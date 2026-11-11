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
    probeRuntime: async () => ({ supported: true }),
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

test('#2105: the question an automatic report asks is in the inbox, a phone tap answers it, and every surface reads the same receipt', async t => {
  const r = await rig(t)
  const report = { finding: 'The fourth chat ended before its report.', caveat: 'I read only part of it.', ask: 'Let it read the reason and write a report?',
    options: [{ id: 'read', label: 'Read the reason' }, { id: 'later', label: 'Not now' }], recommended: 'read' }
  await r.journal.appendReply(`${report.finding}\n${report.caveat}\n${report.ask}`, report)
  const id = r.journal.state.messages.at(-1)!.id
  const before = await r.host.call('lead/inbox/read', {})
  assert.deepEqual(before.items.filter(item => item.kind === 'ask').map(item => [item.id, item.title]), [[`ask:${id}`, report.ask]])
  assert.equal(before.needsYou, 1)
  const phone = { id: 'phone:p1', label: 'Jane’s iPhone' }
  t.mock.method(r.host.credentials, 'leadStatus', async () => ({ configured: true, protection: 'synthetic cipher' }))
  t.mock.method(r.host.credentials, 'resolveLead', async () => 'fixture-key')
  await r.host.call('lead/thread/send', { idempotencyKey: 'tap-1', text: 'Not now', ask: id, device: phone })
  const onDesktop = await r.host.call('lead/presence/read', { device: window, active: true })
  const onPhone = await r.host.call('lead/presence/read', { device: phone, active: true })
  const asked = onDesktop.asks.find(one => one.id === id)!
  assert.equal(asked.status, 'answered')
  assert.equal(asked.answer?.by, 'Jane’s iPhone')
  assert.deepEqual(onPhone.asks.find(one => one.id === id), asked, 'the phone and the window read one receipt')
  const after = await r.host.call('lead/inbox/read', {})
  assert.deepEqual(after.items.filter(item => item.kind === 'ask'), [], 'an answered question leaves the inbox')
  await assert.rejects(r.host.call('lead/thread/send', { idempotencyKey: 'tap-2', text: 'Read the reason', ask: id, device: window }),
    (error: Error & { wireCode?: string }) => error.wireCode === 'lead-ask-answered')
})
