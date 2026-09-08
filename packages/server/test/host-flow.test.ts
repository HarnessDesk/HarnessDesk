import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BackgroundTask, Session, SessionQueue } from '@harnessdesk/protocol'

import { FAKE_RUNTIME_ID, type FakeSession } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'

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
