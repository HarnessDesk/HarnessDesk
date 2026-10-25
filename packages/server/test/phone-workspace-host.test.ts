import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { approvalId, itemId, sessionId, turnId, type Session, type SessionSummary } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { SessionIndex } from '../src/session-index.js'
import { StateStore } from '../src/state.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/** A real host over a fake agent and an index seeded the way a desk's own is, asked the phone's way. */
const desk = async (t: TestContext) => {
  const root = tempDir('hd-phone-host-')
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false } })
  const row = (id: string, over: Partial<SessionSummary>): SessionSummary =>
    ({ runtime: runtime.info.id, id: sessionId(id), title: id, cwd: join(root, 'acme-api'), createdAt: 10, updatedAt: 20, status: { type: 'notLoaded' }, archived: false, ...over })
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.upsert(row('priced', { title: `Fix the sign-in for dev@example.com in ${root}/acme-api/src/auth.ts`, updatedAt: 30 }), { archived: false })
  index.upsert(row('free', { title: 'Tidy the settings page', updatedAt: 20 }), { archived: false })
  index.upsert(row('shelved', { title: 'Old idea', updatedAt: 10 }), { archived: true })
  index.upsert(row('seat', { title: 'A Team seat', updatedAt: 40 }), { archived: false, teamId: 'team-1' })
  index.close()
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  db.prepare('UPDATE sessions SET usage=? WHERE id=?').run(JSON.stringify({ total: { totalTokens: 5 }, last: { totalTokens: 5 }, cost: { amount: 0.75, currency: 'USD' } }), 'priced')
  db.close()
  // The price catalogue the ledger would otherwise fetch from the network: cached, fresh and empty.
  await mkdir(join(root, 'cache'), { recursive: true })
  await writeFile(join(root, 'cache', 'model-pricing.json'), JSON.stringify({ fetchedAt: Date.now(), catalogue: {} }))
  const host = new Host({ state: new StateStore(join(root, 'state.json')), logger: silent, builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') })
  host.register(runtime)
  await host.start()
  t.after(() => host.dispose())
  return { host, root, runtime }
}

test('the host lists the person’s own sessions for a phone, priced by the desk and named by the agent’s own presentation', async t => {
  const { host, root, runtime } = await desk(t)
  const list = await host.call('phone/sessions/list', {})
  assert.deepEqual(list.rows.map(one => [one.id, one.state, one.cost, one.seat]), [
    [`${runtime.info.id}:priced`, 'done', 0.75, runtime.info.presentation.name],
    [`${runtime.info.id}:free`, 'done', null, runtime.info.presentation.name],
  ])
  assert.equal(list.rows[0]!.title, 'Fix the sign-in for … in …')
  assert.deepEqual(list.counts, { running: 0, needsYou: 0, done: 2, archived: 1 })
  assert.equal(list.next, null)
  const text = JSON.stringify(list)
  assert.ok(!text.includes(root), 'no path of the desk’s own leaves in a response')
  assert.ok(!text.includes('@'))
  assert.deepEqual((await host.call('phone/sessions/list', { state: 'archived' })).rows.map(one => one.title), ['Old idea'])
})

test('the host answers an empty Teams list for a desk with no Team', async t => {
  const { host } = await desk(t)
  assert.deepEqual(await host.call('phone/teams/list', {}), { rows: [] })
})

test('the host answers the phone’s snapshot of the work in the phone’s own units, without a path or an address', async t => {
  const { host, root, runtime } = await desk(t)
  const snapshot = await host.call('workspace/read', {})
  assert.deepEqual(snapshot.items.map(one => [one.id, one.kind, one.phase, one.line, one.cost, one.agent]), [
    [`${runtime.info.id}:priced`, 'session', 'done', 'Done', { micros: 750_000 }, { name: runtime.info.presentation.name }],
    [`${runtime.info.id}:free`, 'session', 'done', 'Done', undefined, { name: runtime.info.presentation.name }],
  ])
  assert.equal(snapshot.items[0]!.title, 'Fix the sign-in for … in …')
  assert.equal(snapshot.items[0]!.project, undefined, 'a folder that is no repository names no project, in the list or in the conversation')
  assert.equal(snapshot.deskName, 'Desk')
  assert.deepEqual(snapshot.capabilities, { startSession: false, startTeam: false, reply: false, stop: false, delete: false, chooseModel: false, choosePermissions: false, attach: false, undo: false, decide: true })
  assert.deepEqual([snapshot.models, snapshot.flows, snapshot.commands, snapshot.threads], [[], [], [], []])
  // The usage scan may or may not have finished; when it has, it is seven days and no account.
  if (snapshot.usage) assert.equal(snapshot.usage.days.length, 7)
  const text = JSON.stringify(snapshot)
  assert.ok(!text.includes(root), 'no path of the desk’s own leaves in a response')
  assert.ok(!text.includes('@'))
})

test('the host reads one conversation for the phone as what was said and done, and nothing of the machine', async t => {
  const { host, root, runtime } = await desk(t)
  const cwd = join(root, 'acme-api')
  runtime.minted.set('priced', cwd)
  runtime.stored.set('priced', [{
    id: turnId('t1'), status: 'completed',
    items: [
      { id: itemId('u1'), type: 'userMessage', content: [{ type: 'text', text: `Fix ${cwd}/src/auth.ts for dev@example.com` }] },
      { id: itemId('c1'), type: 'command', command: 'pnpm test', cwd, origin: 'agent', status: 'completed', actions: [], output: `${cwd}/src/auth.ts failed`, exitCode: 0 },
      { id: itemId('a1'), type: 'assistantMessage', text: `All green in ${cwd}/src.`, phase: 'final' },
    ],
  }] as Session['turns'])
  const thread = await host.call('workspace/thread/read', { id: `${runtime.info.id}:priced` })
  assert.equal(thread.title, 'Fix the sign-in for … in …')
  assert.equal(thread.project, undefined)
  assert.equal(thread.status, 'done')
  assert.deepEqual(thread.turns.map(turn => turn.type), ['you', 'work', 'agent'])
  const text = JSON.stringify(thread)
  assert.ok(!text.includes(root), 'no path of the desk’s own leaves in a response')
  assert.ok(!text.includes('@'))
  assert.ok(!text.includes('auth.ts failed'), 'a command’s output stays on the desk')

  for (const id of [`${runtime.info.id}:shelved`, `${runtime.info.id}:seat`, `${runtime.info.id}:nope`, 'nope']) {
    await assert.rejects(host.call('workspace/thread/read', { id }), /not a session this desk can show/, id)
  }
})

test('the host lets a phone answer an approval through the window’s own path, and shows what it answered', async t => {
  const { host, root, runtime } = await desk(t)
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: join(root, 'acme-api') } })
  const id = `${runtime.info.id}:${created.id}`
  const live = runtime.sessions.get(created.id)!

  const asked = live.askApproval(approvalId('ap-deny'))
  const waiting = await host.call('workspace/thread/read', { id })
  assert.equal(waiting.status, 'asksYou')
  const turn = waiting.turns.at(-1)!
  assert.deepEqual(turn.type === 'approval' ? [turn.id, turn.state, turn.highRisk, turn.command, 'sessionGrant' in turn] : null, ['ap-deny', 'pending', true, 'rm -rf build', false])
  assert.equal((await host.call('workspace/read', {})).items.find(one => one.id === id)?.phase, 'needsYou')

  await assert.rejects(host.call('workspace/approval/decide', { id: 'ap-deny', session: id, allow: true, scope: 'session' }), /cannot be allowed for the whole session/)
  await assert.rejects(host.call('workspace/approval/decide', { id: 'unknown', session: id, allow: false }), /not waiting any more/)
  assert.deepEqual(await host.call('workspace/approval/decide', { id: 'ap-deny', session: id, allow: false, scope: 'once' }), {})
  assert.deepEqual(await asked, { type: 'option', optionId: 'opt-1' })
  const after = await host.call('workspace/thread/read', { id })
  assert.equal(after.status, 'done')
  assert.deepEqual(after.turns.map(one => one.type === 'approval' ? [one.id, one.state] : one.type), [['ap-deny', 'denied']])

  const allowed = live.askApproval(approvalId('ap-once'))
  await host.call('workspace/approval/decide', { id: 'ap-once', session: id, allow: true })
  assert.deepEqual(await allowed, { type: 'option', optionId: 'opt-0' })
})
