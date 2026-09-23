import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  AgentOrigin,
  AttachmentDeclaration,
  AttachmentIdentity,
  AttachmentReview,
  CeilingLevel,
} from '@harnessdesk/protocol'

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
}

const consequenceOf = (subject: AttachmentSubject, entries: readonly ResolvedAttachment[]): string => {
  const skills = entries.filter((one) => one.identity.kind === 'skill').length
  const servers = entries.filter((one) => one.identity.kind === 'mcp').length
  if (skills === 0 && servers === 0) return `${subject.runtime} will load nothing new for this Seat.`
  const parts: string[] = []
  if (skills > 0) parts.push(`${skills} skill${skills === 1 ? '' : 's'}`)
  if (servers > 0) parts.push(`${servers} MCP server${servers === 1 ? '' : 's'}`)
  const serverNote = servers > 0 ? ' A server starts running the moment this Seat opens.' : ''
  return `Approving this lets ${subject.runtime} load ${parts.join(' and ')} for this Seat, at the ${subject.ceiling} ceiling it already has.${serverNote}`
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
  async preview(subject: AttachmentSubject, entries: readonly ResolvedAttachment[]): Promise<AttachmentReview> {
    const token = randomUUID()
    const expiresAt = this.#now() + REVIEW_TTL_MS
    this.#prune()
    this.#pending.set(token, { subject, identities: entries.map((one) => one.identity), expiresAt })
    const declarations: AttachmentDeclaration[] = entries.map((one) => ({
      kind: one.identity.kind,
      name: one.identity.name,
      identity: one.identity,
      problem: null,
    }))
    const files = entries.flatMap((one) =>
      one.files.map((file) => ({
        path: `${one.identity.kind}/${one.identity.name}/${file.path}`,
        text: new TextDecoder('utf-8', { fatal: false }).decode(file.bytes),
      })),
    )
    return {
      token,
      expiresAt,
      declarations,
      files,
      runtime: subject.runtime,
      effectiveCeiling: subject.ceiling,
      consequence: consequenceOf(subject, entries),
    }
  }

  /** Records the person's own answer, verbatim, as of exactly what `preview` showed — and only that. */
  async approve(token: string): Promise<void> {
    this.#prune()
    const pending = this.#pending.get(token)
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
        grant.ceiling === subject.ceiling &&
        this.#verify(key, grant),
    )
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
