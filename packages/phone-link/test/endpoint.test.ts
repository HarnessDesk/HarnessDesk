import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { b64u, fromB64u, generateSigningIdentity, startPhoneHandshake } from '@harnessdesk/crypto'
import { DeviceRegistry, EventRing, loadOrCreateDeskIdentity, PhoneEndpoint } from '../src/index.js'

const rig = async (t: { after(fn: () => Promise<void>): void }) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-endpoint-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const identity = await loadOrCreateDeskIdentity(dir), registry = await DeviceRegistry.open(join(dir, 'devices.json'))
  const frames: Uint8Array[] = [], closes: unknown[] = [], calls: unknown[] = []
  let confirm!: (value: readonly ['read'] | null) => void, waiting = false
  const endpoint = new PhoneEndpoint({ identity, registry, ring: new EventRing(), now: Date.now,
    policy: { methods: { read: 'read' }, topics: {}, defaultTiers: ['read'] },
    call: async (...args) => { calls.push(args); return null },
    confirm: async () => { waiting = true; return new Promise(resolve => { confirm = resolve }) },
  }, { send: frame => { frames.push(frame) }, close: (...args) => { closes.push(args) } })
  t.after(async () => { endpoint.dispose(); confirm?.(null) })
  return { endpoint, registry, identity, frames, closes, calls, waiting: () => waiting, confirm: () => confirm(['read']) }
}

test('queued frames and bytes are bounded before asynchronous processing', async t => {
  for (const mode of ['frames', 'bytes']) {
    const s = await rig(t)
    const pending = mode === 'frames' ? Array.from({ length: 33 }, () => s.endpoint.receive(new Uint8Array(1)))
      : [s.endpoint.receive(new Uint8Array(1_048_577))]
    assert.equal(s.endpoint.closed, true, mode)
    await Promise.all(pending)
    assert.equal(s.closes.length, 1)
  }
})

test('application frames during desktop confirmation close the session and cannot enrol a phone', async t => {
  const s = await rig(t), phone = await generateSigningIdentity()
  const handshake = await startPhoneHandshake(fromB64u(s.identity.pub))
  await s.endpoint.receive(handshake.hello)
  const session = await handshake.finish(s.frames.shift()! as Uint8Array<ArrayBuffer>)
  const offer = s.registry.issueOffer(1000, Date.now())
  const enrolling = s.endpoint.receive(await session.sealJson({ t: 'enroll', secret: b64u(offer.secret), devicePub: b64u(phone.pub), name: 'Demo phone' }))
  for (let i = 0; !s.waiting() && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(s.waiting(), true)
  const received = s.endpoint.receive(await session.sealJson({ t: 'req', id: '1', method: 'read', params: {} }))
  assert.equal(s.endpoint.closed, true)
  s.confirm()
  await Promise.all([enrolling, received])
  assert.deepEqual(s.registry.list(), [])
  assert.deepEqual(s.calls, [])
})
