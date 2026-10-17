import {
  CLIENT_METHODS, CLIENT_ACTION_TIERS, clientTierFor, parseClientMessage,
  parseLeadAcceptanceContract, parseLeadBudgetState, parseLeadCard, parseLeadCardDecisionFor, parseLeadPermissionPolicy,
  type LeadAcceptanceContract, type LeadBudgetState, type LeadCard, type LeadPermissionPolicy,
  type LeadPermissionRule, type LeadPlanStep, type LeadProject, type ClientMethodName, type WireRequest,
} from '@harnessdesk/protocol'

export type LeadPermissionEffect = 'allow' | 'ask' | 'deny'
export type LeadPermissionFloor = 'irreversible' | 'worker-approval' | 'client-surface' | 'mode' | 'project' | 'run'
  | 'scope' | 'policy-interpretation' | 'unapproved' | 'consent' | 'budget' | 'start' | 'invalid-input'
export type LeadPermissionCall = Readonly<Pick<WireRequest<ClientMethodName>, 'method' | 'params'>>
export interface LeadPermissionDecision {
  /** Detached, frozen parser output. Dispatch only on allow, using this call, never the input. */
  readonly call: LeadPermissionCall | null
  readonly floor: LeadPermissionFloor | null
  readonly effect: LeadPermissionEffect
  readonly rule: { readonly layer: 'desk' | 'project'; readonly id: string } | null
  readonly reason: string
}
/** Target facts are resolved by the trusted host from the actual call, never supplied by
 * model text. In particular start is the host's frozen preview (including source revision,
 * resolved agents and grants), not a claim that raw source is safe. Step 8 rechecks at dispatch. */
export interface LeadPermissionRequest {
  readonly method: string
  readonly params: unknown
  readonly project: LeadProject | null
  readonly runId: string | null
  readonly start: LeadPlanStep | null
}
export interface LeadPermissionContext {
  readonly desk: LeadPermissionPolicy
  readonly projectPolicy: LeadPermissionPolicy | null
  readonly project: LeadProject | null
  readonly approved: {
    readonly contract: LeadAcceptanceContract
    /** Authenticated plan approval. Policy cards never mint plan consent. */
    readonly consent: { readonly contractDigest: string; readonly contractRevision: number; readonly policyRevision: number; readonly expiresAt: number }
    /** Host-owned membership; never infer it from a model-supplied run id. */
    readonly runIds: readonly string[]
    readonly teamIds: readonly string[]
  } | null
  readonly budget: LeadBudgetState | null
  readonly now: number
  /** Set before interpreting any user policy message; clear only after its result is durable. */
  readonly policyInterpretation: 'idle' | 'interpreting'
}
const rank: Readonly<Record<LeadPermissionEffect, number>> = { deny: 0, ask: 1, allow: 2 }
const decision = (effect: LeadPermissionEffect, reason: string, rule: LeadPermissionDecision['rule'] = null): LeadPermissionDecision => ({ effect, reason, rule, floor: null, call: null })
const deny = (reason: string, floor: LeadPermissionFloor): LeadPermissionDecision => ({ ...decision('deny', reason), floor })
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
// These two reads expose no project/run data. Collection reads must always be filtered.
const deskWideReads = new Set(['client/hello', 'library/usage'])
const actionOf = (method: string, params: unknown): string | null =>
  Object.hasOwn(CLIENT_ACTION_TIERS, method) && typeof record(params).action === 'string' ? record(params).action as string : null
// Canonical structural equality: property insertion order never changes authority.
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'object' && item !== null && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b)
const irreversible = (method: string, action: string | null): boolean =>
  [...method.split('/'), action ?? ''].some(word => ['merge', 'publish', 'delete', 'wrap'].includes(word.toLowerCase()))

/** Modes: plan permits reads only; default asks for unmatched management; manage
 * permits management only after the separate contract floors pass. A matching rule can
 * replace the default, but never plan's read ceiling. Within and across layers:
 * deny > ask > allow. A project's allow is therefore never a grant over the desk. */
const policyDecision = (policy: LeadPermissionPolicy, method: string, action: string | null, project: string | null,
  layer: 'desk' | 'project'): LeadPermissionDecision => {
  const tier = clientTierFor(method, action === null ? {} : { action })
  if (tier === null || tier === 'answer') return deny('Method or action exceeds the Lead run ceiling', 'client-surface')
  if (tier === 'run' && policy.mode === 'plan') return deny(`${layer} plan mode permits reads only`, 'mode')
  const matches = policy.rules.filter(rule => rule.method === method &&
    (rule.action === null || rule.action === action) && (rule.project === null || rule.project === project))
  const winning = matches.reduce<LeadPermissionRule | null>((winner, rule) =>
    winner === null || rank[rule.effect] < rank[winner.effect] ? rule : winner, null)
  if (winning) return decision(winning.effect, `${layer} rule ${winning.id}`, { layer, id: winning.id })
  return decision(tier === 'read' || policy.mode === 'manage' ? 'allow' : 'ask', `${layer} ${policy.mode} mode`)
}
const intersect = (desk: LeadPermissionPolicy, projectPolicy: LeadPermissionPolicy | null,
  method: string, action: string | null, project: string | null): LeadPermissionDecision => {
  const deskResult = policyDecision(desk, method, action, project, 'desk')
  if (projectPolicy === null) return deskResult
  const projectResult = policyDecision(projectPolicy, method, action, project, 'project')
  return rank[projectResult.effect] < rank[deskResult.effect] ? projectResult : deskResult
}

/** Pure admission only: no I/O, timers or clock reads; invalid snapshots fail closed.
 * Floors are deliberately outside the editable rule algebra and card approval path. */
const decideParsedPermission = (request: LeadPermissionRequest, context: LeadPermissionContext): LeadPermissionDecision => {
  try {
    const action = actionOf(request.method, request.params)
    const tier = clientTierFor(request.method, request.params)
    if (tier === null || tier === 'answer') return deny('Method or action exceeds the Lead run ceiling', 'client-surface')
    const desk = parseLeadPermissionPolicy(context.desk)
    const projectPolicy = context.projectPolicy === null ? null : parseLeadPermissionPolicy(context.projectPolicy)
    const contract = context.approved === null ? null : parseLeadAcceptanceContract(context.approved.contract)
    if (request.project !== null && (context.project === null || !same(request.project, context.project) ||
      (contract !== null && !same(request.project, contract.project)))) return deny('Project is outside the selected contract', 'project')
    const params = record(request.params)
    // A definition's path names a skill/bundle, never a project. With no cwd the
    // host confines a global definition to its agent-owned definition directories.
    const globalDefinition = request.method === 'library/definition' && params.cwd === undefined && request.project === null
    // Raw identifiers must agree with the host-resolved target. Other target forms (room,
    // goal, seat, subscription scope) require the host to resolve membership before calling.
    if (['root', 'path', 'project', 'run', 'goal', 'room', 'team', 'seat', 'scope', 'cwd', 'session', 'sessionId'].some(key => params[key] !== undefined && !(globalDefinition && key === 'path')) && request.project === null)
      return deny('Target requires host-resolved project membership', 'project')
    if ((['flow/catalog', 'flow/source', 'flow/preview', 'flow/start-goal', 'goal/list'].includes(request.method) &&
        params.root !== undefined && params.root !== request.project?.path) ||
      (request.method === 'workspace/open' && params.path !== request.project?.path) ||
      (request.method === 'flow/executions' && params.project !== undefined &&
        params.project !== request.project?.path))
      return deny('Call project differs from its resolved target', 'project')
    if (['library/read', 'library/definition'].includes(request.method) && params.cwd !== undefined && params.cwd !== request.project?.path) return deny('Call cwd differs from its resolved target', 'project')
    if (params.run !== undefined && params.run !== request.runId) return deny('Call run differs from its resolved target', 'run')
    const scope = record(params.scope)
    if ((scope.run !== undefined && scope.run !== request.runId) ||
      (scope.project !== undefined && scope.project !== request.project?.path))
      return deny('Subscription scope differs from its resolved target', 'scope')
    const team = request.method === 'flow/executions' ? params.team : request.method === 'client/subscribe' ? scope.team : undefined
    if (team !== undefined && (context.approved === null || !context.approved.teamIds.includes(team as string)))
      return deny('Team is outside the approved contract', 'scope')
    if (request.runId !== null && (context.approved === null || !context.approved.runIds.includes(request.runId)))
      return deny('Run is outside the approved contract', 'run')
    // Listings are scoped to the selected project; single-run reads to the approved contract, intentionally.
    if (request.method === 'flow/preview' && (params.retry !== undefined || params.continues !== undefined))
      return deny('Lead previews cannot retry or continue another run', 'scope')
    if (tier === 'read') {
      if (!deskWideReads.has(request.method) && !globalDefinition && request.project === null) return deny('Read requires a selected project target', 'project')
      if ((request.method === 'flow/executions' && params.project === undefined && params.team === undefined) ||
        (request.method === 'goal/list' && params.root === undefined) ||
        (request.method === 'client/subscribe' && scope.project === undefined &&
          scope.team === undefined && !(request.runId !== null && scope.run !== undefined)) ||
        (request.method === 'library/read' && params.cwd === undefined))
        return deny('Listing or subscription requires a selected project scope', 'scope')
      return intersect(desk, projectPolicy, request.method, action, request.project?.id ?? null)
    }
    if (context.policyInterpretation !== 'idle') return deny('Management paused while user policy text is interpreted', 'policy-interpretation')
    if (contract === null || context.approved === null || request.project === null || !same(contract.project, context.project))
      return deny('Management requires an approved contract and its project', 'unapproved')
    // Cancelling approved work narrows authority. Admission headroom and expiring plan
    // consent must never prevent it; scope, the interpretation pause and policy still apply.
    if (request.method === 'flow/execution/stop' || (request.method === 'team/intent' && action === 'abandon')) {
      if (request.runId === null) return deny('Cancellation requires membership in an approved run', 'run')
      return intersect(desk, projectPolicy, request.method, action, request.project.id)
    }
    const consent = context.approved.consent
    if (!Number.isSafeInteger(context.now) || context.now < 0 || !Number.isSafeInteger(consent.expiresAt) ||
      consent.expiresAt <= context.now || consent.contractDigest !== contract.digest || consent.contractRevision !== contract.revision ||
      consent.policyRevision !== contract.policyRevision || desk.revision < contract.policyRevision)
      return deny('Plan consent is stale or differs from the approved contract', 'consent')
    if (context.budget === null) return deny('Management requires known budget headroom', 'budget')
    const budget = parseLeadBudgetState(context.budget)
    if (budget.stop !== null || budget.spend !== 'known' ||
      request.method === 'flow/start-goal' && budget.roundsAdmitted >= budget.caps.rounds ||
      budget.leadUsdMicros + budget.workerUsdMicros + budget.reservedUsdMicros >= budget.caps.usdMicros)
      return deny('Budget is stopped, exhausted or unknown', 'budget')
    if (request.method === 'flow/start-goal') {
      const step = contract.steps.find(step => step.id === request.start?.id)
      if (!step || !same(step, request.start) || step.assignments.some(assignment => ['publish', 'merge'].includes(assignment.ceiling)))
        return deny('Start differs from the approved frozen step', 'start')
      const seats = Object.fromEntries(step.assignments.map(assignment => [assignment.role, [assignment.seat]]))
      if (params.root !== contract.project.path || params.sentence !== contract.goal || !same(params.vars ?? {}, step.variables) ||
        params.attended !== (step.attendance === 'attended') || !same(params.seats ?? {}, seats) ||
        params.continues != null || params.goal !== undefined)
        return deny('Start inputs, seats or attendance differ from the approved contract', 'start')
    } else if (request.method !== 'workspace/open' && request.runId === null) {
      return deny('Management requires membership in an approved run', 'run')
    }
    return intersect(desk, projectPolicy, request.method, action, request.project.id)
  } catch {
    return deny('Invalid permission input or contract snapshot', 'invalid-input')
  }
}

/** Freeze a detached graph, including open-shape extra fields, without touching caller data. */
const freezeSnapshot = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    for (const child of Object.values(value)) freezeSnapshot(child, seen)
    Object.freeze(value)
  }
  return value
}

export const decideLeadPermission = (request: LeadPermissionRequest, context: LeadPermissionContext): LeadPermissionDecision => {
  try {
    const method = request.method
    if (irreversible(method, null)) return deny('Merge, publish, delete and wrap require the person', 'irreversible')
    if (method.split('/').some(part => ['approval', 'approvals'].includes(part)))
      return deny('Worker approvals belong to the person', 'worker-approval')
    // Capture once, before validation: getters and later caller mutation cannot change
    // either the parser's input or the call eventually handed to the dispatcher.
    const captured = structuredClone(request.params)
    // Fixed refusals also catch attempted irreversible verbs in open-shape extra fields.
    // Only declared action-tier methods may use action to select an editable policy rule.
    const attemptedAction = record(captured).action
    if (irreversible('', typeof attemptedAction === 'string' ? attemptedAction : null))
      return deny('Merge, publish, delete and wrap require the person', 'irreversible')
    const tier = clientTierFor(method, captured)
    if (tier === null || tier === 'answer') return deny('Method or action exceeds the Lead run ceiling', 'client-surface')
    const parsed = parseClientMessage({ id: 1, method, params: captured })
    const call = freezeSnapshot({ method, params: parsed.params } as LeadPermissionCall)
    const result = decideParsedPermission({ method, params: call.params,
      project: request.project, runId: request.runId, start: request.start }, context)
    return { ...result, call: result.effect === 'deny' ? null : call }
  } catch {
    return deny('Invalid permission input or contract snapshot', 'invalid-input')
  }
}

export type LeadAuthorityChange = 'narrowing' | 'widening' | 'mixed' | 'unchanged'
/** Exact finite partition of rule predicates: each named action/project and one remainder
 * represent every possible match. Client eligibility is always delegated to clientTierFor.
 * Stored desk policy outlives any contract/project restrictions: neither may mask widening.
 * Transient budgets/consent do not erase potential policy authority during comparison. */
export const compareLeadPolicyAuthority = (old: LeadPermissionPolicy, proposed: LeadPermissionPolicy,
  projectPolicy: LeadPermissionPolicy | null = null, contract: LeadAcceptanceContract | null = null): LeadAuthorityChange => {
  const previous = parseLeadPermissionPolicy(old), next = parseLeadPermissionPolicy(proposed)
  const project = projectPolicy === null ? null : parseLeadPermissionPolicy(projectPolicy)
  const approved = contract === null ? null : parseLeadAcceptanceContract(contract)
  const rules = [...previous.rules, ...next.rules, ...(project?.rules ?? [])]
  let other = 'other'
  while (rules.some(rule => rule.project === other || rule.action === other)) other += '.'
  const projects = new Set([null, other, ...(approved ? [approved.project.id] : []),
    ...rules.flatMap(rule => rule.project === null ? [] : [rule.project])])
  let wider = false, narrower = false
  for (const method of Object.keys(CLIENT_METHODS)) {
    const actionTiers = record(CLIENT_ACTION_TIERS)[method]
    const actions = new Set<string | null>(actionTiers === undefined ? [null] : [null, other, ...Object.keys(record(actionTiers)),
      ...rules.filter(rule => rule.method === method).flatMap(rule => rule.action === null ? [] : [rule.action])])
    for (const action of actions) {
      const tier = clientTierFor(method, action === null ? {} : { action })
      if (tier === null || tier === 'answer' || irreversible(method, action)) continue
      for (const projectId of projects) {
        const before = policyDecision(previous, method, action, projectId, 'desk').effect
        const after = policyDecision(next, method, action, projectId, 'desk').effect
        wider ||= rank[after] > rank[before]
        narrower ||= rank[after] < rank[before]
      }
    }
  }
  return wider && narrower ? 'mixed' : wider ? 'widening' : narrower ? 'narrowing' : 'unchanged'
}

type PermissionCard = Extract<LeadCard, { type: 'permission-change' }>
export interface LeadPolicyProposal {
  readonly current: LeadPermissionPolicy
  readonly proposed: LeadPermissionPolicy
  readonly projectPolicy: LeadPermissionPolicy | null
  readonly contract: LeadAcceptanceContract | null
  readonly source: 'user-text' | 'model'
  readonly ambiguous: boolean
  readonly cardId: string
  readonly cardRevision: number
}
export interface LeadPolicyChange {
  readonly kind: 'apply' | 'card' | 'unchanged'
  readonly comparison: LeadAuthorityChange
  readonly policy: LeadPermissionPolicy
  readonly card: PermissionCard | null
}
/** Interpret text elsewhere while dispatch is paused. Ambiguity preserves the current
 * policy; only proven narrowing from user text takes effect without a window click. */
export const proposeLeadPolicyChange = (input: LeadPolicyProposal): LeadPolicyChange => {
  const current = parseLeadPermissionPolicy(input.current), proposed = parseLeadPermissionPolicy(input.proposed)
  if (proposed.revision <= current.revision) throw new Error('Policy proposal must advance its revision')
  const comparison = compareLeadPolicyAuthority(current, proposed, input.projectPolicy, input.contract)
  if (input.ambiguous) return { kind: 'unchanged', comparison, policy: current, card: null }
  if (comparison === 'narrowing' && input.source === 'user-text') return { kind: 'apply', comparison, policy: proposed, card: null }
  if (comparison === 'unchanged') return { kind: 'unchanged', comparison, policy: current, card: null }
  const card = parseLeadCard({ version: 1, id: input.cardId, revision: input.cardRevision, type: 'permission-change',
    contractDigest: input.contract?.digest ?? null, previous: current, proposed }) as PermissionCard
  return { kind: 'card', comparison, policy: current, card }
}
/** The caller supplies the live immutable card and authenticated window decision. This
 * changes policy only; no fixed floor, contract, budget or plan consent is changed. */
export const applyLeadPolicyDecision = (value: unknown, liveCard: unknown, current: LeadPermissionPolicy,
  liveContractDigest: string | null): LeadPermissionPolicy => {
  const parsed = parseLeadCardDecisionFor(value, liveCard)
  const card = parseLeadCard(liveCard)
  const policy = parseLeadPermissionPolicy(current)
  if (card.type !== 'permission-change' || card.contractDigest !== liveContractDigest || !same(card.previous, policy))
    throw new Error('Policy decision no longer matches the live policy and contract')
  return parsed.choice === 'approve' ? card.proposed : policy
}
