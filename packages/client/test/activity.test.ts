import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLIENT_METHODS, type FindingRoundPublication, type FlowExecution, type HostToClient, type WireNotification, type WireRequest } from '@harnessdesk/protocol'
import { connect, type Client, type ClientEvent, type ClientTransport } from '../src/index.js'

const run = (id = 'run-1', goal = 'team-1'): FlowExecution => ({ id, goal, state: 'running', reason: null,
  rounds: [{ n: 1, cards: [1], role: 'review', state: 'running' }], document: { flow: { name: 'Demo', roles: [] } },
} as unknown as FlowExecution)
const round = (state: FindingRoundPublication['state'] = 'none'): FindingRoundPublication => ({ round: 1, cards: [1], state, reason: null, pr: null })
class Desk implements ClientTransport {
  requests: WireRequest[] = []
  message: (message: HostToClient) => void = () => {}
  closed: () => void = () => {}
  runs = [run()]
  rounds = [round()]
  hold = false
  baseline: WireNotification[] = []
  methods = Object.keys(CLIENT_METHODS)
  onMessage(listener: (message: HostToClient) => void) { this.message = listener; return () => { this.message = () => {} } }
  onClose(listener: () => void) { this.closed = listener; return () => { this.closed = () => {} } }
  close() { this.closed() }
  answer(request: WireRequest, result: unknown) { this.message({ id: request.id, ok: true, result }) }
  send(request: WireRequest) {
    this.requests.push(request)
    switch (request.method) {
      case 'client/hello': this.answer(request, { protocolVersion: 1, hostVersion: 'demo', desk: { home: '/tmp/demo', pid: 1, startedAt: 1 }, tiers: ['read'], methods: this.methods, runtimes: [] }); break
      case 'client/subscribe': this.answer(request, { baseline: this.baseline.length }); for (const item of this.baseline) this.message(item); break
      case 'flow/execution': this.answer(request, this.runs.find(r => r.id === (request.params as { run: string }).run)); break
      case 'flow/executions': {
        const params = request.params as { team?: string }
        this.answer(request, this.runs.filter(r => !params.team || r.goal === params.team).map(r => ({ id: r.id, team: r.goal })))
        break
      }
      case 'finding/run': if (!this.hold) this.review(request, this.rounds); break
      default: this.answer(request, []);
    }
  }
  review(request: WireRequest, rounds: readonly FindingRoundPublication[]) {
    const id = (request.params as { run: string }).run
    this.answer(request, { run: id, goal: this.runs.find(r => r.id === id)!.goal, rounds })
  }
  finding(goal = 'team-1') { this.message({ method: 'finding/changed', params: { goal, revision: 1 } }) }
  sent(method: string) { return this.requests.filter(r => r.method === method) }
}
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }
const wait = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(check(), 'expected wire request arrived')
}
const observe = (client: Client) => {
  const events: ClientEvent[] = []
  const done = (async () => { for await (const event of client.events()) events.push(event) })()
  const bodies = (type: string) => events.filter(e => e.type === type).map(({ v, at, ...body }) => body)
  return { events, done, bodies }
}
const open = (desk: Desk, topics: ('seats' | 'reviews' | 'runs' | 'cards')[] = ['reviews'], scope?: { team?: string; run?: string; project?: string }) =>
  connect({ transport: async () => desk, client: { name: 'demo', version: '1' }, subscribe: { topics, ...(scope ? { scope } : {}) } })

test('seat snapshots map their recorded fields and deduplicate the four activity values per Team and seat', async t => {
  const desk = new Desk(), client = await open(desk, ['seats']); t.after(() => client.close())
  const observed = observe(client)
  const activity = { goal: 'team-1', seat: 'demo:session-1', role: 'review', card: 1, state: 'working' as const, doing: { kind: 'thinking' as const }, since: 0 }
  desk.message({ method: 'seat/activity', params: activity })
  desk.message({ method: 'seat/activity', params: { ...activity, since: 2 } })
  desk.message({ method: 'seat/activity', params: { ...activity, goal: 'team-2' } })
  desk.message({ method: 'seat/activity', params: { ...activity, state: 'idle', doing: null, since: undefined } })
  client.close(); await observed.done
  assert.deepEqual(observed.bodies('seat.changed'), [
    { type: 'seat.changed', team: 'team-1', seat: activity.seat, role: 'review', card: 1, state: 'working', doing: activity.doing, since: 0 },
    { type: 'seat.changed', team: 'team-2', seat: activity.seat, role: 'review', card: 1, state: 'working', doing: activity.doing, since: 0 },
    { type: 'seat.changed', team: 'team-1', seat: activity.seat, role: 'review', card: 1, state: 'idle', doing: null },
  ])
})

test('run revision and continues are compared and omitted when null; attempt is not invented', async t => {
  const desk = new Desk(), client = await open(desk, ['runs']); t.after(() => client.close())
  const observed = observe(client)
  for (const extra of [{}, { revision: 'a'.repeat(40), continues: 'earlier' }, { revision: 'b'.repeat(40), continues: 'earlier' }, { revision: 'b'.repeat(40), continues: 'another-run' }, { revision: null, continues: null }]) {
    desk.message({ method: 'flow/execution-changed', params: { execution: { ...run(), ...extra } } })
  }
  client.close(); await observed.done
  const changed = observed.bodies('run.changed')
  assert.equal(changed.length, 5)
  assert.deepEqual(changed[1], { type: 'run.changed', run: 'run-1', team: 'team-1', flow: 'Demo', state: 'running', round: 1, reason: null, revision: 'a'.repeat(40), continues: 'earlier' })
  assert.ok(changed.every(e => !Object.hasOwn(e, 'attempt')))
  assert.ok(!Object.hasOwn(changed[4]!, 'revision') && !Object.hasOwn(changed[4]!, 'continues'))
})

test('card claim movement and its recorded time produce changes; since exists only while claimed', async t => {
  const desk = new Desk(), client = await open(desk, ['cards']); t.after(() => client.close())
  const observed = observe(client)
  for (const [state, seat, at] of [['claimed', 'one', 0], ['claimed', 'two', 0], ['claimed', 'two', 2], ['done', 'two', 2]] as const) {
    desk.message({ method: 'team/changed', params: { state: { id: 'team-1', members: [], intents: [{ id: 1, title: 'Review', state, role: 'review', outcome: null, claim: { runtime: 'demo', sessionId: seat, at } }] } } } as unknown as WireNotification)
  }
  client.close(); await observed.done
  const changed = observed.bodies('card.changed')
  assert.equal(changed.length, 4)
  assert.deepEqual(changed[0], { type: 'card.changed', team: 'team-1', card: 1, role: 'review', state: 'claimed', outcome: null, title: 'Review', seat: 'demo:one', since: 0 })
  assert.ok(!Object.hasOwn(changed[3]!, 'since'))
})

test('reviews-only subscriptions discover scoped runs, map rounds, and compare state reason pr and cards', async t => {
  const desk = new Desk(), client = await open(desk, ['reviews'], { team: 'team-1' }); t.after(() => client.close())
  const observed = observe(client)
  await wait(() => desk.sent('finding/run').length === 1); await flush()
  assert.deepEqual(observed.bodies('review.changed'), [{ type: 'review.changed', team: 'team-1', run: 'run-1', ...round() }])
  desk.finding(); await flush(); await flush()
  assert.equal(observed.bodies('review.changed').length, 1)
  for (const patch of [{ state: 'local' as const }, { reason: 'Kept on the desk' }, { pr: 9 }, { cards: [1, 2] }]) {
    desk.rounds = [{ ...desk.rounds[0]!, ...patch }]; desk.finding(); await flush(); await flush()
  }
  assert.equal(observed.bodies('review.changed').length, 5)
  assert.ok(desk.sent('flow/executions').every(r => (r.params as { team?: string; active?: boolean }).team === 'team-1' && (r.params as { active?: boolean }).active === false))
  assert.equal(observed.events[0]?.type, 'hello')
})

test('a run created after reviews-only discovery is read on its first Team invalidation', async t => {
  const desk = new Desk(), client = await open(desk); t.after(() => client.close())
  const observed = observe(client)
  await wait(() => desk.sent('finding/run').length === 1); await flush()
  desk.runs.push(run('run-2')); desk.finding()
  await wait(() => desk.sent('finding/run').some(r => (r.params as { run: string }).run === 'run-2')); await flush()
  assert.ok(observed.bodies('review.changed').some(e => (e as { run: string }).run === 'run-2'))
})

test('Team reads serialize so a burst cannot apply a later answer before the earlier one', async t => {
  const desk = new Desk(); desk.hold = true
  const client = await open(desk); t.after(() => client.close()); const observed = observe(client)
  await wait(() => desk.sent('finding/run').length === 1)
  for (let i = 0; i < 12; i++) desk.finding()
  await flush()
  assert.equal(desk.sent('finding/run').length, 1, 'second read cannot start until first is applied')
  desk.review(desk.sent('finding/run')[0]!, [round('local')])
  await wait(() => desk.sent('finding/run').length === 2)
  desk.review(desk.sent('finding/run')[1]!, [round('posted')]); await flush()
  assert.deepEqual(observed.bodies('review.changed').map(e => (e as { state: string }).state), ['local', 'posted'])
  assert.equal(desk.sent('finding/run').length, 2, 'burst is one in-flight batch plus one queued batch')
})

test('failed background reads emit the desk message as a notice and wait for a new invalidation', async t => {
  const desk = new Desk(); desk.hold = true
  const client = await open(desk); t.after(() => client.close()); const observed = observe(client)
  await wait(() => desk.sent('finding/run').length === 1)
  const request = desk.sent('finding/run')[0]!
  desk.message({ id: request.id, ok: false, error: { code: 'refused', message: 'The round is unavailable.' } }); await flush(); await flush()
  assert.deepEqual(observed.bodies('notice'), [{ type: 'notice', team: 'team-1', text: 'The round is unavailable.' }])
  assert.equal(desk.sent('finding/run').length, 1)
  desk.finding(); await wait(() => desk.sent('finding/run').length === 2)
  desk.review(desk.sent('finding/run')[1]!, [round('local')]); await flush()
  assert.equal(observed.bodies('review.changed').length, 1)
})

for (const stale of ['success', 'failure'] as const) test(`accepted replacement ignores ${stale} from an earlier review read`, async t => {
  const desk = new Desk(); desk.hold = true
  const client = await open(desk); t.after(() => client.close()); const observed = observe(client)
  await wait(() => desk.sent('finding/run').length === 1)
  const request = desk.sent('finding/run')[0]!
  await client.call('client/subscribe', { topics: ['seats'], scope: { team: 'team-2' } })
  if (stale === 'success') desk.review(request, [round('posted')])
  else desk.message({ id: request.id, ok: false, error: { code: 'refused', message: 'Old scope refused' } })
  await flush(); client.close(); await observed.done
  assert.deepEqual(observed.events.map(e => e.type), ['hello', 'gap', 'end'])
})

test('reconnect rebuilds reviews after gap and suppresses disconnected-read notices', async t => {
  const first = new Desk(), second = new Desk(); first.hold = true; second.rounds = [round('posted')]
  let opens = 0
  const client = await connect({ transport: async () => ++opens === 1 ? first : second, client: { name: 'demo', version: '1' }, subscribe: { topics: ['reviews'] } })
  t.after(() => client.close()); const observed = observe(client)
  await wait(() => first.sent('finding/run').length === 1); first.close()
  await wait(() => second.sent('finding/run').length === 1); await flush()
  assert.deepEqual(observed.events.map(e => e.type), ['hello', 'gap', 'review.changed'])
})

test('close suppresses pending review notices and keeps end last', async () => {
  const desk = new Desk(); desk.hold = true
  const client = await open(desk); const observed = observe(client)
  await wait(() => desk.sent('finding/run').length === 1); client.close(); await observed.done; await flush()
  assert.deepEqual(observed.events.map(e => e.type), ['hello', 'end'])
})

test('an invalidation arriving as a completed batch exits still starts its read', async t => {
  const desk = new Desk(); desk.hold = true
  const client = await open(desk); t.after(() => client.close()); const observed = observe(client)
  await wait(() => desk.sent('finding/run').length === 1)
  desk.hold = false; desk.rounds = [round('posted')]
  desk.review(desk.sent('finding/run')[0]!, [round('local')])
  queueMicrotask(() => desk.finding())
  await wait(() => desk.sent('finding/run').length === 2); await flush()
  assert.deepEqual(observed.bodies('review.changed').map(e => (e as { state: string }).state), ['local', 'posted'])
})

test('background discovery failure is a notice, leaves connection usable, and never retries itself', async t => {
  const desk = new Desk(), send = desk.send.bind(desk)
  desk.send = request => {
    if (request.method !== 'flow/executions') return send(request)
    desk.requests.push(request)
    desk.message({ id: request.id, ok: false, error: { code: 'refused', message: 'The run catalogue is unavailable.' } })
  }
  const client = await open(desk); t.after(() => client.close()); const observed = observe(client)
  await flush(); await flush()
  assert.deepEqual(observed.bodies('notice'), [{ type: 'notice', team: null, text: 'The run catalogue is unavailable.' }])
  assert.equal(desk.sent('flow/executions').length, 1)
  assert.deepEqual(await client.call('goal/list', {}), [])
})

for (const stale of ['success', 'failure'] as const) test(`replacement ignores ${stale} from pending run discovery`, async t => {
  const desk = new Desk(), send = desk.send.bind(desk)
  desk.send = request => { if (request.method === 'flow/executions') desk.requests.push(request); else send(request) }
  const client = await open(desk); t.after(() => client.close()); const observed = observe(client)
  const discovery = desk.sent('flow/executions')[0]!
  await client.call('client/subscribe', { topics: ['seats'], scope: { team: 'team-2' } })
  if (stale === 'success') desk.answer(discovery, [{ id: 'old-run', team: 'team-1' }])
  else desk.message({ id: discovery.id, ok: false, error: { code: 'refused', message: 'Old discovery refused' } })
  await flush()
  assert.equal(desk.sent('finding/run').length, 0)
  assert.deepEqual(observed.events.map(e => e.type), ['hello', 'gap'])
})

test('Teams refresh independently while each Team serializes its own multiple runs', async t => {
  const desk = new Desk(); desk.runs = [run(), run('run-2'), run('run-3', 'team-2')]; desk.hold = true
  const client = await open(desk); t.after(() => client.close()); const observed = observe(client)
  await wait(() => desk.sent('finding/run').length === 2)
  const started = desk.sent('finding/run')
  assert.deepEqual(started.map(r => (r.params as { run: string }).run), ['run-1', 'run-3'])
  desk.review(started[1]!, [round('posted')]); await flush()
  assert.deepEqual(observed.bodies('review.changed').map(e => (e as { run: string }).run), ['run-3'])
  desk.review(started[0]!, [round('local')])
  await wait(() => desk.sent('finding/run').length === 3)
  assert.equal((desk.sent('finding/run')[2]!.params as { run: string }).run, 'run-2')
})

test('reviews-only run scope reads only that run, including after same-Team invalidation', async t => {
  const desk = new Desk(); desk.runs.push(run('run-2'))
  const client = await open(desk, ['reviews'], { run: 'run-1' }); t.after(() => client.close()); const observed = observe(client)
  await wait(() => desk.sent('finding/run').length === 1); await flush()
  desk.finding(); await wait(() => desk.sent('finding/run').length === 2); await flush()
  assert.ok(desk.sent('finding/run').every(r => (r.params as { run: string }).run === 'run-1'))
  assert.equal(desk.sent('flow/executions').length, 0)
  assert.deepEqual(observed.events.map(e => e.type), ['hello', 'review.changed'])
})

test('newly notified runs refresh reviews without a finding invalidation', async t => {
  const desk = new Desk(); desk.runs = []
  const client = await open(desk, ['runs', 'reviews']); t.after(() => client.close()); const observed = observe(client)
  await flush()
  const created = run('new-run'); desk.runs.push(created)
  desk.message({ method: 'flow/execution-changed', params: { execution: created } })
  await wait(() => desk.sent('finding/run').length === 1); await flush()
  assert.deepEqual(observed.events.map(e => e.type), ['hello', 'run.changed', 'review.changed'])
})

test('synchronous seat baseline follows hello and each accepted gap before review reads', async t => {
  const desk = new Desk()
  desk.baseline = [{ method: 'seat/activity', params: { goal: 'team-1', seat: 'demo:one', role: null, card: null, state: 'idle', doing: null } }]
  const client = await open(desk, ['seats', 'reviews']); t.after(() => client.close()); const observed = observe(client)
  await wait(() => desk.sent('finding/run').length === 1); await flush()
  await client.call('client/subscribe', { topics: ['seats', 'reviews'] })
  await wait(() => desk.sent('finding/run').length === 2); await flush()
  assert.deepEqual(observed.events.map(e => e.type), ['hello', 'seat.changed', 'review.changed', 'gap', 'seat.changed', 'review.changed'])
})

test('accepted run-scoped review projection starts even when its supplemental execution read refuses', async t => {
  const desk = new Desk(), client = await open(desk, ['seats']); t.after(() => client.close()); const observed = observe(client)
  desk.baseline = [{ method: 'flow/execution-changed', params: { execution: run() } }]
  const send = desk.send.bind(desk)
  desk.send = request => {
    if (request.method !== 'flow/execution') return send(request)
    desk.requests.push(request)
    desk.message({ id: request.id, ok: false, error: { code: 'refused', message: 'Execution temporarily unavailable' } })
  }
  await assert.rejects(client.call('client/subscribe', { topics: ['reviews'], scope: { run: 'run-1' } }), /Execution temporarily unavailable/)
  await wait(() => desk.sent('finding/run').length === 1); await flush()
  desk.rounds = [round('posted')]; desk.finding()
  await wait(() => desk.sent('finding/run').length === 2); await flush()
  assert.deepEqual(observed.events.map(e => e.type), ['hello', 'gap', 'review.changed', 'review.changed'])
})

test('an accepted reviews-only run scope recovers discovery on a later invalidation after its execution deadline', async t => {
  const desk = new Desk(), client = await open(desk, ['seats']); t.after(() => client.close()); const observed = observe(client)
  const send = desk.send.bind(desk)
  desk.send = request => { if (request.method === 'flow/execution') desk.requests.push(request); else send(request) }
  await assert.rejects(client.call('client/subscribe', { topics: ['reviews'], scope: { run: 'run-1' } }, { deadlineMs: 5 }), /before its deadline/)
  assert.equal(desk.sent('finding/run').length, 0)
  desk.send = send; desk.finding()
  await wait(() => desk.sent('finding/run').length === 1); await flush()
  assert.deepEqual(observed.events.map(e => e.type), ['hello', 'gap', 'review.changed'])
  assert.equal(desk.sent('flow/execution').length, 2, 'a fresh notification permits one exact-run discovery read')
  assert.equal(desk.sent('flow/executions').length, 0, 'run scope never widens to other runs')
})

test('synced includes the initial review reads and copies their rounds', async t => {
  const desk = new Desk(); desk.hold = true
  const client = await open(desk); t.after(() => client.close())
  let whole = false
  const synced = client.synced().then(() => { whole = true })
  await wait(() => desk.sent('finding/run').length === 1)
  await flush(); assert.equal(whole, false)
  desk.review(desk.sent('finding/run')[0]!, [round('posted')])
  await synced
  const before = client.snapshot()
  assert.deepEqual(before.reviews, [{ run: 'run-1', rounds: [round('posted')] }])
  const copy = client.snapshot()
  ;(copy.reviews[0]!.rounds[0]!.cards as number[]).push(99)
  copy.reviews.push({ run: 'other', rounds: [] })
  assert.deepEqual(client.snapshot(), before)
  desk.hold = false
  desk.rounds = []
  desk.finding(); await flush(); await flush()
  assert.deepEqual(client.snapshot().reviews, [{ run: 'run-1', rounds: [] }])
})

test('a failed bootstrap review read emits notice and allows synced to finish', async t => {
  const desk = new Desk(); desk.hold = true
  const client = await open(desk); t.after(() => client.close())
  const synced = client.synced()
  await wait(() => desk.sent('finding/run').length === 1)
  const request = desk.sent('finding/run')[0]!
  desk.message({ id: request.id, ok: false, error: { code: 'methodFailed', message: 'Unavailable review' } })
  await synced
  assert.deepEqual(client.snapshot().reviews, [])
  const observed = observe(client); client.close(); await observed.done
  assert.ok(observed.events.some(event => event.type === 'notice' && event.text === 'Unavailable review'))
})

test('synced on a new gap waits for only the new subscription review reads', async t => {
  const desk = new Desk(); desk.hold = true
  const client = await open(desk); t.after(() => client.close())
  await wait(() => desk.sent('finding/run').length === 1)
  const stale = desk.sent('finding/run')[0]!
  await client.call('client/subscribe', { topics: ['reviews'] })
  let whole = false
  const synced = client.synced().then(() => { whole = true })
  await wait(() => desk.sent('finding/run').length === 2)
  desk.review(stale, [round('uncertain')])
  await flush(); assert.equal(whole, false)
  desk.review(desk.sent('finding/run')[1]!, [round('local')])
  await synced
  assert.deepEqual(client.snapshot().reviews, [{ run: 'run-1', rounds: [round('local')] }])
})

test('a synchronous notification during review startup cannot complete synced early', async t => {
  const desk = new Desk(); desk.hold = true
  desk.baseline = [{ method: 'flow/execution-changed', params: { execution: run() } }]
  const original = desk.send.bind(desk)
  desk.send = request => {
    if (request.method === 'finding/run') desk.message({ method: 'seat/activity', params: { goal: 'team-1', seat: 'demo:session-1', role: 'review', card: 1, state: 'working', doing: { kind: 'thinking' } } })
    original(request)
  }
  const client = await open(desk, ['runs', 'reviews', 'seats']); t.after(() => client.close())
  let whole = false
  const synced = client.synced().then(() => { whole = true })
  await wait(() => desk.sent('finding/run').length > 0)
  await flush(); assert.equal(whole, false)
  desk.review(desk.sent('finding/run')[0]!, [round()])
  await synced
})

test('synced ignores a later live refresh after its initial review pass has arrived', async t => {
  const desk = new Desk(); desk.hold = true
  const client = await open(desk); t.after(() => client.close())
  let whole = false
  const synced = client.synced().then(() => { whole = true })
  await wait(() => desk.sent('finding/run').length === 1)
  desk.finding()
  desk.review(desk.sent('finding/run')[0]!, [round('local')])
  await wait(() => desk.sent('finding/run').length === 2)
  await flush()
  assert.equal(whole, true, 'later live reads do not hold the initial baseline')
  await synced
  assert.deepEqual(client.snapshot().reviews, [{ run: 'run-1', rounds: [round('local')] }])
})
