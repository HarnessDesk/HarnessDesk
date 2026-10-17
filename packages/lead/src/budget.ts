import { LEAD_LIMITS, nextLeadRevision, parseLeadBudgetEvent, parseLeadBudgetState, parseLeadCardDecisionFor,
  type LeadBudgetEvent, type LeadBudgetState, type LeadCard, type LeadCardDecision } from '@harnessdesk/protocol'

type Event<T extends LeadBudgetEvent['type']> = Extract<LeadBudgetEvent, { type: T }>
interface Request {
  readonly reservation: Event<'reserve'>; readonly settlement: Event<'settle'> | null; readonly uncertain: boolean
}
/** Retained identities survive checkpointing. At the bound, refuse admission rather than
 * evicting deduplication evidence and permitting a paid request to be counted twice. */
export interface LeadBudgetLedger extends LeadBudgetState {
  readonly logicalGoalId: string; readonly goalId: string | null; readonly executionIds: readonly string[]
  readonly now: number; readonly freshnessMs: number
  readonly requests: readonly Request[]
  readonly rounds: readonly { readonly executionId: string; readonly roundId: string }[]
  readonly observations: Readonly<Record<'insight/goal' | 'worker-samples', Event<'observe'> | null>>
  readonly observation: Event<'observe'> | null
}
const ensure = (condition: unknown): void => { if (!condition) throw new Error('lead-budget-refused') }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const cost = (tokens: number, rate: number): number => {
  const value = (BigInt(tokens) * BigInt(rate) + 999_999n) / 1_000_000n
  ensure(value <= BigInt(LEAD_LIMITS.maxUsdMicros))
  return Number(value)
}
const charge = (request: Request): number => {
  const reserve = request.reservation, usage = request.settlement
  return cost(usage?.inputTokens ?? reserve.inputTokens, reserve.inputUsdMicrosPerMillion) +
    cost(usage?.outputTokens ?? reserve.maxOutputTokens, reserve.outputUsdMicrosPerMillion)
}
const covers = (state: LeadBudgetLedger, observation: Event<'observe'>) => observation.executionIds.length === state.executionIds.length &&
  state.executionIds.every(id => observation.executionIds.includes(id))
/** Read-only projection takes time explicitly. Unknown, partial or stale attribution
 * never replaces a cumulative charge with zero. The Lead stops when reported spend reaches the cap. */
export const leadBudgetProjection = (state: LeadBudgetLedger, now: number): LeadBudgetState => {
  ensure(Number.isSafeInteger(now) && now >= state.now)
  const observed = state.observation
  let spend: LeadBudgetState['spend'] = state.executionIds.length === 0 ? 'known' : 'unknown'
  if (observed) {
    spend = observed.quality
    if (!covers(state, observed)) spend = 'partial'
    else if (now - observed.at > state.freshnessMs) spend = 'stale'
    else if (observed.usdMicros !== null && observed.usdMicros < state.workerUsdMicros) spend = 'ambiguous'
  }
  if (state.requests.some(request => request.uncertain && request.settlement === null)) spend = 'unknown'
  return parseLeadBudgetState({ version: 1, revision: state.revision, caps: state.caps, leadUsdMicros: state.leadUsdMicros,
    workerUsdMicros: state.workerUsdMicros, reservedUsdMicros: state.reservedUsdMicros, roundsAdmitted: state.rounds.length, spend, stop: state.stop })
}
const finish = (state: LeadBudgetLedger): LeadBudgetLedger => {
  let leadUsdMicros = 0, reservedUsdMicros = 0
  for (const request of state.requests) {
    if (request.settlement) leadUsdMicros += charge(request)
    else reservedUsdMicros += charge(request)
  }
  const total = leadUsdMicros + state.workerUsdMicros
  const reason = total >= state.caps.usdMicros || total + reservedUsdMicros > state.caps.usdMicros ? 'budget' :
    state.rounds.length >= state.caps.rounds ? 'rounds' : null
  const stop = state.stop ?? (reason ? { reason, revision: state.revision } : null)
  const next = { ...state, leadUsdMicros, reservedUsdMicros, roundsAdmitted: state.rounds.length, stop }
  return { ...next, ...leadBudgetProjection(next, state.now) }
}
const admit = (state: LeadBudgetLedger, now: number): void => {
  const view = leadBudgetProjection(state, now)
  ensure(view.stop === null && view.spend === 'known' && view.roundsAdmitted < view.caps.rounds &&
    view.leadUsdMicros + view.workerUsdMicros + view.reservedUsdMicros < view.caps.usdMicros)
}
/** Pure state transition; only journal admission may turn its result into an effect. */
export const reduceLeadBudget = (previous: LeadBudgetLedger | null, value: unknown): LeadBudgetLedger => {
  const event = parseLeadBudgetEvent(value)
  if (event.type === 'initialize') {
    ensure(previous === null)
    return finish({ version: 1, revision: 1, logicalGoalId: event.logicalGoalId, caps: event.caps, freshnessMs: event.freshnessMs,
      now: event.now, goalId: null, executionIds: [], requests: [], rounds: [], observations: { 'insight/goal': null, 'worker-samples': null },
      observation: null, leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known', stop: null })
  }
  ensure(previous !== null)
  const state = previous!
  ensure(event.now >= state.now)
  let next = { ...state, revision: nextLeadRevision(state.revision), now: event.now }
  switch (event.type) {
    case 'bind':
      ensure(state.goalId === null || state.goalId === event.goalId)
      if (state.executionIds.includes(event.executionId)) return state
      ensure(state.executionIds.length < LEAD_LIMITS.rounds)
      next = { ...next, goalId: event.goalId, executionIds: [...state.executionIds, event.executionId] }; break
    case 'reserve': {
      admit(state, event.now)
      ensure(state.requests.length < 4096 && !state.requests.some(request => request.reservation.requestId === event.requestId))
      const request = { reservation: event, settlement: null, uncertain: false }
      ensure(state.leadUsdMicros + state.workerUsdMicros + state.reservedUsdMicros + charge(request) <= state.caps.usdMicros)
      next = { ...next, requests: [...state.requests, request] }; break
    }
    case 'settle': case 'uncertain': {
      const index = state.requests.findIndex(request => request.reservation.requestId === event.requestId)
      ensure(index !== -1)
      const request = state.requests[index]!
      if (event.type === 'settle') {
        ensure(event.inputTokens <= request.reservation.inputTokens && event.outputTokens <= request.reservation.maxOutputTokens)
        if (request.settlement) { ensure(same({ ...request.settlement, now: event.now }, event)); return state }
      } else { ensure(request.settlement === null); if (request.uncertain) return state }
      next = { ...next, requests: state.requests.map((item, i) => i !== index ? item : event.type === 'settle'
        ? { ...item, settlement: event, uncertain: false } : { ...item, uncertain: true }) }; break
    }
    case 'observe': {
      ensure(state.goalId === event.goalId && event.executionIds.every(id => state.executionIds.includes(id)))
      const prior = state.observations[event.source]
      if (prior && event.revision === prior.revision) { ensure(same({ ...prior, now: event.now }, event)); return state }
      ensure((!prior || event.revision > prior.revision) && (!state.observation || event.at >= state.observation.at))
      next = { ...next, observations: { ...state.observations, [event.source]: event }, observation: event,
        workerUsdMicros: Math.max(state.workerUsdMicros, event.usdMicros ?? 0) }; break
    }
    case 'round':
      ensure(state.executionIds.includes(event.executionId))
      if (state.rounds.some(round => round.executionId === event.executionId && round.roundId === event.roundId)) return state
      admit(state, event.now)
      ensure(state.rounds.length < LEAD_LIMITS.rounds)
      next = { ...next, rounds: [...state.rounds, { executionId: event.executionId, roundId: event.roundId }] }; break
    case 'tighten':
      ensure(event.caps.usdMicros <= state.caps.usdMicros && event.caps.rounds <= state.caps.rounds)
      next = { ...next, caps: event.caps }; break
    case 'stop': next = { ...next, stop: state.stop ?? { reason: event.reason, revision: next.revision } }; break
  }
  return finish(next)
}
/** Only a revision-bound window click can widen allowances; it cannot clear a stop. */
export const applyLeadBudgetCard = (state: LeadBudgetLedger, decision: LeadCardDecision, card: LeadCard): LeadBudgetLedger => {
  const click = parseLeadCardDecisionFor(decision, card)
  ensure(card.type === 'budget-change')
  if (card.type !== 'budget-change' || click.choice === 'decline') return state
  ensure(card.logicalGoalId === state.logicalGoalId && card.previous.revision === state.revision && same(card.previous.caps, state.caps))
  return finish({ ...state, revision: nextLeadRevision(state.revision), caps: card.proposed })
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
  ensure(Array.isArray(source.requests) && source.requests.length <= 4096)
  const ids = new Set<string>()
  for (const request of source.requests) {
    ensure(request && Object.keys(request).sort().join() === ['reservation', 'settlement', 'uncertain'].sort().join() && typeof request.uncertain === 'boolean')
    ensure(parseLeadBudgetEvent(request.reservation).type === 'reserve' && request.reservation.now <= source.now && !ids.has(request.reservation.requestId))
    ids.add(request.reservation.requestId)
    if (request.settlement) {
      const usage = parseLeadBudgetEvent(request.settlement)
      ensure(usage.type === 'settle' && usage.requestId === request.reservation.requestId && usage.now <= source.now &&
        usage.now >= request.reservation.now && usage.inputTokens <= request.reservation.inputTokens && usage.outputTokens <= request.reservation.maxOutputTokens && !request.uncertain)
    }
  }
  ensure(Array.isArray(source.rounds) && source.rounds.length <= LEAD_LIMITS.rounds)
  const rounds = new Set<string>()
  for (const round of source.rounds) {
    ensure(round && Object.keys(round).sort().join() === ['executionId', 'roundId'].sort().join())
    parseLeadBudgetEvent({ version: 1, type: 'round', now: source.now, ...round })
    const key = JSON.stringify([round.executionId, round.roundId])
    ensure(source.executionIds.includes(round.executionId) && !rounds.has(key)); rounds.add(key)
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
