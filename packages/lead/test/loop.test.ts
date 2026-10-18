import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as lead from '../src/index.js'
import * as protocol from '@harnessdesk/protocol'
import { contract, evidence, exported, fixture, input } from './fixtures/loop.js'
import { message, tool } from './fixtures/fake-messages.js'

test('loop proposes a plan without starting before the authenticated approval', async () => {
  const create = exported('createLeadLoop')
  const s = await fixture([message([{ type: 'text', text: JSON.stringify({ version: 1, type: 'lead-output', plan: contract }) }])])
  const loop = create(s.options)
  await loop.request(input)
  assert.equal(loop.state.phase, 'awaiting-plan')
  assert.equal(s.journal.state.contract, null)
  assert.equal(s.calls.some(c => c.method === 'flow/start-goal'), false)
  assert.deepEqual(s.calls[0].params.topics, ['runs', 'cards', 'teams', 'waiting', 'notices', 'seats', 'reviews'])
  await loop.close()
})

test('ordinary activity bursts cost at most one model request and gaps replace observations without restarting', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' }), message()]), loop = exported('createLeadLoop')(s.options)
  await s.approve(); s.setEvidence({ ...spendEvidence(), reviews: [] }); await loop.request(input)
  for (let i = 0; i < 20; i++) s.emit({ type: 'run.changed', run: 'run-1', team: 'team-1', state: 'running', flow: 'lead-reviewed-result', round: 1, reason: null })
  await s.drain(); await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 2)
  s.setReady(false); s.emit({ type: 'gap', reason: 'lost baseline' }); await s.drain()
  assert.equal(loop.state.synchronized, false)
  await loop.refresh(); assert.equal(loop.state.synchronized, false)
  assert.equal(s.fake.requests.length, 2)
  s.setSnapshot({ teams: [], runs: [], boards: [], seats: [], approvals: [], reviews: [], waiting: [] })
  s.setReady(true); await loop.refresh()
  assert.equal(loop.state.synchronized, true)
  assert.equal(s.calls.filter(c => c.method === 'flow/start-goal').length, 1)
  assert.equal(s.fake.requests.length, 2)
  await loop.close()
})

test('uncertain requests and budget stops halt without another model call', async () => {
  for (const variant of ['uncertain', 'budget']) {
    const s = await fixture(variant === 'uncertain' ? [async () => { throw new Error('lost after send') }] : [message()])
    const loop = exported('createLeadLoop')(s.options)
    if (variant === 'budget') await s.journal.updateBudget({ version: 1, type: 'stop', now: 100, reason: 'budget' })
    await loop.request(input)
    for (let i = 0; i < 10; i++) s.emit({ type: 'notice', team: null, text: 'Activity' })
    await s.drain(); await s.tick(); await loop.request(input)
    assert.equal(s.fake.requests.length, variant === 'budget' ? 0 : 1)
    assert.equal(loop.state.phase, variant === 'budget' ? 'stopped' : 'waiting-for-user')
    assert.ok(loop.state.reason)
    await loop.close()
  }
})

test('replay converts a crash-mid-send reservation to uncertain without settling or retrying', async () => {
  const s = await fixture()
  await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'lost-request', inputTokens: 100, maxOutputTokens: 100,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
  const recovered: any = await lead.createLeadJournal(s.storage)
  assert.equal(s.records.at(-1)!.type, 'budget')
  assert.equal(recovered.state.budget!.requests[0]!.uncertain, false)
  await recovered.recoverUnsettledRequests()
  assert.equal(recovered.state.budget!.requests[0]!.uncertain, true)
  assert.equal(recovered.state.budget!.reservedUsdMicros, 200)
  const count = s.records.length
  await lead.createLeadJournal(s.storage)
  assert.equal(s.records.length, count)
})

test('worker approval events only relay and model result-card prose cannot manufacture acceptance', async () => {
  const s = await fixture([message()]), loop = exported('createLeadLoop')(s.options)
  await s.approve(); await loop.request(input)
  s.setSnapshot({ teams: [], runs: [], boards: [], seats: [], approvals: [], reviews: [], waiting: [
    { id: 'approval-1', team: 'team-1', kind: 'approval', summary: 'Approve command', seat: 'seat-1' }] })
  s.emit({ type: 'waiting', id: 'approval-1', team: 'team-1', kind: 'approval', summary: 'Approve command' })
  await s.drain(); await loop.refresh()
  assert.equal(s.journal.state.cards.some(c => c.type === 'waiting' && c.kind === 'worker-approval'), false)
  assert.equal(s.calls.some(c => c.method.includes('answer') || c.method === 'team/intent'), false)
  await loop.close()
})

test('a recovered paid reservation is written off automatically without a model call', async () => {
  const s = await fixture()
  await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'lost-request', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
  const recovered = await lead.createLeadJournal(s.storage), loop = exported('createLeadLoop')({ ...s.options, journal: recovered })
  await loop.start()
  assert.equal(recovered.state.budget!.requests.length, 0)
  assert.equal(recovered.state.budget!.leadUsdMicros, 2)
  assert.equal(s.fake.requests.length, 0)
  await loop.close()
})

test('a baseline gap stays fenced until every fresh evidence read completes', async () => {
  const s = await fixture(), source = (lead as any).leadReviewedResultSource
  await s.approve()
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  await tools.execute({ method: 'flow/start-goal', params: { root: contract.project.path, source, token: 'preview-1', sentence: contract.goal,
    vars: {}, attended: true, seats: { implement: [contract.steps[0]!.assignments[0]!.seat], review: [contract.steps[0]!.assignments[1]!.seat] } } })
  let release!: (value: unknown) => void
  const loop = exported('createLeadLoop')({ ...s.options, readEvidence: () => new Promise(resolve => { release = resolve }) })
  const reading = loop.start()
  for (let i = 0; i < 100 && !release; i++) await Promise.resolve()
  assert.ok(release)
  assert.equal(loop.state.synchronized, false)
  release(evidence()); await reading
  assert.equal(loop.state.synchronized, true)
  await loop.close()
})

test('refused, rate limited and failed Messages results wait with no event-driven retry', async () => {
  for (const reply of [
    message([], { stop_reason: 'refusal' }),
    { status: 401, processing: 'not-started' as const, body: 'synthetic refusal' },
    { status: 429, processing: 'not-started' as const, retryAfter: '999999', body: '' },
  ]) {
    const s = await fixture([reply]), loop = exported('createLeadLoop')(s.options)
    await loop.request(input)
    assert.equal(loop.state.phase, 'waiting-for-user')
    assert.match(loop.state.reason, /^lead-request-(refused|rate-limited|failed)$/)
    s.emit({ type: 'notice', team: null, text: 'Activity' }); await s.drain(); await s.tick(); await loop.idle()
    assert.equal(s.fake.requests.length, 1)
    await loop.close()
  }
})

const startCall = () => ({ method: 'flow/start-goal', params: { root: contract.project.path, source: (lead as any).leadReviewedResultSource,
  token: 'preview-1', sentence: contract.goal, vars: {}, attended: true,
  seats: { implement: [contract.steps[0]!.assignments[0]!.seat], review: [contract.steps[0]!.assignments[1]!.seat] } } })
const spendEvidence = () => ({ ...evidence(), spend: { version: 1, type: 'observe', now: 100, at: 100, revision: 1,
  source: 'worker-samples', sourceIds: ['sample-1'], goalId: 'team-1', executionIds: ['run-1'], quality: 'known', usdMicros: 1 } })

test('the API brain starts only after subscribing, binds returned execution, and accepts only fresh reviewed facts', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const loop = exported('createLeadLoop')(s.options)
  await loop.request(input)
  assert.deepEqual(s.calls.slice(0, 2).map(call => call.method), ['client/subscribe', 'flow/start-goal'])
  assert.deepEqual(s.journal.state.budget!.executionIds, ['run-1'])
  assert.equal(loop.state.phase, 'waiting-for-user')
  assert.equal(loop.state.acceptance[0].result.status, 'reviewed')
  const card = s.journal.state.cards.find(c => c.type === 'result')!
  assert.ok(card)
  await s.journal.decideCard({ version: 1, cardId: card.id, cardType: 'result', expectedRevision: card.revision,
    contractDigest: contract.digest, choice: 'accept' })
  assert.equal(loop.state.phase, 'accepted')
  s.emit({ type: 'run.changed', run: 'run-1', team: 'team-1', state: 'settled', flow: 'lead-reviewed-result', round: 1, reason: null })
  await s.drain(); await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 1)
  assert.equal(s.calls.filter(call => call.method === 'flow/start-goal').length, 1)
  assert.equal(s.calls.some(call => /publish|merge|delete|wrap|answer/.test(call.method)), false)
  await loop.close()
})

test('stale evidence or a baseline gap invalidates an outstanding result click', async () => {
  for (const variant of ['stale', 'gap']) {
    const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
    await s.approve(); s.setEvidence(spendEvidence())
    const loop = exported('createLeadLoop')(s.options); await loop.request(input)
    const card = s.journal.state.cards.find(c => c.type === 'result')!
    assert.ok(card)
    if (variant === 'stale') { s.setNow(100_000); s.setEvidence({ ...spendEvidence(), observedAt: 0 }); await loop.refresh() }
    else { s.setReady(false); s.emit({ type: 'gap', reason: 'synthetic gap' }); await s.drain(); await loop.idle() }
    await assert.rejects(s.journal.decideCard({ version: 1, cardId: card.id, cardType: 'result', expectedRevision: card.revision,
      contractDigest: contract.digest, choice: 'accept' }))
    assert.notEqual(loop.state.phase, 'accepted')
    assert.equal(s.calls.filter(call => call.method === 'flow/start-goal').length, 1)
    await loop.close()
  }
})

test('untrusted result proposals and worker-answer tools cannot create acceptance authority', async () => {
  const s = await fixture([message([
    { type: 'text', text: JSON.stringify({ version: 1, type: 'lead-output', cards: [{ version: 1, id: 'model-result', revision: 1,
      type: 'result', contractDigest: contract.digest, outcome: 'reviewed', summary: 'All passed', assertions: [], budget: {
        version: 1, revision: 1, caps: contract.caps, leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known', stop: null } }] }) },
    tool('answer', 'approval_answer', {}), tool('done', 'team_intent', { action: 'done' }),
  ], { stop_reason: 'tool_use' }), message()])
  await s.approve(); const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  assert.equal(s.journal.state.cards.some(card => card.type === 'result'), false)
  assert.deepEqual(s.calls.map(call => call.method), ['client/subscribe'])
  assert.equal(loop.state.phase, 'waiting-for-user')
  assert.equal(loop.state.reason, 'lead-tools-refused')
  await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 1)
  await loop.close()
})

test('plans are frozen by a trusted port before a card, and the API brain receives the private recipe', async () => {
  const s = await fixture([message([{ type: 'text', text: JSON.stringify({ version: 1, type: 'lead-output', plan: contract }) }])])
  let frozen = 0
  const loop = exported('createLeadLoop')({ ...s.options, freezePlan: async () => { frozen++; return { ...contract, digest: 'b'.repeat(64) } } })
  await loop.request(input)
  assert.equal(frozen, 1)
  const card = s.journal.state.cards.find(c => c.type === 'plan')!
  assert.equal(card.contractDigest, 'b'.repeat(64))
  assert.ok(JSON.parse(s.fake.requests[0].body).system.includes((lead as any).leadReviewedResultSource))
  await loop.close()
})

test('a refused request while a plan is pending still waits for the user', async () => {
  const s = await fixture([message([{ type: 'text', text: JSON.stringify({ version: 1, type: 'lead-output', plan: contract }) }]),
    { status: 401, processing: 'not-started', body: '' }])
  const loop = exported('createLeadLoop')(s.options)
  await loop.request(input); assert.equal(loop.state.phase, 'awaiting-plan')
  await loop.request(input)
  assert.equal(loop.state.phase, 'waiting-for-user')
  assert.equal(loop.state.reason, 'lead-request-failed')
  await loop.close()
})

test('read-only tool results continue planning without waiting for a desk event', async () => {
  const s = await fixture([message([tool('catalog', 'flow_catalog', { root: contract.project.path })], { stop_reason: 'tool_use' }),
    message([{ type: 'text', text: JSON.stringify({ version: 1, type: 'lead-output', plan: contract }) }])])
  const loop = exported('createLeadLoop')(s.options)
  await loop.request(input)
  await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 2)
  assert.equal(loop.state.phase, 'awaiting-plan')
  const continuation = JSON.parse(s.fake.requests[1].body).messages
  assert.equal(continuation.at(-1).content[0].tool_use_id, 'catalog')
  await loop.close()
})

test('relevant activity invalidates a result before the deferred observation batch runs', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  const card = s.journal.state.cards.find(c => c.type === 'result')!
  s.setEvidence({ ...spendEvidence(), checks: [] })
  s.emit({ type: 'run.changed', run: 'run-1', team: 'team-1', state: 'running', flow: 'lead-reviewed-result', round: 2, reason: null })
  await s.drain()
  assert.ok(s.scheduled.length > 0)
  await assert.rejects(s.journal.decideCard({ version: 1, cardId: card.id, cardType: 'result', expectedRevision: card.revision,
    contractDigest: contract.digest, choice: 'accept' }))
  assert.notEqual(loop.state.phase, 'accepted')
  await loop.close()
})

test('an ordinary event prevents an older in-flight evidence read from restoring an invalidated result', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  let hold = false, release!: (value: unknown) => void
  const loop = exported('createLeadLoop')({ ...s.options, readEvidence: async () => hold ? new Promise(resolve => { release = resolve }) : spendEvidence() })
  await loop.request(input)
  hold = true
  const reading = loop.refresh()
  for (let i = 0; i < 100 && !release; i++) await Promise.resolve()
  assert.ok(release)
  s.emit({ type: 'run.changed', run: 'run-1', team: 'team-1', state: 'running', flow: 'lead-reviewed-result', round: 2, reason: null })
  await s.drain()
  release(spendEvidence()); await reading
  const liveResults = s.journal.state.cards.filter(card => card.type === 'result' && !s.journal.state.decidedCards.includes(`${card.id}:${card.revision}`))
  assert.equal(liveResults.length, 0)
  assert.equal(loop.state.synchronized, false)
  await loop.close()
})

test('missing worker accounting fences acceptance and calls, then automatically resumes when known', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' }), message()])
  await s.approve(); s.setEvidence({ ...evidence(), spendComplete: true, reviews: [] })
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  assert.equal(loop.state.phase, 'running')
  assert.equal(loop.state.reason, 'lead-budget-unknown')
  assert.equal(loop.state.acceptance[0].result.status, 'unknown')
  assert.equal(s.journal.state.cards.some(card => card.type === 'result'), false)
  await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 1)
  s.setEvidence({ ...spendEvidence(), reviews: [] })
  s.emit({ type: 'run.changed', run: 'run-1', team: 'team-1', state: 'running' })
  await s.drain(); await s.tick(); await loop.idle()
  assert.equal(loop.state.phase, 'running')
  assert.equal(s.fake.requests.length, 2)
  await loop.close()
})

test('unchanged notice batches do not exhaust result-card revisions', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  const first = s.journal.state.cards.find(card => card.type === 'result')!
  for (let i = 0; i < 40; i++) {
    s.emit({ type: 'notice', team: null, text: 'Ordinary activity' })
    await s.drain(); await s.tick(); await loop.idle()
  }
  const last = s.journal.state.cards.find(card => card.id === first.id)!
  assert.equal(loop.state.synchronized, true)
  assert.equal(last.revision, first.revision)
  assert.equal(s.journal.state.decidedCards.includes(`${last.id}:${last.revision}`), false)
  assert.equal(s.fake.requests.length, 1)
  await loop.close()
})


test('a gap during a request still settles usage and permits a later reviewed result', async () => {
  let release!: (value: any) => void
  const s = await fixture([() => new Promise(resolve => { release = resolve })])
  await s.approve()
  await exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true }).execute(startCall())
  s.setEvidence({ ...spendEvidence(), reviews: [] })
  const loop = exported('createLeadLoop')(s.options), request = loop.request(input)
  for (let i = 0; i < 500 && !release; i++) await Promise.resolve()
  assert.ok(release)
  s.emit({ type: 'gap', reason: 'baseline replaced' }); await s.drain()
  release(message()); const result = await request; await loop.idle()
  assert.equal(result.status, 'completed')
  assert.equal(s.journal.state.budget!.requests.length, 0)
  s.setEvidence(spendEvidence()); await loop.refresh()
  assert.equal(loop.state.acceptance[0].result.status, 'reviewed')
  assert.ok(s.journal.state.cards.some(card => card.type === 'result'))
  await loop.close()
})

for (const variant of ['crash', 'close']) {
  test(`${variant} mid-send writes off once and still permits reviewed person acceptance`, { timeout: 2000 }, async () => {
    let sent = false
    const s = await fixture([() => { sent = true; return new Promise(() => {}) }])
    await s.approve()
    await exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true }).execute(startCall())
    s.setEvidence({ ...spendEvidence(), reviews: [] })
    let recovered: any
    if (variant === 'crash') {
      await s.journal.updateBudget(spendEvidence().spend as any)
      await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'lost', inputTokens: 100, maxOutputTokens: 100,
        inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
      recovered = await lead.createLeadJournal(s.storage)
    } else {
      const old = exported('createLeadLoop')(s.options), pending = old.request(input)
      for (let i = 0; i < 500 && !sent; i++) await Promise.resolve()
      assert.ok(sent); await old.close(); await pending
      recovered = await lead.createLeadJournal(s.storage)
    }
    const loop = exported('createLeadLoop')({ ...s.options, journal: recovered })
    s.setEvidence(spendEvidence()); await loop.start(); await loop.refresh()
    assert.equal(recovered.state.budget.leadUsdMicros, 200)
    assert.equal(recovered.state.budget.reservedUsdMicros, 0)
    assert.equal(s.records.filter((record: any) => record.type === 'budget' && record.event.type === 'write-off').length, 1)
    const card = recovered.state.cards.find((card: any) => card.type === 'result')!
    assert.ok(card)
    await recovered.decideCard({ version: 1, cardId: card.id, cardType: 'result', expectedRevision: card.revision, contractDigest: contract.digest, choice: 'accept' })
    assert.equal(recovered.state.phase, 'accepted')
    await loop.close()
  })
}

test('fresh same-dollar spend samples preserve one live result at its original revision', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  const first = s.journal.state.cards.find(card => card.type === 'result')!
  const managementCount = s.records.filter(record => record.type === 'management').length
  for (let i = 0; i < 40; i++) {
    const at = 110 + i * 10
    s.setNow(at)
    s.setEvidence({ ...spendEvidence(), observedAt: at, spend: { ...spendEvidence().spend, now: at, at, revision: i + 2 } })
    s.emit({ type: 'seat.changed', team: 'team-1', seat: 'seat-1' })
    await s.drain(); await s.tick(); await loop.idle()
  }
  const live = s.journal.state.cards.filter(card => card.type === 'result' && !s.journal.state.decidedCards.includes(`${card.id}:${card.revision}`))
  assert.equal(loop.state.synchronized, true)
  assert.equal(live.length, 1); assert.equal(live[0]!.revision, first.revision)
  assert.equal(loop.state.reason, 'lead-result-awaiting-person')
  assert.equal(s.records.filter(record => record.type === 'management').length, managementCount)
  await loop.close()
})

test('notices and seat/team changes refresh observations without waking the model', async () => {
  const s = await fixture([message(), message(), message(), message()])
  await s.approve()
  await exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true }).execute(startCall())
  s.setEvidence({ ...spendEvidence(), reviews: [] })
  let refreshes = 0
  const synced = s.options.desk.synced
  s.options.desk.synced = async () => { refreshes++; await synced() }
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  for (const event of [{ type: 'notice', team: null, text: 'Unrelated prose' }, { type: 'notice', team: 'team-1', text: 'Prose' },
    { type: 'seat.changed', team: 'team-1', seat: 'seat-1' }, { type: 'team.changed', team: 'team-1' }]) {
    const before = refreshes
    s.emit(event); await s.drain(); await s.tick(); await loop.idle()
    assert.ok(refreshes > before, event.type + ' refreshes observations')
    assert.equal(s.fake.requests.length, 1, event.type)
  }
  await loop.close()
})

test('background journal failures never produce an unhandled rejection', async () => {
  const { spawnSync } = await import('node:child_process')
  const fixtureUrl = new URL('./fixtures/loop.js', import.meta.url).href
  const leadUrl = new URL('../src/index.js', import.meta.url).href
  const program = `
    import { fixture, input, contract, evidence } from ${JSON.stringify(fixtureUrl)};
    import { createLeadLoop, createLeadTools, leadReviewedResultSource } from ${JSON.stringify(leadUrl)};
    let unhandled = 0; process.on('unhandledRejection', () => { unhandled++ });
    for (const variant of ['gap', 'batch']) {
      const s = await fixture(); await s.approve();
      await createLeadTools({ ...s.options, now: s.options.clock.now, synchronized: () => true }).execute({ method: 'flow/start-goal', params: {
        root: contract.project.path, source: leadReviewedResultSource, token: 'preview-1', sentence: contract.goal, vars: {}, attended: true,
        seats: { implement: [contract.steps[0].assignments[0].seat], review: [contract.steps[0].assignments[1].seat] } } });
      s.setEvidence({ ...evidence(), spend: { version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'worker-samples',
        sourceIds: ['sample-1'], goalId: 'team-1', executionIds: ['run-1'], quality: 'known', usdMicros: 1 } });
      const loop = createLeadLoop(s.options); await loop.request(input);
      let invalidations = 0, queuedRefresh = false, refreshRejected = false;
      s.journal.invalidateResults = async () => {
        if (variant === 'gap' ? queuedRefresh : ++invalidations > 1) { refreshRejected = true; throw Error('writer fault') };
      };
      s.journal.setManagementPhase = async () => { throw Error('writer latched') };
      s.options.desk.synced = async () => { queuedRefresh = true; throw Error('observations unavailable') };
      s.emit(variant === 'gap' ? { type: 'gap', reason: 'replace' } : { type: 'card.changed', team: 'team-1', card: 'card-1' });
      await new Promise(resolve => setImmediate(resolve)); await s.tick(); await loop.idle(); await new Promise(resolve => setImmediate(resolve));
      if (!queuedRefresh || !refreshRejected) throw Error('queued refresh did not reject');
      await loop.close();
    }
    if (unhandled) { console.error('unhandled:', unhandled); process.exitCode = 1 }
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
})


test('journal opens read-only until owner explicitly recovers paid requests', async () => {
  const s = await fixture()
  await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'lost', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
  const count = s.records.length
  const journal: any = await lead.createLeadJournal({ read: s.storage.read, async append() { throw Error('read-only') } })
  assert.equal(journal.state.budget.requests[0].uncertain, false)
  assert.equal(s.records.length, count)
  await assert.rejects(journal.recoverUnsettledRequests())
})

test('request failure reason survives reopen/checkpoint and guarded resume is durable', async () => {
  const s = await fixture([{ status: 401, processing: 'not-started', body: '' }, message()])
  await s.approve()
  const loop = exported('createLeadLoop')(s.options); await loop.request(input); await loop.close()
  const checkpoint = lead.parseLeadCheckpoint(lead.leadCheckpoint(s.journal.state, '0'.repeat(64))).state
  const recovered: any = await lead.createLeadJournal(s.storage)
  const next = exported('createLeadLoop')({ ...s.options, journal: recovered })
  assert.equal(next.state.reason, 'lead-request-failed')
  assert.equal((checkpoint as any).managementReason, 'lead-request-failed')
  await recovered.resume()
  assert.equal(recovered.state.phase, 'running')
  assert.equal(recovered.state.managementReason, null)
  await next.request(input); assert.equal(s.fake.requests.length, 2)
  await assert.rejects(recovered.resume())
  await recovered.stop(); await assert.rejects(recovered.resume())
  await next.close()
})

test('resume refuses terminal phases budget stops and pending plans', async () => {
  for (const variant of ['draft', 'accepted', 'declined', 'stopped', 'budget', 'plan']) {
    const s = await fixture()
    const journal: any = s.journal
    assert.equal(typeof journal.resume, 'function')
    if (variant === 'budget') await journal.updateBudget({ version: 1, type: 'stop', now: 100, reason: 'budget' })
    else if (variant === 'plan' || variant === 'declined') {
      await journal.offerCard({ version: 1, id: 'pending', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
      if (variant === 'declined') await journal.decideCard({ version: 1, cardId: 'pending', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'decline' })
      else await journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
    } else if (variant === 'accepted') {
      await s.approve()
      await journal.offerCard({ version: 1, id: 'result', revision: 1, type: 'result', contractDigest: contract.digest, outcome: 'reviewed', summary: 'Reviewed', assertions: [], budget: lead.leadBudgetProjection(journal.state.budget, 100) })
      await journal.decideCard({ version: 1, cardId: 'result', cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' })
    } else if (variant === 'stopped') await journal.stop()
    await assert.rejects(journal.resume(), variant)
  }
})

const liveResults = (s: Awaited<ReturnType<typeof fixture>>) => s.journal.state.cards.filter(card =>
  card.type === 'result' && !s.journal.state.decidedCards.includes(`${card.id}:${card.revision}`))

test('a refused result offer retries current evidence without restoring an older subject', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  const newer = { ...spendEvidence(), revision: 'head-2', checks: [{ ...evidence().checks[0], id: 'check-2', revision: 'head-2' }],
    reviews: [{ ...evidence().reviews[0], id: 'review-2', revision: 'head-2' }] }
  s.setEvidence(newer)
  const offer = s.journal.offerCard.bind(s.journal)
  let refused = false
  s.journal.offerCard = async card => { if (!refused) { refused = true; throw Error('offer refused') }; return offer(card) }
  await loop.refresh()
  assert.equal(liveResults(s).length, 0)
  await loop.refresh()
  const live: any = liveResults(s)[0]
  assert.equal(live.revision, 2)
  assert.ok(live.assertions.flatMap((fact: any) => fact.evidence).every((ref: any) => ref.revision === 'head-2'))
  await s.journal.decideCard({ version: 1, cardId: live.id, cardType: 'result', expectedRevision: live.revision, contractDigest: contract.digest, choice: 'accept' })
  assert.equal(loop.state.phase, 'accepted')
  await loop.close()
})

test('restore compares the stored card facts with the current result signature', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  const card: any = liveResults(s)[0]
  await s.journal.offerCard({ ...card, revision: 2, assertions: card.assertions.map((fact: any) => ({ ...fact,
    evidence: fact.evidence.map((ref: any) => ({ ...ref, revision: 'older-head' })) })) })
  await s.journal.invalidateResults()
  await loop.refresh()
  const live: any = liveResults(s)[0]
  assert.equal(live.revision, 3)
  assert.ok(live.assertions.flatMap((fact: any) => fact.evidence).every((ref: any) => ref.revision === 'head-1'))
  await loop.close()
})

test('a gap during an approved start keeps a continuation for resync without restarting', async () => {
  let release!: (value: any) => void
  const s = await fixture([() => new Promise(resolve => { release = resolve }), message()])
  await s.approve()
  const loop = exported('createLeadLoop')(s.options), pending = loop.request(input)
  for (let i = 0; i < 500 && !release; i++) await Promise.resolve()
  assert.ok(release)
  s.setReady(false); s.emit({ type: 'gap', reason: 'replace baseline' }); await s.drain()
  release(message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' }))
  await pending; await loop.idle()
  assert.equal(s.calls.filter(call => call.method === 'flow/start-goal').length, 0)
  assert.equal(loop.state.phase, 'running')
  await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 1)
  s.setReady(true); await loop.refresh(); await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 2)
  await s.tick(); await loop.idle(); assert.equal(s.fake.requests.length, 2)
  await loop.close()
})

test('one transient read failure continues instead of waiting for a person', async () => {
  const s = await fixture([message([tool('catalog', 'flow_catalog', { root: contract.project.path })], { stop_reason: 'tool_use' }), message()])
  const call = s.options.desk.call
  s.options.desk.call = async (method: string, params: unknown) => { if (method === 'flow/catalog') throw Error('transient read'); return call(method, params) }
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  assert.equal(loop.state.phase, 'planning')
  await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 2)
  await loop.close()
})

for (const event of [{ type: 'seat.changed', team: 'team-1', seat: 'seat-1' }, { type: 'notice', team: null, text: 'Spend refreshed' }]) {
  test(`clearing the spend fence via ${event.type} wakes the pending continuation exactly once`, async () => {
    const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' }), message()])
    await s.approve(); s.setEvidence({ ...evidence(), reviews: [] })
    const loop = exported('createLeadLoop')(s.options); await loop.request(input)
    await s.tick(); await loop.idle(); assert.equal(s.fake.requests.length, 1)
    s.setEvidence({ ...spendEvidence(), reviews: [] }); s.emit(event)
    await s.drain(); await s.tick(); await loop.idle(); await s.tick(); await loop.idle()
    assert.equal(s.fake.requests.length, 2)
    s.emit(event); await s.drain(); await s.tick(); await loop.idle(); assert.equal(s.fake.requests.length, 2)
    await loop.close()
  })
}

test('a recovered reservation crossing the cap immediately reports a budget stop', async () => {
  const s = await fixture()
  await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'lost', inputTokens: 50_000, maxOutputTokens: 50_000,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
  const loop = exported('createLeadLoop')(s.options); await loop.start()
  assert.equal(loop.state.phase, 'stopped')
  assert.equal(loop.state.reason, 'lead-budget-stopped')
  assert.ok(s.journal.state.stopEffectsPending)
  assert.equal(s.fake.requests.length, 0)
  await loop.close()
})

test('repeated relevant events do not append duplicate management waits', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  const count = s.records.filter(record => record.type === 'management').length
  for (let i = 0; i < 5; i++) { s.emit({ type: 'seat.changed', team: 'team-1', seat: 'seat-1' }); await s.drain(); await s.tick(); await loop.idle() }
  assert.equal(s.records.filter(record => record.type === 'management').length, count)
  await loop.close()
})

test('permission-gate denials still park an all-refused turn', async () => {
  const s = await fixture([message([tool('catalog', 'flow_catalog', { root: contract.project.path })], { stop_reason: 'tool_use' })])
  await s.journal.setPolicy({ version: 1, revision: 2, mode: 'manage', rules: [{ id: 'deny', method: 'flow/catalog', action: null, project: null, effect: 'deny' }] })
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  assert.equal(loop.state.phase, 'waiting-for-user')
  assert.equal(loop.state.reason, 'lead-tools-refused')
  await s.tick(); await loop.idle(); assert.equal(s.fake.requests.length, 1)
  await loop.close()
})

test('a result at the revision cap stays invalid after repeated refused offers', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  for (let revision = 2; revision <= 33; revision++) {
    const head = `head-${revision}`
    s.setEvidence({ ...spendEvidence(), revision: head,
      checks: [{ ...evidence().checks[0], id: `check-${revision}`, revision: head }],
      reviews: [{ ...evidence().reviews[0], id: `review-${revision}`, revision: head }] })
    await loop.refresh()
  }
  await loop.refresh()
  assert.equal(loop.state.synchronized, false)
  assert.equal(liveResults(s).length, 0)
  assert.equal(loop.state.reason, 'lead-result-revisions-exhausted')
  assert.equal(s.journal.state.managementReason, 'lead-result-revisions-exhausted')
  const reopened = await lead.createLeadJournal(s.storage)
  assert.equal(reopened.state.managementReason, 'lead-result-revisions-exhausted')
  const checkpoint = lead.parseLeadCheckpoint(lead.leadCheckpoint(reopened.state, '0'.repeat(64)))
  assert.equal(checkpoint.state.managementReason, 'lead-result-revisions-exhausted')
  const old = s.journal.state.cards.find(card => card.type === 'result')!
  assert.equal(old.revision, 32)
  await assert.rejects(s.journal.decideCard({ version: 1, cardId: old.id, cardType: 'result', expectedRevision: old.revision, contractDigest: contract.digest, choice: 'accept' }))
  assert.notEqual(loop.state.phase, 'accepted')
  await loop.close()
})

test('a Messages settlement crossing the cap reports its stop immediately', async () => {
  const s = await fixture()
  const loop = exported('createLeadLoop')(s.options); await loop.start()
  await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'paid', inputTokens: 50_000, maxOutputTokens: 50_000,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
  await s.journal.updateBudget({ version: 1, type: 'settle', now: 100, requestId: 'paid', inputTokens: 50_000, outputTokens: 50_000 })
  assert.equal(loop.state.phase, 'stopped')
  assert.equal(loop.state.reason, 'lead-budget-stopped')
  assert.ok(s.journal.state.stopEffectsPending)
  await loop.close()
})

test('a successful tool result beyond the continuation budget does not park the goal', async () => {
  const s = await fixture([message([tool('usage', 'library_usage')], { stop_reason: 'tool_use' }), message()])
  const call = s.options.desk.call
  s.options.desk.call = async (method: string, params: unknown) => method === 'library/usage' ? 'x'.repeat(15_000) : call(method, params)
  const loop = exported('createLeadLoop')(s.options)
  const result = await loop.request({ ...input, messages: [{ role: 'user', content: Array.from({ length: 64 }, () => ({ type: 'text', text: 'x'.repeat(16_200) })) }] })
  assert.equal(result.status, 'completed')
  assert.equal(result.toolResults[0].content, 'Tool refused')
  assert.equal([...s.journal.state.attempts.values()].find(attempt => attempt.method === 'library/usage')!.outcome, 'succeeded')
  assert.equal(loop.state.phase, 'planning')
  await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 2)
  await loop.close()
})

for (const variant of ['expired consent', 'wrong recipe', 'unknown tool', 'malformed arguments', 'host scope', 'dispatch scope']) {
  test(`${variant} parks after one refused tool turn`, async () => {
    const use = variant === 'unknown tool' ? tool('refused', 'approval_answer', {})
      : variant === 'malformed arguments' ? tool('refused', 'flow_catalog', { root: 3 })
      : variant === 'host scope' || variant === 'dispatch scope' ? tool('refused', 'flow_catalog', { root: contract.project.path })
      : tool('refused', 'flow_start_goal', { ...startCall().params, ...(variant === 'wrong recipe' ? { source: 'wrong recipe' } : {}) })
    const s = await fixture([message([use], { stop_reason: 'tool_use' }), message()])
    await s.approve()
    if (variant === 'expired consent') s.setNow(2000)
    const resolve = s.options.resolveTool
    let resolutions = 0
    s.options.resolveTool = async (call: any) => {
      if (call.method === 'flow/catalog' && ++resolutions >= (variant === 'dispatch scope' ? 2 : 1)) throw Error('host scope refused')
      return resolve(call)
    }
    const loop = exported('createLeadLoop')(s.options); await loop.request(input)
    assert.equal(loop.state.phase, 'waiting-for-user')
    assert.equal(loop.state.reason, 'lead-tools-refused')
    await s.tick(); await loop.idle()
    assert.equal(s.fake.requests.length, 1)
    assert.equal(s.calls.filter(call => call.method === 'flow/start-goal' || call.method === 'flow/catalog').length, 0)
    await loop.close()
  })
}

test('three consecutive transient read failures park without a fourth request', async () => {
  const s = await fixture(Array.from({ length: 4 }, (_, i) => message([tool(`read-${i}`, 'flow_catalog', { root: contract.project.path })], { stop_reason: 'tool_use' })))
  const call = s.options.desk.call
  s.options.desk.call = async (method: string, params: unknown) => { if (method === 'flow/catalog') throw Error('read failed'); return call(method, params) }
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  for (let i = 0; i < 4; i++) { await s.tick(); await loop.idle() }
  assert.equal(s.fake.requests.length, 3)
  assert.equal(loop.state.phase, 'waiting-for-user')
  assert.equal(loop.state.reason, 'lead-tools-refused')
  await loop.close()
})

test('a successful tool resets the consecutive no-progress bound', async () => {
  const s = await fixture(Array.from({ length: 7 }, (_, i) => message([tool(`read-${i}`, 'flow_catalog', { root: contract.project.path })], { stop_reason: 'tool_use' })))
  const call = s.options.desk.call
  let reads = 0
  s.options.desk.call = async (method: string, params: unknown) => {
    if (method === 'flow/catalog' && ++reads !== 3) throw Error('read failed')
    return call(method, params)
  }
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  for (let i = 0; i < 7; i++) { await s.tick(); await loop.idle() }
  assert.equal(s.fake.requests.length, 6)
  assert.equal(loop.state.reason, 'lead-tools-refused')
  await loop.close()
})

test('a fenced batch preserves a continuation until a notice clears the fence', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' }), message()])
  await s.approve(); s.setEvidence({ ...evidence(), reviews: [] })
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  s.emit({ type: 'notice', team: null, text: 'Spend still missing' }); await s.drain(); await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 1)
  assert.equal(s.scheduled.length, 0)
  s.setEvidence({ ...spendEvidence(), reviews: [] }); s.emit({ type: 'notice', team: null, text: 'Fresh spend' })
  await s.drain(); await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 2)
  await loop.close()
})

for (const fence of ['batch', 'gap']) {
  test(`dirty activity survives a ${fence} without a pending tool continuation`, async () => {
    const s = await fixture([message(), message()])
    await s.approve(); s.setEvidence({ ...spendEvidence(), reviews: [] })
    const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
    assert.equal((await tools.execute(startCall())).outcome, 'succeeded')
    const loop = exported('createLeadLoop')(s.options); await loop.request(input)
    assert.equal(s.scheduled.length, 0)
    s.setReady(false); s.emit({ type: 'run.changed', run: 'run-1', team: 'team-1' }); await s.drain()
    if (fence === 'gap') { s.emit({ type: 'gap', reason: 'new baseline' }); await s.drain() }
    await s.tick(); await loop.idle()
    assert.equal(s.fake.requests.length, 1)
    assert.equal(s.scheduled.length, 0)
    s.setReady(true); s.emit({ type: 'notice', team: null, text: 'Baseline ready' })
    await s.drain(); await s.tick(); await loop.idle()
    assert.equal(s.fake.requests.length, 2)
    await loop.close()
  })
}

test('a pending continuation survives a gap before its batch runs', async () => {
  const s = await fixture([message([tool('catalog', 'flow_catalog', { root: contract.project.path })], { stop_reason: 'tool_use' }), message()])
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  assert.equal(s.scheduled.length, 1)
  s.setReady(false); s.emit({ type: 'gap', reason: 'new baseline' }); await s.drain(); await loop.idle()
  assert.equal(s.scheduled.length, 0)
  assert.equal(s.fake.requests.length, 1)
  s.setReady(true); await loop.refresh(); await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 2)
  await s.tick(); await loop.idle(); assert.equal(s.fake.requests.length, 2)
  await loop.close()
})

test('refresh schedules no callbacks while a pending continuation is spend-fenced', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' }), message()])
  await s.approve(); s.setEvidence({ ...evidence(), reviews: [] })
  let scheduled = 0
  const schedule = s.options.clock.schedule
  s.options.clock.schedule = (callback: () => void) => { scheduled++; return schedule(callback) }
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  for (let i = 0; i < 3; i++) { await loop.refresh(); await s.tick(); await loop.idle() }
  assert.equal(scheduled, 0)
  assert.equal(s.fake.requests.length, 1)
  s.setEvidence({ ...spendEvidence(), reviews: [] }); await loop.refresh()
  assert.equal(scheduled, 1)
  await s.tick(); await loop.idle(); assert.equal(s.fake.requests.length, 2)
  await loop.close()
})

test('a refused same-evidence offer resets the signature instead of restoring the stored card', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  const offer = s.journal.offerCard.bind(s.journal)
  let offers = 0
  s.journal.offerCard = async card => { if (++offers <= 2) throw Error('offer refused'); return offer(card) }
  s.setEvidence({ ...spendEvidence(), revision: 'head-2', checks: [{ ...evidence().checks[0], revision: 'head-2' }],
    reviews: [{ ...evidence().reviews[0], revision: 'head-2' }] })
  await loop.refresh(); assert.equal(liveResults(s).length, 0)
  s.setEvidence(spendEvidence())
  await loop.refresh(); assert.equal(liveResults(s).length, 0)
  await loop.refresh()
  assert.equal(offers, 3)
  assert.equal(liveResults(s)[0]!.revision, 2)
  await loop.close()
})

test('the result-revision exhaustion reason is shared by protocol, record and checkpoint parsing', async () => {
  const reasons = (protocol as Record<string, unknown>).LEAD_MANAGEMENT_REASONS
  assert.ok(Array.isArray(reasons) && reasons.includes('lead-result-revisions-exhausted'))
  const s = await fixture()
  await s.journal.setManagementPhase('waiting-for-user', 'lead-result-revisions-exhausted')
  const reopened = await lead.createLeadJournal(s.storage)
  assert.equal(reopened.state.managementReason, 'lead-result-revisions-exhausted')
  const checkpoint = lead.parseLeadCheckpoint(lead.leadCheckpoint(reopened.state, '0'.repeat(64)))
  assert.equal(checkpoint.state.managementReason, 'lead-result-revisions-exhausted')
})


test('text-only turns leave the no-progress counter alone', async () => {
  const s = await fixture([message(), message(), message([tool('read', 'flow_catalog', { root: contract.project.path })], { stop_reason: 'tool_use' }), message()])
  const call = s.options.desk.call
  s.options.desk.call = async (method: string, params: unknown) => { if (method === 'flow/catalog') throw Error('transient'); return call(method, params) }
  const loop = exported('createLeadLoop')(s.options)
  await loop.request(input); await loop.request(input); await loop.request(input)
  assert.equal(loop.state.phase, 'planning')
  await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 4)
  await loop.close()
})

test('a person resume resets the no-progress bound', async () => {
  const s = await fixture([...Array.from({ length: 4 }, (_, i) => message([tool(`read-${i}`, 'flow_catalog', { root: contract.project.path })], { stop_reason: 'tool_use' })), message()])
  const call = s.options.desk.call
  s.options.desk.call = async (method: string, params: unknown) => { if (method === 'flow/catalog') throw Error('transient'); return call(method, params) }
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  for (let i = 0; i < 3; i++) { await s.tick(); await loop.idle() }
  assert.equal(loop.state.phase, 'waiting-for-user')
  await s.journal.resume(); await loop.request(input)
  assert.equal(loop.state.phase, 'running')
  await s.tick(); await loop.idle()
  assert.equal(s.fake.requests.length, 5)
  await loop.close()
})

test('three oversized successful reads park without a fourth request', async () => {
  const s = await fixture(Array.from({ length: 5 }, (_, i) => message([tool(`usage-${i}`, 'library_usage')], { stop_reason: 'tool_use' })))
  const call = s.options.desk.call
  s.options.desk.call = async (method: string, params: unknown) => method === 'library/usage' ? 'x'.repeat(15_000) : call(method, params)
  const loop = exported('createLeadLoop')(s.options)
  await loop.request({ ...input, messages: [{ role: 'user', content: Array.from({ length: 64 }, () => ({ type: 'text', text: 'x'.repeat(16_200) })) }] })
  for (let i = 0; i < 4; i++) { await s.tick(); await loop.idle() }
  assert.equal(s.fake.requests.length, 3)
  assert.equal(loop.state.reason, 'lead-tools-refused')
  await loop.close()
})

test('a permanent refusal counts as no progress even beside a successful tool', async () => {
  const s = await fixture(Array.from({ length: 5 }, (_, i) => message([tool(`read-${i}`, 'flow_catalog', { root: contract.project.path }), tool(`start-${i}`, 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })))
  await s.approve(); s.setNow(2000)
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  for (let i = 0; i < 4; i++) { await s.tick(); await loop.idle() }
  assert.equal(s.fake.requests.length, 3)
  assert.equal(loop.state.reason, 'lead-tools-refused')
  assert.equal(s.calls.filter(call => call.method === 'flow/start-goal').length, 0)
  await loop.close()
})


test('an oversized plan refusal parks with its typed reason rather than hanging', async () => {
  const s = await fixture([message([{ type: 'text', text: JSON.stringify({ version: 1, type: 'lead-output', plan: contract }) }])])
  s.journal.offerCard = async () => { throw Object.assign(new Error('lead-card-too-large'), { wireCode: 'lead-card-too-large' }) }
  const loop = exported('createLeadLoop')(s.options)
  try {
    await loop.request(input)
    assert.equal(loop.state.phase, 'waiting-for-user')
    assert.equal(loop.state.reason, 'lead-card-too-large')
    assert.equal(s.journal.state.managementReason, 'lead-card-too-large')
    assert.equal(s.journal.state.cards.length, 0)
  } finally { await loop.close() }
})

test('an oversized host result parks with the typed admission reason', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const offer = s.journal.offerCard.bind(s.journal)
  s.journal.offerCard = async (card: any) => {
    if (card.type === 'result') throw Object.assign(new Error('lead-card-too-large'), { wireCode: 'lead-card-too-large' })
    return offer(card)
  }
  const loop = exported('createLeadLoop')(s.options)
  try {
    await loop.request(input)
    assert.equal(loop.state.phase, 'waiting-for-user')
    assert.equal(loop.state.reason, 'lead-card-too-large')
    assert.equal(s.journal.state.managementReason, 'lead-card-too-large')
    assert.equal(s.journal.state.cards.some(card => card.type === 'result'), false)
  } finally { await loop.close() }
})


test('the chosen Lead name enters the system prompt without changing authority', async () => {
  const s = await fixture([message()])
  await (s.journal as any).settingsChanged('lex')
  const before = s.journal.state.policy
  const loop = exported('createLeadLoop')(s.options)
  await loop.request(input)
  assert.match(JSON.stringify(s.fake.requests[0]), /Your name is Lex\./)
  assert.deepEqual(s.journal.state.policy, before)
  await loop.close()
})


test('a premature predecessor refusal stays transient without waiting for a person', async () => {
  const s = await fixture([message([tool('premature', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  const second = { ...contract.steps[0]!, id: 'second' }
  const two = protocol.parseLeadAcceptanceContract({ ...contract, steps: [...contract.steps, second] })
  await s.journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: two.digest, contract: two })
  await s.journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: two.digest, choice: 'approve' }, 1000)
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  await tools.execute(startCall())
  s.setEvidence({ ...spendEvidence(), reviews: [] })
  const resolve = s.options.resolveTool
  s.options.resolveTool = async (call: any) => ({ ...await resolve(call), stepId: 'second', start: second, predecessor: { runId: 'run-1', ready: false } })
  const loop = exported('createLeadLoop')(s.options)
  try {
    const result = await loop.request(input)
    const attempt = [...s.journal.state.attempts.values()].find(one => one.stepId === 'second' && one.method === 'flow/start-goal')!
    assert.equal(attempt.outcome, 'denied')
    assert.equal(attempt.dispatched, false)
    assert.deepEqual(result.transientTools, ['premature'])
    assert.equal(s.journal.state.phase, 'running')
    assert.equal(s.calls.filter(call => call.method === 'flow/start-goal').length, 1)
  } finally { await loop.close() }
})


for (const permanent of [false, true]) test(`a retrying premature start waits for desk activity without paid continuations${permanent ? ' while preserving unrelated permanent refusals' : ''}`, async () => {
  const retry = message([tool('status', 'flow_execution', { run: 'run-1' }), tool('premature', 'flow_start_goal', startCall().params),
    ...(permanent ? [tool('invalid', 'unknown_tool')] : [])], { stop_reason: 'tool_use' })
  const s = await fixture(Array.from({ length: 8 }, () => structuredClone(retry)))
  const second = { ...contract.steps[0]!, id: 'second' }
  const two = protocol.parseLeadAcceptanceContract({ ...contract, steps: [...contract.steps, second] })
  await s.journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: two.digest, contract: two })
  await s.journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: two.digest, choice: 'approve' }, 1000)
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  await tools.execute(startCall()); s.setEvidence({ ...spendEvidence(), reviews: [] })
  let ready = false
  const resolve = s.options.resolveTool
  s.options.resolveTool = async (call: any) => ({ ...await resolve(call), stepId: 'second', start: second, predecessor: { runId: 'run-1', ready } })
  const call = s.options.desk.call
  s.options.desk.call = async (method: string, params: unknown) => method === 'flow/start-goal'
    ? { id: 'run-2', goal: 'team-2', rounds: [{ n: 1 }], state: 'running' } : call(method, params)
  const loop = exported('createLeadLoop')(s.options)
  try {
    await loop.start()
    const first = await loop.request(input)
    assert.equal(first.toolResults.find((tool: any) => tool.tool_use_id === 'premature').content, 'Step 1 is not yet awaiting acceptance; wait for desk activity.')
    for (let i = 0; i < 5; i++) await s.tick()
    assert.equal(s.fake.requests.length, 1, 'only one provider request between desk changes')
    assert.notEqual(s.journal.state.managementReason, 'lead-tools-refused')
    s.emit({ type: 'run.changed', run: 'run-1' }); await s.drain(); await s.tick(); await loop.idle()
    for (let i = 0; i < 5; i++) await s.tick()
    assert.equal(s.fake.requests.length, 2)
    assert.notEqual(s.journal.state.managementReason, 'lead-tools-refused')
    ready = !permanent
    s.emit({ type: 'run.changed', run: 'run-1' }); await s.drain(); await s.tick(); await loop.idle()
    if (permanent) { assert.equal(s.journal.state.managementReason, 'lead-tools-refused'); return }
    assert.equal(s.journal.state.steps[1]!.state, 'started')
    assert.equal(s.journal.state.runs[1]!.runId, 'run-2')
  } finally { await loop.close() }
})

test('a start-only retry does not count refusals across three desk changes', async () => {
  const retry = message([tool('premature', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })
  const s = await fixture(Array.from({ length: 8 }, () => structuredClone(retry)))
  const second = { ...contract.steps[0]!, id: 'second' }
  const two = protocol.parseLeadAcceptanceContract({ ...contract, steps: [...contract.steps, second] })
  await s.journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: two.digest, contract: two })
  await s.journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: two.digest, choice: 'approve' }, 1000)
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  await tools.execute(startCall()); s.setEvidence({ ...spendEvidence(), reviews: [] })
  let ready = false
  const resolve = s.options.resolveTool
  s.options.resolveTool = async (call: any) => ({ ...await resolve(call), stepId: 'second', start: second, predecessor: { runId: 'run-1', ready } })
  const call = s.options.desk.call
  s.options.desk.call = async (method: string, params: unknown) => method === 'flow/start-goal'
    ? { id: 'run-2', goal: 'team-2', rounds: [{ n: 1 }], state: 'running' } : call(method, params)
  const loop = exported('createLeadLoop')(s.options)
  try {
    await loop.start()
    const first = await loop.request(input)
    assert.equal(first.toolResults.find((tool: any) => tool.tool_use_id === 'premature').content, 'Step 1 is not yet awaiting acceptance; wait for desk activity.')
    for (let i = 0; i < 5; i++) await s.tick()
    assert.equal(s.fake.requests.length, 1, 'only one provider request between desk changes')
    assert.notEqual(s.journal.state.managementReason, 'lead-tools-refused')
    for (let change = 0; change < 3; change++) {
      s.emit({ type: 'run.changed', run: 'run-1' }); await s.drain(); await s.tick(); await loop.idle()
      for (let i = 0; i < 5; i++) await s.tick()
      assert.equal(s.fake.requests.length, change + 2)
      assert.notEqual(s.journal.state.managementReason, 'lead-tools-refused')
      assert.equal(s.journal.state.phase, 'running')
    }
    ready = true
    s.emit({ type: 'run.changed', run: 'run-1' }); await s.drain(); await s.tick(); await loop.idle()
    assert.equal(s.journal.state.steps[1]!.state, 'started')
    assert.equal(s.journal.state.runs[1]!.runId, 'run-2')
  } finally { await loop.close() }
})

test('a declined predecessor acceptance parks step 2 immediately', async () => {
  const s = await fixture([message([tool('premature', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  const second = { ...contract.steps[0]!, id: 'second' }
  const two = protocol.parseLeadAcceptanceContract({ ...contract, steps: [...contract.steps, second] })
  await s.journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: two.digest, contract: two })
  await s.journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: two.digest, choice: 'approve' }, 1000)
  const tools = exported('createLeadTools')({ ...s.options, now: s.options.clock.now, synchronized: () => true })
  await tools.execute(startCall())
  s.setEvidence({ ...spendEvidence(), reviews: [] })
  const resolve = s.options.resolveTool
  s.options.resolveTool = async (call: any) => ({ ...await resolve(call), stepId: 'second', start: second, predecessor: { runId: 'run-1', ready: false, terminal: true } })
  const loop = exported('createLeadLoop')(s.options)
  try {
    const result = await loop.request(input)
    const attempt = [...s.journal.state.attempts.values()].find(one => one.stepId === 'second' && one.method === 'flow/start-goal')!
    assert.equal(attempt.outcome, 'denied')
    assert.equal(attempt.dispatched, false)
    assert.deepEqual(result.deskActivityTools, [])
    assert.equal(s.journal.state.phase, 'waiting-for-user')
    assert.equal(s.journal.state.managementReason, 'lead-predecessor-unavailable')
    assert.equal(s.calls.filter(call => call.method === 'flow/start-goal').length, 1)
  } finally { await loop.close() }
})
