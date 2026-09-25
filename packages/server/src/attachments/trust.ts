import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { CEILING_LEVELS, reaches } from '@harnessdesk/protocol'
import type {
  AgentOrigin,
  AttachmentDeclaration,
  AttachmentIdentity,
  AttachmentReview,
  CeilingLevel,
} from '@harnessdesk/protocol'

import type { McpServerSpec } from '@harnessdesk/agent-inventory'

import { plainCipher, type CredentialCipher } from '../credentials.js'
import { errnoOf, NOTHING_YET } from '../errno.js'
import type { AttachmentSubject, ResolvedAttachment } from './catalog.js'

/**
 * The person's own local answer to "may this be loaded", per machine.
 *
 * **Security-critical**, on the same footing as `evidence/seen.ts`'s
 * `CommandsSeen`, whose signing and file shape this reuses — never its
 * check-command key space, which answers a different question. A grant here
 * approves *loading* one exact bundle or server spec for one exact Agent,
 * ceiling and runtime build; it is never read as approval for a tool call,
 * and phase 3's ceiling gate and message-origin hold are untouched by it.
 *
 * Opening a page, scanning a Library, cloning a repository, restoring a
 * backup or dry-running a Goal never grants anything — only a person's own
 * answer to `preview`, through `approve`, does. Nothing here starts a
 * process, opens a socket or reads a byte beyond its own two files.
 */

export const ATTACHMENT_TRUST_FILE = 'attachment-trust.json'

/** Bumped only when an older build could no longer read the file truthfully. */
const FORMAT = 1

/** The most grants kept. The oldest go first; one that goes must be reviewed again, which is the safe way to forget. */
const GRANT_LIMIT = 2_000

/** How long a shown review may still be approved. Long enough to read it, short enough that "stale" is rare and safe. */
const REVIEW_TTL_MS = 5 * 60 * 1000

interface Grant {
  readonly incarnation: string
  readonly agentOrigin: AgentOrigin
  readonly agentId: string
  readonly kind: 'skill' | 'mcp'
  readonly name: string
  readonly digest: string
  readonly runtime: string
  readonly build: string
  readonly ceiling: CeilingLevel
  readonly at: number
  readonly mac: string
}

interface GrantFile {
  readonly grants: readonly Grant[]
}

const isString = (value: unknown): value is string => typeof value === 'string'

const isGrant = (value: unknown): value is Grant => {
  const one = value as Partial<Grant> | null
  return (
    typeof one === 'object' &&
    one !== null &&
    [one.incarnation, one.agentOrigin, one.agentId, one.kind, one.name, one.digest, one.runtime, one.build, one.ceiling, one.mac].every(
      isString,
    ) &&
    Number.isFinite(one.at)
  )
}

/** One name still waiting on a person's answer: what `preview` showed, kept only until it expires or is used once. */
interface PendingReview {
  readonly subject: AttachmentSubject
  readonly identities: readonly AttachmentIdentity[]
  readonly expiresAt: number
  /** How many values the review showed only as set. */
  readonly hidden: number
}

const consequenceOf = (runtimeName: string, subject: AttachmentSubject, entries: readonly ResolvedAttachment[]): string => {
  const skills = entries.filter((one) => one.identity.kind === 'skill').length
  const servers = entries.filter((one) => one.identity.kind === 'mcp').length
  if (skills === 0 && servers === 0) return `${runtimeName} will load nothing new for this Seat.`
  const parts: string[] = []
  if (skills > 0) parts.push(`${skills} skill${skills === 1 ? '' : 's'}`)
  if (servers > 0) parts.push(`${servers} MCP server${servers === 1 ? '' : 's'}`)
  // When a server's command actually runs: the gateway starts it for one
  // listing or one call at a time, each admitted by the desk's own gate, and
  // only for an open Seat that may merge — never merely because a Seat opened.
  const serverNote =
    servers > 0
      ? ` A server’s command runs on this Mac only when the Seat lists or calls its tools — each time through the desk’s gate, and only for an open Seat that may merge.`
      : ''
  return `Approving this lets ${runtimeName} load ${parts.join(' and ')} for this Seat, at the ${subject.ceiling} ceiling it already has.${serverNote}`
}

/** A name whose value is a credential by every convention in use: its value is never shown, only that it is set. */
const SECRET_NAME = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key|auth|cookie|session)/i

const shownValue = (name: string, value: string): string => (SECRET_NAME.test(name) ? `•••• (a secret, ${value.length} characters; the approval covers its exact value)` : value)

/**
 * Every value a server's review shows only as set, as `<server>: <NAME>` —
 * what an approval has to acknowledge, since a value that changes what the
 * server does can hide behind a name that looks like a credential (#895).
 */
export const hiddenValues = (spec: McpServerSpec): string[] =>
  [...Object.keys(spec.env ?? {}), ...Object.keys(spec.headers ?? {})]
    .filter((name) => SECRET_NAME.test(name))
    .sort()
    .map((name) => `${spec.name}: ${name}`)

/** Why an approval of a review with hidden values was refused without an acknowledgement. */
export const HIDDEN_UNACKNOWLEDGED = 'This review shows some values only as set. Confirm you know what they are before approving.'

/**
 * What a server entry will actually run, as a person reads it: the command,
 * each argument, the environment and any URL and headers — the fields
 * `canonicalMcp` digests, so what is shown is what the identity names. A
 * value whose name marks it as a credential is shown as set, never shown.
 */
export const serverReviewText = (identity: AttachmentIdentity, spec: McpServerSpec): string => {
  const lines: string[] = [`transport: ${spec.transport}`]
  if (spec.command !== undefined) lines.push(`command: ${spec.command}`)
  if (spec.args && spec.args.length > 0) lines.push(`arguments: ${spec.args.map((one) => JSON.stringify(one)).join(', ')}`)
  if (spec.url !== undefined) lines.push(`url: ${spec.url}`)
  const env = Object.entries(spec.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  lines.push(env.length === 0 ? 'environment: (nothing added)' : 'environment:')
  for (const [name, value] of env) lines.push(`  ${name}=${shownValue(name, value)}`)
  const headers = Object.entries(spec.headers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (headers.length > 0) {
    lines.push('headers:')
    for (const [name, value] of headers) lines.push(`  ${name}: ${shownValue(name, value)}`)
  }
  lines.push(`identity: ${identity.digest}`)
  return `${lines.join('\n')}\n`
}

export class AttachmentTrust {
  readonly #file: string
  readonly #keyFile: string
  readonly #cipher: CredentialCipher
  readonly #now: () => number
  #writes: Promise<void> = Promise.resolve()
  readonly #pending = new Map<string, PendingReview>()

  constructor(file: string, options: { readonly cipher?: CredentialCipher; readonly now?: () => number } = {}) {
    this.#file = file
    this.#keyFile = file.replace(/\.json$/, '.key')
    this.#cipher = options.cipher ?? plainCipher
    this.#now = options.now ?? Date.now
  }

  /**
   * Shows exactly what would load, and mints a token a person can approve.
   * Never touches disk beyond nothing — nothing here is durable until
   * `approve` is called, and nothing here starts a process or a request.
   */
  async preview(
    subject: AttachmentSubject,
    entries: readonly ResolvedAttachment[],
    options: { readonly runtimeName?: string } = {},
  ): Promise<AttachmentReview> {
    const token = randomUUID()
    const expiresAt = this.#now() + REVIEW_TTL_MS
    this.#prune()
    const hidden = entries.flatMap((one) => (one.identity.kind === 'mcp' && one.server ? hiddenValues(one.server) : []))
    this.#pending.set(token, { subject, identities: entries.map((one) => one.identity), expiresAt, hidden: hidden.length })
    const declarations: AttachmentDeclaration[] = entries.map((one) => ({
      kind: one.identity.kind,
      name: one.identity.name,
      identity: one.identity,
      problem: null,
    }))
    const files = entries.flatMap((one) => [
      ...one.files.map((file) => ({
        path: `${one.identity.kind}/${one.identity.name}/${file.path}`,
        text: new TextDecoder('utf-8', { fatal: false }).decode(file.bytes),
      })),
      // A server has no files of its own: what is reviewed is what will run.
      ...(one.identity.kind === 'mcp' && one.server
        ? [{ path: `mcp/${one.identity.name}/server`, text: serverReviewText(one.identity, one.server) }]
        : []),
    ])
    return {
      token,
      expiresAt,
      declarations,
      files,
      runtime: subject.runtime,
      effectiveCeiling: subject.ceiling,
      consequence: consequenceOf(options.runtimeName ?? 'This agent', subject, entries),
      hidden,
    }
  }

  /**
   * Records the person's own answer, verbatim, as of exactly what `preview`
   * showed — and only that. A review that showed any value only as set is
   * approved only with `acknowledgeHidden`; refused without it, the token
   * stays good, so the person can confirm and approve the same review.
   */
  async approve(token: string, options: { readonly acknowledgeHidden?: boolean } = {}): Promise<void> {
    this.#prune()
    const pending = this.#pending.get(token)
    if (pending && pending.expiresAt >= this.#now() && pending.hidden > 0 && options.acknowledgeHidden !== true) {
      throw new Error(HIDDEN_UNACKNOWLEDGED)
    }
    // Single-use: taken out of the pending set the moment it is spent,
    // successfully or not, so the same token can never be replayed.
    this.#pending.delete(token)
    if (!pending || pending.expiresAt < this.#now()) {
      throw new Error('This content changed; review it again.')
    }
    const at = this.#now()
    await this.#change((file, key) => {
      const fresh = pending.identities.map((identity) =>
        this.#seal(key, {
          incarnation: pending.subject.incarnation,
          agentOrigin: pending.subject.origin,
          agentId: pending.subject.agent,
          kind: identity.kind as 'skill' | 'mcp',
          name: identity.name,
          digest: identity.digest,
          runtime: pending.subject.runtime,
          build: pending.subject.build,
          ceiling: pending.subject.ceiling,
          at,
        }),
      )
      const same = (a: Grant, b: Grant): boolean =>
        a.incarnation === b.incarnation &&
        a.agentOrigin === b.agentOrigin &&
        a.agentId === b.agentId &&
        a.kind === b.kind &&
        a.name === b.name
      const kept = file.grants.filter((existing) => !fresh.some((one) => same(existing, one)))
      return { grants: [...kept, ...fresh].slice(-GRANT_LIMIT) }
    })
  }

  /**
   * Whether this exact identity — same bytes, same Agent, same repository
   * incarnation, same runtime build, same ceiling — was approved on this
   * machine. Everything is compared, and everything is inside the signature:
   * a grants file copied from elsewhere, or hand-edited, verifies against
   * nothing and permits nothing.
   */
  async permits(subject: AttachmentSubject, identity: AttachmentIdentity): Promise<boolean> {
    const { file, key } = await this.#read()
    if (!key) return false
    return file.grants.some(
      (grant) =>
        grant.incarnation === subject.incarnation &&
        grant.agentOrigin === subject.origin &&
        grant.agentId === subject.agent &&
        grant.kind === identity.kind &&
        grant.name === identity.name &&
        grant.digest === identity.digest &&
        grant.runtime === subject.runtime &&
        grant.build === subject.build &&
        // The ceiling a person reviewed covers any Seat at or below it: a
        // narrower Seat is less authority, never more. A Seat above it — an
        // Agent whose file raised its ceiling since — needs a new review.
        (CEILING_LEVELS as readonly string[]).includes(grant.ceiling) &&
        reaches(grant.ceiling, subject.ceiling) &&
        this.#verify(key, grant),
    )
  }

  /**
   * The runtimes this exact identity was approved for, for this same Agent
   * and repository incarnation and a ceiling covering this Seat's — any
   * runtime but this Seat's own. A review is for the runtime `agent/seat`
   * chooses by default, and a seating that fell back to another candidate
   * finds nothing approved for it: this is what lets it say why (#895),
   * never a permission — `permits` alone is that.
   */
  async approvedOnOtherRuntimes(subject: AttachmentSubject, identity: AttachmentIdentity): Promise<readonly string[]> {
    const { file, key } = await this.#read()
    if (!key) return []
    const runtimes = new Set<string>()
    for (const grant of file.grants) {
      if (
        grant.runtime !== subject.runtime &&
        grant.incarnation === subject.incarnation &&
        grant.agentOrigin === subject.origin &&
        grant.agentId === subject.agent &&
        grant.kind === identity.kind &&
        grant.name === identity.name &&
        grant.digest === identity.digest &&
        (CEILING_LEVELS as readonly string[]).includes(grant.ceiling) &&
        reaches(grant.ceiling, subject.ceiling) &&
        this.#verify(key, grant)
      ) runtimes.add(grant.runtime)
    }
    return [...runtimes].sort()
  }

  /**
   * Every digest a grant here names, signed or not — what a collection of
   * staged copies must keep. Read conservatively: a grant that would not
   * verify still keeps its copy, since keeping costs only disk.
   */
  async digests(): Promise<ReadonlySet<string>> {
    const { file } = await this.#read()
    return new Set(file.grants.map((grant) => grant.digest))
  }

  /** Drops expired pending reviews so a long-running host does not keep them forever. */
  #prune(): void {
    const now = this.#now()
    for (const [token, pending] of this.#pending) {
      if (pending.expiresAt < now) this.#pending.delete(token)
    }
  }

  #mac(key: Buffer, grant: Omit<Grant, 'mac'>): string {
    return createHmac('sha256', key)
      .update(
        JSON.stringify([
          grant.incarnation,
          grant.agentOrigin,
          grant.agentId,
          grant.kind,
          grant.name,
          grant.digest,
          grant.runtime,
          grant.build,
          grant.ceiling,
          grant.at,
        ]),
      )
      .digest('hex')
  }

  #seal(key: Buffer, grant: Omit<Grant, 'mac'>): Grant {
    return { ...grant, mac: this.#mac(key, grant) }
  }

  #verify(key: Buffer, grant: Grant): boolean {
    const expected = Buffer.from(this.#mac(key, grant), 'hex')
    const given = Buffer.from(grant.mac, 'hex')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  async #change(next: (file: GrantFile, key: Buffer) => GrantFile): Promise<void> {
    const write = this.#writes.then(async () => {
      const read = await this.#read()
      const key = read.key ?? (await this.#mintKey())
      const changed = next(read.file, key)
      await mkdir(dirname(this.#file), { recursive: true })
      const temp = `${this.#file}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify({ version: FORMAT, ...changed }, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.#file)
    })
    this.#writes = write.catch(() => {})
    return write
  }

  async #read(): Promise<{ readonly file: GrantFile; readonly key: Buffer | null }> {
    const empty: GrantFile = { grants: [] }
    const key = await this.#readKey()
    let raw: string
    try {
      raw = await readFile(this.#file, 'utf8')
    } catch (error) {
      if (NOTHING_YET.has(errnoOf(error))) return { file: empty, key }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { file: empty, key }
    }
    const record = parsed as { version?: unknown; grants?: unknown } | null
    if (typeof record !== 'object' || record === null) return { file: empty, key }
    if (typeof record.version === 'number' && record.version > FORMAT) {
      // Written by a newer build than this one: fail closed rather than misreading it.
      return { file: empty, key: null }
    }
    return { file: { grants: Array.isArray(record.grants) ? record.grants.filter(isGrant) : [] }, key }
  }

  async #readKey(): Promise<Buffer | null> {
    try {
      const hex = this.#cipher.decrypt(await readFile(this.#keyFile))
      return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null
    } catch {
      return null
    }
  }

  async #mintKey(): Promise<Buffer> {
    const key = randomBytes(32)
    await mkdir(dirname(this.#keyFile), { recursive: true })
    const temp = `${this.#keyFile}.${process.pid}.tmp`
    await writeFile(temp, this.#cipher.encrypt(key.toString('hex')), { mode: 0o600 })
    await rename(temp, this.#keyFile)
    return key
  }
}
