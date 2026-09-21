import { watch, type FSWatcher } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

import type { GitReader, LogCursor, RepoHandle, ReflogMove } from './git.js'
import { digest, JOURNAL_LIMIT, object, ProvenanceJournal, type JournalEntry, writeCheckpoint } from './journal.js'
import { moves } from './model.js'
import type { CommitObservation } from './reconcile.js'

export interface ObserverCheckpoint {
  readonly generation: number
  readonly refs: readonly (readonly [string, string])[]
  readonly heads: readonly (readonly [string, string | null])[]
  readonly logs: readonly (readonly [string, LogCursor])[]
  readonly frontier: readonly string[]
  readonly capturedThrough: number
  readonly scanStartedAt: number
}
export interface WorkerCheckpoint extends ObserverCheckpoint {
  readonly rangeKeys: readonly string[]
  readonly rangePending: readonly string[]
  readonly baseline: readonly string[]
}
export interface RefObserverOptions {
  readonly git: GitReader
  readonly journal: ProvenanceJournal
  readonly changed: () => void
  readonly problem: (kind: 'degraded' | 'stopped', reason: string) => void
  readonly now?: () => number
  readonly reconcile?: (
    entries: readonly JournalEntry[], checkpoint: WorkerCheckpoint, signal: AbortSignal,
  ) => Promise<Pick<WorkerCheckpoint, 'rangeKeys' | 'rangePending'>>
  /** Tests can shorten clocks or refuse a watch; real-watch tests use the real function. */
  readonly watch?: typeof watch
  readonly pollMs?: number
  readonly debounceMs?: number
}

/** One active scan and one dirty bit, including wakes arriving between awaits. */
export class Coalesced {
  #dirty = false
  #closed = false
  #running: Promise<void> | null = null
  readonly controller = new AbortController()
  constructor(readonly scan: (signal: AbortSignal) => Promise<void>, readonly failed: (error: unknown) => void) {}

  wake(): void {
    if (this.#closed) return
    this.#dirty = true
    if (this.#running) return
    this.#running = Promise.resolve().then(async () => {
      while (this.#dirty && !this.#closed) {
        this.#dirty = false
        try {
          await this.scan(this.controller.signal)
        } catch (error) {
          if (!this.#closed) this.failed(error)
          this.#dirty = false
        }
        await setImmediate()
      }
    }).finally(() => { this.#running = null })
  }

  async idle(): Promise<void> {
    while (this.#running) await this.#running
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#dirty = false
    this.controller.abort()
    await this.idle()
  }
}

let watchers = 0
const empty = (): WorkerCheckpoint => ({
  generation: 0, refs: [], heads: [], logs: [], frontier: [],
  capturedThrough: 0, scanStartedAt: 0, rangeKeys: [], rangePending: [], baseline: [],
})
const values = <T>(entries: readonly JournalEntry[], kind: JournalEntry['kind']): T[] =>
  entries.filter((entry) => entry.kind === kind && !('restoredAt' in (entry.value as object)))
    .map((entry) => entry.value as T)
export { values as localValues }

export class RefObserver {
  readonly #options: RefObserverOptions
  readonly #queue: Coalesced
  #checkpoint = empty()
  #handle: RepoHandle | null = null
  #closed = false
  #watchers = new Map<string, FSWatcher>()
  #poll: ReturnType<typeof setTimeout> | null = null
  #debounce: ReturnType<typeof setTimeout> | null = null
  #requested = new Set<string>()

  constructor(options: RefObserverOptions) {
    this.#options = options
    this.#queue = new Coalesced((signal) => this.#scan(signal), (error) => {
      const reason = (error as Error).message
      options.problem(reason.startsWith('provenance-') ? 'stopped' : 'degraded',
        reason.includes('limit') ? 'limit-exceeded' : reason.startsWith('provenance-') ? 'storage-failed' : 'history-gap')
    })
  }

  async start(handle: RepoHandle, checkpoint: ObserverCheckpoint | null): Promise<void> {
    if (this.#closed) return
    this.#handle = handle
    this.#checkpoint = checkpoint ? { ...empty(), ...checkpoint } : empty()
    await this.#attach()
    if (this.#closed) return
    this.#schedulePoll(true)
    this.wake()
  }

  wake(): void {
    this.#queue.wake()
  }

  /** History reads queue only full IDs, and never wait for their objects. */
  request(shas: readonly string[]): void {
    for (const sha of shas) this.#requested.add(sha)
    this.wake()
  }

  idle(): Promise<void> {
    return this.#queue.idle()
  }

  #schedulePoll(first = false): void {
    if (this.#closed) return
    const interval = this.#options.pollMs ?? 30000
    if (interval === 0) return
    this.#poll = setTimeout(() => {
      this.wake()
      this.#schedulePoll()
    }, first ? Math.max(1, Math.floor(Math.random() * interval)) : interval)
    this.#poll.unref()
  }

  #event(): void {
    if (this.#closed || this.#debounce) return
    this.#debounce = setTimeout(() => {
      this.#debounce = null
      this.wake()
    }, this.#options.debounceMs ?? 250)
    this.#debounce.unref()
  }

  async #attach(): Promise<void> {
    if (!this.#handle || this.#closed) return
    const directories = new Set<string>()
    let visited = 0
    const add = async (path: string, descend: boolean): Promise<void> => {
      if (this.#closed) return
      if (++visited > 50000) throw new Error('limit-exceeded')
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!info) return
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('external-metadata')
      directories.add(path)
      if (descend) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error('external-metadata')
          if (entry.isDirectory()) await add(join(path, entry.name), true)
        }
      }
    }
    try {
      await add(this.#handle.commonDir, false)
      await add(join(this.#handle.commonDir, 'refs'), true)
      await add(join(this.#handle.commonDir, 'logs'), true)
      await add(join(this.#handle.commonDir, 'worktrees'), false)
      for (const gitdir of this.#handle.checkouts.values()) {
        await add(gitdir, false)
        await add(join(gitdir, 'logs'), true)
      }
      for (const directory of directories) {
        if (this.#closed) break
        if (this.#watchers.has(directory)) continue
        if (this.#watchers.size >= 256 || watchers >= 1024) throw new Error('watch-limit')
        const watcher = (this.#options.watch ?? watch)(directory, () => this.#event())
        watcher.on('error', () => {
          if (this.#watchers.get(directory) === watcher) {
            this.#watchers.delete(directory)
            watcher.close()
            watchers -= 1
          }
          this.#options.problem('degraded', 'watch-unavailable')
          // Polling retries attachment; an error must not create a rescan loop.
        })
        this.#watchers.set(directory, watcher)
        watchers += 1
      }
      for (const [directory, watcher] of this.#watchers) {
        if (directories.has(directory)) continue
        watcher.close()
        this.#watchers.delete(directory)
        watchers -= 1
      }
    } catch {
      this.#options.problem('degraded', 'watch-unavailable')
    }
  }

  async #scan(signal: AbortSignal): Promise<void> {
    if (!this.#handle) return
    const { git, journal } = this.#options
    const now = this.#options.now ?? Date.now
    const prior = this.#checkpoint
    const read = await journal.read()
    if (read.broken) throw new Error('provenance-journal-damaged')
    const commits = new Map(values<CommitObservation>(read.entries, 'commit').map((entry) => [entry.sha, entry]))
    const acknowledged = [...read.entries].reverse().find((entry) => entry.kind === 'cursor' &&
      object(entry.value) && entry.value.type === 'checkpoint')?.seq ?? 0
    const unacknowledged = new Set(read.entries.filter((entry) => entry.seq > acknowledged &&
      entry.kind === 'commit' && object(entry.value) && !('restoredAt' in entry.value))
      .map((entry) => (entry.value as CommitObservation).sha))
    const snapshot = await git.snapshot(signal)
    const logs = await git.reflogs(new Map(prior.logs), signal)
    const generation = prior.generation + 1
    const delta: ReflogMove[] = moves(new Map(prior.refs), snapshot.refs).map((move) => ({
      ...move, id: digest(['snapshot', generation, move]), checkout: null, recordedAt: null,
    }))
    for (const checkout of new Set([...new Map(prior.heads).keys(), ...snapshot.heads.keys()])) {
      const before = new Map(prior.heads).get(checkout) ?? null
      const after = snapshot.heads.get(checkout) ?? null
      if (before !== after) delta.push({
        id: digest(['head', generation, checkout, before, after]), ref: 'HEAD', checkout,
        before, after, recordedAt: null,
      })
    }
    for (const move of [...logs.moves, ...delta]) await journal.append('ref', move)
    const gaps = [...logs.gaps]
    if (prior.generation && delta.some((move) => !logs.moves.some((logged) =>
      logged.ref === move.ref && logged.checkout === move.checkout && logged.after === move.after,
    ))) gaps.push('snapshot-only')
    for (const reason of new Set(gaps)) {
      await journal.append('gap', {
        id: digest(['gap', generation, reason]), reason, from: prior.scanStartedAt || null, to: snapshot.takenAt,
      })
      this.#options.problem('degraded', 'history-gap')
    }
    const first = prior.generation === 0
    const tips = first ? [...snapshot.refs.values(), ...snapshot.heads.values()]
      : [...logs.moves, ...delta].flatMap((move) => [move.before, move.after])
    const requested = [...this.#requested]
    const frontier = [...new Set([...prior.frontier, ...tips, ...requested].filter((sha): sha is string => !!sha))]
    const baseline = first ? [...new Set(tips.filter((sha): sha is string => !!sha))] : [...prior.baseline]
    const began = performance.now()
    let captured = 0
    while (frontier.length && captured < 200 && performance.now() - began < 50) {
      signal.throwIfAborted()
      const sha = frontier.shift()!
      const existing = commits.get(sha)
      if (existing) {
        if (unacknowledged.delete(sha) && !first && !baseline.includes(sha)) {
          for (const parent of existing.parents) if (!commits.has(parent) && !frontier.includes(parent)) frontier.push(parent)
        }
        continue
      }
      const object = await git.commit(sha, signal)
      if (!object) {
        // Refs retain tag object IDs. A bounded rev-list peels a tag without
        // executing project configuration or traversing its whole ancestry.
        const targets = await git.ancestors([sha], new Set(), 1, signal).catch(() => [])
        signal.throwIfAborted()
        const target = targets[0]
        if (target && target !== sha) {
          if (first && !baseline.includes(target)) baseline.push(target)
          if (!commits.has(target) && !frontier.includes(target)) frontier.unshift(target)
          captured += 1
          continue
        }
      }
      let observation: CommitObservation = {
        id: digest(['commit', 1, sha]), sha, tree: object?.tree ?? sha, parents: object?.parents ?? [],
        firstSeenAt: now(), fingerprintVersion: 1,
        discoveredBy: [...logs.moves, ...delta].filter((move) => move.before === sha || move.after === sha).map((move) => move.id),
        checkoutHints: [...this.#handle.checkouts.keys()],
        window: { from: prior.scanStartedAt || null, to: snapshot.takenAt },
        patch: null, files: [], why: object ? null : 'missing-object',
      }
      if (object) {
        try {
          const from = object.parents[0] ?? null
          observation = { ...observation, patch: await git.patch(from, sha, signal), files: await git.files(from, sha, signal) }
        } catch (error) {
          signal.throwIfAborted()
          observation = { ...observation, why: (error as Error).message === 'limit-exceeded' ? 'limit-exceeded' : 'missing-object' }
        }
      }
      if (Buffer.byteLength(JSON.stringify(observation)) > JOURNAL_LIMIT - 1024) {
        observation = { ...observation, patch: null, files: [], discoveredBy: [], checkoutHints: [], why: 'limit-exceeded' }
      }
      await journal.append('commit', observation)
      commits.set(sha, observation)
      if (observation.why) this.#options.problem('degraded', observation.why === 'limit-exceeded' ? 'limit-exceeded' : 'history-gap')
      if (!first && !baseline.includes(sha)) {
        for (const parent of observation.parents) if (!commits.has(parent) && !frontier.includes(parent)) frontier.push(parent)
      }
      captured += 1
    }
    signal.throwIfAborted()
    let next: WorkerCheckpoint = {
      generation, refs: [...snapshot.refs], heads: [...snapshot.heads], logs: [...logs.cursors],
      frontier, capturedThrough: captured ? now() : prior.capturedThrough, scanStartedAt: snapshot.takenAt,
      baseline, rangeKeys: prior.rangeKeys, rangePending: prior.rangePending,
    }
    if (this.#options.reconcile) {
      const ranges = await this.#options.reconcile((await journal.read()).entries, next, signal)
      next = { ...next, ...ranges }
    }
    signal.throwIfAborted()
    await writeCheckpoint(journal, next)
    this.#checkpoint = next
    for (const sha of requested) this.#requested.delete(sha)
    await this.#attach()
    this.#options.changed()
    if (logs.more || frontier.length || next.rangePending.some((key) => !key.startsWith('limit:'))) this.wake()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#poll) clearTimeout(this.#poll)
    if (this.#debounce) clearTimeout(this.#debounce)
    for (const watcher of this.#watchers.values()) {
      watcher.close()
      watchers -= 1
    }
    this.#watchers.clear()
    await this.#queue.close()
    await this.#options.git.close()
    await this.#options.journal.flush()
  }
}
