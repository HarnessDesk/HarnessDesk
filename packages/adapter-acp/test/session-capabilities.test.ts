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

for (const isolatedBy of ['no-close', 'git-environment'] as const) {
  for (const closeFirst of ['source', 'fork'] as const) {
    test(`fork uses the source connection under ${isolatedBy} and survives closing ${closeFirst}`, async t => {
      const runtime = new AcpRuntime({
        id: 'session-peer', name: 'Session peer', command: process.execPath, args: [FAKE],
        env: { FAKE_ACP_FORK: '1', ...(isolatedBy === 'no-close' ? { FAKE_ACP_NO_CLOSE: '1' } : {}) },
        ...(isolatedBy === 'git-environment' ? { gitEnvironment: async () => ({ FAKE_GIT_SCOPE: 'source' }) } : {}),
      })
      t.after(() => runtime.dispose())
      const events: AgentEvent[] = []
      runtime.subscribe(event => events.push(event))
      await runtime.start()
      const source = await runtime.createSession({ cwd: '/tmp' })
      await finish(events, source, 'ephemeral source history')
      const fork = await runtime.forkSession(source.id)
      assert.equal(runtime.connectionFor(source.id), runtime.connectionFor(fork.id))
      await finish(events, source, 'source still owns its id')
      await finish(events, fork, 'fork owns its id')
      await (closeFirst === 'source' ? source : fork).close()
      const survivor = closeFirst === 'source' ? fork : source
      await finish(events, survivor, 'sibling process survives release')
      assert.equal((await runtime.readSession(survivor.id)).turns.at(-1)!.status, 'completed')
    })
  }
}

test('concurrent sibling closes reap their shared fork worker', async t => {
  const runtime = make({ FAKE_ACP_FORK: '1', FAKE_ACP_NO_CLOSE: '1' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const source = await runtime.createSession({ cwd: '/tmp' })
  const fork = await runtime.forkSession(source.id)
  const connection = runtime.connectionFor(source.id)
  await Promise.all([source.close(), fork.close()])
  assert.equal(connection.alive, false)
})

test('a failed fork request never stops the source worker', async t => {
  const runtime = make({ FAKE_ACP_FORK: '1', FAKE_ACP_NO_CLOSE: '1', FAKE_ACP_FORK_ERROR: '1' })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const source = await runtime.createSession({ cwd: '/tmp' })
  await assert.rejects(runtime.forkSession(source.id), /fork refused/)
  await finish(events, source, 'source survives refusal')
  assert.equal((await runtime.readSession(source.id)).turns.at(-1)!.status, 'completed')
})

for (const isolatedBy of ['no-close', 'git-environment'] as const) {
  for (const refused of [false, true]) {
    test(`closing a source during a pending ${refused ? 'refused' : 'persisted'} fork preserves ${isolatedBy} worker ownership`, async t => {
      const dir = mkdtempSync(join(tmpdir(), 'acp-fork-release-'))
      t.after(() => rmSync(dir, { recursive: true, force: true }))
      const opens = join(dir, 'opens.jsonl'), gate = join(dir, 'release'), store = join(dir, 'store.json')
      const runtime = new AcpRuntime({
        id: 'session-peer', name: 'Session peer', command: process.execPath, args: [FAKE],
        env: { FAKE_ACP_FORK: '1', FAKE_ACP_OPENS: opens, FAKE_ACP_FORK_GATE: gate, FAKE_ACP_STORE: store, ...(isolatedBy === 'no-close' ? { FAKE_ACP_NO_CLOSE: '1' } : {}), ...(refused ? { FAKE_ACP_FORK_ERROR: '1' } : {}) },
        ...(isolatedBy === 'git-environment' ? { gitEnvironment: async () => ({ FAKE_GIT_SCOPE: 'source' }) } : {}),
      })
      t.after(() => runtime.dispose())
      const events: AgentEvent[] = []
      runtime.subscribe(event => events.push(event))
      await runtime.start()
      const source = await runtime.createSession({ cwd: dir })
      const connection = runtime.connectionFor(source.id)
      const result = runtime.forkSession(source.id).then(fork => ({ fork, error: undefined }), error => ({ fork: undefined, error }))
      try {
        await until(() => existsSync(opens) && readFileSync(opens, 'utf8').includes(refused ? 'session/fork/refused' : 'session/fork'))
        const entry = JSON.parse(readFileSync(opens, 'utf8').trim().split('\n').find(line => line.includes(refused ? 'session/fork/refused' : 'session/fork'))!)
        if (!refused) await until(() => {
          try { return Object.hasOwn(JSON.parse(readFileSync(store, 'utf8')), entry.sessionId) } catch { return false }
        })
        await source.close()
        assert.equal(connection.alive, true, 'the pending fork still owns the source worker')
        writeFileSync(gate, 'release')
        const outcome = await result
        if (refused) {
          assert.match(String(outcome.error), /fork refused/)
          assert.equal(connection.alive, false, 'the last failed open reaps its unowned worker')
          const stored = existsSync(store) ? Object.keys(JSON.parse(readFileSync(store, 'utf8'))) : []
          assert.ok(stored.every(id => id === source.id), 'the refusal creates no branch')
        } else {
          assert.ifError(outcome.error)
          const fork = outcome.fork!
          assert.equal(fork.id, entry.sessionId)
          await finish(events, fork, 'surviving fork remains usable')
          await fork.close()
          assert.equal(connection.alive, false)
        }
      } finally {
        writeFileSync(gate, 'release')
        await result
      }
    })
  }
}

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

test('busy goals preserve structured set and clear independently of steering', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-goal-control-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const requests = join(dir, 'goals.jsonl')
  const runtime = make({ FAKE_ACP_GOALS: '1', FAKE_ACP_STEER: '1', FAKE_ACP_GOAL_REQUESTS: requests })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const session = await runtime.createSession({ cwd: dir })
  const turn = await session.send([{ type: 'text', text: 'wait for steer' }])
  await until(() => events.some(event => event.type === 'item/started'))
  await session.setGoal!('clear')
  assert.equal((await runtime.readSession(session.id)).goal?.objective, 'clear')
  assert.equal((await runtime.readSession(session.id)).turns[0]!.status, 'inProgress')
  await session.setGoal!('keep working')
  await session.setGoal!(null)
  assert.deepEqual(readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [
    { sessionId: session.id, action: 'set', objective: 'clear' },
    { sessionId: session.id, action: 'set', objective: 'keep working' },
    { sessionId: session.id, action: 'clear' },
  ])
  assert.equal((await runtime.readSession(session.id)).goal, null)
  await session.steer([{ type: 'text', text: 'finish' }])
  await until(() => events.some(event => event.type === 'turn/completed' && event.turn.id === turn))
  assert.equal((await runtime.readSession(session.id)).turns.length, 1)
})

test('a structured goal racing the prompt completion keeps its continuation tracked', async t => {
  const runtime = make({ FAKE_ACP_GOALS: 'race', FAKE_ACP_STEER: 'race' })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp' })
  await session.send([{ type: 'text', text: 'wait for steer' }])
  await until(() => events.some(event => event.type === 'item/started'))
  await session.setGoal!('keep working')
  await until(() => events.some(event => event.type === 'turn/completed'))
  const snapshot = await runtime.readSession(session.id)
  assert.equal(snapshot.goal?.objective, 'keep working')
  assert.equal(snapshot.turns.length, 1)
  assert.equal(snapshot.turns[0]!.status, 'completed')
  assert.match(JSON.stringify(snapshot.turns[0]!.items), /structured goal continuation/)
})

test('interrupting a structured goal continuation preserves interruption after the original prompt ends', async t => {
  const runtime = make({ FAKE_ACP_GOALS: 'race', FAKE_ACP_STEER: 'race', FAKE_ACP_GOAL_LIFECYCLE: 'pending' })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp' })
  await session.send([{ type: 'text', text: 'wait for steer' }])
  await until(() => events.some(event => event.type === 'item/started'))
  const setting = session.setGoal!('keep working')
  await until(() => events.some(event => event.type === 'item/delta' && event.delta.kind === 'assistantText' && event.delta.text.includes('structured goal continuation')))
  assert.equal((await runtime.readSession(session.id)).turns[0]!.status, 'inProgress')
  await session.interrupt()
  await setting
  await until(() => events.some(event => event.type === 'turn/completed'))
  assert.equal((await runtime.readSession(session.id)).turns[0]!.status, 'interrupted')
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
  test(`a source turn ${state} during session/fork returns the durable branch with a history warning`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-fork-race-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const opens = join(dir, 'opens.jsonl'), gate = join(dir, 'release'), closes = join(dir, 'closed')
    const runtime = make({ FAKE_ACP_FORK: '1', FAKE_ACP_OPENS: opens, FAKE_ACP_FORK_GATE: gate, FAKE_ACP_CLOSES: closes, FAKE_ACP_STORE: join(dir, 'store.json') })
    t.after(() => runtime.dispose())
    const events: AgentEvent[] = []
    runtime.subscribe(event => events.push(event))
    await runtime.start()
    const source = await runtime.createSession({ cwd: dir })
    const forking = runtime.forkSession(source.id)
    await until(() => existsSync(opens) && readFileSync(opens, 'utf8').includes('session/fork'))
    const forkId = JSON.parse(readFileSync(opens, 'utf8').trim().split('\n').find(line => line.includes('session/fork'))!).sessionId
    if (state === 'running') await source.send([{ type: 'text', text: 'wait for steer' }])
    else await finish(events, source, 'a whole turn before fork answers')
    writeFileSync(gate, 'release')
    const fork = await forking
    assert.equal(fork.id, forkId)
    assert.ok(!existsSync(closes), 'the created branch is kept live')
    assert.ok(events.some(event => event.type === 'session/started' && event.session.id === forkId))
    assert.ok(events.some(event => event.type === 'notice' && event.sessionId === forkId && /source.*changed/i.test(event.message)))
    const snapshot = await runtime.readSession(fork.id)
    assert.equal(snapshot.partialHistory, true)
    assert.equal(snapshot.turns.length, 0, 'the adapter does not claim a transcript whose fork point is unknown')
    assert.ok((await runtime.listSessions()).data.some(row => row.id === fork.id))
    await finish(events, fork, 'the returned branch works')
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


test('a rejected fork option returns the durable branch and reports the unapplied setting', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-fork-option-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runtime = make({ FAKE_ACP_FORK: '1', FAKE_ACP_STORE: join(dir, 'store.json') })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const source = await runtime.createSession({ cwd: dir })
  const fork = await runtime.forkSession(source.id, { options: { voice: 'invalid' } })
  assert.ok(events.some(event => event.type === 'session/started' && event.session.id === fork.id))
  assert.ok(events.some(event => event.type === 'notice' && event.sessionId === fork.id && /voice.*invalid/i.test(event.message)))
  assert.ok((await runtime.listSessions()).data.some(row => row.id === fork.id))
  await finish(events, fork, 'returned fork is usable')
  assert.equal((await runtime.readSession(fork.id)).turns.at(-1)!.status, 'completed')
})

test('an unacknowledged fork environment returns a visible branch that cannot run', async t => {
  const runtime = make({ FAKE_ACP_FORK: '1', FAKE_ACP_ENVIRONMENT: '1' })
  t.after(() => runtime.dispose())
  const events: AgentEvent[] = []
  runtime.subscribe(event => events.push(event))
  await runtime.start()
  const source = await runtime.createSession({ cwd: '/tmp' })
  const fork = await runtime.forkSession(source.id, { environment: {
    HARNESSDESK_GOAL_ID: 'g1', HARNESSDESK_LANE_ID: 'lane-30000',
    HARNESSDESK_PORT_START: '30000', HARNESSDESK_PORT_END: '30019', HARNESSDESK_PORT_COUNT: '20', PORT: '30000',
  } })
  assert.ok(events.some(event => event.type === 'session/started' && event.session.id === fork.id))
  assert.equal((await runtime.readSession(fork.id)).status.type, 'error')
  await assert.rejects(fork.send([{ type: 'text', text: 'must not run' }]), /did not acknowledge/)
})
