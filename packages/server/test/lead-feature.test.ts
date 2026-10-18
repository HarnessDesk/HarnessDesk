import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { createLeadJournal } from '@harnessdesk/lead'
import { approvalId, parseLeadAcceptanceContract } from '@harnessdesk/protocol'
import { Host, StateStore } from '../src/index.js'
import { SeatBook } from '../src/evidence/seats.js'
import { LeadControls } from '../src/lead/controls.js'
import { evidenceDesk, writeAgent } from './fixtures/evidence-desk.js'
import { LeadBudgets } from '../src/lead/budgets.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const rig = (t: TestContext, leadEnabled?: boolean) => {
  const home = tempDir('hd-lead-feature-')
  const host = new Host({ logger: silent, state: new StateStore(join(home, 'state.json')), catalogRefreshMs: 0,
    ...(leadEnabled === undefined ? {} : { leadEnabled }) })
  t.after(() => host.dispose())
  return { host, home }
}
const unavailable = (error: any) => error.wireCode === 'lead-unavailable'

for (const enabled of [undefined, false]) test(`disabled host (${String(enabled)}) refuses a Lead owner before reading its ports`, async t => {
  const { host } = rig(t, enabled)
  let reads = 0
  const options = new Proxy({}, { get() { reads++; throw new Error('Lead service ports were read') } })
  assert.throws(() => host.createLeadService(options as any), unavailable)
  assert.throws(() => host.registerLead(options as any, options as any), unavailable)
  assert.equal(reads, 0)
  await host.start()
  assert.throws(() => host.createLeadService(options as any), unavailable)
  assert.throws(() => host.registerLead(options as any, options as any), unavailable)
  assert.equal(reads, 0)
})

for (const enabled of [undefined, false]) test(`disabled host (${String(enabled)}) leaves Lead listeners and recovery untouched`, async t => {
  const { host, home } = rig(t, enabled)
  const stale = join(home, 'lead-clients', 'hd-lead-ABC123')
  await mkdir(join(home, 'lead-clients'), { mode: 0o700 })
  await mkdir(stale, { mode: 0o700 })
  await writeFile(join(stale, 'old.sock'), '')
  let recoveries = 0
  t.mock.method(LeadBudgets.prototype, 'recover', async () => { recoveries++ })
  await host.start()
  assert.equal((await lstat(stale)).isDirectory(), true, 'disabled startup must not sweep a Lead listener')
  assert.equal(recoveries, 0)
  assert.equal((await host.call('host/hello', { clientVersion: 'test' }) as any).capabilities?.lead, undefined)
  let keyCalls = 0
  for (const name of ['leadStatus', 'resolveLead', 'storeLead', 'deleteLead'] as const) {
    t.mock.method(host.credentials, name, async () => { keyCalls++; throw new Error('credential port reached') })
  }
  const requests = [
    ['lead/thread/read', {}], ['lead/thread/send', { idempotencyKey: 'off', text: 'Inspect' }],
    ['lead/card/decide', { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: 'a'.repeat(64), choice: 'approve' }],
    ['lead/settings/read', {}], ['lead/settings/update', { expectedRevision: 0, credential: { provider: 'anthropic', key: 'synthetic-value' } }],
    ['lead/resume', { expectedRevision: 0 }], ['lead/stop', { expectedRevision: 0 }],
  ] as const
  for (const [method, params] of requests) await assert.rejects(host.call(method as never, params as never), unavailable, method)
  assert.equal(keyCalls, 0)
  assert.equal((await lstat(stale)).isDirectory(), true)
})

test('a default host creates no Lead directory or files', async t => {
  const { host, home } = rig(t)
  await host.start()
  assert.deepEqual((await readdir(home)).filter(name => /lead/i.test(name)), [])
  assert.equal(Object.hasOwn(await host.call('host/hello', { clientVersion: 'test' }), 'capabilities'), false)
})

test('only the explicitly enabled host advertises the Lead capability', async t => {
  const { host } = rig(t, true)
  const hello = await host.call('host/hello', { clientVersion: 'test' })
  assert.deepEqual((hello as any).capabilities, { lead: true })
})

for (const enabled of [false, true]) test(`the private Lead recipe is never in the Flow catalogue (enabled=${enabled})`, async t => {
  const { host } = rig(t, enabled)
  const project = tempDir('hd-lead-feature-project-')
  await host.start()
  await host.call('workspace/open', { path: project })
  const catalogue = await host.call('flow/catalog', { root: project })
  assert.ok(catalogue.length > 0, 'ordinary built-in Flows remain available')
  assert.equal(catalogue.some(entry => entry.id === 'lead-reviewed-result'), false)
})

test('an unrelated Team approval neither projects Lead nor invalidates a concurrent settings save', async t => {
  const { host, runtime, stateDir, repo } = await evidenceDesk(t, { leadEnabled: true })
  await writeAgent(stateDir)
  const goal = await host.call('goal/create', { root: repo.dir, sentence: 'Unrelated work' })
  const card = await host.call('team/add', { room: goal.goal.id, title: 'Inspect unrelated work' })
  const seat = await host.call('goal/seat', { goal: goal.goal.id, card: card.id, agent: 'scout' })
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'default', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'projection-test', caps: { usdMicros: 100, rounds: 3 }, freshnessMs: 1000 })
  t.mock.method(host.credentials, 'leadStatus', async () => ({ configured: false, protection: 'synthetic cipher' }))
  const service = host.createLeadService({ journal, project: { id: 'demo', path: repo.dir }, prices: {},
    resolveTool: async () => { throw new Error('unused') }, freezePlan: async proposal => proposal,
    readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }) })
  t.after(() => service.close())
  const changed = t.mock.method(LeadControls.prototype, 'workerApprovalsChanged')
  const before = await host.call('lead/settings/read', {})
  const live = runtime.sessions.get(seat.session.sessionId)!
  void live.askApproval(approvalId('unrelated-command'))
  await host.call('lead/thread/read', {})
  assert.equal(journal.state.seq, before.revision, 'an unrelated approval request leaves the journal unchanged')
  const resolved = live.respondToApproval(approvalId('unrelated-command'), { type: 'cancel' })
  const saved = await host.call('lead/settings/update', { expectedRevision: before.revision, name: 'lex' })
  await resolved
  assert.equal(changed.mock.callCount(), 0, 'only approvals from Lead-owned Seats push a Lead projection')
  assert.equal(journal.state.seq, before.revision + 1, 'only the name save advances the journal')
  assert.equal(saved.settings.name, 'lex')
})


test('a worker approval resolved after its Seat closes clears the window projection', async t => {
  const { host, runtime, stateDir, repo } = await evidenceDesk(t, { leadEnabled: true })
  await writeAgent(stateDir)
  const goal = await host.call('goal/create', { root: repo.dir, sentence: 'Owned work' })
  const card = await host.call('team/add', { room: goal.goal.id, title: 'Inspect owned work' })
  const seat = await host.call('goal/seat', { goal: goal.goal.id, card: card.id, agent: 'scout' })
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'default', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'projection-test', caps: { usdMicros: 100, rounds: 3 }, freshnessMs: 1000 })
  const state = journal.state
  const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Owned work', project: { id: 'demo', path: repo.dir }, policyRevision: 1,
    steps: [{ id: 'work', title: 'Work', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended',
      assignments: [{ role: 'implement', agent: 'scout', seat: { runtime: 'fake' }, ceiling: 'read' }] }],
    assertions: [{ id: 'review', kind: 'review', description: 'Reviewed' }], caps: { usdMicros: 100, rounds: 3 } })
  // This test isolates live approval projection from Flow execution/accounting.
  Object.defineProperty(journal, 'state', { get: () => ({ ...state, contract, runs: [{ runId: 'owned-run', teamId: goal.goal.id, correlationId: 'owned-start' }] }) })
  t.mock.method(host.credentials, 'leadStatus', async () => ({ configured: false, protection: 'synthetic cipher' }))
  const service = host.createLeadService({ journal, project: contract.project, prices: {},
    resolveTool: async () => { throw new Error('unused') }, freezePlan: async proposal => proposal,
    readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }) })
  t.after(() => service.close())
  let book!: SeatBook
  const all = SeatBook.prototype.all
  t.mock.method(SeatBook.prototype, 'all', function(this: SeatBook) { book = this; return all.call(this) })
  const changed = t.mock.method(LeadControls.prototype, 'workerApprovalsChanged')
  const pushes: any[] = []
  host.addBroadcaster(value => { if (value.method === 'lead/changed') pushes.push(value.params) })
  const live = runtime.sessions.get(seat.session.sessionId)!
  void live.askApproval(approvalId('owned-command'))
  await Promise.all(changed.mock.calls.map(call => call.result))
  assert.ok(pushes.at(-1)?.thread.cards.some((one: any) => one.kind === 'worker-approval'))
  await book.closeId(seat.id, 'Worker closed')
  assert.ok((await host.call('evidence/seat', seat.session))!.closed)
  const before = changed.mock.callCount()
  await live.respondToApproval(approvalId('owned-command'), { type: 'cancel' })
  await Promise.all(changed.mock.calls.map(call => call.result))
  assert.equal(changed.mock.callCount(), before + 1, 'resolution must re-project ownership even after close')
  assert.equal(pushes.at(-1)?.thread.cards.some((one: any) => one.kind === 'worker-approval'), false)
})
