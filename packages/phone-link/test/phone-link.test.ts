import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { b64u } from '@harnessdesk/crypto'
import {
  DeviceRegistry, EventRing, PhoneCallError, PhoneLinkService, loadOrCreateDeskIdentity,
  type PhonePolicy,
} from '../src/index.js'
import { PhoneSim } from '../src/sim.js'

const policy: PhonePolicy = {
  methods: { 'lead/thread/read': 'read', 'lead/thread/send': 'run', 'lead/card/decide': 'answer', 'lead/settings/update': 'run' },
  topics: { lead: 'read', secret: 'answer' },
  defaultTiers: ['read', 'run'],
}
// The settings method is deliberately not in the table's reach below: tests prove the allowlist by name.
delete (policy.methods as Record<string, unknown>)['lead/settings/update']

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hd-phone-link-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('desk identity', () => {
  test('is created once, kept private, and is the same on the next start', async () => {
    const first = await loadOrCreateDeskIdentity(dir)
    const second = await loadOrCreateDeskIdentity(dir)
    assert.equal(second.id, first.id)
    assert.equal(second.pub, first.pub)
    assert.equal((await stat(join(dir, 'desk-key.json'))).mode & 0o777, 0o600)
  })

  test('is never replaced when the file cannot be read or understood', async () => {
    await writeFile(join(dir, 'desk-key.json'), 'not json', { mode: 0o600 })
    await assert.rejects(loadOrCreateDeskIdentity(dir), /not a valid key file/)
    assert.equal(await readFile(join(dir, 'desk-key.json'), 'utf8'), 'not json')
    await rm(join(dir, 'desk-key.json'))
    await loadOrCreateDeskIdentity(dir)
    await chmod(join(dir, 'desk-key.json'), 0o000)
    if (process.getuid?.() !== 0) await assert.rejects(loadOrCreateDeskIdentity(dir), /could not be read/)
    await chmod(join(dir, 'desk-key.json'), 0o600)
  })
})

describe('device registry', () => {
  test('a pairing secret works once, and only before it expires', async () => {
    const registry = await DeviceRegistry.open(join(dir, 'devices.json'))
    const { secret, expiresAt } = registry.issueOffer(1000, 10)
    const text = b64u(secret)
    assert.equal(registry.takeOffer('x'.repeat(22), 20), false)
    assert.equal(registry.takeOffer(text, 20), true)
    assert.equal(registry.takeOffer(text, 21), false)
    const late = registry.issueOffer(1000, 10)
    assert.equal(registry.takeOffer(b64u(late.secret), expiresAt + 1), false)
  })

  test('remembers devices and removals across a restart, and refuses a file it cannot read', async () => {
    const path = join(dir, 'devices.json')
    const registry = await DeviceRegistry.open(path)
    const device = { id: 'a'.repeat(22), pub: 'p'.repeat(43), name: 'Phone', tiers: ['read'] as const, pushKey: 'k', kid: 1, createdAt: 1, lastSeenAt: null }
    await registry.add(device)
    await registry.add({ ...device, id: 'b'.repeat(22) })
    await registry.revoke('b'.repeat(22), 5)
    const again = await DeviceRegistry.open(path)
    assert.deepEqual(again.list().map(d => d.id), ['a'.repeat(22)])
    assert.equal(again.isRevoked('b'.repeat(22)), true)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    await writeFile(path, '{broken')
    await assert.rejects(DeviceRegistry.open(path), /is not valid/)
  })

  test('holds at eight phones', async () => {
    const registry = await DeviceRegistry.open(join(dir, 'devices.json'))
    for (let i = 0; i < 8; i++) await registry.add({ id: String(i).repeat(22), pub: 'p', name: 'n', tiers: [], pushKey: 'k', kid: 1, createdAt: 1, lastSeenAt: null })
    await assert.rejects(registry.add({ id: 'z'.repeat(22), pub: 'p', name: 'n', tiers: [], pushKey: 'k', kid: 1, createdAt: 1, lastSeenAt: null }), /most phones/)
  })
})

describe('event ring', () => {
  test('numbers events from one and gives back what a phone missed', () => {
    const ring = new EventRing({ epoch: 'e1' })
    ring.append('lead', 1); ring.append('lead', 2); ring.append('lead', 3)
    const read = ring.read('e1', 1)
    assert.ok(read.ok)
    assert.deepEqual(read.events.map(e => e.seq), [2, 3])
    assert.deepEqual(ring.read('e1', 3), { ok: true, events: [] })
  })

  test('resets on a different epoch, a number from the future, or a gap beyond the buffer', () => {
    const ring = new EventRing({ epoch: 'e1', maxEvents: 2 })
    for (let i = 0; i < 5; i++) ring.append('lead', i)
    assert.deepEqual(ring.read('other', 4), { ok: false })
    assert.deepEqual(ring.read('e1', 99), { ok: false })
    assert.deepEqual(ring.read('e1', 2), { ok: false })
    assert.ok(ring.read('e1', 3).ok)
  })

  test('trims by size as well as count, keeping at least the newest', () => {
    const ring = new EventRing({ epoch: 'e1', maxBytes: 100 })
    ring.append('lead', 'x'.repeat(60)); ring.append('lead', 'y'.repeat(60))
    const read = ring.read('e1', 1)
    assert.ok(read.ok)
    assert.equal(read.events.length, 1)
    assert.equal(ring.read('e1', 0).ok, false)
  })
})

describe('the LAN link', () => {
  let service: PhoneLinkService
  const calls: { method: string; params: unknown }[] = []

  const start = async (extra: Partial<Parameters<typeof PhoneLinkService.start>[0]> = {}) => {
    service = await PhoneLinkService.start({
      dir, policy, host: '127.0.0.1', includeLoopback: true, name: 'Test desk', confirmTimeoutMs: 400,
      call: async (method, params) => {
        calls.push({ method, params })
        if (method === 'lead/thread/send' && (params as { text?: string })?.text === 'boom') throw new PhoneCallError('leadUnavailable', 'The Lead is not running.')
        return { echoed: method }
      },
      ...extra,
    })
    return service
  }
  afterEach(async () => { calls.length = 0; await service?.close() })

  test('a restarted desk listens where its paired phones last found it, or anywhere free when that is taken', async () => {
    const first = (await start()).port
    await service.close()
    assert.equal((await start()).port, first)
    const moved = await PhoneLinkService.start({ dir, policy, host: '127.0.0.1', call: async () => null })
    try { assert.notEqual(moved.port, first) } finally { await moved.close() }
  })

  const pair = async (name = 'Jane’s phone') => {
    const code = service.createPairingCode()
    const phone = await PhoneSim.fromCode(code.url)
    assert.equal(phone.offer!.deskPub, service.deskPub)
    await phone.open(service.port, phone.offer!.deskPub)
    await phone.enroll(phone.offer!.enroll, name)
    return phone
  }
  const allowNext = async (tiers?: Parameters<PhoneLinkService['allow']>[1]) => {
    for (let i = 0; i < 100 && service.pending().length === 0; i++) await new Promise(r => setTimeout(r, 10))
    const [request] = service.pending()
    assert.ok(request, 'a phone is waiting to be allowed')
    assert.ok(service.allow(request.id, tiers))
    return request
  }

  test('the pairing code carries the desk key, the enrol secret and where to connect', async () => {
    await start()
    const { offer } = service.createPairingCode()
    assert.equal(offer.deskPub, service.deskPub)
    assert.equal(offer.name, 'Test desk')
    assert.ok(offer.lan!.some(a => a.host === '127.0.0.1' && a.port === service.port))
    assert.ok(offer.exp > Date.now() / 1000)
  })

  test('a new phone waits for the person, then is in', async () => {
    await start()
    const phone = await pair()
    const request = await allowNext()
    assert.equal(request.name, 'Jane’s phone')
    const ok = await phone.next(m => m.t === 'enroll.ok')
    assert.equal(ok.deviceId, phone.id)
    assert.equal(ok.epoch, service.ring.epoch)
    assert.equal(service.devices().length, 1)
    assert.deepEqual(service.devices()[0]!.tiers, ['read', 'run'])
    assert.equal(service.pending().length, 0)
    const reply = await phone.request('lead/thread/read')
    assert.deepEqual(reply.result, { echoed: 'lead/thread/read' })
    phone.close()
  })

  test('the answer no turns the phone away, and so does silence', async () => {
    await start()
    const refused = await pair()
    for (let i = 0; i < 100 && service.pending().length === 0; i++) await new Promise(r => setTimeout(r, 10))
    assert.ok(service.deny(service.pending()[0]!.id))
    assert.equal((await refused.next(m => m.t === 'error')).code, 4401)
    assert.equal((await refused.closedWith()).code, 4401)
    const silent = await pair()
    assert.equal((await silent.next(m => m.t === 'error', 3000)).code, 4401)
    assert.equal(service.devices().length, 0)
  })

  test('a pairing code works once', async () => {
    await start()
    const code = service.createPairingCode()
    const first = await PhoneSim.fromCode(code.url)
    await first.open(service.port, service.deskPub)
    await first.enroll(first.offer!.enroll)
    await allowNext()
    await first.next(m => m.t === 'enroll.ok')
    const second = await PhoneSim.fromCode(code.url)
    await second.open(service.port, service.deskPub)
    await second.enroll(second.offer!.enroll)
    assert.equal((await second.next(m => m.t === 'error')).code, 4401)
    assert.equal(service.devices().length, 1)
  })

  test('a known phone signs in with its key, and a wrong key is refused', async () => {
    await start()
    const phone = await pair()
    await allowNext()
    await phone.next(m => m.t === 'enroll.ok')
    phone.close()
    const back = await PhoneSim.create(phone.key)
    await back.open(service.port, service.deskPub)
    await back.auth()
    const ok = await back.next(m => m.t === 'auth.ok')
    assert.equal(ok.epoch, service.ring.epoch)
    const stranger = await PhoneSim.create()
    await stranger.open(service.port, service.deskPub)
    await stranger.send({ t: 'auth', dev: phone.id, sig: b64u(new Uint8Array(64)) })
    assert.equal((await stranger.next(m => m.t === 'error')).code, 4401)
    const unknown = await PhoneSim.create()
    await unknown.open(service.port, service.deskPub)
    await unknown.auth()
    assert.equal((await unknown.next(m => m.t === 'error')).code, 4401)
    back.close()
  })

  test('only what the table lists is answered, each at its tier', async () => {
    await start()
    const phone = await pair()
    await allowNext(['read'])
    await phone.next(m => m.t === 'enroll.ok')
    assert.equal((await phone.request('lead/settings/update', {})).error.code, 'notOnPhoneSurface')
    assert.equal((await phone.request('flow/start-goal', {})).error.code, 'notOnPhoneSurface')
    assert.equal((await phone.request('lead/thread/send', { text: 'hi' })).error.code, 'tierNotGranted')
    assert.equal((await phone.request('lead/card/decide', {})).error.code, 'tierNotGranted')
    assert.equal((await phone.request('__proto__')).error.code, 'notOnPhoneSurface')
    assert.equal((await phone.request('constructor')).error.code, 'notOnPhoneSurface')
    assert.deepEqual(calls, [])
    phone.close()
  })

  test('a call that fails tells the phone why', async () => {
    await start()
    const phone = await pair()
    await allowNext()
    await phone.next(m => m.t === 'enroll.ok')
    const reply = await phone.request('lead/thread/send', { text: 'boom' })
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'leadUnavailable')
    phone.close()
  })

  test('nothing is answered before the phone signs in, and silence ends the session', async () => {
    await start({ confirmTimeoutMs: 100 })
    const silent = await PhoneSim.create()
    await silent.open(service.port, service.deskPub)
    await silent.send({ t: 'req', id: '1', method: 'lead/thread/read' })
    assert.equal((await silent.closedWith()).code, 4400)
    assert.deepEqual(calls, [])
  })

  test('a replayed or out-of-order frame ends the session', async () => {
    await start()
    const phone = await pair()
    await allowNext()
    await phone.next(m => m.t === 'enroll.ok')
    const frame = await phone.session!.sealJson({ t: 'ping' })
    phone.sendRaw(frame)
    await phone.next(m => m.t === 'pong')
    phone.sendRaw(frame)
    assert.equal((await phone.closedWith()).code, 4400)
  })

  test('events reach a signed-in phone live, filtered by tier, and a missed run is replayed on resume', async () => {
    await start()
    const phone = await pair()
    await allowNext(['read'])
    await phone.next(m => m.t === 'enroll.ok')
    service.publish('lead', { n: 1 })
    service.publish('secret', { n: 2 })
    service.publish('lead', { n: 3 })
    const one = await phone.next(m => m.t === 'evt')
    assert.deepEqual([one.topic, one.seq, one.data], ['lead', 1, { n: 1 }])
    const three = await phone.next(m => m.t === 'evt')
    assert.deepEqual([three.topic, three.seq], ['lead', 3])
    phone.close()

    service.publish('lead', { n: 4 })
    service.publish('lead', { n: 5 })
    const back = await PhoneSim.create(phone.key)
    await back.open(service.port, service.deskPub)
    await back.auth()
    const ok = await back.next(m => m.t === 'auth.ok')
    assert.equal(ok.seq, 5)
    await back.send({ t: 'resume', epoch: ok.epoch, after: 3 })
    const resumed = await back.next(m => m.t === 'resume.ok')
    assert.deepEqual([resumed.from, resumed.to], [4, 5])
    assert.deepEqual([(await back.next(m => m.t === 'evt')).seq, (await back.next(m => m.t === 'evt')).seq], [4, 5])
    service.publish('lead', { n: 6 })
    assert.equal((await back.next(m => m.t === 'evt')).seq, 6)
    await back.send({ t: 'resume', epoch: 'another-desk-run', after: 3 })
    const reset = await back.next(m => m.t === 'resume.reset')
    assert.equal(reset.epoch, service.ring.epoch)
    back.close()
  })

  test('removing a phone ends its live session at once and it is told so when it returns', async () => {
    await start()
    const phone = await pair()
    await allowNext()
    await phone.next(m => m.t === 'enroll.ok')
    assert.ok(await service.revoke(phone.id))
    assert.equal((await phone.closedWith()).code, 4423)
    const back = await PhoneSim.create(phone.key)
    await back.open(service.port, service.deskPub)
    await back.auth()
    assert.equal((await back.next(m => m.t === 'error')).code, 4423)
    assert.equal(service.devices().length, 0)
  })

  test('a phone that pinned a different desk key never finishes the handshake', async () => {
    await start()
    const phone = await PhoneSim.create()
    await assert.rejects(phone.open(service.port, b64u(new Uint8Array(32).fill(7))), /desk-signature|closed/)
  })

  test('the desk key and paired phones survive a restart', async () => {
    await start()
    const phone = await pair()
    await allowNext()
    await phone.next(m => m.t === 'enroll.ok')
    const deskPub = service.deskPub
    phone.close()
    await service.close()
    await start()
    assert.equal(service.deskPub, deskPub)
    const back = await PhoneSim.create(phone.key)
    await back.open(service.port, deskPub)
    await back.auth()
    const ok = await back.next(m => m.t === 'auth.ok')
    assert.equal(ok.epoch, service.ring.epoch)
    back.close()
  })

  test('changes are announced so a window can show who is waiting', async () => {
    await start()
    const seen: string[] = []
    service.onChange(change => seen.push(change))
    const phone = await pair()
    await allowNext()
    await phone.next(m => m.t === 'enroll.ok')
    assert.ok(seen.includes('pending') && seen.includes('devices'))
    phone.close()
  })
})

test('a failed registry save preserves memory and permits a later durable removal', async () => {
  const path = join(dir, 'devices.json'), registry = await DeviceRegistry.open(path)
  const device = { id: 'demo-phone', pub: 'p', name: 'Phone', tiers: ['read'] as const, pushKey: 'k', kid: 1, createdAt: 1, lastSeenAt: null }
  await registry.add(device)
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(temporary)
  await assert.rejects(registry.revoke(device.id, 2))
  assert.deepEqual(registry.get(device.id), device)
  assert.equal(registry.isRevoked(device.id), false)
  assert.deepEqual((await DeviceRegistry.open(path)).get(device.id), device)
  await rm(temporary, { recursive: true })
  await registry.revoke(device.id, 3)
  assert.equal(registry.get(device.id), null)
  assert.equal((await DeviceRegistry.open(path)).isRevoked(device.id), true)
})

test('concurrent registry additions enforce capacity at the persistence boundary', async () => {
  const registry = await DeviceRegistry.open(join(dir, 'devices.json'))
  const results = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => registry.add({ id: String(i), pub: 'p', name: 'Phone', tiers: [], pushKey: 'k', kid: 1, createdAt: 1, lastSeenAt: null })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 8)
  assert.equal(registry.list().length, 8)
})

test('an interrupted port file falls back to a valid atomic replacement', async () => {
  for (const text of ['{', 'null', '{"port":"1234"}', '{"port":70000}']) {
    await writeFile(join(dir, 'phone-port.json'), text)
    const service = await PhoneLinkService.start({ dir, policy, host: '127.0.0.1', call: async () => null })
    try {
      assert.ok(service.port > 0 && service.port < 65536)
      assert.equal(JSON.parse(await readFile(join(dir, 'phone-port.json'), 'utf8')).port, service.port)
    } finally { await service.close() }
  }
})
