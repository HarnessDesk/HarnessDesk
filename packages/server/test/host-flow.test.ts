import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BackgroundTask, FlowRun, GoalView, Session, SessionQueue, TeamState, WrapPreview } from '@harnessdesk/protocol'

import { FAKE_RUNTIME_ID, type FakeSession } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * One flow through the real host, over the wire.
 *
 * `methods.test.ts` proves each handler against a hand-built context. This
 * proves the other half: that the context the host actually builds — every
 * closure over its private state — still says what the handlers assume, on a
 * path that crosses several domains in one sitting. It is the smoke a large
 * relocation owes its reviewers, and the test that catches the day a closure
 * and a handler drift apart while each still passes alone.
 */

const queueOf = (client: Client): SessionQueue | null => {
  for (let index = client.events.length - 1; index >= 0; index -= 1) {
    const event = client.events[index]
    if (event?.type === 'session/queue') return event.queue
  }
  return null
}

const say = (text: string) => [{ type: 'text' as const, text }]

test('hello → create → send-or-queue → tasks → confined read → routes and their credential → close', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // The handshake names the runtime the rest of the flow speaks to.
  const hello = (await client.call('host/hello', { clientVersion: 'test' })) as {
    protocolVersion: number
    runtimes: readonly { id: string }[]
  }
  assert.equal(hello.protocolVersion, 1)
  assert.ok(hello.runtimes.some((runtime) => runtime.id === FAKE_RUNTIME_ID))

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  const address = { runtime: FAKE_RUNTIME_ID, sessionId: session.id }

  // Idle: the message goes straight out. Working: the next one waits.
  const first = await client.call('turn/queue', { ...address, input: say('the first thing') })
  assert.deepEqual(first, { queuedId: null, sent: true })
  await client.until(() => client.events.some((event) => event.type === 'turn/started'))
  const second = (await client.call('turn/queue', { ...address, input: say('and then') })) as {
    queuedId: string | null
    sent: boolean
  }
  assert.equal(second.sent, false)
  assert.ok(second.queuedId)
  await client.until(() => queueOf(client)?.messages.length === 1)

  // The runtime's background work, asked of the runtime and held by the host.
  const task: BackgroundTask = {
    id: 'bg-1',
    label: 'Watch the tests',
    kind: 'command',
    state: 'running',
    startedAt: Date.now(),
    stoppable: true,
  }
  harness.runtime.tasks.put(session.id, [task])
  const tasks = (await client.call('tasks/list', address)) as readonly BackgroundTask[]
  assert.deepEqual(tasks.map((entry) => entry.id), ['bg-1'])

  // A file inside the conversation's folder reads; one outside every open root does not.
  const read = (await client.call('workspace/readFile', { runtime: FAKE_RUNTIME_ID, path: '/w/README.md' })) as {
    content: string
    hash: string
  }
  assert.equal(read.content, 'from the fake runtime')
  assert.match(read.hash, /^[0-9a-f]{64}$/)
  await assert.rejects(
    client.call('workspace/readFile', { runtime: FAKE_RUNTIME_ID, path: '/elsewhere/secret.txt' }),
  )
  assert.equal(harness.runtime.files.calls.includes('read /elsewhere/secret.txt'), false)

  // A route over a stored credential, listed, then deleted — and the credential
  // nothing else refers to goes with it, through the real broker.
  const { ref } = (await client.call('credentials/store', { name: 'gateway key', value: 'sk-test' })) as {
    ref: string
  }
  const { id: routeId } = (await client.call('routes/save', {
    name: 'Elsewhere',
    endpoint: 'https://example.invalid/v1',
    wireProtocol: 'responses',
    credentialRef: ref,
  })) as { id: string }
  const listed = (await client.call('routes/list', { runtime: FAKE_RUNTIME_ID })) as readonly { id: string }[]
  assert.deepEqual(listed.map((route) => route.id), [routeId])
  await client.call('routes/delete', { id: routeId })
  assert.deepEqual(await client.call('routes/list', {}), [])
  assert.deepEqual(await client.call('credentials/list', {}), [])

  // The queued message is still waiting; closing the handle does not lose it.
  await client.call('session/close', address)
  assert.equal(queueOf(client)?.messages.length, 1)
})

test('two messages typed in the same breath on an idle conversation: one goes out, the other waits behind it', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  const address = { runtime: FAKE_RUNTIME_ID, sessionId: session.id }
  const live = harness.runtime.sessions.get(session.id) as FakeSession
  // Wide enough for the second request to land while the first is still on
  // its way to the agent — the window in which the session still reads idle.
  live.sendDelayMs = 60

  const results = (await Promise.all([
    client.call('turn/queue', { ...address, input: say('one') }),
    client.call('turn/queue', { ...address, input: say('two') }),
  ])) as { queuedId: string | null; sent: boolean }[]
  assert.equal(results.filter((result) => result.sent).length, 1, 'exactly one went straight out')
  assert.equal(results.filter((result) => !result.sent && result.queuedId).length, 1, 'the other waits')
  await client.until(() => queueOf(client)?.messages.length === 1)

  // The turn ends and the waiting one follows it, in order, with nothing lost.
  live.finish()
  await client.until(() => queueOf(client)?.messages.length === 0)
  const starts = client.events.filter((event) => event.type === 'turn/started')
  assert.equal(starts.length, 2)
})

test('a send the agent never accepts stops counting as busy after the deadline, so nothing waits behind it forever', async (t) => {
  // The mark is a guard against two messages in one breath, not a lock: the
  // deadline is what keeps a silent agent from holding every later message.
  const harness = await start({ sendAcceptDeadlineMs: 50 })
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  const address = { runtime: FAKE_RUNTIME_ID, sessionId: session.id }
  const live = harness.runtime.sessions.get(session.id) as FakeSession
  live.sendDelayMs = 400

  const first = client.call('turn/queue', { ...address, input: say('one') })
  // Well inside the agent's silence, and well past the deadline.
  await new Promise((resolve) => setTimeout(resolve, 150))
  const second = (await client.call('turn/queue', { ...address, input: say('two') })) as {
    queuedId: string | null
    sent: boolean
  }
  assert.equal(second.sent, true, 'the conversation is judged by its session again')
  assert.deepEqual(await first, { queuedId: null, sent: true })
})

test('wrapped or restored Goal cannot dispatch', async (t) => {
  const work = tempDir('hd-flow-wrap-barrier-')
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: work })
  const goal = (await client.call('goal/create', { root: work, sentence: 'Hold the barrier' }) as GoalView).goal.id
  const nothing = { summary: 'Nothing was left to do.', cards: [] }
  const early = await client.call('goal/preview', { goal, choices: nothing }) as WrapPreview

  // A run starts between the preview and the wrap: its Seat opens and gets its order.
  const run = await client.call('flow/start', { room: goal, source: [
    'name: Barrier', 'roles:', '  worker: { kind: agent, seat: fake, permission: publish, outcomes: [done], order: Do the card. }',
    'seed: { role: worker, title: The card }', 'rules: []', '',
  ].join('\n') }) as FlowRun
  assert.equal(run.state, 'running')
  const seated = run.seats[0]!
  assert.ok(harness.runtime.sessions.has(seated.sessionId))
  await client.until(() => client.events.some((event) => event.type === 'turn/started'))

  // The wrap stops the run's dispatch first; its stale stamp is then refused, and nothing was wrapped.
  await assert.rejects(client.call('goal/wrap', { goal, stamp: early.stamp, choices: nothing }))
  const runs = await client.call('flow/runs', { room: goal }) as readonly FlowRun[]
  assert.equal(runs.at(-1)?.state, 'stopped')
  assert.equal((await client.call('goal/read', { goal }) as GoalView).goal.state, 'open')
  // Stopping kept the conversation and what it had said so far.
  assert.ok(harness.runtime.sessions.has(seated.sessionId), 'the partial answer is retained')

  // Its turn ends on its own; the stopped run sends it nothing more.
  const before = client.events.filter((event) => event.type === 'turn/started').length
  ;(harness.runtime.sessions.get(seated.sessionId) as FakeSession).finish()
  await client.until(() => client.events.some((event) => event.type === 'turn/completed'))
  assert.equal(client.events.filter((event) => event.type === 'turn/started').length, before, 'a stopped run re-arms nobody')

  // Wrapped now, nothing more can be dispatched onto it. The board's own write lands behind the run's.
  let board = (await client.call('goal/read', { goal }) as GoalView).board
  for (let tries = 0; board.intents.length === 0 && tries < 100; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    board = (await client.call('goal/read', { goal }) as GoalView).board
  }
  assert.equal(board.intents.length, 1, 'the run’s one card is on the Goal')
  const choices = { summary: 'Stopped by hand.', cards: board.intents.map((card) => ({ id: card.id, resolution: 'dropped' as const, reason: 'The run was stopped.' })) }
  const preview = await client.call('goal/preview', { goal, choices }) as WrapPreview
  await client.call('goal/wrap', { goal, stamp: preview.stamp, choices })
  const sessions = harness.runtime.sessions.size
  const turns = client.events.filter((event) => event.type === 'turn/started').length
  const channel = (await client.call('team/state', { room: goal }) as TeamState).channel.length
  await assert.rejects(client.call('flow/start', { room: goal, source: 'name: Late\nroles:\n  w: { kind: agent, seat: fake, order: W }\nseed: { role: w, title: W }\n' }), /closing|wrapped/)
  assert.equal(harness.runtime.sessions.size, sessions, 'no runtime was started')
  assert.equal(client.events.filter((event) => event.type === 'turn/started').length, turns, 'no turn was sent')
  assert.equal((await client.call('team/state', { room: goal }) as TeamState).channel.length, channel, 'no channel traffic')
})
