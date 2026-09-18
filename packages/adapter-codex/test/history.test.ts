import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexAppServer } from '@harnessdesk/codex'
import { sessionId, type AgentEvent, type Session } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'

/**
 * A conversation's history, read, forked and undone the way Codex keeps it
 * (`src/history.ts`). The fake keeps its histories as Codex does, with the
 * deprecation notices and refusals word for word as
 * `script/probe/paginated-history.mjs` measured them on 0.145.0 and 0.155.0.
 * So "no deprecation notice" here is said of a stand-in that sends one
 * wherever Codex does — the first control below shows it does.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

type Context = { after(fn: () => Promise<void>): void }

const start = async (t: Context, version = '0.155.0') => {
  const runtime = new CodexRuntime({
    binaryPath: FAKE,
    clientName: 'harnessdesk-test',
    env: { FAKE_CODEX_VERSION: version },
  })
  t.after(() => runtime.dispose())
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  /**
   * Codex's deprecation notices so far. A round trip first: whatever Codex
   * wrote before answering it has been read by the time the answer is.
   */
  const deprecations = async (): Promise<string[]> => {
    await runtime.listSessions({ pageSize: 1 })
    return events.flatMap((event) => (event.type === 'notice' && /deprecated/.test(event.message) ? [event.message] : []))
  }
  return { runtime, events, deprecations }
}

/** Each turn by id, with the kinds of its items in order. */
const shape = (session: Session): string[] =>
  session.turns.map((turn) => `${turn.id}: ${turn.items.map((item) => item.type).join(', ')}`)
const turnIds = (session: Session): string[] => session.turns.map((turn) => String(turn.id))

const PAGED = [
  'turn-p1: userMessage, assistantMessage',
  'turn-p2: userMessage, command, assistantMessage',
  'turn-p3: userMessage, assistantMessage',
]

test('control: the fake deprecates a whole read of a paginated thread where 0.155.0 does', async (t) => {
  const server = new CodexAppServer({
    clientInfo: { name: 'harnessdesk-test', title: 'HarnessDesk', version: '0.0.0' },
    binaryPath: FAKE,
    env: { FAKE_CODEX_VERSION: '0.155.0' },
    experimentalApi: true,
  })
  t.after(() => server.stop())
  const heard: string[] = []
  server.onNotification((notification) => {
    if (notification.method === 'deprecationNotice') heard.push(notification.params.summary)
  })
  await server.start()
  const whole = await server.request('thread/read', { threadId: 'thread-paged', includeTurns: true })
  assert.equal(whole.thread.turns.length, 3, 'it answers, as 0.155.0 answers')
  assert.deepEqual(heard, [
    'Full-history hydration is deprecated for paginated threads; omit `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`.',
  ])
})

test('a paginated conversation is read in pages, every item under its turn, and Codex says nothing', async (t) => {
  const { runtime, deprecations } = await start(t)
  // Pages of two: three turns take two, their seven items four, and a turn's
  // items straddle a page.
  const session = await runtime.readSession(sessionId('thread-paged'))
  assert.equal(session.itemsLoaded, true)
  assert.deepEqual(shape(session), PAGED)
  assert.deepEqual(await deprecations(), [])
})

test('a legacy conversation is read whole, since Codex will not page one', async (t) => {
  const { runtime, deprecations } = await start(t)
  // The fake refuses `thread/items/list` a legacy thread, as Codex does: a
  // read that tried to page this one would fail rather than come back short.
  const session = await runtime.readSession(sessionId('thread-legacy'))
  assert.equal(session.itemsLoaded, true)
  assert.deepEqual(shape(session), [
    'turn-l1: userMessage, assistantMessage',
    'turn-l2: userMessage, assistantMessage',
  ])
  assert.deepEqual(await deprecations(), [])
})

test('a conversation with nothing stored yet reads as no turns, and has none to undo', async (t) => {
  const { runtime, deprecations } = await start(t)
  // Codex refuses to list the turns of a thread before its first message.
  const live = await runtime.createSession({ cwd: '/w' })
  const read = await runtime.readSession(live.id)
  assert.deepEqual(read.turns, [])
  assert.equal(read.itemsLoaded, true)
  await live.rollback!(1)
  assert.deepEqual(await deprecations(), [])
})

test('Undo reverts a paginated conversation to before the turn it drops, and Codex says nothing', async (t) => {
  const { runtime, deprecations } = await start(t)
  const live = await runtime.resumeSession(sessionId('thread-paged'))
  await live.rollback!(1)
  assert.deepEqual(turnIds(await runtime.readSession(live.id)), ['turn-p1', 'turn-p2'])
  await live.rollback!(2)
  assert.deepEqual(turnIds(await runtime.readSession(live.id)), [])
  assert.deepEqual(await deprecations(), [])
})

test('Undo counts turns across pages, and more than there are drops them all', async (t) => {
  for (const [count, left] of [
    [2, ['turn-p1']],
    [3, []],
    [5, []],
  ] as const) {
    const { runtime } = await start(t)
    const live = await runtime.resumeSession(sessionId('thread-paged'))
    await live.rollback!(count)
    assert.deepEqual(turnIds(await runtime.readSession(live.id)), left, `undoing ${count}`)
  }
})

test('Undo rolls a legacy conversation back, and Codex’s notice for that one stays: it has no other verb for one', async (t) => {
  const { runtime, deprecations } = await start(t)
  const live = await runtime.resumeSession(sessionId('thread-legacy'))
  await live.rollback!(1)
  assert.deepEqual(turnIds(await runtime.readSession(live.id)), ['turn-l1'])
  assert.deepEqual(await deprecations(), ['thread/rollback is deprecated and will be removed soon'])
})

test('a fork arrives with the history it copied, read in pages, and Codex says nothing', async (t) => {
  const { runtime, events, deprecations } = await start(t)
  const fork = await runtime.forkSession(sessionId('thread-paged'))
  assert.notEqual(String(fork.id), 'thread-paged')
  const started = events.find(
    (event): event is Extract<AgentEvent, { type: 'session/started' }> =>
      event.type === 'session/started' && event.session.id === fork.id,
  )
  // The pane shows a fork from this event and never reads it again.
  assert.deepEqual(started && shape(started.session), PAGED)
  assert.deepEqual(await deprecations(), [])
})

test('a fork of a legacy conversation arrives with its history, read whole', async (t) => {
  const { runtime, events, deprecations } = await start(t)
  const fork = await runtime.forkSession(sessionId('thread-legacy'))
  const started = events.find(
    (event): event is Extract<AgentEvent, { type: 'session/started' }> =>
      event.type === 'session/started' && event.session.id === fork.id,
  )
  assert.deepEqual(started && turnIds(started.session), ['turn-l1', 'turn-l2'])
  assert.deepEqual(await deprecations(), [])
})

test('resuming a paginated conversation never asks for its turns', async (t) => {
  const { runtime, deprecations } = await start(t)
  await runtime.resumeSession(sessionId('thread-paged'))
  assert.deepEqual(await deprecations(), [])
})

test('on Codex 0.145.0 a conversation is legacy: read whole, and rolled back', async (t) => {
  // The oldest Codex supported keeps every thread it starts whole and has no
  // `thread/revert`: asked for one, the fake refuses it as an unknown method.
  const { runtime } = await start(t, '0.145.0')
  const live = await runtime.resumeSession(sessionId('thread-e2e'))
  assert.deepEqual(shape(await runtime.readSession(live.id)), ['turn-old: userMessage, assistantMessage'])
  await live.rollback!(1)
  assert.deepEqual(turnIds(await runtime.readSession(live.id)), [])
})

test('a Codex without thread/revert says in words that it cannot undo a paginated conversation', async (t) => {
  // A conversation a newer Codex started, opened on 0.145.0: it pages the
  // thread, but has no verb to undo it.
  const { runtime } = await start(t, '0.145.0')
  const live = await runtime.resumeSession(sessionId('thread-paged'))
  assert.deepEqual(shape(await runtime.readSession(live.id)), PAGED)
  await assert.rejects(live.rollback!(1), (error: Error) => {
    assert.equal(
      error.message,
      'This version of Codex cannot undo a turn in a conversation a newer Codex started. Update Codex to undo it.',
    )
    return true
  })
  assert.deepEqual(turnIds(await runtime.readSession(live.id)), ['turn-p1', 'turn-p2', 'turn-p3'])
})
