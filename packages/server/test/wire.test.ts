import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'

import {
  allItems,
  approvalId,
  isBusy,
  itemId,
  runtimeId,
  sessionId,
  turnId,
  type AgentEvent,
  type HostMethodName,
  type HostToClient,
  type Session,
} from '@harnessdesk/protocol'
import WebSocket from 'ws'

import { Host, Logger, StateStore, serve } from '../src/index.js'
import { FAKE_RUNTIME_ID, FakeRuntime, type FakeSession } from './fixtures/fake-runtime.js'
import { Client, silent, start, stop } from './fixtures/harness.js'

/**
 * End-to-end over a real WebSocket against a fake runtime.
 *
 * No Codex is imported anywhere in this file, which is the point: if the host
 * can drive a full session without it, the runtime abstraction holds.
 */

test('the host binds to loopback only', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  assert.match(harness.server.url, /^http:\/\/127\.0\.0\.1:\d+$/)
})

test('a socket without the launch token is refused', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  await assert.rejects(() => Client.connect(harness.server, 'not-the-token'))
  await assert.rejects(() => Client.connect(harness.server, ''))
})

test('a new client receives a sync snapshot immediately', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  await client.until(() => client.notifications.length > 0)
  const sync = client.notifications[0]
  assert.equal('method' in sync! && sync.method, 'sync')
})

test('host/hello reports the protocol version, the runtimes and the home to shorten paths against', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const hello = (await client.call('host/hello', { clientVersion: '0.0.1' })) as {
    protocolVersion: number
    hostVersion: string
    runtimes: { id: string }[]
    home: string
  }
  assert.equal(hello.protocolVersion, 1)
  assert.equal(hello.hostVersion, '9.9.9')
  assert.deepEqual(hello.runtimes.map((r) => r.id), [FAKE_RUNTIME_ID])
  // The renderer has no home of its own; without this it cannot write `~` and
  // prints the machine's username into every screenshot of a path.
  assert.equal(hello.home, homedir())
})

test('an unknown method is refused rather than dispatched', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const refused = new Promise<HostToClient>((resolve) => {
    const check = setInterval(() => {
      const found = client.notifications.find((m) => 'ok' in m && m.ok === false)
      if (found) {
        clearInterval(check)
        resolve(found)
      }
    }, 10)
  })
  client.raw(JSON.stringify({ id: 99, method: 'runtime/exec-anything', params: {} }))
  const message = await refused
  assert.equal('ok' in message && message.ok, false)
})

test('a failed method carries the reason, not just the message', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // What an ACP agent hands back for a load it cannot serve: a message that
  // says nothing on its own, and the reason alongside it.
  harness.runtime.readFailure = Object.assign(new Error('Internal error'), {
    details: 'the query closed before it answered',
  })

  await assert.rejects(() =>
    client.call('session/read', { runtime: FAKE_RUNTIME_ID, sessionId: 'anything' }),
  )
  const failed = client.notifications.find((m) => 'ok' in m && m.ok === false)
  assert.ok(failed && 'ok' in failed && failed.ok === false, 'the client was told it failed')
  assert.equal(failed.error.message, 'Internal error')
  assert.equal(
    failed.error.details,
    'the query closed before it answered',
    'the detail survives the host and reaches the renderer',
  )
})

test('malformed params are rejected before reaching the host', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await assert.rejects(() => client.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: 's' }))
})

test('a full turn streams to the client and folds into session state', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session

  await client.call('turn/send', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'hello' }],
  })
  await client.until(() => client.events.some((event) => event.type === 'item/delta'))

  const live = harness.runtime.sessions.get(session.id) as FakeSession
  live.finish()
  await client.until(() => client.events.some((event) => event.type === 'turn/completed'))

  // The host's own copy must match what the client could rebuild from events.
  const record = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))
  const items = allItems(record!.session)
  assert.deepEqual(items.map((item) => item.type), ['userMessage', 'assistantMessage'])
  // The person's words, echoed.
  assert.equal(items[1]?.type === 'assistantMessage' ? items[1].text : '', 'echo: hello')
  assert.equal(record!.session.turns[0]?.status, 'completed')
})

/**
 * Leaving a working conversation and coming back to it.
 *
 * The renderer opens a conversation with a `session/read` followed by a
 * `session/resume`, whether or not it was the one on screen a moment ago. Both
 * used to answer from the agent's store, which knows nothing about the turn
 * running right now — so coming back mid-turn replaced the streaming
 * transcript with the store's older idea of the conversation, dropped every
 * delta that arrived afterwards, and saved the damage to the host transcript.
 */
test('a working conversation is still working, and still itself, when it is opened again', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const working = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await client.call('turn/send', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: working.id,
    input: [{ type: 'text', text: 'the long job' }],
  })
  await client.until(() => client.events.some((event) => event.type === 'item/delta'))

  // The user opens another conversation; this one is left running.
  const other = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await client.call('session/read', { runtime: FAKE_RUNTIME_ID, sessionId: other.id })
  await client.call('session/resume', { runtime: FAKE_RUNTIME_ID, sessionId: other.id })

  // It keeps working while it is off screen.
  const live = harness.runtime.sessions.get(working.id) as FakeSession
  await live.steer([{ type: 'text', text: 'while away' }])

  // Coming back to it: the same two calls the renderer makes.
  const read = (await client.call('session/read', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: working.id,
  })) as Session
  const resumed = (await client.call('session/resume', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: working.id,
  })) as Session
  for (const [label, session] of [['read', read], ['resume', resumed]] as const) {
    assert.equal(session.turns.length, 1, `${label} kept the turn`)
    assert.equal(session.turns[0]?.status, 'inProgress', `${label} kept it running`)
    const text = allItems(session).find((item) => item.type === 'assistantMessage')
    assert.equal(
      text?.type === 'assistantMessage' && text.text,
      'echo: the long job +while away',
      `${label} kept what streamed`,
    )
  }

  // And what streams after the return still lands.
  await live.steer([{ type: 'text', text: 'after' }])
  await client.until(() => {
    const items = allItems(harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(working.id))!.session)
    const message = items.find((item) => item.type === 'assistantMessage')
    return message?.type === 'assistantMessage' && message.text.endsWith('+after')
  })
  live.finish()
  await client.until(() => client.events.some((event) => event.type === 'turn/completed'))
  const record = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(working.id))!
  assert.equal(record.session.turns[0]?.status, 'completed')
  assert.deepEqual(
    allItems(record.session).map((item) => item.type),
    ['userMessage', 'assistantMessage'],
  )
})

test('a turn the store has not caught up with is not deleted by reading it', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await client.call('turn/send', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'hello' }],
  })
  await client.until(() => client.events.some((event) => event.type === 'item/delta'))
  const live = harness.runtime.sessions.get(session.id) as FakeSession
  live.finish()
  await client.until(() => client.events.some((event) => event.type === 'turn/completed'))

  // The turn is over, so the read is not short-circuited — and the store has
  // not written it down yet, which is the race a switch away can land in.
  harness.runtime.stored.set(session.id, [])
  const read = (await client.call('session/read', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
  })) as Session
  assert.equal(read.turns.length, 1, 'the turn we watched is ours to keep')
  assert.deepEqual(allItems(read).map((item) => item.type), ['userMessage', 'assistantMessage'])
})

test('a held live transcript is served when the backend refuses to read it', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await client.call('turn/send', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'hello' }],
  })
  await client.until(() => client.events.some((event) => event.type === 'item/delta'))
  const live = harness.runtime.sessions.get(session.id) as FakeSession
  live.finish()
  await client.until(() => client.events.some((event) => event.type === 'turn/completed'))

  // Codex 0.153.0 answers a read-with-turns of a thread it holds live with
  // "list_turns is not supported yet". The host watched every item of that
  // conversation; a refusal from the store must not become a notice over a
  // pane that already has the whole turn on it.
  harness.runtime.readFailure = new Error('list_turns is not supported yet')
  const read = (await client.call('session/read', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
  })) as Session
  assert.equal(read.turns.length, 1, 'the held turn is the read')
  assert.deepEqual(allItems(read).map((item) => item.type), ['userMessage', 'assistantMessage'])
  assert.ok(!client.notifications.some((m) => 'ok' in m && m.ok === false), 'nothing failed on the wire')
})

test('a turn left in progress by a dead agent is shown as stopped, not as working', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // What the store of a runtime that was killed mid-turn hands back: a turn
  // that says it is running, in a session that says it is active. Nothing here
  // is driving it — the agent is our own child process, so it died with us.
  harness.runtime.stored.set('killed-mid-turn', [
    {
      id: turnId('turn-cut-off'),
      status: 'inProgress',
      items: [{ id: itemId('u-1'), type: 'userMessage', content: [{ type: 'text', text: 'do it' }] }],
    },
  ])
  const read = (await client.call('session/read', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: 'killed-mid-turn',
  })) as Session
  assert.equal(read.turns[0]?.status, 'interrupted')
  assert.equal(read.status.type, 'idle')
  assert.equal(isBusy(read), false, 'the composer is free rather than stuck behind a dead turn')
})

test('a reconnecting client is handed state and any waiting approval', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))

  const first = await Client.connect(harness.server)
  const session = (await first.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await first.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, input: [{ type: 'text', text: 'hi' }] })

  const live = harness.runtime.sessions.get(session.id) as FakeSession
  const answered = live.askApproval(approvalId('ap-1'))
  await first.until(() => first.events.some((event) => event.type === 'approval/requested'))

  // The window closes mid-approval — the agent is still blocked.
  first.close()
  await new Promise((resolve) => setTimeout(resolve, 50))

  const second = await Client.connect(harness.server)
  t.after(() => second.close())
  await second.until(() => second.events.some((event) => event.type === 'approval/requested'))

  const sync = second.notifications.find((m) => 'method' in m && m.method === 'sync')
  assert.ok(sync && 'method' in sync && sync.method === 'sync')
  assert.equal(sync.params.sessions.length, 1)

  await second.call('approval/respond', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    approvalId: 'ap-1',
    decision: { type: 'option', optionId: 'opt-0' },
  })
  assert.deepEqual(await answered, { type: 'option', optionId: 'opt-0' })
})

test('two conversations asking at once are answered independently, and events say which runtime', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const a = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  const b = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  const liveA = harness.runtime.sessions.get(a.id) as FakeSession
  const liveB = harness.runtime.sessions.get(b.id) as FakeSession
  const answeredA = liveA.askApproval(approvalId('ap-a'))
  const answeredB = liveB.askApproval(approvalId('ap-b'))
  await client.until(
    () => client.events.filter((event) => event.type === 'approval/requested').length === 2,
  )

  // Every event on the wire is tagged with the runtime that produced it, so a
  // client can keep two runtimes' conversations apart even if ids collide.
  const tagged = client.notifications.filter(
    (message) => 'method' in message && message.method === 'event',
  )
  assert.ok(tagged.length > 0)
  for (const message of tagged) {
    assert.ok('method' in message && message.method === 'event' && message.params.runtime === FAKE_RUNTIME_ID)
  }

  // Answering B leaves A waiting: the registry keeps approvals per conversation.
  await client.call('approval/respond', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: b.id,
    approvalId: 'ap-b',
    decision: { type: 'option', optionId: 'opt-1' },
  })
  assert.deepEqual(await answeredB, { type: 'option', optionId: 'opt-1' })
  assert.ok(harness.host.registry.hasApproval(FAKE_RUNTIME_ID, sessionId(a.id), approvalId('ap-a')))
  assert.ok(!harness.host.registry.hasApproval(FAKE_RUNTIME_ID, sessionId(b.id), approvalId('ap-b')))

  // A's id with B's approval is refused: the pair is the identity.
  await assert.rejects(() =>
    client.call('approval/respond', {
      runtime: FAKE_RUNTIME_ID,
      sessionId: a.id,
      approvalId: 'ap-b',
      decision: { type: 'option', optionId: 'opt-0' },
    }),
  )
  await client.call('approval/respond', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: a.id,
    approvalId: 'ap-a',
    decision: { type: 'option', optionId: 'opt-0' },
  })
  assert.deepEqual(await answeredA, { type: 'option', optionId: 'opt-0' })
})

test('two clients both see the same event stream', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const a = await Client.connect(harness.server)
  const b = await Client.connect(harness.server)
  t.after(() => {
    a.close()
    b.close()
  })

  const session = (await a.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await a.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, input: [{ type: 'text', text: 'hey' }] })

  await a.until(() => a.events.some((event) => event.type === 'item/delta'))
  await b.until(() => b.events.some((event) => event.type === 'item/delta'))

  /* Finish the turn rather than compare mid-flight. `FakeSession.send` emits
     its four events synchronously and then waits: a turn completes when
     something completes it, and `live.finish()` is that something. Five tests
     in this file call it, four of them before this one; of the other 36, most
     never take a turn past its delta and one ends with `turn/interrupt`.

     The five above was wrong twice before it was right, both times from
     counting the bare string: a comment that mentions a call is counted as a
     call, so the sentence changes the number it reports — and then the
     sentence correcting it did the same. No unanchored count is quoted here
     for that reason, including the wrong ones. The check that cannot count
     itself matches a statement:

         grep -cE '^\s*live\.finish\(\)\s*$' packages/server/test/wire.test.ts

     An earlier version of this test asserted a racing tail that does not
     exist, and compared a prefix to work around it. */
  const live = harness.runtime.sessions.get(session.id) as FakeSession
  live.finish()
  await a.until(() => a.events.some((event) => event.type === 'turn/completed'))
  await b.until(() => b.events.some((event) => event.type === 'turn/completed'))

  /* "The same event stream" is not "each of them saw one event": two `some`
     checks pass on a host that answers whoever asked and dribbles a single
     delta to everyone else. The streams are compared whole and by value — ids,
     turn ids and delta text included — because a client that sent nothing has
     to be able to rebuild the same conversation as the one that did. */
  assert.deepEqual(b.events, a.events)
  /* The exact sequence, which also pins that nothing follows the completion:
     an equality against six named types fails if a seventh event arrives. */
  assert.deepEqual(
    a.events.map((event) => event.type),
    ['session/started', 'turn/started', 'item/started', 'item/started', 'item/delta', 'turn/completed'],
  )
})

/**
 * An agent is restarted for ordinary reasons — a catalogue refresh when the
 * window comes back into focus, a stored key changing — and every open
 * conversation loses its handle when it happens. What follows is the rule
 * that the conversation on screen must stay usable across that.
 */
test('a conversation whose agent restarted is reopened by the next thing said in it', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await client.call('turn/send', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'first' }],
  })
  await client.until(() => client.events.some((event) => event.type === 'item/delta'))

  // A restart: down, then up again, which is what a catalogue refresh is.
  harness.runtime.setHealth({ state: 'unavailable', reason: 'unknown', message: 'restarting' })
  await client.until(() =>
    client.notifications.some((m) => 'method' in m && m.method === 'runtime/healthChanged'),
  )
  assert.equal(harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))?.live, null)
  harness.runtime.setHealth({ state: 'ready' })

  // Nobody re-opened anything by hand; the next message does it.
  await client.call('turn/send', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'second' }],
  })
  const record = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))
  assert.ok(record?.live, 'the conversation is attached again')
  // And the composer is told what the new process declares, rather than
  // drawing the dead one's answer.
  await client.until(() => client.events.some((event) => event.type === 'session/options'))
})

test('everything arriving at once after a restart reopens the conversation once', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  harness.runtime.setHealth({ state: 'unavailable', reason: 'unknown', message: 'restarting' })
  await client.until(() =>
    client.notifications.some((m) => 'method' in m && m.method === 'runtime/healthChanged'),
  )
  harness.runtime.setHealth({ state: 'ready' })
  harness.runtime.resumes = 0

  // A window coming back to a conversation asks several things at once.
  await Promise.all([
    client.call('session/setTitle', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, title: 'named' }),
    client.call('turn/send', {
      runtime: FAKE_RUNTIME_ID,
      sessionId: session.id,
      input: [{ type: 'text', text: 'x' }],
    }),
    client.call('session/setTitle', {
      runtime: FAKE_RUNTIME_ID,
      sessionId: session.id,
      title: 'named twice',
    }),
  ])
  assert.equal(harness.runtime.resumes, 1, 'one resume between them, not one each')
})

test('an agent that cannot reopen a conversation says so, plainly', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  // An agent that keeps no store — DeepSeek Harness is the real one — has
  // nothing to resume from, so the refusal has to name what is actually lost.
  const forgetful = new FakeRuntime({
    id: runtimeId('forgetful'),
    name: 'Forgetful',
    capabilities: { resume: false },
  })
  harness.host.register(forgetful)
  await forgetful.start()
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: forgetful.info.id,
    options: { cwd: '/w' },
  })) as Session
  forgetful.setHealth({ state: 'unavailable', reason: 'unknown', message: 'restarting' })
  await client.until(() =>
    client.notifications.some((m) => 'method' in m && m.method === 'runtime/healthChanged'),
  )
  forgetful.setHealth({ state: 'ready' })

  await assert.rejects(
    () =>
      client.call('turn/send', {
        runtime: forgetful.info.id,
        sessionId: session.id,
        input: [{ type: 'text', text: 'x' }],
      }),
    /Start a new one/,
  )
})

test('a reopen that fails reports why, rather than a resume nobody can perform', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  harness.runtime.setHealth({ state: 'unavailable', reason: 'unknown', message: 'restarting' })
  await client.until(() =>
    client.notifications.some((m) => 'method' in m && m.method === 'runtime/healthChanged'),
  )
  harness.runtime.setHealth({ state: 'ready' })
  // A conversation the agent never wrote down — created, never prompted —
  // is the case that cannot be recovered at all.
  harness.runtime.resumeFailure = new Error('Session not found')

  await assert.rejects(
    () =>
      client.call('turn/send', {
        runtime: FAKE_RUNTIME_ID,
        sessionId: session.id,
        input: [{ type: 'text', text: 'x' }],
      }),
    /could not reopen this conversation: Session not found/,
  )
})

test('a runtime going unhealthy detaches its sessions and tells the client', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session

  harness.runtime.setHealth({ state: 'unavailable', reason: 'crashed', message: 'boom' })
  await client.until(() =>
    client.notifications.some((m) => 'method' in m && m.method === 'runtime/healthChanged'),
  )

  // The transcript survives; only the live handle is gone.
  assert.equal(harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))?.live, null)
  // And an agent that is *down* is not a restart to heal: reopening a
  // conversation into nothing would only fail later and less clearly.
  await assert.rejects(
    () => client.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, input: [{ type: 'text', text: 'x' }] }),
    /is not running: boom/,
  )
})

test('sign-in is relayed to the runtime, and its outcome arrives as an event', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  harness.runtime.signInDriveable = true
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const status = (await client.call('runtime/account', { runtime: FAKE_RUNTIME_ID })) as {
    signInMethods: { id: string }[]
  }
  assert.equal(status.signInMethods[0]?.id, 'fake-browser')

  const started = (await client.call('runtime/login', {
    runtime: FAKE_RUNTIME_ID,
    method: 'fake-browser',
  })) as { type: string; loginId: string; url: string }
  assert.equal(started.type, 'browser')
  assert.deepEqual(harness.runtime.logins, ['fake-browser'])

  await client.call('runtime/login/cancel', { runtime: FAKE_RUNTIME_ID, loginId: started.loginId })
  await client.until(() => client.events.some((event) => event.type === 'account/loginCompleted'))
  assert.deepEqual(harness.runtime.cancelled, [started.loginId])

  await client.call('runtime/logout', { runtime: FAKE_RUNTIME_ID })
  await client.until(() => client.events.some((event) => event.type === 'account/changed'))
})

test('a runtime with no sign-in to drive is refused in its own words', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  // A runtime that implements none of the optional sign-in verbs.
  Object.defineProperty(harness.runtime, 'login', { value: undefined })
  Object.defineProperty(harness.runtime, 'logout', { value: undefined })
  Object.defineProperty(harness.runtime, 'cancelLogin', { value: undefined })
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // The refusal is phrased from the runtime's own presentation — the host has
  // no name of its own to put there.
  await assert.rejects(
    () => client.call('runtime/login', { runtime: FAKE_RUNTIME_ID, method: 'fake-browser' }),
    /Fake Runtime has no sign-in to drive/,
  )
  await assert.rejects(
    () => client.call('runtime/logout', { runtime: FAKE_RUNTIME_ID }),
    /Fake Runtime/,
  )
  // Cancelling against a runtime with nothing to cancel is not an error.
  await client.call('runtime/login/cancel', { runtime: FAKE_RUNTIME_ID, loginId: 'x' })
})

test('workspaces persist across host restarts', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  const opened = (await client.call('workspace/open', { path: harness.stateDir })) as {
    path: string
    name: string
  }
  assert.equal(opened.path, harness.stateDir)
  client.close()
  await harness.server.close()
  await harness.host.dispose()

  // A second host over the same state directory must remember it.
  const runtime = new FakeRuntime()
  const host = new Host({
    logger: silent,
    state: new StateStore(join(harness.stateDir, 'state.json')),
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  t.after(async () => {
    await server.close()
    await host.dispose()
    await rm(harness.stateDir, { recursive: true, force: true })
  })

  const reconnected = await Client.connect(server)
  t.after(() => reconnected.close())
  const recent = (await reconnected.call('workspace/recent', {})) as { path: string }[]
  assert.equal(recent[0]?.path, harness.stateDir)
})

test('interrupt and steer route to the live session', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await client.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, input: [{ type: 'text', text: 'go' }] })
  await client.call('turn/steer', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'and tests' }],
  })
  await client.call('turn/interrupt', { runtime: FAKE_RUNTIME_ID, sessionId: session.id })

  await client.until(() =>
    client.events.some(
      (event) => event.type === 'turn/completed' && event.turn.status === 'interrupted',
    ),
  )
})

test('resuming a session carries its settings, not just its transcript', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const created = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await client.call('session/close', { runtime: FAKE_RUNTIME_ID, sessionId: created.id })

  // The transcript read has no settings; they come back with the resume. Losing
  // them left the composer with no model or permission controls to render.
  const resumed = (await client.call('session/resume', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: created.id,
  })) as Session

  assert.ok(resumed.settings, 'settings survived the resume')
  assert.equal(resumed.settings?.model, 'fake-1')
  assert.ok(resumed.options?.some((option) => option.id === 'tone'), 'options survived the resume')
})

test('an option change is checked against the declared choices before the runtime sees it', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const created = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session

  await client.call('session/options/set', { runtime: FAKE_RUNTIME_ID, sessionId: created.id, optionId: 'tone', value: 'cheerful' })
  await client.until(() =>
    client.events.some(
      (event) =>
        event.type === 'session/options' &&
        event.options.some((option) => option.id === 'tone' && option.currentValue === 'cheerful'),
    ),
  )
  // The host's fold agrees with the event, so a reconnecting client gets it from sync.
  const folded = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(created.id))?.session
  assert.equal(folded?.options?.find((option) => option.id === 'tone')?.currentValue, 'cheerful')

  await assert.rejects(
    () => client.call('session/options/set', { runtime: FAKE_RUNTIME_ID, sessionId: created.id, optionId: 'tone', value: 'shouty' }),
    /not one of the values/,
  )
  await assert.rejects(
    () => client.call('session/options/set', { runtime: FAKE_RUNTIME_ID, sessionId: created.id, optionId: 'nope', value: 'x' }),
    /no option/,
  )
  await assert.rejects(
    () => client.call('session/options/set', { runtime: FAKE_RUNTIME_ID, sessionId: created.id, optionId: 'uppercase', value: 'yes' }),
    /on or off/,
  )
})

test('runtime-wide options are listed and set through the host', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const options = (await client.call('runtime/options', { runtime: FAKE_RUNTIME_ID })) as { id: string }[]
  assert.equal(options[0]?.id, 'verboseLogs')
  await client.call('runtime/options/set', { runtime: FAKE_RUNTIME_ID, optionId: 'verboseLogs', value: true })
  assert.equal(harness.runtime.verboseLogs, true)
  await client.until(() => client.events.some((event) => event.type === 'runtime/options'))
  await assert.rejects(
    () => client.call('runtime/options/set', { runtime: FAKE_RUNTIME_ID, optionId: 'verboseLogs', value: 'on' }),
    /on or off/,
  )
})

test('the next session\'s options are served before any session exists', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const options = (await client.call('runtime/sessionDefaults', {
    runtime: FAKE_RUNTIME_ID,
  })) as { id: string; currentValue: unknown }[]
  assert.ok(options.some((option) => option.id === 'model'), 'the fake declares a model draft')

  // Picks ride along and the whole list is re-declared with them applied.
  const picked = (await client.call('runtime/sessionDefaults', {
    runtime: FAKE_RUNTIME_ID,
    values: { model: 'fake-2' },
  })) as { id: string; currentValue: unknown }[]
  assert.equal(picked.find((option) => option.id === 'model')?.currentValue, 'fake-2')

  // A pick the runtime refuses fails the call rather than half-applying.
  await assert.rejects(
    () => client.call('runtime/sessionDefaults', { runtime: FAKE_RUNTIME_ID, values: { model: 'bogus' } }),
    /not one of the values|no session option/,
  )
})

test('routes: credentials stay one-way, compatibility greys with a reason, and create resolves a gateway', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // A tiny upstream so the resolved gateway has somewhere real to point.
  const { createServer } = await import('node:http')
  const upstream = createServer((_incoming, outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'application/json' })
    outgoing.end('{}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())
  const address = upstream.address()
  const upstreamPort = typeof address === 'object' && address ? address.port : 0

  // The credential goes in; the listing shows a reference and never the value.
  const { ref } = (await client.call('credentials/store', {
    name: 'Test provider',
    value: 'the-secret-value',
  })) as { ref: string }
  const listed = (await client.call('credentials/list', {})) as unknown[]
  assert.ok(!JSON.stringify(listed).includes('the-secret-value'))

  // A route in a protocol the runtime does not speak: offered, greyed, with a sentence.
  const wrong = (await client.call('routes/save', {
    name: 'Wrong protocol',
    endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
    wireProtocol: 'responses',
    credentialRef: ref,
  })) as { id: string }
  const { id: rightId } = (await client.call('routes/save', {
    name: 'Right protocol',
    endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
    wireProtocol: 'fakewire',
    credentialRef: ref,
  })) as { id: string }
  const routes = (await client.call('routes/list', { runtime: FAKE_RUNTIME_ID })) as {
    id: string
    usable?: boolean
    reason?: string
  }[]
  const greyed = routes.find((route) => route.id === wrong.id)
  assert.equal(greyed?.usable, false)
  assert.match(greyed?.reason ?? '', /speaks fakewire/)
  assert.equal(routes.find((route) => route.id === rightId)?.usable, true)

  // Creating with the incompatible route fails in the same words.
  await assert.rejects(
    () =>
      client.call('session/create', {
        runtime: FAKE_RUNTIME_ID,
        options: { cwd: '/w', routeId: wrong.id },
      }),
    /speaks fakewire/,
  )

  // Creating with the compatible one hands the adapter a resolved gateway:
  // loopback, tokenised, and carrying neither the credential nor its ref.
  await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w', routeId: rightId },
  })
  const handed = harness.runtime.lastCreateOptions
  assert.ok(handed?.route, 'the adapter received a resolved route')
  assert.match(handed.route.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]+$/)
  assert.ok(!JSON.stringify(handed).includes('the-secret-value'))
  assert.ok(!JSON.stringify(handed).includes(ref))

  // A client trying to hand-roll a route is ignored; only routeId counts.
  await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w', route: { id: 'x', name: 'x', endpoint: 'http://evil', wireProtocol: 'fakewire', token: 't' } },
  })
  assert.equal(harness.runtime.lastCreateOptions?.route, undefined)
})

test('a policy rule answers an approval before any human sees it, and the audit log remembers', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // One rule: destructive-looking commands are denied, across every backend.
  await client.call('app/state/set', {
    patch: {
      permissionPolicy: [
        {
          id: 'r1',
          name: 'No rm -rf',
          match: { type: 'command', pattern: 'rm -rf' },
          action: 'deny',
        },
      ],
    },
  })

  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w' },
  })) as Session
  await client.call('turn/send', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    input: [{ type: 'text', text: 'hi' }],
  })

  const live = harness.runtime.sessions.get(session.id) as FakeSession
  const answered = live.askApproval(approvalId('ap-policy'))

  // The agent gets its answer without a click; the option chosen is the deny.
  assert.deepEqual(await answered, { type: 'option', optionId: 'opt-1' })
  // The user is told a rule acted; the approval itself never renders.
  await client.until(() =>
    client.events.some(
      (event) => event.type === 'notice' && /No rm -rf/.test((event as { message: string }).message),
    ),
  )
  assert.ok(
    !client.events.some((event) => event.type === 'approval/requested'),
    'a policy-decided approval must not reach the interface',
  )

  // The audit log holds the whole story, queryable by repository.
  const audit = (await client.call('audit/query', { root: '/w' })) as {
    kind: string
    rule?: string
  }[]
  assert.ok(audit.some((entry) => entry.kind === 'session/started'))
  assert.ok(audit.some((entry) => entry.kind === 'approval/autoDecided' && entry.rule === 'No rm -rf'))
  const elsewhere = (await client.call('audit/query', { root: '/somewhere-else' })) as unknown[]
  assert.equal(elsewhere.length, 0)
})

// --------------------------------------------------------------------- files

test('file reads go through the runtime\'s own view when it declares one', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: harness.stateDir })
  // Nothing under /w exists on disk; only the fake runtime can serve it.
  // The conversation has to be in the agent's own store before it can be
  // read out of it — the fake refuses an id it never issued, the way every
  // real agent does.
  harness.runtime.stored.set('s-w', [])
  harness.host.registry.upsert(
    { ...(await harness.runtime.readSession(sessionId('s-w'))), cwd: '/w' },
    null,
  )

  const read = (await client.call('workspace/readFile', { path: '/w/README.md', runtime: FAKE_RUNTIME_ID })) as {
    content: string
  }
  assert.equal(read.content, 'from the fake runtime')

  const found = (await client.call('workspace/files', {
    root: '/w',
    query: 'README',
    runtime: FAKE_RUNTIME_ID,
  })) as { path: string }[]
  assert.deepEqual(found.map((match) => match.path), ['/w/README.md'])

  const browsed = (await client.call('workspace/browse', { path: '/w', runtime: FAKE_RUNTIME_ID })) as {
    entries: { name: string }[]
  }
  assert.deepEqual(browsed.entries.map((entry) => entry.name), ['src'])
  assert.ok(harness.runtime.files.calls.some((call) => call.startsWith('read /w/README.md')))
})

test('without a runtime view the host\'s own reader serves the same calls', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: harness.stateDir })
  await writeFile(join(harness.stateDir, 'note.txt'), 'on disk')

  const read = (await client.call('workspace/readFile', { path: join(harness.stateDir, 'note.txt') })) as {
    content: string
  }
  assert.equal(read.content, 'on disk')
  assert.equal(harness.runtime.files.calls.length, 0, 'the runtime was never asked')
})

test('a read outside every open workspace is refused by the host, whichever reader would serve it', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: harness.stateDir })

  // The fake runtime would happily serve this — Codex's fs/* does too — and
  // the host must not ask it.
  await assert.rejects(
    () => client.call('workspace/readFile', { path: '/elsewhere/secret.txt', runtime: FAKE_RUNTIME_ID }),
    /outside every open workspace/,
  )
  await assert.rejects(
    () => client.call('workspace/readFile', { path: '/etc/hosts' }),
    /outside every open workspace/,
  )
  // Traversal out of an open root is collapsed before the check.
  await assert.rejects(
    () => client.call('workspace/readFile', { path: join(harness.stateDir, '..', '..', 'etc', 'hosts') }),
    /outside every open workspace/,
  )
  await assert.rejects(
    () => client.call('workspace/files', { root: '/elsewhere', query: 'secret', runtime: FAKE_RUNTIME_ID }),
    /outside every open workspace/,
  )
  assert.equal(harness.runtime.files.calls.length, 0, 'no reader was consulted')
  await assert.rejects(
    () => client.call('workspace/readFile', { path: 'relative/path.txt' }),
    /not an absolute path/,
  )
})

// ----------------------------------------------------------------- terminals

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString()

test('a terminal survives a resize and a client reload, with its output intact', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  await (await Client.connect(harness.server)).call('workspace/open', { path: harness.stateDir })

  const first = await Client.connect(harness.server)
  const { terminalId } = (await first.call('terminal/open', {
    runtime: FAKE_RUNTIME_ID,
    cwd: harness.stateDir,
    size: { rows: 24, cols: 80 },
  })) as { terminalId: string }
  await first.call('terminal/write', { terminalId, data: Buffer.from('ls\n').toString('base64') })
  await first.call('terminal/resize', { terminalId, size: { rows: 40, cols: 120 } })
  await first.until(() =>
    first.notifications.some(
      (m) => 'method' in m && m.method === 'terminal/output' && decode(m.params.data).includes('[40x120]'),
    ),
  )
  // The window reloads. The shell must not die with it.
  first.close()
  await new Promise((resolve) => setTimeout(resolve, 50))

  const second = await Client.connect(harness.server)
  t.after(() => second.close())
  const attached = (await second.call('terminal/attach', { terminalId })) as {
    scrollback: string
    exitCode: number | null
    size: { rows: number; cols: number }
  }
  const scrollback = decode(attached.scrollback)
  assert.match(scrollback, /echo:ls/, 'what was typed before the reload is still on screen')
  assert.match(scrollback, /\[40x120\]/, 'and the size it was resized to')
  assert.deepEqual(attached.size, { rows: 40, cols: 120 })
  assert.equal(attached.exitCode, null, 'still running')

  await second.call('terminal/write', { terminalId, data: Buffer.from('pwd\n').toString('base64') })
  await second.until(() =>
    second.notifications.some(
      (m) => 'method' in m && m.method === 'terminal/output' && decode(m.params.data).includes('echo:pwd'),
    ),
  )

  await second.call('terminal/close', { terminalId })
  assert.equal(harness.runtime.spawned[0]?.exited, 130, 'closing kills the process')
  await assert.rejects(() => second.call('terminal/attach', { terminalId }), /ended when HarnessDesk restarted, or was closed/)
})

test('a terminal opened for a conversation runs under that conversation', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: harness.stateDir })
  const session = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: harness.stateDir } })) as Session
  await client.call('terminal/open', {
    runtime: FAKE_RUNTIME_ID,
    cwd: harness.stateDir,
    size: { rows: 24, cols: 80 },
    sessionId: session.id,
    command: ['npm', 'test'],
  })
  assert.equal(harness.runtime.spawned[0]?.sessionUsed, session.id)
  await assert.rejects(
    () => client.call('terminal/open', { runtime: FAKE_RUNTIME_ID, cwd: '/elsewhere', size: { rows: 1, cols: 1 } }),
    /outside every open workspace/,
  )
})

test('a runtime going down ends its terminals visibly rather than leaving them hanging', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: harness.stateDir })
  const { terminalId } = (await client.call('terminal/open', {
    runtime: FAKE_RUNTIME_ID,
    cwd: harness.stateDir,
    size: { rows: 24, cols: 80 },
  })) as { terminalId: string }
  harness.runtime.setHealth({ state: 'unavailable', reason: 'crashed', message: 'gone' })
  await client.until(() =>
    client.notifications.some(
      (m) => 'method' in m && m.method === 'terminal/exited' && m.params.terminalId === terminalId,
    ),
  )
})

// --------------------------------------------------------------------- saving

test('a save that races an external change is refused with the other content, never overwritten', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: harness.stateDir })
  const path = join(harness.stateDir, 'notes.md')
  await writeFile(path, 'first draft\n')

  const loaded = (await client.call('workspace/readFile', { path })) as { content: string; hash: string }
  assert.equal(loaded.content, 'first draft\n')

  // Someone — an agent in another pane, say — writes the file meanwhile.
  await writeFile(path, 'agent rewrote this\n')

  const refused = (await client.call('file/save', {
    path,
    content: 'my edit\n',
    expectedHash: loaded.hash,
  })) as { saved: false; conflict: { content: string; hash: string } }
  assert.equal(refused.saved, false)
  assert.equal(refused.conflict.content, 'agent rewrote this\n')
  assert.equal(await readFile(path, 'utf8'), 'agent rewrote this\n', 'the other change survived')

  // Saving against the current hash goes through.
  const saved = (await client.call('file/save', {
    path,
    content: 'merged\n',
    expectedHash: refused.conflict.hash,
  })) as { saved: true; hash: string }
  assert.equal(saved.saved, true)
  assert.equal(await readFile(path, 'utf8'), 'merged\n')

  await assert.rejects(
    () => client.call('file/save', { path: '/etc/hosts', content: 'x', expectedHash: '' }),
    /outside every open workspace/,
  )
})

test('an agent switched off is not asked about its usage, and comes back when it is switched on', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // A meter that counts how often it was consulted: "switched off" has to mean
  // the question is never asked, not that the answer is hidden afterwards.
  let reads = 0
  harness.host.bindUsage(FAKE_RUNTIME_ID, {
    meter: {
      id: 'test-meter',
      source: { kind: 'file', label: 'from a test' },
      watchPaths: () => [],
      read: async () => {
        reads += 1
        return {
          account: 'someone@example.com',
          plan: 'Test',
          lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 40, windowMinutes: 10_080, resetsAt: null }],
          credits: null,
          reached: null,
          fetchedAt: Date.now(),
          staleAfterMs: 0,
        }
      },
    },
  })

  const tracked = (await client.call('usage/reports', {})) as { runtime: string }[]
  assert.deepEqual(
    tracked.map((report) => report.runtime),
    [FAKE_RUNTIME_ID],
  )
  assert.equal(reads, 1)
  assert.notEqual(await client.call('runtime/limits', { runtime: FAKE_RUNTIME_ID }), null)

  await client.call('app/state/set', { patch: { usageOff: [FAKE_RUNTIME_ID] } })
  const quiet = reads

  assert.deepEqual(await client.call('usage/reports', {}), [], 'no card, because no question was asked')
  assert.deepEqual(await client.call('usage/refresh', {}), [], 'and refreshing everything skips it too')
  assert.equal(
    await client.call('runtime/limits', { runtime: FAKE_RUNTIME_ID }),
    null,
    'the composer ring and the footer go quiet with it',
  )
  assert.equal(reads, quiet, 'the meter was never consulted while it was off')

  await client.call('app/state/set', { patch: { usageOff: [] } })
  const back = (await client.call('usage/reports', {})) as { runtime: string }[]
  assert.deepEqual(
    back.map((report) => report.runtime),
    [FAKE_RUNTIME_ID],
    'switching it on again needs no restart',
  )
})

// ------------------------------------------------------------- git RPC roots

const gitIn = async (cwd: string, ...args: string[]): Promise<string> =>
  (
    await promisify(execFile)('git', ['-C', cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@x',
      },
    })
  ).stdout

test('git RPCs refuse a root nobody opened', async (t) => {
  // The socket is authenticated, not trusted: a page in the browser pane
  // that got hold of it must not be able to read — or branch — an arbitrary
  // repository by absolute path.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const outside = await mkdtemp(join(tmpdir(), 'hd-git-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await gitIn(outside, 'init', '-q', '-b', 'main')

  const refused = /outside every open workspace/
  await assert.rejects(() => client.call('git/log', { root: outside }), refused)
  await assert.rejects(() => client.call('git/refs', { root: outside }), refused)
  await assert.rejects(() => client.call('git/status', { root: outside }), refused)
  await assert.rejects(
    () => client.call('git/createBranch', { root: outside, name: 'x', at: 'deadbeef' }),
    refused,
  )

  // Opened, the same folder answers like any workspace.
  await client.call('workspace/open', { path: outside })
  const summary = (await client.call('git/refs', { root: outside })) as { branch: string | null }
  assert.equal(summary.branch, 'main')
})

test('the repository top level above an open subfolder is reachable', async (t) => {
  // The history pane keys itself by git/status's answer, and a workspace is
  // often a folder inside its repository — that one derived root is allowed,
  // verified against git rather than taken from the wire.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const repo = await mkdtemp(join(tmpdir(), 'hd-git-top-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await gitIn(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await gitIn(repo, 'add', '.')
  await gitIn(repo, 'commit', '-qm', 'root commit')
  await mkdir(join(repo, 'pkg'))
  await writeFile(join(repo, 'pkg', 'b.txt'), 'two\n')

  await client.call('workspace/open', { path: join(repo, 'pkg') })
  const status = (await client.call('git/status', { root: join(repo, 'pkg') })) as { root: string }
  const page = (await client.call('git/log', { root: status.root })) as {
    commits: readonly { subject: string }[]
  }
  assert.deepEqual(
    page.commits.map((entry) => entry.subject),
    ['root commit'],
  )
})

test('create-and-switch refuses whole on a dirty tree', async (t) => {
  // The switch's own preflight runs before the branch is made: refusing
  // *after* would leave the branch behind, and the retry failing on
  // "already exists" for a branch nobody asked to keep.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const repo = await mkdtemp(join(tmpdir(), 'hd-git-dirty-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await gitIn(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await gitIn(repo, 'add', '.')
  await gitIn(repo, 'commit', '-qm', 'root commit')
  const at = (await gitIn(repo, 'rev-parse', 'HEAD')).trim()
  await writeFile(join(repo, 'a.txt'), 'one\ndirty\n')

  await client.call('workspace/open', { path: repo })
  await assert.rejects(
    () => client.call('git/createBranch', { root: repo, name: 'clean-jump', at, checkout: true }),
    /uncommitted/,
  )
  const branches = await gitIn(repo, 'branch', '--list', 'clean-jump')
  assert.equal(branches.trim(), '', 'the refusal left no half-made branch behind')

  // Without the switch, a dirty tree is no reason not to mark a commit.
  await client.call('git/createBranch', { root: repo, name: 'marked', at })
  assert.equal((await gitIn(repo, 'rev-parse', 'marked')).trim(), at)
})


test('a profile written through app/state/set replaces the stored one whole, and {} clears it', async (t) => {
  // The UI writes the whole profile, and Reset writes {}, because this method
  // hands the patch to the store unmerged. A merge here would keep a face the
  // user reset, and nothing on the UI side would notice.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const stored = async (): Promise<unknown> =>
    ((await client.call('app/state/get', {})) as Record<string, unknown>)['profile']

  await client.call('app/state/set', { patch: { profile: { name: 'Jane', avatar: 'dj', account: { id: 'a1' } } } })
  await client.call('app/state/set', { patch: { profile: { name: 'JD' } } })
  assert.deepEqual(await stored(), { name: 'JD' })
  await client.call('app/state/set', { patch: { profile: {} } })
  assert.deepEqual(await stored(), {})
})
