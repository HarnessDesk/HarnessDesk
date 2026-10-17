import { LEAD_LIMITS, nextLeadRevision, parseLeadBudgetEvent, parseLeadBudgetState, parseLeadCardDecisionFor,
  type LeadBudgetEvent, type LeadBudgetState, type LeadCard, type LeadCardDecision } from '@harnessdesk/protocol'

type Event<T extends LeadBudgetEvent['type']> = Extract<LeadBudgetEvent, { type: T }>
interface Request { readonly reservation: Event<'reserve'>; readonly uncertain: boolean }
interface Settled { readonly id: string; readonly digest: string; readonly usdMicros: number }
/** Active requests retain reservations; settled requests retain only compact identity,
 * charge and collision-free usage digests. Neither index is evicted during checkpointing. */
export interface LeadBudgetLedger extends LeadBudgetState {
  readonly logicalGoalId: string; readonly goalId: string | null; readonly executionIds: readonly string[]
  readonly now: number; readonly freshnessMs: number
  readonly capsRevision: number
  /** A reported charge exceeded the portable protocol range; never infer headroom from its saturated total. */
  readonly spendOverflow: boolean
  readonly requests: readonly Request[]
  readonly settled: readonly Settled[]
  readonly rounds: readonly { readonly executionId: string | null; readonly roundId: string | null; readonly startId: string | null }[]
  readonly observations: Readonly<Record<'insight/goal' | 'worker-samples', Event<'observe'> | null>>
  readonly observation: Event<'observe'> | null
}
const ensure = (condition: unknown): void => { if (!condition) throw new Error('lead-budget-refused') }
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
const covers = (state: LeadBudgetLedger, observation: Event<'observe'>) => observation.executionIds.length === state.executionIds.length &&
  state.executionIds.every(id => observation.executionIds.includes(id))
/** Read-only projection takes time explicitly. Unknown, partial or stale attribution
 * never replaces a cumulative charge with zero. The Lead stops when reported spend reaches the cap. */
export const leadBudgetProjection = (state: LeadBudgetLedger, now: number): LeadBudgetState => {
  ensure(Number.isSafeInteger(now) && now >= 0)
  now = Math.max(now, state.now)
  const observed = state.observation
  let spend: LeadBudgetState['spend'] = state.executionIds.length === 0 ? 'known' : 'unknown'
  if (observed) {
    spend = observed.quality
    if (!covers(state, observed)) spend = 'partial'
    else if (now - observed.at > state.freshnessMs) spend = 'stale'
    else if (observed.usdMicros !== null && observed.usdMicros < state.workerUsdMicros) spend = 'ambiguous'
  }
  if (state.spendOverflow || state.requests.some(request => request.uncertain) || state.rounds.some(round => round.startId !== null && round.executionId === null)) spend = 'unknown'
  return parseLeadBudgetState({ version: 1, revision: state.revision, caps: state.caps, leadUsdMicros: state.leadUsdMicros,
    workerUsdMicros: state.workerUsdMicros, reservedUsdMicros: state.reservedUsdMicros, roundsAdmitted: state.rounds.length, spend, stop: state.stop })
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
      now: event.now, goalId: null, executionIds: [], capsRevision: 1, spendOverflow: false, requests: [], settled: [], rounds: [], observations: { 'insight/goal': null, 'worker-samples': null },
      observation: null, leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known', stop: null })
  }
  ensure(previous !== null)
  const state = previous!
  const now = Math.max(state.now, event.now)
  const duplicate = () => finish({ ...state, now })
  let next = { ...state, revision: nextLeadRevision(state.revision), now }
  switch (event.type) {
    case 'bind': {
      ensure(state.goalId === null || state.goalId === event.goalId)
      let rounds = state.rounds
      if (event.startId) {
        const started = state.rounds.find(round => round.startId === event.startId)
        ensure(started && (started.executionId === null || started.executionId === event.executionId))
        ensure(!event.firstRoundId || started!.roundId === null || started!.roundId === event.firstRoundId)
        ensure(!event.firstRoundId || !state.rounds.some(round => round !== started && round.executionId === event.executionId && round.roundId === event.firstRoundId))
        // The host binds the already admitted first round explicitly. Reporting
        // some other round first cannot rename this placeholder or bypass admission.
        rounds = state.rounds.map(round => round === started ? { ...round, executionId: event.executionId,
          roundId: event.firstRoundId ?? round.roundId } : round)
      }
      if (state.executionIds.includes(event.executionId) && same(rounds, state.rounds)) return duplicate()
      ensure(state.executionIds.includes(event.executionId) || state.executionIds.length < LEAD_LIMITS.rounds)
      next = { ...next, rounds, goalId: event.goalId, executionIds: [...new Set([...state.executionIds, event.executionId])] }; break
    }
    case 'reserve': {
      admit(state, now)
      ensure(state.requests.length < 4096 && !state.requests.some(request => request.reservation.requestId === event.requestId) && !state.settled.some(item => item.id === event.requestId))
      const request = { reservation: event, uncertain: false }
      ensure(state.leadUsdMicros + state.workerUsdMicros + state.reservedUsdMicros + charge(event, null) <= state.caps.usdMicros)
      next = { ...next, requests: [...state.requests, request] }; break
    }
    case 'settle': case 'uncertain': {
      const settled = state.settled.find(item => item.id === event.requestId)
      if (settled) { ensure(event.type === 'settle' && settled.digest === usageDigest(event)); return duplicate() }
      const request = state.requests.find(request => request.reservation.requestId === event.requestId)
      ensure(request)
      if (event.type === 'settle') {
        const actual = charge(request!.reservation, event)
        next = { ...next, requests: state.requests.filter(item => item !== request),
          spendOverflow: state.spendOverflow || actual > LEAD_LIMITS.maxUsdMicros,
          settled: [...state.settled, { id: event.requestId, digest: usageDigest(event), usdMicros: Math.min(LEAD_LIMITS.maxUsdMicros, actual) }] }
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
      ensure((!prior || event.revision > prior.revision) && (!state.observation || event.at >= state.observation.at))
      next = { ...next, observations: { ...state.observations, [event.source]: event }, observation: event,
        workerUsdMicros: Math.max(state.workerUsdMicros, event.usdMicros ?? 0) }; break
    }
    case 'start':
      if (state.rounds.some(round => round.startId === event.startId)) return duplicate()
      admit(state, now, true)
      next = { ...next, rounds: [...state.rounds, { executionId: null, roundId: null, startId: event.startId }] }; break
    case 'round': {
      ensure(state.executionIds.includes(event.executionId))
      if (state.rounds.some(round => round.executionId === event.executionId && round.roundId === event.roundId)) return duplicate()
      admit(state, now, true)
      ensure(state.rounds.length < LEAD_LIMITS.rounds)
      next = { ...next, rounds: [...state.rounds, { executionId: event.executionId, roundId: event.roundId, startId: null }] }; break
    }
    case 'tighten':
      ensure(event.caps.usdMicros <= state.caps.usdMicros && event.caps.rounds <= state.caps.rounds)
      return applyLeadBudgetCaps({ ...state, now }, event.caps)
    case 'stop': next = { ...next, stop: state.stop ?? { reason: event.reason, revision: next.revision } }; break
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
  ensure(typeof source.spendOverflow === 'boolean')
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
    ensure(!ids.has(item.id) && typeof item.digest === 'string' && /^(?:[0-9a-z]{1,6}\.){3}[0-9a-z]{1,6}$/.test(item.digest))
    ensure(Number.isSafeInteger(item.usdMicros) && item.usdMicros >= 0 && item.usdMicros <= LEAD_LIMITS.maxUsdMicros)
    ids.add(item.id)
  }
  ensure(Array.isArray(source.rounds) && source.rounds.length <= LEAD_LIMITS.rounds)
  const rounds = new Set<string>(), starts = new Set<string>()
  for (const round of source.rounds) {
    ensure(round && Object.keys(round).sort().join() === ['executionId', 'roundId', 'startId'].sort().join())
    if (round.startId !== null) {
      parseLeadBudgetEvent({ version: 1, type: 'start', now: source.now, startId: round.startId })
      ensure(!starts.has(round.startId)); starts.add(round.startId)
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
  ensure(source.observation === null || same(source.observation, source.observations[source.observation.source]))
  const rebuilt = finish(source)
  ensure(same(leadBudgetProjection(rebuilt, source.now), { version: source.version, revision: source.revision, caps: source.caps,
    leadUsdMicros: source.leadUsdMicros, workerUsdMicros: source.workerUsdMicros, reservedUsdMicros: source.reservedUsdMicros,
    roundsAdmitted: source.roundsAdmitted, spend: source.spend, stop: source.stop }))
  return structuredClone(source)
}

/** Only proof that a start created nothing may release its admitted round. */
export const releaseLeadStart = (state: LeadBudgetLedger, startId: string): LeadBudgetLedger => {
  const round = state.rounds.find(round => round.startId === startId)
  ensure(round && round.executionId === null)
  return finish({ ...state, revision: nextLeadRevision(state.revision), rounds: state.rounds.filter(item => item !== round) })
}
