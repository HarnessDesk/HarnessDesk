import { createHash } from 'node:crypto'
import { decideLeadPermission, leadBudgetProjection, leadReviewedResultSource, type LeadJournal } from '@harnessdesk/lead'
import { LEAD_LIMITS, type LeadBudgetEvent, type LeadProject, type SeatRecord } from '@harnessdesk/protocol'
import { attributeSample, goalSpend, meterSample, meterTurn, openMeter } from '../intake/spend.js'
import { seatWindowOf } from '../insight/attribution.js'
import type { UsageSample } from '../ledger/insight.js'
import { leadRoundId, type FlowLeadBinding, type FlowLeadGuard, type StoredFlowExecution } from '../flow-execution.js'

export interface LeadBudgetPort {
  usage?(project: string, from: number, to: number): Promise<{ readonly samples: readonly UsageSample[]; readonly complete: boolean }>
  seats?(): readonly SeatRecord[]
  delegation?(seat: SeatRecord): 'none' | 'unknown'
  /** Returns a cancellation function; tests advance the host scheduler explicitly. */
  schedule?(callback: () => void, delayMs: number): () => void
  now(): number
  runs(): readonly StoredFlowExecution[]
  /** Re-check the canonical project is still admitted, before every effect. */
  member(project: LeadProject): Promise<boolean>
  interruptChecks(goal: string): void
  stop(run: string, reason: string): Promise<unknown>
}
/** The host keeps this owner when the child disconnects. A saved Lead run with
 * no registered journal is refused, including during host recovery. */
export class LeadBudgets implements FlowLeadGuard {
  readonly #journals = new Map<string, LeadJournal>()
  readonly #detach = new Map<string, () => void>()
  readonly #cleaning = new Map<string, Promise<void>>()
  readonly #metering = new Map<string, Promise<void>>()
  readonly #turns = new Map<string, { started?: number; ended?: number }>()
  readonly #observing = new Map<string, Promise<void>>()
  readonly #retries = new Map<string, () => void>()
  readonly #backoff = new Map<string, number>()
  readonly #pending = new Map<string, { journal: LeadJournal; stepId: string; params: unknown; project: LeadProject }>()
  readonly #children = new Map<LeadJournal, () => void>()
  #recovering = false
  constructor(readonly port: LeadBudgetPort) {}
  register(journal: LeadJournal): () => void {
    const id = journal.state.budget?.logicalGoalId
    if (!id || this.#journals.has(id)) throw new Error('lead-budget-owner')
    this.#journals.set(id, journal)
    this.#detach.set(id, journal.onChange(() => this.#changed(id, journal)))
    this.#changed(id, journal)
    return () => {
      if (this.#journals.get(id) !== journal) return
      this.#children.get(journal)?.()
      this.#detach.get(id)?.(); this.#detach.delete(id); this.#journals.delete(id)
      this.#clearRetry(id)
      for (const [start, pending] of this.#pending) if (pending.journal === journal) this.#pending.delete(start)
    }
  }
  /** The supervisor holds this latch from child start until fully observed exit. */
  childStarted(journal: LeadJournal): () => void {
    const id = journal.state.budget?.logicalGoalId
    if (!id || this.#journals.get(id) !== journal) throw new Error('lead-budget-owner')
    if (this.#recovering) throw new Error('lead-recovery-live')
    if (this.#children.has(journal)) throw new Error('lead-child-live')
    const ended = () => { if (this.#children.get(journal) === ended) this.#children.delete(journal) }
    this.#children.set(journal, ended)
    return ended
  }
  #changed(id: string, journal: LeadJournal): void {
    const state = journal.state
    const uncertain = state.budget?.requests.some(request => request.uncertain)
    if ((!uncertain && state.stopEffectsPending === null) || this.#observing.has(id)) return
    const task = Promise.resolve().then(async () => {
      // A Messages reservation already bounds its unknown bill. Charge that
      // bound in full; worker usage with no bound still stops at the dispatch gate.
      for (const request of journal.state.budget?.requests ?? []) if (request.uncertain)
        await journal.updateBudget({ version: 1, type: 'write-off', now: this.port.now(), requestId: request.reservation.requestId })
      if (journal.state.stopEffectsPending !== null) await this.cleanup(id)
    })
    this.#observing.set(id, task)
    void task.finally(() => this.#observing.delete(id)).catch(() => {})
  }
  /** The journal already charged this start's first round. Revalidate its
   * allowance without charging it twice or treating its own placeholder as lost. */
  startBudget(journal: LeadJournal, startId: string) {
    const budget = journal.state.budget!
    return leadBudgetProjection({ ...budget, rounds: budget.rounds.filter(round => round.startId !== startId || round.executionId !== null) }, this.port.now())
  }
  prepared(startId: string): boolean { return this.#pending.has(startId) }
  prepare(startId: string, journal: LeadJournal, stepId: string, params: unknown, project: LeadProject): void {
    if (this.#journals.get(journal.state.budget!.logicalGoalId) !== journal || this.#pending.has(startId)) throw new Error('lead-budget-owner')
    this.#pending.set(startId, { journal, stepId, params: structuredClone(params), project: structuredClone(project) })
  }
  async validateStart(binding: FlowLeadBinding): Promise<void> {
    const pending = this.#pending.get(binding.startId), journal = this.#journals.get(binding.logicalGoalId)
    if (!journal || pending?.journal !== journal) throw new Error('lead-start-not-approved')
    const state = journal.state, contract = state.contract, step = contract?.steps.find(item => item.id === binding.stepId)
    const admitted = state.steps.find(item => item.id === step?.id), attempt = admitted?.attemptId ? state.attempts.get(admitted.attemptId) : null
    if (!contract || contract.digest !== binding.contractDigest || !step || admitted?.state !== 'admitted' ||
      !attempt || attempt.correlationId !== binding.startId || attempt.phase !== 'started' || !attempt.dispatched || attempt.method !== 'flow/start-goal' ||
      state.runs.some(run => run.correlationId === binding.startId) ||
      state.recoveryBlocked || ['stopped', 'accepted', 'declined', 'waiting-for-user', 'awaiting-plan'].includes(state.phase) ||
      !await this.port.member(contract.project)) throw new Error('lead-start-not-approved')
    const current = journal.state
    const decision = decideLeadPermission({ method: 'flow/start-goal', params: pending.params, project: pending.project, runId: null, start: step },
      { desk: current.policy!, projectPolicy: null, project: pending.project, approved: current.contract && current.consent ?
        { contract: current.contract, consent: current.consent, runIds: current.runs.map(run => run.runId), teamIds: current.teams } : null,
      budget: current.budget ? this.startBudget(journal, binding.startId) : null, now: this.port.now(), policyInterpretation: 'idle' })
    if (decision.effect !== 'allow') throw new Error('lead-start-not-approved')
  }
  #journal(run: StoredFlowExecution): LeadJournal {
    const journal = run.lead && this.#journals.get(run.lead.logicalGoalId)
    const step = journal?.state.steps.find(step => step.id === run.lead?.stepId && step.attemptId === run.lead.startId)
    if (!journal || run.source !== leadReviewedResultSource || !run.requireHeld || !step?.contractDigest ||
      step.contractDigest !== run.lead!.contractDigest) throw new Error('lead-guard-unavailable')
    return journal
  }
  async bind(run: StoredFlowExecution): Promise<void> {
    const journal = this.#journal(run), lead = run.lead!
    if (!await this.port.member(journal.state.contract!.project)) throw new Error('lead-project-withdrawn')
    const state = journal.state
    if (state.budget!.goalId !== null && state.budget!.goalId !== run.goal && state.contract!.steps.length <= 1) throw new Error('lead-start-not-approved')
    const pending = this.#pending.get(lead.startId)
    const owned = state.runs.find(item => item.correlationId === lead.startId || item.runId === run.id)
    if (owned ? owned.runId !== run.id || owned.teamId !== run.goal || owned.correlationId !== lead.startId
      : !pending || pending.journal !== journal || pending.stepId !== lead.stepId) throw new Error('lead-start-not-approved')
    await journal.updateBudget({ version: 1, type: 'bind', now: this.port.now(), startId: lead.startId,
      goalId: run.goal, executionId: run.id, firstRoundId: leadRoundId(run.id, 1) })
    this.#pending.delete(lead.startId)
  }
  async gate(run: StoredFlowExecution): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    try {
      const journal = this.#journal(run), state = journal.state
      if (!state.runs.some(item => item.runId === run.id && item.teamId === run.goal) || !state.budget!.executionIds.includes(run.id)) throw new Error('lead-run-unowned')
      if (!await this.port.member(state.contract!.project)) throw new Error('lead-project-withdrawn')
      await this.#refresh(run, journal)
      // Read again after membership awaits: a latch may have landed meanwhile.
      const current = journal.state, budget = leadBudgetProjection(current.budget!, this.port.now())
      if (budget.stop || ['stopped', 'accepted', 'declined'].includes(current.phase) || current.recoveryBlocked) throw new Error('lead-budget-stopped')
      // A brand-new execution has no worker turn to meter. Once work exists,
      // missing or stale attribution stops it rather than inferring zero.
      const worked = this.port.runs().some(one => one.lead?.logicalGoalId === run.lead!.logicalGoalId && one.operations.some(op => op.kind === 'turn' && op.state === 'finished'))
      if (worked && budget.spend !== 'known') {
        await journal.updateBudget({ version: 1, type: 'stop', now: this.port.now(), reason: 'unknown-spend' })
        throw new Error('lead-budget-unknown')
      }
      return { ok: true }
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'lead-dispatch-refused' } }
  }
  /** Rebuild meters from the host-created Seats' full usage windows. The
   * durable aggregate only moves upwards; a restart needs no guessed baseline. */
  #refresh(run: StoredFlowExecution, journal: LeadJournal): Promise<void> {
    if (!this.port.usage || !this.port.seats || journal.state.budget!.stop) return Promise.resolve()
    const id = run.lead!.logicalGoalId, active = this.#metering.get(id)
    if (active) return active
    const task = (async () => {
      const runs = this.port.runs().filter(one => one.lead?.logicalGoalId === id)
      const ids = new Set(runs.flatMap(one => one.rounds.flatMap(round => round.seats)))
      const seats = this.port.seats!().filter(seat => ids.has(String(seat.id)))
      if (ids.size === 0) return
      const now = Math.max(this.port.now(), journal.state.budget!.now)
      let read: { readonly samples: readonly UsageSample[]; readonly complete: boolean }
      try { read = await this.port.usage!(journal.state.contract!.project.path, seats.length ? Math.min(...seats.map(seat => seat.openedAt)) : now, now) }
      catch { read = { samples: [], complete: false } }
      const windows = seats.map(seatWindowOf)
      let complete = read.complete && seats.length === ids.size && journal.state.budget!.executionIds.every(execution => runs.some(one => one.id === execution))
      const meters = seats.map(seat => {
        let meter = openMeter({ seat: seat.id, runtime: seat.session.runtime, sessionId: seat.session.sessionId,
          project: seat.checkout.project, openedAt: seat.openedAt, fresh: true, delegation: this.port.delegation?.(seat) ?? 'unknown' })
        const assigned = read.samples.filter(sample => attributeSample(sample, windows) === seat.id)
        for (const sample of assigned) meter = meterSample(meter, sample)
        if (read.samples.some(sample => sample.runtime === seat.session.runtime && sample.sessionId === seat.session.sessionId && attributeSample(sample, windows) === null)) complete = false
        if (read.complete) meter = { ...meter, observedAt: Math.max(meter.observedAt ?? 0, now) }
        return meterTurn(meter, this.#turns.get(seat.id) ?? {})
      })
      const total = goalSpend(meters, now).spentMicros
      complete &&= total !== null && Number.isSafeInteger(total) && total <= LEAD_LIMITS.maxUsdMicros
      const budget = journal.state.budget!
      const source = createHash('sha256').update(JSON.stringify(read.samples.map(sample => sample.key).sort())).digest('hex')
      await journal.updateBudget({ version: 1, type: 'observe', now, at: now, revision: budget.revision + 1,
        source: 'worker-samples', sourceIds: [source], goalId: budget.goalId!, executionIds: budget.executionIds,
        quality: complete ? 'known' : 'unknown', usdMicros: total === null ? null : Math.min(LEAD_LIMITS.maxUsdMicros, total) })
      if (!complete && !journal.state.budget!.stop) await journal.updateBudget({ version: 1, type: 'stop', now, reason: 'unknown-spend' })
    })()
    this.#metering.set(id, task)
    void task.finally(() => this.#metering.delete(id)).catch(() => {})
    return task
  }
  /** Usage monitoring belongs to the host and survives the child's exit. */
  turn(seat: SeatRecord, change: 'started' | 'ended'): void {
    const run = this.port.runs().find(one => one.goal === seat.board && one.rounds.some(round => round.seats.includes(seat.id)))
    if (!run?.lead) return
    const at = this.port.now(), previous = this.#turns.get(seat.id) ?? {}
    this.#turns.set(seat.id, { ...previous, ...(change === 'started' ? { started: at } : { ended: at }) })
    const journal = this.#journals.get(run.lead.logicalGoalId)
    if (journal) void this.#refresh(run, journal).catch(async () => {
      if (!journal.state.budget!.stop) await journal.updateBudget({ version: 1, type: 'stop', now: at, reason: 'unknown-spend' })
    }).catch(() => {})
  }
  async round(run: StoredFlowExecution, roundId: string): Promise<void> {
    const journal = this.#journal(run)
    if (journal.state.budget!.rounds.some(item => item.executionId === run.id && item.roundId === roundId)) return
    try { await journal.updateBudget({ version: 1, type: 'round', now: this.port.now(), executionId: run.id, roundId }) }
    catch {
      const view = leadBudgetProjection(journal.state.budget!, this.port.now())
      const reason = view.stop ? null : view.roundsAdmitted >= view.caps.rounds ? 'rounds'
        : view.leadUsdMicros + view.workerUsdMicros >= view.caps.usdMicros ? 'budget'
        : view.spend !== 'known' ? 'unknown-spend' : null
      // An outstanding Messages reservation and a terminal execution refuse this
      // round without converting temporary headroom or closed work into a cap.
      if (reason) await journal.updateBudget({ version: 1, type: 'stop', now: this.port.now(), reason })
      throw new Error('lead-round-refused')
    }
  }
  async update(logicalGoalId: string, event: LeadBudgetEvent): Promise<void> {
    const journal = this.#journals.get(logicalGoalId)
    if (!journal) throw new Error('lead-budget-owner')
    await journal.updateBudget(event)
    if (journal.state.stopEffectsPending !== null) await this.cleanup(logicalGoalId)
  }
  cleanup(logicalGoalId: string): Promise<void> {
    const active = this.#cleaning.get(logicalGoalId)
    if (active) return active
    const journal = this.#journals.get(logicalGoalId)
    if (!journal) return Promise.reject(new Error('lead-budget-owner'))
    const task = journal.runStopEffects(async () => {
      const runs = this.port.runs().filter(run => run.lead?.logicalGoalId === logicalGoalId)
      if (journal.state.runs.some(owned => !runs.some(run => run.id === owned.runId && run.goal === owned.teamId)))
        throw new Error('lead-stop-runs-unavailable')
      for (const run of runs) this.port.interruptChecks(run.goal)
      // Stop owns Seat interruption, release, approval cancellation and unsent
      // publication cleanup. Retrying an ended run finishes that same cleanup.
      const results = await Promise.allSettled(runs.map(run => this.port.stop(run.id, 'Lead budget stopped.')))
      if (results.some(result => result.status === 'rejected')) throw new Error('lead-stop-cleanup-failed')
    })
    this.#cleaning.set(logicalGoalId, task)
    void task.then(() => {
      this.#cleaning.delete(logicalGoalId)
      if (this.#journals.get(logicalGoalId) === journal) this.#clearRetry(logicalGoalId)
    }, () => {
      this.#cleaning.delete(logicalGoalId)
      if (this.#journals.get(logicalGoalId) === journal && journal.state.stopEffectsPending !== null) this.#retry(logicalGoalId, journal)
    })
    return task
  }
  #clearRetry(id: string): void {
    this.#retries.get(id)?.(); this.#retries.delete(id); this.#backoff.delete(id)
  }
  #retry(id: string, journal: LeadJournal): void {
    if (this.#retries.has(id)) return
    const delay = Math.min((this.#backoff.get(id) ?? 50) * 2, 5000)
    this.#backoff.set(id, delay)
    const schedule = this.port.schedule ?? ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms); timer.unref()
      return () => clearTimeout(timer)
    })
    const cancel = schedule(() => {
      this.#retries.delete(id)
      if (this.#journals.get(id) === journal && journal.state.stopEffectsPending !== null) void this.cleanup(id).catch(() => {})
    }, delay)
    this.#retries.set(id, cancel)
  }
  async recover(): Promise<void> {
    if (this.#children.size) throw new Error('lead-child-live')
    if (this.#recovering) throw new Error('lead-recovery-live')
    this.#recovering = true
    try {
      const errors: unknown[] = []
      for (const [id, journal] of this.#journals) {
        try {
          if (journal.state.contract && !await this.port.member(journal.state.contract.project)) {
            await journal.updateBudget({ version: 1, type: 'stop', now: this.port.now(), reason: 'unknown-spend' })
          }
          await journal.recover(async attempt => this.port.runs().filter(run => run.lead?.logicalGoalId === id && run.lead.startId === attempt.correlationId).map(run => ({
            correlationId: attempt.correlationId, runId: run.id, teamId: run.goal, firstRoundId: leadRoundId(run.id, 1), terminal: !['running', 'stalled'].includes(run.state),
          })))
          if (journal.state.stopEffectsPending !== null) await this.cleanup(id)
        } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'lead-recovery-failed')
    } finally { this.#recovering = false }
  }
  async idle(): Promise<void> { while (this.#cleaning.size || this.#observing.size || this.#metering.size) await Promise.allSettled([...this.#cleaning.values(), ...this.#observing.values(), ...this.#metering.values()]) }
}
