import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sessionId, type Session, type SessionQueue, type UserContent } from '@harnessdesk/protocol'

import { QUEUE_LIMIT } from '../src/registry.js'
import { FAKE_RUNTIME_ID, type FakeSession } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'

/**
 * Typing while the agent works.
 *
 * The behaviour these hold is the one the feature exists for: **a message the
 * user typed is never lost**. Not when the agent cannot take input mid-turn,
 * not when the turn fails, not when the window reloads. Every test below is
 * one way that used to be false.
 */

const queueOf = (client: Client): SessionQueue | null => {
  for (let index = client.events.length - 1; index >= 0; index -= 1) {
    const event = client.events[index]
    if (event?.type === 'session/queue') return event.queue
  }
  return null
}

const text = (message: { input: readonly UserContent[] }): string => {
  const part = message.input[0]
  return part?.type === 'text' ? part.text : ''
}

/** A session with a turn already running, which is the state this is all about. */
const busySession = async (
  client: Client,
  harness: Awaited<ReturnType<typeof start>>,
): Promise<{ session: Session; live: FakeSession }> => {
  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await client.call('turn/send', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'the first thing' }],
  })
  await client.until(() => client.events.some((event) => event.type === 'turn/started'))
  return { session, live: harness.runtime.sessions.get(session.id) as FakeSession }
}

test('a message typed mid-turn waits, and goes out when the turn ends', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const { session, live } = await busySession(client, harness)

  const result = (await client.call('turn/queue', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'and then run the tests' }],
  })) as { queuedId: string | null; sent: boolean }
  assert.equal(result.sent, false)
  assert.ok(result.queuedId)

  await client.until(() => queueOf(client)?.messages.length === 1)
  assert.equal(queueOf(client)?.status, 'waiting')

  live.finish()
  await client.until(() => queueOf(client)?.messages.length === 0)

  const record = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))
  const prompts = record!.session.turns.flatMap((turn) =>
    turn.items.filter((item) => item.type === 'userMessage'),
  )
  assert.deepEqual(
    prompts.map((item) => (item.type === 'userMessage' && item.content[0]?.type === 'text' ? item.content[0].text : '')),
    ['the first thing', 'and then run the tests'],
  )
})

test('several messages go out one turn at a time, in the order they were typed', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const { session, live } = await busySession(client, harness)

  for (const line of ['second', 'third', 'fourth']) {
    await client.call('turn/queue', {
      runtime: FAKE_RUNTIME_ID,
      sessionId: session.id,
      input: [{ type: 'text', text: line }],
    })
  }
  await client.until(() => queueOf(client)?.messages.length === 3)

  // Each finish releases exactly one: merging two of the user's messages into
  // one turn would put words in their mouth.
  live.finish()
  await client.until(() => queueOf(client)?.messages.length === 2)
  assert.deepEqual(queueOf(client)?.messages.map(text), ['third', 'fourth'])

  live.finish()
  await client.until(() => queueOf(client)?.messages.length === 1)
  live.finish()
  await client.until(() => queueOf(client)?.messages.length === 0)

  const record = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))
  assert.equal(record!.session.turns.length, 4)
})

test('a turn that was stopped holds the queue rather than firing it', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const { session, live } = await busySession(client, harness)

  await client.call('turn/queue', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'still waiting' }],
  })
  await client.until(() => queueOf(client)?.messages.length === 1)

  await live.interrupt()
  await client.until(() => queueOf(client)?.status === 'paused')
  assert.equal(queueOf(client)?.messages.length, 1)
  assert.match(queueOf(client)?.reason ?? '', /stopped/i)

  // Nothing new ran: pressing Stop must not become "send the next thing".
  const record = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))
  assert.equal(record!.session.turns.length, 1)

  // And the way out is one call, with the message intact.
  await client.call('turn/queue/flush', { runtime: FAKE_RUNTIME_ID, sessionId: session.id })
  await client.until(() => queueOf(client)?.messages.length === 0)
  assert.equal(
    harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))!.session.turns.length,
    2,
  )
})

test('a turn that failed holds the queue and repeats the backend\'s reason', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const { session, live } = await busySession(client, harness)

  await client.call('turn/queue', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'the follow-up' }],
  })
  await client.until(() => queueOf(client)?.messages.length === 1)

  // The case this rule is for: sending the rest of the queue into a limit
  // would fail every one of them and spend the retries doing it.
  live.fail('You have hit your usage limit.')
  await client.until(() => queueOf(client)?.status === 'paused')
  assert.equal(queueOf(client)?.reason, 'You have hit your usage limit.')
  assert.equal(
    harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))!.session.turns.length,
    1,
  )
})

test('a queued message can be dropped, reordered, and thrown away wholesale', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const { session } = await busySession(client, harness)

  const ids: string[] = []
  for (const line of ['a', 'b', 'c']) {
    const result = (await client.call('turn/queue', {
      runtime: FAKE_RUNTIME_ID,
      sessionId: session.id,
      input: [{ type: 'text', text: line }],
    })) as { queuedId: string }
    ids.push(result.queuedId)
  }
  await client.until(() => queueOf(client)?.messages.length === 3)

  await client.call('turn/queue/move', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    id: ids[2],
    to: 0,
  })
  await client.until(() => queueOf(client)?.messages[0] !== undefined && text(queueOf(client)!.messages[0]!) === 'c')
  assert.deepEqual(queueOf(client)?.messages.map(text), ['c', 'a', 'b'])

  await client.call('turn/queue/cancel', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    id: ids[0],
  })
  await client.until(() => queueOf(client)?.messages.length === 2)
  assert.deepEqual(queueOf(client)?.messages.map(text), ['c', 'b'])

  // A second cancel of the same id is not an error: it already left.
  await client.call('turn/queue/cancel', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    id: ids[0],
  })

  await client.call('turn/queue/clear', { runtime: FAKE_RUNTIME_ID, sessionId: session.id })
  await client.until(() => queueOf(client)?.messages.length === 0)
})

test('queueing on an idle conversation sends at once', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  const result = (await client.call('turn/queue', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'go' }],
  })) as { queuedId: string | null; sent: boolean }

  // Otherwise the message would sit waiting for a turn that never starts.
  assert.deepEqual(result, { queuedId: null, sent: true })
  await client.until(() => client.events.some((event) => event.type === 'turn/started'))
})

test('the queue survives the window closing and reopening', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))

  const first = await Client.connect(harness.server)
  const { session } = await busySession(first, harness)
  await first.call('turn/queue', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'do not lose me' }],
  })
  await first.until(() => queueOf(first)?.messages.length === 1)
  first.close()
  await new Promise((resolve) => setTimeout(resolve, 50))

  const second = await Client.connect(harness.server)
  t.after(() => second.close())
  await second.until(() => second.notifications.some((m) => 'method' in m && m.method === 'sync'))
  const sync = second.notifications.find((m) => 'method' in m && m.method === 'sync')
  assert.ok(sync && 'method' in sync && sync.method === 'sync')
  assert.equal(sync.params.queues.length, 1)
  assert.equal(text(sync.params.queues[0]!.queue.messages[0]!), 'do not lose me')
})

test('a full queue is refused out loud rather than swallowing the message', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const { session } = await busySession(client, harness)

  for (let index = 0; index < QUEUE_LIMIT; index += 1) {
    await client.call('turn/queue', {
      runtime: FAKE_RUNTIME_ID,
      sessionId: session.id,
      input: [{ type: 'text', text: `message ${index}` }],
    })
  }
  await assert.rejects(
    client.call('turn/queue', {
      runtime: FAKE_RUNTIME_ID,
      sessionId: session.id,
      input: [{ type: 'text', text: 'one too many' }],
    }),
    /already waiting/,
  )
  assert.equal(queueOf(client)?.messages.length, QUEUE_LIMIT)
})

test('flushing is refused while a turn is running, and says what to do instead', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const { session } = await busySession(client, harness)

  await client.call('turn/queue', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'later' }],
  })
  await assert.rejects(
    client.call('turn/queue/flush', { runtime: FAKE_RUNTIME_ID, sessionId: session.id }),
    /still running/,
  )
})

test('“send this when it is back” sends it when it is back', async (t) => {
  // The queue is held when the agent goes down, and the way back is the
  // button on the held queue. Before this, pressing it re-paused with the
  // same sentence forever: the drain found no live handle and gave up,
  // although the agent it was waiting for had already returned.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const { session } = await busySession(client, harness)

  await client.call('turn/queue', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'say this when you can' }],
  })
  await client.until(() => queueOf(client)?.messages.length === 1)

  harness.runtime.setHealth({ state: 'unavailable', reason: 'unknown', message: 'restarting' })
  await client.until(() => queueOf(client)?.status === 'paused')
  harness.runtime.setHealth({ state: 'ready' })

  await client.call('turn/queue/flush', { runtime: FAKE_RUNTIME_ID, sessionId: session.id })
  await client.until(() => queueOf(client)?.messages.length === 0)
  const record = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))
  assert.equal(record?.queue.status, 'waiting', 'the hold is over, not renewed')
  assert.ok(record?.live, 'and the conversation is attached again')
})

test('two drains racing for one queue send the message once', async (t) => {
  // The drain lock used to go on only after the wait for a live
  // conversation, so two triggers in the same breath — say a double-pressed
  // flush — both passed the "already draining" check and the same message
  // went to the agent twice.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const { session } = await busySession(client, harness)

  await client.call('turn/queue', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'exactly once' }],
  })
  await client.until(() => queueOf(client)?.messages.length === 1)

  // Down and back: the reopening is the await the two drains race across.
  harness.runtime.setHealth({ state: 'unavailable', reason: 'unknown', message: 'restarting' })
  await client.until(() => queueOf(client)?.status === 'paused')
  harness.runtime.setHealth({ state: 'ready' })

  // The loser of the race may be told the turn already runs; what matters is
  // below — how many times the agent was handed the message.
  const flush = (): Promise<unknown> =>
    client.call('turn/queue/flush', { runtime: FAKE_RUNTIME_ID, sessionId: session.id }).catch(() => null)
  await Promise.all([flush(), flush()])
  await client.until(() => queueOf(client)?.messages.length === 0)
  // A beat for a straggling duplicate to land before it is counted absent.
  await new Promise((resolve) => setTimeout(resolve, 50))

  const sends = client.events.filter(
    (event) =>
      event.type === 'item/started' &&
      event.item.type === 'userMessage' &&
      event.item.content.some((part) => part.type === 'text' && part.text === 'exactly once'),
  )
  assert.equal(sends.length, 1, 'the queued message went out exactly once')
})

test('the agent going down holds the queue instead of dropping it', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const { session } = await busySession(client, harness)

  await client.call('turn/queue', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'survive the crash' }],
  })
  await client.until(() => queueOf(client)?.messages.length === 1)

  harness.runtime.setHealth({ state: 'unavailable', reason: 'crashed', message: 'gone' })
  await client.until(() => client.notifications.some((m) => 'method' in m && m.method === 'runtime/healthChanged'))

  const record = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))
  assert.equal(record!.queue.messages.length, 1)
  assert.equal(record!.queue.status, 'paused')
})
