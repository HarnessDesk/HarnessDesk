import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'

import { checkoutRoot, type GitReader, type RepoHandle } from './git.js'
import { digest, type JournalEntry, type ProvenanceJournal } from './journal.js'
import { localValues, type WorkerCheckpoint } from './observer.js'
import {
  captureRange, factSource, rangeCandidates, rangeSource, reconcileProject,
  type CommitObservation, type LinkObservation, type ProvenanceSource, type RangeObservation,
} from './reconcile.js'

/** What one pass reads about a project besides its journal. */
export interface Subject {
  readonly project: string
  readonly handle: RepoHandle | null
  readonly journal: ProvenanceJournal
  readonly facts: readonly EvidenceRecord[]
  readonly seats: readonly SeatRecord[]
}

export type Ranges = Pick<WorkerCheckpoint, 'rangeKeys' | 'rangePending'>

/**
 * One project's reconcile pass: turn what the journal observed, with the facts
 * and Seats the evidence plane holds, into links, and read the ranges a later
 * squash will be compared with.
 */
export class Reconciler {
  readonly #problem: (kind: 'degraded' | 'stopped', reason: string) => void
  #factSources = new Map<string, ProvenanceSource>()
  #reconciled: string | null = null

  constructor(problem: (kind: 'degraded' | 'stopped', reason: string) => void) {
    this.#problem = problem
  }

  /** Forget what this pass has already read, so the next one starts again. */
  reset(): void {
    this.#factSources.clear()
    this.#reconciled = null
  }

  async run(
    subject: Subject, entries: readonly JournalEntry[], checkpoint: Ranges, git: GitReader, signal: AbortSignal,
  ): Promise<Ranges> {
    const signature = digest([
      entries.filter((entry) => entry.kind === 'commit' || entry.kind === 'ref').map((entry) => entry.seq),
      subject.facts.map((fact) => fact.id), subject.seats,
    ])
    if (signature === this.#reconciled && !checkpoint.rangePending.length) {
      return { rangeKeys: checkpoint.rangeKeys, rangePending: [] }
    }
    const commits = localValues<CommitObservation>(entries, 'commit')
    const storedRanges = localValues<RangeObservation>(entries, 'range')
    const ranges = storedRanges.filter((range) => !range.id.startsWith('fact-'))
    let links = localValues<LinkObservation>(entries, 'link')
    const sources: ProvenanceSource[] = []
    const checkoutRoots = new Map<string, Promise<string | null>>()
    const canonicalRoot = (cwd: string): Promise<string | null> => {
      let root = checkoutRoots.get(cwd)
      if (!root) {
        root = checkoutRoot(subject.handle!, cwd)
        checkoutRoots.set(cwd, root)
      }
      return root
    }
    for (const record of subject.facts) {
      signal.throwIfAborted()
      if (record.restored || record.fact.kind !== 'diff' || !record.checkout || !subject.handle) continue
      const cwd = await canonicalRoot(record.checkout.cwd)
      if (!cwd) continue
      const fact = record.fact
      try {
        let source = this.#factSources.get(record.id)
        if (!source) {
          const factId = `fact-${digest([record.id, record.fact.from, record.fact.to])}`
          const saved = storedRanges.find((range) => range.id === factId)
          const observed = commits.find((commit) => commit.sha === fact.to && commit.parents[0] === fact.from)
          const patch = saved?.patch ?? observed?.patch ?? await git.patch(record.fact.from, record.fact.to, signal)
          const seats = (await Promise.all(subject.seats.map(async (seat) =>
            await canonicalRoot(seat.checkout.cwd) === cwd ? { ...seat, checkout: { ...seat.checkout, cwd } } : null,
          ))).filter((seat): seat is SeatRecord => seat !== null)
          const canonical = { ...record, checkout: { ...record.checkout, cwd } }
          source = factSource(subject.project, cwd, record.fact.from, record.fact.to,
            patch, seats, [canonical]) ?? undefined
          if (source) {
            // An exact fact range is not a first-parent decomposition. Keep its
            // fingerprint for replay, but never offer it as a squash candidate.
            if (!saved) await subject.journal.append('range', {
              id: factId, from: record.fact.from, to: record.fact.to,
              commits: [record.fact.to], patch, seats: source.seats, ambiguous: true, at: record.observedAt,
            } satisfies RangeObservation)
            this.#factSources.set(record.id, source)
          }
        }
        if (source) sources.push(source)
      } catch {
        signal.throwIfAborted()
        this.#problem('degraded', 'history-gap')
      }
    }
    const reconcile = async () => {
      const decisions = await reconcileProject({
        commits, sources: [...sources, ...ranges.map((range) => rangeSource(range, links))],
        moves: localValues(entries, 'ref'), priorLinks: links, now: Date.now(),
      }, git, signal)
      for (const link of decisions) await subject.journal.append('link', link)
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
        await subject.journal.append('range', range)
        ranges.push(range)
        keys.add(candidate.key)
      } catch (error) {
        signal.throwIfAborted()
        if ((error as Error).message.startsWith('provenance-')) throw error
        failed.push(`limit:${candidate.key}`)
        this.#problem('degraded', 'history-gap')
      }
    }
    await reconcile()
    this.#reconciled = signature
    return { rangeKeys: [...keys], rangePending: [...candidates.pending, ...failed] }
  }
}
