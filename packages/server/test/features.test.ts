import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, start, halt } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

// Keep these calls on a real socket: validation and notifications are part of the contract.
const read = 'app/features/read' as const
const set = 'app/features/set' as const

test('features toggle live, notify another client and persist explicit false over launch defaults', async t => {
  const home = tempDir('hd-features-')
  let desk = await start({ catalogRefreshMs: 0 }, home)
  t.after(async () => { await halt(desk) })
  const client = await Client.connect(desk.server), other = await Client.connect(desk.server)
  t.after(() => { client.close(); other.close() })
  assert.deepEqual(await client.call(read, {}), { lead: false, mobile: false })
  for (const enabled of [true, false, true, false]) {
    assert.deepEqual(await client.call(set, { feature: 'mobile', enabled }), { lead: false, mobile: enabled })
    assert.equal((await client.call('phone/state', {}) as any).enabled, enabled)
    if (!enabled) await assert.rejects(client.call('phone/pairing', {}), /phone-link-unavailable/)
  }
  await client.call(set, { feature: 'lead', enabled: true })
  assert.equal((await client.call('host/hello', { clientVersion: 'test' }) as any).capabilities.lead, true)
  await client.call(set, { feature: 'lead', enabled: false })
  await assert.rejects(client.call('lead/thread/read', {}), /lead-unavailable/)
  await other.until(() => other.notifications.some((n: any) => n.method === 'app/features/changed' && n.params.mobile))
  client.close(); other.close()
  await halt(desk)
  desk = await start({ catalogRefreshMs: 0, leadEnabled: true, mobileEnabled: true } as any, home)
  const again = await Client.connect(desk.server); t.after(() => again.close())
  assert.deepEqual(await again.call(read, {}), { lead: false, mobile: false })
})

test('feature wire rejects malformed parameters without changing the running state', async t => {
  const desk = await start({ catalogRefreshMs: 0 }, tempDir('hd-feature-validation-'))
  t.after(() => halt(desk))
  const client = await Client.connect(desk.server); t.after(() => client.close())
  for (const params of [{ feature: 'unknown', enabled: true }, { feature: 'lead', enabled: 1 }, { feature: 'mobile' }, null])
    await assert.rejects(client.call(set, params))
  assert.deepEqual(await client.call(read, {}), { lead: false, mobile: false })
})

test('feature save failure leaves the running mobile service off', async t => {
  const home = tempDir('hd-feature-save-'), desk = await start({ catalogRefreshMs: 0 }, home)
  t.after(() => halt(desk))
  await mkdir(join(home, 'features.json'))
  await assert.rejects(desk.host.call(set, { feature: 'mobile', enabled: true } as never))
  assert.equal((await desk.host.call('phone/state', {})).enabled, false)
})

test('concurrent feature changes serialize and persist the last choice', async t => {
  const home = tempDir('hd-feature-serial-'), desk = await start({ catalogRefreshMs: 0 }, home)
  t.after(() => halt(desk))
  const results = await Promise.all([true, false, true].map(enabled => desk.host.call(set, { feature: 'mobile', enabled } as never)))
  assert.deepEqual(results, [{ lead: false, mobile: true }, { lead: false, mobile: false }, { lead: false, mobile: true }])
  assert.equal(JSON.parse(await readFile(join(home, 'features.json'), 'utf8')).mobile, true)
})

test('Lead can close and reopen its saved journal repeatedly without losing its settings', async t => {
  const desk = await start({ catalogRefreshMs: 0 }, tempDir('hd-feature-lead-journal-'))
  t.after(() => halt(desk))
  await desk.host.call('workspace/open', { path: desk.stateDir })
  for (const enabled of [true, false, true, false, true]) {
    await desk.host.call(set, { feature: 'lead', enabled } as never)
    if (enabled) {
      const thread = await desk.host.call('lead/thread/read', {})
      assert.equal(thread.settings?.name, 'dex')
    }
  }
  assert.equal((await desk.host.call(read, {})).lead, true)
})

test('failed Mobile activation keeps the choice and running state off', async t => {
  const desk = await start({ catalogRefreshMs: 0, phoneLink: { host: '127.0.0.1', port: -1 } }, tempDir('hd-feature-mobile-fail-'))
  t.after(() => halt(desk))
  await assert.rejects(desk.host.call(set, { feature: 'mobile', enabled: true } as never))
  assert.deepEqual(await desk.host.call(read, {}), { lead: false, mobile: false })
  assert.equal((await desk.host.call('phone/state', {})).enabled, false)
})

test('Lead disable refuses success until owned Flow cleanup finishes, then can retry', async t => {
  const { createLeadJournal } = await import('@harnessdesk/lead')
  const desk = await start({ catalogRefreshMs: 0, leadEnabled: true }, tempDir('hd-feature-stop-fail-'))
  t.after(() => halt(desk))
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
  await journal.updateBudget({ version: 1, type: 'initialize', now: Date.now(), logicalGoalId: 'feature-stop', caps: { usdMicros: 100, rounds: 3 }, freshnessMs: 1000 })
  const state = journal.state
  t.mock.getter(journal, 'state', () => ({ ...state, runs: [{ runId: 'owned-run', teamId: 'owned-team', correlationId: 'owned-start' }] }))
  const run = { id: 'owned-run', state: 'running' }
  let attempts = 0
  t.mock.method(desk.host.flowsPlane, 'leadRuns', () => [run] as any)
  t.mock.method(desk.host.flowsPlane, 'interruptChecks', () => {})
  t.mock.method(desk.host.flowsPlane, 'stopRun', async () => {
    run.state = 'stopped'
    if (++attempts === 1) throw new Error('synthetic cleanup pending')
  })
  desk.host.createLeadService({ journal, project: { id: 'demo', path: desk.stateDir }, prices: {},
    resolveTool: async () => { throw Error('unused') }, freezePlan: async value => value, readEvidence: async () => { throw Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }) })
  await assert.rejects(desk.host.call(set, { feature: 'lead', enabled: false }), /lead-owned-work-stop-pending/)
  assert.equal((await desk.host.call(read, {})).lead, true)
  await assert.rejects(desk.host.call('lead/thread/read', {}), /lead-unavailable/)
  assert.equal((await desk.host.call(set, { feature: 'lead', enabled: false })).lead, false)
  assert.equal(attempts, 2)
})

test('Mobile close detaches listeners and retains paired devices across re-enable', async t => {
  const { PhoneSim } = await import('@harnessdesk/phone-link/sim')
  const { PhoneLinkService } = await import('@harnessdesk/phone-link')
  const desk = await start({ catalogRefreshMs: 0, phoneLink: { host: '127.0.0.1', includeLoopback: true } }, tempDir('hd-feature-pairing-'))
  t.after(() => halt(desk))
  const original = PhoneLinkService.prototype.onChange
  let subscriptions = 0
  t.mock.method(PhoneLinkService.prototype, 'onChange', function(this: import('@harnessdesk/phone-link').PhoneLinkService, listener: Parameters<typeof original>[0]) {
    subscriptions++
    const off = original.call(this, listener)
    let active = true
    return () => { if (active) { subscriptions--; active = false }; off() }
  })
  await desk.host.call(set, { feature: 'mobile', enabled: true })
  const pairing = await desk.host.call('phone/pairing', {}), state = await desk.host.call('phone/state', {})
  assert.equal(state.relay, 'off', 'local enable never turns account reachability on')
  const phone = await PhoneSim.fromCode(pairing.url)
  t.after(() => phone.close())
  await phone.open(state.port!, phone.offer!.deskPub)
  await phone.enroll(phone.offer!.enroll, 'Demo phone')
  let pending = await desk.host.call('phone/state', {})
  for (let i = 0; !pending.pending.length && i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    pending = await desk.host.call('phone/state', {})
  }
  assert.ok(pending.pending[0])
  await desk.host.call('phone/allow', { id: pending.pending[0].id })
  await phone.next(message => message.t === 'enroll.ok')
  const devices = (await desk.host.call('phone/state', {})).devices
  assert.equal(devices.length, 1)
  phone.close()
  await desk.host.call(set, { feature: 'mobile', enabled: false })
  assert.equal(subscriptions, 0, 'closed mobile services retain no change listeners')
  await desk.host.call(set, { feature: 'mobile', enabled: true })
  assert.deepEqual((await desk.host.call('phone/state', {})).devices.map(d => d.id), devices.map(d => d.id))
})

test('disabling Lead detaches its intake publication subscription before reopening', async t => {
  const { IntakePlane } = await import('../src/intake/plane.js')
  const follow = IntakePlane.prototype.followPullRequests
  let attached = 0
  t.mock.method(IntakePlane.prototype, 'followPullRequests', function(this: InstanceType<typeof IntakePlane>, port: Parameters<typeof follow>[0]) {
    attached++
    const off = follow.call(this, port)
    return () => { attached--; off?.() }
  })
  const desk = await start({ catalogRefreshMs: 0 }, tempDir('hd-feature-intake-'))
  t.after(() => halt(desk))
  await desk.host.call('workspace/open', { path: desk.stateDir })
  for (let i = 0; i < 2; i++) {
    await desk.host.call(set, { feature: 'lead', enabled: true })
    await desk.host.call('lead/thread/read', {})
    assert.equal(attached, 1)
    await desk.host.call(set, { feature: 'lead', enabled: false })
    assert.equal(attached, 0)
  }
})

test('interrupted Lead disable restores recovery before startup resume despite false launch default', async t => {
  const { writeFile } = await import('node:fs/promises')
  const { LeadBudgets } = await import('../src/lead/budgets.js')
  const { Flows } = await import('../src/flows.js')
  const home = tempDir('hd-feature-recover-'), calls: string[] = []
  await writeFile(join(home, 'features.json'), JSON.stringify({ pending: { previous: { lead: true, mobile: false }, feature: 'lead', enabled: false } }))
  t.mock.method(LeadBudgets.prototype, 'recover', async () => { calls.push('recover') })
  const resume = Flows.prototype.resume
  t.mock.method(Flows.prototype, 'resume', async function(this: InstanceType<typeof Flows>, ...args: Parameters<typeof resume>) {
    calls.push('resume'); return resume.apply(this, args)
  })
  const desk = await start({ catalogRefreshMs: 0, leadEnabled: false }, home)
  t.after(() => halt(desk))
  assert.equal((await desk.host.call(read, {})).lead, true)
  assert.ok(calls.indexOf('recover') >= 0 && calls.indexOf('recover') < calls.indexOf('resume'))
})

test('feature choices stay off the phone and agent tool surfaces', async () => {
  const { clientTierFor } = await import('@harnessdesk/protocol')
  const { PHONE_POLICY } = await import('../src/phone-link.js')
  for (const method of [read, set]) {
    assert.equal(clientTierFor(method), null)
    assert.equal(PHONE_POLICY.methods[method], undefined)
  }
})
