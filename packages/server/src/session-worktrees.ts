import { createHash, randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join, resolve, relative, sep } from 'node:path'
import type { HostParams, HostResult, RuntimeId, SessionId, StorageCandidate, StorageKeptWorktree } from '@harnessdesk/protocol'
import { SessionIndex, type SessionWorktreeRecord } from './session-index.js'
import { changes, list, remove, restore, repositoryRoot, samePath, worktreeInventoryKey, branchExists } from './worktree.js'
import { diskBytes } from './storage-walk.js'

/** Conversation-owned inventory survives removal of the conversation's body or row. */
export class SessionWorktrees {
  #tail: Promise<unknown> = Promise.resolve()
  readonly #previews = new Map<string, { path: string; inventory: string; stamp: string }>()
  readonly #cleanups = new Map<string, { days: number; at: number; inventories: Map<string, { key: string; clean: boolean }> }>()
  constructor(private readonly index: SessionIndex, private readonly stateDir: string,
    private readonly working: (path: string) => boolean,
    private readonly live: (runtime: RuntimeId, id: SessionId) => boolean = () => false,
    private readonly removeWorktree: typeof remove = remove,
    private readonly liveAtPath: (path: string) => boolean = () => false) {}

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
        const removed = await this.removeWorktree(record.path, { stateDir: this.stateDir, keepIgnored: true, keepDetached: true,
          assertUnused: () => this.#assertUnused(record.path) })
        this.index.worktreeState(record.path, 'removed', removed.branch)
      } catch {
        // Git failures, unreadable inventories and dirty trees all keep the verb successful.
        this.index.worktreeState(record.path, 'kept')
        return 'The worktree stayed. Review it in Archive before discarding it.'
      }
    })
  }

  kept(): Promise<readonly StorageKeptWorktree[]> {
    return this.#serial(async () => {
      const rows = this.index.storageWorktrees().filter(row => row.state === 'kept' && row.hidden)
      const seen = new Set<string>(), result: StorageKeptWorktree[] = []
      for (const row of rows) {
        if (seen.has(row.path)) continue
        seen.add(row.path)
        try { result.push({ runtime: row.runtime, sessionId: row.id, title: row.title, path: row.path, changes: await changes(row.path) }) }
        catch (error) { result.push({ runtime: row.runtime, sessionId: row.id, title: row.title, path: row.path, reason: String(error) }) }
      }
      return result
    })
  }

  #inactive(params: HostParams<'storage/cleanupPreview'>): SessionWorktreeRecord[] {
    const before = Date.now() - params.olderThanDays * 86_400_000
    const excluded = new Set(params.exclude.map(row => JSON.stringify([row.runtime, row.sessionId])))
    const eligible = (row: { runtime: RuntimeId; id: SessionId; updatedAt: number | null }) =>
      row.updatedAt !== null && row.updatedAt < before && !this.live(row.runtime, row.id) && !excluded.has(JSON.stringify([row.runtime, row.id]))
    const rows = this.index.storageWorktrees(), seen = new Set<string>(), result: SessionWorktreeRecord[] = []
    for (const row of rows) {
      if (row.state !== 'present' || !eligible(row) || seen.has(row.path) || this.working(row.path) || this.liveAtPath(row.path)) continue
      if (rows.some(other => samePath(other.path, row.path) && (other.state !== 'present' || !eligible(other)))) continue
      if (this.index.storageOwners(row.path).some(other => !eligible(other))) continue
      seen.add(row.path); result.push(row)
    }
    return result
  }

  cleanupPreview(params: HostParams<'storage/cleanupPreview'>): Promise<HostResult<'storage/cleanupPreview'>> {
    return this.#serial(async () => {
      const candidates: StorageCandidate[] = [], inventories = new Map<string, { key: string; clean: boolean }>()
      for (const row of this.#inactive(params)) {
        // Inventory read failure aborts the preview; it never means clean.
        const key = await worktreeInventoryKey(row.path), pending = await changes(row.path)
        const bytes = await diskBytes(row.path)
        if (key !== await worktreeInventoryKey(row.path)) throw new Error('A worktree changed while reading it. Review again.')
        const clean = pending.modified === 0 && pending.untracked === 0 && pending.ignoredCount === 0
        inventories.set(row.path, { key, clean })
        candidates.push({ runtime: row.runtime, sessionId: row.id, title: this.index.storageWorktrees().find(owner => owner.runtime === row.runtime && owner.id === row.id)?.title ?? null,
          path: row.path, bytes, changes: pending, clean })
      }
      const hash = createHash('sha256').update(randomUUID())
      for (const [path, inventory] of inventories) if (!inventory.clean) hash.update(JSON.stringify([path, inventory.key]))
      const inventoryToken = hash.digest('hex')
      // A token is a host-held confirmation, never an inventory supplied by a client.
      while (this.#cleanups.size >= 20) this.#cleanups.delete(this.#cleanups.keys().next().value!)
      this.#cleanups.set(inventoryToken, { days: params.olderThanDays, at: Date.now(), inventories })
      return { candidates, cleanBytes: candidates.filter(row => row.clean).reduce((sum, row) => sum + row.bytes, 0), inventoryToken }
    })
  }

  cleanupInactive(params: HostParams<'storage/cleanup'>): Promise<HostResult<'storage/cleanup'>> {
    return this.#serial(async () => {
      const shown = this.#cleanups.get(params.inventoryToken)
      if (!shown || shown.days !== params.olderThanDays || Date.now() - shown.at > 15 * 60_000) throw new Error('Review the worktrees before removing them.')
      this.#cleanups.delete(params.inventoryToken)
      let removed = 0, kept = 0, freedBytes = 0
      const refused: { path: string; reason: string }[] = []
      for (const row of this.#inactive(params)) {
        const approved = shown.inventories.get(row.path)
        if (!approved) continue // A newly eligible tree was never shown.
        try {
          if (!approved.clean && !params.includeDirty) { kept++; continue }
          const pending = await changes(row.path)
          const dirty = pending.modified > 0 || pending.untracked > 0 || pending.ignoredCount > 0
          if (dirty && (approved.clean || !params.includeDirty)) { kept++; continue }
          const key = await worktreeInventoryKey(row.path)
          if (dirty && key !== approved.key) throw new Error('The worktree changed since you looked. Review it again.')
          // Count what actually goes now, never the earlier size estimate.
          const bytes = await diskBytes(row.path)
          const result = await this.removeWorktree(row.path, { stateDir: this.stateDir, keepIgnored: true, keepDetached: true,
            ...(dirty ? { force: true, expectedInventory: approved.key } : {}),
            assertUnused: () => {
              if (!this.#inactive(params).some(candidate => samePath(candidate.path, row.path))) throw new Error('A conversation now uses this worktree.')
            } })
          this.index.worktreeState(row.path, 'removed', result.branch)
          removed++; freedBytes += bytes
        } catch (error) { kept++; refused.push({ path: row.path, reason: error instanceof Error ? error.message : String(error) }) }
      }
      return { removed, kept, freedBytes, refused }
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
      // Discard and confirmed dirty Storage cleanup are the two lifecycle paths that force removal.
      const removed = await this.removeWorktree(record.path, { stateDir: this.stateDir, force: true, keepDetached: true, expectedInventory: approved.inventory,
        assertUnused: () => { this.#kept(runtime, id) } })
      this.index.worktreeState(record.path, 'removed', removed.branch)
      return { discarded: true }
    })
  }
}
