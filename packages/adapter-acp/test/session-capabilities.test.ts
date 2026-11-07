import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentSession, AgentRuntime } from '@harnessdesk/protocol'
import { AcpRuntime } from '../src/index.js'
import { goalUpdate, supportsGoals, supportsSteering } from '../src/session-controls.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
const make = (env: Record<string, string> = {}) => new AcpRuntime({
  id: 'session-peer', name: 'Session peer', command: process.execPath, args: [FAKE], env,
})
const until = async (predicate: () => boolean) => {
  const end = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out waiting for peer')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const finish = async (events: AgentEvent[], session: AgentSession, text: string) => {
  const id = await session.send([{ type: 'text', text }])
  await until(() => events.some(event => event.type === 'turn/completed' && event.sessionId === session.id && event.turn.id === id))
}

test('fork is negotiated and opens an independent conversation with its source history', async t => {
  const runtime = make({ FAKE_ACP_FORK: '1' })
  t.after(() => runtime.dispose())
  assert.equal(runtime.info.capabilities.fork, false)
  await runtime.start()
  assert.equal(runtime.info.capabilities.fork, true)
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  const source = await runtime.createSession({ cwd: '/tmp' })
  await finish(events, source, 'remember this')
  const fork = await (runtime as AgentRuntime).forkSession(source.id)
  assert.notEqual(fork.id, source.id)
  const snapshot = await runtime.readSession(fork.id)
  assert.equal(snapshot.forkedFrom, source.id)
  assert.equal(snapshot.turns.length, 1)
  await finish(events, fork, 'fork only')
  assert.equal((await runtime.readSession(fork.id)).turns.length, 2)
  assert.equal((await runtime.readSession(source.id)).turns.length, 1)
  await finish(events, source, 'source still works')
})

test('undeclared and null fork capabilities refuse without opening a branch', async t => {
  for (const env of [{}, { FAKE_ACP_FORK: 'null' }] as Record<string, string>[]) {
    const runtime = make(env)
    t.after(() => runtime.dispose())
    await runtime.start()
    assert.equal(runtime.info.capabilities.fork, false)
    const source = await runtime.createSession({ cwd: '/tmp' })
    await assert.rejects((runtime as AgentRuntime).forkSession(source.id), /does not support forking/)
  }
})

test('an isolated fork connection never replaces the source connection', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-fork-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runtime = make({ FAKE_ACP_FORK: '1', FAKE_ACP_NO_CLOSE: '1', FAKE_ACP_STORE: join(dir, 'store.json') })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const source = await runtime.createSession({ cwd: dir })
  await finish(events, source, 'persist before fork')
  const fork = await runtime.forkSession(source.id)
  await finish(events, source, 'source connection still owns this id')
  await finish(events, fork, 'fork connection owns its id')
  assert.equal((await runtime.readSession(source.id)).turns.length, 2)
  assert.equal((await runtime.readSession(fork.id)).turns.length, 2)
})

test('a fork inherits the approved filter under its own staging key', async t => {
  const runtime = make({ FAKE_ACP_FORK: '1', FAKE_ACP_ATTACHMENTS: '1' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const source = await runtime.createSession({ cwd: '/tmp', attachments: { key: 'source-filter', skills: [], mcp: null } })
  const fork = await runtime.forkSession(source.id)
  const receipt = await runtime.attachmentReceipt(fork.id)
  assert.notEqual(receipt.key, 'source-filter', 'closing the fork must not remove its source staging directory')
  await fork.close()
  assert.equal((await runtime.attachmentReceipt(source.id)).key, 'source-filter')
})

test('steering injects into one running turn and keeps its input and completion', async t => {
  const runtime = make({ FAKE_ACP_STEER: '1' })
  t.after(() => runtime.dispose())
  assert.equal(runtime.info.capabilities.steer, false)
  await runtime.start()
  assert.equal(runtime.info.capabilities.steer, true)
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  const session = await runtime.createSession({ cwd: '/tmp' })
  const id = await session.send([{ type: 'text', text: 'wait for steer' }])
  await until(() => events.some(event => event.type === 'item/started' && event.sessionId === session.id))
  await session.steer([{ type: 'text', text: 'take this direction' }])
  await until(() => events.some(event => event.type === 'turn/completed' && event.turn.id === id))
  assert.equal(events.filter(event => event.type === 'turn/started').length, 1)
  const snapshot = await runtime.readSession(session.id)
  assert.equal(snapshot.turns.length, 1)
  assert.match(JSON.stringify(snapshot.turns[0]), /take this direction/)
  await assert.rejects(session.steer([{ type: 'text', text: 'idle' }]), /running turn/)
})

test('steering promptRequired races fall back to a tracked prompt', async t => {
  const runtime = make({ FAKE_ACP_STEER: 'race' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  const session = await runtime.createSession({ cwd: '/tmp' })
  await session.send([{ type: 'text', text: 'wait for steer' }])
  await until(() => events.some(event => event.type === 'item/started'))
  await session.steer([{ type: 'text', text: 'continue after race' }])
  await until(() => events.filter(event => event.type === 'turn/completed').length === 2)
  assert.equal((await runtime.readSession(session.id)).turns.length, 2)
})

test('goals negotiate the versioned control and project set and clear updates', async t => {
  const runtime = make({ FAKE_ACP_GOALS: '1' })
  t.after(() => runtime.dispose())
  await runtime.start()
  assert.equal(runtime.info.capabilities.goals, true)
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  const session = await runtime.createSession({ cwd: '/tmp' })
  assert.ok(session.setGoal)
  await session.setGoal('finish the fixture')
  await until(() => events.some(event => event.type === 'session/goal' && event.goal?.objective === 'finish the fixture'))
  await until(() => events.filter(event => event.type === 'turn/completed').length === 1)
  assert.equal((await runtime.readSession(session.id)).goal?.objective, 'finish the fixture')
  await session.setGoal(null)
  await until(() => events.some(event => event.type === 'session/goal' && event.goal === null))
  await until(() => events.filter(event => event.type === 'turn/completed').length === 2)
  assert.equal((await runtime.readSession(session.id)).goal, null)
  assert.deepEqual((await runtime.readSession(session.id)).turns.map(turn => turn.status), ['completed', 'completed'])
})

test('a goal that races the running turn uses a tracked continuation', async t => {
  const runtime = make({ FAKE_ACP_GOALS: '1', FAKE_ACP_STEER: 'race' })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp' })
  await session.send([{ type: 'text', text: 'wait for steer' }])
  await until(() => events.some(event => event.type === 'item/started'))
  await session.setGoal!('keep working')
  await until(() => events.filter(event => event.type === 'turn/completed').length === 2)
  const snapshot = await runtime.readSession(session.id)
  assert.equal(snapshot.goal?.objective, 'keep working')
  assert.equal(snapshot.turns.length, 2)
  assert.equal(snapshot.turns[1]!.items[0]!.type, 'notice', 'a control command is not recorded as user speech')
})

test('unadvertised controls stay off and unsupported features stay off', async t => {
  const runtime = make()
  t.after(() => runtime.dispose())
  await runtime.start()
  for (const capability of ['steer', 'goals', 'undo', 'compaction', 'memory', 'review', 'hooks', 'metered', 'mcp'] as const) {
    assert.equal(runtime.info.capabilities[capability], false, capability)
  }
  const session = await runtime.createSession({ cwd: '/tmp' })
  await assert.rejects(session.steer([{ type: 'text', text: 'no' }]), /cannot steer/)
  assert.equal((await runtime.loadout(session.id, '/tmp')).mcp.reported, false)
})

test('untrusted goal states and unknown extension versions are refused', () => {
  const goal = { objective: 'fixture', status: ['active'], controlMethod: '_session/goal' }
  assert.equal(goalUpdate({ jetbrains: { air: { goal } } }), undefined)
  assert.equal(supportsGoals({ jetbrains: { air: { goal: { version: 2, controlMethod: '_session/goal', actions: ['set', 'clear'] } } } }), false)
  assert.equal(supportsSteering({ steering: { supported: 'true' } }), false)
})

for (const native of [false, true]) {
  for (const readFrom of ['source', 'options'] as const) {
    test(`a fork retains its ${readFrom} read ceiling with native enforcement ${native}`, async t => {
      const dir = mkdtempSync(join(tmpdir(), 'acp-fork-read-'))
      t.after(() => rmSync(dir, { recursive: true, force: true }))
      const opens = join(dir, 'opens.jsonl')
      const runtime = make({ FAKE_ACP_FORK: '1', FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_OPENS: opens,
        ...(native ? { FAKE_ACP_READ_CEILING: '1' } : {}) })
      t.after(() => runtime.dispose())
      const events: AgentEvent[] = []
      runtime.subscribe(event => events.push(event))
      await runtime.start()
      const source = await runtime.createSession({ cwd: dir, ...(readFrom === 'source' ? { requestedCeiling: 'read' } : {}) })
      const fork = await runtime.forkSession(source.id, { requestedCeiling: readFrom === 'options' ? 'read' : 'edit' })
      const opened = readFileSync(opens, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(row => row.method === 'session/fork')
      assert.equal(opened._meta?.harnessdesk?.ceiling, native ? 'read' : undefined)
      let approvals = 0
      let live = fork
      runtime.subscribe(event => {
        if (event.type === 'approval/requested') {
          approvals++
          void live.respondToApproval(event.approval.id, { type: 'option', optionId: 'yes' })
        }
      })
      const refuse = async () => {
        for (const kind of ['edit', 'execute']) {
          await finish(events, live, `ceiling permission ${JSON.stringify({ toolCallId: `fork-${kind}`, kind })}`)
          const turn = (await runtime.readSession(live.id)).turns.at(-1)!
          assert.ok(turn.items.some(item => item.type === 'assistantMessage' && item.text === 'denied.'), kind)
        }
        assert.equal(approvals, 0)
      }
      await refuse()
      if (!native) {
        await finish(events, fork, 'persist read fork')
        await fork.close()
        live = await runtime.resumeSession(fork.id)
        await refuse()
      }
    })
  }
}

test('a busy source refuses a fork before sending session/fork', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-busy-fork-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const opens = join(dir, 'opens.jsonl')
  const runtime = make({ FAKE_ACP_FORK: '1', FAKE_ACP_OPENS: opens })
  t.after(() => runtime.dispose())
  await runtime.start()
  const source = await runtime.createSession({ cwd: dir })
  await source.send([{ type: 'text', text: 'wait for steer' }])
  await assert.rejects(runtime.forkSession(source.id), /running turn/)
  assert.ok(!readFileSync(opens, 'utf8').includes('session/fork'))
})

for (const state of ['running', 'completed']) {
  test(`a source turn ${state} during session/fork refuses and closes the fork`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-fork-race-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const opens = join(dir, 'opens.jsonl'), gate = join(dir, 'release'), closes = join(dir, 'closed')
    const runtime = make({ FAKE_ACP_FORK: '1', FAKE_ACP_OPENS: opens, FAKE_ACP_FORK_GATE: gate, FAKE_ACP_CLOSES: closes })
    t.after(() => runtime.dispose())
    const events: AgentEvent[] = []
    runtime.subscribe(event => events.push(event))
    await runtime.start()
    const source = await runtime.createSession({ cwd: dir })
    const forking = runtime.forkSession(source.id)
    const refused = assert.rejects(forking, /source.*changed|running turn/)
    await until(() => existsSync(opens) && readFileSync(opens, 'utf8').includes('session/fork'))
    const forkId = JSON.parse(readFileSync(opens, 'utf8').trim().split('\n').find(line => line.includes('session/fork'))!).sessionId
    if (state === 'running') await source.send([{ type: 'text', text: 'wait for steer' }])
    else await finish(events, source, 'a whole turn before fork answers')
    writeFileSync(gate, 'release')
    await refused
    assert.ok(existsSync(closes) && readFileSync(closes, 'utf8').split('\n').includes(forkId), 'the unused fork is closed')
    assert.ok(!events.some(event => event.type === 'session/started' && event.session.id === forkId))
  })
}

test('an idle goal returns on acceptance while its turn is still running', async t => {
  const runtime = make({ FAKE_ACP_GOALS: '1', FAKE_ACP_GOAL_LIFECYCLE: 'pending' })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp' })
  let accepted = false
  const setting = session.setGoal!('keep running').then(() => { accepted = true }, () => {})
  await until(() => events.some(event => event.type === 'session/goal'))
  assert.equal(accepted, true, 'setting the goal does not wait for its turn')
  assert.equal((await runtime.readSession(session.id)).turns[0]!.status, 'inProgress')
  await session.interrupt()
  await setting
})

test('an accepted goal turn failure stays internal and is recorded as failed', async t => {
  const runtime = make({ FAKE_ACP_GOALS: '1', FAKE_ACP_GOAL_LIFECYCLE: 'fail' })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp' })
  const setting = session.setGoal!('eventually fails').then(() => 'accepted', () => 'rejected')
  await until(() => events.some(event => event.type === 'turn/completed'))
  assert.equal(await setting, 'accepted')
  assert.equal((await runtime.readSession(session.id)).turns[0]!.status, 'failed')
})

test('interrupting an idle goal records interrupted when the bridge replies with an empty object', async t => {
  const runtime = make({ FAKE_ACP_GOALS: '1', FAKE_ACP_GOAL_LIFECYCLE: 'pending' })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp' })
  const setting = session.setGoal!('interrupt this goal').catch(() => {})
  await until(() => events.some(event => event.type === 'session/goal'))
  await session.interrupt()
  await setting
  await until(() => events.some(event => event.type === 'turn/completed'))
  assert.equal((await runtime.readSession(session.id)).turns[0]!.status, 'interrupted')
})

test('steering continues after the earlier goal fails in the promptRequired race', async t => {
  const runtime = make({ FAKE_ACP_GOALS: '1', FAKE_ACP_GOAL_LIFECYCLE: 'pending', FAKE_ACP_STEER: 'goal-failure-race' })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp' })
  const setting = session.setGoal!('old failing goal').catch(() => {})
  await until(() => events.some(event => event.type === 'session/goal'))
  await session.steer([{ type: 'text', text: 'continue with this input' }])
  await setting
  await until(() => events.filter(event => event.type === 'turn/completed').length === 2)
  assert.deepEqual((await runtime.readSession(session.id)).turns.map(turn => turn.status), ['failed', 'completed'])
})
