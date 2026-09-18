import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, AgentSession } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'

/**
 * Where a settings change landed is what Codex said, never what was asked.
 *
 * `thread/settings/update` is answered with `{}`, which says only that the
 * change was taken. Where it landed is `thread/settings/updated`, the whole
 * settings record, and it can reach the desk after the answer, in the same
 * read as it, or before it. A session that wrote the request in when the
 * answer came reported an effort Codex had put somewhere else — until the
 * notification caught up, or, when both came in one read, for good. Every
 * reader above it repeated that as a fact: a seat's read-back, a flow's
 * label, the picker.
 *
 * The fake settles an effort asked for as high on low
 * (FAKE_CODEX_EFFORT_SETTLES), and FAKE_CODEX_SETTINGS_ORDER says where its
 * announcement falls against its answer.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const codex = async (t: TestContext, env: Record<string, string>, settleMs?: number) => {
  const runtime = new CodexRuntime({
    binaryPath: FAKE,
    clientName: 'harnessdesk-test',
    env,
    ...(settleMs === undefined ? {} : { settleMs }),
  })
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  t.after(() => runtime.dispose())
  await runtime.start()
  return { runtime, events }
}

const effortOf = (session: AgentSession) => session.options().find((option) => option.id === 'effort')?.currentValue

/** The effort in the last `session/options` a window was sent for this conversation. */
const toldEffort = (events: readonly AgentEvent[], session: AgentSession) =>
  events
    .filter(
      (event): event is Extract<AgentEvent, { type: 'session/options' }> =>
        event.type === 'session/options' && event.sessionId === session.id,
    )
    .at(-1)
    ?.options.find((option) => option.id === 'effort')?.currentValue

const pause = (ms: number) => new Promise((wake) => setTimeout(wake, ms))

for (const [order, how] of [
  ['answer-first', 'the answer first, and the announcement in a later read, as 0.149.0 writes them'],
  ['one-chunk', 'the answer and the announcement in one read'],
  ['announce-first', 'the announcement before the answer'],
] as const) {
  test(`an effort Codex settles elsewhere is the effort the session reports — ${how}`, async (t) => {
    const { runtime, events } = await codex(t, { FAKE_CODEX_EFFORT_SETTLES: 'high:low', FAKE_CODEX_SETTINGS_ORDER: order })

    // An effort goes in as an update straight after `thread/start` — the
    // path a seat's conversation is opened on.
    const session = await runtime.createSession({ cwd: '/w', options: { effort: 'high' } })
    assert.equal(effortOf(session), 'low', 'as the conversation is handed back')
    await pause(250)
    assert.equal(effortOf(session), 'low', 'and once Codex has said everything it is going to')

    // And on a conversation already open, asked for high again.
    await session.setOption('effort', 'high')
    assert.equal(effortOf(session), 'low', 'as the call returns')
    await pause(250)
    assert.equal(effortOf(session), 'low', 'and after')
    assert.equal(toldEffort(events, session), 'low', 'the window is told where it landed, not what was asked')
  })
}

test('a change Codex takes and never announces is refused, and the control keeps what Codex last said', async (t) => {
  // Codex announces an update only when it changes something (measured on
  // 0.149.0). Asked for high on a thread at low, this Codex settles on low —
  // no change, so no word at all.
  const { runtime } = await codex(t, { FAKE_CODEX_EFFORT_SETTLES: 'high:low', FAKE_CODEX_QUIET_NOOP: '1' }, 200)
  const session = await runtime.createSession({ cwd: '/w', options: { effort: 'low' } })
  assert.equal(effortOf(session), 'low')

  await assert.rejects(session.setOption('effort', 'high'), (error: Error) => {
    assert.equal(
      error.message,
      'Codex took the change to Reasoning effort (High) without saying where it landed — the last it said was Low.',
    )
    return true
  })
  assert.equal(effortOf(session), 'low', 'what was asked is not shown as if Codex had said it')

  // Opened on it, the conversation is closed and the open refused, as any
  // option a new conversation could not be put on is.
  await assert.rejects(runtime.createSession({ cwd: '/w', options: { effort: 'high' } }), /without saying where it landed/)
})

test('a word Codex wrote while the desk was busy counts, though the deadline passed in the meantime', async (t) => {
  // The deadline is 50 ms, and Codex's word comes 100 ms after its answer.
  // The desk is held up from 30 ms to past a second — in the check phase, as a
  // long I/O callback would hold it — so the next turn of the event loop opens
  // on the overdue deadline before the read that would hand the word over. A
  // deadline that decided there would refuse a change Codex had announced.
  const { runtime } = await codex(t, { FAKE_CODEX_EFFORT_SETTLES: 'high:low', FAKE_CODEX_SETTINGS_ORDER: 'answer-first' }, 50)
  const session = await runtime.createSession({ cwd: '/w' })
  const pending = session.setOption('effort', 'high')
  setTimeout(
    () =>
      setImmediate(() => {
        const until = Date.now() + 1_000
        while (Date.now() < until);
      }),
    30,
  )
  await pending
  assert.equal(effortOf(session), 'low')
})

test('an update that moves nothing is answered at once, though Codex says nothing about it', { timeout: 10_000 }, async (t) => {
  // The wait for Codex's word is a minute here, so a setter that waited for
  // one Codex never sends for a change that moves nothing would outlast this
  // test's own ten seconds.
  const { runtime } = await codex(t, { FAKE_CODEX_QUIET_NOOP: '1' }, 60_000)
  const first = await runtime.createSession({ cwd: '/w', options: { effort: 'high' } })
  assert.equal(effortOf(first), 'high')

  await first.setOption('effort', 'high')
  assert.equal(effortOf(first), 'high')

  // A conversation opened on the effort Codex already starts it at: the
  // update after `thread/start` moves nothing either.
  const second = await runtime.createSession({ cwd: '/w', options: { effort: 'high' } })
  assert.equal(effortOf(second), 'high')
})
