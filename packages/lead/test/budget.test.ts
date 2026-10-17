import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as lead from '../src/index.js'

const api = (name: string): any => {
  const fn = (lead as Record<string, unknown>)[name]
  assert.equal(typeof fn, 'function', `${name} must implement durable budget admission`)
  return fn
}
const init = { version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: { usdMicros: 100, rounds: 3 }, freshnessMs: 50 }
const reserve = (requestId: string, outputTokens = 60) => ({ version: 1, type: 'reserve', now: 100, requestId,
  inputTokens: 10, maxOutputTokens: outputTokens, inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
const settle = (requestId: string, outputTokens = 20) => ({ version: 1, type: 'settle', now: 100, requestId, inputTokens: 10, outputTokens })
const bind = (executionId: string) => ({ version: 1, type: 'bind', now: 100, goalId: 'goal-1', executionId })
const observe = (patch: Record<string, unknown> = {}) => ({ version: 1, type: 'observe', now: 100, at: 100,
  revision: 1, source: 'insight/goal', sourceIds: ['corpus-1'], goalId: 'goal-1', executionIds: ['run-1'], quality: 'known', usdMicros: 20, ...patch })
const reduce = (state: any, event: unknown) => api('reduceLeadBudget')(state, event)
const projection = (state: any, now = 100) => api('leadBudgetProjection')(state, now)
const memory = () => ({ records: [] as any[], fail: false,
  async read() { return structuredClone(this.records) },
  async append(record: any) { if (this.fail) throw new Error('synthetic append failure'); this.records.push(structuredClone(record)) } })
const open = (storage: ReturnType<typeof memory>) => lead.createLeadJournal(storage)

test('concurrent requests cannot reserve the same remaining allowance', async () => {
  const storage = memory(), journal: any = await open(storage)
  assert.equal(typeof journal.updateBudget, 'function', 'journal must serialize budget admission')
  await journal.updateBudget(init)
  let effects = 0
  const outcomes = await Promise.allSettled(['request-1', 'request-2'].map(id => journal.updateBudget(reserve(id)).then(() => { effects++ })))
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(effects, 1)
  assert.equal(projection(journal.state.budget).reservedUsdMicros, 70)
})

test('input tokens and fractional prices are rounded up before reservation', () => {
  const state = reduce(reduce(null, init), { ...reserve('request-1', 1), inputTokens: 1,
    inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 1, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 1 })
  assert.equal(projection(state).reservedUsdMicros, 2)
  assert.throws(() => reduce(state, { ...reserve('overflow'), inputUsdMicrosPerMillion: Number.MAX_SAFE_INTEGER }))
})

test('duplicate usage never spends twice and inconsistent usage refuses', () => {
  const state = reduce(reduce(reduce(null, init), reserve('request-1')), settle('request-1'))
  assert.equal(projection(state).leadUsdMicros, 30)
  assert.equal(projection(state).reservedUsdMicros, 0)
  assert.deepEqual(reduce(state, settle('request-1')), state)
  assert.throws(() => reduce(state, settle('request-1', 21)))
  assert.throws(() => reduce(state, reserve('request-1')))
})

test('an uncertain paid request retains its reservation and blocks until settled', () => {
  let state = reduce(reduce(null, init), reserve('request-1'))
  state = reduce(state, { version: 1, type: 'uncertain', now: 100, requestId: 'request-1' })
  assert.equal(projection(state).spend, 'unknown')
  assert.equal(projection(state).reservedUsdMicros, 70)
  assert.throws(() => reduce(state, reserve('request-2', 1)))
  assert.equal(projection(reduce(state, settle('request-1'))).spend, 'known')
  assert.equal(reduce(state, { ...settle('request-1'), outputTokens: 61 }).leadUsdMicros, 71)
})

test('replacement and repair executions never reset logical-goal rounds', () => {
  let state = reduce(null, init)
  for (const executionId of ['run-1', 'run-2', 'run-3']) {
    state = reduce(state, bind(executionId))
    state = reduce(state, observe({ revision: state.revision, executionIds: state.executionIds, usdMicros: 0 }))
    state = reduce(state, { version: 1, type: 'round', now: 100, executionId, roundId: 'round-1' })
  }
  assert.equal(projection(state).roundsAdmitted, 3)
  assert.equal(projection(state).stop, null)
  assert.throws(() => reduce(state, { version: 1, type: 'round', now: 100, executionId: 'run-3', roundId: 'round-2' }))
  assert.deepEqual(reduce(state, { version: 1, type: 'round', now: 100, executionId: 'run-3', roundId: 'round-1' }), state)
  assert.throws(() => reduce(state, { ...bind('run-other'), goalId: 'different-goal' }))
})

test('money equality refuses dispatch and round equality refuses only the next round', () => {
  let state = reduce(reduce(null, init), reserve('request-1', 90))
  assert.equal(projection(state).reservedUsdMicros, 100)
  assert.throws(() => reduce(state, reserve('request-2', 0)))
  state = reduce(state, settle('request-1', 90))
  assert.equal(projection(state).stop.reason, 'budget')
  assert.throws(() => reduce(state, reserve('request-3', 0)))
  let rounds = reduce(null, { ...init, caps: { usdMicros: 100, rounds: 1 } })
  rounds = reduce(rounds, bind('run-1'))
  rounds = reduce(rounds, observe({ usdMicros: 0 }))
  rounds = reduce(rounds, { version: 1, type: 'round', now: 100, executionId: 'run-1', roundId: 'round-1' })
  assert.doesNotThrow(() => reduce(rounds, reserve('request-1', 0)))
  assert.throws(() => reduce(rounds, { version: 1, type: 'round', now: 100, executionId: 'run-1', roundId: 'round-2' }))
})

test('overlapping worker observations replace instead of adding and never erase spend', () => {
  let state = reduce(reduce(null, init), bind('run-1'))
  state = reduce(state, observe())
  state = reduce(state, observe({ source: 'worker-samples', sourceIds: ['transcript-1'] }))
  assert.equal(projection(state).workerUsdMicros, 20)
  state = reduce(state, observe({ revision: 2, usdMicros: 10 }))
  assert.equal(projection(state).workerUsdMicros, 20)
  assert.notEqual(projection(state).spend, 'known')
  state = reduce(state, observe({ revision: 3, usdMicros: 25 }))
  assert.equal(projection(state).workerUsdMicros, 25)
  assert.equal(projection(state).spend, 'known')
})

for (const quality of ['unknown', 'stale', 'partial', 'ambiguous']) test(`${quality} worker spend blocks dispatch without becoming zero`, () => {
  let state = reduce(reduce(null, init), bind('run-1'))
  state = reduce(state, observe())
  state = reduce(state, observe({ revision: 2, quality, sourceIds: [], usdMicros: null }))
  assert.equal(projection(state).workerUsdMicros, 20)
  assert.notEqual(projection(state).spend, 'known')
  assert.throws(() => reduce(state, reserve('request-1', 1)))
  state = reduce(state, observe({ revision: 3, usdMicros: 30 }))
  assert.equal(projection(state).spend, 'known')
  assert.equal(projection(state, 151).spend, 'stale')
})

test('incomplete coverage and a new execution fail closed until observed', () => {
  let state = reduce(reduce(null, init), bind('run-1'))
  assert.notEqual(projection(state).spend, 'known')
  state = reduce(state, observe())
  state = reduce(state, bind('run-2'))
  assert.notEqual(projection(state).spend, 'known')
  state = reduce(state, observe({ revision: 2 }))
  assert.notEqual(projection(state).spend, 'known')
  assert.throws(() => reduce(state, reserve('request-1', 1)))
  assert.throws(() => reduce(state, observe({ revision: 3, goalId: 'unbound-goal' })))
})

test('budget stop is durable before effects and survives crash and reopen', async () => {
  const storage = memory(), journal: any = await open(storage)
  assert.equal(typeof journal.updateBudget, 'function')
  await journal.updateBudget(init)
  await journal.updateBudget(bind('run-1'))
  await journal.updateBudget(observe({ usdMicros: 0 }))
  await journal.updateBudget(observe({ revision: 2, usdMicros: 100 }), async () => {
    const recovered: any = await open(storage)
    assert.equal(recovered.state.phase, 'stopped')
    assert.equal(recovered.state.budget.stop.reason, 'budget')
    throw new Error('crash during stop effects')
  })
  assert.equal(journal.stopEffectFailure.reason, 'stop-effects-failed')
  const recovered: any = await open(storage)
  await assert.rejects(recovered.updateBudget(reserve('request-1')))
  assert.equal(recovered.state.budget.workerUsdMicros, 100)
})

test('failed budget append prevents reservation and stop effects', async () => {
  const storage = memory(), journal: any = await open(storage)
  assert.equal(typeof journal.updateBudget, 'function')
  await journal.updateBudget(init)
  storage.fail = true
  let effects = 0
  await assert.rejects(journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 0, rounds: 3 } }, async () => { effects++ }))
  assert.equal(effects, 0)
  assert.equal((await open({ ...storage, fail: false }) as any).state.budget.stop, null)
})

test('tightening stops immediately; widening requires a current card and never restarts', async () => {
  const storage = memory(), journal: any = await open(storage)
  assert.equal(typeof journal.changeBudgetCaps, 'function')
  await journal.updateBudget(init)
  await journal.updateBudget(reserve('request-1'))
  await journal.updateBudget(settle('request-1'))
  assert.equal(await journal.changeBudgetCaps({ usdMicros: 20, rounds: 3 }, { id: 'caps-1', revision: 1 }, 100), null)
  assert.equal(journal.state.phase, 'stopped')
  const card = await journal.changeBudgetCaps({ usdMicros: 200, rounds: 4 }, { id: 'caps-2', revision: 1 }, 100)
  assert.equal(journal.state.budget.caps.usdMicros, 20)
  const decision = { version: 1, cardId: card.id, cardType: card.type, expectedRevision: card.revision, contractDigest: null, choice: 'approve' }
  await assert.rejects(journal.decideCard({ ...decision, expectedRevision: 2 }))
  await journal.decideCard(decision)
  assert.equal(journal.state.budget.caps.usdMicros, 200)
  assert.equal(journal.state.budget.stop.reason, 'budget')
  assert.equal(journal.state.phase, 'stopped')
  await assert.rejects(journal.updateBudget(reserve('request-2')))
  await assert.rejects(journal.decideCard(decision))
})

test('budget stop effects may use the journal cancellation path after durable admission', { timeout: 1000 }, async () => {
  const journal: any = await open(memory())
  await journal.updateBudget(init)
  await journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 0, rounds: 3 } }, async () => {
    await journal.stop()
  })
  assert.equal(journal.state.phase, 'stopped')
})

test('a late budget stop preserves acceptance while retaining its monetary latch', () => {
  const budget = reduce(reduce(null, init), reserve('request-1', 90))
  const state = { ...lead.initialLeadState(), phase: 'accepted' as const, budget }
  const stopped = lead.reduceLeadRecord(state, { version: 1, seq: 1, type: 'budget', event: settle('request-1', 90) } as any)
  assert.equal(stopped.phase, 'accepted')
  assert.equal(stopped.budget!.stop!.reason, 'budget')
})

test('stale mixed cap cards cannot widen after intervening cap changes', async () => {
  const journal: any = await open(memory())
  await journal.updateBudget(init)
  const card = await journal.changeBudgetCaps({ usdMicros: 200, rounds: 2 }, { id: 'mixed-1', revision: 1 }, 100)
  await journal.changeBudgetCaps({ usdMicros: 90, rounds: 3 }, { id: 'narrow', revision: 1 }, 100)
  const click = { version: 1, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: null, choice: 'approve' }
  await assert.rejects(journal.decideCard(click))
  assert.deepEqual(journal.state.budget.caps, { usdMicros: 90, rounds: 3 })
  await journal.decideCard({ ...click, choice: 'decline' })
  await assert.rejects(journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 200, rounds: 2 } }))
  await journal.stop()
})

test('budget snapshots recompute counters and reject corrupted retained identities', () => {
  let state = reduce(reduce(reduce(null, init), reserve('request-1')), settle('request-1'))
  state = reduce(state, bind('run-1'))
  state = reduce(state, observe())
  state = reduce(state, { version: 1, type: 'round', now: 100, executionId: 'run-1', roundId: 'round-1' })
  const parse = api('parseLeadBudgetLedger')
  assert.deepEqual(parse(state), state)
  for (const patch of [{ leadUsdMicros: 0 }, { reservedUsdMicros: 1 }, { requests: [...state.requests, state.requests[0]] },
    { rounds: [...state.rounds, state.rounds[0]] }, { executionIds: [] }, { workerUsdMicros: -1 }]) assert.throws(() => parse({ ...state, ...patch }))
})

test('budget reservation append failure never authorizes its paid effect', async () => {
  const storage = memory(), journal: any = await open(storage)
  await journal.updateBudget(init)
  storage.fail = true
  let calls = 0
  await assert.rejects(journal.updateBudget(reserve('request-1')).then(() => { calls++ }))
  assert.equal(calls, 0)
  assert.equal((await open({ ...storage, fail: false }) as any).state.budget.requests.length, 0)
})

test('budget records run through core canaries without latching a refusal', async () => {
  const storage = memory(), journal: any = await lead.createLeadJournal(storage, { canaries: ['synthetic-budget-canary'] })
  await assert.rejects(journal.updateBudget({ ...init, logicalGoalId: 'synthetic-budget-canary' }), /canary/)
  await journal.updateBudget(init)
  assert.ok(!JSON.stringify(storage.records).includes('synthetic-budget-canary'))
  await journal.stop()
})

test('round tightening retains admitted identities and stops without resetting the goal', () => {
  let state = reduce(reduce(null, init), bind('run-1'))
  state = reduce(state, observe({ usdMicros: 0 }))
  for (const roundId of ['round-1', 'round-2']) state = reduce(state, { version: 1, type: 'round', now: 100, executionId: 'run-1', roundId })
  state = reduce(state, { version: 1, type: 'tighten', now: 100, caps: { usdMicros: 100, rounds: 1 } })
  assert.equal(state.stop.reason, 'rounds')
  assert.equal(state.roundsAdmitted, 2)
  assert.equal(state.rounds.length, 2)
  assert.throws(() => reduce(state, init))
})

test('expired observations and stale observation revisions refuse new admission', () => {
  let state = reduce(reduce(null, init), bind('run-1'))
  state = reduce(state, observe({ revision: 2 }))
  assert.throws(() => reduce(state, { ...reserve('request-1', 1), now: 151 }))
  assert.throws(() => reduce(state, observe({ revision: 1 })))
  assert.throws(() => reduce(state, observe({ revision: 2, usdMicros: 21 })))
  assert.deepEqual(reduce(state, observe({ revision: 2 })), state)
  assert.equal(state.workerUsdMicros, 20)
})

for (const duplicate of ['observation', 'bind', 'round', 'settlement', 'uncertain']) test(`duplicate ${duplicate} advances processed time without double charging`, () => {
  let state = reduce(reduce(null, init), reserve('paid-1', 1))
  state = reduce(state, bind('run-1'))
  state = reduce(state, observe())
  let event: any
  if (duplicate === 'observation') event = observe()
  else if (duplicate === 'bind') event = bind('run-1')
  else if (duplicate === 'round') event = { version: 1, type: 'round', now: 100, executionId: 'run-1', roundId: 'one' }
  else if (duplicate === 'settlement') event = settle('paid-1', 1)
  else event = { version: 1, type: 'uncertain', now: 100, requestId: 'paid-1' }
  state = reduce(state, event)
  const spent = state.leadUsdMicros, rounds = state.rounds.length
  state = reduce(state, { ...event, now: 1000 })
  assert.equal(state.now, 1000)
  assert.equal(state.leadUsdMicros, spent)
  assert.equal(state.rounds.length, rounds)
  assert.notEqual(state.spend, 'known')
  assert.throws(() => reduce(state, { ...reserve('paid-2', 1), now: 120 }))
})

test('round cap one admits its round and still reserves review without cancellation', async () => {
  const journal: any = await open(memory())
  await journal.updateBudget({ ...init, caps: { usdMicros: 100, rounds: 1 } })
  await journal.updateBudget(bind('run-1'))
  await journal.updateBudget(observe({ usdMicros: 0 }))
  let stops = 0
  await journal.updateBudget({ version: 1, type: 'round', now: 100, executionId: 'run-1', roundId: 'one' }, async () => { stops++ })
  assert.equal(journal.state.budget.stop, null)
  assert.equal(stops, 0)
  await journal.updateBudget(reserve('review-1', 1))
  await assert.rejects(journal.updateBudget({ version: 1, type: 'round', now: 100, executionId: 'run-1', roundId: 'two' }))
})

test('observation and settlement traffic never invalidates a pending cap increase', async () => {
  const journal: any = await open(memory())
  await journal.updateBudget(init)
  await journal.updateBudget(reserve('paid-1', 1))
  await journal.updateBudget(bind('run-1'))
  await journal.updateBudget(observe())
  const card = await journal.changeBudgetCaps({ usdMicros: 200, rounds: 4 }, { id: 'raise-1', revision: 1 }, 100)
  await journal.updateBudget(observe({ revision: 2, usdMicros: 21 }))
  await journal.updateBudget(settle('paid-1', 1))
  await journal.decideCard({ version: 1, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: null, choice: 'approve' })
  assert.equal(journal.state.budget.caps.usdMicros, 200)
})

test('usage above reservation including cached input is charged and stops at the cap', () => {
  let state = reduce(reduce(null, init), { ...reserve('paid-1', 1), inputTokens: 10,
    cacheReadUsdMicrosPerMillion: 100_000, cacheWriteUsdMicrosPerMillion: 2_000_000 })
  assert.equal(state.reservedUsdMicros, 21, 'input reserves at the most expensive possible cache rate')
  const usage = { ...settle('paid-1', 30), inputTokens: 12, cacheReadTokens: 10, cacheWriteTokens: 40 }
  state = reduce(state, usage)
  assert.equal(state.leadUsdMicros, 123)
  assert.equal(state.reservedUsdMicros, 0)
  assert.equal(state.stop.reason, 'budget')
  assert.deepEqual(reduce(state, usage), state)
})

test('settled requests compact to identity digests and do not consume the active request bound', () => {
  let state = reduce(null, { ...init, caps: { usdMicros: 100_000, rounds: 3 } })
  for (let i = 0; i < 4100; i++) {
    state = reduce(state, reserve(`paid-${i}`, 0))
    state = reduce(state, settle(`paid-${i}`, 0))
  }
  assert.equal(state.requests.length, 0)
  assert.equal(state.leadUsdMicros, 41_000)
  assert.ok(JSON.stringify(state).length < 600_000)
  assert.deepEqual(reduce(state, settle('paid-0', 0)), state)
  assert.throws(() => reduce(state, settle('paid-0', 1)))
  assert.throws(() => reduce(state, reserve('paid-0')))
  assert.deepEqual(api('parseLeadBudgetLedger')(state), state)
})

test('pending stop effects survive reopen and clear only after durable acknowledgement', async () => {
  const storage = memory(), journal: any = await open(storage)
  await journal.updateBudget(init)
  await journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 0, rounds: 3 } }, async () => { throw new Error('crash') })
  assert.equal(journal.stopEffectFailure.reason, 'stop-effects-failed')
  const recovered: any = await open(storage)
  assert.ok(recovered.state.stopEffectsPending)
  let calls = 0
  await recovered.runStopEffects(async () => { calls++ })
  assert.equal(calls, 1)
  assert.equal((await open(storage) as any).state.stopEffectsPending, null)
  await recovered.runStopEffects(async () => { calls++ })
  assert.equal(calls, 1)
  assert.equal(storage.records.at(-1).type, 'stop-effects-done')
})

test('failed stop-effect acknowledgement remains pending for supervisor retry', async () => {
  const storage = memory(), append = storage.append.bind(storage), journal: any = await open(storage)
  await journal.updateBudget(init)
  storage.append = async record => { if (record.type === 'stop-effects-done') throw new Error('ack failure'); await append(record) }
  let stops = 0
  await journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 0, rounds: 3 } }, async () => { stops++ })
  assert.equal(journal.stopEffectFailure.reason, 'stop-effects-failed')
  storage.append = append
  const recovered: any = await open(storage)
  assert.ok(recovered.state.stopEffectsPending)
  await recovered.runStopEffects(async () => { stops++ })
  assert.equal(stops, 2)
  assert.equal((await open(storage)).state.stopEffectsPending, null)
})

test('cache reservations cover independent micro-unit rounding across all input categories', () => {
  const reservation = { ...reserve('paid-1', 0), inputTokens: 3,
    inputUsdMicrosPerMillion: 1, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 1 }
  const reserved = reduce(reduce(null, init), reservation)
  assert.equal(reserved.reservedUsdMicros, 3)
  const settled = reduce(reserved, { ...settle('paid-1', 0), inputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 })
  assert.equal(settled.leadUsdMicros, reserved.reservedUsdMicros)
  for (const [inputTokens, expected] of [[0, 0], [1, 1], [2, 2], [10, 3]] as const) {
    const state = reduce(reduce(null, init), { ...reservation, inputTokens })
    assert.equal(state.reservedUsdMicros, expected)
  }
})


test('unrepresentable settlement saturates, stops and stays unknown through replay', async () => {
  const storage = memory(), journal: any = await open(storage)
  await journal.updateBudget({ ...init, caps: { usdMicros: 1_000_000_000_000, rounds: 3 } })
  await journal.updateBudget({ ...reserve('overflow', 0), inputTokens: 999_999,
    inputUsdMicrosPerMillion: 1_000_000_000_000, cacheReadUsdMicrosPerMillion: 0, cacheWriteUsdMicrosPerMillion: 0 })
  const ledger = await journal.updateBudget({ ...settle('overflow', 0), inputTokens: 1_000_001 })
  assert.equal(ledger.leadUsdMicros, 1_000_000_000_000)
  assert.equal(ledger.stop.reason, 'budget')
  assert.equal(ledger.spend, 'unknown')
  await journal.stop()
  const restored: any = await open(storage)
  assert.equal(restored.state.budget.spend, 'unknown')
  assert.deepEqual(api('parseLeadBudgetLedger')(restored.state.budget), restored.state.budget)
  await assert.rejects(restored.updateBudget(reserve('next', 0)))
})

test('aggregate actual usage saturates without preventing later stop records', () => {
  let state = reduce(null, { ...init, caps: { usdMicros: 1_000_000_000_000, rounds: 3 } })
  for (const id of ['a', 'b']) state = reduce(state, { ...reserve(id, 0), inputTokens: 1,
    inputUsdMicrosPerMillion: 1_000_000_000_000 })
  for (const id of ['a', 'b']) state = reduce(state, { ...settle(id, 0), inputTokens: 750_000 })
  assert.equal(state.leadUsdMicros, 1_000_000_000_000)
  assert.equal(state.spend, 'unknown')
  assert.equal(reduce(state, { version: 1, type: 'stop', now: 101, reason: 'cancelled' }).stop.reason, 'budget')
})

test('host first round adopts the admitted start instead of spending a second round', () => {
  let state = reduce(null, { ...init, caps: { usdMicros: 100, rounds: 2 } })
  state = reduce(state, { version: 1, type: 'start', now: 100, startId: 's1' })
  state = reduce(state, { ...bind('run-1'), startId: 's1' })
  state = reduce(state, observe({ usdMicros: 0 }))
  const round = (roundId: string) => ({ version: 1, type: 'round', now: 100, executionId: 'run-1', roundId })
  state = reduce(state, round('1'))
  assert.equal(state.roundsAdmitted, 1)
  state = reduce(state, round('2'))
  assert.equal(state.roundsAdmitted, 2)
  assert.deepEqual(reduce(state, round('1')), state)
  assert.deepEqual(api('parseLeadBudgetLedger')(state), state)
  assert.throws(() => reduce(state, round('3')))
})

test('a durable settlement resolves independently of failed cancellation effects', async () => {
  const storage = memory(), journal: any = await open(storage)
  await journal.updateBudget(init)
  await journal.updateBudget(reserve('paid', 1))
  const settled = await journal.updateBudget(settle('paid', 100), async () => { throw new Error('synthetic cleanup failure') })
  assert.equal(settled.leadUsdMicros, 110)
  assert.ok(journal.state.stopEffectsPending)
  assert.equal(journal.stopEffectFailure.reason, 'stop-effects-failed')
  assert.ok(!JSON.stringify(journal.stopEffectFailure).includes('synthetic cleanup'))
  await journal.runStopEffects(async () => {})
  assert.equal(journal.stopEffectFailure, null)
  assert.equal(journal.state.stopEffectsPending, null)
})
