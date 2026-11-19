import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export interface ClosedConsultAuthority { readonly incarnation: string; readonly root: string }

/** Host-lifetime closed consult facts. A failed store never answers as if empty. */
export class ConsultAuthorityStore {
  readonly file: string
  readonly #db: DatabaseSync
  readonly #identity: { readonly dev: number; readonly ino: number }
  #failed = false
  #closed = false

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, `consult-authority-${randomUUID()}.sqlite`)
    const fd = openSync(this.file, 'wx', 0o600)
    closeSync(fd)
    const identity = statSync(this.file)
    this.#identity = { dev: identity.dev, ino: identity.ino }
    try {
      this.#db = new DatabaseSync(this.file)
      this.#db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-1024;
        CREATE TABLE members (key TEXT PRIMARY KEY, incarnation TEXT NOT NULL, root TEXT NOT NULL) WITHOUT ROWID;`)
    } catch (error) {
      try { unlinkSync(this.file) } catch { /* leave an inaccessible file alone */ }
      throw error
    }
  }

  #check(): void {
    if (this.#failed || this.#closed) throw new Error('Consult authority store unavailable')
    try {
      const identity = statSync(this.file)
      if (identity.dev !== this.#identity.dev || identity.ino !== this.#identity.ino) throw new Error('Consult authority store replaced')
      const check = this.#db.prepare('PRAGMA quick_check').get()
      if (check?.quick_check !== 'ok') throw new Error('Consult authority store corrupt')
    } catch (error) { this.#failed = true; throw error }
  }

  #run<T>(operation: () => T): T {
    this.#check()
    try { return operation() } catch (error) { this.#failed = true; throw error }
  }

  #transaction<T>(operation: () => T): T {
    return this.#run(() => {
      this.#db.exec('BEGIN IMMEDIATE')
      try { const value = operation(); this.#db.exec('COMMIT'); return value }
      catch (error) { try { this.#db.exec('ROLLBACK') } catch { /* original failure wins */ }; throw error }
    })
  }

  archive(incarnation: string, root: string, members: readonly string[]): void {
    this.#transaction(() => {
      const insert = this.#db.prepare('INSERT INTO members VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
      const current = this.#db.prepare('SELECT incarnation, root FROM members WHERE key=?')
      for (const key of members) {
        insert.run(key, incarnation, root)
        const owner = current.get(key)
        if (owner?.incarnation !== incarnation || owner.root !== root) throw new Error('Consult authority owner conflict')
      }
    })
  }

  lookup(key: string): ClosedConsultAuthority | null {
    return this.#run(() => {
      const row = this.#db.prepare('SELECT incarnation, root FROM members WHERE key=?').get(key)
      return row ? { incarnation: String(row.incarnation), root: String(row.root) } : null
    })
  }

  inherit(parentKey: string, childKey: string): boolean {
    return this.#transaction(() => {
      const parent = this.#db.prepare('SELECT incarnation, root FROM members WHERE key=?').get(parentKey)
      if (!parent) return false
      this.#db.prepare('INSERT INTO members VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').run(childKey, String(parent.incarnation), String(parent.root))
      const child = this.#db.prepare('SELECT incarnation, root FROM members WHERE key=?').get(childKey)
      if (child?.incarnation !== parent.incarnation || child?.root !== parent.root) throw new Error('Consult authority owner conflict')
      return true
    })
  }

  replace(key: string, expectedIncarnation: string, incarnation: string, root: string): boolean {
    return this.#run(() => Number(this.#db.prepare('UPDATE members SET incarnation=?, root=? WHERE key=? AND incarnation=?').run(incarnation, root, key, expectedIncarnation).changes) === 1)
  }

  release(key: string, expectedIncarnation: string): boolean {
    return this.#run(() => Number(this.#db.prepare('DELETE FROM members WHERE key=? AND incarnation=?').run(key, expectedIncarnation).changes) === 1)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
    try {
      const identity = statSync(this.file)
      if (identity.dev === this.#identity.dev && identity.ino === this.#identity.ino) unlinkSync(this.file)
    } catch { /* absent or inaccessible: never remove another file */ }
  }
}
