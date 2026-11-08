import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage, parseLeadAcceptanceContract, parseLeadBudgetState, parseLeadPermissionPolicy, type LeadPermissionPolicy } from '@harnessdesk/protocol'
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
const decide = (request: unknown, context: unknown): { effect: string; rule: unknown; reason: string; floor: string | null; call: { method: string; params: unknown } | null } => {
  const fn = (lead as Record<string, unknown>).decideLeadPermission
  assert.equal(typeof fn, 'function', 'decideLeadPermission must enforce the desk deny before a project allow')
  return (fn as (r: unknown, c: unknown) => ReturnType<typeof decide>)(request, context)
}
const context = () => ({
  desk: policy(), projectPolicy: null as LeadPermissionPolicy | null, project: contract.project,
  approved: { contract, consent: { contractDigest: contract.digest, contractRevision: 1, policyRevision: 1, expiresAt: 200 }, runIds: ['run-1'], teamIds: ['team-1'] },
  budget: parseLeadBudgetState({ version: 1, revision: 1, caps: contract.caps, leadUsdMicros: 10,
    workerUsdMicros: 20, reservedUsdMicros: 0, roundsAdmitted: 1, spend: 'known', stop: null }),
  now: 100, policyInterpretation: 'idle',
})
const request = () => ({ method: 'flow/execution/stop', params: { run: 'run-1', reason: 'Stop work' },
  project: contract.project, runId: 'run-1', start: null })

test('ordinary chats use project policy and known headroom without a reviewed contract', () => {
  const c = { ...context(), approved: null }
  for (const [method, params] of [
    ['lead/chat/list', {}], ['lead/chat/read', { id: 'fixture:chat' }],
    ['lead/chat/start', { text: 'Capture a screenshot' }], ['lead/chat/send', { id: 'fixture:chat', text: 'Use the active window' }],
    ['lead/chat/stop', { id: 'fixture:chat' }],
  ] as const) {
    const r = { method, params, project: contract.project, runId: null, start: null }
    assert.equal(decide(r, c).effect, 'allow', method)
    assert.equal(decide({ ...r, project: null }, c).effect, 'deny', `${method} needs the host's project`)
    if (method === 'lead/chat/start' || method === 'lead/chat/send') {
      assert.equal(decide(r, { ...c, desk: policy('plan') }).effect, 'deny')
      assert.equal(decide(r, { ...c, desk: policy('default') }).effect, 'ask')
      assert.equal(decide(r, { ...c, policyInterpretation: 'interpreting' }).effect, 'deny')
      assert.equal(decide(r, { ...c, budget: { ...c.budget, spend: 'unknown' } }).effect, 'deny')
      assert.equal(decide(r, { ...c, budget: { ...c.budget, leadUsdMicros: 500 } }).effect, 'deny')
    }
  }
})

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
    { label: 'merge', floor: 'irreversible', request: { ...request(), method: 'git/merge', params: {} } },
    { label: 'publish', floor: 'irreversible', request: { ...request(), params: { run: 'run-1', action: 'publish' } } },
    { label: 'delete', floor: 'irreversible', request: { ...request(), params: { run: 'run-1', action: 'delete' } } },
    { label: 'worker approval', floor: 'worker-approval', request: { ...request(), method: 'approval/respond', params: { choice: 'approve' } } },
    { label: 'off surface', floor: 'client-surface', request: { ...request(), method: 'session/send', params: {} } },
    { label: 'answer tier', floor: 'client-surface', request: { ...request(), method: 'team/intent', params: { room: 'room-1', id: 1, action: 'done' } } },
    { label: 'unknown action', floor: 'client-surface', request: { ...request(), method: 'team/intent', params: { action: 'other' } } },
    { label: 'unapproved', floor: 'unapproved', context: { approved: null } },
    { label: 'unrelated project', floor: 'project', request: { ...request(), project: { id: 'other', path: '/workspace/other' } } },
    { label: 'unrelated run', floor: 'run', request: { ...request(), runId: 'run-other', params: { run: 'run-other', reason: 'Stop work' } } },
    { label: 'disguised run', floor: 'run', request: { ...request(), params: { run: 'run-other', reason: 'Stop work' } } },
    { label: 'stale consent', floor: 'consent', context: { now: 200 } },
    { label: 'changed contract', floor: 'consent', context: { approved: { ...context().approved, consent: { ...context().approved.consent, contractRevision: 0 } } } },
    { label: 'stale digest', floor: 'consent', context: { approved: { ...context().approved, consent: { ...context().approved.consent, contractDigest: 'b'.repeat(64) } } } },
    { label: 'stale policy consent', floor: 'consent', context: { approved: { ...context().approved, consent: { ...context().approved.consent, policyRevision: 0 } } } },
    { label: 'caps', floor: 'budget', context: { budget: { ...context().budget, leadUsdMicros: 500, stop: { reason: 'budget', revision: 1 } } } },
    { label: 'rounds', floor: 'budget', context: { budget: { ...context().budget, roundsAdmitted: 3 } } },
    { label: 'unknown spend', floor: 'budget', context: { budget: { ...context().budget, spend: 'unknown' } } },
    { label: 'stale spend', floor: 'budget', context: { budget: { ...context().budget, spend: 'stale' } } },
    { label: 'partial spend', floor: 'budget', context: { budget: { ...context().budget, spend: 'partial' } } },
    { label: 'missing budget', floor: 'budget', context: { budget: null } },
    { label: 'policy interpretation', floor: 'policy-interpretation', context: { policyInterpretation: 'interpreting' } },
  ]
  for (const c of wideningPaths) for (const item of cases) {
    const result = decide(item.request ?? startRequest(), { ...c, ...item.context })
    assert.equal(result.effect, 'deny', item.label)
    assert.equal(result.floor, item.floor, item.label)
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
  assert.equal(compare(policy('manage'), policy('manage', [{ ...rule('deny'), project: 'unrelated' }], 2)), 'narrowing')
  assert.equal(compare(policy('plan'), policy('manage', [], 2), policy('plan')), 'widening')
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

test('unapproved starts and exhausted or malformed allowances fail closed', () => {
  assert.equal(decide(startRequest(), { ...context(), approved: null }).effect, 'deny')
  for (const patch of [
    { leadUsdMicros: 480 }, { reservedUsdMicros: 470 },
    { stop: { reason: 'cancelled', revision: 1 } }, { leadUsdMicros: NaN },
  ]) assert.equal(decide(startRequest(), { ...context(), budget: { ...context().budget, ...patch } }).effect, 'deny')
  for (const now of [NaN, Infinity, -1, 100.5])
    assert.equal(decide(startRequest(), { ...context(), now }).effect, 'deny')
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


test('stored desk changes cannot hide widening on other projects or behind project restrictions', () => {
  const startDeny = { ...rule('deny', 'start-deny'), method: 'flow/start-goal' as const, project: 'other-project' }
  const localDeny = { ...rule('deny', 'local-deny'), method: 'workspace/open' as const, project: contract.project.id }
  const probes = [
    { current: policy('manage', [startDeny]), proposed: policy('manage', [localDeny], 2), projectPolicy: null },
    { current: policy('default'), proposed: policy('default', [{ ...startDeny, effect: 'allow' as const }, localDeny], 2), projectPolicy: null },
    { current: policy('default'), proposed: policy('default', [rule('allow'), localDeny], 2), projectPolicy: policy('manage', [rule('deny')]) },
  ]
  for (const probe of probes) {
    assert.equal(compare(probe.current, probe.proposed, probe.projectPolicy), 'mixed')
    for (const approved of [contract, null]) {
      const result = change(probe.current, probe.proposed, { projectPolicy: probe.projectPolicy, contract: approved })
      assert.equal(result.comparison, 'mixed')
      assert.equal(result.kind, 'card')
      assert.deepEqual(result.policy, probe.current)
    }
  }
})

test('reads cannot discover unrelated projects through omitted listing or subscription scope', () => {
  const probes = [
    { method: 'flow/executions', params: {} },
    { method: 'flow/executions', params: { active: false } },
    { method: 'goal/list', params: {} },
    { method: 'client/subscribe', params: { topics: ['runs', 'waiting'] } },
    { method: 'client/subscribe', params: { topics: ['runs'], scope: {} } },
    { method: 'library/read', params: { cwd: '/workspace/other' } },
    { method: 'session/loadout', params: { session: 'someone' } },
    { method: 'library/read', params: { sessionId: 'someone' } },
  ]
  for (const probe of probes) for (const resolved of [null, contract.project]) {
    const result = decide({ ...request(), ...probe, project: resolved, runId: null }, context())
    // A resolved target is required for session reads; the host owns session-to-project lookup.
    if (probe.method === 'session/loadout' && resolved !== null) continue
    assert.equal(result.effect, 'deny', JSON.stringify({ probe, resolved }))
  }
})

test('scoped reads stay within the selected project and honor project denies', () => {
  const probes = [
    { method: 'flow/executions', params: { project: contract.project.path } },
    { method: 'goal/list', params: { root: contract.project.path } },
    { method: 'client/subscribe', params: { topics: ['runs'], scope: { project: contract.project.path } } },
    { method: 'library/read', params: { cwd: contract.project.path } },
    { method: 'session/loadout', params: { session: 'session-1' } },
  ] as const
  for (const probe of probes) {
    assert.equal(decide({ ...request(), ...probe, runId: null }, context()).effect, 'allow')
    const denyRead = { ...rule('deny'), method: probe.method, project: contract.project.id }
    const result = decide({ ...request(), ...probe, runId: null }, { ...context(), projectPolicy: policy('manage', [denyRead]) })
    assert.equal(result.effect, 'deny'); assert.deepEqual(result.rule, { layer: 'project', id: 'deny' })
  }
  const deskDeny = { ...rule('deny'), method: 'flow/executions' as const, project: contract.project.id }
  assert.equal(decide({ ...request(), method: 'flow/executions', params: { active: false }, project: null, runId: null },
    { ...context(), desk: policy('manage', [deskDeny]) }).effect, 'deny')
  for (const project of [contract.project.path, '/workspace/other'])
    assert.equal(decide({ ...request(), method: 'library/read', params: { cwd: project } }, context()).effect,
      project === contract.project.path ? 'allow' : 'deny')
  assert.equal(decide({ ...request(), method: 'client/hello', params: { client: { name: 'fixture', version: '1' }, protocol: 1 }, project: null, runId: null }, context()).effect, 'allow')
})


test('approved stop and abandon remain available under every degraded admission state', () => {
  const cancellations = [request(), { ...request(), method: 'team/intent', params: { room: 'room-1', id: 1, action: 'abandon' } }]
  const degraded = [
    { now: 200 }, { now: NaN },
    { budget: null },
    { budget: { ...context().budget, stop: { reason: 'budget', revision: 1 } } },
    ...['unknown', 'stale', 'partial'].map(spend => ({ budget: { ...context().budget, spend } })),
    { budget: { ...context().budget, roundsAdmitted: 3 } },
    { budget: { ...context().budget, leadUsdMicros: 480 } },
    { budget: { ...context().budget, reservedUsdMicros: 470 } },
    { budget: { ...context().budget, leadUsdMicros: NaN } },
  ]
  for (const r of cancellations) for (const patch of degraded) {
    const c = { ...context(), ...patch }
    assert.equal(decide(r, c).effect, 'allow', JSON.stringify({ r, patch }))
    assert.equal(decide(r, { ...c, desk: policy('default') }).effect, 'ask')
    assert.equal(decide(r, { ...c, desk: policy('plan') }).effect, 'deny')
    const denyCancellation = { ...rule('deny'), method: r.method as 'flow/execution/stop', action: r.method === 'team/intent' ? 'abandon' : null }
    assert.equal(decide(r, { ...c, projectPolicy: policy('manage', [denyCancellation]) }).effect, 'deny')
    assert.equal(decide(r, { ...c, policyInterpretation: 'interpreting' }).effect, 'deny')
    assert.equal(decide({ ...r, runId: 'run-other' }, c).effect, 'deny')
    assert.equal(decide({ ...r, project: { id: 'other', path: '/workspace/other' } }, c).effect, 'deny')
    assert.equal(decide(r, { ...c, approved: null }).effect, 'deny')
    assert.equal(decide(startRequest(), c).effect, 'deny')
  }
})

test('library definition uses cwd membership and keeps definition paths under host confinement', () => {
  const skill = { ...request(), method: 'library/definition', runId: null,
    params: { kind: 'skill', name: 'test-skill', path: '/workspace/demo/.claude/skills/test-skill', cwd: contract.project.path } }
  assert.equal(decide(skill, context()).effect, 'allow')
  const global = { ...skill, project: null, params: { kind: 'skill', name: 'test-skill', path: '/profiles/demo/.claude/skills/test-skill' } }
  assert.equal(decide(global, context()).effect, 'allow')
  assert.equal(decide({ ...skill, params: { ...skill.params, cwd: '/workspace/other' } }, context()).effect, 'deny')
  assert.equal(decide({ ...skill, project: null }, context()).effect, 'deny')
  const denyDefinition = { ...rule('deny'), method: 'library/definition' as const, project: contract.project.id }
  assert.equal(decide(skill, { ...context(), projectPolicy: policy('manage', [denyDefinition]) }).effect, 'deny')
  const globalDeny = { ...denyDefinition, project: null }
  assert.equal(decide(global, { ...context(), desk: policy('manage', [globalDeny]) }).effect, 'deny')
  for (const [method, params] of [
    ['flow/catalog', { root: contract.project.path }],
    ['flow/source', { root: contract.project.path, id: 'fixture' }],
    ['flow/preview', { root: contract.project.path, source: 'synthetic recipe' }],
    ['flow/start-goal', startRequest().params], ['goal/list', { root: contract.project.path }],
  ] as const) {
    const r = { ...startRequest(), method, params }
    assert.equal(decide(r, context()).effect, 'allow', method)
    const result = decide({ ...r, params: { ...params, root: '/workspace/other' } }, context())
    assert.equal(result.effect, 'deny', method); assert.equal(result.floor, 'project', method)
  }
})


test('irreversible and worker-approval floors are independently observable', () => {
  for (const action of ['merge', 'publish', 'delete']) {
    // workspace/open has an open validator: absent the fixed floor this otherwise runs.
    const r = { ...request(), method: 'workspace/open', runId: null, params: { path: contract.project.path, action } }
    const result = decide(r, context())
    assert.equal(result.effect, 'deny'); assert.equal(result.floor, 'irreversible')
  }
  const result = decide({ ...request(), method: 'approval/respond', params: { choice: 'approve' } }, context())
  assert.equal(result.effect, 'deny'); assert.equal(result.floor, 'worker-approval')
  const ordinary = decide({ ...request(), method: 'workspace/open', runId: null, params: { path: contract.project.path } }, context())
  assert.equal(ordinary.effect, 'allow'); assert.equal(ordinary.floor, null)
})

test('non-action methods cannot acquire authority through an injected action', () => {
  const invalidRule = { ...rule('allow'), method: 'workspace/open' as const, action: 'x' }
  assert.throws(() => policy('default', [invalidRule]))
  assert.throws(() => policy('manage', [{ ...invalidRule, effect: 'deny', method: 'library/read' }]))
  const injected = { ...request(), method: 'workspace/open', runId: null, params: { path: contract.project.path, action: 'x' } }
  assert.equal(decide(injected, { ...context(), desk: policy('default') }).effect, 'ask')
  const malformedPolicy = { ...policy('default'), rules: [invalidRule] }
  const result = decide(injected, { ...context(), desk: malformedPolicy })
  assert.equal(result.effect, 'deny'); assert.equal(result.floor, 'invalid-input')
  assert.throws(() => change(policy('default'), { ...malformedPolicy, revision: 2 }))
  const stopDeny = { ...rule('deny'), method: 'workspace/open' as const }
  assert.equal(decide(injected, { ...context(), desk: policy('manage', [stopDeny]) }).effect, 'deny')
})


test('permission decisions expose the parsed detached snapshot used for dispatch', () => {
  const r = startRequest()
  const expected = parseClientMessage({ id: 1, method: r.method, params: r.params })
  const result = decide(r, context())
  assert.equal(result.effect, 'allow')
  assert.ok(result.call)
  assert.equal(result.call.method, r.method)
  assert.deepEqual(result.call.params, expected.params)
  assert.notEqual(result.call.params, r.params)
  r.params.vars = { task: 'Changed after deciding' }
  r.params.seats.implement[0] = { runtime: 'other', model: 'other' }
  assert.deepEqual((result.call.params as typeof r.params).vars, contract.steps[0]!.variables)
  assert.deepEqual((result.call.params as typeof r.params).seats, (expected.params as typeof r.params).seats)
  assert.ok(Object.isFrozen(result.call))
  assert.ok(Object.isFrozen((result.call.params as typeof r.params).seats.implement))
  assert.equal(decide({ ...request(), method: 'session/send', params: {} }, context()).call, null)
  const asking = decide(startRequest(), { ...context(), desk: policy('default', [{ ...rule('ask'), method: 'flow/start-goal' }]) })
  assert.equal(asking.effect, 'ask'); assert.ok(asking.call)
})

test('in default mode the approved plan is the consent to start its own frozen step, and nothing more', () => {
  const started = decide(startRequest(), { ...context(), desk: policy('default') })
  assert.equal(started.effect, 'allow'); assert.ok(started.call)
  // A person's own rule still decides, and plan mode still permits reads only.
  for (const effect of ['ask', 'deny'] as const)
    assert.equal(decide(startRequest(), { ...context(), desk: policy('default', [{ ...rule(effect), method: 'flow/start-goal' }]) }).effect, effect)
  assert.equal(decide(startRequest(), { ...context(), desk: policy('plan') }).effect, 'deny')
  assert.equal(decide(startRequest(), { ...context(), desk: policy('manage'), projectPolicy: policy('default', [{ ...rule('ask'), method: 'flow/start-goal' }]) }).effect, 'ask')
  // Other management in an approved run still asks in default mode.
  assert.equal(decide(request(), { ...context(), desk: policy('default') }).effect, 'ask')
  // A step that differs from the approved one is refused, not started.
  assert.equal(decide({ ...startRequest(), params: { ...startRequest().params, sentence: 'Other task' } }, { ...context(), desk: policy('default') }).effect, 'deny')
})

test('normalized parser values, rather than raw params, decide global definition scope', () => {
  const r = { ...request(), method: 'library/definition', project: null, runId: null,
    params: { kind: 'skill', name: 'test-skill', path: '/profiles/demo/.claude/skills/test-skill', cwd: null } }
  const result = decide(r, context())
  assert.equal(result.effect, 'allow')
  assert.ok(result.call)
  assert.equal((result.call.params as { cwd?: unknown }).cwd, undefined)
  assert.equal(r.params.cwd, null)
})

test('project filters use canonical paths and previews cannot import another run', () => {
  for (const method of ['flow/executions', 'client/subscribe']) {
    const params = method === 'flow/executions' ? { project: contract.project.id } : { topics: ['runs'], scope: { project: contract.project.id } }
    assert.equal(decide({ ...request(), method, params, runId: null }, context()).effect, 'deny')
  }
  for (const patch of [{ retry: { run: 'run-other', card: 1 } }, { continues: 'run-other' }]) {
    const params = { root: contract.project.path, source: 'synthetic recipe', ...patch }
    assert.equal(decide({ ...request(), method: 'flow/preview', params, runId: null }, context()).effect, 'deny')
  }
})

test('approved Team scope works before a first run and refuses other Team ids', () => {
  const c = { ...context(), approved: { ...context().approved, runIds: [], teamIds: ['team-1'] } }
  for (const method of ['flow/executions', 'client/subscribe']) {
    const params = method === 'flow/executions' ? { team: 'team-1' } : { topics: ['runs'], scope: { team: 'team-1' } }
    assert.equal(decide({ ...request(), method, params, runId: null }, c).effect, 'allow')
    const other = method === 'flow/executions' ? { project: contract.project.path, team: 'other' }
      : { topics: ['runs'], scope: { project: contract.project.path, team: 'other' } }
    assert.equal(decide({ ...request(), method, params: other, runId: null }, c).effect, 'deny')
  }
})
