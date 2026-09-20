import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
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
  type FlowRun,
  type GoalView,
  type HostMethodName,
  type HostParams,
  type HostToClient,
  type Session,
  type SessionSummary,
  type TeamState,
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
    goalMigrationPending: boolean
  }
  assert.equal(hello.protocolVersion, 1)
  assert.equal(hello.hostVersion, '9.9.9')
  assert.deepEqual(hello.runtimes.map((r) => r.id), [FAKE_RUNTIME_ID])
  // The renderer has no home of its own; without this it cannot write `~` and
  // prints the machine's username into every screenshot of a path.
  assert.equal(hello.home, homedir())
  assert.equal(hello.goalMigrationPending, false)
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

test('a review on a side thread answers with its conversation, which the host already holds', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const session = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  const review = (delivery?: 'detached') =>
    client.call('session/review', {
      runtime: FAKE_RUNTIME_ID,
      sessionId: session.id,
      target: { type: 'uncommitted', ...(delivery ? { delivery } : {}) },
    }) as Promise<Session | null>

  assert.equal(await review(), null, 'a review that runs here answers with no other conversation')
  const side = await review('detached')
  assert.ok(side && side.id !== session.id, 'a review on a side thread answers with the conversation it runs in')
  assert.equal(side.cwd, '/w')

  // Held from the first word: the window that opens it sends straight to it.
  const resumes = harness.runtime.resumes
  await client.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: side.id, input: [{ type: 'text', text: 'and?' }] })
  assert.equal(harness.runtime.resumes, resumes, 'nothing was reopened to send to it')
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
  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w', routeId: rightId },
  })) as Session
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

  // Forking with the compatible routeId resolves the gateway route as well.
  await client.call('session/fork', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    options: { routeId: rightId },
  })
  const forkedHanded = harness.runtime.lastCreateOptions
  assert.ok(forkedHanded?.route, 'the adapter received a resolved route on fork')
  assert.match(forkedHanded.route.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]+$/)
  assert.ok(!JSON.stringify(forkedHanded).includes('the-secret-value'))
  assert.ok(!JSON.stringify(forkedHanded).includes(ref))

  // Forking with a hand-rolled route is ignored.
  await client.call('session/fork', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    options: { route: { id: 'x', name: 'x', endpoint: 'http://evil', wireProtocol: 'fakewire', token: 't' } },
  })
  assert.equal(harness.runtime.lastCreateOptions?.route, undefined)

  // Resuming with the compatible routeId resolves the gateway route as well (#425).
  await client.call('session/close', { runtime: FAKE_RUNTIME_ID, sessionId: session.id })
  await client.call('session/resume', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    options: { routeId: rightId },
  })
  const resumedHanded = harness.runtime.lastResumeOptions
  assert.ok(resumedHanded?.route, 'the adapter received a resolved route on resume')
  assert.match(resumedHanded.route.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]+$/)
  assert.ok(!JSON.stringify(resumedHanded).includes('the-secret-value'))
  assert.ok(!JSON.stringify(resumedHanded).includes(ref))

  // Resuming with a hand-rolled route is ignored and stripped (#425).
  await client.call('session/close', { runtime: FAKE_RUNTIME_ID, sessionId: session.id })
  await client.call('session/resume', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    options: { route: { id: 'x', name: 'x', endpoint: 'http://evil', wireProtocol: 'fakewire', token: 't' } },
  })
  assert.equal(harness.runtime.lastResumeOptions?.route, undefined)
})

test('app/state/set with null modelRoutes does not poison routes/list or routes/save (#426)', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // Poison modelRoutes with nulls and malformed entries via app/state/set
  await client.call('app/state/set', {
    patch: {
      modelRoutes: [null, { bad: 'entry' }, null],
    },
  })

  // routes/list with runtime should not crash on null entries
  const routes = (await client.call('routes/list', { runtime: FAKE_RUNTIME_ID })) as unknown[]
  assert.deepEqual(routes, [])

  // routes/save should not crash on null entries
  const saved = (await client.call('routes/save', {
    name: 'Recovered Route',
    endpoint: 'http://127.0.0.1:8080/v1',
    wireProtocol: 'fakewire',
    credentialRef: 'cred-1',
  })) as { id: string }
  assert.ok(saved.id)

  // routes/delete should also not crash on null entries
  await client.call('routes/delete', { id: saved.id })
  const empty = (await client.call('routes/list', { runtime: FAKE_RUNTIME_ID })) as unknown[]
  assert.deepEqual(empty, [])
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

test('policy auto-decision failure falls back to surfacing approval to client without unhandled rejection (#421)', async (t) => {
  let unhandled: unknown = null
  const onUnhandled = (err: unknown) => {
    unhandled = err
  }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

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

  const live = harness.runtime.sessions.get(session.id) as FakeSession

  // Simulate runtime/transport failure on policy response (both sync throw and async rejection)
  live.respondToApproval = () => {
    throw new Error('simulated policy response failure')
  }

  live.askApproval(approvalId('ap-failed-policy'))

  // The approval must be surfaced to the client as an approval/requested event
  await client.until(
    () =>
      client.events.some(
        (event) =>
          event.type === 'approval/requested' &&
          (event as { approval?: { id: string } }).approval?.id === 'ap-failed-policy',
      ),
    2000,
  )

  const record = harness.host.registry.get(FAKE_RUNTIME_ID, session.id)
  assert.ok(record?.approvals.has('ap-failed-policy'))
  assert.equal(unhandled, null, 'no unhandled rejection should occur')
})

test('permissionPolicy with null or malformed entries does not crash approval handling (#427)', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // Store malformed permissionPolicy array containing nulls and invalid entries
  await client.call('app/state/set', {
    patch: {
      permissionPolicy: [
        null,
        undefined,
        'not-a-rule',
        { id: 'bad-1' },
        { id: 'bad-2', match: null },
        null,
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
  // Trigger an approval request from the agent; #applyPolicy must not throw on null rules
  live.askApproval(approvalId('ap-null-policy'))

  await client.until(
    () =>
      client.events.some(
        (event) =>
          event.type === 'approval/requested' &&
          (event as { approval?: { id: string } }).approval?.id === 'ap-null-policy',
      ),
    2000,
  )

  const record = harness.host.registry.get(FAKE_RUNTIME_ID, session.id)
  assert.ok(record?.approvals.has('ap-null-policy'))
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

/**
 * What each git verb is asked beside its root, in the test below.
 *
 * Keyed by every `git/*` verb on the wire, so a verb added without a line here
 * fails the build rather than going untested. Against a host that admits the
 * root, git is asked, so every ask that would change something is one git
 * turns down — a commit id naming nothing, a branch that is not there — and
 * the scratch repository ends as it began.
 */
const RELATIVE_ROOT_ASKS: {
  readonly [M in Extract<HostMethodName, `git/${string}`>]: Omit<HostParams<M>, 'root'>
} = {
  'git/status': {},
  'git/branches': {},
  'git/checkout': { branch: 'not-a-branch' },
  'git/diff': {},
  'git/log': {},
  'git/refs': {},
  'git/commit': { sha: 'deadbeef' },
  'git/commitDiff': { sha: 'deadbeef', path: 'a.txt' },
  'git/createBranch': { name: 'made-relative', at: 'deadbeef' },
  'git/commitAll': { message: 'made relative' },
  'git/pull': {},
  'git/push': {},
  'git/fetch': {},
  'git/merge': { ref: 'not-a-branch' },
  'git/rebase': { onto: 'not-a-branch' },
  'git/checkoutCommit': { sha: 'deadbeef' },
  'git/renameBranch': { from: 'not-a-branch', to: 'renamed' },
  'git/deleteBranch': { name: 'not-a-branch' },
  'git/createTag': { name: 'made-relative', at: 'deadbeef' },
  'git/deleteTag': { name: 'not-a-tag' },
  'git/reset': { to: 'deadbeef', mode: 'soft' },
  'git/revert': { sha: 'deadbeef' },
  'git/cherryPick': { sha: 'deadbeef' },
  'git/stashSave': {},
  'git/stashApply': { ref: 'stash@{0}' },
  'git/stashDrop': { ref: 'stash@{0}' },
  'git/patch': { sha: 'deadbeef' },
  'git/diffRange': { from: 'HEAD', to: 'HEAD' },
  'git/pullRequestUrl': { branch: 'main' },
  'git/worktrees': {},
  'git/worktreeAdd': { path: 'made-relative', checkout: { kind: 'detach', at: 'deadbeef' } },
  'git/worktreeInventory': { path: 'not-a-worktree' },
  'git/worktreeRemove': { path: 'not-a-worktree' },
  'git/worktreePrune': {},
  'git/worktreeLock': { path: 'not-a-worktree', locked: true },
  'git/worktreeMove': { from: 'not-a-worktree', to: 'elsewhere' },
}

test('git RPCs refuse a relative root, even one that leads into an open repository', async (t) => {
  // A relative path names no folder until something resolves it, and what
  // resolved it here was the host's working directory — wherever the app
  // happened to be started. So the root below is the one relative spelling
  // that resolution would admit: from this process's working directory, which
  // is the host's, into a repository opened here. Anything but the refusal —
  // an answer, a git error — is that spelling admitted.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // The repository one folder down, so a worktree made beside it lands in
  // what this test removes.
  const scratch = await mkdtemp(join(tmpdir(), 'hd-git-relative-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repo = join(scratch, 'repo')
  await mkdir(repo)
  await gitIn(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await gitIn(repo, 'add', '.')
  await gitIn(repo, 'commit', '-qm', 'root commit')
  await client.call('workspace/open', { path: repo })

  const spelled = relative(process.cwd(), repo)
  // The controls: the spelling is relative, it leads from the host's working
  // directory into the open repository, and that repository spelled absolutely
  // is answered — so a refusal below can only be about the spelling.
  assert.equal(isAbsolute(spelled), false)
  assert.equal(await realpath(spelled), await realpath(repo))
  assert.equal(((await client.call('git/status', { root: repo })) as { branch?: string | null }).branch, 'main')

  for (const [verb, asks] of Object.entries(RELATIVE_ROOT_ASKS)) {
    await t.test(verb, async () => {
      await assert.rejects(() => client.call(verb as HostMethodName, { ...asks, root: spelled }), {
        message: `${spelled} is not an absolute path.`,
      })
    })
  }
})

/**
 * What each worktree verb is handed in the test below, spelled relative: the
 * open repository for the two that take a folder of it, and a worktree
 * HarnessDesk made of it for the three that take a worktree.
 *
 * Keyed by every `worktree/*` verb on the wire, so a verb added without a line
 * here fails the build rather than going untested. Against a host that admits
 * the path, every ask that would change something is turned down after the
 * fact — a base that names no commit, a worktree holding a file nobody
 * committed — so the repository and its worktree end as they began.
 */
const RELATIVE_WORKTREE_ASKS: {
  readonly [M in Extract<HostMethodName, `worktree/${string}`>]: {
    readonly names: 'repository' | 'worktree'
    readonly ask: (spelled: string) => HostParams<M>
  }
} = {
  'worktree/list': { names: 'repository', ask: (root) => ({ root }) },
  'worktree/create': { names: 'repository', ask: (root) => ({ root, name: 'made-relative', base: 'not-a-commit' }) },
  'worktree/changes': { names: 'worktree', ask: (path) => ({ path }) },
  'worktree/remove': { names: 'worktree', ask: (path) => ({ path }) },
  'worktree/bringHome': { names: 'worktree', ask: (path) => ({ path }) },
}

test('worktree RPCs refuse a relative path, even one that leads into an open repository', async (t) => {
  // `git -C` reads a relative path against the host's working directory, as
  // `resolve` and `realpath` do, and the worktree verbs handed theirs to git
  // before anything confined it. So each path below is the relative spelling
  // that would be let in: from this process's working directory, which is the
  // host's, to a repository opened here or to a worktree HarnessDesk made of
  // it. Anything but the refusal — an answer, or a refusal made after the path
  // was let in — is that spelling admitted.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const repo = await mkdtemp(join(tmpdir(), 'hd-worktree-relative-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await gitIn(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await gitIn(repo, 'add', '.')
  await gitIn(repo, 'commit', '-qm', 'root commit')
  await client.call('workspace/open', { path: repo })
  const side = ((await client.call('worktree/create', { root: repo, name: 'side' })) as { path: string }).path
  // A file nobody committed, so that removing the worktree or bringing it home
  // is refused for the dirty tree once the path is let in, and nothing moves.
  await writeFile(join(side, 'draft.txt'), 'not yet\n')

  const spelled = { repository: relative(process.cwd(), repo), worktree: relative(process.cwd(), side) }
  // The controls: both spellings are relative, each leads from the host's
  // working directory where it should, and spelled absolutely the repository
  // and the worktree are both answered — so a refusal below can only be about
  // the spelling.
  assert.equal(isAbsolute(spelled.repository), false)
  assert.equal(isAbsolute(spelled.worktree), false)
  assert.equal(await realpath(spelled.repository), await realpath(repo))
  assert.equal(await realpath(spelled.worktree), await realpath(side))
  assert.equal(((await client.call('worktree/list', { root: repo })) as readonly unknown[]).length, 2)
  assert.equal(((await client.call('worktree/changes', { path: side })) as { untracked: number }).untracked, 1)

  for (const [verb, { names, ask }] of Object.entries(RELATIVE_WORKTREE_ASKS)) {
    await t.test(verb, async () => {
      await assert.rejects(() => client.call(verb as HostMethodName, ask(spelled[names])), {
        message: `${spelled[names]} is not an absolute path.`,
      })
    })
  }
})

/** The keys a params type names, and none for an open record such as `Record<string, never>`. */
type NamedKeys<P> = string extends keyof P ? never : keyof P

/** What a params type's `options` hold, when it has them. */
type OptionsOf<P> = P extends { readonly options?: infer O } ? NonNullable<O> : never

/** Every method whose `options` name the folder a conversation works in. */
type ConversationFolderMethod = {
  [M in HostMethodName]: 'options' extends NamedKeys<HostParams<M>>
    ? 'cwd' extends NamedKeys<OptionsOf<HostParams<M>>>
      ? M
      : never
    : never
}[HostMethodName]

/**
 * What each verb that names a conversation's folder is asked in the test
 * below: to start one there, or to reopen or fork `held` into it.
 *
 * Keyed by every method whose `options` carry a cwd, so a verb added with one
 * and without a line here fails the build rather than going untested.
 */
const RELATIVE_CONVERSATION_ASKS: {
  readonly [M in ConversationFolderMethod]: (held: Session['id'], cwd: string) => HostParams<M>
} = {
  'session/create': (_held, cwd) => ({ runtime: FAKE_RUNTIME_ID, options: { cwd } }),
  'session/resume': (held, cwd) => ({ runtime: FAKE_RUNTIME_ID, sessionId: held, options: { cwd } }),
  'session/fork': (held, cwd) => ({ runtime: FAKE_RUNTIME_ID, sessionId: held, options: { cwd } }),
}

test('a conversation is not started, reopened or forked in a relative folder, even one that leads into a repository', async (t) => {
  // `session/create` handed its cwd to the runtime as it was spelled, and the
  // adapters pass it on as given. A conversation's cwd is then an open root,
  // which every confinement check trusts and reads against the host's working
  // directory: a repository nobody opened answered `git/status` and
  // `worktree/list` once a conversation had been started in its relative
  // spelling. The folder below is that spelling, from this process's working
  // directory, which is the host's, into a repository nobody opened. The empty
  // string is refused beside it: Codex reads it as its own working directory,
  // which is the host's, and that is `/` when the app is started from Finder.
  // Anything but the refusal is the spelling handed on.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const repo = await mkdtemp(join(tmpdir(), 'hd-session-relative-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await gitIn(repo, 'init', '-q', '-b', 'main')
  await gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'root commit')
  // A conversation to reopen and to fork, working in a folder of its own.
  const held = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: harness.stateDir },
  })) as Session
  const resumes = harness.runtime.resumes

  const spelled = relative(process.cwd(), repo)
  // The controls: the spelling is relative, it leads from the host's working
  // directory into the repository, and nothing has opened that repository.
  assert.equal(isAbsolute(spelled), false)
  assert.equal(await realpath(spelled), await realpath(repo))
  await assert.rejects(() => client.call('git/status', { root: repo }), /outside every open workspace/)

  for (const [verb, ask] of Object.entries(RELATIVE_CONVERSATION_ASKS)) {
    await t.test(verb, async () => {
      for (const cwd of [spelled, '']) {
        await assert.rejects(() => client.call(verb as HostMethodName, ask(held.id, cwd)), {
          message: `${cwd} is not an absolute path.`,
        })
      }
    })
  }

  // The runtime was handed none of them, and nothing was opened: the
  // repository is still refused. Spelled absolutely, the same folder starts a
  // conversation and is open from then on, so what was refused was the
  // spelling.
  assert.equal(harness.runtime.lastCreateOptions?.cwd, harness.stateDir)
  assert.equal(harness.runtime.resumes, resumes)
  await assert.rejects(() => client.call('git/status', { root: repo }), /outside every open workspace/)
  const started = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: repo },
  })) as Session
  assert.equal(started.cwd, repo)
  assert.equal(((await client.call('git/status', { root: repo })) as { branch?: string | null }).branch, 'main')
})

test('a folder is an open root only when it is absolute, whoever reports it', async (t) => {
  // The wire refuses a relative folder before it can become an open root, but
  // not every root arrives as a request. A conversation's cwd is whatever its
  // agent reports, and one read or reopened from the agent's store carries the
  // folder the agent wrote down; the workspaces come back from the state file.
  // Every check that holds a path to the open roots reads a relative one
  // against the host's working directory, so each spelling below is the one
  // that would open the repository: from this process's working directory,
  // which is the host's, into a repository nobody opened.
  const repo = await mkdtemp(join(tmpdir(), 'hd-root-relative-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await gitIn(repo, 'init', '-q', '-b', 'main')
  await gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'root commit')
  const spelled = relative(process.cwd(), repo)
  // The controls: the spelling is relative, and it leads from the host's
  // working directory into the repository.
  assert.equal(isAbsolute(spelled), false)
  assert.equal(await realpath(spelled), await realpath(repo))
  const branchOf = async (client: Client): Promise<string | null | undefined> =>
    ((await client.call('git/status', { root: repo })) as { branch?: string | null }).branch

  await t.test('a conversation its agent keeps in a relative folder', async (t) => {
    const harness = await start()
    t.after(() => stop(harness))
    const client = await Client.connect(harness.server)
    t.after(() => client.close())
    const kept = (id: string, cwd: string): SessionSummary => ({
      id: sessionId(id),
      runtime: FAKE_RUNTIME_ID,
      title: id,
      preview: null,
      cwd,
      status: { type: 'idle' },
      createdAt: 1,
      updatedAt: 2,
    })
    harness.runtime.history.push(kept('kept-relative', spelled), kept('kept-absolute', repo))

    // Read, it is held with the folder its agent reported, and that opens nothing.
    const read = (await client.call('session/read', { runtime: FAKE_RUNTIME_ID, sessionId: 'kept-relative' })) as Session
    assert.equal(read.cwd, spelled)
    await assert.rejects(() => branchOf(client), /outside every open workspace/)
    // Reported absolutely, the same folder is open.
    await client.call('session/read', { runtime: FAKE_RUNTIME_ID, sessionId: 'kept-absolute' })
    assert.equal(await branchOf(client), 'main')
  })

  await t.test('a workspace the state file remembers by a relative path', async (t) => {
    const at = await mkdtemp(join(tmpdir(), 'harnessdesk-test-'))
    await writeFile(join(at, 'state.json'), JSON.stringify({ workspaces: [{ path: spelled }] }))
    const harness = await start({}, at)
    t.after(() => stop(harness))
    const client = await Client.connect(harness.server)
    t.after(() => client.close())

    await assert.rejects(() => branchOf(client), /outside every open workspace/)
    // Opened absolutely, the same folder is open.
    await client.call('workspace/open', { path: repo })
    assert.equal(await branchOf(client), 'main')
  })
})

/** Every method that names the folder it is about as its `cwd`. */
type FolderMethod = {
  [M in HostMethodName]: 'cwd' extends NamedKeys<HostParams<M>> ? M : never
}[HostMethodName]

/**
 * What each method that takes a cwd is asked in the test below, beside that
 * folder.
 *
 * Keyed by every method whose params carry one, so a method added with a cwd
 * and without a line here fails the build rather than going untested.
 */
const RELATIVE_FOLDER_ASKS: { readonly [M in FolderMethod]: (cwd: string) => HostParams<M> } = {
  'goal/create': (cwd) => ({ root: cwd, sentence: 'Finish the probe' }),
  'session/list': (cwd) => ({ runtime: FAKE_RUNTIME_ID, cwd }),
  'runtime/sessionDefaults': (cwd) => ({ runtime: FAKE_RUNTIME_ID, cwd }),
  'runtime/skills': (cwd) => ({ runtime: FAKE_RUNTIME_ID, cwd }),
  'runtime/hooks': (cwd) => ({ runtime: FAKE_RUNTIME_ID, cwd }),
  'runtime/catalog': (cwd) => ({ runtime: FAKE_RUNTIME_ID, cwd }),
  'runtime/mcp/list': (cwd) => ({ runtime: FAKE_RUNTIME_ID, cwd }),
  'runtime/imports/detect': (cwd) => ({ runtime: FAKE_RUNTIME_ID, cwd }),
  'library/read': (cwd) => ({ cwd }),
  'library/definition': (cwd) => ({ kind: 'skill', name: 'hd-probe', path: '/nowhere/hd-probe', cwd }),
  'library/plan': (cwd) => ({ cwd, intents: [] }),
  'library/apply': (cwd) => ({ cwd, ops: [] }),
  'terminal/open': (cwd) => ({ runtime: FAKE_RUNTIME_ID, cwd, size: { rows: 24, cols: 80 } }),
  'agent/seat': (cwd) => ({ id: 'hd-probe', cwd }),
}

/**
 * The empty folder, where a method's wire shape asks for a filled one: refused
 * before its handler runs, in the shape's own words, and handed to nothing.
 */
const EMPTY_CWD_SHAPE_REFUSALS: { readonly [M in FolderMethod]?: string } = {
  'goal/create': 'message.params.root: expected a non-empty string',
  'agent/seat': 'message.params.cwd: expected a non-empty string',
}

test('a cwd is refused when it is relative, whichever method it is handed to', async (t) => {
  // Each of these hands its cwd to something that reads a relative one
  // against the host's working directory. The library resolves it there
  // itself, for the scans and for the roots its writes are held to. Codex is
  // spawned with the host's working directory, and its skills, hooks, config
  // layers and import detection answered for a relative folder from there. An
  // ACP agent opens its draft probe in it. The rest filter by it or pass it
  // on, and what an agent makes of a relative one is the agent's business, so
  // none of them is handed one. The spelling below is the one that would reach
  // a folder nobody opened, from this process's working directory, which is
  // the host's; the empty string is refused beside it.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // What the runtime's own surfaces were handed, so a refusal is told apart
  // from a runtime that took the folder and ignored it.
  const handed: string[] = []
  const heard = <T>(cwd: string | undefined, answer: T): T => {
    if (cwd !== undefined) handed.push(cwd)
    return answer
  }
  const runtime = harness.runtime
  const defaults = runtime.defaultSessionOptions.bind(runtime)
  runtime.defaultSessionOptions = (cwd, values) => heard(cwd, defaults(cwd, values))
  const listSessions = runtime.listSessions.bind(runtime)
  runtime.listSessions = (query) => heard(query?.cwd, listSessions(query))
  Object.assign(runtime, {
    listSkills: async (cwd?: string) => heard(cwd, []),
    listHooks: async (cwd?: string) => heard(cwd, []),
    extensions: {
      catalog: async (cwd?: string) => heard(cwd, { plugins: [], marketplaces: [], loadErrors: [], featured: [] }),
      mcpServers: async (cwd?: string) => heard(cwd, []),
      detectImports: async (cwd?: string) => heard(cwd, []),
    },
  })

  // A folder nobody opened, with a skill of its own for the library to find.
  const folder = await mkdtemp(join(tmpdir(), 'hd-cwd-relative-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  await mkdir(join(folder, '.agents', 'skills', 'hd-probe'), { recursive: true })
  await writeFile(
    join(folder, '.agents', 'skills', 'hd-probe', 'SKILL.md'),
    '---\nname: hd-probe\ndescription: A skill only this folder has.\n---\n',
  )

  const spelled = relative(process.cwd(), folder)
  // The controls: the spelling is relative, and it leads from the host's
  // working directory to the folder.
  assert.equal(isAbsolute(spelled), false)
  assert.equal(await realpath(spelled), await realpath(folder))

  for (const [method, ask] of Object.entries(RELATIVE_FOLDER_ASKS)) {
    await t.test(method, async () => {
      for (const cwd of [spelled, '']) {
        await assert.rejects(() => client.call(method as HostMethodName, ask(cwd)), {
          message:
            (cwd === '' ? EMPTY_CWD_SHAPE_REFUSALS[method as FolderMethod] : undefined) ??
            `${cwd} is not an absolute path.`,
        })
      }
    })
  }

  // No surface was handed either spelling, and agent/seat opened no
  // conversation. Spelled absolutely, the same folder is handed on, and the
  // library finds its skill there, so what was refused was the spelling.
  assert.deepEqual(handed, [])
  assert.equal(harness.runtime.lastCreateOptions, null)
  await client.call('runtime/skills', { runtime: FAKE_RUNTIME_ID, cwd: folder })
  assert.deepEqual(handed, [folder])
  const library = (await client.call('library/read', { cwd: folder })) as {
    entries: readonly { name: string; copies: readonly { path: string }[] }[]
  }
  assert.deepEqual(
    library.entries.find((entry) => entry.name === 'hd-probe')?.copies.map((copy) => copy.path),
    [join(folder, '.agents', 'skills', 'hd-probe')],
  )
})

test('worktree/list refuses a repository nobody opened, and answers for one opened through any of its checkouts', async (t) => {
  // It ran `git worktree list` wherever it was pointed, so an absolute path to
  // a repository nobody opened was answered with every checkout's path, branch
  // and HEAD commit. It is held to the repositories opened here, as the verbs
  // that read or change one worktree are, rather than to open folders, as the
  // git pane's verbs are: after a refused bring-back the store asks it of the
  // main checkout, which is outside every open folder when the folder open is
  // one of its linked worktrees.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const scratch = await mkdtemp(join(tmpdir(), 'hd-worktree-list-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repo = join(scratch, 'repo')
  const linked = join(scratch, 'linked')
  await mkdir(repo)
  await gitIn(repo, 'init', '-q', '-b', 'main')
  await gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'root commit')
  await gitIn(repo, 'worktree', 'add', '-q', '-b', 'linked', linked)

  await t.test('a repository nobody opened is refused, through any of its checkouts', async () => {
    await assert.rejects(() => client.call('worktree/list', { root: repo }), /not a project opened here/)
    await assert.rejects(() => client.call('worktree/list', { root: linked }), /not a project opened here/)
  })

  await t.test('opened as a linked worktree alone, its main checkout answers', async () => {
    await client.call('workspace/open', { path: linked })
    const listed = (await client.call('worktree/list', { root: repo })) as readonly { path: string }[]
    assert.deepEqual(
      listed.map((entry) => entry.path),
      [await realpath(repo), await realpath(linked)],
    )
  })

  await t.test('a folder in no repository answers an empty list, not a failed call', async () => {
    // An ordinary workspace, and the store asks each time one opens.
    const plain = join(scratch, 'plain')
    await mkdir(plain)
    await client.call('workspace/open', { path: plain })
    assert.deepEqual(await client.call('worktree/list', { root: plain }), [])
  })
})

test('worktree/create refuses a repository reached through a link in an open folder, and cuts one in any folder opened here', async (t) => {
  // It checked the root as it was spelled, and a link has no spelling of its
  // own: with one repository open, a link in it to another read as inside it,
  // and `git -C` followed the link, so a repository nobody opened was given a
  // worktree under the state directory and a branch.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // Real paths throughout, so that nothing but the link below stands between
  // the open repository and the other one.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'hd-worktree-create-')))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repository = async (path: string): Promise<void> => {
    await mkdir(path)
    await gitIn(path, 'init', '-q', '-b', 'main')
    await gitIn(path, 'commit', '-q', '--allow-empty', '-m', 'root commit')
  }
  const opened = join(scratch, 'opened')
  const other = join(scratch, 'other')
  await repository(opened)
  await repository(other)
  const link = join(opened, 'elsewhere')
  await symlink(other, link)
  await client.call('workspace/open', { path: opened })

  // What a repository holds of HarnessDesk's: its branches, and its checkouts
  // as git lists them.
  const holds = async (repo: string): Promise<{ branches: string[]; checkouts: string[] }> => ({
    branches: (await gitIn(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/harnessdesk/'))
      .split('\n')
      .filter((line) => line.length > 0),
    checkouts: (await gitIn(repo, 'worktree', 'list', '--porcelain'))
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length)),
  })
  const untouched = { branches: [], checkouts: [other] }
  const outside = `${other} is outside every open workspace. Open its folder first to read from it.`

  await t.test('named directly, a repository nobody opened is refused', async () => {
    await assert.rejects(() => client.call('worktree/create', { root: other, name: 'direct' }), { message: outside })
    assert.deepEqual(await holds(other), untouched)
  })

  await t.test('reached through a link in the open one, it is refused as well, and nothing is made in it', async () => {
    // The control: the link leads to that repository, so a refusal is about
    // where the path leads and not about a path that leads nowhere.
    assert.equal(await realpath(link), other)
    const answer = await client
      .call('worktree/create', { root: link, name: 'through-link' })
      .then((created) => ({ created }), (error: Error) => ({ refused: error.message }))
    // Read before the answer, so a call that was let in fails on what it made
    // there rather than only on having been answered.
    assert.deepEqual(await holds(other), untouched)
    assert.deepEqual(answer, { refused: outside })
  })

  await t.test('the open repository still gets its worktree', async () => {
    const created = (await client.call('worktree/create', { root: opened, name: 'ordinary' })) as {
      path: string
      branch: string
    }
    assert.equal(created.branch, 'harnessdesk/ordinary')
    assert.deepEqual(await holds(opened), { branches: ['harnessdesk/ordinary'], checkouts: [opened, created.path] })
  })

  await t.test('so does a submodule opened on its own', async () => {
    // Why this verb is held to open folders rather than to open repositories,
    // as the other worktree verbs are: git lists a submodule's own checkout as
    // its git directory, inside the superproject's `.git`, and that rule judges
    // those checkouts, so it refuses the submodule while it is the folder open.
    const library = join(scratch, 'library')
    const superproject = join(scratch, 'superproject')
    await repository(library)
    await repository(superproject)
    await gitIn(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendored')
    const vendored = join(superproject, 'vendored')
    assert.deepEqual((await holds(vendored)).checkouts, [join(superproject, '.git', 'modules', 'vendored')])
    await client.call('workspace/open', { path: vendored })
    const created = (await client.call('worktree/create', { root: vendored, name: 'in-vendored' })) as {
      branch: string
    }
    assert.equal(created.branch, 'harnessdesk/in-vendored')
    assert.deepEqual((await holds(vendored)).branches, ['harnessdesk/in-vendored'])
  })
})

/** The flow the room test below starts: one agent, in a worktree of its own. */
const ISOLATING_FLOW = `name: Probe
roles:
  worker:
    kind: agent
    seat: fake
    isolate: true
    outcomes: [done]
seed: { role: worker, title: "Do it" }
`

/** The same agent in the room's own folder, for a folder no worktree can be cut from. */
const SEATING_FLOW = `name: Probe
roles:
  worker:
    kind: agent
    seat: fake
    outcomes: [done]
seed: { role: worker, title: "Do it" }
`

test('goal/create refuses a repository nobody opened, flow/start refuses a Goal whose folder was closed, and a Goal in any folder or repository opened here still starts its flow', async (t) => {
  // The team plane took a room's root as it came, and the host's `isolate`
  // hands a room's folder straight to the worktree service, past the handler
  // that holds `worktree/create` to what is open. So with one repository open,
  // a room could be made in another, and a flow started in it cut a branch and
  // a worktree there.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // Real paths throughout, so that nothing but what each subtest sets up
  // stands between the open repository and the others.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'hd-room-root-')))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repository = async (path: string): Promise<string> => {
    await mkdir(path)
    await gitIn(path, 'init', '-q', '-b', 'main')
    await gitIn(path, 'commit', '-q', '--allow-empty', '-m', 'root commit')
    return path
  }
  // What a repository holds of HarnessDesk's: its branches, and its checkouts
  // as git lists them.
  const holds = async (repo: string): Promise<{ branches: string[]; checkouts: string[] }> => ({
    branches: (await gitIn(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/harnessdesk/'))
      .split('\n')
      .filter((line) => line.length > 0),
    checkouts: (await gitIn(repo, 'worktree', 'list', '--porcelain'))
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length)),
  })
  const untouched = (repo: string) => ({ branches: [], checkouts: [repo] })
  const refused = (folder: string): string =>
    `${folder} is outside every folder and repository opened here. Open it first.`
  const startFlow = (room: string): Promise<FlowRun> =>
    client.call('flow/start', { room, source: ISOLATING_FLOW }) as Promise<FlowRun>
  // A room made there and its flow started, the way the room dialog does both,
  // or the refusal of the room.
  const attempt = async (root: string, name: string): Promise<unknown> => {
    let room: GoalView
    try {
      room = (await client.call('goal/create', { root, sentence: name })) as GoalView
    } catch (error) {
      return { refused: (error as Error).message }
    }
    return startFlow(room.goal.id).then(
      (run) => ({ room: room.goal.root, flow: run.state }),
      (error: Error) => ({ room: room.goal.root, flow: error.message }),
    )
  }

  const opened = await repository(join(scratch, 'opened'))
  await client.call('workspace/open', { path: opened })

  await t.test('a room in a repository nobody opened is refused, and nothing is cut there', async () => {
    const other = await repository(join(scratch, 'other'))
    const answer = await attempt(other, 'elsewhere')
    // Read before the answer, so a room that was let in fails on what its flow
    // cut there rather than only on having been made.
    assert.deepEqual(await holds(other), untouched(other))
    assert.deepEqual(answer, { refused: refused(other) })
    assert.deepEqual(await client.call('team/rooms', { root: other }), [])
  })

  await t.test('reached through a link in the open one, it is refused as well', async () => {
    const behind = await repository(join(scratch, 'behind'))
    const link = join(opened, 'elsewhere')
    await symlink(behind, link)
    // The control: the link leads to that repository, so a refusal is about
    // where the path leads and not about a path that leads nowhere.
    assert.equal(await realpath(link), behind)
    const answer = await attempt(link, 'through the link')
    assert.deepEqual(await holds(behind), untouched(behind))
    assert.deepEqual(answer, { refused: refused(behind) })
  })

  await t.test('spelled relative, a root is refused, even one that leads into a repository opened here', async () => {
    // A relative path names no folder until something resolves it, and what
    // resolved this one was the host's working directory, wherever the app
    // was started. So the root below is the one relative spelling that
    // resolution would admit: from this process's working directory, which is
    // the host's, into a repository opened here.
    const near = await repository(join(scratch, 'near'))
    await client.call('workspace/open', { path: near })
    const spelled = relative(process.cwd(), near)
    // The controls: the spelling is relative, and it leads there.
    assert.equal(isAbsolute(spelled), false)
    assert.equal(await realpath(spelled), near)
    const answer = await attempt(spelled, 'relative')
    assert.deepEqual(await holds(near), untouched(near))
    assert.deepEqual(answer, { refused: `${spelled} is not an absolute path.` })
  })

  await t.test('a room whose folder is no longer open starts no flow, and nothing is cut there', async () => {
    // A room outlives its folder being open: forgetting the folder leaves the
    // room, and so does every launch after it.
    const closed = await repository(join(scratch, 'closed'))
    await client.call('workspace/open', { path: closed })
    const room = (await client.call('goal/create', { root: closed, sentence: 'was open' })) as GoalView
    await client.call('workspace/forget', { path: closed })
    const answer = await startFlow(room.goal.id).then(
      (run) => ({ flow: run.state }),
      (error: Error) => ({ refused: error.message }),
    )
    assert.deepEqual(await holds(closed), untouched(closed))
    assert.deepEqual(answer, { refused: refused(closed) })
  })

  await t.test('a room in the open repository still isolates its flow', async () => {
    const room = (await client.call('goal/create', { root: opened, sentence: 'here' })) as GoalView
    const run = await startFlow(room.goal.id)
    assert.equal(run.state, 'running')
    const held = await holds(opened)
    assert.match(held.branches.join(' '), /^harnessdesk\/lane-[a-f0-9-]{36}$/)
    assert.deepEqual(held.checkouts, [opened, ...run.seats.map((seat) => seat.cwd)])
  })

  await t.test('so does one made from a linked worktree, at its main checkout', async () => {
    // What the room dialog asks for there: `projectRootOf` names a linked
    // worktree's main checkout, which is outside every open folder while only
    // the worktree is open. The repository is open, and that is what admits it.
    const main = await repository(join(scratch, 'main'))
    const linked = join(scratch, 'linked')
    await gitIn(main, 'worktree', 'add', '-q', '-b', 'linked', linked)
    await client.call('workspace/open', { path: linked })
    await assert.rejects(() => client.call('git/status', { root: main }), /outside every open workspace/)
    const room = (await client.call('goal/create', { root: main, sentence: 'from the worktree' })) as GoalView
    assert.equal(room.goal.root, main)
    assert.equal((await startFlow(room.goal.id)).state, 'running')
    assert.equal((await holds(main)).branches.length, 1)
  })

  await t.test('and so does one in a submodule opened on its own', async () => {
    // A folder opened here, whatever git lists as its repository's main
    // checkout: its git directory, inside the superproject's `.git`.
    const library = await repository(join(scratch, 'library'))
    const superproject = await repository(join(scratch, 'superproject'))
    await gitIn(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendored')
    const vendored = join(superproject, 'vendored')
    await client.call('workspace/open', { path: vendored })
    const room = (await client.call('goal/create', { root: vendored, sentence: 'vendored' })) as GoalView
    assert.equal((await startFlow(room.goal.id)).state, 'running')
    assert.equal((await holds(vendored)).branches.length, 1)
  })

  await t.test('and a room in a folder in no repository still seats its flow there', async () => {
    // The folder rule's own case: the repository rule has nothing to say
    // about a folder git knows nothing of.
    const plain = join(scratch, 'plain')
    await mkdir(plain)
    await client.call('workspace/open', { path: plain })
    const room = (await client.call('goal/create', { root: plain, sentence: 'plain' })) as GoalView
    const run = (await client.call('flow/start', { room: room.goal.id, source: SEATING_FLOW })) as FlowRun
    assert.equal(run.state, 'running')
    assert.deepEqual(
      run.seats.map((seat) => seat.cwd),
      [plain],
    )
  })
})

test('flow/list and flow/read refuse a folder nobody opened, and read the flows of any folder or repository opened here', async (t) => {
  // They took their root as it came: with one folder open, any other folder's
  // `.harnessdesk/flows` was listed and its files read. The room dialog asks
  // them about the root it will make its room at, so they answer to the rule
  // a room does.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  // Real paths throughout, so that nothing but the link below stands between
  // the open folder and the other one.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'hd-flow-files-')))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const flowFile = (name: string): string => `name: ${name}
roles:
  worker:
    kind: agent
    seat: fake
    outcomes: [done]
seed: { role: worker, title: "Do it" }
`
  // A folder with one flow in it, and nothing git knows about.
  const folder = async (path: string, file: string, name: string): Promise<string> => {
    await mkdir(join(path, '.harnessdesk', 'flows'), { recursive: true })
    await writeFile(join(path, '.harnessdesk', 'flows', file), flowFile(name))
    return path
  }
  const opened = await folder(join(scratch, 'opened'), 'here.yml', 'Here')
  const other = await folder(join(scratch, 'other'), 'secret.yml', 'Only in the other folder')
  await client.call('workspace/open', { path: opened })

  const outside = (path: string): string =>
    `${path} is outside every folder and repository opened here. Open it first.`
  // Each call's answer, or its refusal, so a call that was let in fails on
  // what it read.
  const list = (root: string): Promise<unknown> =>
    client.call('flow/list', { root }).then(
      (files) => ({ listed: (files as readonly { path: string; name: string }[]).map((file) => [file.path, file.name]) }),
      (error: Error) => ({ refused: error.message }),
    )
  const read = (root: string, path: string): Promise<unknown> =>
    client.call('flow/read', { root, path }).then(
      (text) => ({ read: text }),
      (error: Error) => ({ refused: error.message }),
    )

  await t.test('a flow in a folder nobody opened is not read', async () => {
    assert.deepEqual(await read(other, '.harnessdesk/flows/secret.yml'), { refused: outside(other) })
  })

  await t.test('and that folder’s flows are not listed', async () => {
    assert.deepEqual(await list(other), { refused: outside(other) })
  })

  await t.test('reached through a link in the open folder, it is refused as well', async () => {
    const link = join(opened, 'elsewhere')
    await symlink(other, link)
    // The control: the link leads to that folder.
    assert.equal(await realpath(link), other)
    assert.deepEqual(await read(link, '.harnessdesk/flows/secret.yml'), { refused: outside(other) })
    assert.deepEqual(await list(link), { refused: outside(other) })
  })

  await t.test('spelled relative, even into the open folder, it is refused', async () => {
    const spelled = relative(process.cwd(), opened)
    assert.equal(isAbsolute(spelled), false)
    assert.equal(await realpath(spelled), opened)
    assert.deepEqual(await list(spelled), { refused: `${spelled} is not an absolute path.` })
    assert.deepEqual(await read(spelled, '.harnessdesk/flows/here.yml'), {
      refused: `${spelled} is not an absolute path.`,
    })
  })

  await t.test('the folder opened here still lists and reads its flows', async () => {
    // A folder in no repository, which only the folder rule admits.
    assert.deepEqual(await list(opened), { listed: [['.harnessdesk/flows/here.yml', 'Here']] })
    assert.deepEqual(await read(opened, '.harnessdesk/flows/here.yml'), { read: flowFile('Here') })
  })

  await t.test('and so does a linked worktree’s main checkout, the root the room dialog asks with', async () => {
    // Outside every open folder while only the worktree is open: the
    // repository is open, and that is what admits it.
    const main = await folder(join(scratch, 'main'), 'main.yml', 'In the main checkout')
    await gitIn(main, 'init', '-q', '-b', 'main')
    await gitIn(main, 'add', '.')
    await gitIn(main, 'commit', '-q', '-m', 'root commit')
    const linked = join(scratch, 'linked')
    await gitIn(main, 'worktree', 'add', '-q', '-b', 'linked', linked)
    await client.call('workspace/open', { path: linked })
    assert.deepEqual(await list(main), { listed: [['.harnessdesk/flows/main.yml', 'In the main checkout']] })
    assert.deepEqual(await read(main, '.harnessdesk/flows/main.yml'), { read: flowFile('In the main checkout') })
  })
})

test('a folder is not opened by a relative path, whether the wire or the picker names it', async (t) => {
  // `describeWorkspace` resolved what it was handed, so a relative path opened
  // whatever it led to from the host's working directory, and that folder then
  // counted as open for every confinement check after it. The path below is
  // the spelling that resolution would open: from this process's working
  // directory, which is the host's, to a folder nothing has opened.
  const scratch = await mkdtemp(join(tmpdir(), 'hd-open-relative-'))
  const spelled = relative(process.cwd(), scratch)
  // The native picker answers with an absolute path, but the host is the
  // boundary, and `workspace/pick` opens what it is handed as
  // `workspace/open` does.
  const harness = await start({ pickDirectory: async () => spelled })
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  t.after(() => rm(scratch, { recursive: true, force: true }))

  // The controls: the spelling is relative, and it leads from the host's
  // working directory to the folder.
  assert.equal(isAbsolute(spelled), false)
  assert.equal(await realpath(spelled), await realpath(scratch))

  await t.test('workspace/open', async () => {
    await assert.rejects(() => client.call('workspace/open', { path: spelled }), {
      message: `${spelled} is not an absolute path.`,
    })
  })
  await t.test('workspace/pick', async () => {
    await assert.rejects(() => client.call('workspace/pick', {}), {
      message: `${spelled} is not an absolute path.`,
    })
  })

  // Neither refusal opened it: nothing is remembered, and a read of it is
  // still refused. Spelled absolutely, it opens, so what was refused was the
  // spelling.
  assert.deepEqual(await client.call('workspace/recent', {}), [])
  await assert.rejects(() => client.call('git/status', { root: scratch }), /outside every open workspace/)
  assert.equal(((await client.call('workspace/open', { path: scratch })) as { path: string }).path, scratch)
})

test('a git root that is not there yet is judged by the folder it would be in, links and all', async (t) => {
  // `realpath` refuses a path that does not exist, and the confinement then
  // compared the path as it was spelled against open folders it had resolved.
  // A folder reached through a link — macOS reaches every temporary folder
  // through /var -> /private/var — was refused as outside the very folder it
  // sits in the moment it was not there; and a link out of an open folder
  // passed as inside it, because nothing looked at the link.
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const scratch = await mkdtemp(join(tmpdir(), 'hd-git-missing-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repo = join(scratch, 'real', 'repo')
  await mkdir(repo, { recursive: true })
  await gitIn(repo, 'init', '-q', '-b', 'main')
  await symlink(join(scratch, 'real'), join(scratch, 'link'))
  await mkdir(join(scratch, 'outside'))
  await symlink(join(scratch, 'outside'), join(repo, 'out'))
  // Opened the way a person reached it: through the link.
  const opened = join(scratch, 'link', 'repo')
  await client.call('workspace/open', { path: opened })

  await t.test('inside an open folder reached through a link, git answers', async () => {
    // Git's answer for a folder that is not a repository, not a refusal.
    assert.equal(await client.call('git/status', { root: join(opened, 'not-yet') }), null)
  })

  await t.test('behind a link out of an open folder, it is refused', async () => {
    // The control: a link inside the open folder that leads out of it is still
    // out of it, whether what it leads to is there or not. Spelled from the
    // real path, so that nothing but the link stands between it and the open
    // folder.
    const leaving = join(await realpath(repo), 'out', 'not-yet')
    await assert.rejects(() => client.call('git/status', { root: leaving }), /outside every open workspace/)
  })
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

test('git/status does not crash when persisted workspaces contain malformed records missing path (#428)', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-malformed-workspace-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  const repo = await mkdtemp(join(tmpdir(), 'hd-git-repo-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await gitIn(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'a.txt'), 'hello\n')
  await gitIn(repo, 'add', '.')
  await gitIn(repo, 'commit', '-qm', 'initial')

  // Persist state containing workspace records missing path or having non-string path
  const stateFile = join(stateDir, 'state.json')
  await writeFile(
    stateFile,
    JSON.stringify({
      workspaces: [
        { id: 'ws-valid', path: repo },
        { id: 'ws-missing-path' },
        { id: 'ws-null-path', path: null },
        { id: 'ws-number-path', path: 123 },
      ],
    }),
  )

  const host = new Host({
    logger: silent,
    state: new StateStore(stateFile),
  })
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  t.after(async () => {
    await server.close()
    await host.dispose()
  })

  const client = await Client.connect(server)
  t.after(() => client.close())

  // Calling git/status must not throw ERR_INVALID_ARG_TYPE
  const status = (await client.call('git/status', { root: repo })) as { root: string }
  const { realpathSync } = await import('node:fs')
  assert.equal(realpathSync(status.root), realpathSync(repo))
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

test('app/state/set wire call rejects when state cannot be persisted to disk', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const stateFile = join(harness.stateDir, 'state.json')
  await rm(stateFile, { force: true })
  await mkdir(stateFile)

  await assert.rejects(client.call('app/state/set', { patch: { theme: 'dark' } }))
})

test('HTTP token gate cannot be bypassed by non-root SPA routes (#429)', async (t) => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const uiDir = await mkdtemp(join(tmpdir(), 'harnessdesk-ui-gate-'))
  t.after(() => rm(uiDir, { recursive: true, force: true }))
  await writeFile(join(uiDir, 'index.html'), '<html>app shell</html>')
  await writeFile(join(uiDir, 'bundle.js'), 'console.log("bundle")')

  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-gate-state-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
  })
  await host.start()
  const server = await serve({ host, logger: silent, port: 0, uiRoot: uiDir, token: 'secret-token' })
  t.after(async () => {
    await server.close()
    await host.dispose()
  })

  // 1. Root without token -> 401
  const resRootNoToken = await fetch(`${server.url}/`)
  assert.equal(resRootNoToken.status, 401)

  // 2. Non-root fallback route without token -> must be 401, not 200
  const resSpaRouteNoToken = await fetch(`${server.url}/settings/appearance`)
  assert.equal(resSpaRouteNoToken.status, 401, 'non-root SPA route without token must be refused with 401')

  // 3. Root with token -> 200
  const resRootWithToken = await fetch(`${server.url}/?token=secret-token`)
  assert.equal(resRootWithToken.status, 200)
  assert.equal(await resRootWithToken.text(), '<html>app shell</html>')

  // 4. Non-root fallback route with token -> 200
  const resSpaRouteWithToken = await fetch(`${server.url}/settings/appearance?token=secret-token`)
  assert.equal(resSpaRouteWithToken.status, 200)
  assert.equal(await resSpaRouteWithToken.text(), '<html>app shell</html>')

  // 5. Existing static asset without token -> 200 (static assets are ungated per design)
  const resStatic = await fetch(`${server.url}/bundle.js`)
  assert.equal(resStatic.status, 200)
  assert.equal(await resStatic.text(), 'console.log("bundle")')
})

test('preview-frame endpoint restricts navigation and form actions in CSP (#474)', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const root = harness.stateDir
  const { writeFile } = await import('node:fs/promises')
  const htmlFile = join(root, 'preview.html')
  await writeFile(htmlFile, '<html><body>preview</body></html>', 'utf8')

  // Open workspace folder so confinement passes
  await client.call('workspace/open', { path: root })

  const { ticket } = (await client.call('preview/ticket', {
    path: htmlFile,
  })) as { ticket: string }

  const res = await fetch(`${harness.server.url}/preview-frame?ticket=${encodeURIComponent(ticket)}`)
  assert.equal(res.status, 200)
  const csp = res.headers.get('content-security-policy') ?? ''
  assert.match(csp, /form-action 'none'/, 'CSP must forbid form submission navigation')
  assert.match(csp, /navigate-to 'none'/, 'CSP must forbid document navigation')
})
