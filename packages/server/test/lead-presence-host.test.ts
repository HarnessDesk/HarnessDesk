import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { createLeadJournal, type LeadJournalRecord, type LeadPermissionContext } from '@harnessdesk/lead'
import { clientTierFor, parseLeadPresenceRead } from '@harnessdesk/protocol'
import { PHONE_POLICY } from '../src/phone-link.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'

/** The real host and its context with a journaled Lead; no child, model or vendor traffic. */
const rig = async (t: TestContext) => {
  const { StateStore } = await import('../src/index.js')
  const { tempDir } = await import('./scratch.js')
  const desk = await evidenceDesk(t, { leadEnabled: true, state: new StateStore(`${tempDir('hd-lead-presence-state-')}/state.json`) })
  const project = { id: 'project-demo', path: await realpath(desk.repo.dir) }
  const records: LeadJournalRecord[] = []
  const journal = await createLeadJournal({ read: async () => [], append: async record => { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', logicalGoalId: 'ordinary-delegation', now: Date.now(), caps: { usdMicros: 100000, rounds: 3 }, freshnessMs: 60000 })
  const context = (): LeadPermissionContext => ({ desk: journal.state.policy!, projectPolicy: null, project, approved: null, budget: null, now: Date.now(), policyInterpretation: 'idle' })
  const service = desk.host.createLeadService({ journal, project, prices: {},
    resolveTool: async () => ({ project, runId: null, start: null, stepId: null, context: context() }),
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }),
  })
  await service.setEnabled(true)
  return { ...desk, journal }
}
const window = { id: 'window:main', label: 'Desktop' }

test('presence methods answer through the host: a device is marked, the brief is off, an ask is tracked from the journal', async t => {
  const r = await rig(t)
  assert.deepEqual(await r.host.call('lead/brief/read', {}), { enabled: false, at: '07:30' })
  assert.deepEqual(await r.host.call('lead/brief/update', { enabled: true, at: '06:45' }), { enabled: true, at: '06:45' })
  await r.journal.appendReply('Start it?', undefined, { question: 'Start it?', options: [{ id: 'start', label: 'Start it' }, { id: 'later', label: 'Not now' }], recommended: 'start', expiresInMinutes: 30 })
  const view = await r.host.call('lead/presence/read', { device: window, active: true })
  assert.equal(view.digest, null)
  assert.equal(view.asks.length, 1)
  assert.equal(view.asks[0]!.status, 'open')
  assert.ok(view.asks[0]!.expiresAt! > Date.now())
  assert.deepEqual((await r.host.call('lead/presence/dismiss', { device: window, digest: 'nothing' })).digest, null)
  assert.throws(() => parseLeadPresenceRead({ device: { id: 'bad', label: 'x' }, active: true }), /window:<id> or phone:<id>/)
})

test('a phone may read presence and dismiss its own copy, but the brief setting stays on the desktop', () => {
  assert.equal(PHONE_POLICY.methods['lead/presence/read'], 'read')
  assert.equal(PHONE_POLICY.methods['lead/presence/dismiss'], 'read')
  assert.equal(PHONE_POLICY.methods['lead/brief/read'], 'read')
  assert.equal(PHONE_POLICY.methods['lead/brief/update'], undefined)
  assert.equal(PHONE_POLICY.topics.notices, 'read')
  assert.equal(clientTierFor('lead/presence/read'), null, 'the Lead’s own door does not carry presence')
})
