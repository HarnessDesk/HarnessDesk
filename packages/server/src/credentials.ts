import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * The credential broker.
 *
 * Follows the design the architecture review rated best (DSH's
 * `ctx.credentials`): values go in, **references** come out, and nothing that
 * can be reached from the renderer — or from a plugin — ever returns a value.
 * `describe()` lists names and references; `resolve()` exists only host-side
 * and is called in exactly one place, where the loopback gateway is handed
 * its upstream key.
 *
 * Storage is pluggable. The desktop shell supplies an Electron
 * `safeStorage`-backed cipher (OS keychain material); standalone development
 * falls back to plain bytes with the fact recorded on the store, so the UI
 * can say which protection is in force rather than imply one.
 */

export interface CredentialCipher {
  /** A human answer to "how is this protected", e.g. `macOS Keychain`. */
  readonly protection: string
  encrypt(plaintext: string): Buffer
  decrypt(blob: Buffer): string
}

/** The development fallback: file permissions are the only protection. */
export const plainCipher: CredentialCipher = {
  protection: 'file permissions only',
  encrypt: (plaintext) => Buffer.from(plaintext, 'utf8'),
  decrypt: (blob) => blob.toString('utf8'),
}

export interface CredentialInfo {
  readonly ref: string
  readonly name: string
  readonly createdAt: number
  /**
   * The agent this secret signs in, when the broker minted it for one.
   *
   * The store holds two unrelated kinds: a key a *route* refers to, whose
   * only owner is the route, and a key an *agent* authenticates with, minted
   * by `secretName` and cleared through `runtime/apiKey/clear` — which also
   * reloads the runtime's secrets, as a plain delete does not.
   *
   * Told apart here rather than by the reader, because the name's shape is
   * this class's own invention. A surface that parsed it would be a second
   * copy of `secretName`, and the first surface to list credentials did
   * exactly that by accident: with no way to tell, it drew every agent's
   * sign-in key as an unused leftover with a Remove beside it.
   */
  readonly agent: string | null
}

interface StoredEntry {
  readonly name: string
  readonly createdAt: number
  readonly blob: string
  /**
   * The cipher that wrote this blob, by its own name. The same file is read
   * by the desktop shell (OS keystore) and by a standalone host (plain
   * bytes), and a blob written by one is meaningless to the other — so the
   * reader checks before decrypting rather than throwing a cipher error at
   * whatever asked. Absent on entries written before this was recorded.
   */
  readonly protection?: string
}

export class CredentialBroker {
  readonly #path: string
  readonly #cipher: CredentialCipher
  #entries: Map<string, StoredEntry> | null = null

  constructor(path: string, cipher: CredentialCipher = plainCipher) {
    this.#path = path
    this.#cipher = cipher
  }

  get protection(): string {
    return this.#cipher.protection
  }

  /** Names and references. Never values — there is no method that returns one. */
  async describe(): Promise<readonly CredentialInfo[]> {
    const entries = await this.#load()
    return [...entries.entries()]
      .map(([ref, entry]) => ({
        ref,
        name: entry.name,
        createdAt: entry.createdAt,
        agent: CredentialBroker.agentOf(entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async store(name: string, value: string): Promise<string> {
    const trimmed = name.trim()
    if (trimmed.length === 0) throw new Error('A credential needs a name.')
    if (value.length === 0) throw new Error('An empty credential protects nothing; not stored.')
    const entries = await this.#load()
    const ref = `cred_${randomBytes(9).toString('hex')}`
    entries.set(ref, {
      name: trimmed,
      createdAt: Date.now(),
      blob: this.#cipher.encrypt(value).toString('base64'),
      protection: this.#cipher.protection,
    })
    await this.#persist(entries)
    return ref
  }

  async delete(ref: string): Promise<void> {
    const entries = await this.#load()
    if (entries.delete(ref)) await this.#persist(entries)
  }

  /**
   * Host-internal only. The single caller is the gateway supervisor, which
   * feeds the value to the gateway child over stdin. Never dispatch this from
   * the wire, and never put its result in a log, an event, or an error.
   */
  /**
   * The name an agent's secret is stored under. Deterministic, so the shell
   * can store and clear one without tracking references, and readable in the
   * credential list: `agent:dsh:DEEPSEEK_API_KEY`.
   */
  static secretName(runtime: string, env: string): string {
    return `agent:${runtime}:${env}`
  }

  /**
   * The runtime a stored name belongs to, or `null` for anything else.
   *
   * The other half of `secretName`, and deliberately beside it: a caller that
   * needs to know what a credential is asks this class, which is the one that
   * decided. A runtime id has no colons, so the shape is exact — a route key
   * a user happened to call `agent:something` is not two colons deep and does
   * not match.
   */
  static agentOf(name: string): string | null {
    const parts = name.split(':')
    return parts.length === 3 && parts[0] === 'agent' && parts[1] ? parts[1] : null
  }

  /** Loads the file so `peek` can answer without awaiting. */
  async warm(): Promise<void> {
    await this.#load()
  }

  /**
   * A stored value by name, synchronously, for the one caller that cannot
   * await: building a child process's environment at spawn. Host-side only —
   * nothing on the wire reaches this, and `warm()` must have run.
   */
  peek(name: string): string | undefined {
    for (const entry of this.#entries?.values() ?? []) {
      if (entry.name === name) return this.#read(entry)
    }
    return undefined
  }

  /**
   * A stored blob as a value, or nothing when this host cannot read it.
   *
   * Unreadable is a real state, not an error: a key stored by the standalone
   * host is protected by file permissions alone, and the desktop shell's
   * keystore cipher cannot decrypt it (nor the reverse). Reporting that as
   * "no key" makes the shell offer the field again, which fixes it; throwing
   * took down the whole account read instead.
   */
  #read(entry: StoredEntry): string | undefined {
    const wrote = entry.protection ?? plainCipher.protection
    if (wrote !== this.#cipher.protection) {
      if (!this.#warned.has(entry.name)) {
        this.#warned.add(entry.name)
        this.#onUnreadable?.(entry.name, wrote, this.#cipher.protection)
      }
      return undefined
    }
    try {
      return this.#cipher.decrypt(Buffer.from(entry.blob, 'base64'))
    } catch {
      return undefined
    }
  }

  readonly #warned = new Set<string>()
  #onUnreadable: ((name: string, wrote: string, reader: string) => void) | undefined

  /** Told once per name when a stored secret cannot be read here. */
  onUnreadable(listener: (name: string, wrote: string, reader: string) => void): void {
    this.#onUnreadable = listener
  }

  /** Stores under a fixed name, replacing whatever was there. */
  async put(name: string, value: string): Promise<void> {
    await this.forget(name)
    await this.store(name, value)
  }

  /** Removes every entry with this name; absent is success. */
  async forget(name: string): Promise<void> {
    const entries = await this.#load()
    for (const [ref, entry] of entries) if (entry.name === name) entries.delete(ref)
    await this.#persist(entries)
  }

  async resolve(ref: string): Promise<string> {
    const entry = (await this.#load()).get(ref)
    if (!entry) throw new Error('That credential no longer exists. Add it again in Settings.')
    const value = this.#read(entry)
    if (value === undefined) {
      throw new Error(
        `${entry.name} was stored with different protection (${entry.protection ?? plainCipher.protection}) and cannot be read here. Enter it again.`,
      )
    }
    return value
  }

  async #load(): Promise<Map<string, StoredEntry>> {
    if (this.#entries) return this.#entries
    try {
      const raw = JSON.parse(await readFile(this.#path, 'utf8')) as Record<string, StoredEntry>
      this.#entries = new Map(Object.entries(raw))
    } catch {
      this.#entries = new Map()
    }
    return this.#entries
  }

  async #persist(entries: Map<string, StoredEntry>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.tmp`
    await writeFile(tmp, JSON.stringify(Object.fromEntries(entries), null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.#path)
  }
}
