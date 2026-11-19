import { closeSync, mkdirSync, openSync, lstatSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

// JSON escapes NUL and preserves every JavaScript string, including lone surrogates.
// Node 22's SQLite TEXT reader otherwise truncates strings at embedded NULs.
const encode = (value: string): string => JSON.stringify(value)
const decode = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Invalid consult authority identifier')
  const decoded: unknown = JSON.parse(value)
  if (typeof decoded !== 'string' || encode(decoded) !== value) throw new Error('Invalid consult authority identifier')
  return decoded
}

export interface ClosedConsultAuthority { readonly incarnation: string; readonly root: string }

/** Host-lifetime closed consult facts. A failed store never answers as if empty. */
export class ConsultAuthorityStore {
  readonly file: string
  readonly #db: DatabaseSync
  readonly #identity: { readonly dev: number; readonly ino: number }
  #failed = false
  #closed = false

  constructor(directory: string, private readonly hooks: { readonly afterCommit?: () => void } = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, `consult-authority-${randomUUID()}.sqlite`)
    const fd = openSync(this.file, 'wx', 0o600)
    closeSync(fd)
    const identity = lstatSync(this.file)
    this.#identity = { dev: identity.dev, ino: identity.ino }
    try {
      this.#db = new DatabaseSync(this.file)
      this.#db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-1024;
        CREATE TABLE members (key TEXT PRIMARY KEY, incarnation TEXT NOT NULL, root TEXT NOT NULL) WITHOUT ROWID;`)
      if (this.#db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Consult authority store corrupt')
    } catch (error) {
      try {
        const current = lstatSync(this.file)
        if (current.isFile() && current.nlink === 1 && current.dev === this.#identity.dev && current.ino === this.#identity.ino) unlinkSync(this.file)
      } catch { /* leave an inaccessible file alone */ }
      throw error
    }
  }

  #check(): void {
    if (this.#failed || this.#closed) throw new Error('Consult authority store unavailable')
    try {
      const identity = lstatSync(this.file)
      if (identity.dev !== this.#identity.dev || identity.ino !== this.#identity.ino) throw new Error('Consult authority store replaced')
      if (!identity.isFile() || identity.nlink !== 1) throw new Error('Consult authority store is not a private regular file')
    } catch (error) { this.#failed = true; throw error }
  }

  #run<T>(operation: () => T): T {
    this.#check()
    try { return operation() } catch (error) { this.#failed = true; throw error }
  }

  #transaction<T>(operation: () => T): T {
    return this.#run(() => {
      this.#db.exec('BEGIN IMMEDIATE')
      try { const value = operation(); this.#db.exec('COMMIT'); this.hooks.afterCommit?.(); return value }
      catch (error) { try { this.#db.exec('ROLLBACK') } catch { /* original failure wins */ }; throw error }
    })
  }

  archive(incarnation: string, root: string, members: readonly string[], includeRoot = true): void {
    this.#transaction(() => {
      const insert = this.#db.prepare('INSERT INTO members VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
      const current = this.#db.prepare('SELECT incarnation, root FROM members WHERE key=?')
      for (const key of (function* () { if (includeRoot) yield root; yield* members })()) {
        insert.run(encode(key), encode(incarnation), encode(root))
        const owner = current.get(encode(key))
        if (!owner || decode(owner.incarnation) !== incarnation || decode(owner.root) !== root) throw new Error('Consult authority owner conflict')
      }
    })
  }

  lookup(key: string): ClosedConsultAuthority | null {
    return this.#run(() => {
      const row = this.#db.prepare('SELECT incarnation, root FROM members WHERE key=?').get(encode(key))
      return row ? { incarnation: decode(row.incarnation), root: decode(row.root) } : null
    })
  }

  inherit(parentKey: string, childKey: string): boolean {
    return this.#transaction(() => {
      const parent = this.#db.prepare('SELECT incarnation, root FROM members WHERE key=?').get(encode(parentKey))
      if (!parent) return false
      const incarnation = decode(parent.incarnation), root = decode(parent.root)
      this.#db.prepare('INSERT INTO members VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').run(encode(childKey), encode(incarnation), encode(root))
      const child = this.#db.prepare('SELECT incarnation, root FROM members WHERE key=?').get(encode(childKey))
      if (!child || decode(child.incarnation) !== incarnation || decode(child.root) !== root) throw new Error('Consult authority owner conflict')
      return true
    })
  }

  // Validate both stored fields before a conditional mutation can discard them.
  #owner(key: string): ClosedConsultAuthority | null {
    const row = this.#db.prepare('SELECT incarnation, root FROM members WHERE key=?').get(encode(key))
    return row ? { incarnation: decode(row.incarnation), root: decode(row.root) } : null
  }

  replace(key: string, expectedIncarnation: string, incarnation: string, root: string): boolean {
    return this.#run(() => {
      if (this.#owner(key)?.incarnation !== expectedIncarnation) return false
      return Number(this.#db.prepare('UPDATE members SET incarnation=?, root=? WHERE key=? AND incarnation=?').run(encode(incarnation), encode(root), encode(key), encode(expectedIncarnation)).changes) === 1
    })
  }

  release(key: string, expectedIncarnation: string): boolean {
    return this.#run(() => {
      if (this.#owner(key)?.incarnation !== expectedIncarnation) return false
      return Number(this.#db.prepare('DELETE FROM members WHERE key=? AND incarnation=?').run(encode(key), encode(expectedIncarnation)).changes) === 1
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
    try {
      const identity = lstatSync(this.file)
      if (identity.isFile() && identity.nlink === 1 && identity.dev === this.#identity.dev && identity.ino === this.#identity.ino) unlinkSync(this.file)
    } catch { /* absent or inaccessible: never remove another file */ }
  }
}
