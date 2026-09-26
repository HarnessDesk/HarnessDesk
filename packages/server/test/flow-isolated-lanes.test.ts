import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { runtimeId, sessionId, type FlowExecution, type FlowPreview, type GoalView, type Lane, type Session } from '@harnessdesk/protocol'

import { Host, StateStore } from '../src/index.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/*
 * The comparison a use-case walk could not start: two competitors in
 * isolated lanes and a judge. Every isolated competitor was refused on any
 * runtime that could not take the lane's variables per session — a row
 * running a bridge built before lane support, or an agent whose own ACP
 * server claims nothing — though a lane needs only its checkout from a runtime. These run the real
 * Host with two ACP runtime doubles side by side: the bridge this repository
 * ships over a scripted Claude CLI, which takes the variables, and the
 * adapter's own scripted peer, which claims nothing and takes none. Both open
 * in their own lanes; only the first is handed the variables; the second is
 * told them in its standing order. And a round whose first Seat will not open
 * says what became of its sibling.
 */

const BRIDGE = fileURLToPath(new URL('../../../claude-acp/dist/src/main.js', import.meta.url))
const FAKE_CLAUDE = fileURLToPath(new URL('../../../claude-acp/dist/test/fixtures/fake-claude.mjs', import.meta.url))
const PLAIN_ACP = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))

const COMPARISON = `
version: 2
name: Comparison
inputs:
  task:
    label: Task
roles:
  competitor: { kind: agent, uses: implementer, seats: [claude-code, plain], isolate: true, grant: edit, independentOf: [] }
  judge: { kind: agent, uses: judge, grant: read, independentOf: [] }
seed: { role: competitor, title: "{{task}}" }
rules:
  - { id: to-judge, on: competitor, then: { role: judge, title: "Pick the better attempt" } }
messaging: board-only
`

const writeAgent = async (stateDir: string, id: string, lines: readonly string[]): Promise<void> => {
  await mkdir(join(stateDir, 'agents', id), { recursive: true })
  await writeFile(join(stateDir, 'agents', id, 'AGENT.md'), ['---', `name: ${id}`, ...lines, '---', `Do the ${id} part.`, ''].join('\n'), 'utf8')
}

interface Desk {
  readonly host: Host
  readonly root: string
}

const deskWith = async (t: TestContext, ...runtimes: readonly AcpRuntime[]): Promise<Desk> => {
  const repo = await makeRepo('hd-lane-claude-')
  const stateDir = tempDir('hd-lane-claude-state-')
  await writeAgent(stateDir, 'implementer', ['ceiling: edit', 'answers: [done]', 'prefer: [fake]'])
  await writeAgent(stateDir, 'judge', ['ceiling: read', 'answers: [picked, neither]', 'prefer: [fake]'])
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: tempDir('hd-lane-claude-builtins-'),
    catalogRefreshMs: 0,
  })
  for (const runtime of runtimes) host.register(runtime)
  host.register(new FakeRuntime({ provider: 'vendor-a' }))
  await host.start()
  t.after(() => host.dispose())
  await host.call('workspace/open', { path: repo.dir })
  return { host, root: repo.dir }
}

const startComparison = async (d: Desk): Promise<FlowExecution> => {
  const vars = { task: 'Make the greeting friendlier' }
  const preview = await d.host.call('flow/preview', { root: d.root, source: COMPARISON, vars }) as FlowPreview
  assert.ok(preview.token, `the flow previews clean: ${JSON.stringify(preview.problems)}`)
  return await d.host.call('flow/start-goal', { root: d.root, source: COMPARISON, token: preview.token!, sentence: 'Compare two attempts', vars }) as FlowExecution
}

/** The run once its first round is seated or it stopped for a person. */
const settledFirstRound = async (d: Desk, run: string): Promise<FlowExecution> => {
  const deadline = Date.now() + 20_000
  for (;;) {
    const now = await d.host.call('flow/execution', { run }) as FlowExecution
    if (now.state !== 'running' || (now.rounds[0]?.seats.length ?? 0) === 2) return now
    if (Date.now() > deadline) throw new Error(`the first round did not settle: ${JSON.stringify(now)}`)
    await new Promise((wake) => setTimeout(wake, 50))
  }
}

const claudeBridge = (home: string, envLog: string): AcpRuntime => new AcpRuntime({
  id: 'claude-code',
  name: 'Claude',
  command: process.execPath,
  args: [BRIDGE],
  env: {
    CLAUDE_CODE_EXECUTABLE: FAKE_CLAUDE,
    CLAUDE_CONFIG_DIR: join(home, 'config'),
    CLAUDE_ACP_STATE_DIR: join(home, 'state'),
    CLAUDECODE: '',
    FAKE_LANE_ENV_LOG: envLog,
  },
})

/** An ACP agent that claims nothing under `_meta.harnessdesk` — no session environments — as several agents' own ACP servers do. */
const plainPeer = (env: Record<string, string> = {}): AcpRuntime => new AcpRuntime({
  id: 'plain',
  name: 'Plain',
  command: process.execPath,
  args: [PLAIN_ACP],
  env,
})

const orderOf = async (d: Desk, runtime: string, id: string): Promise<string> => {
  const deadline = Date.now() + 10_000
  for (;;) {
    const session = await d.host.call('session/read', { runtime: runtimeId(runtime), sessionId: sessionId(id) }) as Session
    const notice = session.turns.flatMap((turn) => turn.items).find((item) => item.type === 'notice')
    if (notice?.type === 'notice') return notice.text
    if (Date.now() > deadline) throw new Error(`no standing order reached ${runtime}`)
    await new Promise((wake) => setTimeout(wake, 50))
  }
}

test('a comparison seats both competitors in their own lanes — the runtime that takes session environments gets the variables, the one that cannot is told them', { timeout: 60_000 }, async (t) => {
  const home = tempDir('hd-lane-claude-home-')
  const envLog = join(home, 'environment.ndjson')
  const claude = claudeBridge(home, envLog)
  const plain = plainPeer()
  const d = await deskWith(t, claude, plain)
  assert.equal(claude.info.capabilities.sessionEnvironment, true, 'the shipped bridge claims lanes in its handshake')
  assert.equal(plain.info.capabilities.sessionEnvironment, false, 'the plain peer claims nothing')

  const started = await startComparison(d)
  const run = await settledFirstRound(d, started.id)
  assert.equal(run.state, 'running', run.reason ?? '')

  const view = await d.host.call('goal/read', { goal: run.goal }) as GoalView
  const lanes = (await d.host.call('lane/list', {}) as readonly Lane[]).filter((lane) => lane.goal === run.goal)
  const laneOf = (runtime: string) => {
    const seat = view.members.find((one) => one.session.runtime === runtime)
    assert.ok(seat, `the ${runtime} competitor was seated`)
    const lane = lanes.find((one) => one.seat === String(seat.id))
    assert.ok(lane, `the ${runtime} Seat holds a lane of its own`)
    assert.notEqual(lane.cwd, d.root, 'never the main checkout')
    assert.equal(seat.checkout.cwd, lane.cwd)
    return { seat, lane }
  }
  const mine = laneOf('claude-code')
  const theirs = laneOf('plain')
  assert.notEqual(mine.lane.cwd, theirs.lane.cwd)

  // Each conversation, as its runtime reports it, works in its own lane.
  for (const { seat, lane } of [mine, theirs]) {
    const session = await d.host.call('session/read', { runtime: runtimeId(seat.session.runtime), sessionId: sessionId(seat.session.sessionId) }) as Session
    assert.equal(session.settings?.cwd, lane.cwd)
  }

  // The Claude CLI the bridge spawned was handed its lane's values.
  const deadline = Date.now() + 10_000
  let seen: Record<string, string>[] = []
  while (Date.now() < deadline) {
    seen = (await readFile(envLog, 'utf8').catch(() => ''))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, string>)
    if (seen.some((one) => one.HARNESSDESK_LANE_ID === mine.lane.id)) break
    await new Promise((wake) => setTimeout(wake, 50))
  }
  const handed = seen.find((one) => one.HARNESSDESK_LANE_ID === mine.lane.id)
  assert.ok(handed, `the Claude CLI saw its lane: ${JSON.stringify(seen)}`)
  assert.equal(handed.HARNESSDESK_GOAL_ID, run.goal)
  assert.equal(handed.PORT, String(mine.lane.ports.start))
  assert.equal(handed.HARNESSDESK_PORT_END, String(mine.lane.ports.end))
  assert.equal(seen.some((one) => one.HARNESSDESK_LANE_ID === theirs.lane.id), false, 'no values crossed lanes')
  assert.doesNotMatch(await orderOf(d, 'claude-code', mine.seat.session.sessionId), /not set in your environment/)

  // The plain peer was told its own lane's values, and that it must pass them itself.
  const told = await orderOf(d, 'plain', theirs.seat.session.sessionId)
  assert.match(told, /They are not set in your environment, so give them to each command explicitly/)
  assert.match(told, new RegExp(`^HARNESSDESK_LANE_ID=${theirs.lane.id}$`, 'm'))
  assert.match(told, new RegExp(`^PORT=${theirs.lane.ports.start}$`, 'm'))
})

test('a round whose first Seat will not open stalls naming the sibling it held back, and the next step', { timeout: 60_000 }, async (t) => {
  // Card #1's runtime answers every conversation it is asked to open with an error.
  const claude = new AcpRuntime({ id: 'claude-code', name: 'Claude', command: process.execPath, args: [PLAIN_ACP], env: { FAKE_ACP_SERVER_ERROR: '1' } })
  const d = await deskWith(t, claude, plainPeer())

  const started = await startComparison(d)
  const run = await settledFirstRound(d, started.id)
  assert.equal(run.state, 'stalled')
  const reason = run.reason ?? ''
  assert.match(reason, /^The Seat for card #1 could not be opened: /)
  assert.match(reason, /\nA round’s cards start together, so card #2 was not started either\.\n/)
  assert.match(reason, /\nNext: fix what stopped card #1 and start the flow again, or seat an Agent in this Goal and give it the cards yourself\.$/)

  // Nothing is left open, in a lane or in the main checkout.
  const view = await d.host.call('goal/read', { goal: run.goal }) as GoalView
  assert.deepEqual(view.members.filter((one) => one.closed === null), [])
})
