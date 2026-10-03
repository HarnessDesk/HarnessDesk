import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLIENT_METHODS, type FlowExecution, type GoalView, type HostToClient, type TeamState, type WireNotification, type WireRequest } from '@harnessdesk/protocol'
import { connect, WireCallError, type ClientTransport, type ClientEvent } from '../src/index.js'

const hello = { protocolVersion: 1, hostVersion: '0.1.0', desk: { home: '/tmp/demo-desk', pid: 42, startedAt: 1 }, tiers: ['read'], methods: Object.keys(CLIENT_METHODS), runtimes: [] }
class ScriptedTransport implements ClientTransport {
  requests: WireRequest[] = []
  message: (message: HostToClient) => void = () => {}
  closed: () => void = () => {}
  reply = true
  baseline: WireNotification[] = []
  execution = run()
  methods = hello.methods
  onMessage(listener: (message: HostToClient) => void) { this.message = listener; return () => { this.message = () => {} } }
  onClose(listener: () => void) { this.closed = listener; return () => { this.closed = () => {} } }
  send(request: WireRequest) {
    this.requests.push(request)
    if (request.method === 'client/hello') this.message({ id: request.id, ok: true, result: { ...hello, methods: this.methods } })
    else if (request.method === 'client/subscribe') {
      this.message({ id: request.id, ok: true, result: null })
      for (const notification of this.baseline) this.message(notification)
    } else if (this.reply) this.message({ id: request.id, ok: true, result: request.method === 'flow/execution' ? this.execution : [] })
  }
  close() { this.closed() }
  emit(notification: WireNotification) { this.message(notification) }
}
function run(patch: Partial<FlowExecution> = {}): FlowExecution {
  return { version: 2, id: 'run-1', goal: 'team-1', state: 'running', reason: null, rounds: [{ n: 1, role: 'person', cards: [1], seats: [], evidence: [], state: 'running', cause: 'start' }], operations: [], legacyRun: null,
    document: { format: 'agents', flow: { name: 'demo-flow', roles: [{ id: 'person', kind: 'person', outcomes: ['accept'] }] } }, ...patch } as FlowExecution
}
function board(state = 'open', outcome: string | null = null): TeamState {
  return { id: 'team-1', members: ['demo\u0000session-1'], intents: [{ id: 1, title: 'Decide', role: 'person', state, outcome, files: [], dependsOn: [] }] } as unknown as TeamState
}
function view(): GoalView { return { goal: { id: 'team-1', sentence: 'Demo work' }, activity: 'working', board: board(), members: [] } as unknown as GoalView }
const execution = (value = run()): WireNotification => ({ method: 'flow/execution-changed', params: { execution: value } })
const cards = (value = board()): WireNotification => ({ method: 'team/changed', params: { state: value } })
const team = (): WireNotification => ({ method: 'goal/changed', params: { view: view() } })
const approval = (id: string, type = 'permission'): WireNotification => ({ method: 'event', params: { runtime: 'demo', event: { type: 'approval/requested', approval: { id, sessionId: 'session-1', type, summary: 'Same summary', requestedAt: 1, options: [], questions: [{ question: 'Same summary' }] } } } } as unknown as WireNotification)
const resolved = (id: string): WireNotification => ({ method: 'event', params: { runtime: 'demo', event: { type: 'approval/resolved', sessionId: 'session-1', approvalId: id, resolution: { type: 'cancelled' } } } } as unknown as WireNotification)
const clientInfo = { name: 'demo-client', version: '0.1.0' }
const next = async (stream: AsyncIterator<ClientEvent>) => {
  const value = await stream.next()
  assert.equal(value.done, false)
  return value.value!
}
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(check(), 'condition reached')
}

test('hello is first and its result is exposed', async () => {
  const transport = new ScriptedTransport()
  const client = await connect({ transport: async () => transport, client: clientInfo, subscribe: { topics: ['runs'] } })
  assert.deepEqual(transport.requests.map(r => r.method), ['client/hello', 'client/subscribe'])
  assert.deepEqual(transport.requests[0]?.params, { client: clientInfo, protocol: 1 })
  assert.deepEqual(client.hello, hello)
  assert.equal((await next(client.events()[Symbol.asyncIterator]())).type, 'hello')
  client.close()
})

test('deadline rejects a silent call and does not resend it', async () => {
  const transport = new ScriptedTransport()
  const client = await connect({ transport: async () => transport, client: clientInfo })
  transport.reply = false
  await assert.rejects(client.call('goal/list', {}, { deadlineMs: 5 }), e => e instanceof WireCallError && e.code === 'deadline')
  assert.equal(transport.requests.filter(r => r.method === 'goal/list').length, 1)
  client.close()
})

test('a disconnected in-flight call rejects and is never retried', async () => {
  const first = new ScriptedTransport(), second = new ScriptedTransport()
  let opens = 0
  const client = await connect({ transport: async () => ++opens === 1 ? first : second, client: clientInfo })
  first.reply = false
  const call = client.call('goal/list', {})
  first.close()
  await assert.rejects(call, e => e instanceof WireCallError && e.code === 'disconnected')
  await waitFor(() => second.requests.length > 0)
  assert.deepEqual(second.requests.map(r => r.method), ['client/hello'])
  client.close()
})

test('missing advertised method is deskTooOld with no request sent', async () => {
  const transport = new ScriptedTransport()
  transport.methods = ['client/hello']
  const client = await connect({ transport: async () => transport, client: clientInfo })
  await assert.rejects(client.call('goal/list', {}), e => e instanceof WireCallError && e.code === 'deskTooOld')
  assert.equal(transport.requests.length, 1)
  client.close()
})

test('wire error keeps its code, details and data rather than reclassifying a refusal', async () => {
  const transport = new ScriptedTransport()
  const client = await connect({ transport: async () => transport, client: clientInfo })
  transport.reply = false
  const call = client.call('goal/list', {})
  transport.message({ id: transport.requests.at(-1)!.id, ok: false, error: { code: 'notOnClientSurface', message: 'Refused', details: 'detail', data: { tier: 'read' } } })
  await assert.rejects(call, e => e instanceof WireCallError && e.code === 'notOnClientSurface' && e.message === 'Refused' && e.details === 'detail' && (e.data as { tier: string }).tier === 'read')
  client.close()
})

test('notification sequences derive run, card, team, waiting, clear and notice events', async () => {
  const transport = new ScriptedTransport()
  const client = await connect({ transport: async () => transport, client: clientInfo, subscribe: { topics: ['runs', 'cards', 'teams', 'waiting', 'notices'] } })
  const events = client.events()[Symbol.asyncIterator]()
  await next(events)
  transport.emit(execution()); transport.emit(cards()); transport.emit(team())
  assert.equal((await next(events)).type, 'run.changed')
  assert.equal((await next(events)).type, 'card.changed')
  const waiting = await next(events)
  assert.equal(waiting.type, 'waiting')
  assert.equal(waiting.type === 'waiting' && waiting.id, 'card:team-1:1')
  assert.equal((await next(events)).type, 'team.changed')
  transport.emit(cards(board('done', 'accept')))
  assert.equal((await next(events)).type, 'card.changed')
  assert.equal((await next(events)).type, 'waiting.cleared')
  transport.emit({ method: 'person/notice', params: { notice: { id: 'notice-1', from: { runtime: 'demo', sessionId: 'session-1', name: 'Demo' }, where: 'inbox', title: 'Ready', body: 'See result', at: 1 } } } as WireNotification)
  const notice = await next(events)
  assert.equal(notice.type, 'notice')
  for (const event of [waiting, notice]) { assert.equal(event.v, 1); assert.ok(!Number.isNaN(Date.parse(event.at))) }
  client.close()
})

test('unchanged state yields no duplicate events; unrelated edits do not change run or card', async () => {
  const transport = new ScriptedTransport()
  const client = await connect({ transport: async () => transport, client: clientInfo, subscribe: { topics: ['runs', 'cards', 'teams'] } })
  const events = client.events()[Symbol.asyncIterator]()
  await next(events)
  for (let i = 0; i < 2; i++) { transport.emit(execution()); transport.emit(cards()); transport.emit(team()) }
  transport.emit(execution({ ...run(), operations: [{ key: 'op', kind: 'round', state: 'finished', card: null, seat: null }] }))
  transport.emit(cards({ ...board(), intents: [{ ...board().intents[0]!, title: 'New title' }] }))
  client.close()
  const all: ClientEvent[] = []
  for (let event = await events.next(); !event.done; event = await events.next()) all.push(event.value)
  assert.deepEqual(all.map(e => e.type), ['run.changed', 'card.changed', 'team.changed', 'end'])
})

test('waiting-only observes person creation and clear on stopped run using the same id', async () => {
  const transport = new ScriptedTransport()
  const client = await connect({ transport: async () => transport, client: clientInfo, subscribe: { topics: ['waiting'] } })
  const events = client.events()[Symbol.asyncIterator]()
  await next(events)
  transport.emit(cards()); transport.emit(execution())
  const waiting = await next(events)
  assert.equal(waiting.type, 'waiting')
  transport.emit(execution(run({ state: 'stopped', reason: 'Stopped' })))
  const clear = await next(events)
  assert.equal(clear.type, 'waiting.cleared')
  assert.equal('id' in clear && clear.id, 'id' in waiting && waiting.id)
  client.close()
})

test('done, abandoned, closed-round and nonperson cards do not wait', async () => {
  const transport = new ScriptedTransport()
  const client = await connect({ transport: async () => transport, client: clientInfo, subscribe: { topics: ['waiting'] } })
  transport.emit(execution(run({ rounds: [{ ...run().rounds[0]!, state: 'closed' }] })))
  transport.emit(cards())
  transport.emit(cards(board('abandoned')))
  transport.emit(execution())
  transport.emit(cards(board('done')))
  transport.emit(cards({ ...board(), intents: [{ ...board().intents[0]!, role: 'agent' }] }))
  client.close()
  const all: ClientEvent[] = []
  for await (const event of client.events()) all.push(event)
  assert.deepEqual(all.map(e => e.type), ['hello', 'end'])
})

test('two approvals with identical summaries retain ids; question resolves independently', async () => {
  const transport = new ScriptedTransport()
  const client = await connect({ transport: async () => transport, client: clientInfo, subscribe: { topics: ['waiting'] } })
  const events = client.events()[Symbol.asyncIterator]()
  await next(events)
  transport.emit(approval('one')); transport.emit(approval('two', 'userInput'))
  const one = await next(events), two = await next(events)
  assert.equal('id' in one && one.id, 'approval:demo:session-1:one')
  assert.equal('id' in two && two.id, 'approval:demo:session-1:two')
  assert.equal('kind' in two && two.kind, 'question')
  transport.emit(resolved('two'))
  const clearedTwo = await next(events)
  assert.equal(clearedTwo.type, 'waiting.cleared')
  assert.equal('id' in clearedTwo && clearedTwo.id, 'approval:demo:session-1:two')
  transport.emit(resolved('one'))
  const clearedOne = await next(events)
  assert.equal(clearedOne.type, 'waiting.cleared')
  assert.equal('id' in clearedOne && clearedOne.id, 'approval:demo:session-1:one')
  client.close()
})

test('reconnect yields gap then the whole unchanged baseline, and resumes diffing', async () => {
  const first = new ScriptedTransport(), second = new ScriptedTransport()
  first.baseline = second.baseline = [execution(), cards(), team(), approval('one')]
  let opens = 0
  const client = await connect({ transport: async () => ++opens === 1 ? first : second, client: clientInfo, subscribe: { topics: ['runs', 'cards', 'teams', 'waiting'] } })
  const events = client.events()[Symbol.asyncIterator]()
  assert.deepEqual((await Promise.all(Array.from({ length: 6 }, () => next(events)))).map(e => e.type), ['hello', 'run.changed', 'card.changed', 'waiting', 'team.changed', 'waiting'])
  first.close()
  assert.equal((await next(events)).type, 'gap')
  assert.deepEqual((await Promise.all(Array.from({ length: 5 }, () => next(events)))).map(e => e.type), ['run.changed', 'card.changed', 'waiting', 'team.changed', 'waiting'])
  assert.deepEqual(second.requests.map(r => r.method), ['client/hello', 'client/subscribe'])
  second.emit(execution()); second.emit(cards()); second.emit(team()); second.emit(approval('one'))
  client.close()
  assert.equal((await next(events)).type, 'end')
  assert.equal((await events.next()).done, true)
})

test('scoped run is read after each subscribe, including settlement during disconnect', async () => {
  const first = new ScriptedTransport(), second = new ScriptedTransport()
  second.execution = run({ state: 'settled', reason: 'Done' })
  let opens = 0
  const client = await connect({ transport: async () => ++opens === 1 ? first : second, client: clientInfo, subscribe: { topics: ['runs'], scope: { run: 'run-1' } } })
  const events = client.events()[Symbol.asyncIterator]()
  await next(events)
  assert.equal((await next(events)).type, 'run.changed')
  first.close()
  assert.equal((await next(events)).type, 'gap')
  const changed = await next(events)
  assert.equal(changed.type === 'run.changed' && changed.state, 'settled')
  assert.deepEqual(second.requests.map(r => r.method), ['client/hello', 'client/subscribe', 'flow/execution'])
  client.close()
})

test('raw notifications stay ordered while slow events consumers never block calls', async () => {
  const transport = new ScriptedTransport()
  const client = await connect({ transport: async () => transport, client: clientInfo })
  transport.emit(execution()); transport.emit(cards())
  assert.deepEqual(await client.call('goal/list', {}), [])
  const raw = client.notifications()[Symbol.asyncIterator]()
  assert.deepEqual((await raw.next()).value, execution())
  assert.deepEqual((await raw.next()).value, cards())
  client.close()
})

test('host shutdown ends stream and never reconnects', async () => {
  const transport = new ScriptedTransport()
  let opens = 0
  const client = await connect({ transport: async () => { opens++; return transport }, client: clientInfo })
  transport.emit({ method: 'host/shutdown', params: { reason: 'quit' } })
  transport.close()
  const all: ClientEvent[] = []
  for await (const event of client.events()) all.push(event)
  assert.deepEqual(all.map(e => e.type), ['hello', 'end'])
  assert.equal(all[1]?.type === 'end' && all[1].reason, 'desk-closed')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(opens, 1)
})

function typeRefusal(client: Awaited<ReturnType<typeof connect>>) {
  // @ts-expect-error terminal/open exists on the wire, but not on the client surface.
  void client.call('terminal/open', { cwd: '/tmp/demo' })
}
void typeRefusal

test('person roles in legacy documents also wait while their round is open', async () => {
  const transport = new ScriptedTransport()
  const client = await connect({ transport: async () => transport, client: clientInfo, subscribe: { topics: ['waiting'] } })
  transport.emit(execution(run({ document: { format: 'legacy', flow: { name: 'demo-flow', roles: [{ id: 'person', kind: 'person', outcomes: ['accept'] }] } } as unknown as FlowExecution['document'] })))
  transport.emit(cards())
  client.close()
  const all: ClientEvent[] = []
  for await (const event of client.events()) all.push(event)
  assert.deepEqual(all.map(e => e.type), ['hello', 'waiting', 'end'])
})

test('replacement subscribe changes event topics and is replayed on reconnect', async () => {
  const first = new ScriptedTransport(), second = new ScriptedTransport()
  let opens = 0
  const client = await connect({ transport: async () => ++opens === 1 ? first : second, client: clientInfo, subscribe: { topics: ['runs'] } })
  const replacement = { topics: ['cards'] as const }
  await client.call('client/subscribe', replacement)
  first.emit(execution()); first.emit(cards())
  const events = client.events()[Symbol.asyncIterator]()
  await next(events)
  assert.equal((await next(events)).type, 'gap')
  assert.equal((await next(events)).type, 'card.changed')
  first.close()
  assert.equal((await next(events)).type, 'gap')
  await waitFor(() => second.requests.some(r => r.method === 'client/subscribe'))
  assert.deepEqual(second.requests.find(r => r.method === 'client/subscribe')?.params, replacement)
  client.close()
})

test('drop just after the initial subscribe response still reconnects', async () => {
  const first = new ScriptedTransport(), second = new ScriptedTransport()
  const send = first.send.bind(first)
  first.send = request => { send(request); if (request.method === 'client/subscribe') first.close() }
  let opens = 0
  const client = await connect({ transport: async () => ++opens === 1 ? first : second, client: clientInfo, subscribe: { topics: ['runs'] } })
  await waitFor(() => second.requests.some(r => r.method === 'client/subscribe'))
  assert.equal(opens, 2)
  client.close()
})

const personBaseline = (id: string): WireNotification[] => [execution(run({ id: `run-${id}`, goal: id })), cards({ ...board(), id })]

test('accepted replacement resets the selected projection before its synchronous whole baseline', async t => {
  const transport = new ScriptedTransport()
  transport.baseline = personBaseline('team-a')
  const client = await connect({ transport: async () => transport, client: clientInfo, subscribe: { topics: ['waiting'] } })
  t.after(() => client.close())
  transport.baseline = personBaseline('team-b')
  await client.call('client/subscribe', { topics: ['waiting'], scope: { team: 'team-b' as never } })
  client.close()
  const all: ClientEvent[] = []
  for await (const event of client.events()) all.push(event)
  assert.deepEqual(all.map(e => e.type), ['hello', 'waiting', 'gap', 'waiting', 'end'])
  assert.equal(all[2]?.type === 'gap' && all[2].reason, 'subscription-changed')
  assert.equal(all[3]?.type === 'waiting' && all[3].id, 'card:team-b:1')
})

test('unsubscribe then resubscribe replays unchanged items after each accepted boundary', async t => {
  const transport = new ScriptedTransport()
  transport.baseline = personBaseline('team-a')
  const client = await connect({ transport: async () => transport, client: clientInfo, subscribe: { topics: ['waiting'] } })
  t.after(() => client.close())
  transport.baseline = []
  await client.call('client/subscribe', { topics: [] })
  transport.baseline = personBaseline('team-a')
  await client.call('client/subscribe', { topics: ['waiting'] })
  client.close()
  const all: ClientEvent[] = []
  for await (const event of client.events()) all.push(event)
  assert.deepEqual(all.map(e => e.type), ['hello', 'waiting', 'gap', 'gap', 'waiting', 'end'])
  assert.equal(all[4]?.type === 'waiting' && all[4].id, 'card:team-a:1')
})

test('a refused replacement preserves acknowledged topics and projection throughout the proposal', async t => {
  const transport = new ScriptedTransport()
  transport.baseline = personBaseline('team-a')
  const client = await connect({ transport: async () => transport, client: clientInfo, subscribe: { topics: ['waiting'] } })
  t.after(() => client.close())
  const original = transport.send.bind(transport)
  transport.send = request => { if (request.method === 'client/subscribe') transport.requests.push(request); else original(request) }
  const proposal = client.call('client/subscribe', { topics: ['teams'] })
  const refused = assert.rejects(proposal, e => e instanceof WireCallError && e.code === 'tierNotGranted')
  transport.emit(execution(run({ id: 'run-team-a', goal: 'team-a', state: 'stopped' })))
  transport.message({ id: transport.requests.at(-1)!.id, ok: false, error: { code: 'tierNotGranted', message: 'Refused' } })
  await refused
  client.close()
  const all: ClientEvent[] = []
  for await (const event of client.events()) all.push(event)
  assert.deepEqual(all.map(e => e.type), ['hello', 'waiting', 'waiting.cleared', 'end'])
})

for (const code of ['incompatible', 'deskTooOld', 'notOnClientSurface', 'tierNotGranted']) {
  test(`fatal reconnect ${code} emits error end, then throws original wire error without a third transport`, async t => {
    const first = new ScriptedTransport(), second = new ScriptedTransport()
    let opens = 0
    second.send = request => {
      second.requests.push(request)
      second.message({ id: request.id, ok: false, error: { code, message: 'Cannot reconnect', details: 'Specific detail', data: { retry: false } } })
    }
    const client = await connect({ transport: async () => ++opens === 1 ? first : second, client: clientInfo })
    t.after(() => client.close())
    first.close()
    const all: ClientEvent[] = []
    let caught: unknown
    try { for await (const event of client.events()) all.push(event) } catch (error) { caught = error }
    assert.deepEqual(all.map(e => e.type), ['hello', 'end'])
    const end = all.at(-1)
    assert.equal(end?.type === 'end' && end.reason, 'error')
    assert.ok(caught instanceof WireCallError)
    assert.equal(caught.code, code)
    assert.equal(caught.message, 'Cannot reconnect')
    assert.equal(caught.details, 'Specific detail')
    assert.deepEqual(caught.data, { retry: false })
    await assert.rejects(client.notifications()[Symbol.asyncIterator]().next(), error => error === caught)
    await new Promise(resolve => setTimeout(resolve, 125))
    assert.equal(opens, 2)
  })
}

test('scoped public subscribe deadline includes its execution read and preserves the accepted selection', async t => {
  const first = new ScriptedTransport(), second = new ScriptedTransport()
  let opens = 0
  const client = await connect({ transport: async () => ++opens === 1 ? first : second, client: clientInfo, subscribe: { topics: ['teams'] } })
  t.after(() => client.close())
  first.reply = false
  const selected = { topics: ['runs'] as const, scope: { run: 'run-1' } }
  let failure: unknown
  void client.call('client/subscribe', selected, { deadlineMs: 10 }).catch(error => { failure = error })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.ok(failure instanceof WireCallError && failure.code === 'deadline', 'the whole scoped call uses the deadline')
  assert.equal(first.requests.filter(r => r.method === 'flow/execution').length, 1)
  first.close()
  await waitFor(() => second.requests.some(r => r.method === 'client/subscribe'))
  assert.deepEqual(second.requests.find(r => r.method === 'client/subscribe')?.params, selected)
})

test('two concurrent refused replacements never become the reconnect selection', async t => {
  const first = new ScriptedTransport(), second = new ScriptedTransport()
  let opens = 0
  const selected = { topics: ['teams'] as const }
  const client = await connect({ transport: async () => ++opens === 1 ? first : second, client: clientInfo, subscribe: selected })
  t.after(() => client.close())
  const original = first.send.bind(first)
  first.send = request => { if (request.method === 'client/subscribe') first.requests.push(request); else original(request) }
  const one = assert.rejects(client.call('client/subscribe', { topics: ['runs'], scope: { run: 'missing-a' } }), e => e instanceof WireCallError && e.code === 'notFound')
  const two = assert.rejects(client.call('client/subscribe', { topics: ['runs'], scope: { run: 'missing-b' } }), e => e instanceof WireCallError && e.code === 'notFound')
  for (const request of first.requests.slice(-2)) first.message({ id: request.id, ok: false, error: { code: 'notFound', message: 'Run missing' } })
  await Promise.all([one, two])
  first.close()
  await waitFor(() => second.requests.some(r => r.method === 'client/subscribe'))
  assert.deepEqual(second.requests.find(r => r.method === 'client/subscribe')?.params, selected)
})

test('unacknowledged replacement timeout discards late scope data and reconnects the acknowledged selection', async t => {
  const first = new ScriptedTransport(), second = new ScriptedTransport()
  first.baseline = second.baseline = personBaseline('team-a')
  let opens = 0
  const selected = { topics: ['waiting'] as const }
  const client = await connect({ transport: async () => ++opens === 1 ? first : second, client: clientInfo, subscribe: selected })
  t.after(() => client.close())
  const original = first.send.bind(first)
  first.send = request => { if (request.method === 'client/subscribe') first.requests.push(request); else original(request) }
  await assert.rejects(client.call('client/subscribe', { topics: ['waiting'], scope: { team: 'team-b' as never } }, { deadlineMs: 5 }), e => e instanceof WireCallError && e.code === 'deadline')
  first.message({ id: first.requests.at(-1)!.id, ok: true, result: null })
  for (const notification of personBaseline('team-b')) first.emit(notification)
  await waitFor(() => second.requests.some(r => r.method === 'client/subscribe'))
  assert.deepEqual(second.requests.find(r => r.method === 'client/subscribe')?.params, selected)
  client.close()
  const all: ClientEvent[] = []
  for await (const event of client.events()) all.push(event)
  assert.deepEqual(all.map(e => e.type), ['hello', 'waiting', 'gap', 'waiting', 'end'])
  assert.ok(all.every(e => e.type !== 'waiting' || e.id === 'card:team-a:1'))
})
