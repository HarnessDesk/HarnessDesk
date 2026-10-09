import type { AgentRuntime, HistoryImportState, ListSessionsQuery, Page, RuntimeId, SessionSummary } from '@harnessdesk/protocol'
import type { SessionArchive } from './archive.js'
import type { SessionIndex } from './session-index.js'

interface Job { cancelled: boolean; readonly runtime: AgentRuntime; readonly scanAt: number }

/** Metadata only: no transcript read, repository resolution or agent-file write. */
export class HistoryImport {
  readonly #jobs = new Map<RuntimeId, Job>()
  #closed = false
  constructor(readonly ports: {
    index: SessionIndex
    archive: SessionArchive
    resolve(runtime: RuntimeId): AgentRuntime
    start(runtime: AgentRuntime): Promise<void>
    list(runtime: AgentRuntime, query: ListSessionsQuery): Promise<Page<SessionSummary>>
    changed(runtime: RuntimeId, state: HistoryImportState): void
    now?: () => number
  }) { ports.index.interruptImports() }

  status(runtime: RuntimeId): HistoryImportState | null { return this.ports.index.importStatus(runtime) }

  import(id: RuntimeId): void {
    const runtime = this.ports.resolve(id)
    if (!runtime.info.capabilities.listHistory) throw new Error(`${runtime.info.presentation.name} cannot import history for this account.`)
    if (this.#closed) throw new Error('The host is closing')
    const now = this.ports.now?.() ?? Date.now()
    const previous = this.status(id)
    if (this.#jobs.has(id) || (previous?.state === 'done' && now - previous.lastScanAt < 60_000)) return
    const job: Job = { runtime, cancelled: false, scanAt: now }
    this.#jobs.set(id, job)
    this.#save(id, job, 'running')
    void this.#run(id, job)
  }

  #current(id: RuntimeId, job: Job): boolean {
    return !this.#closed && !job.cancelled && this.#jobs.get(id) === job && this.ports.resolve(id) === job.runtime
  }

  #save(id: RuntimeId, job: Job, state: HistoryImportState['state'], error?: string): void {
    const value: HistoryImportState = { state, count: this.ports.index.importedCount(id),
      importedAt: state === 'done' ? (this.ports.now?.() ?? Date.now()) : this.status(id)?.importedAt ?? null,
      lastScanAt: job.scanAt, ...(error ? { error } : {}) }
    this.ports.index.saveImport(id, value)
    this.ports.changed(id, value)
  }

  async #run(id: RuntimeId, job: Job): Promise<void> {
    try {
      await this.ports.start(job.runtime)
      await this.ports.archive.load()
      for (const archived of job.runtime.info.capabilities.archiveHistory ? ['only', 'exclude'] as const : ['exclude'] as const) {
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          if (!this.#current(id, job)) return
          const page = await this.ports.list(job.runtime, { archived, pageSize: 500, ...(cursor ? { cursor } : {}) })
          if (!this.#current(id, job)) return
          this.ports.index.importPage(page.data.map(row => ({ ...row, runtime: id })), row => job.runtime.info.capabilities.archiveHistory
            ? archived === 'only' : this.ports.archive.has(id, row.id))
          this.#save(id, job, 'running')
          cursor = page.nextCursor ?? undefined
          if (cursor && seen.has(cursor)) throw new Error('History listing repeated its cursor')
          if (cursor) seen.add(cursor)
        } while (cursor)
      }
      if (this.#current(id, job)) this.#save(id, job, 'done')
    } catch (error) {
      if (!this.#closed && this.#jobs.get(id) === job && !job.cancelled) this.#save(id, job, 'failed', String(error))
    } finally {
      if (this.#jobs.get(id) === job) this.#jobs.delete(id)
    }
  }

  cancel(id: RuntimeId): void {
    const job = this.#jobs.get(id)
    if (!job) return
    job.cancelled = true
    this.#save(id, job, 'cancelled')
    this.#jobs.delete(id)
  }

  close(): void {
    for (const id of this.#jobs.keys()) this.cancel(id)
    this.#closed = true
  }
}
