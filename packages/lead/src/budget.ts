import { LEAD_LIMITS, nextLeadRevision, parseLeadBudgetEvent, parseLeadBudgetState, parseLeadCardDecisionFor,
  type LeadBudgetEvent, type LeadBudgetState, type LeadCard, type LeadCardDecision } from '@harnessdesk/protocol'

/** The host and child use the same identity at start settlement and recovery. */
export const leadRoundId = (run: string, round: number): string => `${run}:round:${round}`

type Event<T extends LeadBudgetEvent['type']> = Extract<LeadBudgetEvent, { type: T }>
interface Request { readonly reservation: Event<'reserve'>; readonly uncertain: boolean }
interface Settled { readonly id: string; readonly digest: string; readonly usdMicros: number }
/** Active requests retain reservations; settled requests retain only compact identity,
 * charge and collision-free usage digests. Neither index is evicted during checkpointing. */
export interface LeadBudgetLedger extends LeadBudgetState {
  /** goalId anchors aggregate observations; each run's actual Goal stays in the journal. */
  readonly logicalGoalId: string; readonly goalId: string | null; readonly executionIds: readonly string[]
  readonly now: number; readonly freshnessMs: number
  readonly capsRevision: number
  /** A reported charge exceeded the portable protocol range; never infer headroom from its saturated total. */
  readonly spendOverflow: boolean
  /** History exceeded the bounded accounting index; only live cancellation evidence remains complete. */
  readonly accountingIncomplete: boolean
  readonly terminalObservations: readonly Event<'observe'>[]
  readonly requests: readonly Request[]
  readonly settled: readonly Settled[]
  readonly rounds: readonly { readonly executionId: string | null; readonly roundId: string | null; readonly startId: string | null }[]
  readonly observations: Readonly<Record<'insight/goal' | 'worker-samples', Event<'observe'> | null>>
  readonly observation: Event<'observe'> | null
}
const ensure = (condition: unknown): void => { if (!condition) throw new Error('lead-budget-refused') }
/** A valid reserve can lose headroom while it waits for the durable writer. */
export class LeadBudgetAdmissionRefused extends Error {
  constructor() { super('lead-budget-refused') }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const cost = (tokens: number, rate: number): number => {
  const value = (BigInt(tokens) * BigInt(rate) + 999_999n) / 1_000_000n
  return Number(value)
}
// Numeric usage has a compact, lossless base-36 digest; unlike a hash this cannot
// collide. Time is excluded so retries of the same usage remain idempotent.
const usageDigest = (usage: Event<'settle'>) => [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0,
  usage.cacheWriteTokens ?? 0].map(value => value.toString(36)).join('.')
const charge = (reserve: Event<'reserve'>, usage: Event<'settle'> | null): number => {
  if (usage) return cost(usage.inputTokens, reserve.inputUsdMicrosPerMillion) + cost(usage.outputTokens, reserve.outputUsdMicrosPerMillion) +
    cost(usage.cacheReadTokens ?? 0, reserve.cacheReadUsdMicrosPerMillion) + cost(usage.cacheWriteTokens ?? 0, reserve.cacheWriteUsdMicrosPerMillion)
  const rates = [reserve.inputUsdMicrosPerMillion, reserve.cacheReadUsdMicrosPerMillion, reserve.cacheWriteUsdMicrosPerMillion]
  const maximum = Math.max(...rates)
  // Each additional populated input category can add one micro-unit of rounding.
  // An integral per-token maximum already bounds each category without headroom.
  const rounding = maximum % 1_000_000 === 0 ? 0 : Math.min(Math.max(0, reserve.inputTokens - 1), rates.filter(rate => rate > 0).length - 1)
  return cost(reserve.inputTokens, maximum) + rounding + cost(reserve.maxOutputTokens, reserve.outputUsdMicrosPerMillion)
}
const terminalIds = (state: LeadBudgetLedger) => state.terminalObservations.map(observation => observation.executionIds[0]!)
const sum = (observations: readonly Event<'observe'>[]) => observations.reduce((total, observation) => total + observation.usdMicros!, 0)
const goalNamed = (state: LeadBudgetLedger) => state.terminalObservations.filter(observation => state.observation?.executionIds.includes(observation.executionIds[0]!))
/** Both figures are lower bounds for the runs they share, whatever their quality or age:
 * the larger one counts, so a final cost is never hidden behind an older goal total. */
const observedCost = (state: LeadBudgetLedger): number => {
  const named = goalNamed(state)
  return Math.max(state.observation?.usdMicros ?? 0, sum(named)) + sum(state.terminalObservations.filter(observation => !named.includes(observation)))
}
/** Read-only projection takes time explicitly. Unknown, partial or stale attribution
 * never replaces a cumulative charge with zero. The Lead stops when reported spend reaches the cap. */
export const leadBudgetProjection = (state: LeadBudgetLedger, now: number): LeadBudgetState => {
  ensure(Number.isSafeInteger(now) && now >= 0)
  now = Math.max(now, state.now)
  const observed = state.observation
  const terminal = terminalIds(state)
  const remaining = state.executionIds.filter(id => !terminal.includes(id))
  let spend: LeadBudgetState['spend'] = remaining.length === 0 ? 'known' : 'unknown'
  if (remaining.length > 0 && (observed || terminal.length > 0)) {
    spend = observed?.quality ?? 'partial'
    if (!observed || !remaining.every(id => observed.executionIds.includes(id))) spend = 'partial'
    else if (now - observed.at > state.freshnessMs) spend = 'stale'
    // A goal total below the final costs it names predates them; it cannot vouch for its runs still going.
    else if (sum(goalNamed(state)) > (observed.usdMicros ?? 0)) spend = 'partial'
  }
  if (spend === 'known' && observedCost(state) < state.workerUsdMicros) spend = 'ambiguous'
  if (state.accountingIncomplete || state.spendOverflow || state.requests.some(request => request.uncertain) || state.rounds.some(round => round.startId !== null && round.executionId === null)) spend = 'unknown'
  return parseLeadBudgetState({ version: 1, revision: state.revision, caps: state.caps, leadUsdMicros: state.leadUsdMicros,
    workerUsdMicros: state.workerUsdMicros, reservedUsdMicros: state.reservedUsdMicros, roundsAdmitted: state.rounds.length, spend, stop: state.stop })
}
/** Host-only, journaled reopening of one stopped execution. Validate the old
 * complete projection first, retain every charged dollar, and reserve exactly
 * one additional round before discarding its final-cost status. Fresh cumulative
 * metering must cover the active run again before dispatch; old observations
 * stay as source revision fences but can no longer vouch for its spend.
 */
export const reopenLeadBudgetRound = (state: LeadBudgetLedger, executionId: string, roundId: string, now: number): LeadBudgetLedger => {
  ensure(Number.isSafeInteger(now) && now >= state.now && state.executionIds.includes(executionId) &&
    typeof roundId === 'string' && roundId.length > 0 && roundId.length <= 200)
  if (state.rounds.some(round => round.executionId === executionId && round.roundId === roundId)) return state
  const view = leadBudgetProjection(state, now)
  ensure(view.stop === null && view.spend === 'known' && state.requests.length === 0 && view.reservedUsdMicros === 0 &&
    view.roundsAdmitted < view.caps.rounds && state.rounds.length < LEAD_LIMITS.rounds &&
    view.leadUsdMicros + view.workerUsdMicros < view.caps.usdMicros)
  return finish({ ...state, now, revision: nextLeadRevision(state.revision),
    rounds: [...state.rounds, { executionId, roundId, startId: null }],
    terminalObservations: state.terminalObservations.filter(observation => observation.executionIds[0] !== executionId),
    observation: null })
}
const finish = (state: LeadBudgetLedger): LeadBudgetLedger => {
  const charged = state.settled.reduce((total, item) => Math.min(LEAD_LIMITS.maxUsdMicros + 1, total + item.usdMicros), 0)
  const leadUsdMicros = Math.min(LEAD_LIMITS.maxUsdMicros, charged)
  const reservedUsdMicros = state.requests.reduce((total, request) => total + charge(request.reservation, null), 0)
  const total = leadUsdMicros + state.workerUsdMicros
  const spendOverflow = state.spendOverflow || charged > LEAD_LIMITS.maxUsdMicros || total > LEAD_LIMITS.maxUsdMicros
  const reason = spendOverflow || total >= state.caps.usdMicros ? 'budget' : state.rounds.length > state.caps.rounds ? 'rounds' : null
  const stop = state.stop ?? (reason ? { reason, revision: state.revision } : null)
  const next = { ...state, spendOverflow, leadUsdMicros, reservedUsdMicros, roundsAdmitted: state.rounds.length, stop }
  return { ...next, ...leadBudgetProjection(next, state.now) }
}
const admit = (state: LeadBudgetLedger, now: number, round = false): void => {
  const view = leadBudgetProjection(state, now)
  ensure(view.stop === null && view.spend === 'known' && (!round || view.roundsAdmitted < view.caps.rounds) &&
    view.leadUsdMicros + view.workerUsdMicros + view.reservedUsdMicros < view.caps.usdMicros)
}
/** Pure state transition; only journal admission may turn its result into an effect. */
export const reduceLeadBudget = (previous: LeadBudgetLedger | null, value: unknown): LeadBudgetLedger => {
  const event = parseLeadBudgetEvent(value)
  if (event.type === 'initialize') {
    ensure(previous === null)
    return finish({ version: 1, revision: 1, logicalGoalId: event.logicalGoalId, caps: event.caps, freshnessMs: event.freshnessMs,
      now: event.now, goalId: null, executionIds: [], capsRevision: 1, spendOverflow: false, accountingIncomplete: false, terminalObservations: [], requests: [], settled: [], rounds: [], observations: { 'insight/goal': null, 'worker-samples': null },
      observation: null, leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known', stop: null })
  }
  ensure(previous !== null)
  const state = previous!
  const now = Math.max(state.now, event.now)
  const duplicate = () => finish({ ...state, now })
  let next = { ...state, revision: nextLeadRevision(state.revision), now }
  switch (event.type) {
    case 'bind': {
      // Each approved step starts a fresh host Goal. Only a recorded start may
      // add one; legacy observations retain their single-Goal binding.
      ensure(state.goalId === null || state.goalId === event.goalId || event.startId !== undefined)
      const recordedStart = state.rounds.find(round => round.executionId === event.executionId && round.startId !== null)
      ensure(!recordedStart || event.startId === recordedStart.startId)
      const exhausted = () => finish({ ...next, accountingIncomplete: true,
        stop: state.stop ?? { reason: 'unknown-spend', revision: next.revision } })
      if (!state.executionIds.includes(event.executionId) && state.executionIds.length >= LEAD_LIMITS.rounds) return exhausted()
      let rounds = state.rounds
      if (event.startId) {
        const existing = state.rounds.filter(round => round.startId === event.startId)
        ensure(existing.length > 0 && event.firstRoundId)
        const started = existing.find(round => round.executionId === event.executionId) ?? existing.find(round => round.executionId === null)
        ensure(!state.rounds.some(round => round !== started && round.executionId === event.executionId && round.roundId === event.firstRoundId))
        if (started) {
          ensure(started.roundId === null || started.roundId === event.firstRoundId)
          rounds = state.rounds.map(round => round === started ? { ...round, executionId: event.executionId, roundId: event.firstRoundId! } : round)
        } else {
          // This run already exists. Discovery records consumption even beyond a
          // cap; it cannot refuse history as though it were admitting new work.
          if (state.rounds.length >= LEAD_LIMITS.rounds) return exhausted()
          rounds = [...state.rounds, { executionId: event.executionId, roundId: event.firstRoundId!, startId: event.startId }]
        }
      }
      if (state.executionIds.includes(event.executionId) && same(rounds, state.rounds)) return duplicate()
      ensure(state.executionIds.includes(event.executionId) || state.executionIds.length < LEAD_LIMITS.rounds)
      next = { ...next, rounds, goalId: state.goalId ?? event.goalId, executionIds: [...new Set([...state.executionIds, event.executionId])] }; break
    }
    case 'reserve': {
      ensure(state.requests.length < 4096 && !state.requests.some(request => request.reservation.requestId === event.requestId) && !state.settled.some(item => item.id === event.requestId))
      const view = leadBudgetProjection(state, now)
      if (view.stop !== null || view.spend !== 'known' || view.roundsAdmitted >= view.caps.rounds ||
          view.leadUsdMicros + view.workerUsdMicros + view.reservedUsdMicros >= view.caps.usdMicros ||
          state.leadUsdMicros + state.workerUsdMicros + state.reservedUsdMicros + charge(event, null) > state.caps.usdMicros)
        throw new LeadBudgetAdmissionRefused()
      const request = { reservation: event, uncertain: false }
      next = { ...next, requests: [...state.requests, request] }; break
    }
    case 'settle': case 'uncertain': case 'write-off': {
      const settled = state.settled.find(item => item.id === event.requestId)
      if (settled) { ensure(event.type === 'write-off' ? settled.digest === 'write-off' : event.type === 'settle' && settled.digest === usageDigest(event)); return duplicate() }
      const request = state.requests.find(request => request.reservation.requestId === event.requestId)
      ensure(request)
      if (event.type === 'settle' || event.type === 'write-off') {
        ensure(event.type !== 'write-off' || request!.uncertain)
        const actual = charge(request!.reservation, event.type === 'settle' ? event : null)
        next = { ...next, requests: state.requests.filter(item => item !== request),
          spendOverflow: state.spendOverflow || actual > LEAD_LIMITS.maxUsdMicros,
          settled: [...state.settled, { id: event.requestId, digest: event.type === 'write-off' ? 'write-off' : usageDigest(event), usdMicros: Math.min(LEAD_LIMITS.maxUsdMicros, actual) }] }
      } else {
        if (request!.uncertain) return duplicate()
        next = { ...next, requests: state.requests.map(item => item === request ? { ...item, uncertain: true } : item) }
      }
      break
    }
    case 'observe': {
      ensure(state.goalId === event.goalId && event.executionIds.every(id => state.executionIds.includes(id)))
      const prior = state.observations[event.source]
      if (prior && event.revision === prior.revision) { ensure(same({ ...prior, now: event.now }, event)); return duplicate() }
      ensure((!prior || event.revision > prior.revision && event.at >= prior.at) && (!state.observation || event.at >= state.observation.at))
      let terminalObservations = state.terminalObservations
      if (event.terminal) {
        // Late billing can correct a final cost upwards; a lower report never lowers it.
        const previous = terminalObservations.find(item => item.executionIds[0] === event.executionIds[0])
        if (!previous) terminalObservations = [...terminalObservations, event]
        else if (event.usdMicros! > previous.usdMicros!) terminalObservations = terminalObservations.map(item => item === previous ? event : item)
      }
      next = { ...next, observations: { ...state.observations, [event.source]: event }, terminalObservations,
        observation: event.terminal ? state.observation : event }
      const workerCost = observedCost(next)
      next = { ...next, workerUsdMicros: Math.max(state.workerUsdMicros, Math.min(LEAD_LIMITS.maxUsdMicros, workerCost)),
        spendOverflow: state.spendOverflow || workerCost > LEAD_LIMITS.maxUsdMicros }; break
    }
    case 'start':
      if (state.rounds.some(round => round.startId === event.startId)) return duplicate()
      admit(state, now, true)
      next = { ...next, rounds: [...state.rounds, { executionId: null, roundId: null, startId: event.startId }] }; break
    case 'round': {
      ensure(state.executionIds.includes(event.executionId))
      ensure(!state.rounds.some(round => round.executionId === event.executionId && round.startId !== null && round.roundId === null))
      if (state.rounds.some(round => round.executionId === event.executionId && round.roundId === event.roundId)) return duplicate()
      // A finished run's cost is final; new work on it would spend unseen.
      ensure(!terminalIds(state).includes(event.executionId))
      admit(state, now, true)
      ensure(state.rounds.length < LEAD_LIMITS.rounds)
      next = { ...next, rounds: [...state.rounds, { executionId: event.executionId, roundId: event.roundId, startId: null }] }; break
    }
    case 'tighten':
      ensure(event.caps.usdMicros <= state.caps.usdMicros && event.caps.rounds <= state.caps.rounds)
      return applyLeadBudgetCaps({ ...state, now }, event.caps)
    case 'stop': next = { ...next, stop: state.stop ?? { reason: event.reason, revision: next.revision },
      accountingIncomplete: state.accountingIncomplete || event.reason === 'unknown-spend' }; break
  }
  return finish(next)
}
export const applyLeadBudgetCaps = (state: LeadBudgetLedger, caps: LeadBudgetState['caps']): LeadBudgetLedger => {
  const revision = nextLeadRevision(state.revision)
  const tightening = caps.usdMicros < state.caps.usdMicros && state.leadUsdMicros + state.workerUsdMicros + state.reservedUsdMicros > caps.usdMicros
  return finish({ ...state, caps, revision, capsRevision: nextLeadRevision(state.capsRevision),
    stop: state.stop ?? (tightening ? { reason: 'budget', revision } : null) })
}
/** Only a revision-bound window click can widen allowances; it cannot clear a stop. */
export const applyLeadBudgetCard = (state: LeadBudgetLedger, decision: LeadCardDecision, card: LeadCard): LeadBudgetLedger => {
  const click = parseLeadCardDecisionFor(decision, card)
  ensure(card.type === 'budget-change')
  if (card.type !== 'budget-change' || click.choice === 'decline') return state
  ensure(card.logicalGoalId === state.logicalGoalId && card.previous.revision === state.capsRevision && same(card.previous.caps, state.caps))
  return applyLeadBudgetCaps(state, card.proposed)
}
/** Validate reduced checkpoint data without trusting stored projections or losing IDs. */
export const parseLeadBudgetLedger = (value: unknown): LeadBudgetLedger => {
  const source = value as LeadBudgetLedger
  ensure(source && typeof source === 'object')
  const initial = reduceLeadBudget(null, { version: 1, type: 'initialize', now: source.now, logicalGoalId: source.logicalGoalId,
    caps: source.caps, freshnessMs: source.freshnessMs })
  ensure(Object.keys(source).sort().join() === Object.keys(initial).sort().join())
  parseLeadBudgetState({ version: source.version, revision: source.revision, caps: source.caps, leadUsdMicros: source.leadUsdMicros,
    workerUsdMicros: source.workerUsdMicros, reservedUsdMicros: source.reservedUsdMicros, roundsAdmitted: source.roundsAdmitted, spend: source.spend, stop: source.stop })
  ensure(Array.isArray(source.executionIds) && source.executionIds.length <= LEAD_LIMITS.rounds && new Set(source.executionIds).size === source.executionIds.length)
  for (const executionId of source.executionIds) parseLeadBudgetEvent({ version: 1, type: 'bind', now: source.now, goalId: source.goalId, executionId })
  ensure(source.goalId === null ? source.executionIds.length === 0 : source.executionIds.length > 0)
  ensure(typeof source.spendOverflow === 'boolean' && typeof source.accountingIncomplete === 'boolean')
  ensure(!source.accountingIncomplete || source.stop !== null)
  ensure(Array.isArray(source.requests) && source.requests.length <= 4096)
  ensure(Number.isSafeInteger(source.capsRevision) && source.capsRevision >= 1 && source.capsRevision <= source.revision)
  const ids = new Set<string>()
  for (const request of source.requests) {
    ensure(request && Object.keys(request).sort().join() === ['reservation', 'uncertain'].sort().join() && typeof request.uncertain === 'boolean')
    ensure(parseLeadBudgetEvent(request.reservation).type === 'reserve' && request.reservation.now <= source.now && !ids.has(request.reservation.requestId))
    ids.add(request.reservation.requestId)
  }
  ensure(Array.isArray(source.settled))
  for (const item of source.settled) {
    ensure(item && Object.keys(item).sort().join() === ['id', 'digest', 'usdMicros'].sort().join())
    parseLeadBudgetEvent({ version: 1, type: 'uncertain', now: source.now, requestId: item.id })
    ensure(!ids.has(item.id) && typeof item.digest === 'string' && (item.digest === 'write-off' || /^(?:[0-9a-z]{1,6}\.){3}[0-9a-z]{1,6}$/.test(item.digest)))
    ensure(Number.isSafeInteger(item.usdMicros) && item.usdMicros >= 0 && item.usdMicros <= LEAD_LIMITS.maxUsdMicros)
    ids.add(item.id)
  }
  ensure(Array.isArray(source.rounds) && source.rounds.length <= LEAD_LIMITS.rounds)
  const rounds = new Set<string>(), starts = new Set<string>()
  for (const round of source.rounds) {
    ensure(round && Object.keys(round).sort().join() === ['executionId', 'roundId', 'startId'].sort().join())
    if (round.startId !== null) {
      parseLeadBudgetEvent({ version: 1, type: 'start', now: source.now, startId: round.startId })
      const startKey = JSON.stringify([round.startId, round.executionId])
      ensure(!starts.has(startKey)); starts.add(startKey)
      ensure(!source.rounds.some(other => other !== round && other.startId === round.startId && (other.executionId === null || round.executionId === null)))
    } else ensure(round.executionId !== null && round.roundId !== null)
    if (round.executionId === null) ensure(round.roundId === null)
    if (round.executionId !== null) {
      ensure(source.executionIds.includes(round.executionId))
      if (round.roundId === null) continue
      parseLeadBudgetEvent({ version: 1, type: 'round', now: source.now, executionId: round.executionId, roundId: round.roundId })
      const key = JSON.stringify([round.executionId, round.roundId])
      ensure(source.executionIds.includes(round.executionId) && !rounds.has(key)); rounds.add(key)
    }
  }
  ensure(source.observations && Object.keys(source.observations).sort().join() === ['insight/goal', 'worker-samples'].sort().join())
  for (const [key, observation] of Object.entries(source.observations)) if (observation !== null) {
    const parsed = parseLeadBudgetEvent(observation)
    ensure(parsed.type === 'observe' && parsed.source === key && parsed.now <= source.now && parsed.goalId === source.goalId &&
      parsed.executionIds.every(id => source.executionIds.includes(id)) && (parsed.usdMicros ?? 0) <= source.workerUsdMicros)
  }
  const validateObservation = (observation: Event<'observe'>) => {
    const parsed = parseLeadBudgetEvent(observation)
    ensure(parsed.type === 'observe' && parsed.now <= source.now && parsed.goalId === source.goalId &&
      parsed.executionIds.every(id => source.executionIds.includes(id)) && (parsed.usdMicros ?? 0) <= source.workerUsdMicros &&
      parsed.revision <= (source.observations[parsed.source]?.revision ?? 0))
  }
  ensure(Array.isArray(source.terminalObservations) && source.terminalObservations.length <= LEAD_LIMITS.rounds)
  ensure(new Set(terminalIds(source)).size === source.terminalObservations.length)
  for (const observation of source.terminalObservations) { validateObservation(observation); ensure(observation.terminal === true) }
  if (source.observation !== null) { validateObservation(source.observation); ensure(!source.observation.terminal) }
  ensure(observedCost(source) <= source.workerUsdMicros || source.spendOverflow)
  const rebuilt = finish(source)
  ensure(same(leadBudgetProjection(rebuilt, source.now), { version: source.version, revision: source.revision, caps: source.caps,
    leadUsdMicros: source.leadUsdMicros, workerUsdMicros: source.workerUsdMicros, reservedUsdMicros: source.reservedUsdMicros,
    roundsAdmitted: source.roundsAdmitted, spend: source.spend, stop: source.stop }))
  return structuredClone(source)
}

/** Release only an unproved placeholder; positive execution history is retained. */
export const releaseLeadStart = (state: LeadBudgetLedger, startId: string): LeadBudgetLedger => {
  const round = state.rounds.find(round => round.startId === startId)
  ensure(round)
  // Releasing an unresolved placeholder never releases rounds already proved to
  // have run. Their execution attribution and consumption outlive live evidence.
  if (round!.executionId !== null) return state
  return finish({ ...state, revision: nextLeadRevision(state.revision), rounds: state.rounds.filter(item => item !== round) })
}
