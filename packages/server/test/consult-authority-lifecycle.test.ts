import assert from 'node:assert/strict'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'

import type { GoalView, Intent, SessionSummary, WireNotification } from '@harnessdesk/protocol'

import { CONSULT_CLOSED_REFUSAL, CONSULT_PROMPT } from '../src/consult.js'
import { executionOf } from '../src/flow-recovery.js'
import { GoalStore } from '../src/goals/store.js'
import type { QuestionTimers } from '../src/host.js'
import type { UsageSample } from '../src/ledger/insight.js'
import { InsightCacheUnavailableError } from '../src/ledger/insight-cache.js'
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
const asking = async (t: TestContext, source = ASKS, options: { readonly kept?: number; readonly also?: readonly string[]; readonly afterCommit?: () => void; readonly beforeHost?: (stateDir: string) => Promise<void>; readonly registerHostCleanup?: (host: Desk['host']) => void } = {}): Promise<Asking> => {
  const timers = manualTimers()
  const d = await desk(t, undefined, { consultTimers: timers, ...(options.kept !== undefined ? { consultsRetiredKept: options.kept } : {}), ...(options.afterCommit ? { consultAuthorityAfterCommit: options.afterCommit } : {}), ...(options.beforeHost ? { beforeHost: options.beforeHost } : {}), ...(options.registerHostCleanup ? { registerHostCleanup: options.registerHostCleanup } : {}) })
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

const admitRead = (a: Asking, runtime: string, sessionId: string) => a.d.host.ceilingGate.admit({
  startedAt: Date.now(), tool: 'board_read', args: undefined, needs: 'read', scope: { runtime: runtime as never, sessionId: sessionId as never }, quiet: true,
})
const ASK_TWICE = (seats: string) => FLOW(`\n    ask: { seats: [${seats}], times: 3, timeoutSeconds: 30 }`)

test('closed consult families with registered children retire at the configured bound', E2E, async (t) => {
  const a = await asking(t, ASK_TWICE('holdfake'), { kept: 1 })
  const roots: string[] = []
  const children: string[] = []
  a.holds.onSend = (session) => {
    void (async () => {
      roots.push(String(session.id))
      const child = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
      children.push(String(child.id))
      a.holds.emit({ type: 'item/completed', sessionId: session.id, turnId: 'consult-turn' as never,
        item: { id: `spawn-${child.id}` as never, type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: String(child.id) }] } })
      ;(session as HoldSession).finish('4')
    })()
  }
  for (const question of ['one', 'two', 'three']) await a.d.host.consultPlane.ask({ agent: 'holdfake', question, context: null }, a.caller)
  assert.deepEqual(a.d.host.consultAuthorityHotCounts, { families: 1, keys: 2 })
  assert.deepEqual(await admitRead(a, 'holdfake', roots[0]!), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL })
  for (const child of children) assert.deepEqual(await admitRead(a, 'holdfake', child), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL }, child)
  assert.deepEqual(await admitRead(a, 'holdfake', roots[2]!), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL })
})

test('probe: a late registered descendant of an evicted registered child remains refused', E2E, async (t) => {
  const a = await asking(t, ASK_TWICE('holdfake'), { kept: 1 })
  const children: string[] = []
  a.holds.onSend = (session) => { void (async () => {
    const child = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
    children.push(String(child.id))
    a.holds.emit({ type: 'item/completed', sessionId: session.id, turnId: 'consult-turn' as never,
      item: { id: `spawn-${child.id}` as never, type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: String(child.id) }] } })
    ;(session as HoldSession).finish('4')
  })() }
  for (const question of ['one', 'two', 'three']) await a.d.host.consultPlane.ask({ agent: 'holdfake', question, context: null }, a.caller)
  const late = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
  a.holds.emit({ type: 'item/completed', sessionId: children[0] as never, turnId: 'late-turn' as never,
    item: { id: 'late-spawn' as never, type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: String(late.id) }] } })
  assert.deepEqual(await admitRead(a, 'holdfake', String(late.id)), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL })
})

test('cold authority retains more than 2000 late and nested reported children', E2E, async (t) => {
  const a = await asking(t, ASK_TWICE('holdfake'), { kept: 0 })
  let root = ''
  a.holds.onSend = (session) => { void (async () => {
    const child = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
    root = String(child.id)
    a.holds.emit({ type: 'item/completed', sessionId: session.id, turnId: 'spawn' as never, item: { id: 'spawn' as never, type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: root }] } })
    ;(session as HoldSession).finish('4')
  })() }
  await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'one', context: null }, a.caller)
  const nested = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
  const emit = (parent: string, members: string[]) => a.holds.emit({ type: 'item/completed', sessionId: parent as never, turnId: 'late' as never,
    item: { id: 'late-spawn' as never, type: 'subagent', action: 'spawn', status: 'completed', members: members.map(sessionId => ({ sessionId })) } })
  emit(root, [...Array.from({ length: 2001 }, (_, n) => `late-${n}`), String(nested.id)])
  emit(String(nested.id), ['nested-late'])
  assert.deepEqual(a.d.host.consultAuthorityHotCounts, { families: 0, keys: 0 })
  for (const id of ['late-0', 'late-2000', 'nested-late']) assert.deepEqual(await admitRead(a, 'holdfake', id), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL })
  const independent = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
  assert.deepEqual(await admitRead(a, 'holdfake', String(independent.id)), { admitted: true })
})

test('review: out-of-order registered descendants remain closed after delegation cache churn', E2E, async (t) => {
  const a = await asking(t, ASKS, { kept: 0 })
  let grandchild = ''
  a.holds.onSend = session => { void (async () => {
    const parent = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
    const child = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
    grandchild = String(child.id)
    const edge = (from: string, members: string[]) => a.holds.emit({ type: 'item/completed', sessionId: from as never, turnId: 'edge' as never, item: { id: 'edge' as never, type: 'subagent', action: 'spawn', status: 'completed', members: members.map(sessionId => ({ sessionId })) } })
    edge(String(parent.id), [grandchild])
    const unrelated = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
    edge(String(unrelated.id), Array.from({ length: 2001 }, (_, n) => `early-churn-${n}`))
    edge(String(session.id), [String(parent.id)])
    ;(session as HoldSession).finish('4')
  })() }
  await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'one', context: null }, a.caller)
  const independent = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd })
  a.holds.emit({ type: 'item/completed', sessionId: independent.id, turnId: 'churn' as never, item: { id: 'churn' as never, type: 'subagent', action: 'spawn', status: 'completed', members: Array.from({length: 2001}, (_, n) => ({ sessionId: `churn-${n}` })) } })
  assert.deepEqual(await admitRead(a, 'holdfake', grandchild), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL })
  assert.deepEqual(await admitRead(a, 'holdfake', String(independent.id)), { admitted: true })
})

test('review: a former consult child can be independently reassociated', E2E, async (t) => {
  const a = await asking(t, ASK_TWICE('holdfake'), { kept: 0, beforeHost: async dir => { await mkdir(join(dir, 'agents', 'review-independent'), { recursive: true }); await writeFile(join(dir, 'agents', 'review-independent', 'AGENT.md'), '---\nname: Independent\nceiling: read\nprefer: [holdfake]\n---\nRead.\n') } })
  let child = ''
  a.holds.onSend = session => { void (async () => {
    const registered = await a.holds.createSession({ cwd: a.holds.createOptions[0]!.cwd }); child = String(registered.id)
    a.holds.emit({ type: 'item/completed', sessionId: session.id, turnId: 'edge' as never, item: { id: 'edge' as never, type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: child }] } })
    ;(session as HoldSession).finish('4')
  })() }
  await a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'one', context: null }, a.caller)
  a.d.host.registry.delete('holdfake' as never, child as never)
  a.holds.reuseId = child
  await a.d.host.call('agent/seat', { id: 'review-independent', cwd: a.d.root, permission: 'read' })
  assert.deepEqual(await admitRead(a, 'holdfake', child), { admitted: true })
})

test('review: failed opening discard cannot close a newer consult on the same key', E2E, async (t) => {
  const a = await asking(t, ASK_TWICE('holdfake'), { kept: 0 })
  const create = a.holds.createSession.bind(a.holds)
  let first = true
  a.holds.createSession = async options => {
    const session = await create(options)
    if (first) { first = false; session.options = () => { throw new Error('injected opening failure') } }
    return session
  }
  let release!: () => void, deleting = false
  a.holds.deleteSession = async () => { deleting = true; await new Promise<void>(r => { release = r }); return { disposition: 'removed', removed: 1 } }
  const old = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'old', context: null }, a.caller)
  void old.catch(() => {})
  await whenChanged(a.d, () => deleting ? true : null, 'failed opening discard waits')
  for (const timer of [...a.timers.live.values()].filter(one => one.ms === 30_000)) timer.fire()
  await assert.rejects(old, code('askTimeout'))
  const id = String(a.holds.held[0]!.id)
  a.d.host.registry.delete('holdfake' as never, id as never)
  a.holds.reuseId = id
  let sent = false
  a.holds.onSend = () => { sent = true }
  const next = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'new', context: null }, a.caller)
  void next.catch(() => {})
  await whenChanged(a.d, () => sent ? true : null, 'new consult running')
  release()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(await admitRead(a, 'holdfake', id), { admitted: true })
  a.holds.deleteSession = async () => ({ disposition: 'removed', removed: 1 })
  for (const timer of [...a.timers.live.values()].filter(one => one.ms === 30_000)) timer.fire()
  await assert.rejects(next, code('askTimeout'))
})

test('review: a shown late consult still broadcasts removal after cold retirement', E2E, async (t) => {
  const a = await asking(t, ASKS, { kept: 0 })
  let open!: () => void, release!: () => void, deleting = false
  a.holds.createGate = new Promise<void>(r => { open = r })
  a.holds.deleteSession = async () => { deleting = true; await new Promise<void>(r => { release = r }); return { disposition: 'removed', removed: 1 } }
  const pending = a.d.host.consultPlane.ask({ agent: 'holdfake', question: 'late', context: null }, a.caller)
  await whenChanged(a.d, () => a.holds.createOptions.length ? true : null, 'opening waits')
  for (const timer of [...a.timers.live.values()].filter(one => one.ms === 30_000)) timer.fire()
  await assert.rejects(pending, code('askTimeout'))
  for (const timer of [...a.timers.live.values()].filter(one => one.ms === 10_000)) timer.fire()
  open()
  await whenChanged(a.d, () => deleting ? true : null, 'late discard waits')
  const id = String(a.holds.held[0]!.id)
  assert.ok(mentions(a.seen, 'holdfake', id).some(n => n.method === 'event' && n.params.event.type === 'session/started'), 'the late start was shown')
  assert.deepEqual(a.d.host.consultAuthorityHotCounts, { families: 0, keys: 0 })
  release()
  await whenChanged(a.d, () => a.d.host.registry.get('holdfake' as never, id as never) === undefined ? true : null, 'late removal completed')
  assert.ok(mentions(a.seen, 'holdfake', id).some(n => n.method === 'session/removed'), 'shown start receives removal')
})

test('review: pending-edge storage failure fails closed on the real tool gate', E2E, async (t) => {
  const a = await asking(t, ASKS, { kept: 0 })
  const independent = await a.holds.createSession({ cwd: a.d.root })
  assert.deepEqual(await admitRead(a, 'holdfake', String(independent.id)), { admitted: true })
  const directory = join(a.d.stateDir, 'consult-authority')
  const [file] = await readdir(directory)
  const db = new DatabaseSync(join(directory, file!))
  try {
    db.exec("CREATE TRIGGER fail_edge BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT, 'edge write failure'); END")
    a.holds.emit({ type: 'item/completed', sessionId: independent.id, turnId: 'edge' as never, item: { id: 'edge' as never, type: 'subagent', action: 'spawn', status: 'completed', members: [{ sessionId: 'pending-child' }] } })
    assert.deepEqual(await admitRead(a, 'holdfake', String(independent.id)), { admitted: false, refusal: CONSULT_CLOSED_REFUSAL })
  } finally { db.close() }
})
