import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
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
  assert.equal((await runtime.readSession(session.id)).goal?.objective, 'finish the fixture')
  await session.setGoal(null)
  await until(() => events.some(event => event.type === 'session/goal' && event.goal === null))
  assert.equal((await runtime.readSession(session.id)).goal, null)
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
