import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ApprovalDecision, FlowExecution, GoalView, Intent, TriggerHistoryPage, WireNotification } from '@harnessdesk/protocol'

import { QUESTION_STOP } from '../src/findings/rounds.js'
import type { QuestionTimers } from '../src/host.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import type { FakeSession } from './fixtures/fake-runtime.js'
import { claimed, desk, E2E, execution, start, TASK, whenChanged } from './fixtures/flow-host-evidence.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'
import { commitTriggers, intakeDesk, until, type IntakeDesk } from './fixtures/intake-host.js'

/*
 * A Seat's question.
 *
 * On a run a person started, nothing times it: the Seat waits for their
 * answer. On a run a trigger started, nobody is here, so the question waits
 * only as long as this machine says; then its run stops for a person and its
 * turn ends. A person who answers it after that, on the room's own question
 * card, has still answered it — the Seat is handed the answer in a turn of its
 * own and carries on, and the run goes with it. The Goal's activity, which the
 * header reads, reads the same as its board all the way through.
 */

/** The question wait's timers, fired when the test says rather than when the machine's wait runs out. */
const manualTimers = (): QuestionTimers & { readonly live: Map<number, { fire: () => void; ms: number }>; fireAll(): void } => {
  const live = new Map<number, { fire: () => void; ms: number }>()
  let next = 0
  return {
    live,
    setTimer: (fire, ms) => { next += 1; live.set(next, { fire, ms }); return next },
    clearTimer: (timer) => { live.delete(timer as number) },
    fireAll() {
      const due = [...live.values()]
      live.clear()
      for (const one of due) one.fire()
    },
  }
}

const OPTIONS = [{ id: 'opt-main', label: 'main' }, { id: 'opt-next', label: 'next' }] as const
const ANSWER: ApprovalDecision = { type: 'answers', answers: { q: ['opt-main'] } }

// ---------------------------------------------------------------- a person's run

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

test('on a run a person started, a Seat’s question has no deadline: it waits for the answer, which goes into its own turn', E2E, async (t) => {
  const timers = manualTimers()
  const d = await desk(t, undefined, { questionTimers: timers })
  const run = await start(d, FLOW, TASK)
  const [card] = await claimed(d, run.goal, 'fixer', 1)
  const session = d.runtimes.find((one) => one.info.id === card!.claim!.runtime)!.sessions.get(card!.claim!.sessionId)!
  const answered = session.askQuestion('qu-live' as never, 'Which base branch?', OPTIONS)
  await whenChanged(d, () => d.host.registry.hasApproval(card!.claim!.runtime as never, card!.claim!.sessionId as never, 'qu-live' as never) ? true : null, 'the question on the desk')
  assert.equal(timers.live.size, 0, 'no wait is set on a question a person is here to answer')
  await d.host.call('approval/respond', {
    runtime: card!.claim!.runtime as never, sessionId: card!.claim!.sessionId as never, approvalId: 'qu-live' as never, decision: ANSWER,
  })
  assert.deepEqual(await answered, ANSWER, 'the agent’s own question is answered, in its own turn')
  const now = await execution(d, run.id)
  assert.equal(now.state, 'running')
  assert.equal(now.operations.some((one) => one.key.includes(':answer:')), false, 'no answer is handed over in a turn of its own')
})

// ---------------------------------------------------------------- a trigger's run

const TRIAGE = `- id: triage
  on: issue
  events: [labelled]
  label: ready
  opens: { flow: review-pr }
`

interface Asking {
  readonly d: IntakeDesk
  readonly timers: ReturnType<typeof manualTimers>
  readonly run: FlowExecution
  readonly card: { readonly id: number; readonly session: string }
  readonly session: FakeSession
  /** Every message the Seat was sent, in order. */
  readonly sent: string[]
  /** Every denial the Team was told of, by conversation. */
  readonly denials: string[]
}

const claimedCards = async (d: IntakeDesk, goal: string): Promise<readonly { id: number; session: string }[]> => {
  const view = await d.host.call('goal/read', { goal }) as GoalView
  return view.board.intents.filter((one: Intent) => one.state === 'claimed' && one.claim).map((one) => ({ id: one.id, session: one.claim!.sessionId }))
}

/** A trigger's run whose one Seat asked a question nobody answered in time: its run stopped, its turn interrupted. */
const stoppedOnAQuestion = async (t: { after(fn: () => Promise<void>): void }): Promise<Asking> => {
  const timers = manualTimers()
  const repo = await makeRepo('hd-flow-question-')
  await commitTriggers(repo, TRIAGE)
  const d = await intakeDesk({ repo, questionTimers: timers })
  t.after(() => d.stop())
  const sent: string[] = []
  d.runtime.onSend = (_session, text) => { sent.push(text) }
  const denials: string[] = []
  const team = d.host.teamPlane
  const noted = team.noteDenial.bind(team)
  team.noteDenial = (runtime, sessionId) => { denials.push(sessionId); noted(runtime, sessionId) }
  const root = repo.dir
  const preview = await d.host.call('trigger/preview', { root, id: 'triage' })
  await d.host.call('trigger/arm', { root, id: 'triage', token: preview.token! })
  const at = d.clocks.wall + 1000
  d.forge.issues.push({ number: 21, state: 'open', created: at, updated: at, events: [{ id: 21, event: 'labeled', created: at, label: 'ready' }], comments: [] })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const goal = await until(async () => {
    const found = (await d.host.call('goal/list', {}) as readonly GoalView[]).filter((view) => view.goal.origin.kind === 'trigger')
    return found.length === 1 ? found[0]!.goal.id : null
  }, 'the trigger Goal')
  const running = (): readonly string[] => d.host.registry.all().filter((record) => record.running.size > 0).map((record) => String(record.session.id))
  const [card] = await until(async () => { const cards = await claimedCards(d, goal); return cards.length === 1 && running().length === 1 ? cards : null }, 'its Seat at work')
  const history = await d.host.call('trigger/history', { root, id: 'triage' }) as TriggerHistoryPage
  const runId = history.items.find((one) => one.goal === goal && one.run)!.run!
  const session = d.runtime.sessions.get(card!.session)!
  void session.askQuestion('qu-base' as never, 'Which base branch should the fix go on?', OPTIONS)
  const [timer] = await until(() => (timers.live.size === 1 ? [...timers.live.values()] : null), 'the question’s wait set')
  assert.equal(timer!.ms, 5 * 60_000, 'this machine’s default wait: five minutes')
  timers.fireAll()
  const stalled = await until(async () => {
    const now = await d.host.call('flow/execution', { run: runId }) as FlowExecution
    return now.state === 'stalled' ? now : null
  }, 'the run stopped for the unanswered question')
  assert.match(stalled.reason ?? '', /asked a question nobody can answer/)
  assert.equal(session.busy, false, 'the Seat’s turn was interrupted')
  return { d, timers, run: stalled, card: card!, session, sent, denials }
}

const hasQuestion = (a: Asking): boolean =>
  a.d.host.registry.hasApproval(a.d.runtime.info.id, a.card.session as never, 'qu-base' as never)

const answerIt = (a: Asking, decision: ApprovalDecision = ANSWER): Promise<unknown> =>
  a.d.host.call('approval/respond', { runtime: a.d.runtime.info.id, sessionId: a.card.session as never, approvalId: 'qu-base' as never, decision })

const runOf = async (a: Asking): Promise<FlowExecution> => await a.d.host.call('flow/execution', { run: a.run.id }) as FlowExecution
const goalOf = async (a: Asking): Promise<GoalView> => await a.d.host.call('goal/read', { goal: a.run.goal }) as GoalView

const resolutions = (pushed: readonly WireNotification[]): unknown[] => pushed.flatMap((one) => {
  if (one.method !== 'event') return []
  const event = (one.params as { event: { type: string; approvalId?: string; resolution?: unknown } }).event
  return event.type === 'approval/resolved' && event.approvalId === 'qu-base' ? [event.resolution] : []
})

test('an answered question resumes the trigger’s Seat that asked it, and the run goes on to its end', E2E, async (t) => {
  const a = await stoppedOnAQuestion(t)
  assert.ok(hasQuestion(a), 'the question is still on the desk for a person to answer')
  const before = a.sent.length

  await answerIt(a)

  // Durable before the answer is acknowledged: the run is running again by the time the call returns.
  const resumed = await runOf(a)
  assert.equal(resumed.state, 'running', `the run goes on: ${resumed.reason}`)
  assert.equal(resumed.reason, null)
  assert.ok(resumed.operations.some((one) => one.kind === 'turn' && one.card === a.card.id && one.key.includes(':answer:') && one.state === 'finished'),
    'the answer’s hand-over is journaled')
  assert.equal(a.session.busy, true, 'the Seat is back inside a turn')
  assert.equal(a.sent.length, before + 1, 'one turn, carrying the answer')
  const handed = a.sent.at(-1)!
  assert.match(handed, /Which base branch should the fix go on\?/)
  assert.match(handed, /Their answer: main/)
  assert.doesNotMatch(handed, /\bnext\b/, 'the answer the person chose, not the other option')
  assert.match(handed, new RegExp(`Card #${a.card.id} on this Goal is yours`), 'and its own card, again')
  assert.equal(hasQuestion(a), false, 'the question is withdrawn once it is answered')
  assert.deepEqual(a.session.decisions, [{ type: 'cancel' }], 'the stopped turn’s outstanding request is closed, never answered in it')
  // Answered, not refused: every window reads it so, and nothing holds the Seat's mail in the turn that carries the answer.
  assert.deepEqual(resolutions(a.d.pushed), [{ outcome: 'decided', decision: ANSWER }])
  assert.deepEqual(a.denials, [], 'closing the stopped request is not a denial')

  // The same answer again — a second press — is the same answer, delivered once.
  await answerIt(a)
  assert.equal(a.sent.length, before + 1, 'not handed over twice')

  // The Seat finishes its card; the run reaches its end.
  const said = await a.d.host.teamPlane.complete(a.card.id, { outcome: 'approve' }, { runtime: a.d.runtime.info.id, sessionId: a.card.session })
  assert.doesNotMatch(said, /^Refused/, said)
  a.session.finish()
  await until(async () => ((await runOf(a)).state === 'settled' ? true : null), 'the run at its end')
})

test('while a run is stopped on its Seat’s question, the Goal reads Needs you; once answered, it reads working', E2E, async (t) => {
  const a = await stoppedOnAQuestion(t)
  assert.equal((await goalOf(a)).activity, 'needs-you', 'the Goal, as the header reads it, needs its person')
  await answerIt(a)
  const answered = await goalOf(a)
  assert.equal(answered.activity, 'working', 'the Goal no longer needs its person once the question is answered')
  assert.equal(answered.board.intents.find((one) => one.id === a.card.id)?.state, 'claimed', 'and the card is still its Seat’s')
})

test('an answer is refused, the question kept and the run left stopped, while the Seat is inside a turn', E2E, async (t) => {
  const a = await stoppedOnAQuestion(t)
  await a.session.send([{ type: 'text', text: 'Still here?' }])
  await assert.rejects(answerIt(a), /inside a turn now/)
  assert.ok(hasQuestion(a), 'the question is kept, to be answered once that turn ends')
  const run = await runOf(a)
  assert.equal(run.state, 'stalled', 'the run stays stopped for its person')
  assert.match(run.reason ?? '', /asked a question nobody can answer/)
  // Once that turn ends, the same answer is heard.
  a.session.finish()
  await answerIt(a)
  assert.equal((await runOf(a)).state, 'running')
  assert.match(a.sent.at(-1)!, /Their answer: main/)
})

test('an answer is refused, the question kept, when the Seat that asked it has been released', E2E, async (t) => {
  const a = await stoppedOnAQuestion(t)
  const seat = (await goalOf(a)).members.find((one) => one.session.sessionId === a.card.session)!
  await a.d.host.call('goal/release', { goal: a.run.goal as never, seat: seat.id })
  await assert.rejects(answerIt(a), /closed, so it cannot be handed your answer/)
  assert.ok(hasQuestion(a), 'the question is kept')
  assert.equal((await runOf(a)).state, 'stalled', 'the run stays stopped for its person')
})

test('an answer no run is waiting for any more is refused, never sent into the turn that is over', E2E, async (t) => {
  const a = await stoppedOnAQuestion(t)
  await a.d.host.flowsPlane.stopRun(a.run.id)
  assert.equal((await runOf(a)).state, 'stopped')
  await assert.rejects(answerIt(a), /no longer waiting on the answer/)
  assert.deepEqual(a.session.decisions, [], 'nothing reached the agent’s own request')
  // Dismissing it is still the person's to do.
  await answerIt(a, { type: 'cancel' })
  assert.equal(hasQuestion(a), false)
})

test('this machine’s wait is the one set: until a person is back sets no deadline at all', E2E, async (t) => {
  const timers = manualTimers()
  const repo = await makeRepo('hd-flow-question-wait-')
  await commitTriggers(repo, TRIAGE)
  const d = await intakeDesk({ repo, questionTimers: timers })
  t.after(() => d.stop())
  await d.host.call('app/state/set', { patch: { unattendedQuestionWait: 'back' } })
  const root = repo.dir
  const preview = await d.host.call('trigger/preview', { root, id: 'triage' })
  await d.host.call('trigger/arm', { root, id: 'triage', token: preview.token! })
  const at = d.clocks.wall + 1000
  d.forge.issues.push({ number: 22, state: 'open', created: at, updated: at, events: [{ id: 22, event: 'labeled', created: at, label: 'ready' }], comments: [] })
  d.clocks.advance(60_000)
  await d.host.intakePlane.tick()
  const session = await until(() => d.host.registry.all().find((record) => record.running.size > 0), 'its Seat at work')
  const fake = d.runtime.sessions.get(String(session.session.id))!
  void fake.askQuestion('qu-wait' as never, 'Which base branch?', OPTIONS)
  await until(() => (d.host.registry.hasApproval(d.runtime.info.id, session.session.id, 'qu-wait' as never) ? true : null), 'the question on the desk')
  assert.equal(timers.live.size, 0, 'no deadline: the question waits for a person')
})

// ---------------------------------------------------------------- the engine

const ONE_STAGE = `
version: 2
name: One fixer
roles:
  fixer: { kind: agent, uses: fixer }
seed: { role: fixer, title: Fix it }
rules: []
`

/** A trigger's run in the engine rig, stopped on its Seat's question. */
const engineStopped = async (t: Parameters<typeof goalRig>[0]) => {
  const rig = await goalRig(t)
  const run = await rig.startTriggered(ONE_STAGE, [agent('fixer', ['done'])])
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  const seat = [...rig.seats.values()].find((one) => one.board === run.goal)!
  const { runtime, sessionId } = seat.session
  assert.equal(await rig.flows.stopForQuestion(runtime, sessionId, QUESTION_STOP), true)
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stalled')
  const settled: string[] = []
  const settle = async (): Promise<void> => { settled.push('settled'); rig.events.push('settle') }
  const words = { question: 'Which base branch?', answer: 'main' }
  return { rig, run, seat, runtime, sessionId, settled, settle, words }
}

test('the old question is settled before the turn that carries its answer is sent, never after', async (t) => {
  const e = await engineStopped(t)
  assert.equal(await e.rig.flows.answerQuestion(e.runtime, e.sessionId, e.words, e.settle), true)
  const settleAt = e.rig.events.lastIndexOf('settle')
  const orderAt = e.rig.events.lastIndexOf(`order:${e.seat.id}`)
  assert.ok(settleAt !== -1 && settleAt < orderAt, `settled before the order: ${e.rig.events.slice(-4).join(', ')}`)
  assert.match(e.rig.orderTexts.get(String(e.seat.id))!.at(-1)!, /Their answer: main/)
  assert.equal(e.rig.flows.executionsFor(e.run.goal)[0]!.state, 'running')
})

test('an answer re-checks a trigger’s consent and spend right before the hand-back, not only before reopening its Seat (#939)', async (t) => {
  for (const [gate, stays] of [
    [{ reason: 'The desk is paused.', transient: true as const }, /asked a question nobody can answer/],
    ['Today’s trigger spend cap was reached while its Seat was being reopened.', /^Today’s trigger spend cap was reached/],
  ] as const) {
    const e = await engineStopped(t)
    const orders = e.rig.orderTexts.get(String(e.seat.id))?.length ?? 0
    // Spend was fine when the answer arrived; it runs out only while the Seat is being reopened.
    e.rig.onReseat = () => { e.rig.triggerGate = () => gate }
    await assert.rejects(e.rig.flows.answerQuestion(e.runtime, e.sessionId, e.words, e.settle), /Your answer was not sent/)
    const [run] = e.rig.flows.executionsFor(e.run.goal)
    assert.equal(run!.state, 'stalled')
    assert.match(run!.reason ?? '', stays)
    assert.deepEqual(e.settled, [], 'the question is not closed: a refused answer keeps it')
    assert.equal(e.rig.orderTexts.get(String(e.seat.id))?.length ?? 0, orders, 'never handed back on spend that went stale while its Seat reopened')
  }
})

test('the question answered in its own turn after all puts the run it stopped back to running', async (t) => {
  const e = await engineStopped(t)
  await e.rig.flows.answeredInTurn(e.runtime, e.sessionId)
  const [run] = e.rig.flows.executionsFor(e.run.goal)
  assert.equal(run!.state, 'running')
  assert.equal(run!.reason, null)
})
