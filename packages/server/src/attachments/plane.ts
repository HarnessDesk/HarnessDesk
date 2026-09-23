import { randomUUID } from 'node:crypto'

import {
  reaches,
  type AgentOrigin,
  type AttachmentDeclaration,
  type AttachmentIdentity,
  type AttachmentSupport,
  type CeilingLevel,
  type SeatAttachmentsRecord,
  type SeatId,
  type SeatRecord,
  type SessionAttachmentReceipt,
  type SessionAttachments,
} from '@harnessdesk/protocol'

import { activateBindings, type Binding, type Candidate } from './gate.js'
import { AttachmentReceipts } from './receipts.js'

/**
 * Prepare → open → read: the one transaction every Seat's attachments go
 * through, whether it seats a plain Agent or staffs a Goal. `prepare` reads
 * and decides, entirely before any runtime session exists; `record` is
 * called once that session answered back, and durably freezes what it
 * actually loaded. Nothing in between ever lets a public wire field assert
 * approval, a digest or a loaded state — every one of those is host-computed
 * from `port`, never trusted from a caller.
 */

export interface AttachmentSubject {
  readonly project: string
  readonly incarnation: string
  readonly agent: string
  readonly origin: AgentOrigin
  readonly agentDigest: string
  readonly runtime: string
  readonly build: string
  readonly ceiling: CeilingLevel
}

export interface ResolvedForPlane {
  readonly identity: AttachmentIdentity
  readonly endpoint: string | null
}

export interface AttachmentsPlanePort {
  /** Every declared name, resolved or not — Task 1's catalog, already revalidated and never executed. */
  resolve(subject: AttachmentSubject): Promise<{
    readonly declarations: readonly AttachmentDeclaration[]
    readonly resolved: readonly ResolvedForPlane[]
  }>
  /** A person's local answer for one exact identity — Task 1's `AttachmentTrust.permits`. */
  permits(subject: AttachmentSubject, identity: AttachmentIdentity): Promise<boolean>
  /** What this runtime build can do with each kind, for one Seat. */
  support(subject: AttachmentSubject): AttachmentSupport
  /** Whether this runtime's own auto-loading of unapproved repository content can be suppressed for one Seat. */
  suppressUnapproved(subject: AttachmentSubject): Promise<boolean>
}

export interface PreparedAttachments {
  readonly subject: AttachmentSubject
  readonly input: SessionAttachments
  readonly declarations: readonly AttachmentDeclaration[]
}

/** Thrown by `prepare` when the runtime cannot be trusted not to auto-load unapproved repository content on its own. */
export class UnsuppressedAutoLoadError extends Error {}

export class AttachmentsPlane {
  readonly #receipts: AttachmentReceipts
  /** Live gateway state per open Seat — never persisted, never survives a restart, gone the moment a Seat closes. */
  readonly #live = new Map<SeatId, { readonly servers: readonly { readonly identity: AttachmentIdentity; readonly endpoint: string }[] }>()

  constructor(folder: string, private readonly port: AttachmentsPlanePort) {
    this.#receipts = new AttachmentReceipts(folder)
  }

  /**
   * Resolves, checks trust and ceiling, and builds the isolated input a
   * runtime session is created with — never the other way around. Skills
   * and MCP servers are judged independently: an Agent that declared only
   * skills gets `mcp: null` (native defaults), never an empty allowlist it
   * never asked for.
   */
  async prepare(subject: AttachmentSubject): Promise<PreparedAttachments> {
    const { declarations: found, resolved } = await this.port.resolve(subject)
    const key = randomUUID()
    if (found.length === 0) {
      return { subject, input: { key, skills: null, mcp: null, notes: null }, declarations: [] }
    }
    const support = this.port.support(subject)
    const declaredSkills = found.some((one) => one.kind === 'skill')
    const declaredMcp = found.some((one) => one.kind === 'mcp')

    const finalized: AttachmentDeclaration[] = []
    const skills: { name: string; digest: string; path: string }[] = []
    const mcp: { name: string; digest: string; endpoint: string }[] = []
    let anyUnapproved = false

    for (const declaration of found) {
      if (!declaration.identity) {
        finalized.push(declaration)
        continue
      }
      const identity = declaration.identity
      const approved = await this.port.permits(subject, identity)
      const permitted = declaration.kind === 'mcp' ? reaches(subject.ceiling, 'merge') : true
      const supported =
        declaration.kind === 'skill' ? support.skills === 'scoped' : declaration.kind === 'mcp' ? support.mcp === 'scoped-gated' : true
      if (!approved) {
        anyUnapproved = true
        finalized.push({ ...declaration, problem: 'Review this content before loading it.' })
        continue
      }
      if (!permitted) {
        finalized.push({ ...declaration, problem: 'This attachment exceeds the Seat ceiling.' })
        continue
      }
      if (!supported) {
        finalized.push({ ...declaration, problem: 'This runtime cannot load this attachment for one Seat.' })
        continue
      }
      finalized.push(declaration)
      if (declaration.kind === 'skill') {
        skills.push({ name: identity.name, digest: identity.digest, path: identity.pathLabel })
      } else if (declaration.kind === 'mcp') {
        const endpoint = resolved.find((one) => one.identity.kind === 'mcp' && one.identity.name === identity.name)?.endpoint
        if (endpoint) mcp.push({ name: identity.name, digest: identity.digest, endpoint })
        else finalized[finalized.length - 1] = { ...declaration, problem: 'This server has no reachable gateway endpoint.' }
      }
    }

    // A runtime that cannot suppress its own unapproved auto-loading must
    // never get the chance to: refused here, before any session exists,
    // rather than opened and then found to have loaded something nobody approved.
    if (anyUnapproved && !(await this.port.suppressUnapproved(subject))) {
      throw new UnsuppressedAutoLoadError(
        `${subject.runtime} cannot be stopped from loading unapproved repository content on its own for this Seat.`,
      )
    }

    return {
      subject,
      input: {
        key,
        skills: declaredSkills ? skills : null,
        mcp: declaredMcp ? mcp : null,
        notes: null,
      },
      declarations: finalized,
    }
  }

  /**
   * Compares what was prepared against what the runtime says it loaded
   * (`activateBindings`, the exact proven admission order), then durably
   * appends epoch 0 for this Seat. A mismatched or failed readback is a
   * `not-loaded` result, never an exception the caller has to guess the
   * meaning of, and never a reason to expose a tool or send a turn.
   */
  async record(seat: SeatRecord, prepared: PreparedAttachments, receipt: SessionAttachmentReceipt): Promise<SeatAttachmentsRecord> {
    const bindings: Binding[] = prepared.declarations
      .filter((one): one is AttachmentDeclaration & { identity: AttachmentIdentity } => one.identity !== null && one.problem === null)
      .map((one) => ({
        candidate: { kind: one.kind as 'skill' | 'mcp', name: one.identity.name, digest: one.identity.digest },
        approved: true,
        permitted: true,
        supported: true,
      }))
    const observedByKey = new Map(receipt.loaded.map((one) => [`${one.kind}:${one.name}`, one.digest]))
    const results = await activateBindings(bindings, async (candidate: Candidate) => {
      const observed = observedByKey.get(`${candidate.kind}:${candidate.name}`)
      if (observed === undefined) throw new Error('not loaded')
      return observed
    })
    const byName = new Map(results.map((one) => [`${one.candidate.kind}:${one.candidate.name}`, one]))
    const loadResults = prepared.declarations
      .filter((one) => one.identity !== null)
      .map((one) => {
        const identity = one.identity!
        if (one.problem) return { identity, status: 'not-loaded' as const, reason: one.problem }
        const activated = byName.get(`${identity.kind}:${identity.name}`)
        return activated
          ? { identity, status: activated.status, reason: activated.reason }
          : { identity, status: 'not-loaded' as const, reason: 'Loading failed; review the runtime status and start a new Seat.' }
      })

    const previous = await this.#receipts.read(seat.id)
    const record: SeatAttachmentsRecord = {
      version: 1,
      seat: seat.id,
      agentDigest: prepared.subject.agentDigest,
      runtime: prepared.subject.runtime,
      build: prepared.subject.build,
      epoch: previous ? previous.epoch + 1 : 0,
      observedAt: Date.now(),
      skillsMode: prepared.input.skills === null ? 'runtime-defaults' : 'allowlist',
      mcpMode: prepared.input.mcp === null ? 'runtime-defaults' : 'allowlist',
      declarations: prepared.declarations,
      results: loadResults,
      restored: false,
    }
    await this.#receipts.append(record)
    if (prepared.input.mcp) {
      this.#live.set(
        seat.id,
        {
          servers: prepared.input.mcp
            .filter((one) => loadResults.find((r) => r.identity.name === one.name)?.status === 'loaded')
            .map((one) => ({
              identity: prepared.declarations.find((d) => d.identity?.name === one.name)!.identity!,
              endpoint: one.endpoint,
            })),
        },
      )
    }
    return record
  }

  async read(seat: SeatId): Promise<SeatAttachmentsRecord | null> {
    return this.#receipts.read(seat)
  }

  /** Ends this Seat's live gateway access — called on release, wrap, session delete and host shutdown. Never touches history. */
  async revokeLive(seat: SeatId): Promise<void> {
    this.#live.delete(seat)
  }

  /** The frozen, live server list for a Seat's gateway calls — `null` once revoked or never loaded. */
  liveServersFor(seat: SeatId): readonly { readonly identity: AttachmentIdentity; readonly endpoint: string }[] | null {
    return this.#live.get(seat)?.servers ?? null
  }
}
