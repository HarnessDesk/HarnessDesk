import type { FlowExecution, SeatRecord, TriggerBudgetState, TriggerDefinition, TriggerStopReason } from '@harnessdesk/protocol'
import { DEFAULT_TRIGGER_DAILY_USD } from '@harnessdesk/protocol'

import { seatWindowOf } from '../insight/attribution.js'
import type { UsageSample } from '../ledger/insight.js'
import { usdMicros } from './definition.js'
import { attributeSample, goalSpend, meterSample, meterTurn, openMeter, type SessionMeter } from './spend.js'
import type { IntakeBudget, IntakeOperation, IntakeSnapshot } from './store.js'

/**
 * What unattended work may spend, and where it stops.
 *
 * - **One budget per Goal generation.** Made with the firing that opened the
 *   Goal and never with a later one: a force-push buys no new time, money or
 *   rounds. Its deadline is start plus the trigger's hours; its rounds and
 *   progress limits are the narrower of the trigger's and the flow's, frozen
 *   into the run (`effectiveBudget`) and counted by the findings plane.
 * - **Money is observed, not charged.** Spend is each Seat's attributed,
 *   source-qualified cost (`spend.ts`); unknown spend refuses further
 *   unattended dispatch, even with rounds and hours left, and never reads as
 *   zero. A turn in flight may spend past a limit before its meter reports
 *   and its interruption lands — the stop is on the observed figure.
 * - **A daily cap on reservations.** Opening a Goal reserves its whole USD
 *   budget against today's UTC cap, in the same save as its firing; the
 *   reservation is carried past midnight and released only when the Goal's
 *   final, completely attributed spend settles — unknown keeps it. The day is
 *   read from the journal's forward-only clock, so a clock rolled back never
 *   picks an earlier day.
 * - **Stopping keeps the work.** A reached limit is recorded first — which
 *   refuses every later dispatch — then active work is interrupted, then the
 *   run stops with the reason. Nothing is merged, wrapped, deleted or
 *   discarded, and the answer so far is kept.
 *
 * Every write goes through admission's queue (`Admission.transact`); the
 * dispatch gate only reads the journal, so a run queue asking it never waits
 * on admission.
 */

export interface BudgetCheck {
  now: number; deadline: number; closedRounds: number; roundLimit: number
  idleRounds: number; idleLimit: number; spentMicros: number | null; limitMicros: number
  lane: 'available' | 'spent' | 'unknown'; paused: boolean
}

export const PAUSED_STOP = 'Every trigger is paused. Resume triggers to continue.'

/** The fail-closed decision: the first bound that stops the next dispatch, or null. Unknown spend stops too. */
export function budgetRefusal(input: BudgetCheck): string | null {
  if (input.paused) return PAUSED_STOP
  if (input.now >= input.deadline) return 'Timed out: this Goal reached its time budget.'
  if (input.closedRounds >= input.roundLimit) return 'Out of budget: this Goal reached its round limit.'
  if (input.idleRounds >= input.idleLimit) return 'Out of budget: no new evidence in the allowed rounds.'
  if (input.lane === 'spent') return 'Out of budget: this plan has no allowance left.'
  if (input.lane === 'unknown' || input.spentMicros === null) return 'Spend is unknown. Check usage before continuing this Goal.'
  if (input.spentMicros >= input.limitMicros) return 'Out of budget: this Goal reached its spend limit.'
  return null
}

/** Which of the stop reasons a refusal is. */
export const stopReasonOf = (refusal: string): TriggerStopReason =>
  refusal.startsWith('Timed out') ? 'timed out' : refusal.startsWith('Out of budget') ? 'out of budget' : 'needs a person'

/** A UTC day, `YYYY-MM-DD`: no timezone or daylight rule ever moves it. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export const DEFAULT_DAILY_MICROS = usdMicros(DEFAULT_TRIGGER_DAILY_USD)

const dollars = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`

/** What every trigger on this machine holds against today's cap: settled spend today and every reservation still outstanding. */
export const committedToday = (snapshot: IntakeSnapshot, day: string): number =>
  (snapshot.days[day] ?? 0) + Object.values(snapshot.budgets).reduce((sum, one) => sum + (one.settled ? 0 : one.reservedMicros), 0)

/**
 * A new Goal's reservation, decided inside the firing's own save: its whole
 * USD budget, against today's cap. A cap of zero admits no paid Goal.
 */
export function reserveDaily(
  snapshot: IntakeSnapshot, operation: IntakeOperation, definition: TriggerDefinition, now: number, capMicros: number,
): { readonly snapshot: IntakeSnapshot } | { readonly refused: string } {
  const clock = Math.max(snapshot.clock, now)
  const day = utcDay(clock)
  const need = usdMicros(definition.budget.usd)
  if (capMicros <= 0) return { refused: 'Today’s trigger spend cap is $0, so no trigger opens paid work. Raise it in Settings; this is not replayed.' }
  const committed = committedToday(snapshot, day)
  if (committed + need > capMicros) {
    return {
      refused: `Opening this would reserve ${dollars(need)} with ${dollars(committed)} already committed today, past the ${dollars(capMicros)} daily cap, so it did not fire. This is not replayed.`,
    }
  }
  const budget: IntakeBudget = {
    trigger: definition.id, project: operation.project, startedAt: clock, deadline: clock + Math.round(definition.budget.hours * 3_600_000),
    usdMicros: need, rounds: definition.budget.rounds, withoutProgress: definition.budget.withoutProgress,
    reservedMicros: need, day, settled: false, meters: {}, stop: null,
  }
  return { snapshot: { ...snapshot, clock, budgets: { ...snapshot.budgets, [operation.goal]: budget } } }
}

/**
 * A Goal's final spend, replacing its reservation in the settling day's
 * bucket — only when that spend is known and complete. Unknown keeps the
 * whole reservation held, however long.
 */
export function settleDaily(snapshot: IntakeSnapshot, goal: string, finalMicros: number | null, now: number): IntakeSnapshot | null {
  const budget = snapshot.budgets[goal]
  if (!budget || budget.settled || finalMicros === null || !Number.isSafeInteger(finalMicros) || finalMicros < 0) return null
  const clock = Math.max(snapshot.clock, now)
  const day = utcDay(clock)
  return {
    ...snapshot, clock,
    days: { ...snapshot.days, [day]: (snapshot.days[day] ?? 0) + finalMicros },
    budgets: { ...snapshot.budgets, [goal]: { ...budget, reservedMicros: 0, settled: true } },
  }
}

export interface TriggerBudgetPort {
  /** Machine pause (`trigger/preferences`). */
  paused(): boolean
  /** The daily cap in micros; a person's preference, never a trigger's. */
  capMicros(): number
  /** Whether the plan the Goal's Seats spend from has allowance left, as the usage service last read it; unknown refuses. */
  lane(goal: string): 'available' | 'spent' | 'unknown'
  /** The trigger run on a Goal, for its round and progress counters. */
  run(goal: string): FlowExecution | null
  now(): number
}

/**
 * A trigger Goal's budget: the dispatch gate, the meters, the stop and the
 * settlement, over the admission journal.
 */
export class TriggerBudgets {
  readonly #read: () => IntakeSnapshot
  readonly #transact: <T>(change: (snapshot: IntakeSnapshot) => { readonly next: IntakeSnapshot | null; readonly value: T }) => Promise<T>
  readonly #port: TriggerBudgetPort

  constructor(
    read: () => IntakeSnapshot,
    transact: <T>(change: (snapshot: IntakeSnapshot) => { readonly next: IntakeSnapshot | null; readonly value: T }) => Promise<T>,
    port: TriggerBudgetPort,
  ) {
    this.#read = read
    this.#transact = transact
    this.#port = port
  }

  /** The reservation admission makes with a new Goal. */
  reserve(snapshot: IntakeSnapshot, operation: IntakeOperation, definition: TriggerDefinition): { readonly snapshot: IntakeSnapshot } | { readonly refused: string } {
    return reserveDaily(snapshot, operation, definition, this.#port.now(), this.#port.capMicros())
  }

  /**
   * The gate every dispatch of a trigger's run passes, read from the journal
   * alone (no queue): a recorded stop, a pause, time, rounds, progress,
   * allowance, unknown or spent money, and a cap lowered below what is
   * already committed — each refuses, with the sentence the run stops on.
   */
  check(run: FlowExecution): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    let snapshot: IntakeSnapshot
    try {
      snapshot = this.#read()
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    const budget = snapshot.budgets[run.goal]
    if (!budget) return { ok: false, reason: 'This Goal has no recorded trigger budget, so nothing more runs unattended.' }
    if (budget.stop) return { ok: false, reason: budget.stop.detail }
    const now = Math.max(this.#port.now(), snapshot.clock)
    const spend = goalSpend(Object.values(budget.meters), now)
    const findings = run.findings
    const refused = budgetRefusal({
      now, deadline: budget.deadline,
      closedRounds: findings?.closedRounds.length ?? 0, roundLimit: Math.min(budget.rounds, findings?.budget.rounds ?? budget.rounds),
      idleRounds: findings?.idleRounds ?? 0, idleLimit: Math.min(budget.withoutProgress, findings?.budget.withoutProgress ?? budget.withoutProgress),
      spentMicros: spend.spentMicros, limitMicros: budget.usdMicros, lane: this.#port.lane(run.goal), paused: this.#port.paused(),
    })
    if (refused) return { ok: false, reason: spend.spentMicros === null && refused.startsWith('Spend is unknown') && spend.why ? `${refused} ${spend.why}` : refused }
    if (committedToday(snapshot, utcDay(now)) > this.#port.capMicros()) {
      return { ok: false, reason: 'Today’s trigger spend cap is lower than what is already committed, so this Goal waits. Raise the cap or stop some work.' }
    }
    return { ok: true }
  }

  /** The gate by Goal, for a dispatch outside a run's own queue (a publication, a check started elsewhere). */
  async beforeDispatch(goal: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: TriggerStopReason; readonly detail: string }> {
    const run = this.#port.run(goal)
    if (!run) return { ok: false, reason: 'needs a person', detail: 'This Goal has no trigger run to dispatch.' }
    const verdict = this.check(run)
    return verdict.ok ? verdict : { ok: false, reason: stopReasonOf(verdict.reason), detail: verdict.reason }
  }

  /**
   * A trigger run seated a Seat: its meter starts here, at zero only for a
   * session the desk opened for it. The host calls this once the Seat is
   * durable, without waiting on it from inside a run's queue: it takes
   * admission's queue, which is to the run queue's left.
   */
  seated(goal: string, meter: Parameters<typeof openMeter>[0]): Promise<void> {
    return this.#transact((snapshot) => {
      const budget = snapshot.budgets[goal]
      if (!budget || budget.meters[meter.seat]) return { next: null, value: undefined }
      return { next: { ...snapshot, budgets: { ...snapshot.budgets, [goal]: { ...budget, meters: { ...budget.meters, [meter.seat]: openMeter(meter) } } } }, value: undefined }
    })
  }

  /** A turn started or ended on one of a Goal's Seats, as the host saw it. */
  turn(goal: string, seat: string, turn: { readonly started?: number; readonly ended?: number }): Promise<void> {
    return this.#transact((snapshot) => {
      const budget = snapshot.budgets[goal]
      const meter = budget?.meters[seat]
      if (!budget || !meter) return { next: null, value: undefined }
      return { next: { ...snapshot, budgets: { ...snapshot.budgets, [goal]: { ...budget, meters: { ...budget.meters, [seat]: meterTurn(meter, turn) } } } }, value: undefined }
    })
  }

  /**
   * One usage sample, attributed to exactly one of the desk's Seats (the
   * host's Seat book) or to none, and folded into that Seat's meter on the
   * trigger Goal it is kept on. A Seat with no meter yet — its opening not
   * yet recorded — gets one that vouches for nothing cumulative: it was not
   * seen starting at zero. Answers the Goal it counted for, or null.
   */
  observe(sample: UsageSample, seats: readonly SeatRecord[]): Promise<string | null> {
    const id = attributeSample(sample, seats.map(seatWindowOf))
    const seat = id === null ? null : seats.find((one) => one.id === id) ?? null
    const goal = seat?.board ?? null
    if (seat === null || goal === null) return Promise.resolve(null)
    return this.#transact((snapshot) => {
      const budget = snapshot.budgets[goal]
      if (!budget) return { next: null, value: null }
      const meter = budget.meters[seat.id] ?? openMeter({
        seat: seat.id, runtime: seat.session.runtime, sessionId: seat.session.sessionId, project: seat.checkout.project,
        openedAt: seat.openedAt, fresh: false, delegation: 'unknown',
      })
      const next = meterSample(meter, sample)
      if (next === budget.meters[seat.id]) return { next: null, value: goal }
      const clock = Math.max(snapshot.clock, this.#port.now())
      return { next: { ...snapshot, clock, budgets: { ...snapshot.budgets, [goal]: { ...budget, meters: { ...budget.meters, [seat.id]: next } } } }, value: goal }
    })
  }

  /**
   * One read of a Goal's usage, folded in one save with the turn it was read
   * for: every sample attributed to exactly one of the Goal's Seats, then —
   * when the read covered everything — each Seat the desk can vouch for is
   * witnessed as read at `read.at`, then the turn's start or end is
   * recorded. A turn's end is only ever recorded with the read made after
   * it, so a finished turn is metered in the same save that says it ended;
   * a read with gaps witnesses nothing, and the turn then reads as not yet
   * metered — unknown, never zero.
   *
   * A Seat is witnessed only when the desk has read it before, or it is a
   * session the desk opened at zero: an older session found with nothing
   * says nothing about what it spent.
   */
  read(
    goal: string, samples: readonly UsageSample[], seats: readonly SeatRecord[],
    read: { readonly at: number; readonly complete: boolean },
    turn?: { readonly seat: string; readonly started?: number; readonly ended?: number },
  ): Promise<void> {
    const windows = seats.map(seatWindowOf)
    return this.#transact((snapshot) => {
      const budget = snapshot.budgets[goal]
      if (!budget) return { next: null, value: undefined }
      const meters: Record<string, SessionMeter> = { ...budget.meters }
      for (const sample of samples) {
        const id = attributeSample(sample, windows)
        const seat = id === null ? null : seats.find((one) => one.id === id) ?? null
        if (!seat || seat.board !== goal) continue
        const meter = meters[seat.id] ?? openMeter({
          seat: seat.id, runtime: seat.session.runtime, sessionId: seat.session.sessionId, project: seat.checkout.project,
          openedAt: seat.openedAt, fresh: false, delegation: 'unknown',
        })
        meters[seat.id] = meterSample(meter, sample)
      }
      if (read.complete) {
        for (const [id, meter] of Object.entries(meters)) {
          if (meter.unknown !== null || !(meter.observedAt !== null || meter.fresh)) continue
          meters[id] = { ...meter, observedAt: Math.max(meter.observedAt ?? 0, read.at) }
        }
      }
      if (turn && meters[turn.seat]) meters[turn.seat] = meterTurn(meters[turn.seat]!, turn)
      if (JSON.stringify(meters) === JSON.stringify(budget.meters)) return { next: null, value: undefined }
      const clock = Math.max(snapshot.clock, this.#port.now())
      return { next: { ...snapshot, clock, budgets: { ...snapshot.budgets, [goal]: { ...budget, meters } } }, value: undefined }
    })
  }

  /** Records a stop — the first one stands — which refuses every later dispatch. */
  stop(goal: string, reason: TriggerStopReason, detail: string): Promise<boolean> {
    return this.#transact((snapshot) => {
      const budget = snapshot.budgets[goal]
      if (!budget || budget.stop) return { next: null, value: false }
      const at = Math.max(snapshot.clock, this.#port.now())
      return { next: { ...snapshot, clock: at, budgets: { ...snapshot.budgets, [goal]: { ...budget, stop: { reason, detail, at } } } }, value: true }
    })
  }

  /** The Goal's final spend settles its reservation: only a known, complete figure does. */
  settle(goal: string): Promise<boolean> {
    return this.#transact((snapshot) => {
      const budget = snapshot.budgets[goal]
      if (!budget) return { next: null, value: false }
      const now = Math.max(snapshot.clock, this.#port.now())
      const next = settleDaily(snapshot, goal, goalSpend(Object.values(budget.meters), now).spentMicros, now)
      return { next, value: next !== null }
    })
  }

  /** Moves the journal's forward-only clock: a clock read backwards changes nothing. */
  witness(now: number): Promise<void> {
    return this.#transact((snapshot) => ({ next: now > snapshot.clock ? { ...snapshot, clock: now } : null, value: undefined }))
  }

  /** How a Goal's budget stands, for a surface. */
  state(goal: string): TriggerBudgetState | null {
    const snapshot = this.#read()
    const budget = snapshot.budgets[goal]
    if (!budget) return null
    const run = this.#port.run(goal)
    const spend = goalSpend(Object.values(budget.meters), Math.max(this.#port.now(), snapshot.clock))
    return {
      goal, startedAt: budget.startedAt, deadline: budget.deadline,
      budget: { usd: budget.usdMicros / 1_000_000, rounds: budget.rounds, hours: (budget.deadline - budget.startedAt) / 3_600_000, withoutProgress: budget.withoutProgress },
      spentMicros: spend.spentMicros, reservedMicros: budget.reservedMicros, provenance: spend.provenance,
      closedRounds: run?.findings?.closedRounds ?? [], idleRounds: run?.findings?.idleRounds ?? 0, stop: budget.stop,
    }
  }

  /** Every Goal whose budget may still dispatch: unsettled and not stopped. */
  live(): readonly string[] {
    try {
      return Object.entries(this.#read().budgets).filter(([, budget]) => !budget.settled && budget.stop === null).map(([goal]) => goal)
    } catch {
      return []
    }
  }
}

export interface BudgetWatchPort {
  /** Interrupts every active turn and check on the Goal, keeping what each already produced. */
  interrupt(goal: string): Promise<void>
  /** Stops the Goal's trigger run with the reason: its cards, answers and findings are kept, and nothing is merged or wrapped. */
  stopRun(goal: string, reason: string): Promise<void>
  readonly timers?: { every(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
}

/**
 * Watches every live budget at least once a second: a Goal past its time,
 * rounds, progress or money — or whose spend became unknown, or while the
 * machine is paused — is stopped. Recorded first, so no queue dispatches
 * anything more; then interrupted; then its run stops with the reason.
 */
export class BudgetWatch {
  readonly #budgets: TriggerBudgets
  readonly #runs: (goal: string) => FlowExecution | null
  readonly #port: BudgetWatchPort
  #timer: unknown = null
  #ticking: Promise<void> | null = null

  constructor(budgets: TriggerBudgets, runs: (goal: string) => FlowExecution | null, port: BudgetWatchPort) {
    this.#budgets = budgets
    this.#runs = runs
    this.#port = port
  }

  start(): void {
    if (this.#timer !== null || !this.#port.timers) return
    this.#timer = this.#port.timers.every(() => { void this.tick().catch(() => {}) }, 1000)
  }

  close(): void {
    if (this.#timer !== null) this.#port.timers?.clear(this.#timer)
    this.#timer = null
  }

  /** One sweep; a sweep already running is joined, never doubled. */
  tick(): Promise<void> {
    this.#ticking ??= this.#sweep().finally(() => { this.#ticking = null })
    return this.#ticking
  }

  async #sweep(): Promise<void> {
    for (const goal of this.#budgets.live()) {
      const run = this.#runs(goal)
      // Only a run that is going can dispatch: one that settled, stopped or stalled waits on a person already.
      if (!run || run.state !== 'running') continue
      const verdict = this.#budgets.check(run)
      if (verdict.ok) continue
      if (!await this.#budgets.stop(goal, stopReasonOf(verdict.reason), verdict.reason)) continue
      await this.#port.interrupt(goal)
      await this.#port.stopRun(goal, verdict.reason)
    }
  }
}
