import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  CaptureHealth, CommitProvenance, EvidenceRecord, ProjectProvenance,
  ProvenanceReason, ProvenanceSeatDetail, SeatRecord, WireNotification,
} from '@harnessdesk/protocol'

import type { EvidencePlane } from '../evidence/plane.js'
import { foldSeats } from '../evidence/records.js'
import { exportProvenance, importProvenance } from './backup.js'
import { admitProject, gitReader, oid, type GitReader, type RepoHandle } from './git.js'
import { captureHealth } from './health.js'
import { digest, object, ProvenanceJournal, readCheckpoint, type JournalEntry } from './journal.js'
import { localValues, RefObserver, type WorkerCheckpoint } from './observer.js'
import { ProvenancePreferences } from './preferences.js'
import {
  captureRange, factSource, rangeCandidates, rangeSource, reconcileProject, relatedEvidence,
  type CommitObservation, type LinkObservation, type RangeObservation, type ProvenanceSource,
} from './reconcile.js'

export interface ProvenancePort {
  readonly evidence: EvidencePlane
  readonly stateDir: string
  readonly projects: () => readonly string[]
  readonly push: (notice: WireNotification) => void
  readonly log: (message: string, details?: Readonly<Record<string, unknown>>) => void
}
interface Project {
  project: string
  handle: RepoHandle | null
  observer: RefObserver | null
  journal: ProvenanceJournal
  entries: readonly JournalEntry[]
  seats: readonly SeatRecord[]
  facts: readonly EvidenceRecord[]
  health: CaptureHealth
  issues: Set<string>
  fatal: boolean
  pending: Set<string>
  catchingUp: boolean
  factSources: Map<string, ProvenanceSource>
  reconciled: string | null
  links: Map<string, LinkObservation>
  historical: Map<string, LinkObservation>
  observed: Set<string>
}
const reasons = new Set<ProvenanceReason>([
  'not-observed', 'capture-off', 'capture-stopped', 'catching-up', 'no-seat-evidence',
  'ambiguous-patch', 'empty-change', 'changed-patch', 'missing-object', 'history-gap',
  'limit-exceeded', 'unsupported-merge', 'restored-history',
])
const explanation = (reason: ProvenanceReason | null): string => {
  switch (reason) {
    case null: return 'Associated with the Seat whose observed patch matches this commit.'
    case 'catching-up': return 'Capture is still reading this commit.'
    case 'capture-off': return 'Capture is off on this machine.'
    case 'capture-stopped': return 'Capture needs attention before this commit can be read.'
    case 'ambiguous-patch': return 'More than one source could explain this patch.'
    case 'changed-patch': return 'Only the unchanged file contributions could be associated.'
    case 'missing-object': return 'Git no longer exposes an object needed for this association.'
    case 'history-gap': return 'The observed history does not establish this association.'
    case 'limit-exceeded': return 'This commit exceeded a background capture limit.'
    case 'unsupported-merge': return 'No observed fact establishes ownership of this merge.'
    case 'restored-history': return 'This association came from a backup and is historical.'
    case 'empty-change': return 'This commit has no changed patch to associate.'
    case 'no-seat-evidence': return 'No matching local Seat evidence was observed.'
    case 'not-observed': return 'This commit has not been observed on this machine.'
  }
}

export class ProvenancePlane {
  readonly #port: ProvenancePort
  #preferences: ProvenancePreferences
  #projects = new Map<string, Project>()
  #aliases = new Map<string, string>()
  #journals = new Map<string, ProvenanceJournal>()
  #roots: readonly string[] = []
  #revision = 0
  #generation = 0
  #closed = false
  #started = false
  #tail: Promise<void> = Promise.resolve()

  constructor(port: ProvenancePort) {
    this.#port = port
    this.#preferences = new ProvenancePreferences(join(port.stateDir, 'provenance-preferences.json'))
  }

  async start(): Promise<void> {
    await this.#preferences.load()
    if (this.#closed) return
    this.#started = true
    this.setProjects(this.#port.projects())
  }

  #queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work)
    this.#tail = next.then(() => {}, () => {})
    return next
  }

  setProjects(roots: readonly string[]): void {
    if (this.#closed) return
    const next = [...new Set(roots)].sort()
    if (JSON.stringify(next) === JSON.stringify(this.#roots) && this.#projects.size) return
    this.#roots = next
    const generation = ++this.#generation
    if (!this.#started) return
    void this.#queue(async () => {
      if (generation !== this.#generation || this.#closed) return
      for (const state of this.#projects.values()) await this.#stop(state)
      this.#projects.clear()
      this.#aliases.clear()
      for (const root of next) {
        if (generation !== this.#generation || this.#closed) return
        let handle: RepoHandle | null = null
        try {
          handle = await admitProject(root, this.#port.stateDir, next)
          if (generation !== this.#generation || this.#closed) {
            await gitReader(handle).close()
            return
          }
          this.#aliases.set(root, handle.project)
          if (this.#projects.has(handle.project)) {
            await gitReader(handle).close()
            continue
          }
          const state = this.#state(handle.project, handle)
          this.#projects.set(handle.project, state)
          await this.#open(state)
        } catch (error) {
          if (handle) await gitReader(handle).close().catch(() => {})
          const state = this.#state(root, null)
          this.#projects.set(root, state)
          this.#aliases.set(root, root)
          this.#problem(state, 'stopped', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'folder-unavailable' : 'external-metadata')
        }
      }
    }).catch(() => this.#port.log('provenance registration failed'))
  }

  #journal(project: string): ProvenanceJournal {
    let journal = this.#journals.get(project)
    if (!journal) {
      journal = new ProvenanceJournal(join(this.#port.evidence.store.folderOf(project), 'provenance.ndjson'))
      this.#journals.set(project, journal)
    }
    return journal
  }

  async #prepare(project: string): Promise<void> {
    const folder = this.#port.evidence.store.folderOf(project)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'project.json'), JSON.stringify({ root: project }), { flag: 'wx', mode: 0o600 })
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  }

  #state(project: string, handle: RepoHandle | null): Project {
    const preference = this.#preferences.get(project)
    return {
      project, handle, observer: null, journal: this.#journal(project), entries: [], seats: [], facts: [],
      catchingUp: true, factSources: new Map(), reconciled: null,
      links: new Map(), historical: new Map(), observed: new Set(),
      issues: new Set(preference.problem ? [preference.problem] : []), fatal: !!preference.problem, pending: new Set(),
      health: captureHealth({
        project, enabled: preference.enabled, fatal: !!preference.problem, issues: preference.problem ? [preference.problem] : [],
        checkedAt: null, lastCapturedAt: null, pending: 1, gaps: 0, revision: ++this.#revision,
      }),
    }
  }

  async #load(state: Project): Promise<void> {
    const read = await state.journal.read()
    if (read.broken) throw new Error('provenance-journal-damaged')
    for (const entry of read.entries.slice(state.entries.length)) {
      if (entry.kind === 'link' && object(entry.value)) {
        if ('restoredAt' in entry.value) {
          const link = entry.value.data as LinkObservation
          state.historical.set(link.sha, link)
        } else {
          const link = entry.value as unknown as LinkObservation
          state.links.set(link.sha, link)
        }
      }
      if (entry.kind === 'commit' && object(entry.value) && !('restoredAt' in entry.value)) {
        const commit = entry.value as unknown as CommitObservation
        state.observed.add(commit.sha)
        state.pending.delete(commit.sha)
        if (commit.why) state.issues.add(commit.why === 'limit-exceeded' ? 'limit-exceeded' : 'history-gap')
      }
    }
    state.entries = read.entries
    state.seats = foldSeats((await this.#port.evidence.store.read(state.project, 'seats')).lines)
    state.facts = (await this.#port.evidence.store.read(state.project, 'evidence')).lines.flatMap((line) =>
      line.type === 'evidence' ? [line.record] : [],
    )
  }

  #publish(state: Project): void {
    if (this.#closed || this.#projects.get(state.project) !== state) return
    const preference = this.#preferences.get(state.project)
    const checkpoint = readCheckpoint(state.entries) as WorkerCheckpoint | null
    const pending = state.pending.size + (checkpoint?.frontier.length ?? 0) + (checkpoint?.rangePending.length ?? 0)
    state.health = captureHealth({
      project: state.project, enabled: preference.enabled, fatal: state.fatal,
      issues: [...state.issues], checkedAt: checkpoint?.scanStartedAt ?? null,
      lastCapturedAt: checkpoint?.capturedThrough || null, pending: pending + (state.catchingUp && preference.enabled ? 1 : 0),
      gaps: state.entries.filter((entry) => entry.kind === 'gap').length,
      revision: ++this.#revision,
    })
    this.#port.push({ method: 'provenance/changed', params: {
      project: state.project, revision: state.health.revision, health: state.health,
    } })
  }

  #problem(state: Project, kind: 'degraded' | 'stopped', reason: string): void {
    state.issues.add(reason)
    state.fatal ||= kind === 'stopped'
    this.#publish(state)
  }

  async #open(state: Project): Promise<void> {
    await this.#prepare(state.project)
    try {
      await this.#load(state)
      const preference = this.#preferences.get(state.project)
      if (!preference.enabled || preference.problem || !state.handle || this.#closed) {
        if (state.handle) await gitReader(state.handle).close()
        state.handle = null
        this.#publish(state)
        return
      }
      state.catchingUp = true
      const git = gitReader(state.handle)
      const observer = new RefObserver({
        git, journal: state.journal,
        changed: () => {
          void this.#load(state).then(() => { state.catchingUp = false; this.#publish(state) })
            .catch(() => this.#problem(state, 'stopped', 'storage-failed'))
        },
        problem: (kind, reason) => this.#problem(state, kind, reason),
        reconcile: (entries, checkpoint, signal) => this.#reconcile(state, entries, checkpoint, git, signal),
      })
      state.observer = observer
      await observer.start(state.handle, readCheckpoint(state.entries) as WorkerCheckpoint | null)
      if (this.#closed) await this.#stop(state)
    } catch {
      if (state.handle && !state.observer) await gitReader(state.handle).close()
      this.#problem(state, 'stopped', 'storage-failed')
    }
  }

  async #reconcile(
    state: Project, entries: readonly JournalEntry[], checkpoint: WorkerCheckpoint, git: GitReader, signal: AbortSignal,
  ): Promise<Pick<WorkerCheckpoint, 'rangeKeys' | 'rangePending'>> {
    await this.#load(state)
    const signature = digest([
      entries.filter((entry) => entry.kind === 'commit' || entry.kind === 'ref').map((entry) => entry.seq),
      state.facts.map((fact) => fact.id), state.seats,
    ])
    if (signature === state.reconciled && !checkpoint.rangePending.length) {
      return { rangeKeys: checkpoint.rangeKeys, rangePending: [] }
    }
    const commits = localValues<CommitObservation>(entries, 'commit')
    const storedRanges = localValues<RangeObservation>(entries, 'range')
    const ranges = storedRanges.filter((range) => !range.id.startsWith('fact-'))
    let links = localValues<LinkObservation>(entries, 'link')
    const sources: ProvenanceSource[] = []
    for (const record of state.facts) {
      signal.throwIfAborted()
      if (record.restored || record.fact.kind !== 'diff' || !record.checkout ||
        !state.handle?.checkouts.has(record.checkout.cwd)) continue
      const fact = record.fact
      try {
        let source = state.factSources.get(record.id)
        if (!source) {
          const factId = `fact-${digest([record.id, record.fact.from, record.fact.to])}`
          const saved = storedRanges.find((range) => range.id === factId)
          const observed = commits.find((commit) => commit.sha === fact.to && commit.parents[0] === fact.from)
          const patch = saved?.patch ?? observed?.patch ?? await git.patch(record.fact.from, record.fact.to, signal)
          source = factSource(state.project, record.checkout.cwd, record.fact.from, record.fact.to,
            patch, state.seats, [record]) ?? undefined
          if (source) {
            // An exact fact range is not a first-parent decomposition. Keep its
            // fingerprint for replay, but never offer it as a squash candidate.
            if (!saved) await state.journal.append('range', {
              id: factId, from: record.fact.from, to: record.fact.to,
              commits: [record.fact.to], patch, seats: source.seats, ambiguous: true, at: record.observedAt,
            } satisfies RangeObservation)
            state.factSources.set(record.id, source)
          }
        }
        if (source) sources.push(source)
      } catch {
        signal.throwIfAborted()
        this.#problem(state, 'degraded', 'history-gap')
      }
    }
    const reconcile = async () => {
      const decisions = await reconcileProject({
        commits, sources: [...sources, ...ranges.map((range) => rangeSource(range, links))],
        moves: localValues(entries, 'ref'), priorLinks: links, now: Date.now(),
      }, git, signal)
      for (const link of decisions) await state.journal.append('link', link)
      links = [...links, ...decisions]
    }
    await reconcile()
    const keys = new Set(checkpoint.rangeKeys)
    const candidates = rangeCandidates(commits, keys)
    const failed: string[] = []
    for (const candidate of candidates.ready) {
      signal.throwIfAborted()
      try {
        const range = await captureRange(candidate.from, candidate.commits, links, git, signal, Date.now())
        await state.journal.append('range', range)
        ranges.push(range)
        keys.add(candidate.key)
      } catch (error) {
        signal.throwIfAborted()
        if ((error as Error).message.startsWith('provenance-')) throw error
        failed.push(`limit:${candidate.key}`)
        this.#problem(state, 'degraded', 'history-gap')
      }
    }
    await reconcile()
    state.reconciled = signature
    return { rangeKeys: [...keys], rangePending: [...candidates.pending, ...failed] }
  }

  evidenceChanged(project: string): void {
    this.#projects.get(this.#aliases.get(project) ?? project)?.observer?.wake()
  }

  #registered(root: string): Project {
    const state = this.#projects.get(this.#aliases.get(root) ?? root)
    if (!state) throw new Error('This project is not registered for capture.')
    return state
  }

  async read(root: string, shas: readonly string[]): Promise<ProjectProvenance> {
    if (!Array.isArray(shas) || shas.length > 1000) throw new Error('Expected at most 1000 full object ids.')
    for (const sha of shas) oid(sha)
    const state = this.#registered(root)
    const latest = state.links
    const known = state.observed
    const historical = state.historical
    const requested = [...new Set(shas)]
    const enqueue = requested.filter((sha) => !known.has(sha) && !historical.has(sha) &&
      !state.pending.has(sha) && !!state.observer && state.health.enabled && !state.fatal)
    for (const sha of enqueue) state.pending.add(sha)
    if (enqueue.length) {
      state.observer!.request(enqueue)
      this.#publish(state)
    }
    const commits: CommitProvenance[] = requested.map((sha) => {
      const link = latest.get(sha) ?? historical.get(sha)
      const imported = !latest.has(sha) && historical.has(sha)
      const pending = state.pending.has(sha) && state.health.enabled && !state.fatal
      const joined = link ? relatedEvidence(link, state.seats, state.facts) : null
      const reason: ProvenanceReason | null = imported ? 'restored-history'
        : link ? link.reason && reasons.has(link.reason as ProvenanceReason) ? link.reason as ProvenanceReason :
          link.coverage === 'none' ? 'no-seat-evidence' : null
        : !state.health.enabled ? 'capture-off' : state.fatal ? 'capture-stopped'
        : pending ? 'catching-up' : 'not-observed'
      return {
        sha, state: pending && !link ? 'pending' : link?.seats.length && joined?.seats.length ? 'attributed' : 'unattributed',
        coverage: link?.coverage ?? 'none', seats: joined?.seats ?? [], via: link?.via ?? null,
        reason, explanation: explanation(reason), evidenceIds: joined?.evidenceIds ?? [], cards: joined?.cards ?? [],
        observedAt: link?.at ?? null,
      }
    })
    return { project: state.project, revision: state.health.revision, health: state.health, commits }
  }

  async status(root?: string): Promise<readonly CaptureHealth[]> {
    if (root !== undefined) return [this.#registered(root).health]
    return [...this.#projects.values()].map((state) => state.health)
  }

  setCapture(root: string, enabled: boolean): Promise<CaptureHealth> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Expected a capture preference.'))
    return this.#queue(async () => {
      const state = this.#registered(root)
      // Stop first: no scan may acknowledge a cursor after the disabled preference is published.
      await this.#stop(state)
      try {
        await this.#preferences.set(state.project, enabled)
      } catch (error) {
        this.#problem(state, 'stopped', 'storage-failed')
        throw error
      }
      state.pending.clear()
      state.catchingUp = enabled
      await state.journal.append('gap', {
        id: digest(['toggle', enabled, Date.now(), ++this.#revision]), reason: 'capture-toggle',
        from: state.health.checkedAt, to: Date.now(),
      })
      await this.#load(state)
      if (enabled && !this.#closed && this.#roots.includes(root)) {
        state.handle = await admitProject(root, this.#port.stateDir, this.#roots)
        state.fatal = false
        state.issues.clear()
        await this.#open(state)
      }
      this.#publish(state)
      return state.health
    })
  }

  retry(root: string): Promise<CaptureHealth> {
    return this.#queue(async () => {
      const state = this.#registered(root)
      await this.#stop(state)
      this.#preferences = new ProvenancePreferences(join(this.#port.stateDir, 'provenance-preferences.json'))
      await this.#preferences.load()
      this.#journals.delete(state.project)
      state.journal = this.#journal(state.project)
      state.entries = []
      state.links.clear()
      state.historical.clear()
      state.observed.clear()
      state.factSources.clear()
      state.reconciled = null
      state.fatal = false
      state.issues.clear()
      const preference = this.#preferences.get(state.project)
      if (preference.problem) this.#problem(state, 'stopped', preference.problem)
      if (preference.enabled && !this.#closed) {
        state.handle = await admitProject(root, this.#port.stateDir, this.#roots)
      }
      await this.#open(state)
      this.#publish(state)
      return state.health
    })
  }

  async seat(root: string, id: string): Promise<ProvenanceSeatDetail> {
    const state = this.#registered(root)
    if (!id || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) throw new Error('Expected a Seat id.')
    const seat = this.#port.evidence.seats.byId(id)
    if (!seat || seat.checkout.project !== state.project) {
      return { seat: null, session: null, unavailable: 'This Seat record is unavailable in this project.' }
    }
    if (seat.restored) return { seat, session: null, unavailable: 'This Seat record came from another backup.' }
    if (seat.closed?.why === 'deleted') return { seat, session: null, unavailable: 'Its conversation was deleted.' }
    return { seat, session: seat.session, unavailable: null }
  }

  backup() {
    return this.#queue(() => exportProvenance({
      projects: async () => [...new Set([...await this.#port.evidence.store.projects(), ...this.#journals.keys()])],
      journal: (project) => this.#journal(project),
    }))
  }

  restore(raw: unknown) {
    return this.#queue(async () => {
      const report = await importProvenance({
        projects: () => this.#port.evidence.store.projects(), journal: (project) => this.#journal(project),
        prepare: (project) => this.#prepare(project),
      }, raw)
      for (const state of this.#projects.values()) {
        await this.#load(state)
        this.#publish(state)
      }
      return report
    })
  }

  async #stop(state: Project): Promise<void> {
    const observer = state.observer
    state.observer = null
    if (observer) await observer.close().catch(() => this.#problem(state, 'stopped', 'storage-failed'))
    state.handle = null
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#generation += 1
    for (const state of this.#projects.values()) void state.observer?.close().catch(() => {})
    await this.#tail
    for (const state of this.#projects.values()) await this.#stop(state)
    for (const journal of this.#journals.values()) {
      await journal.flush().catch(() => this.#port.log('provenance observations could not be saved'))
    }
  }
}
