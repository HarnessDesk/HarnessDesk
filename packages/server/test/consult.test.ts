import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GoalView, Intent, SessionSummary, WireNotification } from '@harnessdesk/protocol'

import { CONSULT_CLOSED_REFUSAL, CONSULT_PROMPT } from '../src/consult.js'
import { executionOf } from '../src/flow-recovery.js'
import { GoalStore } from '../src/goals/store.js'
import type { QuestionTimers } from '../src/host.js'
import type { UsageSample } from '../src/ledger/insight.js'
import { claimed, desk, E2E, execution, start, TASK, whenChanged, type Desk } from './fixtures/flow-host-evidence.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { HoldFake, type HoldSession } from './fixtures/hold-runtime.js'
import { commitTriggers, intakeDesk, until } from './fixtures/intake-host.js'

/*
 * `ask_agent` on a real desk: a Flow seat whose role says `ask:` puts one
 * question to another agent. The desk opens that agent hidden, ephemeral
 * and held read-only in the caller's checkout, takes its one answer, and
 * discards it. Nothing of the consult reaches a window, the sidebar or
 * search; its approvals are declined, never asked of a person.
 *
 * The rules in order are `consult-plane.test.ts`; this file is the host's
 * half — the conversation itself.
 */

const FLOW = (ask: string): string => `version: 2
name: "Ask, then fix"
description: "One fixer, who may ask another agent one question."
inputs:
  task:
    label: "Task"
roles:
  fixer:
    kind: agent
    uses: [implementer]
    grant: edit
    independentOf: []${ask}
seed: { role: fixer, title: "{{task}}" }
rules: []
messaging: board-only
`
const ASKS = FLOW('\n    ask: { seats: [holdfake], times: 1, timeoutSeconds: 30 }')

const manualTimers = (): QuestionTimers & { readonly live: Map<number, { fire: () => void; ms: number }> } => {
  const live = new Map<number, { fire: () => void; ms: number }>()
  let next = 0
  return {
    live,
    setTimer: (fire, ms) => { next += 1; live.set(next, { fire, ms }); return next },
    clearTimer: (timer) => { live.delete(timer as number) },
  }
}

interface Asking {
  readonly d: Desk
  readonly holds: HoldFake
  readonly timers: ReturnType<typeof manualTimers>
  readonly caller: { readonly runtime: string; readonly sessionId: string }
  readonly run: string
  readonly seen: WireNotification[]
  /** Further runtimes the seat may ask, by id. */
  readonly others: Record<string, HoldFake>
}

/** A desk with a running fixer seat that may (or may not) ask `holdfake`, and a window listening to everything. */
const asking = async (t: TestContext, source = ASKS, options: { readonly kept?: number; readonly also?: readonly string[] } = {}): Promise<Asking> => {
  const timers = manualTimers()
  const d = await desk(t, undefined, { consultTimers: timers, ...(options.kept !== undefined ? { consultsRetiredKept: options.kept } : {}) })
  const holds = new HoldFake('holdfake')
  d.host.register(holds)
  await holds.start()
  const others: Record<string, HoldFake> = {}
  for (const id of options.also ?? []) {
    others[id] = new HoldFake(id)
    d.host.register(others[id])
    await others[id].start()
  }
  const run = await start(d, source, TASK)
  const [card] = await claimed(d, run.goal, 'fixer', 1)
  const seen: WireNotification[] = []
  t.after(d.host.addBroadcaster((notification) => { seen.push(notification) }))
  return { d, holds, timers, caller: { runtime: card!.claim!.runtime, sessionId: card!.claim!.sessionId }, run: run.id, seen, others }
}

const answerWith = (holds: HoldFake, text: string): void => {
  holds.onSend = (session) => { setImmediate(() => (session as HoldSession).finish(text)) }
}

const code = (expected: string) => (error: unknown): boolean => (error as { wireCode?: string }).wireCode === expected

/** Whether any notification a window received names this conversation. */
const mentions = (seen: readonly WireNotification[], runtime: string, sessionId: string): WireNotification[] =>
  seen.filter((notification) => JSON.stringify(notification).includes(`"${sessionId}"`) && JSON.stringify(notification).includes(`"${runtime}"`))

interface SeatLine {
  readonly type: string
  readonly record?: { readonly id: string; readonly session: { readonly sessionId: string }; readonly checkout: { readonly project: string } }
  readonly consult?: { readonly seat: string; readonly runtime: string; readonly sessionId: string; readonly openedAt: number; readonly closedAt: number | null }
}

/** Every line of every project's Seat file under the desk's state. */
const seatLines = async (dir: string): Promise<SeatLine[]> => {
  const out: SeatLine[] = []
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name === 'seats.ndjson') out.push(...(await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as SeatLine))
    }
  }
  await walk(dir)
  return out
}

test('a seat whose role may ask gets one answer from a hidden, read-only, ephemeral consult in its own checkout', E2E, async (t) => {
  const a = await asking(t)
  answerWith(a.holds, '4')
  const listed: SessionSummary[] = []
  let linkedBeforeQuestion: (number | null)[] = []
  // A window that lists conversations while the consult is open never sees it.
  a.holds.onSend = (session) => {
    void (async () => {
      const page = await a.d.host.call('session/list', { runtime: 'holdfake' as never }) as { data: SessionSummary[] }
      listed.push(...page.data)
      // Whose consult this is was on disk before the question reached it: a crash now still attributes the work.
      linkedBeforeQuestion = (await seatLines(a.d.stateDir)).filter((line) => line.type === 'seat-consult').map((line) => line.consult!.closedAt)
      ;(session as HoldSession).finish('4')
    })()
  }
  const answer = await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'What is 2+2?', context: null }, a.caller)
  assert.deepEqual(answer, { text: '4', agentName: 'Hold Fake', truncated: false })

  const [options] = a.holds.createOptions
  assert.equal(options!.requestedCeiling, 'read', 'opened asking for the read ceiling')
  assert.equal(options!.ephemeral, true, 'opened ephemeral')
  assert.deepEqual(options!.withheldTools, ['ask_agent'], 'a consult is never offered ask_agent')
  const callerRecord = a.d.host.registry.get(a.caller.runtime as never, a.caller.sessionId as never)!
  assert.equal(options!.cwd, callerRecord.shellCheckout?.cwd ?? callerRecord.session.cwd, 'in the caller’s checkout')
  const consult = a.holds.held[0]!
  assert.equal(consult.sandbox, 'read-only', 'held at read, read back')

  assert.equal(a.d.host.registry.get('holdfake' as never, consult.id), undefined, 'discarded once it answered')
  assert.deepEqual(mentions(a.seen, 'holdfake', String(consult.id)), [], 'no window heard anything of the consult')
  assert.equal(listed.some((row) => row.id === consult.id), false, 'session/list never lists it')

  // Whose the consult was is written beside the caller's Seat, so Insight folds what it spent into that Seat.
  const lines = await seatLines(a.d.stateDir)
  const callerSeat = lines.find((line) => line.type === 'seat' && line.record?.session.sessionId === a.caller.sessionId)?.record?.id
  assert.deepEqual(linkedBeforeQuestion, [null], 'the opening link was written before the question was sent, and not yet closed')
  assert.deepEqual(lines.filter((line) => line.type === 'seat-consult').map((line) => [line.consult?.seat, line.consult?.runtime, line.consult?.sessionId, line.consult?.closedAt === null]),
    [[callerSeat, 'holdfake', String(consult.id), true], [callerSeat, 'holdfake', String(consult.id), false]], 'its opening, then its closing')

  const audit = await a.d.host.call('audit/query', {}) as readonly { kind: string; agent?: string; outcome?: string; bytesOut?: number }[]
  const line = audit.find((entry) => entry.kind === 'consult')
  assert.deepEqual({ agent: line?.agent, outcome: line?.outcome, bytesOut: line?.bytesOut }, { agent: 'holdfake', outcome: 'answered', bytesOut: 1 })
})

test('times: the second ask on the run is askSpent, and the count is on the run’s own record', E2E, async (t) => {
  const a = await asking(t)
  answerWith(a.holds, '4')
  await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'One?', context: null }, a.caller)
  await assert.rejects(a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'Two?', context: null }, a.caller), code('askSpent'))
  assert.equal(a.holds.createOptions.length, 1, 'the refused ask opened nothing')
  const run = await execution(a.d, a.run)
  assert.deepEqual(Object.values(run.asks ?? {}), [1], 'the run says the seat spent its one ask')
  // A restarted desk reads the count back from disk, so a restart cannot refill it.
  const stored = await storedRun(a.d.stateDir, a.run)
  assert.deepEqual(Object.values(executionOf(stored).asks ?? {}), [1])
  assert.throws(() => executionOf({ ...(stored as object), asks: { seat: -1 } }), /unreadable ask count/)
})

test('the gate: a role without ask is refused and is not offered the tool; the allowed seat is; a consult is not', E2E, async (t) => {
  const a = await asking(t, FLOW(''))
  await assert.rejects(a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller), code('askNotAllowed'))
  assert.deepEqual(a.d.host.withheldTools(a.caller), ['ask_agent'])
  assert.deepEqual(a.d.host.withheldTools(undefined), ['ask_agent'], 'an unknown caller is not offered it')
  assert.equal(a.holds.createOptions.length, 0)
})

test('the gate, allowed: the seat is offered ask_agent; another agent is refused by name; the consult itself is refused at depth', E2E, async (t) => {
  const a = await asking(t)
  assert.deepEqual(a.d.host.withheldTools(a.caller), [], 'the seat whose role may ask is offered the tool')
  await assert.rejects(a.d.host.consultPlane.ask({ agent: 'fake', question: 'q', context: null }, a.caller),
    (error: Error) => code('askNotAllowed')(error) && /may ask only: holdfake \(Hold Fake\)/.test(error.message))
  let depth: unknown = null
  let withheld: readonly string[] | null = null
  a.holds.onSend = (session) => {
    void (async () => {
      withheld = a.d.host.withheldTools({ runtime: 'holdfake', sessionId: String(session.id) })
      depth = await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'and you?', context: null }, { runtime: 'holdfake', sessionId: String(session.id) })
        .catch((error: unknown) => error)
      ;(session as HoldSession).finish('4')
    })()
  }
  await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller)
  assert.ok(code('askDepth')(depth), 'an agent asked cannot ask another')
  assert.deepEqual(withheld, ['ask_agent'], 'and is not offered the tool')
})

test('the desk holds a consult at read for its whole life: a desk tool that edits is refused, a read is not', E2E, async (t) => {
  const a = await asking(t)
  const admissions: { tool: string; admitted: boolean }[] = []
  a.holds.onSend = (session) => {
    void (async () => {
      const scope = { runtime: 'holdfake' as never, sessionId: session.id }
      for (const [tool, needs] of [['run_tests', 'edit'], ['board_read', 'read']] as const) {
        const { admitted } = await a.d.host.ceilingGate.admit({ startedAt: Date.now(), tool, args: undefined, needs, scope, quiet: true })
        admissions.push({ tool, admitted })
      }
      ;(session as HoldSession).finish('4')
    })()
  }
  await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller)
  assert.deepEqual(admissions, [{ tool: 'run_tests', admitted: false }, { tool: 'board_read', admitted: true }])
})

test('a runtime that does not hold the read ceiling is refused, and its conversation is discarded', E2E, async (t) => {
  const a = await asking(t)
  a.holds.habit = 'settlesElsewhere'
  await assert.rejects(a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller), code('askNoReadCeiling'))
  const opened = a.holds.held[0]!
  assert.equal(a.d.host.registry.get('holdfake' as never, opened.id), undefined, 'the registry no longer holds it')
  assert.deepEqual(mentions(a.seen, 'holdfake', String(opened.id)), [])
})

test('sizes: a 17 KiB question is refused and nothing opens', E2E, async (t) => {
  const a = await asking(t)
  await assert.rejects(a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'x'.repeat(17 * 1024), context: null }, a.caller), code('askTooLarge'))
  assert.equal(a.holds.createOptions.length, 0)
})

test('the timeout: an agent that never answers is askTimeout after the role’s 30 seconds, and is discarded', E2E, async (t) => {
  const a = await asking(t)
  let sent = false
  a.holds.onSend = () => { sent = true }
  const pending = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller)
  await whenChanged(a.d, () => (sent ? true : null), 'the consult asked')
  const timers = [...a.timers.live.values()]
  assert.deepEqual(timers.map((one) => one.ms), [30_000])
  timers[0]!.fire()
  await assert.rejects(pending, code('askTimeout'))
  assert.equal(a.d.host.registry.get('holdfake' as never, a.holds.held[0]!.id), undefined)
})

test('the deadline bounds the open: the timer fires while the agent is still opening — askTimeout then, and the late conversation is discarded unseen', E2E, async (t) => {
  const a = await asking(t)
  let open!: () => void
  a.holds.createGate = new Promise<void>((resolve) => { open = resolve })
  let sent = false
  a.holds.onSend = () => { sent = true }
  const pending = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller)
  await whenChanged(a.d, () => (a.holds.createOptions.length > 0 ? true : null), 'the consult is opening')
  const timers = [...a.timers.live.values()]
  assert.deepEqual(timers.map((one) => one.ms), [30_000])
  timers[0]!.fire()
  await assert.rejects(pending, code('askTimeout'))
  assert.equal(a.holds.held.length, 0, 'the ask ended while the agent was still opening')
  open()
  await whenChanged(a.d, () => (a.holds.held.length === 1 ? true : null), 'the late conversation came back')
  const late = a.holds.held[0]!
  await whenChanged(a.d, () => (a.d.host.registry.get('holdfake' as never, late.id) === undefined ? true : null), 'the late conversation is discarded')
  assert.equal(sent, false, 'it was never asked')
  assert.deepEqual(mentions(a.seen, 'holdfake', String(late.id)), [], 'no window heard of it')
})

test('a consult’s children are held at its read ceiling, registered or not, however deep, and nothing of it runs once it has answered', E2E, async (t) => {
  const a = await asking(t)
  const admit = (sessionId: string, tool: string, needs: 'read' | 'edit') => a.d.host.ceilingGate.admit({
    startedAt: Date.now(), tool, args: undefined, needs, scope: { runtime: 'holdfake' as never, sessionId: sessionId as never }, quiet: true,
  })
  const spawn = (parent: string, child: string): void => a.holds.emit({
    type: 'item/completed', sessionId: parent as never, turnId: 'consult-turn' as never,
    item: { id: `spawn-${child}` as never, type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: child }] },
  })
  let child = ''
  const during: Record<string, boolean> = {}
  a.holds.onSend = (session) => {
    void (async () => {
      // A child the runtime opens as a conversation of its own: the desk's registry knows it.
      child = String((await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })).id)
      assert.ok(a.d.host.registry.get('holdfake' as never, child as never), 'the child is a registered conversation')
      spawn(String(session.id), child)
      spawn(child, 'grandchild-1')
      during['child edits'] = (await admit(child, 'run_tests', 'edit')).admitted
      during['grandchild edits'] = (await admit('grandchild-1', 'run_tests', 'edit')).admitted
      during['child reads'] = (await admit(child, 'board_read', 'read')).admitted
      ;(session as HoldSession).finish('4')
    })()
  }
  await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller)
  assert.deepEqual(during, { 'child edits': false, 'grandchild edits': false, 'child reads': true })
  // Answered: nothing of it — the consult, its registered child, its nested one — is admitted, not even a read,
  // and the refusal is the durable one, not a bounded cache that a busy desk evicts.
  const consult = String(a.holds.held[0]!.id)
  for (const id of [consult, child, 'grandchild-1']) {
    assert.deepEqual(await admit(id, 'board_read', 'read'), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL }, id)
  }
})

test('a timed-out open lets the runtime’s other conversations through one cleanup bound after the deadline, and the late consult is still discarded', E2E, async (t) => {
  const a = await asking(t)
  let open!: () => void
  a.holds.createGate = new Promise<void>((resolve) => { open = resolve })
  const pending = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller)
  await whenChanged(a.d, () => (a.holds.createOptions.length > 0 ? true : null), 'the consult is opening')
  const [deadline] = [...a.timers.live.values()]
  deadline!.fire()
  await assert.rejects(pending, code('askTimeout'))
  // An ordinary conversation on the same runtime starts while the consult is still stuck opening.
  a.holds.createGate = null
  const other = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
  assert.deepEqual(mentions(a.seen, 'holdfake', String(other.id)), [], 'held while the consult opens, within the bound')
  const bound = [...a.timers.live.values()].filter((one) => one.ms === 10_000)
  assert.equal(bound.length, 1, 'the hold is bounded at the deadline')
  bound[0]!.fire()
  await whenChanged(a.d, () => (mentions(a.seen, 'holdfake', String(other.id)).length > 0 ? true : null), 'the other conversation reaches the window')
  open()
  await whenChanged(a.d, () => (a.holds.held.length === 2 ? true : null), 'the late consult came back')
  const late = a.holds.held.find((one) => one.id !== other.id)!
  await whenChanged(a.d, () => (a.d.host.registry.get('holdfake' as never, late.id) === undefined ? true : null), 'the late consult is discarded')
})

const admitRead = (a: Asking, runtime: string, sessionId: string) => a.d.host.ceilingGate.admit({
  startedAt: Date.now(), tool: 'board_read', args: undefined, needs: 'read', scope: { runtime: runtime as never, sessionId: sessionId as never }, quiet: true,
})

test('round 3: a consult is closed the moment it answers, before its discard: a discard that never settles leaves nothing of it admissible', E2E, async (t) => {
  const a = await asking(t)
  answerWith(a.holds, '4')
  let deleting = false
  ;(a.holds as { deleteSession: HoldFake['deleteSession'] }).deleteSession = () => { deleting = true; return new Promise(() => {}) }
  const pending = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller)
  await whenChanged(a.d, () => (deleting ? true : null), 'the discard is under way, and never ends')
  const consult = String(a.holds.held[0]!.id)
  assert.deepEqual(await admitRead(a, 'holdfake', consult), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL }, 'refused while the discard hangs')
  for (const one of [...a.timers.live.values()].filter((timer) => timer.ms === 10_000)) one.fire()
  assert.equal((await pending).text, '4', 'the ask still ends at its cleanup bound')
  assert.deepEqual(await admitRead(a, 'holdfake', consult), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL })
})

const ASK_TWICE = (seats: string) => FLOW(`\n    ask: { seats: [${seats}], times: 3, timeoutSeconds: 30 }`)

test('round 3: an id a closed consult once had is a new consult when the runtime hands it out again — admitted while it lives, refused once it ends', E2E, async (t) => {
  const a = await asking(t, ASK_TWICE('holdfake'))
  answerWith(a.holds, '4')
  await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'one', context: null }, a.caller)
  const id = String(a.holds.held[0]!.id)
  assert.deepEqual(await admitRead(a, 'holdfake', id), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL })
  a.holds.reuseId = id
  let during: unknown = null
  a.holds.onSend = (session) => { void admitRead(a, 'holdfake', String(session.id)).then((admission) => { during = admission }) }
  // The desk's session index keeps a deleted id's events out, so this consult is ended by its deadline, not an answer.
  const second = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'two', context: null }, a.caller)
  await whenChanged(a.d, () => during, 'the second consult was asked, and its read was admitted or refused')
  ;[...a.timers.live.values()].find((one) => one.ms === 30_000)!.fire()
  await assert.rejects(second, code('askTimeout'))
  assert.equal(String(a.holds.held[1]!.id), id, 'the runtime handed the same id out again')
  assert.deepEqual(during, { admitted: true }, 'the new consult reads, rather than inheriting the old one’s refusal')
  assert.deepEqual(await admitRead(a, 'holdfake', id), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL }, 'and is refused once it, too, has ended')
})

test('round 3: closed consults retire, and only the oldest beyond the bound is forgotten', E2E, async (t) => {
  const a = await asking(t, ASK_TWICE('holdfake'), { kept: 1 })
  answerWith(a.holds, '4')
  for (const question of ['one', 'two', 'three']) await a.d.host.consultPlane.ask({ agent: 'holdfake', question, context: null }, a.caller)
  const [first, second, third] = a.holds.held.map((one) => String(one.id))
  // Bound at one: the two older consults are forgotten, the last is still refused.
  assert.deepEqual(await admitRead(a, 'holdfake', third!), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL })
  for (const id of [first!, second!]) {
    const admission = await admitRead(a, 'holdfake', id)
    assert.equal(!admission.admitted && admission.refusal === CONSULT_CLOSED_REFUSAL, false, id)
  }
})

test('round 3: each opening holds only its own runtime’s announcements, and only until its own bound — an overlapping opening never extends it', E2E, async (t) => {
  const a = await asking(t, ASK_TWICE('holdfake'))
  let openA!: () => void
  a.holds.createGate = new Promise<void>((resolve) => { openA = resolve })
  const first = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'one', context: null }, a.caller)
  await whenChanged(a.d, () => (a.holds.createOptions.length === 1 ? true : null), 'opening A')
  ;[...a.timers.live.values()].find((one) => one.ms === 30_000)!.fire()
  await assert.rejects(first, code('askTimeout'))
  const boundA = [...a.timers.live.values()].filter((one) => one.ms === 10_000)
  assert.equal(boundA.length, 1)
  a.holds.createGate = null
  const x = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
  assert.deepEqual(mentions(a.seen, 'holdfake', String(x.id)), [], 'X waits on opening A')
  // A second opening on the same runtime starts while A is still within its bound.
  let openB!: () => void
  a.holds.createGate = new Promise<void>((resolve) => { openB = resolve })
  const second = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'two', context: null }, a.caller)
  await whenChanged(a.d, () => (a.holds.createOptions.length === 3 ? true : null), 'opening B')
  a.holds.createGate = null
  const y = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
  boundA[0]!.fire()
  await whenChanged(a.d, () => (mentions(a.seen, 'holdfake', String(x.id)).length > 0 ? true : null), 'X goes out at A’s bound, though B still opens')
  assert.deepEqual(mentions(a.seen, 'holdfake', String(y.id)), [], 'Y, which started while B was opening, still waits on B')
  ;[...a.timers.live.values()].find((one) => one.ms === 30_000)!.fire()
  await assert.rejects(second, code('askTimeout'))
  for (const one of [...a.timers.live.values()].filter((timer) => timer.ms === 10_000)) one.fire()
  await whenChanged(a.d, () => (mentions(a.seen, 'holdfake', String(y.id)).length > 0 ? true : null), 'Y goes out at B’s bound')
  openA()
  openB()
})

test('round 3: an opening on another runtime never holds this one’s announcements', E2E, async (t) => {
  const a = await asking(t, ASK_TWICE('holdfake, holdfake2'), { also: ['holdfake2'] })
  const other = a.others['holdfake2']!
  let open!: () => void
  other.createGate = new Promise<void>((resolve) => { open = resolve })
  const pending = a.d.host.consultPlane.ask({ agent: 'holdfake2', question: 'q', context: null }, a.caller)
  await whenChanged(a.d, () => (other.createOptions.length === 1 ? true : null), 'opening on holdfake2')
  const x = await a.holds.createSession({ cwd: other.createOptions[0]!.cwd })
  await whenChanged(a.d, () => (mentions(a.seen, 'holdfake', String(x.id)).length > 0 ? true : null), 'holdfake’s conversation goes straight out')
  ;[...a.timers.live.values()].find((one) => one.ms === 30_000)!.fire()
  await assert.rejects(pending, code('askTimeout'))
  open()
})

test('approvals inside a consult are declined by the desk, never shown, and the ask still answers', E2E, async (t) => {
  const a = await asking(t)
  let decided: unknown = null
  a.holds.onSend = (session) => {
    void (async () => {
      decided = await (session as HoldSession).askApproval('consult-approval' as never)
      ;(session as HoldSession).finish('4')
    })()
  }
  const answer = await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller)
  assert.equal(answer.text, '4')
  assert.deepEqual(decided, { type: 'option', optionId: 'opt-1' }, 'the deny option was chosen')
  assert.equal(a.seen.some((one) => one.method === 'event' && one.params.event.type === 'approval/requested'), false)
})

test('a run that stops withdraws its open consult: askCancelled, discarded', E2E, async (t) => {
  const a = await asking(t)
  let sent = false
  a.holds.onSend = () => { sent = true }
  const pending = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'q', context: null }, a.caller)
  await whenChanged(a.d, () => (sent ? true : null), 'the consult asked')
  await a.d.host.call('flow/execution/stop', { run: a.run, reason: 'Stopped while asking' })
  await assert.rejects(pending, code('askCancelled'))
  assert.equal(a.d.host.registry.get('holdfake' as never, a.holds.held[0]!.id), undefined)
})

/** The run's own file on disk, as a restarted desk reads it. */
const storedRun = async (dir: string, run: string): Promise<unknown> => {
  const walk = async (at: string): Promise<string[]> => {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => [])
    const found: string[] = []
    for (const entry of entries) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) found.push(...await walk(path))
      else if (entry.name.endsWith('.json')) found.push(path)
    }
    return found
  }
  for (const path of await walk(dir)) {
    const raw = JSON.parse(await readFile(path, 'utf8').catch(() => 'null')) as { id?: unknown; version?: unknown } | null
    if (raw && raw.id === run && raw.version === 2) return raw
  }
  throw new Error(`no stored run ${run} under ${dir}`)
}

/** A trigger Goal whose reviewer Seat may ask `fake` this many times, at work. */
const triggerSeat = async (t: TestContext, times = 1, usage?: () => readonly UsageSample[]): Promise<{ d: Awaited<ReturnType<typeof intakeDesk>>; goal: string; caller: { runtime: string; sessionId: string } }> => {
  const repo = await makeRepo('hd-consult-trigger-')
  await commitTriggers(repo, `- id: triage
  on: issue
  events: [labelled]
  label: ready
  opens: { flow: review-pr }
`)
  await writeFile(join(repo.dir, '.harnessdesk', 'flows', 'review-pr.yml'), `version: 2
name: Review a pull request
roles:
  reviewer: { kind: agent, uses: reviewer, grant: read, ask: { seats: [fake], times: ${times} } }
seed: { role: reviewer, title: Review it }
rules: []
`)
  await repo.git('commit', '-qam', 'ask')
  const d = await intakeDesk({ repo, ...(usage ? { usage } : {}) })
  t.after(() => d.stop())
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
  const card = await until(async () => {
    const view = await d.host.call('goal/read', { goal }) as GoalView
    return view.board.intents.find((one: Intent) => one.state === 'claimed' && one.claim) ?? null
  }, 'its Seat at work')
  return { d, goal, caller: { runtime: card.claim!.runtime, sessionId: card.claim!.sessionId } }
}

/** The consult's meter on the Goal, `${seat}/ask/${n}`. */
const askMeter = (d: Awaited<ReturnType<typeof intakeDesk>>, goal: string, n = 1) =>
  Object.entries(d.host.intakePlane.journal.read().budgets[goal]!.meters).find(([key]) => key.endsWith(`/ask/${n}`))?.[1] ?? null

const USAGE = (usd: number | null) => ({
  total: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 200, outputTokens: 300, reasoningOutputTokens: 0 },
  last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 200, outputTokens: 300, reasoningOutputTokens: 0 },
  ...(usd === null ? {} : { cost: { amount: usd, currency: 'USD' } }),
})

test('on a trigger’s Goal the consult is metered against the caller’s run, as its own window on the caller’s Goal', E2E, async (t) => {
  const { d, goal, caller } = await triggerSeat(t)
  d.runtime.onSend = (session, text) => { if (text.includes(CONSULT_PROMPT)) setImmediate(() => (session as HoldSession).finish('4')) }
  assert.deepEqual(d.host.withheldTools(caller), [], 'the trigger Seat whose role may ask is offered the tool')
  const answer = await d.host.consultPlane.ask({ agent: 'fake', question: 'What is 2+2?', context: null }, caller)
  assert.equal(answer.text, '4')
  const meters = Object.keys(d.host.intakePlane.journal.read().budgets[goal]!.meters)
  assert.ok(meters.some((key) => key.endsWith('/ask/1')), `a meter for the consult on the caller’s Goal: ${meters.join(', ')}`)
  assert.equal(d.pushed.some((one) => one.method === 'event' && one.params.event.type === 'session/started' && one.params.event.session.title === 'Consult'), false)
})

test('a consult’s usage is read from the live conversation before it is discarded, and its turn is on the meter before the question goes', E2E, async (t) => {
  const { d, goal, caller } = await triggerSeat(t)
  let startedBeforeAnswer: number | null = null
  d.runtime.onSend = (session, text) => {
    if (!text.includes(CONSULT_PROMPT)) return
    startedBeforeAnswer = askMeter(d, goal)?.turnStartedAt ?? null
    d.runtime.emit({ type: 'usage/updated', sessionId: session.id, usage: USAGE(0.42) })
    setImmediate(() => (session as HoldSession).finish('4'))
  }
  await d.host.consultPlane.ask({ agent: 'fake', question: 'What is 2+2?', context: null }, caller)
  assert.notEqual(startedBeforeAnswer, null, 'the turn’s start was recorded before the consult was asked')
  const meter = askMeter(d, goal)!
  assert.deepEqual({ unknown: meter.unknown, scope: meter.scope, provenance: meter.provenance, lastMicros: meter.lastMicros },
    { unknown: null, scope: 'session', provenance: 'vendorMetered', lastMicros: 420_000 }, 'the consult’s own 0.42 USD, not zero')
})

test('a consult that reported no usage is unknown, never zero, and the Goal’s next ask is refused with why', E2E, async (t) => {
  const { d, goal, caller } = await triggerSeat(t, 2)
  d.runtime.onSend = (session, text) => { if (text.includes(CONSULT_PROMPT)) setImmediate(() => (session as HoldSession).finish('4')) }
  await d.host.consultPlane.ask({ agent: 'fake', question: 'What is 2+2?', context: null }, caller)
  assert.match(askMeter(d, goal)?.unknown ?? '', /reported no usage/)
  await assert.rejects(d.host.consultPlane.ask({ agent: 'fake', question: 'And 3+3?', context: null }, caller),
    (error: Error) => code('askBudget')(error) && /Spend is unknown/.test(error.message) && /reported no usage/.test(error.message))
})

/** A corpus reading of one conversation's whole spend, as Insight's scan finds it. */
const corpusOf = (runtime: string, sessionId: string, project: string, usd: number, from: number, to: number): UsageSample => ({
  key: `corpus-${sessionId}-${usd}`, runtime, sessionId, turnId: null, requestId: null, project, model: 'fake-1',
  source: { id: 'corpus', kind: 'corpus', label: 'Recorded usage', observedAt: to, checkedAt: to, stale: false, problem: null },
  from, to, scope: 'session', includesChildren: null,
  input: { value: 10, quality: 'exact' }, output: { value: 10, quality: 'exact' }, cacheRead: { value: 0, quality: 'exact' }, cacheWrite: { value: 0, quality: 'exact' },
  usd: { value: usd, quality: 'exact' }, moneyBasis: 'vendorMetered',
})

test('an earlier corpus reading never hides the consult’s final live total: 0.10 recorded, 0.42 live, and the Goal is charged 0.42', E2E, async (t) => {
  const corpus: UsageSample[] = []
  const { d, goal, caller } = await triggerSeat(t, 1, () => corpus)
  d.runtime.onSend = (session, text) => {
    if (!text.includes(CONSULT_PROMPT)) return
    void (async () => {
      const project = (await seatLines(d.stateDir)).find((line) => line.type === 'seat')!.record!.checkout.project
      const at = Date.now()
      corpus.push(corpusOf('fake', String(session.id), project, 0.1, at, at))
      await d.host.intakePlane.tick()
      assert.equal(askMeter(d, goal)?.lastMicros, 100_000, 'the corpus reading was counted first')
      d.runtime.emit({ type: 'usage/updated', sessionId: session.id, usage: USAGE(0.42) })
      setImmediate(() => (session as HoldSession).finish('4'))
    })()
  }
  await d.host.consultPlane.ask({ agent: 'fake', question: 'What is 2+2?', context: null }, caller)
  const meter = askMeter(d, goal)!
  assert.deepEqual({ unknown: meter.unknown, lastMicros: meter.lastMicros }, { unknown: null, lastMicros: 420_000 })
})

test('a consult’s unknown spend is repaired by a later reading of it, and the Goal may ask again', E2E, async (t) => {
  const corpus: UsageSample[] = []
  const { d, goal, caller } = await triggerSeat(t, 2, () => corpus)
  d.runtime.onSend = (session, text) => { if (text.includes(CONSULT_PROMPT)) setImmediate(() => (session as HoldSession).finish('4')) }
  await d.host.consultPlane.ask({ agent: 'fake', question: 'What is 2+2?', context: null }, caller)
  assert.match(askMeter(d, goal)?.unknown ?? '', /reported no usage/)
  const lines = await seatLines(d.stateDir)
  const link = lines.find((line) => line.type === 'seat-consult' && line.consult!.closedAt !== null)!.consult!
  const project = lines.find((line) => line.type === 'seat')!.record!.checkout.project
  // Both found by one read: one from part-way through the turn, which repairs nothing, and one taken at its end, which does.
  corpus.push(corpusOf('fake', link.sessionId, project, 0.02, link.openedAt, link.openedAt))
  corpus.push(corpusOf('fake', link.sessionId, project, 0.05, link.openedAt, link.closedAt!))
  await d.host.intakePlane.tick()
  const meter = askMeter(d, goal)!
  assert.deepEqual({ unknown: meter.unknown, lastMicros: meter.lastMicros }, { unknown: null, lastMicros: 50_000 }, 'reconciled from the reading')
  d.runtime.onSend = (session, text) => { if (text.includes(CONSULT_PROMPT)) setImmediate(() => (session as HoldSession).finish('6')) }
  assert.equal((await d.host.consultPlane.ask({ agent: 'fake', question: 'And 3+3?', context: null }, caller)).text, '6')
})

test('round 3: a reading from part-way through a consult repairs nothing — the Goal stops for a person — and the final reading still repairs it after the stop', E2E, async (t) => {
  const corpus: UsageSample[] = []
  const { d, goal, caller } = await triggerSeat(t, 2, () => corpus)
  d.runtime.onSend = (session, text) => { if (text.includes(CONSULT_PROMPT)) setImmediate(() => (session as HoldSession).finish('4')) }
  await d.host.consultPlane.ask({ agent: 'fake', question: 'What is 2+2?', context: null }, caller)
  const lines = await seatLines(d.stateDir)
  const link = lines.find((line) => line.type === 'seat-consult' && line.consult!.closedAt !== null)!.consult!
  const project = lines.find((line) => line.type === 'seat')!.record!.checkout.project
  corpus.push(corpusOf('fake', link.sessionId, project, 0.02, link.openedAt, link.openedAt))
  await d.host.intakePlane.tick()
  assert.match(askMeter(d, goal)?.unknown ?? '', /reported no usage/, 'an intermediate record repairs nothing')
  assert.match(d.host.intakePlane.journal.read().budgets[goal]!.stop?.detail ?? '', /Spend is unknown/, 'and the Goal stops for a person')
  corpus.push(corpusOf('fake', link.sessionId, project, 0.05, link.openedAt, link.closedAt!))
  await d.host.intakePlane.tick()
  const meter = askMeter(d, goal)!
  assert.deepEqual({ unknown: meter.unknown, lastMicros: meter.lastMicros }, { unknown: null, lastMicros: 50_000 }, 'a stopped Goal’s consult is still read, and repaired')
  // The stop stands: the stopped run's seat no longer asks at all.
  await assert.rejects(d.host.consultPlane.ask({ agent: 'fake', question: 'And 3+3?', context: null }, caller),
    (error: unknown) => code('askBudget')(error) || code('askNotAllowed')(error))
})

/** A trigger Seat that asks once, while the corpus records `before` part-way through the consult and the live conversation reports `live` (or nothing). */
const askWithCorpus = async (t: TestContext, before: number, live: number | null) => {
  const corpus: UsageSample[] = []
  const { d, goal, caller } = await triggerSeat(t, 2, () => corpus)
  d.runtime.onSend = (session, text) => {
    if (!text.includes(CONSULT_PROMPT)) return
    void (async () => {
      const project = (await seatLines(d.stateDir)).find((line) => line.type === 'seat')!.record!.checkout.project
      const at = Date.now()
      corpus.push(corpusOf('fake', String(session.id), project, before, at, at))
      await d.host.intakePlane.tick()
      assert.equal(askMeter(d, goal)?.lastMicros, Math.round(before * 1_000_000), 'the corpus reading was counted first')
      if (live !== null) d.runtime.emit({ type: 'usage/updated', sessionId: session.id, usage: USAGE(live) })
      setImmediate(() => (session as HoldSession).finish('4'))
    })()
  }
  await d.host.consultPlane.ask({ agent: 'fake', question: 'What is 2+2?', context: null }, caller)
  return { d, goal, caller }
}

test('round 3: a total that reset — 0.30 recorded, then a final 0.12 live — is unknown, and the Goal’s next ask is refused', E2E, async (t) => {
  const { d, goal, caller } = await askWithCorpus(t, 0.3, 0.12)
  const meter = askMeter(d, goal)!
  assert.match(meter.unknown ?? '', /final total below/)
  await assert.rejects(d.host.consultPlane.ask({ agent: 'fake', question: 'And 3+3?', context: null }, caller),
    (error: Error) => code('askBudget')(error) && /Spend is unknown/.test(error.message))
})

test('round 3: no final reading — 0.10 recorded mid-turn, nothing live — is unknown, never a known 0.10, and the next ask is refused', E2E, async (t) => {
  const { d, goal, caller } = await askWithCorpus(t, 0.1, null)
  assert.match(askMeter(d, goal)?.unknown ?? '', /reported no usage/)
  await assert.rejects(d.host.consultPlane.ask({ agent: 'fake', question: 'And 3+3?', context: null }, caller),
    (error: Error) => code('askBudget')(error) && /Spend is unknown/.test(error.message))
})

test('round 3: after a restart, a wrapped Goal whose consult’s spend a final reading repairs settles its reservation', E2E, async (t) => {
  const corpus: UsageSample[] = []
  const { d, goal, caller } = await triggerSeat(t, 2, () => corpus)
  d.runtime.onSend = (session, text) => { if (text.includes(CONSULT_PROMPT)) setImmediate(() => (session as HoldSession).finish('4')) }
  await d.host.consultPlane.ask({ agent: 'fake', question: 'What is 2+2?', context: null }, caller)
  assert.match(askMeter(d, goal)?.unknown ?? '', /reported no usage/)
  // As a desk that restarted finds it: the Goal wrapped on disk, and nothing of that in the intake plane's memory.
  const standing = GoalStore.prototype.standing
  GoalStore.prototype.standing = function (id) {
    const real = standing.call(this, id)
    return id === goal && real ? { ...real, state: 'wrapped' } : real
  }
  t.after(() => { GoalStore.prototype.standing = standing })
  const lines = await seatLines(d.stateDir)
  const link = lines.find((line) => line.type === 'seat-consult' && line.consult!.closedAt !== null)!.consult!
  corpus.push(corpusOf('fake', link.sessionId, lines.find((line) => line.type === 'seat')!.record!.checkout.project, 0.05, link.openedAt, link.closedAt!))
  await d.host.intakePlane.tick()
  const budget = d.host.intakePlane.journal.read().budgets[goal]!
  assert.deepEqual({ unknown: askMeter(d, goal)!.unknown, settled: budget.settled, reservedMicros: budget.reservedMicros }, { unknown: null, settled: true, reservedMicros: 0 })
})
