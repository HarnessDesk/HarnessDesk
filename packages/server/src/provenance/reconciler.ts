import { setImmediate as yielded } from 'node:timers/promises'

import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'

import { checkoutRoot, type GitReader, type RepoHandle } from './git.js'
import { digest, type JournalEntry, type ProvenanceJournal } from './journal.js'
import { localValues, type WorkerCheckpoint } from './observer.js'
import {
  backlog, captureRange, factSource, LIMIT_PREFIX, rangeCandidates, rangeSource, reconcileProject,
  type CommitObservation, type LinkObservation, type ProvenanceSource, type RangeCandidate, type RangeObservation,
} from './reconcile.js'

/** Ranges read under one check of the repository's metadata, with a turn for everything else after each. */
const RANGE_BATCH = 8

/**
 * Ranges one pass reads before it leaves the rest to the next. A history of N
 * commits offers about 63 ranges to each, so a pass that read them all would
 * start work with no end in sight; this one is bounded, and says so in what it
 * returns, so the observer comes back for more.
 */
const RANGE_BUDGET = 128

/** What one pass reads about a project besides its journal. */
export interface Subject {
  readonly project: string
  readonly handle: RepoHandle | null
  readonly journal: ProvenanceJournal
  readonly facts: readonly EvidenceRecord[]
  readonly seats: readonly SeatRecord[]
}

export type Ranges = Pick<WorkerCheckpoint, 'rangeKeys' | 'rangePending'>

/** The journal itself is failing, which no range is to blame for. */
const journalFailure = (error: unknown): boolean => (error as Error).message.startsWith('provenance-')

/**
 * One project's reconcile pass: turn what the journal observed, with the facts
 * and Seats the evidence plane holds, into links, and read the ranges a later
 * squash will be compared with.
 *
 * What a pass reads is the commits and ref moves the journal holds, the facts
 * and the Seats. It remembers the signature of what it last reconciled, so a
 * pass over the same things does nothing; a range it could not read waits
 * until one of them changes, and never makes a pass run again by itself.
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

  /** The object ids the facts name that Git no longer has as commits: one process for all of them. */
  async #gone(
    handle: RepoHandle, facts: readonly EvidenceRecord[], reader: GitReader, signal: AbortSignal,
  ): Promise<ReadonlySet<string>> {
    const width = handle.objectFormat === 'sha1' ? 40 : 64
    const named = new Set<string>()
    for (const record of facts) {
      if (record.restored || record.fact.kind !== 'diff' || !record.checkout || this.#factSources.has(record.id)) continue
      for (const sha of [record.fact.from, record.fact.to]) {
        if (sha.length === width && /^[a-f0-9]+$/.test(sha)) named.add(sha)
      }
    }
    const gone = new Set<string>()
    if (!named.size) return gone
    try {
      for (const [sha, type] of await reader.kinds([...named], signal)) if (type !== 'commit') gone.add(sha)
    } catch {
      // Whatever Git could not be asked is that fact's own failure, where it is read.
      signal.throwIfAborted()
    }
    return gone
  }

  async run(
    subject: Subject, entries: readonly JournalEntry[], checkpoint: Ranges, git: GitReader, signal: AbortSignal,
  ): Promise<Ranges> {
    const signature = digest([
      entries.filter((entry) => entry.kind === 'commit' || entry.kind === 'ref').map((entry) => entry.seq),
      subject.facts.map((fact) => fact.id), subject.seats,
    ])
    if (signature === this.#reconciled && !backlog(checkpoint.rangePending)) {
      return { rangeKeys: checkpoint.rangeKeys, rangePending: checkpoint.rangePending }
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
    // A history gap is one fact about the project, however many facts and ranges it spoils.
    let gap = false
    await git.batch(signal, async (reader) => {
      const gone = subject.handle ? await this.#gone(subject.handle, subject.facts, reader, signal) : new Set<string>()
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
            if (!saved && !observed && (gone.has(fact.from) || gone.has(fact.to))) throw new Error('missing-object')
            const patch = saved?.patch ?? observed?.patch ?? await reader.patch(record.fact.from, record.fact.to, signal)
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
          gap = true
        }
      }
    })
    /** How many links the pass added: what it decided, and so whether another look could decide more. */
    const reconcile = async (): Promise<number> => {
      const decisions = await reconcileProject({
        commits, sources: [...sources, ...ranges.map((range) => rangeSource(range, links))],
        moves: localValues(entries, 'ref'), priorLinks: links, now: Date.now(),
      }, git, signal)
      for (const link of decisions) await subject.journal.append('link', link)
      links = [...links, ...decisions]
      return decisions.length
    }
    const decided = await reconcile()
    const keys = new Set(checkpoint.rangeKeys)
    const failedBefore = new Set(checkpoint.rangePending.filter((key) => key.startsWith(LIMIT_PREFIX))
      .map((key) => key.slice(LIMIT_PREFIX.length)))
    const candidates = rangeCandidates(commits, keys, failedBefore)
    // Ranges never tried come first: ones that could not be read wait behind them.
    const turn = [...candidates.ready, ...candidates.retry].slice(0, RANGE_BUDGET)
    const failed = new Set<string>()
    const lost = new Set<string>()
    let read = 0
    for (let at = 0; at < turn.length; at += RANGE_BATCH) {
      signal.throwIfAborted()
      const batch = turn.slice(at, at + RANGE_BATCH)
      const captured = await git.batch(signal, async (reader) => {
        // One process says which parts of the whole batch Git no longer has, so
        // a range across a lost commit is refused without a process of its own.
        const unknown = new Set(batch.flatMap((candidate) => candidate.commits.map((part) => part.sha))
          .filter((sha) => !lost.has(sha)))
        try {
          for (const [sha, type] of await reader.kinds([...unknown], signal)) if (type !== 'commit') lost.add(sha)
        } catch {
          // A range Git cannot be asked about fails below, by itself.
          signal.throwIfAborted()
        }
        const found: { candidate: RangeCandidate; range: RangeObservation }[] = []
        for (const candidate of batch) {
          signal.throwIfAborted()
          try {
            if (candidate.commits.some((part) => lost.has(part.sha))) throw new Error('missing-object')
            found.push({ candidate, range: await captureRange(candidate.from, candidate.commits, links, reader, signal, Date.now()) })
          } catch {
            signal.throwIfAborted()
            failed.add(candidate.key)
            gap = true
          }
        }
        return found
      })
      for (const { candidate, range } of captured) {
        try {
          await subject.journal.append('range', range)
          ranges.push(range)
          keys.add(candidate.key)
          read += 1
        } catch (error) {
          signal.throwIfAborted()
          if (journalFailure(error)) throw error
          failed.add(candidate.key)
          gap = true
        }
      }
      await yielded()
    }
    // What nothing has changed since the first look cannot change a second.
    if (decided > 0 || read > 0) await reconcile()
    if (gap) this.#problem('degraded', 'history-gap')
    this.#reconciled = signature
    const tried = new Set(turn.map((candidate) => candidate.key))
    const stillFailed = candidates.retry.filter((candidate) => !tried.has(candidate.key)).map((candidate) => candidate.key)
    return {
      rangeKeys: [...keys],
      rangePending: [...new Set([
        ...candidates.pending,
        ...candidates.ready.slice(RANGE_BUDGET).map((candidate) => candidate.key),
        ...[...failed, ...stillFailed].map((key) => `${LIMIT_PREFIX}${key}`),
      ])],
    }
  }
}
