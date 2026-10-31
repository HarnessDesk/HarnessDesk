import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLeadJournal, type LeadJournalRecord } from '@harnessdesk/lead'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import { parseLeadAcceptanceContract, type PhoneLinkState, type WireNotification } from '@harnessdesk/protocol'
import { Logger } from '../src/log.js'
import { dispatch, type HostContext } from '../src/methods/index.js'
import { PHONE_POLICY, phoneLinkOff, startPhoneLink, type PhoneLinkControl } from '../src/phone-link.js'

test('repeat history, repeat controls and direct limit raises require their own phone tiers', () => {
  assert.equal(PHONE_POLICY.methods['lead/schedule/read'], 'read')
  assert.equal(PHONE_POLICY.methods['lead/repeat/control'], 'run')
  assert.equal(PHONE_POLICY.methods['lead/budget/raise'], 'answer')
  assert.equal(PHONE_POLICY.methods['lead/thread/read'], 'read')
  assert.equal(PHONE_POLICY.methods['lead/card/decide'], 'answer')
  assert.equal(PHONE_POLICY.methods['lead/settings/update'], undefined)
})

const project = { id: 'demo', path: '/workspace/demo' }
const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Inspect the check', project,
  policyRevision: 1, steps: [{ id: 'work', title: 'Review work', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture', model: 'fixture-model' }, ceiling: 'edit' }] }],
  assertions: [{ id: 'unit', kind: 'check', description: 'Tests pass' }, { id: 'review', kind: 'review', description: 'Review approves' }, { id: 'blockers', kind: 'blocking-findings', description: 'No blockers' }], caps: { usdMicros: 100000, rounds: 5 } })
const plan = { version: 1 as const, id: 'plan', revision: 1, type: 'plan' as const, contractDigest: contract.digest, contract }
const planClick = { version: 1 as const, cardId: 'plan', cardType: 'plan' as const, expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' as const }

/** The desk's Lead, over real controls and a fake model, reachable the way the host reaches it. */
const desk = async () => {
  const performed: unknown[] = []
  let personActions: any[] = [{ kind: 'worker-approval', id: 'worker', runId: 'run', role: 'code reviewer', request: 'read the git log', choices: ['yes-once', 'no'] }, { kind: 'check', id: 'check', runId: 'run', name: 'verify', command: 'node --test' }]
  const records: LeadJournalRecord[] = []
  const journal = await createLeadJournal({ async read() { return records }, async append(record: LeadJournalRecord) { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'default', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 1000 })
  const broadcasters = new Set<(n: WireNotification) => void>()
  const { LeadControls } = await import('../src/lead/controls.js')
  const controls = new LeadControls({
    journal, project, model: 'fixture-model', now: () => 100, nextId: () => `card-${Math.random()}`,
    service: { async status() { return { configured: true, protection: 'synthetic' } }, async setKey() {}, async deleteKey() {}, async assertPublic() {},
      async send() { return { status: 'completed', text: 'Ready to inspect' } } },
    push: (notification: WireNotification) => broadcasters.forEach(f => f(notification)),
    decidePerson: async () => {}, decideResult: async () => {},
    readPersonActions: async () => journal.state.contract ? personActions : [], performAction: async (input: any) => { if (!personActions.some(one => one.id === input.id)) throw Object.assign(new Error('stale'), { wireCode: 'lead-card-stale' }); performed.push({ id: input.id, choice: input.choice }); personActions = personActions.filter(one => one.id !== input.id) },
  } as never)
  let attached: PhoneLinkControl | null = null
  const ctx = {
    phone: { state: () => attached?.state() ?? phoneLinkOff, pairing: () => attached!.pairing(), allow: (...a: never[]) => (attached!.allow as any)(...a),
      deny: (id: string) => attached!.deny(id), revoke: (d: string) => attached!.revoke(d) },
    leadActionPerform: (p: unknown) => (controls as any).perform(p), leadThreadRead: () => controls.readThread(), leadThreadSend: (p: unknown) => controls.send(p as never), leadCardDecide: (p: unknown) => controls.decide(p as never),
    leadSettingsRead: () => controls.readSettings(), leadSettingsUpdate: (p: unknown) => controls.updateSettings(p as never),
    leadStop: (p: unknown) => controls.stop(p as never), leadResume: (p: unknown) => controls.resume(p as never),
  } as unknown as HostContext
  const host = {
    call: (method: string, params: unknown) => dispatch(ctx, method as never, params as never),
    addBroadcaster: (f: (n: WireNotification) => void) => { broadcasters.add(f); return () => { broadcasters.delete(f) } },
    attachPhoneLink: (control: PhoneLinkControl) => { attached = control },
  }
  return { host, journal, controls, ctx, performed }
}

const rig = async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-phone-server-'))
  const d = await desk()
  const running = await startPhoneLink(d.host as never, new Logger('test', { console: false }), { home, host: '127.0.0.1', includeLoopback: true, name: 'Test desk' })
  const pair = async () => {
    const code = running.control.pairing()
    const phone = await PhoneSim.fromCode(code.url)
    await phone.open(running.service.port, phone.offer!.deskPub)
    await phone.enroll(phone.offer!.enroll, 'Jane’s phone')
    for (let i = 0; i < 200 && running.control.state().pending.length === 0; i++) await new Promise(r => setTimeout(r, 10))
    running.control.allow(running.control.state().pending[0]!.id)
    await phone.next(m => m.t === 'enroll.ok')
    return phone
  }
  return { ...d, running, pair, done: async () => { await running.close(); await rm(home, { recursive: true, force: true }) } }
}

test('a paired phone reads and writes the Lead thread and gets its changes live', async () => {
  const s = await rig()
  try {
    const phone = await s.pair()
    const sent = await phone.request('lead/thread/send', { idempotencyKey: 'phone-1', text: 'Inspect the check' })
    assert.equal(sent.ok, true, JSON.stringify(sent))
    await s.controls.idle()
    const read = await phone.request('lead/thread/read')
    assert.deepEqual(read.result.thread.messages.map((m: any) => m.text), ['Inspect the check', 'Ready to inspect'])
    const changed = await phone.next(m => m.t === 'evt' && m.topic === 'lead')
    assert.equal(changed.data.version, 1)
    assert.ok(changed.seq >= 1)
    phone.close()
  } finally { await s.done() }
})

test('a phone decides a card, and a stale decision is refused with the Lead’s own code', async () => {
  const s = await rig()
  try {
    const phone = await s.pair()
    await s.journal.offerCard(plan)
    const stale = await phone.request('lead/card/decide', { ...planClick, expectedRevision: 0 })
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'lead-card-stale')
    const decided = await phone.request('lead/card/decide', planClick)
    assert.equal(decided.ok, true, JSON.stringify(decided))
    const again = await phone.request('lead/card/decide', planClick)
    assert.equal(again.error.code, 'lead-card-decided')
    phone.close()
  } finally { await s.done() }
})

test('a phone cannot reach settings, the window, or anything the table leaves out', async () => {
  const s = await rig()
  try {
    const phone = await s.pair()
    for (const method of ['lead/settings/update', 'phone/allow', 'phone/revoke', 'phone/pairing', 'flow/start-goal', 'session/start', 'host/hello', 'approval/respond', 'evidence/check/run']) {
      const reply = await phone.request(method, {})
      assert.equal(reply.error.code, 'notOnPhoneSurface', method)
    }
    const bad = await phone.request('lead/thread/send', { text: 7 })
    assert.equal(bad.error.code, 'badRequest')
    phone.close()
  } finally { await s.done() }
})

test('the window sees who is waiting and can remove a phone, which ends its session', async () => {
  const s = await rig()
  try {
    const states: PhoneLinkState[] = []
    s.running.control.onChange(() => states.push(s.running.control.state()))
    const phone = await s.pair()
    assert.ok(states.some(state => state.pending.length === 1))
    const state = await dispatch(s.ctx, 'phone/state', {})
    assert.equal(state.devices.length, 1)
    assert.equal(state.devices[0]!.name, 'Jane’s phone')
    assert.equal(JSON.stringify(state).includes('pushKey'), false)
    const after = await dispatch(s.ctx, 'phone/revoke', { device: state.devices[0]!.id })
    assert.equal(after.devices.length, 0)
    assert.equal((await phone.closedWith()).code, 4423)
  } finally { await s.done() }
})

test('with the phone link off, the window is told so', async () => {
  const d = await desk()
  const state = await dispatch(d.ctx, 'phone/state', {})
  assert.equal(state.enabled, false)
  assert.deepEqual(state.devices, [])
})

for (const choice of ['yes-once', 'no', 'run']) test(`paired phone performs person action ${choice} and replays are refused`, async () => {
  const s = await rig()
  try {
    await s.journal.offerCard(plan); await s.controls.decide(planClick)
    const phone = await s.pair()
    const params = { id: choice === 'run' ? 'check' : 'worker', contractDigest: contract.digest, choice }
    assert.equal((await phone.request('lead/action/perform', { ...params, choice: 'always' })).error.code, 'badRequest')
    const reply = await phone.request('lead/action/perform', params)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    assert.deepEqual(s.performed, [{ id: params.id, choice }])
    assert.equal((await phone.request('lead/action/perform', params)).error.code, 'lead-card-stale')
    const device = s.running.control.state().devices[0]!
    await s.running.control.revoke(device.id)
    assert.equal((await phone.closedWith()).code, 4423)
    phone.close()
  } finally { await s.done() }
})
