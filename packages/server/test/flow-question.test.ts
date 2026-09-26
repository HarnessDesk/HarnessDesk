import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FlowExecution, GoalView, Intent } from '@harnessdesk/protocol'

import type { QuestionTimers } from '../src/host.js'
import { claimed, desk, E2E, execution, settled, start, TASK, whenChanged, write, type Desk } from './fixtures/flow-host-evidence.js'
import type { FakeSession } from './fixtures/fake-runtime.js'

/*
 * An unattended Seat's question: nobody answers it in time, so its turn is
 * interrupted and its run stops for a person. A person who then answers it,
 * on the room's own question card, has answered it — the Seat is handed that
 * answer in a turn of its own and carries on, and the run goes with it. The
 * Goal's activity, which the header reads, reads the same as its board all
 * the way through.
 */

const FLOW = `version: 2
name: "Ask, then fix"
description: "One fixer, who may ask a question first."
inputs:
  task:
    label: "Task"
roles:
  fixer:
    kind: agent
    uses: [implementer]
    grant: edit
    independentOf: []
seed: { role: fixer, title: "{{task}}" }
rules: []
messaging: board-only
`

/** The question deadline's timers, fired when the test says rather than twenty seconds on. */
const manualTimers = (): QuestionTimers & { readonly live: Map<number, () => void>; fireAll(): void } => {
  const live = new Map<number, () => void>()
  let next = 0
  return {
    live,
    setTimer: (fire) => { next += 1; live.set(next, fire); return next },
    clearTimer: (timer) => { live.delete(timer as number) },
    fireAll() {
      const due = [...live.values()]
      live.clear()
      for (const fire of due) fire()
    },
  }
}

interface Asking {
  readonly d: Desk
  readonly timers: ReturnType<typeof manualTimers>
  readonly run: FlowExecution
  readonly card: Intent
  readonly session: FakeSession
  /** Every message the Seat was sent, in order. */
  readonly sent: string[]
}

/** A flow whose one Seat asked a question nobody answered in time: its turn interrupted, its run stopped. */
const stoppedOnAQuestion = async (t: Parameters<typeof desk>[0]): Promise<Asking> => {
  const timers = manualTimers()
  const d = await desk(t, undefined, { questionTimers: timers })
  const sent: string[] = []
  for (const runtime of d.runtimes) runtime.onSend = (_session, text) => { sent.push(text) }
  const run = await start(d, FLOW, TASK)
  const [card] = await claimed(d, run.goal, 'fixer', 1)
  const runtime = d.runtimes.find((one) => one.info.id === card!.claim!.runtime)!
  const session = runtime.sessions.get(card!.claim!.sessionId)!
  assert.equal(session.busy, true, 'the Seat is inside its turn')
  void session.askQuestion('qu-base' as never, 'Which base branch should the fix go on?', [
    { id: 'opt-main', label: 'main' },
    { id: 'opt-next', label: 'next' },
  ])
  await whenChanged(d, () => (timers.live.size === 1 ? true : null), 'the question’s deadline set')
  timers.fireAll()
  const stalled = await whenChanged(d, async () => {
    const now = await execution(d, run.id)
    return now.state === 'stalled' ? now : null
  }, 'the run stopped for the unanswered question')
  assert.match(stalled.reason ?? '', /asked a question nobody can answer/)
  assert.equal(session.busy, false, 'the Seat’s turn was interrupted')
  return { d, timers, run, card: card!, session, sent }
}

const hasQuestion = (a: Asking): boolean =>
  a.d.host.registry.hasApproval(a.card.claim!.runtime as never, a.card.claim!.sessionId as never, 'qu-base' as never)

const answerIt = (a: Asking, choice = 'opt-main'): Promise<unknown> =>
  a.d.host.call('approval/respond', {
    runtime: a.card.claim!.runtime as never,
    sessionId: a.card.claim!.sessionId as never,
    approvalId: 'qu-base' as never,
    decision: { type: 'answers', answers: { q: [choice] } },
  })

const goal = async (a: Asking): Promise<GoalView> => await a.d.host.call('goal/read', { goal: a.run.goal }) as GoalView

test('an answered question resumes the flow Seat that asked it, and the run goes on to its end', E2E, async (t) => {
  const a = await stoppedOnAQuestion(t)
  assert.ok(hasQuestion(a), 'the question is still on the desk for a person to answer')
  const before = a.sent.length

  await answerIt(a)

  // Durable before the answer is acknowledged: the run is running again by the time the call returns.
  const resumed = await execution(a.d, a.run.id)
  assert.equal(resumed.state, 'running', `the run goes on: ${resumed.reason}`)
  assert.equal(resumed.reason, null)
  assert.ok(resumed.operations.some((one) => one.kind === 'turn' && one.card === a.card.id && one.key.includes(':answer:') && one.state === 'finished'),
    'the answer’s hand-over is journaled')
  // The Seat is back at work, in a turn that carries the question and the person's answer.
  assert.equal(a.session.busy, true, 'the Seat is back inside a turn')
  assert.equal(a.sent.length, before + 1, 'one turn, carrying the answer')
  const handed = a.sent.at(-1)!
  assert.match(handed, /Which base branch should the fix go on\?/)
  assert.match(handed, /main/)
  assert.doesNotMatch(handed, /\bnext\b/, 'the answer the person chose, not the other option')
  assert.match(handed, new RegExp(`Card #${a.card.id} on this Goal is yours`), 'and its own card, again')
  assert.equal(hasQuestion(a), false, 'the question is withdrawn once it is answered')
  assert.deepEqual(a.session.decisions, [{ type: 'cancel' }], 'the stopped turn’s outstanding question is closed, never answered in it')

  // The Seat finishes its card; the run reaches its end.
  await write(a.d, a.card, 'fixed on main')
  a.session.finish()
  await settled(a.d, a.run.id)
})

test('while a run is stopped on its Seat’s question, the Goal reads Needs you and its card is in Needs you; once answered, both read working', E2E, async (t) => {
  const a = await stoppedOnAQuestion(t)
  const stopped = await goal(a)
  assert.equal(stopped.activity, 'needs-you', 'the Goal, as the header reads it, needs its person')

  await answerIt(a)

  const answered = await goal(a)
  assert.equal(answered.activity, 'working', 'the Goal no longer needs its person once the question is answered')
  assert.equal(answered.board.intents.find((one) => one.id === a.card.id)?.state, 'claimed', 'and the card is still its Seat’s')
  assert.equal((await execution(a.d, a.run.id)).state, 'running')
})

test('an answer is refused, the question kept and the run left stopped, while the Seat is inside a turn', E2E, async (t) => {
  const a = await stoppedOnAQuestion(t)
  // A turn under way in the Seat's conversation — the stopped one still ending, or one begun since.
  await a.session.send([{ type: 'text', text: 'Still here?' }])
  await assert.rejects(answerIt(a), /inside a turn now/)
  assert.ok(hasQuestion(a), 'the question is kept, to be answered once that turn ends')
  const run = await execution(a.d, a.run.id)
  assert.equal(run.state, 'stalled', 'the run stays stopped for its person')
  assert.match(run.reason ?? '', /asked a question nobody can answer/)
  // Once that turn ends, the same answer is heard.
  a.session.finish()
  await answerIt(a)
  assert.equal((await execution(a.d, a.run.id)).state, 'running')
  assert.match(a.sent.at(-1)!, /Their answer: main/)
})

test('an answer is refused, the question kept, when the Seat that asked it has been released', E2E, async (t) => {
  const a = await stoppedOnAQuestion(t)
  const seat = (await goal(a)).members.find((one) => one.session.sessionId === a.card.claim!.sessionId)!
  await a.d.host.call('goal/release', { goal: a.run.goal as never, seat: seat.id })
  await assert.rejects(answerIt(a), /closed, so it cannot be handed your answer/)
  assert.ok(hasQuestion(a), 'the question is kept')
  assert.equal((await execution(a.d, a.run.id)).state, 'stalled', 'the run stays stopped for its person')
})

test('a question answered in time goes into the turn that asked it, and nothing is handed over', E2E, async (t) => {
  const timers = manualTimers()
  const d = await desk(t, undefined, { questionTimers: timers })
  const run = await start(d, FLOW, TASK)
  const [card] = await claimed(d, run.goal, 'fixer', 1)
  const session = d.runtimes.find((one) => one.info.id === card!.claim!.runtime)!.sessions.get(card!.claim!.sessionId)!
  const answered = session.askQuestion('qu-live' as never, 'Which base branch?', [{ id: 'opt-main', label: 'main' }])
  await whenChanged(d, () => (timers.live.size === 1 ? true : null), 'the question’s deadline set')
  await d.host.call('approval/respond', {
    runtime: card!.claim!.runtime as never, sessionId: card!.claim!.sessionId as never, approvalId: 'qu-live' as never,
    decision: { type: 'answers', answers: { q: ['opt-main'] } },
  })
  assert.deepEqual(await answered, { type: 'answers', answers: { q: ['opt-main'] } }, 'the agent’s own question is answered, in its own turn')
  assert.equal(timers.live.size, 0, 'the deadline is cleared')
  const now = await execution(d, run.id)
  assert.equal(now.state, 'running')
  assert.equal(now.operations.some((one) => one.key.includes(':answer:')), false, 'no answer is handed over in a turn of its own')
})

test('an answer no run is waiting for any more is refused, never sent into the turn that is over', E2E, async (t) => {
  const a = await stoppedOnAQuestion(t)
  await a.d.host.flowsPlane.stopRun(a.run.id)
  assert.equal((await execution(a.d, a.run.id)).state, 'stopped')
  await assert.rejects(answerIt(a), /no longer waiting on the answer/)
  assert.deepEqual(a.session.decisions, [], 'nothing reached the agent’s own request')
  // Dismissing it is still the person's to do.
  await a.d.host.call('approval/respond', {
    runtime: a.card.claim!.runtime as never, sessionId: a.card.claim!.sessionId as never, approvalId: 'qu-base' as never, decision: { type: 'cancel' },
  })
  assert.equal(hasQuestion(a), false)
})
