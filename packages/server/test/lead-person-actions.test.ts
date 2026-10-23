import assert from 'node:assert/strict'
import test from 'node:test'
import { LeadPersonActions } from '../src/lead/person-actions.js'
import { leadApprovalCards } from '../src/lead/projection.js'

const digest = 'a'.repeat(64)
const rig = (role = 'review') => {
  const approval = { type: 'permission', id: 'approval', sessionId: 'session', requestedAt: 1, summary: 'mcp__harnessdesk__git_log', options: [
    { id: 'allow-once', label: 'Allow once', intent: 'approve' }, { id: 'always', label: 'Always', intent: 'approveAlways' }, { id: 'deny', label: 'Deny', intent: 'deny' },
  ] }
  const record = { runtime: 'fixture', session: { id: 'session' }, approvals: new Map([['approval', approval]]) }
  const state = { phase: 'running', contract: { digest, assertions: [] }, runs: [{ runId: 'run', teamId: 'team', correlationId: 'start' }], steps: [{ state: 'started', attemptId: 'start' }] }
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
