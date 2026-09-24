import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import {
  runtimeId, sessionId, SeatRefusedError,
  type CeilingLevel, type FlowExecution, type FlowSeat, type FrontDoorPreview, type FlowPreview, type SeatRecord, type Session,
} from '@harnessdesk/protocol'

import { Agents } from '../src/agents.js'
import { NOT_HELD } from '../src/ceilings/held-seat.js'
import type { SeatHold } from '../src/ceilings/hold.js'
import { sourceDigest } from '../src/flow-execution.js'
import { Host, StateStore } from '../src/index.js'
import { seatAgent } from '../src/methods/agents.js'
import type { HostContext } from '../src/methods/context.js'
import { MachineSeatingFile } from '../src/agent-seating-file.js'
import type { SeatedAs } from '../src/registry.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'
import { silent } from './fixtures/harness.js'
import { HoldFake } from './fixtures/hold-runtime.js'
import { tempDir } from './scratch.js'

/*
 * A front-door start holds every Seat it ever opens to its ceiling: read back
 * as held, at exactly the previewed level, before it is kept and before any
 * brief, tool or card reaches it — its first round, every later round, and
 * every round after a restart. An ordinary start keeps phase 3's watched
 * behaviour exactly.
 */

const SHAPE = [
  'version: 2',
  'name: Read review',
  'roles:',
  '  reviewer: { kind: agent, uses: [reviewer], grant: read }',
  'seed: { role: reviewer, title: Review the change }',
  '',
].join('\n')

const desk = async (t: TestContext, prefer: string) => {
  const stateDir = tempDir('hd-front-door-state-')
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: tempDir('hd-front-door-builtins-'),
    catalogRefreshMs: 0,
  })
  const holds = new HoldFake()
  const plain = new FakeRuntime()
  host.register(holds)
  host.register(plain)
  await host.start()
  t.after(() => host.dispose())
  const work = tempDir('hd-front-door-work-')
  await host.call('workspace/open', { path: work })
  await mkdir(join(stateDir, 'agents', 'reviewer'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'reviewer', 'AGENT.md'), `---\nname: Reviewer\nceiling: read\nanswers: [done]\nprefer: [${prefer}]\n---\nRead the diff.\n`, 'utf8')
  const sent: string[] = []
  holds.onSend = (session, text) => { sent.push(`holdfake ${session.id}: ${text.slice(0, 30)}`) }
  plain.onSend = (session, text) => { sent.push(`fake ${session.id}: ${text.slice(0, 30)}`) }
  return { host, holds, plain, work, sent }
}

test('asked never receives work', async (t) => {
  const { host, holds, work, sent } = await desk(t, 'holdfake')
  // The runtime declares it can hold read, so the dry run offers it and mints a strict token.
  const preview = (await host.call('authoring/start/preview', { context: { kind: 'project', root: work }, source: SHAPE, vars: {} })) as FrontDoorPreview
  assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
  assert.deepEqual(preview.flow.seats[0]?.plan.ceiling, { level: 'read', hold: 'held' })
  // …but once opened, its control reads back as something else: only asked.
  holds.habit = 'settlesElsewhere'
  const run = (await host.call('flow/start-goal', { root: work, source: SHAPE, token: preview.flow.token, sentence: preview.sentence })) as FlowExecution
  assert.equal(run.requireHeld, true)
  assert.equal(run.state, 'stalled')
  assert.match(run.reason ?? '', /could not be opened: [\s\S]*cannot hold read — Sandbox reads back as Full access, not Read only, and a start from the front door needs every Seat to hold its ceiling/)
  // Opened once, provisionally, and closed before anything was sent to it: no brief, no card, no Seat kept.
  assert.equal(holds.held.length, 1)
  assert.deepEqual(sent, [])
  assert.equal(host.registry.get(runtimeId('holdfake'), holds.held[0]!.id), undefined)
  const view = (await host.call('goal/read', { goal: run.goal })) as { members: readonly SeatRecord[] }
  assert.deepEqual(view.members, [])
})

test('ordinary start keeps watched semantics', async (t) => {
  const { host, plain, work, sent } = await desk(t, 'fake')
  // The front door refuses a runtime that can only ask: no start token, with the candidate named.
  const strict = (await host.call('authoring/start/preview', { context: { kind: 'project', root: work }, source: SHAPE, vars: {} })) as FrontDoorPreview
  assert.equal(strict.flow.token, null)
  assert.deepEqual(strict.flow.seats[0]?.plan.candidates.map((one) => one.reason), [{ kind: 'unheld', level: 'read', detail: null, required: true }])
  assert.deepEqual(strict.flow.seats[0]?.plan.candidates[0]?.fix, { kind: 'seats' }, 'the fix is a seat that can hold, never this Mac’s setting')
  // The ordinary dry run on this Mac's watched default still seats it, and says asked — never held.
  const preview = (await host.call('flow/preview', { root: work, source: SHAPE })) as FlowPreview
  assert.ok(preview.token, JSON.stringify(preview.problems))
  assert.deepEqual(preview.seats[0]?.plan.ceiling, { level: 'read', hold: 'asked' })
  const run = (await host.call('flow/start-goal', { root: work, source: SHAPE, token: preview.token, sentence: 'Review' })) as FlowExecution
  assert.equal(run.requireHeld, undefined)
  assert.equal(run.state, 'running', run.reason ?? '')
  const view = (await host.call('goal/read', { goal: run.goal })) as { members: readonly SeatRecord[] }
  assert.equal(view.members.length, 1)
  assert.deepEqual(view.members[0]?.ceiling, { level: 'read', hold: 'asked' })
  assert.equal(plain.sessions.size, 1)
  assert.ok(sent.some((one) => one.startsWith('fake ')), 'the brief was handed over')
})

/** `seatAgent` itself, on the host's seating path, with the hold, the Seat record and the brief as ports a test drives. */
const seating = async (options: { readonly hold: (level: CeilingLevel) => SeatHold; readonly recordFails?: string; readonly prefer?: string }) => {
  const root = tempDir('hd-front-door-seat-')
  const user = join(root, 'user')
  await mkdir(join(user, 'reviewer'), { recursive: true })
  await writeFile(join(user, 'reviewer', 'AGENT.md'), `---\nname: Reviewer\nceiling: read\nprefer: [${options.prefer ?? 'holds'}]\n---\nRead the diff.\n`, 'utf8')
  const roster = new Agents({ user, builtin: join(root, 'builtin') })
  const steps: string[] = []
  const runtime = (id: string) => ({
    info: { id: runtimeId(id), capabilities: { account: true }, presentation: { name: id }, ceilings: { read: { settings: [], how: 'Read-only sandbox' } } },
    health: () => ({ state: 'ready' }),
    getAccount: async () => ({ accounts: [{ kind: 'apiKey', label: 'key' }], signInMethods: [] }),
    listModels: async () => [],
  })
  const runtimes = new Map([['holds', runtime('holds')], ['other', runtime('other')]])
  let opened = 0
  const ctx = {
    state: { state: { preferences: {} } },
    evidence: {
      seats: {
        opened: async (input: { session: { runtime: string; sessionId: string } }) => {
          steps.push(`record ${input.session.sessionId}`)
          if (options.recordFails) throw new Error(options.recordFails)
          return { id: `seat-${input.session.sessionId}` }
        },
      },
    },
    agents: { list: (project?: string) => roster.list(project), read: (id: string, project?: string) => roster.read(id, project) },
    seating: new MachineSeatingFile(join(root, 'seating.json')),
    runtimes: { get: (id: string) => runtimes.get(id), infoOf: (one: { info: unknown }) => one.info, metered: () => [...runtimes.values()] },
    options: { seatReadDeadlineMs: 1_000 },
    logger: { warn: () => {} },
    usage: () => ({ reports: async () => [], cached: () => null }),
    seats: {
      open: async (seat: FlowSeat) => {
        opened += 1
        steps.push(`open ${seat.runtime} s${opened}`)
        return { runtime: seat.runtime, sessionId: `s${opened}`, running: { model: 'm', effort: null, thinking: false, thinkingFixed: null }, label: seat.runtime }
      },
      hold: async (_runtime: string, id: string, level: CeilingLevel) => { steps.push(`hold ${id} ${level}`); return options.hold(level) },
      order: async (_runtime: string, id: string) => { steps.push(`brief ${id}`) },
      retire: async (_runtime: string, id: string) => { steps.push(`retire ${id}`) },
      discard: async (_runtime: string, id: string) => { steps.push(`discard ${id}`); return null },
      recordAgent: (runtime: string, id: string, seated: SeatedAs): Session => {
        steps.push(`expose ${id}`)
        return { id: sessionId(id), runtime: runtimeId(runtime), cwd: '/tmp/x', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, settings: { cwd: '/tmp/x', ...seated }, turns: [], itemsLoaded: true } as unknown as Session
      },
    },
  } as unknown as HostContext
  const seat = () => seatAgent(ctx, { id: 'reviewer', cwd: '/tmp/x' }, { board: 'goal-1', role: null, grant: { kind: 'ceiling', level: 'read' }, requireHeld: true })
  return { steps, seat }
}

test('broader readback is refused', async () => {
  // Previewed at read; the runtime's readback says it holds merge. Held, but not what was shown: closed, never kept.
  const { steps, seat } = await seating({ hold: () => ({ ceiling: { level: 'merge', hold: 'held' }, how: 'Full access', why: null }) })
  await assert.rejects(seat(), (error: unknown) => {
    assert.ok(error instanceof SeatRefusedError)
    assert.deepEqual(error.wireData.candidates.map((one) => one.reason), [{ kind: 'unheld', level: 'read', detail: 'it reads back holding merge, not read', required: true }])
    return true
  })
  assert.deepEqual(steps, ['open holds s1', 'hold s1 read', 'discard s1'])
  // Held at exactly the previewed level, it is kept, and only then briefed and exposed.
  const exact = await seating({ hold: (level) => ({ ceiling: { level, hold: 'held' }, how: 'Read-only sandbox', why: null }) })
  await exact.seat()
  assert.deepEqual(exact.steps, ['open holds s1', 'hold s1 read', 'record s1', 'brief s1', 'expose s1'])
})

test('durability failure closes provisional seat', async () => {
  const { steps, seat } = await seating({
    hold: (level) => ({ ceiling: { level, hold: 'held' }, how: 'Read-only sandbox', why: null }),
    recordFails: 'the evidence store is full',
  })
  await assert.rejects(seat(), /its Seat record could not be written, so the conversation was closed: the evidence store is full/)
  // The record was awaited before anything else: no brief, no exposure to the desk's tools, and the conversation let go.
  assert.deepEqual(steps, ['open holds s1', 'hold s1 read', 'record s1', 'retire s1'])
})

const BUILD_THEN_REVIEW = `
version: 2
name: Build then review
roles:
  builder: { kind: agent, uses: [builder], grant: edit }
  reviewer: { kind: agent, uses: [reviewer], grant: read }
seed: { role: builder, title: Build it }
rules:
  - { id: review, on: builder, then: { role: reviewer, title: Review it } }
`

test('later and recovered rounds keep strict admission', async (t) => {
  const rig = await goalRig(t)
  const agents = [agent('builder', ['done']), agent('reviewer', ['done'])]
  const started = await rig.flows.startGoal({
    root: '/repo', sentence: 'Build and review', source: BUILD_THEN_REVIEW, sourcePath: null, compiled: rig.compile(BUILD_THEN_REVIEW, agents),
    requireHeld: true,
    authorization: { sourceDigest: sourceDigest(BUILD_THEN_REVIEW), commandDigest: sourceDigest(''), approvedAt: 1, start: 'front-door' },
  })
  assert.equal(started.requireHeld, true)
  assert.deepEqual(rig.strictAsks, [true], 'the seed Seat was opened held-only')
  const [build] = rig.board(started.goal).intents
  assert.equal(build?.state, 'claimed')
  // A fresh process: the engine reads the run back from disk alone.
  const restarted = await rig.restart()
  assert.equal(restarted.flows.executionOf(started.id)?.requireHeld, true)
  // The reviewer's runtime can no longer hold: its round refuses rather than seating asked.
  rig.holdsCeilings = false
  await rig.team.complete(build!.id, { outcome: 'done', note: 'BUILT-IT' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  assert.deepEqual(rig.strictAsks, [true, true], 'the later round asked for held Seats too')
  const run = restarted.flows.executionOf(started.id)!
  assert.equal(run.state, 'stalled')
  assert.match(run.reason ?? '', new RegExp(NOT_HELD.replace(/[.]/g, '\\.')))
  // What the first round did is kept: its card, its outcome, its note, its Seat.
  const kept = rig.board(started.goal).intents.find((one) => one.id === build!.id)
  assert.equal(kept?.state, 'done')
  assert.equal(kept?.note, 'BUILT-IT')
  assert.equal(rig.seats.get('seat-1')?.closed, null)
  assert.deepEqual([...rig.orderTexts.keys()], ['seat-1'], 'nothing was ordered to a Seat the later round could not hold')
})

test('a reused empty Goal is reserved before dispatch, and a lost race starts nothing', async (t) => {
  const rig = await goalRig(t)
  const agents = [agent('builder', ['done']), agent('reviewer', ['done'])]
  const existing = await rig.team.createRoom('/repo', 'An empty Goal')
  const request = (revision: number) => ({
    root: '/repo', sentence: 'Build and review', source: BUILD_THEN_REVIEW, sourcePath: null, compiled: rig.compile(BUILD_THEN_REVIEW, agents),
    requireHeld: true as const, goal: { id: existing.id, revision },
    authorization: { sourceDigest: sourceDigest(BUILD_THEN_REVIEW), commandDigest: sourceDigest(''), approvedAt: 1, start: 'front-door' as const },
  })
  // The Goal took work since the preview: the reservation refuses, and nothing outside the desk happened.
  rig.reserve = async () => { throw new Error('This Goal changed or already has work. Open it before starting a shape.') }
  await assert.rejects(rig.flows.startGoal(request(0)), /already has work/)
  assert.equal(rig.events.length, 0, 'no Goal was made, no Seat opened, no lane')
  assert.equal(rig.strictAsks.length, 0)
  // Reserved: the run lands on that Goal — no second Goal — and seats held-only.
  rig.reserve = async () => {}
  const run = await rig.flows.startGoal(request(0))
  assert.equal(run.goal, existing.id)
  assert.deepEqual(rig.events.slice(0, 2), [`reserve:${existing.id}:${run.id}`, 'open:seat-1'])
  assert.equal(rig.events.some((one) => one.startsWith('goal:')), false)
  assert.deepEqual(rig.strictAsks, [true])
  // An ordinary start cannot name a Goal to land on, and a held one must say where it came from.
  await assert.rejects(rig.flows.startGoal({ ...request(1), requireHeld: undefined as never, authorization: { ...request(1).authorization, start: undefined as never } }), /Only a front-door start reuses an existing Goal/)
  await assert.rejects(rig.flows.startGoal({ ...request(1), authorization: { ...request(1).authorization, start: undefined as never } }), /does not match where it came from/)
})
