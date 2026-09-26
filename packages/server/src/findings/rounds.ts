import { ciVerdict, DEFAULT_QUESTION_WAIT, questionWaitMs, type EvidenceRecord, type EvidenceView, type FindingId, type FindingSeries, type FindingView } from '@harnessdesk/protocol'

/**
 * Review rounds, bounded: the pure half of what happens when a flow round
 * closes. How many rounds may close, what counts as progress, when a repair
 * loop has become a design problem, and which findings a review series
 * admits as blocking. Nothing here opens a Seat, writes a file or merges;
 * `FindingsPlane.roundClosed` gathers what these read and records what they
 * decide.
 */

// ------------------------------------------------------------ the decision

export interface LoopSample {
  readonly closed: number
  readonly limit: number
  readonly idle: number
  readonly idleLimit: number
  readonly newProgress: boolean
  readonly unresolvedRepairs: readonly number[]
  readonly unresolved: number
  readonly reviewComplete: boolean
  readonly freshGuards: boolean
  readonly pendingException: boolean
}

export interface LoopDecision {
  readonly idle: number
  readonly next: 'continue' | 'person' | 'merge-card'
  readonly reason: string | null
}

/**
 * The bounded decision, in its one order: a repair loop that is a design
 * problem, then a regression or security claim waiting for a person, then
 * the round ceiling, then rounds without new evidence — each a stop at the
 * person, and the ceiling wins even when every guard is green. `continue`
 * hands back to the flow's own routing, which may still wait on evidence.
 */
export function decideLoop(sample: LoopSample): LoopDecision {
  const idle = sample.newProgress ? 0 : sample.idle + 1
  let reason: string | null = null
  if (sample.unresolvedRepairs.some(count => count >= 2)) {
    reason = 'This is a design problem, not a patch problem.'
  } else if (sample.pendingException) {
    reason = 'Review the new regression or security finding before continuing.'
  } else if (sample.closed >= sample.limit) {
    reason = `Round ${sample.closed} ended with ${sample.unresolved} open findings.`
  } else if (idle >= sample.idleLimit) {
    reason = `${idle} rounds ended without new evidence.`
  }
  if (reason !== null) return { idle, next: 'person', reason }
  if (sample.unresolved === 0 && sample.reviewComplete && sample.freshGuards) {
    return { idle, next: 'merge-card', reason: null }
  }
  return { idle, next: 'continue', reason: null }
}

// ---------------------------------------------------------------- progress

export interface ProgressInput {
  /** The run's facts: filed on its cards, observed on this desk. */
  readonly facts: readonly EvidenceView[]
  /** A review's Seat as a stable slot — its role, its place in the round and its Agent — never the Seat id itself. */
  readonly slotOf: (seat: string) => string | null
  /** Findings confirmed resolved on this desk. */
  readonly confirmed: readonly FindingId[]
}

/**
 * The questions the desk has an answer to, as canonical tuples: a confirmed
 * finding; an observed diff interval; a check's command, revision and
 * result; CI's revision and every check's outcome; a review slot's revision
 * and verdict. A new record id, a new time, a posting or a carry is none of
 * these, so it is never progress; a stale or restored fact is left out.
 */
export function progressKeys(input: ProgressInput): string[] {
  const keys = new Set<string>()
  for (const view of input.facts) {
    const { record } = view
    if (record.restored || view.freshness.state !== 'fresh') continue
    const fact = record.fact
    switch (fact.kind) {
      case 'check':
        if (fact.counted === false || fact.dirty) break
        keys.add(`check|${fact.run}|${fact.at}|${fact.exit === 0 && !fact.timedOut ? 'pass' : 'fail'}`)
        break
      case 'ci':
        keys.add(`ci|${fact.at}|${ciVerdict(fact.checks)}|${fact.checks.map((one) => `${one.name}=${one.state}`).sort().join(',')}`)
        break
      case 'diff':
        keys.add(`diff|${fact.from}|${fact.to}`)
        break
      case 'review': {
        const slot = input.slotOf(fact.by)
        if (slot !== null) keys.add(`review|${slot}|${fact.at}|${fact.verdict}`)
        break
      }
      default:
        break
    }
  }
  for (const id of input.confirmed) keys.add(`finding|${id}`)
  return [...keys].sort()
}

/**
 * The run's progress after one more closed round. The first closed round is
 * the baseline: it is progress, even an empty clean review, so a baseline
 * never spends the allowance for rounds without it.
 */
export function advanceProgress(seen: readonly string[], keys: readonly string[], first: boolean): { readonly newProgress: boolean; readonly progress: string[] } {
  const known = new Set(seen)
  const fresh = keys.filter((key) => !known.has(key))
  return { newProgress: first || fresh.length > 0, progress: [...seen, ...fresh] }
}

// --------------------------------------------------------------- repairs

/**
 * How many distinct revisions a repair of this finding was claimed at and
 * then rejected by an open verdict. A repair claimed twice at one revision is
 * one attempt; a claim not yet reviewed is not yet a rejection.
 */
export function rejectedRepairs(records: readonly EvidenceRecord[], finding: FindingId): number {
  const rejected = new Set<string>()
  let pending = new Set<string>()
  for (const record of records) {
    if (record.fact.kind !== 'finding' || record.fact.id !== finding || !record.finding) continue
    const event = record.finding.event
    if (event.kind === 'repair') pending.add(record.fact.at)
    else if (event.kind === 'verdict') {
      if (event.state === 'open') for (const at of pending) rejected.add(at)
      pending = new Set()
    }
  }
  return rejected.size
}

// ----------------------------------------------------------------- series

/**
 * One review round of a series, closed. The first review freezes the
 * series's blocking set — the blocking findings it raised and any unresolved
 * blocking finding carried into the Goal — and nothing later adds to it: a
 * later ordinary claim is advisory, and a later regression or security claim
 * waits for a person as a pending exception. Neither changes `initial`.
 */
export function closeSeries(
  series: FindingSeries,
  closed: {
    readonly round: number
    readonly at: string | null
    readonly raised: readonly FindingView[]
    readonly carried: readonly FindingView[]
  },
): FindingSeries {
  if (series.reviewRounds.includes(closed.round)) return series
  const first = series.reviewRounds.length === 0
  const blocking = closed.raised.filter((one) => one.blocking && one.problem === null)
  const known = new Set([...series.initial, ...series.exceptions, ...series.pending])
  const initial = first
    ? [...new Set([...closed.carried.filter((one) => one.blocking && !one.lifecycle.confirmed).map((one) => one.id), ...blocking.map((one) => one.id)])]
    : series.initial
  const pending = first
    ? series.pending
    : [...series.pending, ...blocking.filter((one) => one.category !== 'ordinary' && !known.has(one.id)).map((one) => one.id)]
  return {
    ...series,
    reviewedAt: closed.at ?? series.reviewedAt,
    reviewRounds: [...series.reviewRounds, closed.round],
    initial,
    pending,
  }
}

/** The findings a series admits as blocking: its frozen baseline and the exceptions a person admitted. */
export const admittedOf = (series: readonly FindingSeries[]): ReadonlySet<FindingId> =>
  new Set(series.flatMap((one) => [...one.initial, ...one.exceptions]))

/** The findings currently waiting on a person to admit or decline them as exceptions. */
export const pendingOf = (series: readonly FindingSeries[]): ReadonlySet<FindingId> =>
  new Set(series.flatMap((one) => one.pending))

// -------------------------------------------------------------- questions

/** What a run records when an unattended Seat asks a question nobody is there to answer. */
export const QUESTION_STOP = 'asked a question nobody can answer'

/** How long an unattended question waits by default before its run stops: this machine's `QuestionWait`, unless a person chose another. */
export const QUESTION_MS = questionWaitMs(DEFAULT_QUESTION_WAIT)!

export interface QuestionPort {
  /** A fixed wait, for tests; `waitMs` is read instead when it is given. */
  readonly ms?: number
  /** This machine's wait, read as each question is asked; null waits until a person answers. */
  readonly waitMs?: () => number | null
  setTimer(fire: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  /** Interrupts the asking conversation's turn once. What it already said is kept. */
  interrupt(key: string): Promise<void>
  /** Stops the run for a person, with the reason. */
  stop(key: string, reason: string): Promise<void>
}

/**
 * The deadline on an unattended Seat's question. One timer per
 * conversation, however often the question is seen; an answer in time
 * clears it; expiry stops the run with a named reason and then interrupts
 * the turn once. It never answers the question: a forged answer is worse
 * than a stop. A wait of null sets no timer at all: the question waits.
 */
export class QuestionDeadline {
  readonly #port: QuestionPort
  readonly #waiting = new Map<string, { readonly question: string; readonly timer: unknown }>()
  /** Questions whose wait ran out and that nobody has answered since. Forgotten once answered; empty after a restart. */
  readonly #expired = new Set<string>()
  /** Questions whose run is being stopped now, between the stop and the interrupt. */
  readonly #stopping = new Set<string>()
  /** Of those, the ones answered in that window: their turn is not interrupted. */
  readonly #answeredWhileStopping = new Set<string>()

  constructor(port: QuestionPort) {
    this.#port = port
  }

  asked(key: string, question: string): void {
    if (this.#waiting.has(key) || this.#expired.has(`${key}\u0000${question}`)) return
    const ms = this.#port.waitMs ? this.#port.waitMs() : (this.#port.ms ?? QUESTION_MS)
    if (ms === null) return
    const timer = this.#port.setTimer(() => void this.#expire(key, question), ms)
    this.#waiting.set(key, { question, timer })
  }

  answered(key: string, question: string): void {
    const at = `${key}\u0000${question}`
    this.#expired.delete(at)
    if (this.#stopping.has(at)) this.#answeredWhileStopping.add(at)
    const waiting = this.#waiting.get(key)
    if (!waiting || waiting.question !== question) return
    this.#port.clearTimer(waiting.timer)
    this.#waiting.delete(key)
  }

  /**
   * Whether this question outlived its wait and is still unanswered: its run
   * stopped on it, so an answer to it now has no turn to go into.
   */
  expired(key: string, question: string): boolean {
    return this.#expired.has(`${key}\u0000${question}`)
  }

  /** Clears every timer: the desk is closing. */
  close(): void {
    for (const waiting of this.#waiting.values()) this.#port.clearTimer(waiting.timer)
    this.#waiting.clear()
  }

  async #expire(key: string, question: string): Promise<void> {
    const waiting = this.#waiting.get(key)
    if (!waiting || waiting.question !== question) return
    const at = `${key}\u0000${question}`
    this.#waiting.delete(key)
    this.#expired.add(at)
    /* The run stops first, durably, and only then is the turn interrupted:
       the end of that turn is what re-arms a running run's Seat, and a turn
       that ended before its run had stopped was handed its card straight
       back — a Seat at work again on a run that says it is waiting for you.
       An answer that lands between the two went into the live turn, which
       is then left to carry on rather than being cut off. */
    this.#stopping.add(at)
    await this.#port.stop(key, QUESTION_STOP).catch(() => undefined)
    this.#stopping.delete(at)
    if (this.#answeredWhileStopping.delete(at)) return
    await this.#port.interrupt(key).catch(() => undefined)
  }
}
