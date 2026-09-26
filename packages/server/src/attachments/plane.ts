import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { McpServerSpec } from '@harnessdesk/agent-inventory'
import {
  reaches,
  type AgentOrigin,
  type AttachmentDeclaration,
  type AttachmentIdentity,
  type AttachmentLoadResult,
  type AttachmentSupport,
  type CeilingLevel,
  type SeatAttachmentsRecord,
  type SeatId,
  type SeatRecord,
  type SessionAttachmentReceipt,
  type SessionAttachments,
  type SessionId,
} from '@harnessdesk/protocol'

import { bundleDigest, mcpIdentityDigest, readBundle, type BundleFile } from './catalog.js'
import { activateBindings, type Binding, type Candidate } from './gate.js'
import { AttachmentReceipts, attachmentSeatFileFor } from './receipts.js'

/**
 * Prepare → open → read: the one transaction every Seat's attachments go
 * through, whether it seats a plain Agent, staffs a Goal, or reopens a Seat
 * after a restart. `prepare` reads and decides, entirely before any runtime
 * session exists; `record` is called once that session answered back, and
 * durably freezes what it actually loaded. Nothing in between ever lets a
 * public wire field assert approval, a digest or a loaded state — every one
 * of those is host-computed from `port`, never trusted from a caller.
 *
 * One identity per attachment, from one read: the bytes a skill's digest was
 * taken over are the bytes staged under `staged/skill/<digest>/` (a folder
 * this host owns), and the spec a server's digest was taken over is the spec
 * staged under `staged/mcp/<digest>.json` and dialled by the gateway. A
 * runtime is handed the staged path, never the Agent's or the Library's own
 * folder, which can change after a person approved it.
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

/** One resolved name, with the exact bytes (a skill) or spec (a server) its digest was taken over. */
export interface ResolvedForPlane {
  readonly identity: AttachmentIdentity
  readonly files: readonly BundleFile[]
  readonly server: McpServerSpec | null
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
  /**
   * When this identity is not approved for the Seat's runtime but is for
   * another, the names to say so in — the one it was reviewed for, and the
   * one this Seat runs on — each as its runtime presents itself. Only ever
   * words for a refusal; never a permission.
   */
  reviewedElsewhere?(subject: AttachmentSubject, identity: AttachmentIdentity): Promise<{ readonly reviewed: string; readonly seated: string } | null>
}

export interface PreparedAttachments {
  readonly subject: AttachmentSubject
  readonly input: SessionAttachments
  readonly declarations: readonly AttachmentDeclaration[]
  /** The spec each prepared server endpoint names — host-only, never handed to an adapter. */
  readonly servers: ReadonlyMap<string, McpServerSpec>
}

/** A live server a Seat may reach: its identity, its opaque endpoint, and the exact approved spec the gateway dials. */
export interface LiveServer {
  readonly identity: AttachmentIdentity
  readonly endpoint: string
  readonly spec: McpServerSpec
}

/** A conversation reopened on its Seat's frozen filter: which Seat, and the revalidated input it was handed. */
export interface ReopenedSeat {
  readonly seat: SeatRecord
  readonly prepared: PreparedAttachments
}

/**
 * What a runtime says a session loaded — asked of the runtime itself after
 * the session exists, never assumed from what it was handed. A runtime with
 * no such method, one that throws, or one that answers for a key this Seat
 * was not prepared with in this process, is taken at its most conservative:
 * nothing loaded — unless this process has never prepared this Seat at all,
 * in which case there is nothing to weigh the answer against and the reopen
 * fails closed instead of guessing (`HeldBeyondFilterError`; #939).
 */
export async function receiptFrom(
  runtime: { attachmentReceipt?(session: SessionId): Promise<SessionAttachmentReceipt> } | undefined,
  session: SessionId,
  key: string,
  options: {
    readonly reopen?: PreparedAttachments
    /** Every key this Seat's own filter was handed under in this process (`AttachmentsPlane.keysOf`). */
    readonly seatKeys?: ReadonlySet<string>
  } = {},
): Promise<SessionAttachmentReceipt> {
  const empty: SessionAttachmentReceipt = { key, loaded: [], refused: [] }
  if (!runtime?.attachmentReceipt) return empty
  let observed: SessionAttachmentReceipt
  try {
    observed = await runtime.attachmentReceipt(session)
  } catch {
    return empty
  }
  if (observed.key === key) return observed
  /* A reopen the runtime answered with the conversation it still held —
     the registry had let the handle go, the adapter had not (#895). That
     session is still on the filter it was opened with, an earlier reopen of
     this same Seat's frozen declarations, and its receipt answers for that
     key. Taken as this reopen's only when everything it says is loaded is
     something this reopen would load too, identity for identity; anything
     more is `HeldBeyondFilterError`, and the caller closes the session rather
     than keep it on content this Seat may no longer load. What it names is
     then checked against the frozen identities by `record`, never taken as more. */
  const reopen = options.reopen
  if (!reopen) return empty
  const seatKeys = options.seatKeys
  /* `seatKeys` is this process's own record of every key it has itself
     handed this Seat — nothing else ever adds to it, and nothing here reads
     it as a guess at what the agent's own state actually is. It is empty
     exactly when this process has not itself recorded an open or a reopen
     for this Seat before now: the first time this exact process is ever
     asked about it, whatever came before. Whatever the runtime answers for a
     held session in that state is unprovable either way here — trusted as
     "nothing loaded" it could be hiding real content; trusted as loaded it
     could be inventing content nobody approved — so this reopen fails closed
     rather than guess, and the caller closes the session (#939, #948). A
     held session proves what it loaded only by an actual reopen in a process
     that was there to hand it a key in the first place. */
  if (!seatKeys?.size) {
    throw new HeldBeyondFilterError(
      'What this agent still holds cannot be checked against anything this desk remembers giving it. Reopen the Seat, or restart its session, to continue.',
    )
  }
  /* Only a session this Seat's own filter was handed to: its key is one this
     process recorded for this Seat. Any other key — another Seat's input —
     is nothing loaded (review P3-1 on #940). */
  if (!seatKeys.has(observed.key)) return empty
  const allowed = new Set(
    reopen.declarations
      .filter((one) => one.identity !== null && one.problem === null)
      .map((one) => `${one.kind}:${one.name}:${one.identity!.digest}`),
  )
  if (observed.loaded.some((one) => !allowed.has(`${one.kind}:${one.name}:${one.digest}`))) {
    throw new HeldBeyondFilterError('The agent still held this conversation with attachments this Seat may no longer load.')
  }
  return { ...observed, key }
}

/** Thrown by `receiptFrom` for a held session that loaded more than its reopen allows. */
export class HeldBeyondFilterError extends Error {}

/** Thrown by `prepare`/`reapply` when the runtime cannot be trusted not to auto-load unapproved repository content on its own. */
export class UnsuppressedAutoLoadError extends Error {}

/**
 * What a Seat froze at open, kept in machine state beside its receipts: the
 * subject it was prepared for and the declarations as they were decided.
 * A resume, a reconnect or a load re-applies exactly this — revalidated,
 * never re-resolved from the Agent's current file. Never carried by a
 * backup: a restored Seat has history, never a filter to re-apply.
 */
interface FrozenAttachments {
  readonly version: 1
  readonly seat: SeatId
  readonly subject: AttachmentSubject
  readonly skillsMode: 'runtime-defaults' | 'allowlist'
  readonly mcpMode: 'runtime-defaults' | 'allowlist'
  readonly declarations: readonly AttachmentDeclaration[]
}

const MAX_FROZEN_BYTES = 256 * 1024
const MAX_SPEC_BYTES = 64 * 1024

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const frozenOf = (value: unknown): FrozenAttachments | null => {
  if (!object(value) || value['version'] !== 1 || typeof value['seat'] !== 'string') return null
  const subject = value['subject']
  if (!object(subject)) return null
  for (const key of ['project', 'incarnation', 'agent', 'origin', 'agentDigest', 'runtime', 'build', 'ceiling']) {
    if (typeof subject[key] !== 'string') return null
  }
  if (!['runtime-defaults', 'allowlist'].includes(String(value['skillsMode']))) return null
  if (!['runtime-defaults', 'allowlist'].includes(String(value['mcpMode']))) return null
  if (!Array.isArray(value['declarations'])) return null
  for (const one of value['declarations']) {
    if (!object(one) || !['skill', 'mcp'].includes(String(one['kind'])) || typeof one['name'] !== 'string') return null
    if (one['problem'] !== null && typeof one['problem'] !== 'string') return null
    const identity = one['identity']
    if (identity !== null) {
      if (!object(identity) || identity['kind'] !== one['kind'] || identity['name'] !== one['name']) return null
      if (typeof identity['digest'] !== 'string' || !/^[0-9a-f]{64}$/.test(identity['digest'])) return null
    }
  }
  return value as unknown as FrozenAttachments
}

const endpointOf = (identity: AttachmentIdentity): string => `mcp:${identity.name}:${identity.digest}`

/** Every digest a prepared Seat was handed a staged copy of. */
const stagedDigests = (prepared: PreparedAttachments): string[] => [
  ...(prepared.input.skills ?? []).map((one) => one.digest),
  ...(prepared.input.mcp ?? []).map((one) => one.digest),
]

/** `waiting`: queued behind another staging or collection of the same digest. `writing`: no verified copy was there, so one is being written. */
export type StagingStep = 'waiting' | 'writing'

type Staged = { readonly path: string } | { readonly endpoint: string; readonly spec: McpServerSpec } | { readonly problem: string }

export class AttachmentsPlane {
  readonly #receipts: AttachmentReceipts
  readonly #staging: string
  readonly #frozen: string
  /**
   * Live gateway state per open Seat — never persisted, never survives a
   * restart, gone the moment a Seat closes. Holds the spec itself, so the
   * gateway never looks a server up anywhere else: a Seat that is gone has no
   * spec left to dial.
   */
  readonly #live = new Map<SeatId, { readonly servers: readonly LiveServer[] }>()
  /**
   * One queue per staged digest (#895). Two Seats staging the same digest
   * took turns only by luck: one could find the copy missing mid-write, remove
   * the target the other had just placed, and leave the other's bridge reading
   * a folder that was going away. Staging, and collecting, a digest now waits
   * for whatever else is doing either to it.
   */
  readonly #digestQueues = new Map<string, Promise<unknown>>()
  /** Digests a `prepare` staged that no Seat has frozen yet, counted: never collected while a Seat is opening on one. */
  readonly #opening = new Map<string, number>()
  /** The prepared Seats that pinned their digests in `#opening`, so only their own `record` lets go. */
  readonly #pinned = new WeakSet<PreparedAttachments>()
  readonly #onStaging: ((digest: string, step: StagingStep) => Promise<void> | void) | undefined
  /**
   * The key of every input a Seat's filter was handed under and recorded, in
   * this process. An adapter holds a session no longer than this process
   * lives, so a held session's key is here exactly when this Seat's own
   * filter opened it.
   */
  readonly #keys = new Map<SeatId, Set<string>>()

  constructor(
    folder: string,
    private readonly port: AttachmentsPlanePort,
    options: {
      readonly staging?: string
      readonly frozen?: string
      /** Told each step a skill's staging takes; for a test's barrier, never a decision. */
      readonly onStaging?: (digest: string, step: StagingStep) => Promise<void> | void
    } = {},
  ) {
    this.#receipts = new AttachmentReceipts(folder)
    this.#staging = options.staging ?? join(folder, '.staged')
    this.#frozen = options.frozen ?? join(folder, '.frozen')
    this.#onStaging = options.onStaging
  }

  /** Runs `work` alone for one digest: after, and before, anything else staging or collecting it. */
  #forDigest<T>(digest: string, work: () => Promise<T>): Promise<T> {
    const before = this.#digestQueues.get(digest)
    if (before) void this.#onStaging?.(digest, 'waiting')
    const run = (before ?? Promise.resolve()).then(work, work)
    const tail = run.then(() => undefined, () => undefined)
    this.#digestQueues.set(digest, tail)
    void tail.then(() => { if (this.#digestQueues.get(digest) === tail) this.#digestQueues.delete(digest) })
    return run
  }

  /**
   * Removes every staged copy no Seat and no approval references (#895):
   * `staged/skill/<digest>/` and `staged/mcp/<digest>.json` whose digest no
   * frozen filter names — an ended Seat's too, since its conversation reopens
   * on it — is not in `approved` (every digest the trust store holds a grant
   * for), and no Seat is opening on right now; and any half-written copy a
   * crash left behind. Each removal waits its digest's turn. Answers how many
   * it removed. A frozen file that cannot be read keeps everything: what it
   * might name is unknown, so nothing is collected on a guess.
   */
  async collectStaged(approved: ReadonlySet<string>): Promise<number> {
    const kept = new Set<string>(approved)
    let names: string[]
    try {
      names = await readdir(this.#frozen)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 0
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const text = await this.#readBounded(join(this.#frozen, name), MAX_FROZEN_BYTES)
      const frozen = text === null ? null : (() => { try { return frozenOf(JSON.parse(text)) } catch { return null } })()
      if (!frozen) return 0
      for (const one of frozen.declarations) if (one.identity) kept.add(one.identity.digest)
    }
    const digest = /^[0-9a-f]{64}$/
    let removed = 0
    const collect = async (path: string, id: string | null): Promise<void> => {
      if (id === null) {
        await rm(path, { recursive: true, force: true })
        removed += 1
        return
      }
      await this.#forDigest(id, async () => {
        if (kept.has(id) || (this.#opening.get(id) ?? 0) > 0) return
        await rm(path, { recursive: true, force: true })
        removed += 1
      })
    }
    // A real folder, never a link swapped in for one: listing through a link
    // would collect in whatever folder it points at (review P3-2 on #940).
    const realFolder = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null))?.isDirectory() === true
    if (!(await realFolder(this.#staging))) return 0
    for (const [kind, parse] of [
      ['skill', (name: string) => (digest.test(name) ? name : null)],
      ['mcp', (name: string) => (name.endsWith('.json') && digest.test(name.slice(0, -5)) ? name.slice(0, -5) : null)],
    ] as const) {
      const folder = join(this.#staging, kind)
      if (!(await realFolder(folder))) continue
      const entries = await readdir(folder).catch(() => [] as string[])
      for (const name of entries) {
        const id = parse(name)
        if (id !== null) await collect(join(folder, name), id)
        // A copy a crash left half-written, never renamed into place.
        else if (name.endsWith('.tmp')) await collect(join(folder, name), null)
      }
    }
    return removed
  }

  /**
   * Resolves, checks trust and ceiling, stages the exact approved content in
   * this host's own folder, and builds the isolated input a runtime session
   * is created with — never the other way around. Skills and MCP servers are
   * judged independently: an Agent that declared only skills gets `mcp: null`
   * (native defaults), never an empty allowlist it never asked for.
   */
  async prepare(subject: AttachmentSubject): Promise<PreparedAttachments> {
    const { declarations: found, resolved } = await this.port.resolve(subject)
    if (found.length === 0) {
      return { subject, input: { key: randomUUID(), skills: null, mcp: null }, declarations: [], servers: new Map() }
    }
    const content = (declaration: AttachmentDeclaration): ResolvedForPlane | undefined =>
      resolved.find(
        (one) =>
          one.identity.kind === declaration.kind &&
          one.identity.name === declaration.name &&
          one.identity.digest === declaration.identity?.digest,
      )
    const prepared = await this.#decide(subject, found, null, async (declaration) => {
      const read = content(declaration)
      if (!read) return { problem: 'This content was not read, so it cannot be loaded.' }
      return declaration.kind === 'skill' ? this.#stageSkill(declaration.identity!, read.files) : this.#stageServer(declaration.identity!, read.server)
    })
    // Opening on these until `record` freezes them: never collected in between.
    for (const digest of stagedDigests(prepared)) this.#opening.set(digest, (this.#opening.get(digest) ?? 0) + 1)
    this.#pinned.add(prepared)
    return prepared
  }

  /**
   * A reopen of a Seat that froze attachments — a resume, a reconnect after
   * its runtime restarted, a load: the frozen declarations, re-applied to a
   * fresh key and revalidated against what is true now (the staged copy is
   * still exactly the approved content; the approval still covers this
   * runtime build and the Seat's ceiling; the runtime can still scope a
   * Seat), never re-resolved from the Agent's current file. `null` when this
   * Seat froze nothing; throws when the runtime can no longer be kept from
   * loading content nobody approved.
   *
   * A closed Seat's conversation keeps its filter, but no server: the
   * gateway serves open Seats only, so one is never reported loaded for it.
   */
  async reapply(seat: SeatRecord, now: { readonly build: string }): Promise<PreparedAttachments | null> {
    const frozen = await this.#readFrozen(seat.id)
    if (!frozen) return null
    const subject: AttachmentSubject = { ...frozen.subject, build: now.build }
    const prepared = await this.#decide(subject, frozen.declarations, frozen.subject, async (declaration) => {
      if (declaration.kind === 'mcp' && seat.closed !== null) return { problem: 'This Seat has ended, so its servers are no longer reachable.' }
      return declaration.kind === 'skill' ? this.#restagedSkill(declaration.identity!) : this.#restagedServer(declaration.identity!)
    })
    return {
      ...prepared,
      input: {
        ...prepared.input,
        skills: frozen.skillsMode === 'allowlist' ? (prepared.input.skills ?? []) : null,
        mcp: frozen.mcpMode === 'allowlist' ? (prepared.input.mcp ?? []) : null,
      },
    }
  }

  /**
   * Whether anything says this Seat carried a filter even though none can be
   * read back: a frozen file that is there but unreadable, or receipts with
   * no frozen file beside them. A reopen must refuse such a Seat rather than
   * open it on the runtime's own defaults.
   */
  async lostFilter(seat: SeatId): Promise<boolean> {
    if (await this.#readFrozen(seat)) return false
    const present = await lstat(this.#frozenPath(seat)).catch(() => null)
    return present !== null || (await this.#receipts.read(seat)) !== null
  }

  /** Whether this Seat froze a filter that a reopen must re-apply. */
  async frozen(seat: SeatId): Promise<boolean> {
    return (await this.#readFrozen(seat)) !== null
  }

  /**
   * One decision per declaration, in the proven order — approval, ceiling,
   * runtime support — then the content itself (`stage`), which is the step
   * that turns an identity into something a runtime may load. A declaration
   * that fails any of them keeps its reason and never reaches the input.
   */
  async #decide(
    subject: AttachmentSubject,
    found: readonly AttachmentDeclaration[],
    /** The subject a reopened Seat was frozen under; null for a fresh Seat. */
    frozenAs: AttachmentSubject | null,
    stage: (declaration: AttachmentDeclaration) => Promise<Staged>,
  ): Promise<PreparedAttachments> {
    const fresh = frozenAs === null
    const key = randomUUID()
    const support = this.port.support(subject)
    const declaredSkills = found.some((one) => one.kind === 'skill')
    const declaredMcp = found.some((one) => one.kind === 'mcp')

    const finalized: AttachmentDeclaration[] = []
    const skills: { name: string; digest: string; path: string }[] = []
    const mcp: { name: string; digest: string; endpoint: string }[] = []
    const servers = new Map<string, McpServerSpec>()
    let anyUnapproved = false

    for (const declaration of found) {
      // A reopen keeps what was refused at open refused: its reason is history, not a new question.
      if (!declaration.identity || (!fresh && declaration.problem !== null)) {
        finalized.push(declaration)
        continue
      }
      const identity = declaration.identity
      const approved = await this.port.permits(subject, identity)
      const permitted = declaration.kind === 'mcp' ? reaches(subject.ceiling, 'merge') : true
      const supported =
        declaration.kind === 'skill' ? support.skills === 'scoped' : declaration.kind === 'mcp' ? support.mcp === 'scoped-gated' : false
      if (!approved) {
        anyUnapproved = true
        // A reopen onto another build of the agent: the approval is still
        // there, for the build it was given for. Say that, and what to do —
        // never a generic failure, and never "review" as if nobody had.
        const otherBuild =
          frozenAs !== null && frozenAs.build !== subject.build && (await this.port.permits(frozenAs, identity))
        // A fresh Seat whose seating fell back to another candidate: the review was for the first choice (#895).
        const elsewhere = !otherBuild && fresh ? await this.port.reviewedElsewhere?.(subject, identity).catch(() => null) ?? null : null
        finalized.push({
          ...declaration,
          problem: otherBuild
            ? `This was approved for another build of this agent (${frozenAs.build || 'unknown'}), and it now runs ${subject.build || 'an unknown build'}; review it again on the Agent page, then seat the Agent again.`
            : elsewhere
              ? `This was approved for ${elsewhere.reviewed}, but this Seat runs on ${elsewhere.seated} instead, and an approval covers only the agent it was given for.`
              : 'Review this content before loading it.',
        })
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
      const staged = await stage(declaration)
      if ('problem' in staged) {
        finalized.push({ ...declaration, problem: staged.problem })
        continue
      }
      finalized.push({ ...declaration, problem: null })
      if ('path' in staged) {
        skills.push({ name: identity.name, digest: identity.digest, path: staged.path })
      } else {
        mcp.push({ name: identity.name, digest: identity.digest, endpoint: staged.endpoint })
        servers.set(staged.endpoint, staged.spec)
      }
    }

    // A runtime that cannot suppress its own unapproved auto-loading must
    // never get the chance to: refused here, before any session exists,
    // rather than opened and then found to have loaded something nobody approved.
    if (anyUnapproved && !(await this.port.suppressUnapproved(subject))) {
      throw new UnsuppressedAutoLoadError(
        'This agent cannot be stopped from loading unapproved repository content on its own for this Seat.',
      )
    }

    return {
      subject,
      input: { key, skills: declaredSkills ? skills : null, mcp: declaredMcp ? mcp : null },
      declarations: finalized,
      servers,
    }
  }

  /**
   * Writes exactly the bytes whose digest was approved into this host's own
   * folder, `staged/skill/<digest>/`, and hands back that path. Written to a
   * fresh temporary folder and renamed into place, so a half-written copy is
   * never at the path a runtime reads; an existing copy is reused only after
   * it is read back and still hashes to the digest.
   */
  async #stageSkill(identity: AttachmentIdentity, files: readonly BundleFile[]): Promise<Staged> {
    if (bundleDigest(files) !== identity.digest) return { problem: 'The content read is not the content that was approved; review it again.' }
    return this.#forDigest(identity.digest, () => this.#placeSkill(identity, files))
  }

  async #placeSkill(identity: AttachmentIdentity, files: readonly BundleFile[]): Promise<Staged> {
    const existing = await this.#restagedSkill(identity)
    if ('path' in existing) return existing
    await this.#onStaging?.(identity.digest, 'writing')
    const root = await this.#skillRoot()
    const target = join(root, identity.digest)
    await rm(target, { recursive: true, force: true })
    const temporary = join(root, `.${randomUUID()}.tmp`)
    try {
      await mkdir(temporary, { recursive: true, mode: 0o700 })
      for (const file of files) {
        const path = join(temporary, ...file.path.split('/'))
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, file.bytes, { mode: 0o600, flag: 'wx' })
      }
      await rename(temporary, target).catch(async (error: unknown) => {
        // Another Seat staged the same digest first: its copy is used only if it verifies.
        if (!(await lstat(target).catch(() => null))) throw error
      })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
    return this.#restagedSkill(identity)
  }

  /** The staged copy of an approved skill, read back and verified — or why it cannot be used. */
  async #restagedSkill(identity: AttachmentIdentity): Promise<Staged> {
    const target = join(await this.#skillRoot(), identity.digest)
    const read = await readBundle(target)
    if (!read.ok || bundleDigest(read.files) !== identity.digest) {
      return { problem: 'The approved copy of this skill is no longer on this desk as it was approved; start a new Seat.' }
    }
    return { path: target }
  }

  /**
   * This host's own staging folder for skills, canonical: the bundle reader
   * refuses a link at any level, and a legitimate ancestor of machine state
   * may itself be one (macOS's own `/var` → `/private/var`). Resolved once
   * here, so everything below it is read with no link allowed.
   */
  async #skillRoot(): Promise<string> {
    const root = join(this.#staging, 'skill')
    await mkdir(root, { recursive: true, mode: 0o700 })
    return realpath(root)
  }

  /** Writes the exact approved spec to `staged/mcp/<digest>.json`: what a reopen dials after a restart, and nothing else. */
  async #stageServer(identity: AttachmentIdentity, spec: McpServerSpec | null): Promise<Staged> {
    if (!spec || mcpIdentityDigest(spec) !== identity.digest) {
      return { problem: 'This server’s configuration is not the one that was approved; review it again.' }
    }
    const target = join(this.#staging, 'mcp', `${identity.digest}.json`)
    await this.#forDigest(identity.digest, async () => {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(spec), { mode: 0o600, flag: 'wx' })
        await rename(temporary, target)
      } finally {
        await rm(temporary, { force: true })
      }
    })
    return { endpoint: endpointOf(identity), spec }
  }

  /** The staged spec of an approved server, read back and verified against its digest. */
  async #restagedServer(identity: AttachmentIdentity): Promise<Staged> {
    const gone = { problem: 'The approved configuration of this server is no longer on this desk as it was approved; start a new Seat.' }
    const text = await this.#readBounded(join(this.#staging, 'mcp', `${identity.digest}.json`), MAX_SPEC_BYTES)
    if (text === null) return gone
    try {
      const spec = JSON.parse(text) as McpServerSpec
      if (!object(spec) || mcpIdentityDigest(spec) !== identity.digest) return gone
      return { endpoint: endpointOf(identity), spec }
    } catch {
      return gone
    }
  }

  async #readBounded(path: string, limit: number): Promise<string | null> {
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > limit) return null
        return await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  #frozenPath(seat: SeatId): string {
    return join(this.#frozen, attachmentSeatFileFor(seat).replace(/\.ndjson$/, '.json'))
  }

  async #readFrozen(seat: SeatId): Promise<FrozenAttachments | null> {
    const text = await this.#readBounded(this.#frozenPath(seat), MAX_FROZEN_BYTES)
    if (text === null) return null
    try {
      const frozen = frozenOf(JSON.parse(text))
      return frozen && frozen.seat === seat ? frozen : null
    } catch {
      return null
    }
  }

  async #writeFrozen(seat: SeatId, prepared: PreparedAttachments): Promise<void> {
    if (await this.#readFrozen(seat)) return
    const frozen: FrozenAttachments = {
      version: 1,
      seat,
      subject: prepared.subject,
      skillsMode: prepared.input.skills === null ? 'runtime-defaults' : 'allowlist',
      mcpMode: prepared.input.mcp === null ? 'runtime-defaults' : 'allowlist',
      declarations: prepared.declarations,
    }
    const text = JSON.stringify(frozen)
    if (Buffer.byteLength(text, 'utf8') > MAX_FROZEN_BYTES) throw new Error('This Seat’s attachments are too large to freeze.')
    const target = this.#frozenPath(seat)
    await mkdir(this.#frozen, { recursive: true, mode: 0o700 })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  /**
   * Compares what was prepared against what the runtime says it loaded
   * (`activateBindings`, the exact proven admission order), then durably
   * appends the next epoch for this Seat — 0 at open, one more at every
   * reopen — and freezes the Seat's declarations the first time. A
   * mismatched or failed readback is a `not-loaded` result, never an
   * exception the caller has to guess the meaning of, and never a reason to
   * expose a tool or send a turn.
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
    const loadResults: AttachmentLoadResult[] = prepared.declarations
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
    await this.#writeFrozen(seat.id, prepared)
    if (this.#pinned.delete(prepared)) for (const digest of stagedDigests(prepared)) {
      const left = (this.#opening.get(digest) ?? 0) - 1
      if (left > 0) this.#opening.set(digest, left)
      else this.#opening.delete(digest)
    }
    await this.#receipts.append(record)
    const keys = this.#keys.get(seat.id) ?? new Set<string>()
    keys.add(prepared.input.key)
    this.#keys.set(seat.id, keys)
    if (prepared.input.mcp && seat.closed === null) {
      // Matched on kind *and* name, never name alone: a skill and a server
      // may share a name, and a skill that loaded must never make a server
      // of the same name live (nor lend it the skill's identity).
      const loadedServer = (name: string): AttachmentLoadResult | undefined =>
        loadResults.find((r) => r.identity.kind === 'mcp' && r.identity.name === name && r.status === 'loaded')
      this.#live.set(seat.id, {
        servers: prepared.input.mcp.flatMap((one) => {
          const result = loadedServer(one.name)
          const spec = prepared.servers.get(one.endpoint)
          return result && spec && result.identity.digest === one.digest ? [{ identity: result.identity, endpoint: one.endpoint, spec }] : []
        }),
      })
    }
    return record
  }

  /** The keys this Seat's filter was handed under in this process. */
  keysOf(seat: SeatId): ReadonlySet<string> {
    return this.#keys.get(seat) ?? new Set()
  }

  async read(seat: SeatId): Promise<SeatAttachmentsRecord | null> {
    return this.#receipts.read(seat)
  }

  /** Task 6's own backup export: every observation epoch of every Seat this desk has ever recorded. */
  attachmentHistory(): Promise<readonly SeatAttachmentsRecord[]> {
    return this.#receipts.allHistories()
  }

  /**
   * Backup import's one write path for a Seat's attachment history:
   * `'restored'` when this epoch was newly appended, `'alreadyHere'` when an
   * identical epoch already exists (the `restored` provenance flag is not
   * part of that comparison — the same observation, recorded here first or
   * imported first, is one epoch, not two), and `'refused'` for a gap, a
   * mismatch against an existing epoch, or a schema/bound violation
   * `AttachmentReceipts.append` itself catches by throwing. It never writes a
   * frozen filter: a restored Seat has history, never something to re-apply.
   */
  async appendRestored(record: SeatAttachmentsRecord): Promise<'restored' | 'alreadyHere' | 'refused'> {
    const history = await this.#receipts.history(record.seat)
    const existing = history.find((one) => one.epoch === record.epoch)
    const sameContent = (a: SeatAttachmentsRecord, b: SeatAttachmentsRecord): boolean =>
      JSON.stringify({ ...a, restored: undefined }) === JSON.stringify({ ...b, restored: undefined })
    if (existing) return sameContent(existing, record) ? 'alreadyHere' : 'refused'
    const expected = history.length === 0 ? 0 : history[history.length - 1]!.epoch + 1
    if (record.epoch !== expected) return 'refused'
    try {
      await this.#receipts.append({ ...record, restored: true })
      return 'restored'
    } catch {
      return 'refused'
    }
  }

  /** Ends this Seat's live gateway access — called on release, wrap, session delete and host shutdown. Never touches history. */
  async revokeLive(seat: SeatId): Promise<void> {
    this.#live.delete(seat)
  }

  /** Ends every Seat's live gateway access at once: host shutdown. */
  revokeAll(): void {
    this.#live.clear()
  }

  /** The frozen, live server list for a Seat's gateway calls — `null` once revoked or never loaded. */
  liveServersFor(seat: SeatId): readonly LiveServer[] | null {
    return this.#live.get(seat)?.servers ?? null
  }
}
