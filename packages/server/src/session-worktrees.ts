import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join, resolve, relative, sep } from 'node:path'
import type { HostResult, RuntimeId, SessionId } from '@harnessdesk/protocol'
import { SessionIndex, type SessionWorktreeRecord } from './session-index.js'
import { changes, list, remove, restore, repositoryRoot, samePath, worktreeInventoryKey, branchExists } from './worktree.js'

/** Conversation-owned inventory survives removal of the conversation's body or row. */
export class SessionWorktrees {
  #tail: Promise<unknown> = Promise.resolve()
  readonly #previews = new Map<string, { path: string; inventory: string; stamp: string }>()
  constructor(private readonly index: SessionIndex, private readonly stateDir: string,
    private readonly working: (path: string) => boolean) {}

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work)
    this.#tail = next.catch(() => {})
    return next
  }

  async settled(): Promise<void> { await this.#tail }

  remember(runtime: RuntimeId, id: SessionId, refresh = false): Promise<void> {
    return this.#serial(() => this.#remember(runtime, id, refresh))
  }

  async #remember(runtime: RuntimeId, id: SessionId, refresh = false): Promise<void> {
    const row = this.index.get(runtime, id)
    if (!row || this.index.isRemoved(runtime, id)) return
    const previous = this.index.worktree(runtime, id)
    if (previous && (previous.state === 'removed' || !refresh && (samePath(row.cwd, previous.path) || row.cwd.startsWith(previous.path + sep)))) return
    // Ordinary conversations pay no Git read for this inventory.
    const inside = relative(join(this.stateDir, 'worktrees'), resolve(row.cwd))
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || resolve(inside) === inside) return
    const root = await repositoryRoot(row.cwd)
    if (!root) return
    const entry = (await list(root, this.stateDir)).find(tree => tree.managed &&
      (samePath(tree.path, row.cwd) || row.cwd.startsWith(tree.path + sep)))
    if (entry) this.index.rememberWorktree({ runtime, id, root, path: entry.path, branch: entry.branch, state: 'present' })
  }

  cleanup(runtime: RuntimeId, id: SessionId, unreadInventory = false): Promise<string | undefined> {
    return this.#serial(async () => {
      await this.#remember(runtime, id).catch(() => { unreadInventory = true })
      const record = this.index.worktree(runtime, id)
      if (!record) return unreadInventory ? 'The worktree stayed because its inventory could not be read.' : undefined
      if (record.state === 'removed') return
      if (this.index.worktreeInUse(record.path) || this.working(record.path)) {
        this.index.worktreeState(record.path, 'kept')
        return 'The worktree stayed because another conversation still uses it.'
      }
      try {
        await remove(record.path, { stateDir: this.stateDir, keepIgnored: true, keepDetached: true,
          assertUnused: () => this.#assertUnused(record.path) })
        this.index.worktreeState(record.path, 'removed')
      } catch {
        // Git failures, unreadable inventories and dirty trees all keep the verb successful.
        this.index.worktreeState(record.path, 'kept')
        return 'The worktree stayed. Review it in Archive before discarding it.'
      }
    })
  }

  prepare(runtime: RuntimeId, id: SessionId): Promise<{ cwd?: string; warning?: string }> {
    return this.#serial(async () => {
      const record = this.index.worktree(runtime, id)
      if (!record) return {}
      if (record.state !== 'removed') return {}
      if (await access(record.path).then(() => true, () => false)) {
        const entry = (await list(record.root, this.stateDir)).find(tree => tree.managed && samePath(tree.path, record.path) && tree.branch === record.branch)
        if (!entry) throw new Error('The managed worktree path is occupied. Review it before reopening.')
      } else if (!record.branch || !await branchExists(record.root, record.branch)) {
        this.index.setCwd(runtime, id, record.root)
        return { cwd: record.root, warning: 'The worktree branch is gone; this conversation opens in the main checkout.' }
      } else {
        await restore(record.root, record.path, record.branch, this.stateDir)
      }
      this.index.worktreeState(record.path, 'present')
      const old = this.index.get(runtime, id)?.cwd ?? record.path
      const cwd = samePath(old, record.path) || old.startsWith(record.path + sep) ? old : record.path
      this.index.setCwd(runtime, id, cwd)
      return { cwd }
    })
  }

  preview(runtime: RuntimeId, id: SessionId): Promise<HostResult<'session/worktreePreview'>> {
    return this.#serial(() => this.#preview(this.#kept(runtime, id)))
  }

  #kept(runtime: RuntimeId, id: SessionId): SessionWorktreeRecord {
    const record = this.index.worktree(runtime, id)
    if (!record || record.state !== 'kept') throw new Error('That conversation has no kept worktree.')
    this.#assertUnused(record.path)
    return record
  }

  #assertUnused(path: string): void {
    if (this.index.worktreeInUse(path) || this.working(path)) throw new Error('A conversation still uses this worktree. Archive it before discarding.')
  }

  async #preview(record: SessionWorktreeRecord): Promise<HostResult<'session/worktreePreview'>> {
    const inventory = await worktreeInventoryKey(record.path)
    const pending = await changes(record.path)
    if (inventory !== await worktreeInventoryKey(record.path)) throw new Error('The worktree changed while reading it. Review it again.')
    const stamp = randomUUID()
    const approved = { path: record.path, inventory, stamp }
    this.#previews.set(JSON.stringify([record.runtime, record.id]), approved)
    // Stamp is bound to the conversation as well as the full, uncapped inventory.
    return { changes: pending, stamp }
  }

  discard(runtime: RuntimeId, id: SessionId, stamp: string): Promise<HostResult<'session/discardWorktree'>> {
    return this.#serial(async () => {
      const record = this.#kept(runtime, id)
      const key = JSON.stringify([runtime, id])
      const approved = this.#previews.get(key)
      if (!approved || approved.stamp !== stamp || !samePath(approved.path, record.path)) throw new Error('Review the worktree before discarding it.')
      this.#previews.delete(key)
      if (approved.inventory !== await worktreeInventoryKey(record.path)) return { discarded: false, preview: await this.#preview(record) }
      // This is the sole conversation-lifecycle entry that forces a removal, after confirmation.
      await remove(record.path, { stateDir: this.stateDir, force: true, keepDetached: true, expectedInventory: approved.inventory,
        assertUnused: () => { this.#kept(runtime, id) } })
      this.index.worktreeState(record.path, 'removed')
      return { discarded: true }
    })
  }
}
