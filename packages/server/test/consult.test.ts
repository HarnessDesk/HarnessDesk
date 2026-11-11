import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GoalView, Intent, SessionSummary, WireNotification } from '@harnessdesk/protocol'

import { CONSULT_PROMPT } from '../src/consult.js'
import { executionOf } from '../src/flow-recovery.js'
import type { QuestionTimers } from '../src/host.js'
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
}

/** A desk with a running fixer seat that may (or may not) ask `holdfake`, and a window listening to everything. */
const asking = async (t: TestContext, source = ASKS): Promise<Asking> => {
  const timers = manualTimers()
  const d = await desk(t, undefined, { consultTimers: timers })
  const holds = new HoldFake('holdfake')
  d.host.register(holds)
  await holds.start()
  const run = await start(d, source, TASK)
  const [card] = await claimed(d, run.goal, 'fixer', 1)
  const seen: WireNotification[] = []
  t.after(d.host.addBroadcaster((notification) => { seen.push(notification) }))
  return { d, holds, timers, caller: { runtime: card!.claim!.runtime, sessionId: card!.claim!.sessionId }, run: run.id, seen }
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
  readonly record?: { readonly id: string; readonly session: { readonly sessionId: string } }
  readonly consult?: { readonly seat: string; readonly runtime: string; readonly sessionId: string }
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
  // A window that lists conversations while the consult is open never sees it.
  a.holds.onSend = (session) => {
    void (async () => {
      const page = await a.d.host.call('session/list', { runtime: 'holdfake' as never }) as { data: SessionSummary[] }
      listed.push(...page.data)
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
  assert.deepEqual(lines.filter((line) => line.type === 'seat-consult').map((line) => [line.consult?.seat, line.consult?.runtime, line.consult?.sessionId]),
    [[callerSeat, 'holdfake', String(consult.id)]])

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
const triggerSeat = async (t: TestContext, times = 1): Promise<{ d: Awaited<ReturnType<typeof intakeDesk>>; goal: string; caller: { runtime: string; sessionId: string } }> => {
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
  const d = await intakeDesk({ repo })
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
