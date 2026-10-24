import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { sessionId, type SessionSummary } from '@harnessdesk/protocol'
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
