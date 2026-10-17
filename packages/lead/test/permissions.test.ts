import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLeadAcceptanceContract, parseLeadBudgetState, parseLeadPermissionPolicy, type LeadPermissionPolicy } from '@harnessdesk/protocol'
import * as lead from '../src/index.js'

const contract = parseLeadAcceptanceContract({
  version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Repair the check',
  project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
  steps: [{ id: 'implement', title: 'Implement and review', flow: 'lead-reviewed-result', sourceRevision: 'source-1',
    variables: { task: 'Repair the check' }, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture', model: 'vendor/model' }, ceiling: 'edit' }] }],
  assertions: [{ id: 'tests', kind: 'check', description: 'Required checks pass' }], caps: { usdMicros: 500, rounds: 3 },
})
const policy = (mode: LeadPermissionPolicy['mode'] = 'manage', rules: LeadPermissionPolicy['rules'] = [], revision = 1) =>
  parseLeadPermissionPolicy({ version: 1, revision, mode, rules })
const rule = (effect: 'allow' | 'ask' | 'deny', id: string = effect) => ({ id, effect, method: 'flow/execution/stop' as const, action: null, project: null })
// Dynamic export lookup makes the first red assertion describe the missing behavior.
const decide = (request: unknown, context: unknown): { effect: string; rule: unknown; reason: string } => {
  const fn = (lead as Record<string, unknown>).decideLeadPermission
  assert.equal(typeof fn, 'function', 'decideLeadPermission must enforce the desk deny before a project allow')
  return (fn as (r: unknown, c: unknown) => ReturnType<typeof decide>)(request, context)
}
const context = () => ({
  desk: policy(), projectPolicy: null as LeadPermissionPolicy | null, project: contract.project,
  approved: { contract, consent: { contractDigest: contract.digest, contractRevision: 1, policyRevision: 1, expiresAt: 200 }, runIds: ['run-1'] },
  budget: parseLeadBudgetState({ version: 1, revision: 1, caps: contract.caps, leadUsdMicros: 10,
    workerUsdMicros: 20, reservedUsdMicros: 0, roundsAdmitted: 1, spend: 'known', stop: null }),
  now: 100, policyInterpretation: 'idle',
})
const request = () => ({ method: 'flow/execution/stop', params: { run: 'run-1', reason: 'Stop work' },
  project: contract.project, runId: 'run-1', start: null })

test('a project allow cannot override a desk deny', () => {
  const c = { ...context(), desk: policy('manage', [rule('deny')]), projectPolicy: policy('manage', [rule('allow')]) }
  assert.equal(decide(request(), c).effect, 'deny')
})

const compare = (current: LeadPermissionPolicy, proposed: LeadPermissionPolicy, projectPolicy: LeadPermissionPolicy | null = null) => {
  const fn = (lead as Record<string, unknown>).compareLeadPolicyAuthority
  assert.equal(typeof fn, 'function')
  return (fn as (...args: unknown[]) => string)(current, proposed, projectPolicy, contract)
}
const change = (current: LeadPermissionPolicy, proposed: LeadPermissionPolicy, extra = {}) => {
  const fn = (lead as Record<string, unknown>).proposeLeadPolicyChange
  assert.equal(typeof fn, 'function')
  return (fn as (input: unknown) => { kind: string; policy: LeadPermissionPolicy; card: unknown; comparison: string })({
    current, proposed, projectPolicy: null, contract, source: 'user-text', ambiguous: false,
    cardId: 'permission-1', cardRevision: 4, ...extra,
  })
}
const approve = (card: unknown, current: LeadPermissionPolicy, extra = {}) => {
  const fn = (lead as Record<string, unknown>).applyLeadPolicyDecision
  assert.equal(typeof fn, 'function')
  return (fn as (...args: unknown[]) => LeadPermissionPolicy)({ version: 1, cardId: 'permission-1',
    cardType: 'permission-change', expectedRevision: 4, contractDigest: contract.digest, choice: 'approve', ...extra },
  card, current, contract.digest)
}

test('deny beats ask beats allow across both policy layers, independent of order', () => {
  for (const rules of [[rule('allow'), rule('ask'), rule('deny')], [rule('deny'), rule('ask'), rule('allow')]]) {
    const result = decide(request(), { ...context(), desk: policy('manage', rules) })
    assert.equal(result.effect, 'deny'); assert.deepEqual(result.rule, { layer: 'desk', id: 'deny' })
  }
  assert.equal(decide(request(), { ...context(), projectPolicy: policy('manage', [rule('ask')]) }).effect, 'ask')
  assert.equal(decide(request(), { ...context(), desk: policy('default'), projectPolicy: policy('manage', [rule('allow')]) }).effect, 'ask')
})

test('modes are reads only, ask for unmatched management, and manage within approval', () => {
  for (const [mode, effect] of [['plan', 'deny'], ['default', 'ask'], ['manage', 'allow']] as const) {
    assert.equal(decide(request(), { ...context(), desk: policy(mode) }).effect, effect)
    assert.equal(decide({ ...request(), method: 'library/usage', params: {}, project: null, runId: null },
      { ...context(), desk: policy(mode), approved: null, budget: null }).effect, 'allow')
  }
  assert.equal(decide(request(), { ...context(), desk: policy('plan', [rule('allow')]) }).effect, 'deny')
  assert.equal(decide(request(), { ...context(), desk: policy('default', [rule('allow')]) }).effect, 'allow')
})

test('exact action/project matching never grants a different operation', () => {
  const scoped = { ...rule('deny'), project: 'other', action: null }
  assert.equal(decide(request(), { ...context(), desk: policy('manage', [scoped]) }).effect, 'allow')
  assert.equal(decide(request(), { ...context(), desk: policy('manage', [{ ...scoped, project: contract.project.id }]) }).effect, 'deny')
  const actionRule = { ...rule('deny'), method: 'team/intent' as const, action: 'abandon' }
  assert.equal(decide({ ...request(), method: 'team/intent', params: { room: 'room-1', id: 1, action: 'abandon' } },
    { ...context(), desk: policy('manage', [actionRule]) }).effect, 'deny')
})

test('every immutable floor survives project allow, manage mode and an approved widening card', () => {
  const old = policy('plan')
  const proposed = policy('manage', [], 2)
  const approved = approve(change(old, proposed).card, old)
  const wideningPaths = [
    { ...context(), projectPolicy: policy('manage', [rule('allow')]) },
    context(), { ...context(), desk: approved },
  ]
  const cases = [
    { label: 'merge', request: { ...request(), method: 'git/merge', params: {} } },
    { label: 'publish', request: { ...request(), params: { run: 'run-1', action: 'publish' } } },
    { label: 'delete', request: { ...request(), params: { run: 'run-1', action: 'delete' } } },
    { label: 'worker approval', request: { ...request(), method: 'approval/respond', params: { choice: 'approve' } } },
    { label: 'off surface', request: { ...request(), method: 'session/send', params: {} } },
    { label: 'answer tier', request: { ...request(), method: 'team/intent', params: { room: 'room-1', id: 1, action: 'done' } } },
    { label: 'unknown action', request: { ...request(), method: 'team/intent', params: { action: 'other' } } },
    { label: 'unapproved', context: { approved: null } },
    { label: 'unrelated project', request: { ...request(), project: { id: 'other', path: '/workspace/other' } } },
    { label: 'unrelated run', request: { ...request(), runId: 'run-other', params: { run: 'run-other' } } },
    { label: 'disguised run', request: { ...request(), params: { run: 'run-other' } } },
    { label: 'stale consent', context: { now: 200 } },
    { label: 'changed contract', context: { approved: { ...context().approved, consent: { ...context().approved.consent, contractRevision: 0 } } } },
    { label: 'stale digest', context: { approved: { ...context().approved, consent: { ...context().approved.consent, contractDigest: 'b'.repeat(64) } } } },
    { label: 'stale policy consent', context: { approved: { ...context().approved, consent: { ...context().approved.consent, policyRevision: 0 } } } },
    { label: 'caps', context: { budget: { ...context().budget, leadUsdMicros: 500, stop: { reason: 'budget', revision: 1 } } } },
    { label: 'rounds', context: { budget: { ...context().budget, roundsAdmitted: 3 } } },
    { label: 'unknown spend', context: { budget: { ...context().budget, spend: 'unknown' } } },
    { label: 'stale spend', context: { budget: { ...context().budget, spend: 'stale' } } },
    { label: 'partial spend', context: { budget: { ...context().budget, spend: 'partial' } } },
    { label: 'missing budget', context: { budget: null } },
    { label: 'policy interpretation', context: { policyInterpretation: 'interpreting' } },
  ]
  for (const c of wideningPaths) for (const item of cases) {
    const result = decide(item.request ?? request(), { ...c, ...item.context })
    assert.equal(result.effect, 'deny', item.label)
    assert.ok(result.reason.length > 0, item.label)
    assert.equal(result.rule, null, item.label)
  }
  for (const c of wideningPaths)
    assert.equal(decide(startRequest(), { ...c, approved: null }).effect, 'deny', 'unapproved start')
})

const startRequest = () => ({ ...request(), method: 'flow/start-goal', runId: null, start: contract.steps[0],
  params: { root: contract.project.path, source: 'synthetic reviewed recipe', token: 'preview-1', sentence: contract.goal,
    vars: contract.steps[0]!.variables, attended: true, seats: { implement: [contract.steps[0]!.assignments[0]!.seat] } } })

test('start admission matches the frozen step, inputs, seats, attendance and project', () => {
  assert.equal(decide(startRequest(), context()).effect, 'allow')
  for (const start of [null, { ...contract.steps[0], sourceRevision: 'source-other' },
    { ...contract.steps[0], assignments: [{ ...contract.steps[0]!.assignments[0], ceiling: 'merge' }] }])
    assert.equal(decide({ ...startRequest(), start }, context()).effect, 'deny')
  for (const patch of [{ root: '/workspace/other' }, { sentence: 'Other task' }, { vars: { task: 'Other task' } },
    { seats: { implement: [{ runtime: 'other' }] } }, { attended: false }, { continues: 'run-other' }, { goal: { id: 'other', revision: 1 } }])
    assert.equal(decide({ ...startRequest(), params: { ...startRequest().params, ...patch } }, context()).effect, 'deny')
  assert.equal(decide({ ...request(), method: 'workspace/open', params: { path: '/workspace/other' }, runId: null }, context()).effect, 'deny')
})

test('interpreting user policy text pauses management but permits reads', () => {
  assert.equal(decide(request(), { ...context(), policyInterpretation: 'interpreting' }).effect, 'deny')
  assert.equal(decide({ ...request(), method: 'library/usage', params: {}, project: null, runId: null },
    { ...context(), policyInterpretation: 'interpreting' }).effect, 'allow')
})

test('authority comparison detects effective narrowing, widening, mixed and unchanged', () => {
  assert.equal(compare(policy('manage'), policy('default', [], 2)), 'narrowing')
  assert.equal(compare(policy('plan'), policy('manage', [], 2)), 'widening')
  const old = policy('manage', [rule('deny')])
  const next = policy('manage', [{ ...rule('deny'), method: 'workspace/open' }], 2)
  assert.equal(compare(old, next), 'mixed')
  assert.equal(compare(policy('manage'), policy('manage', [{ ...rule('deny'), project: 'unrelated' }], 2)), 'unchanged')
  assert.equal(compare(policy('plan'), policy('manage', [], 2), policy('plan')), 'unchanged')
  assert.equal(compare(policy('manage', [rule('deny'), rule('allow')]), policy('manage', [rule('deny')], 2)), 'unchanged')
  assert.equal(compare(policy('default', [{ ...rule('deny'), method: 'team/intent', action: 'done' }]), policy('default', [], 2)), 'unchanged')
})

test('only proven user-text narrowing applies immediately; widening and mixed need a card', () => {
  const current = policy('manage')
  const narrow = policy('default', [], 2)
  const result = change(current, narrow)
  assert.equal(result.kind, 'apply'); assert.deepEqual(result.policy, narrow); assert.equal(result.card, null)
  assert.equal(change(current, narrow, { source: 'model' }).kind, 'card')
  assert.equal(change(current, narrow, { ambiguous: true }).kind, 'unchanged')
  const widen = change(policy('plan'), policy('manage', [], 2))
  assert.equal(widen.kind, 'card'); assert.deepEqual(widen.policy, policy('plan'))
  assert.equal(change(policy('manage', [rule('deny')]), policy('manage', [{ ...rule('deny'), method: 'workspace/open' }], 2)).kind, 'card')
  assert.equal(change(policy('plan'), policy('manage', [], 2), { ambiguous: true }).kind, 'unchanged')
})

test('policy clicks bind the current policy pair, live card revision and contract digest', () => {
  const old = policy('plan'), next = policy('manage', [], 2)
  const proposal = change(old, next)
  assert.deepEqual(approve(proposal.card, old), next)
  assert.deepEqual(approve(proposal.card, old, { choice: 'decline' }), old)
  for (const patch of [{ expectedRevision: 3 }, { cardId: 'other' }, { contractDigest: 'b'.repeat(64) }, { choice: 'accept' }])
    assert.throws(() => approve(proposal.card, old, patch))
  assert.throws(() => approve(proposal.card, policy('default')))
  assert.throws(() => change(old, policy('manage', [], 1)))
  assert.throws(() => change(old, { ...next, rules: [{ ...rule('allow'), method: 'approval/respond' }] } as unknown as LeadPermissionPolicy))
  const fn = lead as Record<string, unknown>
  assert.throws(() => (fn.applyLeadPolicyDecision as (...args: unknown[]) => unknown)(
    { version: 1, cardId: 'permission-1', cardType: 'permission-change', expectedRevision: 4, contractDigest: contract.digest, choice: 'approve' },
    proposal.card, old, 'b'.repeat(64)))
})

test('decisions are deterministic and do not mutate their inputs', () => {
  const c = context(), r = request(), before = JSON.stringify({ c, r })
  const first = decide(r, c)
  assert.deepEqual(decide(r, c), first)
  assert.equal(JSON.stringify({ c, r }), before)
})

test('comparison includes global reads alongside the approved project', () => {
  const readDeny = { ...rule('deny', 'read-deny'), method: 'library/usage' as const }
  const old = policy('manage', [readDeny])
  const next = policy('manage', [{ ...readDeny, project: contract.project.id }, rule('deny')], 2)
  // The project gets narrower, but global library reads get wider.
  assert.equal(compare(old, next), 'mixed')
  assert.equal(change(old, next).kind, 'card')
})

test('subscription filters agree with host-resolved project and run membership', () => {
  const scoped = { ...request(), method: 'client/subscribe', params: { topics: ['runs'], scope: { run: 'run-1', project: contract.project.path } } }
  assert.equal(decide(scoped, context()).effect, 'allow')
  for (const scope of [{ run: 'run-other' }, { project: '/workspace/other' }])
    assert.equal(decide({ ...scoped, params: { topics: ['runs'], scope } }, context()).effect, 'deny')
})

test('action-specific run eligibility allows abandon while every answer and missing action is refused', () => {
  const r = { ...request(), method: 'team/intent', params: { room: 'room-1', id: 1, action: 'abandon' } }
  assert.equal(decide(r, context()).effect, 'allow')
  for (const params of [{ room: 'room-1', id: 1 }, { room: 'room-1', id: 1, action: 'done', outcome: 'accept' },
    { room: 'room-1', id: 1, action: 'reopen' }, { room: 'room-1', id: 1, action: 'release' }])
    assert.equal(decide({ ...r, params }, context()).effect, 'deny')
})

test('unapproved starts and inflated, exhausted or malformed allowances fail closed', () => {
  assert.equal(decide(startRequest(), { ...context(), approved: null }).effect, 'deny')
  for (const patch of [
    { caps: { usdMicros: 501, rounds: 3 } }, { caps: { usdMicros: 500, rounds: 4 } },
    { leadUsdMicros: 480 }, { reservedUsdMicros: 470 },
    { stop: { reason: 'cancelled', revision: 1 } }, { leadUsdMicros: NaN },
  ]) assert.equal(decide(startRequest(), { ...context(), budget: { ...context().budget, ...patch } }).effect, 'deny')
  for (const now of [NaN, Infinity, -1, 100.5])
    assert.equal(decide(request(), { ...context(), now }).effect, 'deny')
  for (const params of [null, {}, { run: 'run-1' }, { run: 'run-1', reason: 'Stop', unexpected: true }])
    assert.equal(decide({ ...request(), params }, context()).effect, 'deny')
  assert.equal(decide(request(), { ...context(), desk: { ...policy(), mode: 'unknown' } }).effect, 'deny')
})

test('fixed publication floors also constrain an approved start with a wider worker grant', () => {
  for (const ceiling of ['publish', 'merge']) {
    const step = { ...contract.steps[0], assignments: [{ ...contract.steps[0]!.assignments[0], ceiling }] }
    const changed = parseLeadAcceptanceContract({ ...contract, steps: [step] })
    assert.equal(decide({ ...startRequest(), start: step },
      { ...context(), approved: { ...context().approved, contract: changed } }).effect, 'deny')
  }
})

test('comparison without a contract partitions all named projects and the remaining projects', () => {
  const fn = lead as Record<string, unknown>
  const compareAll = fn.compareLeadPolicyAuthority as (...args: unknown[]) => string
  assert.equal(compareAll(policy('manage'), policy('manage', [{ ...rule('deny'), project: 'other' }], 2), null, null), 'narrowing')
  assert.equal(compareAll(policy('manage', [{ ...rule('deny'), project: 'other' }]),
    policy('manage', [{ ...rule('deny'), project: 'other.' }], 2), null, null), 'mixed')
})

test('pre-contract cards bind a null digest and do not grant a plan or worker approval', () => {
  const current = policy('plan'), proposed = policy('manage', [], 2)
  const proposal = change(current, proposed, { contract: null })
  const apply = (lead as Record<string, unknown>).applyLeadPolicyDecision as (...args: unknown[]) => LeadPermissionPolicy
  const click = { version: 1, cardId: 'permission-1', cardType: 'permission-change', expectedRevision: 4, contractDigest: null, choice: 'approve' }
  const widened = apply(click, proposal.card, current, null)
  assert.deepEqual(widened, proposed)
  assert.equal(decide(startRequest(), { ...context(), desk: widened, approved: null }).effect, 'deny')
  assert.throws(() => apply({ ...click, contractDigest: contract.digest }, proposal.card, current, null))
  const workerCard = { version: 1, id: 'permission-1', revision: 4, contractDigest: contract.digest,
    type: 'waiting', kind: 'worker-approval', runId: 'run-1', personCardId: null, summary: 'Approval pending', assertions: [] }
  assert.throws(() => apply({ ...click, contractDigest: contract.digest, cardType: 'waiting', choice: 'accept' }, workerCard, current, contract.digest))
})

test('policy comparison and approval preserve inputs and ignore object property insertion order', () => {
  const current = policy('plan'), proposed = policy('manage', [], 2)
  const before = JSON.stringify({ current, proposed })
  const result = change(current, proposed)
  const reordered = { rules: current.rules, mode: current.mode, revision: current.revision, version: current.version }
  assert.deepEqual(approve(result.card, reordered), proposed)
  assert.equal(JSON.stringify({ current, proposed }), before)
})
