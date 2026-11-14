import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:net'
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
  assert.equal((await desk.host.call(read, {})).problem?.kind, 'transition')
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
  await assert.rejects(desk.host.call(set, { feature: 'lead', enabled: false }), /Repair feature settings/)
  assert.equal((await desk.host.call(read, {})).lead, true)
  await assert.rejects(desk.host.call('lead/thread/read', {}), /lead-unavailable/)
  assert.equal((await desk.host.call('app/features/repair', {})).lead, false)
  assert.ok(attempts >= 2)
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

test('interrupted Lead disable fences admission pending explicit repair despite false launch default', async t => {
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
  assert.equal((await desk.host.call(read, {})).problem?.kind, 'transition')
  assert.equal(calls.includes('recover'), false, 'an uncertain lifetime is not automatically restored')
  await assert.rejects(desk.host.call('lead/thread/read', {}), /lead-unavailable/)
})

test('feature choices stay off the phone and agent tool surfaces', async () => {
  const { clientTierFor } = await import('@harnessdesk/protocol')
  const { PHONE_POLICY } = await import('../src/phone-link.js')
  for (const method of [read, set, 'app/features/repair']) {
    assert.equal(clientTierFor(method), null)
    assert.equal(PHONE_POLICY.methods[method], undefined)
  }
})

test('disable drains an admitted tick and prevents its continuation from reaching a reopened lifetime', async t => {
  const { LeadRepeats } = await import('../src/lead/repeats.js')
  const { LeadPresenceStore } = await import('../src/lead/presence.js')
  const desk = await start({ catalogRefreshMs: 0 }, tempDir('hd-feature-tick-drain-'))
  t.after(() => halt(desk))
  await desk.host.call('workspace/open', { path: desk.stateDir })
  await desk.host.call(set, { feature: 'lead', enabled: true })
  await desk.host.call('lead/thread/read', {})
  let entered!: () => void, release!: () => void
  const inside = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  t.mock.method(LeadRepeats.prototype, 'tick', async () => { entered(); await held })
  let briefs = 0
  t.mock.method(LeadPresenceStore.prototype, 'tick', async () => { briefs++; return false })
  const ticking = desk.host.leadTick(); await inside
  let disabled = false
  const disabling = desk.host.call(set, { feature: 'lead', enabled: false }).then(() => { disabled = true })
  await new Promise(resolve => setTimeout(resolve, 80))
  const stoppedBeforeRelease = disabled
  release(); await ticking; await disabling
  await desk.host.call(set, { feature: 'lead', enabled: true })
  assert.equal(stoppedBeforeRelease, false, 'disable waits for admitted work to leave the old lifetime')
  assert.equal(briefs, 0, 'the held tick cannot continue to the old or new presence owner')
})

for (const damage of ['json', 'directory'] as const) test(`ordinary desk opens with ${damage} feature damage and explicit repair preserves it and stops owned work`, async t => {
  const { writeFile, readdir } = await import('node:fs/promises')
  const { Flows } = await import('../src/flows.js')
  const home = tempDir('hd-feature-repair-wire-'), file = join(home, 'features.json')
  if (damage === 'json') await writeFile(file, '{damaged')
  else await mkdir(file)
  const stopped: string[] = []
  t.mock.method(Flows.prototype, 'leadRuns', () => [{ id: 'owned-demo-run', goal: 'demo-team', state: 'running' }] as any)
  t.mock.method(Flows.prototype, 'interruptChecks', () => {})
  t.mock.method(Flows.prototype, 'stopRun', async (id: string) => { stopped.push(id) })
  const desk = await start({ catalogRefreshMs: 0, leadEnabled: true, mobileEnabled: true }, home)
  t.after(() => halt(desk))
  const client = await Client.connect(desk.server); t.after(() => client.close())
  const snapshot = await client.call(read, {}) as any
  assert.equal(snapshot.lead, false); assert.equal(snapshot.mobile, false)
  assert.equal(snapshot.problem.kind, 'preferences')
  const chat = await desk.host.call('session/create', { runtime: desk.runtime.info.id, options: { cwd: home } })
  assert.ok(chat.id, 'ordinary chats remain available')
  await assert.rejects(client.call(set, { feature: 'mobile', enabled: true }), /Repair/)
  assert.deepEqual(await client.call('app/features/repair', {}), { lead: false, mobile: false })
  assert.deepEqual(stopped, ['owned-demo-run'])
  assert.ok((await readdir(home)).some(name => name.startsWith('features.json.preserved-')))
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { lead: false, mobile: false })
})


for (const finish of ['disable', 'repair'] as const) test(`partial Lead creation retains its failure and lease until ${finish} drains host owners`, async t => {
  const { IntakePlane } = await import('../src/intake/plane.js')
  const { LeadService } = await import('../src/lead/service.js')
  const { LeadFileJournal } = await import('../src/lead/journal.js')
  const home = tempDir('hd-feature-partial-lead-'), desk = await start({ catalogRefreshMs: 0 }, home)
  t.after(() => halt(desk))
  await desk.host.call('workspace/open', { path: desk.stateDir })
  await desk.host.call(set, { feature: 'lead', enabled: true })
  const failure = new Error('synthetic follow registration failure'), follow = IntakePlane.prototype.followPullRequests
  let attempts = 0, subscriptions = 0
  t.mock.method(IntakePlane.prototype, 'followPullRequests', function(this: InstanceType<typeof IntakePlane>, ...args: Parameters<typeof follow>) {
    if (++attempts === 1) throw failure
    return follow.apply(this, args)
  })
  const create = desk.host.createLeadService
  t.mock.method(desk.host, 'createLeadService', function(this: typeof desk.host, options: Parameters<typeof create>[0]) {
    const onChange = options.journal.onChange.bind(options.journal)
    t.mock.method(options.journal, 'onChange', (listener: Parameters<typeof onChange>[0]) => {
      subscriptions++
      const off = onChange(listener)
      return () => { subscriptions--; off() }
    })
    return create.call(this, options)
  })
  await assert.rejects(desk.host.call('lead/thread/read', {}), error => error === failure)
  assert.ok(subscriptions > 0, 'failure happens after host owners and listeners were registered')
  await assert.rejects(desk.host.call('lead/thread/read', {}), error => error === failure)
  assert.equal(attempts, 1)
  await assert.rejects(LeadFileJournal.open(home, 'desk'), /lead-journal-open-refused/)
  const close = LeadService.prototype.close
  let entered!: () => void, release!: () => void
  const inside = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  t.mock.method(LeadService.prototype, 'close', async function(this: InstanceType<typeof LeadService>) {
    entered(); await held; return close.call(this)
  })
  const closing = finish === 'disable' ? desk.host.call(set, { feature: 'lead', enabled: false }) : desk.host.call('app/features/repair', {})
  await inside
  try {
    assert.ok(subscriptions > 0, 'listeners remain owned while the service drains')
    await assert.rejects(LeadFileJournal.open(home, 'desk'), /lead-journal-open-refused/)
  } finally { release() }
  await closing
  assert.equal(subscriptions, 0, 'all partial owners detach before the journal reopens')
  const storage = await LeadFileJournal.open(home, 'desk')
  await storage.close()
  await desk.host.call(set, { feature: 'lead', enabled: true })
  assert.equal((await desk.host.call('lead/thread/read', {})).settings?.name, 'dex')
  assert.equal(attempts, 2, 're-enable builds one fresh service after draining the failed one')
})

// Hold the actual atomic replacement; in-memory state alone cannot prove lifetime isolation.
const holdRename = (t: TestContext, file: string) => {
  const rename = fs.rename
  let entered!: () => void, release!: () => void, once = true
  const inside = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === file && once) { once = false; entered(); await held }
    return rename(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { release(); mocked.mock.restore(); syncBuiltinESMExports() })
  return { inside, release }
}

for (const owner of ['presence', 'autonomy'] as const) test(`Lead Off drains the actual ${owner} rename before replacement`, async t => {
  const home = tempDir('hd-feature-lead-write-'), desk = await start({ catalogRefreshMs: 0 }, home)
  t.after(() => halt(desk))
  await desk.host.call('workspace/open', { path: home })
  await desk.host.call(set, { feature: 'lead', enabled: true })
  await desk.host.call('lead/thread/read', {})
  // Settle assembly/background writes before interposing this specific direct mutation.
  await desk.host.call('lead/brief/update', { at: '07:30' })
  await desk.host.call('lead/autonomy/set', { kind: 'brief', mode: 'off' })
  const hold = holdRename(t, join(home, 'lead', `${owner}.json`))
  const updating = owner === 'presence' ? desk.host.call('lead/brief/update', { at: '08:45' })
    : desk.host.call('lead/autonomy/set', { kind: 'brief', mode: 'observe' })
  await hold.inside
  let disabled = false
  const disabling = desk.host.call(set, { feature: 'lead', enabled: false }).then(() => { disabled = true })
  await new Promise(resolve => setTimeout(resolve, 80))
  const early = disabled
  hold.release(); await updating; await disabling
  await desk.host.call(set, { feature: 'lead', enabled: true })
  await desk.host.call('lead/thread/read', {})
  if (owner === 'presence') {
    assert.equal((await desk.host.call('lead/brief/read', {})).at, '08:45')
    await desk.host.call('lead/brief/update', { at: '09:15' })
    assert.equal(JSON.parse(await readFile(join(home, 'lead/presence.json'), 'utf8')).brief.at, '09:15')
  } else {
    assert.equal((await desk.host.call('lead/autonomy/read', {})).modes.brief, 'observe')
    await desk.host.call('lead/autonomy/set', { kind: 'brief', mode: 'act' })
    await desk.host.call(set, { feature: 'lead', enabled: false })
    await desk.host.call(set, { feature: 'lead', enabled: true })
    assert.equal((await desk.host.call('lead/autonomy/read', {})).modes.brief, 'act')
  }
  assert.equal(early, false, 'Off must wait for the old owner actual filesystem write')
})

test('Mobile Off drains actual revoke persistence before reopening a registry', async t => {
  const home = tempDir('hd-feature-mobile-write-')
  const { PhoneSim } = await import('@harnessdesk/phone-link/sim')
  const desk = await start({ catalogRefreshMs: 0, mobileEnabled: true, phoneLink: { host: '127.0.0.1' } }, home)
  t.after(() => halt(desk))
  const code = await desk.host.call('phone/pairing', {})
  const phone = await PhoneSim.fromCode(code.url)
  t.after(() => phone.close())
  await phone.open((await desk.host.call('phone/state', {})).port!, phone.offer!.deskPub)
  await phone.enroll(phone.offer!.enroll, 'Demo phone')
  let pending = (await desk.host.call('phone/state', {})).pending
  while (!pending.length) { await new Promise(resolve => setTimeout(resolve, 10)); pending = (await desk.host.call('phone/state', {})).pending }
  await desk.host.call('phone/allow', { id: pending[0]!.id })
  await phone.next(message => message.t === 'enroll.ok')
  const hold = holdRename(t, join(home, 'phone-link/phone-devices.json'))
  const removing = desk.host.call('phone/revoke', { device: phone.id })
  await hold.inside
  let disabled = false
  const disabling = desk.host.call(set, { feature: 'mobile', enabled: false }).then(() => { disabled = true })
  await new Promise(resolve => setTimeout(resolve, 80))
  const early = disabled
  await assert.rejects(desk.host.call('phone/pairing', {}), /phone-link-unavailable/)
  hold.release(); await removing; await disabling
  await desk.host.call(set, { feature: 'mobile', enabled: true })
  const reopened = await desk.host.call('phone/state', {})
  assert.deepEqual(reopened.devices, [])
  const returning = await PhoneSim.create(phone.key)
  t.after(() => returning.close())
  await returning.open(reopened.port!, phone.offer!.deskPub)
  await returning.auth()
  assert.equal((await returning.closedWith()).code, 4423, 'retained revoked authority is refused by the real endpoint')
  assert.equal(early, false, 'Off must wait for registry persistence')
})

for (const damaged of ['desk-key.json', 'phone-devices.json', 'listener', 'lead-project'] as const)
  test(`saved optional activation failure (${damaged}) leaves ordinary sessions and explicit repair available`, async t => {
    const home = tempDir('hd-feature-start-fail-')
    const lead = damaged === 'lead-project'
    await fs.writeFile(join(home, 'features.json'), JSON.stringify(lead ? { lead: true } : { mobile: true }))
    await mkdir(join(home, lead ? 'lead' : 'phone-link'))
    const file = join(home, lead ? 'lead/project.json' : `phone-link/${damaged}`)
    const damagedText = '{damaged-PRIVATE_IDENTITY_CANARY'
    if (damaged !== 'listener') await fs.writeFile(file, damagedText)
    const occupied = damaged === 'listener' ? createServer() : null
    if (occupied) await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
    t.after(async () => { if (occupied?.listening) await new Promise<void>(resolve => occupied.close(() => resolve())) })
    const address = occupied?.address()
    const port = address && typeof address === 'object' ? address.port : undefined
    const desk = await start({ catalogRefreshMs: 0, ...(port ? { phoneLink: { host: '127.0.0.1', port } } : {}) }, home)
    t.after(() => halt(desk))
    const state = await desk.host.call(read, {})
    assert.equal(state.problem?.feature, lead ? 'lead' : 'mobile')
    assert.match(state.problem!.message, /could not start.*Retained service files/s)
    const wire = await Client.connect(desk.server)
    try {
      const shown = JSON.stringify(await wire.call(read, {}))
      assert.equal(shown.includes('PRIVATE_IDENTITY_CANARY'), false)
      assert.equal(shown.includes(home), false, 'private state paths stay out of the feature problem')
    } finally { wire.close() }
    assert.equal(state[lead ? 'lead' : 'mobile'], true)
    assert.deepEqual(JSON.parse(await readFile(join(home, 'features.json'), 'utf8')), lead ? { lead: true } : { mobile: true })
    const chat = await desk.host.call('session/create', { runtime: desk.runtime.info.id, options: { cwd: home } })
    assert.ok(chat.id)
    await assert.rejects(desk.host.call('phone/pairing', {}), /phone-link-unavailable/)
    assert.deepEqual(await desk.host.call('app/features/repair', {}), { lead: false, mobile: false })
    if (damaged !== 'listener') {
      assert.equal(await readFile(file, 'utf8'), damagedText, 'repair must not erase retained identity or Lead evidence')
      await assert.rejects(desk.host.call(set, { feature: lead ? 'lead' : 'mobile', enabled: true }), /Repair/)
      assert.equal(await readFile(file, 'utf8'), damagedText, 'retry also preserves damaged artifacts')
      await desk.host.call('app/features/repair', {})
      await fs.rm(file) // external repair in this synthetic fixture
      await desk.host.call(set, { feature: lead ? 'lead' : 'mobile', enabled: true })
    } else {
      await new Promise<void>(resolve => occupied!.close(() => resolve()))
      await desk.host.call(set, { feature: 'mobile', enabled: true })
      assert.equal((await desk.host.call('phone/state', {})).enabled, true)
    }
  })

test('successful launch defaults remain absent from portable explicit choices', async t => {
  const home = tempDir('hd-feature-default-only-'), desk = await start({ catalogRefreshMs: 0, mobileEnabled: true, leadEnabled: true }, home)
  t.after(() => halt(desk))
  assert.deepEqual(await desk.host.call(read, {}), { lead: true, mobile: true })
  await assert.rejects(readFile(join(home, 'features.json')), { code: 'ENOENT' })
})

for (const mutation of ['enrollment', 'touch'] as const) test(`Mobile Off drains endpoint-owned ${mutation} persistence`, async t => {
  const { PhoneSim } = await import('@harnessdesk/phone-link/sim')
  const home = tempDir('hd-feature-endpoint-write-')
  const desk = await start({ catalogRefreshMs: 0, mobileEnabled: true, phoneLink: { host: '127.0.0.1' } }, home)
  t.after(() => halt(desk))
  const code = await desk.host.call('phone/pairing', {})
  const phone = await PhoneSim.fromCode(code.url)
  t.after(() => phone.close())
  await phone.open((await desk.host.call('phone/state', {})).port!, phone.offer!.deskPub)
  await phone.enroll(phone.offer!.enroll, 'Demo phone')
  let pending = (await desk.host.call('phone/state', {})).pending
  while (!pending.length) { await new Promise(resolve => setTimeout(resolve, 10)); pending = (await desk.host.call('phone/state', {})).pending }
  if (mutation === 'touch') {
    await desk.host.call('phone/allow', { id: pending[0]!.id })
    await phone.next(message => message.t === 'enroll.ok')
    phone.close()
  }
  const hold = holdRename(t, join(home, 'phone-link/phone-devices.json'))
  if (mutation === 'enrollment') await desk.host.call('phone/allow', { id: pending[0]!.id })
  else {
    const returning = await PhoneSim.create(phone.key)
    t.after(() => returning.close())
    await returning.open((await desk.host.call('phone/state', {})).port!, phone.offer!.deskPub)
    await returning.auth()
  }
  await hold.inside
  let disabled = false
  const disabling = desk.host.call(set, { feature: 'mobile', enabled: false }).then(() => { disabled = true })
  await new Promise(resolve => setTimeout(resolve, 80))
  const early = disabled
  hold.release(); await disabling
  await desk.host.call(set, { feature: 'mobile', enabled: true })
  const devices = (await desk.host.call('phone/state', {})).devices
  assert.equal(devices[0]?.id, phone.id)
  if (mutation === 'touch') assert.ok(devices[0]!.lastSeenAt)
  assert.equal(early, false, 'endpoint writes drain before releasing the registry owner')
})

test('Mobile stop retries a failed close on the same owner', async t => {
  const { PhoneLinkService } = await import('@harnessdesk/phone-link')
  const home = tempDir('hd-feature-close-retry-'), desk = await start({ catalogRefreshMs: 0, mobileEnabled: true }, home)
  t.after(() => halt(desk))
  const close = PhoneLinkService.prototype.close
  let first: import('@harnessdesk/phone-link').PhoneLinkService | undefined, attempts = 0
  t.mock.method(PhoneLinkService.prototype, 'close', async function(this: import('@harnessdesk/phone-link').PhoneLinkService) {
    if (!first) first = this
    else assert.equal(this, first, 'repair retries the retained service')
    if (++attempts === 1) throw Error('synthetic close failure')
    return close.call(this)
  })
  await assert.rejects(desk.host.call(set, { feature: 'mobile', enabled: false }), /Repair/)
  await assert.rejects(desk.host.call('phone/pairing', {}), /phone-link-unavailable/)
  assert.equal((await desk.host.call(read, {})).problem?.feature, 'mobile')
  await desk.host.call('app/features/repair', {})
  assert.equal(attempts, 2)
  assert.equal((await desk.host.call('phone/state', {})).enabled, false)
})

test('failed saved Lead restore drains partial owners before exposing repair on the ordinary desk', async t => {
  const { IntakePlane } = await import('../src/intake/plane.js')
  const { LeadService } = await import('../src/lead/service.js')
  const { LeadFileJournal } = await import('../src/lead/journal.js')
  const home = tempDir('hd-feature-restore-owner-')
  await fs.writeFile(join(home, 'features.json'), JSON.stringify({ lead: true }))
  await mkdir(join(home, 'lead'))
  await fs.writeFile(join(home, 'lead/project.json'), JSON.stringify({ version: 1, path: home }))
  t.mock.method(IntakePlane.prototype, 'followPullRequests', () => { throw Error('synthetic restore registration failure') })
  const close = LeadService.prototype.close
  let entered!: () => void, release!: () => void
  const inside = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  t.mock.method(LeadService.prototype, 'close', async function(this: InstanceType<typeof LeadService>) {
    entered(); await held; return close.call(this)
  })
  let started = false
  const starting = start({ catalogRefreshMs: 0 }, home).then(desk => { started = true; return desk })
  await inside
  try {
    assert.equal(started, false, 'the failed restore still owns its cleanup')
    await assert.rejects(LeadFileJournal.open(home, 'desk'), /lead-journal-open-refused/)
  } finally { release() }
  const desk = await starting
  t.after(() => halt(desk))
  assert.equal((await desk.host.call(read, {})).problem?.feature, 'lead')
  const storage = await LeadFileJournal.open(home, 'desk')
  await storage.close()
  assert.ok((await desk.host.call('session/create', { runtime: desk.runtime.info.id, options: { cwd: home } })).id)
  assert.deepEqual(await desk.host.call('app/features/repair', {}), { lead: false, mobile: false })
})


test('quit announces runtime shutdown and fences Mobile while an admitted feature save drains', async t => {
  const home = tempDir('hd-feature-quit-drain-')
  const desk = await start({ catalogRefreshMs: 0, mobileEnabled: true }, home)
  t.after(() => desk.server.close())
  const hold = holdRename(t, join(home, 'features.json'))
  const saving = desk.host.call(set, { feature: 'lead', enabled: false })
  await hold.inside
  const dispose = desk.runtime.dispose.bind(desk.runtime)
  let announced = false
  t.mock.method(desk.runtime, 'dispose', () => { announced = true; return dispose() })
  let finished = false
  const quitting = desk.host.dispose().then(() => { finished = true })
  const announcedBeforeYield = announced
  const pairingRefused = await desk.host.call('phone/pairing', {}).then(() => false, () => true)
  const finishedBeforeSave = finished
  hold.release()
  await saving; await quitting
  assert.equal(announcedBeforeYield, true, 'runtime teardown is announced before the first quit yield')
  assert.equal(pairingRefused, true, 'Mobile controls are fenced while the feature queue drains')
  assert.equal(finishedBeforeSave, false, 'the admitted feature write remains part of quit')
  assert.equal((await desk.host.call('phone/state', {})).enabled, false)
})
