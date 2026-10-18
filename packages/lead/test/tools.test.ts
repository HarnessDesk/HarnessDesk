import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contract, exported, fixture, project } from './fixtures/loop.js'
import { LeadToolFencedError, LeadToolRefusedError } from '../src/tools.js'

test('tools cannot start before approval, after preview expiry, changed work or a baseline gap', async () => {
  const create = exported('createLeadTools')
  const source = (await import('../src/index.js') as any).leadReviewedResultSource
  const call = { method: 'flow/start-goal', params: { root: project.path, source, token: 'preview-1', sentence: contract.goal,
    vars: {}, attended: true, seats: { implement: [contract.steps[0]!.assignments[0]!.seat], review: [contract.steps[0]!.assignments[1]!.seat] } } }
  for (const variant of ['unapproved', 'expired', 'changed', 'gap', 'source']) {
    const s = await fixture(); let synced = true
    const tools = create({ ...s.options, now: s.options.clock.now, synchronized: () => synced })
    if (variant !== 'unapproved') await s.approve()
    if (variant === 'expired') s.setPreviewExpires(100)
    if (variant === 'changed') s.setStep({ ...contract.steps[0], variables: { changed: 'yes' } })
    if (variant === 'gap') synced = false
    const request = variant === 'source' ? { ...call, params: { ...call.params, source: 'arbitrary shell recipe' } } : call
    await tools.execute(request).catch(() => {})
    assert.equal(s.calls.filter(c => c.method === 'flow/start-goal').length, 0, variant)
  }
  const s = await fixture(); await s.approve()
  const tools = create({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  assert.equal((await tools.execute(call)).outcome, 'succeeded')
  assert.equal(s.calls.filter(c => c.method === 'flow/start-goal').length, 1)
  assert.deepEqual(s.journal.state.runs.map(r => r.runId), ['run-1'])
})

test('worker approvals have relay information and no answer tool or answerable card', async () => {
  const relay = exported('leadWorkerApprovalRelay')({ id: 'approval-1', team: 'team-1', kind: 'approval', summary: 'Approve command', seat: 'seat-1' })
  assert.equal(relay.kind, 'worker-approval')
  assert.equal(relay.surface, 'approvals')
  assert.equal(relay.approvalId, 'approval-1')
  assert.equal('choice' in relay, false)
  const s = await fixture(), tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  await tools.execute({ method: 'approval/answer', params: { id: 'approval-1', choice: 'accept' } }).catch(() => {})
  await tools.execute({ method: 'team/intent', params: { action: 'done' } }).catch(() => {})
  assert.equal(s.calls.length, 0)
})


test('arbitrary Flow source cannot even be previewed', async () => {
  const s = await fixture(), tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  await assert.rejects(tools.execute({ method: 'flow/preview', params: { root: project.path, source: 'arbitrary shell recipe', vars: {} } }))
  assert.equal(s.calls.length, 0)
})


test('the fence after host tool lookup refuses before journaling a start', async () => {
  const s = await fixture(); await s.approve()
  let synced = true
  const resolve = s.options.resolveTool
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => synced,
    resolveTool: async (call: any) => { const result = await resolve(call); synced = false; return result } })
  const source = (await import('../src/index.js')).leadReviewedResultSource
  const Fenced = LeadToolFencedError
  await assert.rejects(tools.execute({ method: 'flow/start-goal', params: { root: project.path, source, token: 'preview-1', sentence: contract.goal, vars: {}, attended: true } }),
    (error: unknown) => error instanceof Fenced)
  assert.equal(s.journal.state.attempts.size, 0)
  assert.equal(s.calls.length, 0)
})

test('the dispatch fence has the typed fenced error', async () => {
  const s = await fixture()
  let checks = 0
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => ++checks <= 2 })
  const Fenced = LeadToolFencedError
  await assert.rejects(tools.dispatch({ method: 'workspace/open', params: { path: project.path } }, 'dispatch'),
    (error: unknown) => error instanceof Fenced)
  assert.equal(s.calls.length, 0)
})

test('tool resolution itself refuses expired consent', async () => {
  const s = await fixture(); await s.approve(); s.setNow(1000); s.setPreviewExpires(2000)
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  const source = (await import('../src/index.js')).leadReviewedResultSource
  await assert.rejects(tools.resolveTool({ method: 'flow/start-goal', params: { root: project.path, source, token: 'preview-1', sentence: contract.goal, vars: {}, attended: true } }),
    (error: unknown) => error instanceof LeadToolRefusedError)
  assert.equal(s.journal.state.attempts.size, 0)
})
