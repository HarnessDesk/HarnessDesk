import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { allItems, reduceAll, wrapContext, type AgentEvent, type AgentSession, type Session } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'

/**
 * "Review uncommitted changes" — a review on a side thread, which leaves the
 * conversation it was asked from as it is — against the fake Codex, which
 * plays a review notification for notification as 0.155.0 does (`playReview`
 * in the fixture) and answers Codex's own detached delivery as 0.155.0
 * answers it: a deprecation notice, then a refusal.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const start = async (t: { after(fn: () => Promise<void>): void }, env: Record<string, string> = {}) => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test', env })
  t.after(() => runtime.dispose())
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  const until = async (predicate: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; saw ${events.map((event) => event.type).join(', ')}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  return { runtime, events, until }
}

const notices = (events: readonly AgentEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'notice' ? [event.message] : []))

/** What a session's controls read, by id — what the composer shows. */
const values = (session: AgentSession): Record<string, unknown> =>
  Object.fromEntries(session.options().map((option) => [option.id, option.currentValue]))

/** The events about one conversation, in the order they came. */
const about = (events: readonly AgentEvent[], session: AgentSession): AgentEvent[] =>
  events.filter(
    (event) =>
      ('sessionId' in event && event.sessionId === session.id) ||
      (event.type === 'session/started' && event.session.id === session.id),
  )

/** A conversation that has been changed from everything Codex's configuration gives a new one. */
const changed = async (runtime: CodexRuntime): Promise<AgentSession> => {
  const session = await runtime.createSession({ cwd: '/w/app' })
  await session.setOption('permissions', ':read-only')
  await session.setOption('approvals', 'never')
  await session.setOption('serviceTier', 'priority')
  // Plan brings an effort of its own; the one set after it is the one to keep.
  await session.setOption('mode', 'plan')
  await session.setOption('effort', 'high')
  return session
}

test('a review on a side thread runs inline in a new thread set up like this one', async (t) => {
  const { runtime, events, until } = await start(t)
  const session = await changed(runtime)
  const before = events.length

  const side = await session.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side, 'a review on a side thread answers with the thread it runs in')
  assert.notEqual(side.id, session.id)

  // Set up like the conversation it was asked from, control for control.
  assert.deepEqual(values(side), values(session))
  assert.deepEqual(values(session), {
    model: 'gpt-5.5',
    effort: 'high',
    mode: 'plan',
    permissions: ':read-only',
    approvals: 'never',
    approvalsReviewer: 'user',
    serviceTier: 'priority',
  })
  assert.equal(side.settings().cwd, '/w/app')

  // Reviewed inline on the new thread, and never with Codex's detached delivery.
  const reviews = events.slice(before).filter((event) => event.type === 'notice' && event.message.startsWith('REVIEW'))
  assert.deepEqual(
    reviews.map((event) => [event.type === 'notice' && event.message, 'sessionId' in event && event.sessionId]),
    [['REVIEW uncommittedChanges inline', side.id]],
  )
  assert.ok(!notices(events).some((message) => /deprecated/.test(message)), 'no deprecation notice reaches anyone')

  // Named for what it reviews, before the review is even over.
  assert.ok(
    about(events, side).some((event) => event.type === 'session/title' && event.title === 'Review of uncommitted changes'),
  )

  await until(() => about(events, side).some((event) => event.type === 'turn/completed'), 'the review to finish')
  // The conversation it was asked from heard nothing but its own settings.
  assert.deepEqual(
    [...new Set(about(events.slice(before), session).map((event) => event.type))],
    [],
    'the reviewed conversation is left as it is',
  )
})

test('an effort the mode moves is set again once the mode has moved', async (t) => {
  // config.toml asks for high and Plan reasons at low, so a conversation put in
  // Plan and then back up to high matches a new thread's effort only until
  // that thread's mode moves too.
  const { runtime } = await start(t, { FAKE_CODEX_CONFIGURED_EFFORT: 'high', FAKE_CODEX_PLAN_EFFORT: 'low' })
  const session = await runtime.createSession({ cwd: '/w' })
  await session.setOption('mode', 'plan')
  assert.equal(values(session)['effort'], 'low', 'Plan brought its own effort')
  await session.setOption('effort', 'high')
  const side = await session.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side)
  assert.deepEqual([values(side)['mode'], values(side)['effort']], ['plan', 'high'])
})

test('the review turn opens, fills and ends, so a reader keeps the findings', async (t) => {
  const { runtime, events, until } = await start(t)
  const session = await runtime.createSession({ cwd: '/w' })
  const side = await session.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side)
  await until(() => about(events, side).some((event) => event.type === 'turn/completed'), 'the review to finish')
  const told = about(events, side)

  // One turn, the review's own: Codex never announces it and announces the
  // reviewer sub-agent's instead, which nothing else names.
  const started = told.flatMap((event) => (event.type === 'turn/started' ? [String(event.turn.id)] : []))
  assert.deepEqual(started, ['review-turn-1'])
  assert.deepEqual(
    (await runtime.listSessions()).data.find((row) => row.id === side.id)?.status,
    { type: 'idle' },
    'a finished review is not listed as working',
  )

  // Folded by the same reducer the host and the window use.
  const opened = told.find((event) => event.type === 'session/started')
  assert.ok(opened?.type === 'session/started')
  const folded: Session = reduceAll(opened.session, told)
  assert.equal(folded.turns.length, 1)
  const [turn] = folded.turns
  assert.equal(turn?.status, 'completed')
  const shown = allItems(folded).map((item) =>
    item.type === 'review'
      ? `review ${item.phase}`
      : item.type === 'assistantMessage'
        ? `says ${item.text.split('\n')[0]}`
        : item.type,
  )
  assert.deepEqual(shown, [
    'review entered',
    'userMessage',
    'review exited',
    'says One cosmetic finding.',
  ])
})

test('a review can be stopped, and ends as a stopped turn', async (t) => {
  // Codex checks the stop against the reviewer's turn, which the desk never
  // shows; naming the review's own is refused.
  const { runtime, events, until } = await start(t, { FAKE_CODEX_REVIEW_MS: '60000' })
  const session = await runtime.createSession({ cwd: '/w' })
  const side = await session.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side)
  await until(() => about(events, side).some((event) => event.type === 'turn/started'), 'the review to start')

  await side.interrupt()
  await until(() => about(events, side).some((event) => event.type === 'turn/completed'), 'the review to end')
  const told = about(events, side)
  const opened = told.find((event) => event.type === 'session/started')
  assert.ok(opened?.type === 'session/started')
  const [turn] = reduceAll(opened.session, told).turns
  assert.equal(turn?.id, 'review-turn-1')
  assert.equal(turn?.status, 'interrupted')
  assert.deepEqual(
    (await runtime.listSessions()).data.find((row) => row.id === side.id)?.status,
    { type: 'idle' },
  )
})

test('a review stopped before its reviewer has started is stopped all the same', async (t) => {
  // Codex holds a turn it never reports until the reviewer starts, so the
  // stop names no turn at all — measured to stop the review on both versions.
  const { runtime, events, until } = await start(t, { FAKE_CODEX_REVIEW_MS: '60000', FAKE_CODEX_REVIEWER_MS: '60000' })
  const session = await runtime.createSession({ cwd: '/w' })
  const side = await session.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side)
  await until(() => about(events, side).some((event) => event.type === 'turn/started'), 'the review to start')
  await side.interrupt()
  await until(() => about(events, side).some((event) => event.type === 'turn/completed'), 'the review to end')
  const completed = about(events, side).find((event) => event.type === 'turn/completed')
  assert.ok(completed?.type === 'turn/completed' && completed.turn.status === 'interrupted')
})

test('a reviewer that starts first is still the reviewer, and nothing is left working', async (t) => {
  const { runtime, events, until } = await start(t, { FAKE_CODEX_REVIEWER_FIRST: '1' })
  const session = await runtime.createSession({ cwd: '/w' })
  const side = await session.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side)
  await until(
    () => about(events, side).filter((event) => event.type === 'turn/completed').length === 2,
    'the review, and the turn its reviewer was told as, to end',
  )
  const told = about(events, side)
  const opened = told.find((event) => event.type === 'session/started')
  assert.ok(opened?.type === 'session/started')
  const folded: Session = reduceAll(opened.session, told)
  assert.deepEqual(
    folded.turns.map((turn) => [String(turn.id), turn.status, turn.items.length > 0]),
    [
      ['reviewer-turn-1', 'completed', false],
      ['review-turn-1', 'completed', true],
    ],
  )
  assert.deepEqual((await runtime.listSessions()).data.find((row) => row.id === side.id)?.status, { type: 'idle' })
})

test('a review thread closed mid-review and opened again takes its next turn', async (t) => {
  // Closed, this desk stops hearing the thread, and never hears the review
  // end; the next turn must not be taken for the reviewer's.
  const { runtime, events, until } = await start(t, { FAKE_CODEX_REVIEW_MS: '60000' })
  const session = await runtime.createSession({ cwd: '/w' })
  const side = await session.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side)
  await until(() => about(events, side).some((event) => event.type === 'turn/started'), 'the review to start')
  await side.close()

  const again = await runtime.resumeSession(side.id)
  const from = events.length
  const turn = await again.send([{ type: 'text', text: 'Fix the finding' }])
  await until(
    () => events.slice(from).some((event) => event.type === 'turn/started' && event.turn.id === turn),
    'the next turn to start',
  )
})

test('a review that runs here asks Codex for an inline one, and answers with no other thread', async (t) => {
  const { runtime, events, until } = await start(t)
  const session = await runtime.createSession({ cwd: '/w' })
  assert.equal(await session.review!({ type: 'commit', sha: 'abc1234' }), null)
  await until(() => notices(events).includes('REVIEW commit inline'), 'the review request')
  assert.equal(
    events.filter((event) => event.type === 'session/started').length,
    1,
    'no second thread was started',
  )
  await until(() => about(events, session).some((event) => event.type === 'turn/completed'), 'the review to finish')
  assert.deepEqual((await runtime.listSessions()).data.find((row) => row.id === session.id)?.status, { type: 'idle' })
})

test('a review Codex refuses leaves no thread behind and says why', async (t) => {
  const { runtime, events } = await start(t)
  const session = await runtime.createSession({ cwd: '/w' })
  await assert.rejects(
    () => session.review!({ type: 'baseBranch', branch: '  ', delivery: 'detached' }),
    /branch must not be empty/,
  )
  const opened = events.flatMap((event) =>
    event.type === 'session/started' && event.session.id !== session.id ? [event.session.id] : [],
  )
  assert.equal(opened.length, 1, 'the side thread was started before Codex refused the review')
  // Not held open, so the listing lays no row of it over Codex's, where a
  // thread with no turn is never listed (measured on 0.145.0 and 0.155.0).
  assert.equal(runtime.session(opened[0]!), undefined, 'and is not held open')
  assert.ok(
    !events.some((event) => event.type === 'session/title' && event.sessionId === opened[0]),
    'nor named',
  )
})

test('the first message sent in a review thread does not rename it', async (t) => {
  const { runtime, events, until } = await start(t)
  const session = await runtime.createSession({ cwd: '/w' })
  const side = await session.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side)
  await until(() => about(events, side).some((event) => event.type === 'turn/completed'), 'the review to finish')

  // A message the desk wrapped in context is the one a new thread is named
  // after; this thread already has a name.
  await side.send([{ type: 'text', text: `${wrapContext('Git', 'On branch main.')}\n\nFix the finding` }])
  // Answered after anything the send wrote before it: a rename would be in.
  await side.setMemoryMode!(true)
  await until(() => notices(events).includes('MEMORY enabled'), 'the memory switch')
  const titles = about(events, side).flatMap((event) => (event.type === 'session/title' ? [event.title] : []))
  assert.deepEqual(titles, ['Review of uncommitted changes'])
})

test('a side thread keeps the sandbox its configuration gave the conversation, not the profile named after it', async (t) => {
  // No profile chosen: Codex reports only the configuration's sandbox, and a
  // thread started on :workspace instead would lose its network access and
  // writable roots (measured on 0.145.0 and 0.155.0).
  const { runtime, events, until } = await start(t, { FAKE_CODEX_ECHO_STARTS: '1' })
  const session = await runtime.createSession({ cwd: '/w' })
  const side = await session.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side)
  await until(() => notices(events).filter((message) => message.startsWith('STARTED')).length === 2, 'both starts')
  const [, sideStart] = notices(events)
    .filter((message) => message.startsWith('STARTED'))
    .map((message) => JSON.parse(message.slice('STARTED '.length)) as Record<string, unknown>)
  assert.equal(sideStart?.['sandbox'], 'workspace-write')
  assert.equal(sideStart?.['permissions'], undefined)
  assert.equal(values(side)['permissions'], values(session)['permissions'])
})

test('a side thread keeps the model route its conversation was opened on', async (t) => {
  const { runtime, events, until } = await start(t, { FAKE_CODEX_ECHO_STARTS: '1' })
  const route = {
    id: 'route-1',
    name: 'Gateway',
    endpoint: 'http://127.0.0.1:9/t/token',
    wireProtocol: 'responses',
    token: 'token',
    model: 'gpt-5.5',
  }
  const session = await runtime.createSession({ cwd: '/w', route })
  const side = await session.review!({ type: 'uncommitted', delivery: 'detached' })
  assert.ok(side)
  await until(() => notices(events).filter((message) => message.startsWith('STARTED')).length === 2, 'both starts')
  const [, sideStart] = notices(events)
    .filter((message) => message.startsWith('STARTED'))
    .map((message) => JSON.parse(message.slice('STARTED '.length)) as Record<string, unknown>)
  assert.equal(sideStart?.['modelProvider'], 'harnessdesk_route')
  assert.equal(
    (sideStart?.['config'] as Record<string, unknown> | undefined)?.['model_providers.harnessdesk_route.base_url'],
    route.endpoint,
  )
  assert.equal(side.settings().modelProvider, 'harnessdesk_route')
})
