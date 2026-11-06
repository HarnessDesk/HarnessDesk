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

test('start settlement uses the same stable host round identity as recovery', async () => {
  const s = await fixture(); await s.approve()
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  const source = (await import('../src/index.js')).leadReviewedResultSource
  await tools.execute({ method: 'flow/start-goal', params: { root: project.path, source, token: 'preview-1', sentence: contract.goal,
    vars: {}, attended: true, seats: { implement: [contract.steps[0]!.assignments[0]!.seat], review: [contract.steps[0]!.assignments[1]!.seat] } } })
  assert.equal(s.journal.state.budget!.rounds[0]!.roundId, 'run-1:round:1')
})


test('a stored recipe-1 plan can still start its exact frozen source', async () => {
  const { leadReviewedResultSourceFor, LEAD_REVIEWED_RESULT } = await import('../src/index.js')
  assert.equal(LEAD_REVIEWED_RESULT.revision, 'recipe-2')
  const source = leadReviewedResultSourceFor('recipe-1')!
  assert.ok(source && source !== LEAD_REVIEWED_RESULT.source)
  assert.equal(leadReviewedResultSourceFor('recipe-0'), null)
  const s = await fixture()
  const legacy = { ...contract, steps: contract.steps.map(step => ({ ...step, sourceRevision: 'recipe-1' })) }
  await s.journal.offerCard({ version: 1, id: 'legacy', revision: 1, type: 'plan', contractDigest: legacy.digest, contract: legacy })
  await s.journal.decideCard({ version: 1, cardId: 'legacy', cardType: 'plan', expectedRevision: 1, contractDigest: legacy.digest, choice: 'approve' }, 1000)
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true,
    resolveTool: async (call: any) => ({ ...await s.options.resolveTool(call), start: legacy.steps[0],
      preview: { token: 'preview-1', source, expiresAt: 200 } }) })
  const result = await tools.execute({ method: 'flow/start-goal', params: { root: project.path, source, token: 'preview-1', sentence: legacy.goal,
    vars: {}, attended: true, seats: Object.fromEntries(legacy.steps[0]!.assignments.map(assignment => [assignment.role, [assignment.seat]])) } })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(s.journal.state.runs.length, 1)
})

test('recipe-1 preview requires the exact step already stored in the journal contract', async () => {
  const { createLeadJournal, leadReviewedResultSourceFor } = await import('../src/index.js')
  const source = leadReviewedResultSourceFor('recipe-1')!
  const legacy = { ...contract, steps: contract.steps.map(step => ({ ...step, sourceRevision: 'recipe-1' })) }
  const params = { root: project.path, source, vars: {}, attended: true,
    seats: Object.fromEntries(legacy.steps[0]!.assignments.map(assignment => [assignment.role, [assignment.seat]])) }
  for (const variant of ['no contract', 'current recipe', 'wrong step', 'wrong root', 'changed variables', 'changed seats', 'changed attendance', 'stored legacy']) {
    const s = await fixture()
    if (variant === 'current recipe') await s.approve()
    else if (variant !== 'no contract') {
      await s.journal.offerCard({ version: 1, id: 'legacy', revision: 1, type: 'plan', contractDigest: legacy.digest, contract: legacy })
      await s.journal.decideCard({ version: 1, cardId: 'legacy', cardType: 'plan', expectedRevision: 1, contractDigest: legacy.digest, choice: 'approve' }, 1000)
    }
    const journal = await createLeadJournal(s.storage)
    const tools = exported('createLeadTools')({ ...s.options, journal, now: s.options.clock.now, synchronized: () => true,
      resolveTool: async (call: any) => ({ ...await s.options.resolveTool(call), stepId: variant === 'wrong step' ? 'other' : 'work' }) })
    const request = { method: 'flow/preview', params: { ...params,
      ...(variant === 'wrong root' ? { root: '/workspace/other' } : {}),
      ...(variant === 'changed variables' ? { vars: { changed: 'yes' } } : {}),
      ...(variant === 'changed seats' ? { seats: {} } : {}),
      ...(variant === 'changed attendance' ? { attended: false } : {}) } }
    if (variant === 'stored legacy') {
      assert.equal((await tools.execute(request)).outcome, 'succeeded')
      assert.equal(s.calls.at(-1)?.method, 'flow/preview')
      assert.equal(s.calls.at(-1)?.params.source, source)
    } else {
      await assert.rejects(tools.resolveTool(request), (error: unknown) => error instanceof LeadToolRefusedError, variant)
      assert.equal(s.calls.length, 0, variant)
    }
  }
})

test('a current plan cannot start the legacy reviewed source', async () => {
  const { leadReviewedResultSourceFor } = await import('../src/index.js')
  const s = await fixture(); await s.approve()
  const source = leadReviewedResultSourceFor('recipe-1')!
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true,
    resolveTool: async (call: any) => ({ ...await s.options.resolveTool(call), preview: { token: 'preview-1', source, expiresAt: 200 } }) })
  await assert.rejects(tools.resolveTool({ method: 'flow/start-goal', params: { root: project.path, source, token: 'preview-1',
    sentence: contract.goal, vars: {}, attended: true } }), (error: unknown) => error instanceof LeadToolRefusedError)
  assert.equal(s.calls.length, 0)
})


test('a stored recipe-1 attended step previews with attendance omitted', async () => {
  const { createLeadJournal, leadReviewedResultSourceFor } = await import('../src/index.js')
  const s = await fixture()
  const legacy = { ...contract, steps: contract.steps.map(step => ({ ...step, sourceRevision: 'recipe-1' })) }
  await s.journal.offerCard({ version: 1, id: 'legacy', revision: 1, type: 'plan', contractDigest: legacy.digest, contract: legacy })
  await s.journal.decideCard({ version: 1, cardId: 'legacy', cardType: 'plan', expectedRevision: 1, contractDigest: legacy.digest, choice: 'approve' }, 1000)
  const journal = await createLeadJournal(s.storage)
  const tools = exported('createLeadTools')({ ...s.options, journal, now: s.options.clock.now, synchronized: () => true })
  const source = leadReviewedResultSourceFor('recipe-1')!
  const result = await tools.execute({ method: 'flow/preview', params: { root: project.path, source, vars: {},
    seats: Object.fromEntries(legacy.steps[0]!.assignments.map(assignment => [assignment.role, [assignment.seat]])) } })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(s.calls.at(-1)?.method, 'flow/preview')
  assert.equal(s.calls.at(-1)?.params.source, source)
})

test('chat dispatch carries each journal effect id outside model arguments', async () => {
  const s = await fixture(), tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  for (const method of ['lead/chat/start', 'lead/chat/send', 'lead/chat/stop']) {
    const params = { ...(method === 'lead/chat/start' ? {} : { id: 'fixture:chat' }), ...(method === 'lead/chat/stop' ? {} : { text: 'Continue' }) }
    const effectId = `effect-${s.calls.length}`
    await tools.dispatch({ method, params }, effectId)
    assert.equal(s.calls.at(-1).params.effectId, effectId)
    assert.equal('effectId' in params, false)
  }
})
