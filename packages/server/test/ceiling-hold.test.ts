import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { runtimeId, SeatRefusedError, type ConfigOption, type OptionValue, type SeatPlan, type SeatRecord, type Session } from '@harnessdesk/protocol'

import { holdCeiling } from '../src/ceilings/hold.js'
import { unheldPolicy } from '../src/ceilings/policy.js'
import { Host, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { HOLD_CEILINGS, HoldFake } from './fixtures/hold-runtime.js'
import { tempDir } from './scratch.js'

const session = (habit: 'takes' | 'settlesElsewhere' | 'refuses') => {
  let sandbox = 'full'
  const options = (): ConfigOption[] => [
    {
      type: 'select', id: 'sandbox', label: 'Sandbox', currentValue: sandbox,
      choices: [
        { value: 'read-only', label: 'Read only' },
        { value: 'workspace', label: 'Workspace' },
        { value: 'full', label: 'Full access' },
      ],
    },
  ]
  return {
    options,
    setOption: async (_id: string, value: OptionValue) => {
      if (habit === 'refuses') throw new Error('a managed configuration forbids it')
      sandbox = habit === 'settlesElsewhere' ? 'full' : String(value)
    },
  }
}

test('a ceiling is held only when every control reads back as set, and asked — with why — when one does not', async () => {
  assert.deepEqual(await holdCeiling(session('takes'), 'read', HOLD_CEILINGS.read), {
    ceiling: { level: 'read', hold: 'held' }, how: 'Read-only sandbox', why: null,
  })
  assert.deepEqual(await holdCeiling(session('settlesElsewhere'), 'read', HOLD_CEILINGS.read), {
    ceiling: { level: 'read', hold: 'asked' }, how: null, why: 'Sandbox reads back as Full access, not Read only',
  })
  assert.deepEqual(await holdCeiling(session('refuses'), 'edit', HOLD_CEILINGS.edit), {
    ceiling: { level: 'edit', hold: 'asked' }, how: null,
    why: 'Sandbox could not be set to Workspace: a managed configuration forbids it',
  })
  let touched = false
  const untouched = { options: () => [], setOption: async () => void (touched = true) }
  assert.deepEqual(await holdCeiling(untouched, 'publish', undefined), {
    ceiling: { level: 'publish', hold: 'asked' }, how: null, why: null,
  })
  assert.equal(touched, false)
})

test('what this Mac does with a runtime that cannot hold a ceiling is its own setting, and seats and says so unless it says refuse', () => {
  assert.equal(unheldPolicy({}), 'seat')
  assert.equal(unheldPolicy({ unheldCeilings: { watched: 'refuse' } }), 'refuse')
  assert.equal(unheldPolicy({ unheldCeilings: { watched: 'seat' } }), 'seat')
  for (const stored of [null, 'refuse', { watched: 'never' }, { watched: true }, []]) {
    assert.equal(unheldPolicy({ unheldCeilings: stored }), 'seat', JSON.stringify(stored))
  }
})

const desk = async (t: TestContext) => {
  const stateDir = tempDir('hd-hold-state-')
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: tempDir('hd-hold-builtins-'),
    catalogRefreshMs: 0,
  })
  const holds = new HoldFake()
  const plain = new FakeRuntime()
  host.register(holds)
  host.register(plain)
  await host.start()
  t.after(() => host.dispose())
  const work = tempDir('hd-hold-work-')
  await host.call('workspace/open', { path: work })
  const agent = async (ceilingLine: string, prefer: string): Promise<void> => {
    await mkdir(join(stateDir, 'agents', 'reviewer'), { recursive: true })
    await writeFile(
      join(stateDir, 'agents', 'reviewer', 'AGENT.md'),
      `---\nname: Reviewer\n${ceilingLine}\nprefer: [${prefer}]\n---\nRead the diff.\n`,
      'utf8',
    )
  }
  const refuseUnheld = () => host.call('app/state/set', { patch: { unheldCeilings: { watched: 'refuse' } } })
  return { host, holds, plain, work, agent, refuseUnheld }
}

test('through the host: a read Agent on a runtime that can hold read is put in its read-only sandbox before its brief, and is held', async (t) => {
  const { host, holds, work, agent } = await desk(t)
  await agent('ceiling: read', 'holdfake')
  const seated = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.deepEqual(seated.settings?.ceiling, { level: 'read', hold: 'held' })
  assert.equal(seated.settings?.ceilingNote, 'Read-only sandbox')
  assert.equal(holds.held[0]?.sandbox, 'read-only')
  const [plan] = (await host.call('agent/seat/dry', { ids: ['reviewer'] })) as SeatPlan[]
  assert.deepEqual(plan?.ceiling, { level: 'read', hold: 'held' })
})

test('through the host: a control that settles elsewhere is only asked, and says why — never drawn as held', async (t) => {
  const { host, holds, work, agent } = await desk(t)
  holds.habit = 'settlesElsewhere'
  await agent('ceiling: edit', 'holdfake')
  const seated = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.deepEqual(seated.settings?.ceiling, { level: 'edit', hold: 'asked' })
  assert.equal(seated.settings?.ceilingNote, 'Sandbox reads back as Full access, not Workspace')
})

test('through the host: a runtime with no control seats as asked, and the dry run says so first', async (t) => {
  const { host, work, agent } = await desk(t)
  await agent('ceiling: read', 'fake')
  const [plan] = (await host.call('agent/seat/dry', { ids: ['reviewer'] })) as SeatPlan[]
  assert.deepEqual(plan?.ceiling, { level: 'read', hold: 'asked' })
  const seated = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.deepEqual(seated.settings?.ceiling, { level: 'read', hold: 'asked' })
  assert.equal(seated.settings?.ceilingNote, undefined)
})

test('through the host: a Mac that refuses unheld ceilings passes over every runtime that cannot hold one, before or after opening, and names each', async (t) => {
  const { host, holds, plain, work, agent, refuseUnheld } = await desk(t)
  await refuseUnheld()
  holds.habit = 'settlesElsewhere'
  await agent('ceiling: read', 'fake, holdfake')
  const [plan] = (await host.call('agent/seat/dry', { ids: ['reviewer'] })) as SeatPlan[]
  assert.deepEqual(plan?.candidates.map((one) => [one.state, one.reason]), [
    ['passed', { kind: 'unheld', level: 'read', detail: null }],
    ['taken', null],
  ])
  assert.deepEqual(plan?.candidates[0]?.fix, { kind: 'ceilings' })

  await assert.rejects(host.call('agent/seat', { id: 'reviewer', cwd: work }), (error: unknown) => {
    assert.ok(error instanceof SeatRefusedError)
    assert.deepEqual(error.wireData.candidates.map((one) => one.reason), [
      { kind: 'unheld', level: 'read', detail: null },
      { kind: 'unheld', level: 'read', detail: 'Sandbox reads back as Full access, not Read only' },
    ])
    assert.match(String((error as Error).message), /cannot hold read.*this Mac refuses a seat whose ceiling is only asked/)
    return true
  })
  assert.equal(plain.sessions.size, 0)
  assert.equal(holds.held.length, 1)
  const [opened] = holds.held
  assert.ok(opened)
  assert.equal(host.registry.get(runtimeId('holdfake'), opened.id), undefined)
})

test('unattended refuses before and after seating when not held', async (t) => {
  const { migrateDesk } = await import('../src/goals/migration.js')
  const { GoalStore } = await import('../src/goals/store.js')
  const { goal: goalOf } = await import('./fixtures/goals.js')
  const { unattendedPolicy } = await import('../src/ceilings/policy.js')
  // The unattended policy is its own setting and defaults to refuse; the watched setting never answers for it.
  assert.equal(unattendedPolicy({}), 'refuse')
  assert.equal(unattendedPolicy({ unheldCeilings: { watched: 'seat' } }), 'refuse')
  assert.equal(unattendedPolicy({ unheldCeilings: { unattended: 'seat' } }), 'seat')
  for (const stored of [null, 'seat', [], { unattended: 'always' }, { unattended: true }]) {
    assert.equal(unattendedPolicy({ unheldCeilings: stored }), 'refuse', JSON.stringify(stored))
  }

  // A trigger's Goal, as its persisted origin says — nothing a request can claim.
  const stateDir = tempDir('hd-hold-state-')
  const work = tempDir('hd-hold-work-')
  await migrateDesk(stateDir, async () => {})
  const store = new GoalStore(stateDir)
  await store.load()
  const triggerGoal = 'goal-00000000-0000-4000-8000-00000000000a'
  await store.save({
    version: 1, goal: goalOf(triggerGoal, { root: work, cwd: work, origin: { kind: 'trigger', trigger: 'review', event: 'a'.repeat(64) } }),
    board: { nextIntent: 1, messaging: true, intents: [], channel: [] }, citations: [], receipt: null, operation: null,
  }, null)
  const host = new Host({
    logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents: tempDir('hd-hold-builtins-'), catalogRefreshMs: 0,
  })
  const holds = new HoldFake()
  const plain = new FakeRuntime()
  host.register(holds)
  host.register(plain)
  await host.start()
  t.after(() => host.dispose())
  await host.call('workspace/open', { path: work })
  const agentFile = async (prefer: string): Promise<void> => {
    await mkdir(join(stateDir, 'agents', 'reviewer'), { recursive: true })
    await writeFile(join(stateDir, 'agents', 'reviewer', 'AGENT.md'), `---\nname: Reviewer\nceiling: read\nprefer: [${prefer}]\n---\nRead the diff.\n`, 'utf8')
  }
  const seat = () => host.call('goal/seat', { goal: triggerGoal, agent: 'reviewer' })

  // Absent preference: a runtime that cannot hold read is passed over before anything opens.
  await agentFile('fake')
  await assert.rejects(seat(), /cannot hold read.*this Mac refuses a seat whose ceiling is only asked/)
  assert.equal(plain.sessions.size, 0, 'no conversation was opened, so no turn was sent')
  // The watched setting says seat: an unattended Goal still refuses.
  await host.call('app/state/set', { patch: { unheldCeilings: { watched: 'seat' } } })
  await assert.rejects(seat(), /this Mac refuses a seat whose ceiling is only asked/)
  assert.equal(plain.sessions.size, 0)
  // A control that reads back as something else: opened, found unheld, and discarded before any turn.
  await agentFile('holdfake')
  holds.habit = 'settlesElsewhere'
  await assert.rejects(seat(), /this Mac refuses a seat whose ceiling is only asked/)
  assert.equal(holds.held.length, 1)
  assert.equal(host.registry.get(runtimeId('holdfake'), holds.held[0]!.id), undefined, 'the unheld conversation was not kept')

  // A person's own Goal on the same Mac still seats and says so: the watched policy is unchanged.
  await agentFile('fake')
  const personal = (await host.call('goal/create', { root: work, sentence: 'A person’s Goal' })) as { goal: { id: string } }
  const watched = (await host.call('goal/seat', { goal: personal.goal.id, agent: 'reviewer' })) as SeatRecord
  assert.deepEqual(watched.ceiling, { level: 'read', hold: 'asked' })

  // Only the person's explicit unattended choice seats an unattended Goal on an asked ceiling, and it says asked.
  await host.call('app/state/set', { patch: { unheldCeilings: { watched: 'seat', unattended: 'seat' } } })
  const asked = (await seat()) as SeatRecord
  assert.deepEqual(asked.ceiling, { level: 'read', hold: 'asked' })
})
