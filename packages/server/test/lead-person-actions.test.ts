import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { readChecks } from '../src/evidence/checks-file.js'
import { tempDir } from './scratch.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { LeadPersonActions } from '../src/lead/person-actions.js'
import { initialLeadState, reduceLeadRecord } from '@harnessdesk/lead'
import { leadApprovalCards } from '../src/lead/projection.js'

const digest = 'a'.repeat(64)
const rig = (role = 'review') => {
  const approval = { type: 'permission', id: 'approval', sessionId: 'session', requestedAt: 1, summary: 'mcp__harnessdesk__git_log', options: [
    { id: 'allow-once', label: 'Allow once', intent: 'approve' }, { id: 'always', label: 'Always', intent: 'approveAlways' }, { id: 'deny', label: 'Deny', intent: 'deny' },
  ] }
  const record = { runtime: 'fixture', session: { id: 'session' }, approvals: new Map([['approval', approval]]) }
  const state = { ...initialLeadState(), phase: 'running', contract: { digest, assertions: [] }, runs: [{ runId: 'run', teamId: 'team', correlationId: 'start' }], steps: [{ state: 'started', attemptId: 'start' }] }
  const calls: { method: string; params: any }[] = []
  const seat = { role, closed: null, session: { runtime: 'fixture', sessionId: 'session' }, board: 'team' }
  const actions = new LeadPersonActions({ get state() { return state } } as never, {
    registry: { all: () => [record] }, async call(method: string, params: any) { calls.push({ method, params }); record.approvals.delete(params.approvalId) },
  } as never, { seats: { all: () => [seat] } } as never, async value => { if (String(value).includes('synthetic-secret')) throw Error('secret') })
  return { actions, calls, approval, record, seat, state }
}

test('owned worker cards name their role and request, and only once/deny options reach the normal responder', async () => {
  for (const role of ['implement', 'review']) for (const choice of ['yes-once', 'no'] as const) {
    const s = rig(role), [action] = await s.actions.read()
    assert.ok(action?.kind === 'worker-approval')
    assert.equal(action.role, role === 'implement' ? 'implementer' : 'code reviewer')
    assert.match(leadApprovalCards([action], digest)[0]!.summary, /mcp__harnessdesk__git_log/)
    assert.deepEqual(action.choices, ['yes-once', 'no'])
    await s.actions.perform({ id: action.id, contractDigest: digest, choice })
    assert.deepEqual(s.calls, [{ method: 'approval/respond', params: { runtime: 'fixture', sessionId: 'session', approvalId: 'approval', decision: { type: 'option', optionId: choice === 'yes-once' ? 'allow-once' : 'deny' } } }])
    await assert.rejects(s.actions.perform({ id: action.id, contractDigest: digest, choice }), { wireCode: 'lead-card-stale' })
  }
})

test('approval descriptions are bounded and screened before truncation; hidden requests cannot be granted', async () => {
  for (const secret of ['synthetic-secret', 'sk-ant-synthetic-key', 'Authorization: Bearer demo-value', 'ghp_' + 'a'.repeat(36)]) {
    const s = rig(); s.approval.summary = `read ${'x'.repeat(300)} ${secret}`
    const [action] = await s.actions.read()
    assert.ok(action?.kind === 'worker-approval')
    assert.ok(action.request.length <= 240)
    assert.ok(!JSON.stringify(action).includes(secret))
    assert.deepEqual(action.choices, ['no'])
    await assert.rejects(s.actions.perform({ id: action.id, contractDigest: digest, choice: 'yes-once' }))
    assert.deepEqual(s.calls, [])
  }
  const s = rig(); s.approval.summary = `read\n${'x'.repeat(300)}`
  const [action] = await s.actions.read()
  assert.ok(action?.kind === 'worker-approval'); assert.ok(action.request.length <= 240); assert.ok(!action.request.includes('\n'))
})

test('changed approvals, changed contracts and unowned or closed seats refuse person actions', async () => {
  const s = rig(), [action] = await s.actions.read(); assert.ok(action)
  await assert.rejects(s.actions.perform({ id: action.id, contractDigest: 'b'.repeat(64), choice: 'yes-once' }), { wireCode: 'lead-card-stale' })
  s.approval.summary = 'another command'
  await assert.rejects(s.actions.perform({ id: action.id, contractDigest: digest, choice: 'yes-once' }), { wireCode: 'lead-card-stale' })
  s.seat.board = 'another-team'; assert.deepEqual(await s.actions.read(), [])
  assert.deepEqual(s.calls, [])
})

test('requests with undisplayed text offer only No and direct the person to the desk', async () => {
  for (const summary of ['x'.repeat(241), 'read\nfiles', 'read \u202efiles']) {
    const s = rig(); s.approval.summary = summary
    const [action] = await s.actions.read()
    assert.ok(action?.kind === 'worker-approval')
    assert.deepEqual(action.choices, ['no'])
    assert.match(action.request, /full request is on the desk/)
    await assert.rejects(s.actions.perform({ id: action.id, contractDigest: digest, choice: 'yes-once' }))
    assert.deepEqual(s.calls, [])
  }
})

test('undisplayed permission scope and oversized file content cannot receive an affirmative', async () => {
  for (const details of [{ filesystem: ['/workspace/demo'] }, { network: ['example.com'] }, { type: 'fileChange', changes: [{ path: 'demo.ts', kind: { type: 'add' }, diff: 'x'.repeat(8001) }] }]) {
    const s = rig(); Object.assign(s.approval, details)
    const [action] = await s.actions.read()
    assert.ok(action?.kind === 'worker-approval')
    assert.deepEqual(action.choices, ['no'])
    assert.match(action.request, /full request is on the desk/)
  }
})

test('credential-bearing check commands never reach the person action projection', async () => {
  const repo = await makeRepo('lead-check-screen-')
  await mkdir(join(repo.dir, '.harnessdesk'))
  const commands = ['printf "Authorization: Bearer demo-value"', 'echo ghp_' + 'a'.repeat(36)]
  await writeFile(join(repo.dir, '.harnessdesk/checks.yml'), commands.map((run, i) => `check${i}: { run: ${JSON.stringify(run)} }`).join('\n'))
  await repo.git('add', '.harnessdesk'); await repo.git('commit', '-qm', 'Declare demo checks')
  const at = await repo.git('rev-parse', 'HEAD')
  assert.equal((await readChecks(repo.dir)).checks.length, 2)
  const state = { ...initialLeadState(), phase: 'running', contract: { digest, project: { path: repo.dir }, assertions: [{ kind: 'check' }] },
    runs: [{ runId: 'run', teamId: 'team', correlationId: 'start' }], steps: [{ state: 'started', attemptId: 'start' }] }
  const actions = new LeadPersonActions({ state } as never, {
    registry: { all: () => [] }, flowsPlane: { executionOf: () => ({ state: 'running', rounds: [{ cards: [1] }] }) },
    teamPlane: { stateFor: () => ({ intents: [{ id: 1, role: 'implement', state: 'done' }] }) },
    call: async () => ({ cards: [{ card: 1, facts: [{ record: { fact: { kind: 'review', at, verdict: 'approve' } }, freshness: { state: 'fresh' } }], running: [] }] }),
  } as never, { seats: { all: () => [] } } as never, async () => {})
  assert.deepEqual(await actions.read(), [])
})

const standingRig = async () => {
  const project = tempDir('lead-worker-rules-')
  const { createLeadJournal } = await import('@harnessdesk/lead')
  const { parseLeadAcceptanceContract } = await import('@harnessdesk/protocol')
  const journal = await createLeadJournal({ async read() { return [] }, async append() {} })
  const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest, goal: 'Inspect demo', project: { id: 'demo', path: project }, policyRevision: 1,
    steps: [{ id: 'first', title: 'Inspect', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {}, attendance: 'attended', assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] }],
    assertions: [{ id: 'diff', kind: 'diff', description: 'Reviewed' }], caps: { usdMicros: 500, rounds: 3 } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: digest, contract })
  await journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: digest, choice: 'approve' }, 1000)
  const records = [
    { version: 1, seq: 4, type: 'attempt', id: 'start', correlationId: 'start', method: 'flow/start-goal', action: null,
      arguments: { type: 'object', size: 0, fields: [] }, kind: 'mutation', stepId: 'first', policyRevision: 1, projectPolicyRevision: null, contractRevision: 1 },
    { version: 1, seq: 5, type: 'decision', id: 'start', effect: 'allow', reason: 'policy', rule: null },
    { version: 1, seq: 6, type: 'dispatch-start', id: 'start', dispatched: true },
    { version: 1, seq: 7, type: 'result', id: 'start', outcome: 'succeeded', identity: { correlationId: 'start', runId: 'run', teamId: 'team' } },
  ]
  const state = records.reduce((state, event) => reduceLeadRecord(state, event), journal.state)
  const restored = await createLeadJournal({ async read() { return [] }, async append() {}, checkpoint() { return state } })
  const approval: any = { type: 'fileChange', id: 'first', sessionId: 'session', requestedAt: 1, changes: [{ path: join(project, 'demo.ts'), kind: { type: 'update' }, diff: 'export const demo = 1' }], options: [{ id: 'yes', label: 'Yes', intent: 'approve' }, { id: 'no', label: 'No', intent: 'deny' }] }
  const record = { runtime: 'fixture', session: { id: 'session' }, approvals: new Map([['first', approval]]) }
  const calls: unknown[] = []
  const response: { fail: boolean; onAnswer?: () => Promise<void> } = { fail: false }
  const seat = { role: 'review', closed: null, session: { runtime: 'fixture', sessionId: 'session' }, board: 'team' }
  const actions = new LeadPersonActions(restored, { registry: { all: () => [record] }, async call(method: string, params: any) { calls.push({ method, params }); await response.onAnswer?.(); if (response.fail) throw Error('fixture responder refused'); record.approvals.delete(params.approvalId) } } as never,
    { seats: { all: () => [seat] } } as never, async () => {})
  return { actions, journal: restored, record, approval, calls, seat, project, response }
}

test('a person saves an exact goal rule; later matching workers auto-answer and leave a thread line', async () => {
  const s = await standingRig(), [action] = await s.actions.read()
  assert.ok(action?.kind === 'worker-approval'); assert.ok(action.choices.includes('yes-goal'))
  await s.actions.perform({ id: action.id, contractDigest: digest, choice: 'yes-goal' })
  assert.equal(s.calls.length, 1); assert.equal(s.journal.state.workerApprovals.length, 1)
  const next = { ...s.approval, id: 'second' }; s.record.approvals.set('second', next)
  assert.deepEqual(await Promise.all([s.actions.autoAnswer('fixture', 'session', 'second'), s.actions.autoAnswer('fixture', 'session', 'second')]), [true, true])
  assert.equal(s.calls.length, 2); assert.equal(s.journal.state.workerApprovals[0]!.count, 1)
  assert.equal(s.journal.state.messages.length, 0)
  assert.equal(s.journal.state.workerApprovals[0]!.entries![0]!.diff, s.approval.changes[0].diff)
  for (const changed of [{ changes: [{ ...s.approval.changes[0], path: join(s.project, 'other.ts') }] }, { type: 'command', command: 'git status', cwd: s.project }, { type: 'command', kind: 'stdin', input: 'yes', command: 'demo', cwd: s.project }]) {
    s.record.approvals.set('second', { ...next, ...changed })
    assert.equal(await s.actions.autoAnswer('fixture', 'session', 'second'), false)
  }
  s.record.approvals.set('second', next)
  s.seat.board = 'elsewhere'; assert.equal(await s.actions.autoAnswer('fixture', 'session', 'second'), false)
  s.seat.board = 'team'
  await s.actions.revoke({ id: s.journal.state.workerApprovals[0]!.id, contractDigest: digest })
  assert.equal(await s.actions.autoAnswer('fixture', 'session', 'second'), false)
})

test('publication, free text and permission changes never offer Yes for this goal', async () => {
  const s = await standingRig()
  for (const details of [{ type: 'command', command: 'git push', cwd: s.project }, { type: 'command', kind: 'stdin', input: 'yes', command: 'demo', cwd: s.project }, { type: 'permission', summary: 'change permissions', gateway: true },
    { type: 'userInput', tool: 'question', questions: [] }, { type: 'elicitation', server: 'demo', message: 'Answer?', schema: {} }]) {
    s.record.approvals.set('first', { ...s.approval, ...details })
    const [action] = await s.actions.read()
    assert.ok(action?.kind === 'worker-approval'); assert.ok(!action.choices.includes('yes-goal'))
    await assert.rejects(s.actions.perform({ id: action.id, contractDigest: digest, choice: 'yes-goal' }))
  }
  assert.equal(s.journal.state.workerApprovals.length, 0)
})

test('linked folders and files cannot borrow authority outside the project or inside its permission storage', async () => {
  const s = await standingRig(), outside = tempDir('lead-worker-outside-')
  await symlink(outside, join(s.project, 'linked'))
  s.record.approvals.set('first', { ...s.approval, changes: [{ ...s.approval.changes[0], path: join(s.project, 'linked', 'demo.ts') }] })
  let [action] = await s.actions.read()
  assert.ok(action?.kind === 'worker-approval'); assert.ok(!action.choices.includes('yes-goal'))
  await mkdir(join(s.project, '.git')); await writeFile(join(s.project, '.git', 'config'), 'fixture')
  await symlink(join(s.project, '.git', 'config'), join(s.project, 'demo.ts'))
  s.record.approvals.set('first', { ...s.approval, type: 'fileChange', changes: [{ path: join(s.project, 'demo.ts'), kind: { type: 'update' }, diff: 'fixture' }] })
  ;[action] = await s.actions.read()
  assert.ok(action?.kind === 'worker-approval'); assert.ok(!action.choices.includes('yes-goal'))
})


test('a pending replacement plan suspends the reusable choice and automatic answers', async () => {
  const s = await standingRig(), [action] = await s.actions.read(); assert.ok(action)
  await s.actions.perform({ id: action.id, contractDigest: digest, choice: 'yes-goal' })
  s.record.approvals.set('first', s.approval)
  const contract = s.journal.state.contract!
  await s.journal.offerCard({ version: 1, id: 'plan', revision: 2, type: 'plan', contractDigest: digest, contract: { ...contract, revision: 2 } })
  const [pending] = await s.actions.read()
  assert.ok(pending?.kind === 'worker-approval'); assert.ok(!pending.choices.includes('yes-goal'))
  assert.equal(await s.actions.autoAnswer('fixture', 'session', 'first'), false)
})

test('one file path can be remembered with its complete diff, but another file does not match', async () => {
  const s = await standingRig(), path = join(s.project, 'demo.ts')
  const file = { ...s.approval, type: 'fileChange', changes: [{ path, kind: { type: 'add' }, diff: 'export const demo = 1' }] }
  s.record.approvals.set('first', file)
  const [action] = await s.actions.read()
  assert.ok(action?.kind === 'worker-approval'); assert.equal(action.details, file.changes[0]!.diff); assert.ok(action.choices.includes('yes-goal'))
  await s.actions.perform({ id: action.id, contractDigest: digest, choice: 'yes-goal' })
  s.record.approvals.set('next', { ...file, id: 'next', changes: [{ ...file.changes[0], path: join(s.project, 'other.ts') }] })
  assert.equal(await s.actions.autoAnswer('fixture', 'session', 'next'), false)
  s.record.approvals.set('next', { ...file, id: 'next', changes: [{ path, kind: { type: 'update' }, diff: 'export const demo = 2' }] })
  assert.equal(await s.actions.autoAnswer('fixture', 'session', 'next'), true)
  assert.equal(s.journal.state.workerApprovals[0]!.count, 1)
})

test('a multiply linked regular file never offers a goal rule', async () => {
  const s = await standingRig()
  const path = s.approval.changes[0].path
  await writeFile(path, 'fixture')
  await link(path, join(s.project, 'alias.ts'))
  const [action] = await s.actions.read()
  assert.ok(action?.kind === 'worker-approval'); assert.ok(!action.choices.includes('yes-goal'))
})

test('an automatic answer records acknowledged rule history with the exact bounded diff', async () => {
  const s = await standingRig(), [first] = await s.actions.read(); assert.ok(first)
  await s.actions.perform({ id: first.id, contractDigest: digest, choice: 'yes-goal' })
  const diff = 'export const demo = 2 // worker-chosen text'
  s.record.approvals.set('next', { ...s.approval, id: 'next', changes: [{ ...s.approval.changes[0], diff }] })
  s.response.onAnswer = async () => { assert.equal(s.journal.state.workerApprovals[0]!.entries, undefined, 'no grant claimed before acknowledgement') }
  assert.equal(await s.actions.autoAnswer('fixture', 'session', 'next'), true)
  assert.equal(s.journal.state.messages.length, 0)
  assert.equal(s.journal.state.workerApprovals[0]!.entries![0]!.diff, diff)
  assert.equal(s.journal.state.workerApprovals[0]!.target, s.approval.changes[0].path)
})

test('a failed automatic responder leaves no allowed notice or count', async () => {
  const s = await standingRig(), [first] = await s.actions.read(); assert.ok(first)
  await s.actions.perform({ id: first.id, contractDigest: digest, choice: 'yes-goal' })
  s.record.approvals.set('next', { ...s.approval, id: 'next' }); s.response.fail = true
  await assert.rejects(s.actions.autoAnswer('fixture', 'session', 'next'))
  assert.equal(s.journal.state.messages.some(message => message.text.includes('Allowed under your rule')), false)
  assert.equal(s.journal.state.workerApprovals[0]!.count, 0)
})

test('one-time command cards show extra grants and never offer a goal rule', async () => {
  for (const fact of [{ label: 'Additional permissions', value: '{"network":{"enabled":true},"fileSystem":{"write":["/"]}}' }, { label: 'Network approval context', value: '{"host":"example.com","protocol":"https"}' }]) {
    const s = await standingRig()
    s.record.approvals.set('first', { ...s.approval, type: 'command', command: 'git status', cwd: s.project, actions: [], extraGrants: [fact] })
    const [action] = await s.actions.read()
    assert.ok(action?.kind === 'worker-approval'); assert.deepEqual(action.choices, ['yes-once', 'no'])
    assert.ok(action.details?.includes(fact.value)); assert.ok(action.details?.includes(fact.label))
  }
})
