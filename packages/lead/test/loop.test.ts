import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as lead from '../src/index.js'
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
  ], { stop_reason: 'tool_use' })])
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

test('crash or close mid-send writes off once and still permits reviewed person acceptance', async () => {
  for (const variant of ['crash', 'close']) {
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
  }
})

test('unchanged relevant events preserve one live result at its original revision', async () => {
  const s = await fixture([message([tool('start', 'flow_start_goal', startCall().params)], { stop_reason: 'tool_use' })])
  await s.approve(); s.setEvidence(spendEvidence())
  const loop = exported('createLeadLoop')(s.options); await loop.request(input)
  const first = s.journal.state.cards.find(card => card.type === 'result')!
  for (let i = 0; i < 40; i++) {
    s.emit({ type: 'seat.changed', team: 'team-1', seat: 'seat-1' })
    await s.drain(); await s.tick(); await loop.idle()
  }
  const live = s.journal.state.cards.filter(card => card.type === 'result' && !s.journal.state.decidedCards.includes(`${card.id}:${card.revision}`))
  assert.equal(loop.state.synchronized, true)
  assert.equal(live.length, 1); assert.equal(live[0]!.revision, first.revision)
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
      let invalidations = 0;
      s.journal.invalidateResults = async () => { if (++invalidations > 1) throw Error('writer fault') };
      s.journal.setManagementPhase = async () => { throw Error('writer latched') };
      s.options.desk.synced = async () => { throw Error('observations unavailable') };
      s.emit(variant === 'gap' ? { type: 'gap', reason: 'replace' } : { type: 'card.changed', team: 'team-1', card: 'card-1' });
      await new Promise(resolve => setImmediate(resolve)); await s.tick(); await loop.idle(); await new Promise(resolve => setImmediate(resolve)); await loop.close();
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
