import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import {
  runtimeId,
  type FlowExecution, type FlowPolicy, type FrontDoorPreview, type GoalView, type Intent, type RuntimeInfo, type SeatRecord,
  type TriggerArmPreview, type TriggerView,
} from '@harnessdesk/protocol'

import { Host, StateStore } from '../src/index.js'
import { builtinFlowRoot } from '../src/host.js'
import { parseFlowPolicy } from '../src/flow-policy.js'
import { writeShape } from '../src/authoring/model.js'
import { silent } from './fixtures/harness.js'
import { HoldFake } from './fixtures/hold-runtime.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { tempDir } from './scratch.js'

/*
 * The complete front door, on a real Host: a fresh desk with one runtime that
 * can hold a ceiling gets independent-review's three specialists as actual
 * held Seats, an asked-only runtime is refused truthfully with nothing
 * opened, a custom shape saved through authoring survives being re-read and
 * started, and a trigger's Save is disarmed until the same file is committed.
 *
 * A real temp git repository stands in for the project — real commits, so
 * every revision a round hands to the next is one git actually reports —
 * but nothing here reaches a real vendor: both runtimes are fakes, and the
 * "forge" a trigger reads is never asked to poll anything live.
 */

const exec = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', ['-C', cwd, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])).stdout.trim()

/** One Agent's file, and which fake runtime id it prefers. */
interface AgentSpec {
  readonly ceiling: string
  readonly runtime: string
}

const REVIEW_AGENTS: Readonly<Record<string, AgentSpec>> = {
  implementer: { ceiling: 'edit', runtime: 'hold-a' },
  'security-reviewer': { ceiling: 'read', runtime: 'hold-b' },
  'performance-reviewer': { ceiling: 'read', runtime: 'hold-b' },
  'api-reviewer': { ceiling: 'read', runtime: 'hold-b' },
}

const repo = async (): Promise<string> => {
  const dir = tempDir('hd-front-door-accept-repo-')
  await git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'README.md'), 'hello\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

/** A held-capable fake with its own id and vendor — `independentOf` reads the vendor, not the id, so two seats "holding the same runtime" still need to differ here to count as independent. */
const heldRuntime = (id: string, provider: string): HoldFake => {
  const runtime = new HoldFake(id)
  ;(runtime as { info: RuntimeInfo }).info = { ...runtime.info, provider }
  return runtime
}

const desk = async (t: TestContext, runtimes: readonly (HoldFake | FakeRuntime)[], agents: Readonly<Record<string, AgentSpec>>) => {
  const stateDir = tempDir('hd-front-door-accept-state-')
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: tempDir('hd-front-door-accept-builtins-'),
    catalogRefreshMs: 0,
  })
  for (const runtime of runtimes) host.register(runtime)
  await host.start()
  t.after(() => host.dispose())
  for (const [id, spec] of Object.entries(agents)) {
    await mkdir(join(stateDir, 'agents', id), { recursive: true })
    await writeFile(
      join(stateDir, 'agents', id, 'AGENT.md'),
      `---\nname: ${id}\nceiling: ${spec.ceiling}\nanswers: [approve, request-changes]\nprefer: [${spec.runtime}]\n---\nDo the ${id} part.\n`,
      'utf8',
    )
  }
  const work = await repo()
  await host.call('workspace/open', { path: work })
  return { host, work }
}

/** The common single-runtime case the other three tests use. */
const soloDesk = async (t: TestContext, runtimeName: 'holdfake' | 'fake', agents: Readonly<Record<string, string>>) => {
  const runtime = runtimeName === 'holdfake' ? new HoldFake('holdfake') : new FakeRuntime({ id: runtimeId('fake') })
  const specs = Object.fromEntries(Object.entries(agents).map(([id, ceiling]) => [id, { ceiling, runtime: runtimeName }]))
  const { host, work } = await desk(t, [runtime], specs)
  return { host, runtime, work }
}

/** A short, bounded poll — every runtime here is a fake with no real I/O delay. */
const waitUntil = async <T>(read: () => Promise<T | null>, what: string): Promise<T> => {
  const deadline = Date.now() + 10_000
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`nothing became ${what} in time`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const board = async (host: Host, goal: string): Promise<readonly Intent[]> => (await host.call('goal/read', { goal }) as GoalView).board.intents

const claimedOf = async (host: Host, goal: string, role: string, count: number): Promise<readonly Intent[]> =>
  waitUntil(async () => {
    const cards = (await board(host, goal)).filter((one) => one.role === role && one.state !== 'done')
    return cards.length === count && cards.every((one) => one.state === 'claimed') ? cards : null
  }, `${count} claimed ${role} card(s)`)

/** A person step's card: never claimed by a Seat, so it waits for "open", not "claimed". */
const personCardOf = async (host: Host, goal: string, role: string): Promise<Intent> =>
  waitUntil(async () => (await board(host, goal)).find((one) => one.role === role && one.state !== 'done') ?? null, `the ${role} card`)

const REVIEW_SOURCE = async (): Promise<string> => readFile(join(builtinFlowRoot(), 'independent-review.yml'), 'utf8')

test('a fresh desk with held-capable runtimes gives independent-review its build Seat and all three specialist Seats, actually held', async (t) => {
  const holdA = heldRuntime('hold-a', 'vendor-a')
  const holdB = heldRuntime('hold-b', 'vendor-b')
  const { host, work } = await desk(t, [holdA, holdB], REVIEW_AGENTS)
  const source = await REVIEW_SOURCE()

  const preview = await host.call('authoring/start/preview', { context: { kind: 'project', root: work }, source, vars: { task: 'Ship the thing' } }) as FrontDoorPreview
  assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
  const build = preview.flow.seats.find((one) => one.role === 'build')
  const specialists = preview.flow.seats.filter((one) => one.role === 'specialists')
  assert.equal(specialists.length, 3, 'three specialist slots — security, performance and API — each its own seat')
  assert.deepEqual(build?.plan.ceiling, { level: 'edit', hold: 'held' })
  for (const one of specialists) assert.deepEqual(one.plan.ceiling, { level: 'read', hold: 'held' })

  const run = await host.call('flow/start-goal', { root: work, source, token: preview.flow.token!, sentence: 'Ship the thing', vars: { task: 'Ship the thing' } }) as FlowExecution
  assert.equal(run.requireHeld, true)

  const [buildCard] = await claimedOf(host, run.goal, 'build', 1)
  await git(work, 'checkout', '-q', '-b', 'work')
  await writeFile(join(work, 'attempt.txt'), 'built\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-q', '-m', 'built')
  await host.call('team/intent', { room: run.goal, id: buildCard!.id, action: 'done', outcome: 'approve' } as never)

  const specialistCards = await claimedOf(host, run.goal, 'specialists', 3)
  for (const card of specialistCards) await host.call('team/intent', { room: run.goal, id: card.id, action: 'done', outcome: 'approve' } as never)

  const shipCard = await personCardOf(host, run.goal, 'ship')
  await host.call('team/intent', { room: run.goal, id: shipCard.id, action: 'done', outcome: 'shipped' } as never)

  const settled = await waitUntil(async () => {
    const now = await host.call('flow/execution', { run: run.id }) as FlowExecution
    return now.state === 'settled' ? now : null
  }, 'settled')
  assert.equal(settled.rounds.map((one) => one.role).filter((one) => one === 'specialists').length, 1, 'one round of three, not three rounds')

  const view = await host.call('goal/read', { goal: run.goal }) as { members: readonly SeatRecord[] }
  const heldMembers = view.members.filter((one) => one.ceiling?.hold === 'held')
  assert.equal(heldMembers.length, 4, 'build plus three specialists — every Seat this run opened held its ceiling')
})

test('the same shape on a runtime that can only be asked is refused truthfully, and nothing is opened', async (t) => {
  const { host, work } = await soloDesk(t, 'fake', {
    implementer: 'edit', 'security-reviewer': 'read', 'performance-reviewer': 'read', 'api-reviewer': 'read',
  })
  const source = await REVIEW_SOURCE()

  const preview = await host.call('authoring/start/preview', { context: { kind: 'project', root: work }, source, vars: { task: 'Ship the thing' } }) as FrontDoorPreview
  assert.equal(preview.flow.token, null, 'a runtime that cannot hold mints no start token')
  const specialists = preview.flow.seats.filter((one) => one.role === 'specialists')
  assert.equal(specialists.length, 3)
  for (const one of specialists) {
    assert.deepEqual(one.plan.candidates.map((c) => c.reason), [{ kind: 'unheld', level: 'read', detail: null, required: true }])
  }

  // The ordinary (non-front-door) dry run still seats it, asked — proving the
  // refusal above is the front door's own policy, not a runtime failure.
  const ordinary = await host.call('flow/preview', { root: work, source, vars: { task: 'Ship the thing' } }) as { token: string | null; seats: readonly { role: string; plan: { ceiling: { hold: string } | null } }[] }
  assert.ok(ordinary.token)
  assert.equal(ordinary.seats.find((one) => one.role === 'specialists')?.plan.ceiling?.hold, 'asked')
})

test('a custom shape saved through authoring survives a fresh read, a fresh preview and a start — byte and semantic identity, no hardcoded shape', async (t) => {
  const { host, work } = await soloDesk(t, 'holdfake', { implementer: 'edit' })
  const policy: FlowPolicy = {
    version: 2,
    name: 'My own shape',
    inputs: [{ id: 'task', label: 'Task' }],
    messaging: 'board-only',
    wait: 240,
    roles: [
      { id: 'writer', kind: 'agent', uses: ['implementer'], seats: [], isolate: false, grant: 'edit', independentOf: [] },
      { id: 'done', kind: 'person', outcomes: ['shipped'] },
    ],
    rules: [{ id: 'to-done', on: 'writer', then: { role: 'done', title: 'Ship it' } }],
    seed: { role: 'writer', title: '{{task}}' },
  }
  // The one host call the ordered editor and its graph both render through.
  const rendered = await host.call('authoring/shape/render', { policy }) as { source: string; issues: readonly unknown[] }
  assert.deepEqual(rendered.issues, [])
  // A save always writes the budget a run would stop at, the default included.
  const expectedPolicy = { ...policy, budget: { rounds: 3, withoutProgress: 2 } }
  assert.deepEqual(parseFlowPolicy(rendered.source).document?.flow, expectedPolicy, 'the rendered YAML parses back to the exact policy')
  assert.equal(rendered.source, writeShape(policy), 'the wire call and the model function agree')

  const target = { kind: 'flow' as const, origin: 'project' as const, id: 'my-shape', root: work }
  const preview = await host.call('authoring/save/preview', { target, expected: null, source: rendered.source }) as { token: string | null; issues: readonly unknown[] }
  assert.ok(preview.token, JSON.stringify(preview.issues))
  const saved = await host.call('authoring/save/apply', { token: preview.token! }) as { state: string; written: readonly string[] }
  assert.equal(saved.state, 'applied')
  assert.deepEqual(saved.written, ['.harnessdesk/flows/my-shape.yml'])

  // Reopen it exactly as the front door would: the catalogue, then its source.
  const catalogue = await host.call('flow/catalog', { root: work }) as readonly { id: string; origin: string }[]
  const entry = catalogue.find((one) => one.id === 'my-shape' && one.origin === 'project')
  assert.ok(entry, 'the saved shape joins the project catalogue')
  const reopened = await host.call('flow/source', { root: work, id: 'my-shape' }) as string
  assert.equal(reopened, rendered.source, 'reading it back is the exact bytes that were saved')

  const started = await host.call('authoring/start/preview', { context: { kind: 'project', root: work }, source: reopened, vars: { task: 'Write it' } }) as FrontDoorPreview
  assert.ok(started.flow.token, JSON.stringify(started.flow.problems))
  const run = await host.call('flow/start-goal', { root: work, source: reopened, token: started.flow.token!, sentence: 'Write it', vars: { task: 'Write it' } }) as FlowExecution
  assert.deepEqual(run.document.format === 'agents' ? run.document.flow : null, expectedPolicy, 'the run itself carries the exact original policy')
})

test('Every time saves disarmed; the identical file, once committed, is what the existing Arm preview consents to', async (t) => {
  const { host, work } = await soloDesk(t, 'holdfake', { reviewer: 'read' })
  const draft = await host.call('authoring/triggers/draft', { id: 'nightly', on: 'schedule', opens: { agent: 'reviewer' } })
  const rendered = await host.call('authoring/triggers/render', { definitions: [draft] }) as { source: string; issues: readonly unknown[] }
  assert.deepEqual(rendered.issues, [])
  assert.match(rendered.source, /every: 60/, 'a fresh schedule draft starts disarmed at 60 minutes')

  const target = { kind: 'triggers' as const, origin: 'project' as const, root: work }
  const preview = await host.call('authoring/save/preview', { target, expected: null, source: rendered.source }) as { token: string | null; issues: readonly unknown[] }
  assert.ok(preview.token, JSON.stringify(preview.issues))
  const saved = await host.call('authoring/save/apply', { token: preview.token! }) as { state: string }
  assert.equal(saved.state, 'applied')

  // Uncommitted: Intake's own arming preview refuses, because only the
  // committed bytes are ever a candidate for consent.
  const beforeCommit = await host.call('trigger/preview', { root: work, id: 'nightly' }) as TriggerArmPreview
  assert.equal(beforeCommit.token, null)
  assert.equal(beforeCommit.workingCopyChanged, true)

  await git(work, 'add', '.harnessdesk/triggers.yml')
  await git(work, 'commit', '-q', '-m', 'declare the nightly trigger')

  const afterCommit = await host.call('trigger/preview', { root: work, id: 'nightly' }) as TriggerArmPreview
  assert.ok(afterCommit.token, JSON.stringify(afterCommit.problems))
  assert.equal(afterCommit.workingCopyChanged, false)
  const armed = await host.call('trigger/arm', { root: work, id: 'nightly', token: afterCommit.token! }) as TriggerView
  assert.equal(armed.state, 'armed')
})
