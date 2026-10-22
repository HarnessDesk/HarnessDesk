import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  E2eeError, FRAME_DATA, TokenError, acceptHandshake, b64u, checkChallenge, fromB64u, generatePushKey, generateSigningIdentity, handshakeDeviceMessage,
  idFromPub, makeChallenge, openPushJson, randomBytes, readU64be, relayDeskProofMessage, sealPushJson, signToken, signingIdentityFromPkcs8,
  startPhoneHandshake, utf8, verifyEd25519, verifyToken,
} from '../src/index.js'

// The rejection carries the named fields, whatever else the error holds.
async function rejectsWith(promise: Promise<unknown>, fields: Record<string, unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    for (const [name, value] of Object.entries(fields)) assert.equal((error as Record<string, unknown>)[name], value)
    return true
  })
}

async function pair() {
  const desk = await generateSigningIdentity()
  const phone = await startPhoneHandshake(desk.pub)
  const { ready, session: deskSession } = await acceptHandshake(phone.hello, desk)
  const phoneSession = await phone.finish(ready)
  return { desk, phone, ready, deskSession, phoneSession }
}

describe('ids and keys', () => {
  it('derives a 22 character self-certifying id', async () => {
    const k = await generateSigningIdentity()
    const id = await idFromPub(k.pub)
    assert.equal(id.length, 22)
    assert.equal(fromB64u(id).length, 16)
  })

  it('round-trips a key through PKCS#8', async () => {
    const k = await generateSigningIdentity()
    const again = await signingIdentityFromPkcs8(await k.exportPkcs8())
    assert.deepEqual(again.pub, k.pub)
    assert.equal(await verifyEd25519(k.pub, await again.sign(utf8('x')), utf8('x')), true)
  })
})

describe('e2ee', () => {
  it('carries messages both ways', async () => {
    const { deskSession, phoneSession } = await pair()
    assert.deepEqual(await deskSession.openJson(await phoneSession.sealJson({ a: 1 })), { a: 1 })
    assert.deepEqual(await phoneSession.openJson(await deskSession.sealJson({ b: 2 })), { b: 2 })
    assert.deepEqual(phoneSession.th, deskSession.th)
  })

  it('rejects a desk that is not the pinned key', async () => {
    const real = await generateSigningIdentity()
    const impostor = await generateSigningIdentity()
    const phone = await startPhoneHandshake(real.pub)
    const { ready } = await acceptHandshake(phone.hello, impostor)
    await rejectsWith(phone.finish(ready), { code: 'desk-signature' })
  })

  it('gives frames sealed together distinct counters, so no two share a key and nonce', async () => {
    const { deskSession, phoneSession } = await pair()
    const frames = await Promise.all([phoneSession.sealJson({ n: 0 }), phoneSession.sealJson({ n: 1 }), phoneSession.sealJson({ n: 2 })])
    assert.deepEqual(frames.map((f) => Number(readU64be(f, 1))), [0, 1, 2])
    assert.equal(phoneSession.sent, 3n)
    for (const [n, frame] of frames.entries()) assert.deepEqual(await deskSession.openJson(frame), { n })
  })

  it('finishes frames sealed together in the order they were asked for, whatever their size', async () => {
    const { deskSession, phoneSession } = await pair()
    const finished: number[] = []
    const big = phoneSession.seal(new Uint8Array(200_000).fill(1)).then((f) => { finished.push(0); return f })
    const small = phoneSession.seal(utf8('{"n":1}')).then((f) => { finished.push(1); return f })
    const [a, b] = await Promise.all([big, small])
    assert.deepEqual(finished, [0, 1])
    assert.deepEqual([Number(readU64be(a, 1)), Number(readU64be(b, 1))], [0, 1])
    // The peer opens both, in order.
    assert.equal((await deskSession.open(a)).body.length, 200_000)
    assert.equal((await deskSession.open(b)).body.length, 7)
  })

  it('opens a frame once, however many calls are made together', async () => {
    const { deskSession, phoneSession } = await pair()
    const frame = await phoneSession.sealJson({ n: 0 })
    const results = await Promise.allSettled([deskSession.open(frame), deskSession.open(frame)])
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected'])
    assert.equal((results[1] as PromiseRejectedResult).reason.code, 'counter')
    assert.equal(deskSession.received, 1n)
  })

  it('opens frames given together in the order given', async () => {
    const { deskSession, phoneSession } = await pair()
    const a = await phoneSession.sealJson({ n: 0 })
    const b = await phoneSession.sealJson({ n: 1 })
    assert.deepEqual(await Promise.all([deskSession.openJson(a), deskSession.openJson(b)]), [{ n: 0 }, { n: 1 }])
    const c = await phoneSession.sealJson({ n: 2 })
    const d = await phoneSession.sealJson({ n: 3 })
    const settled = await Promise.allSettled([deskSession.openJson(d), deskSession.openJson(c)])
    assert.deepEqual(settled.map((r) => r.status), ['rejected', 'fulfilled'])
  })

  it('rejects a READY that was altered in flight', async () => {
    const desk = await generateSigningIdentity()
    const phone = await startPhoneHandshake(desk.pub)
    const { ready } = await acceptHandshake(phone.hello, desk)
    const bad = ready.slice()
    bad[5]! ^= 1
    await assert.rejects(phone.finish(bad), E2eeError)
  })

  it('rejects a READY made for a different HELLO', async () => {
    const desk = await generateSigningIdentity()
    const first = await startPhoneHandshake(desk.pub)
    const second = await startPhoneHandshake(desk.pub)
    const { ready } = await acceptHandshake(first.hello, desk)
    await rejectsWith(second.finish(ready), { code: 'desk-signature' })
  })

  it('refuses a replayed frame', async () => {
    const { deskSession, phoneSession } = await pair()
    const frame = await phoneSession.sealJson({ n: 1 })
    await deskSession.open(frame)
    await rejectsWith(deskSession.open(frame), { code: 'counter' })
  })

  it('refuses a dropped frame', async () => {
    const { deskSession, phoneSession } = await pair()
    await phoneSession.sealJson({ n: 0 })
    const second = await phoneSession.sealJson({ n: 1 })
    await rejectsWith(deskSession.open(second), { code: 'counter' })
  })

  it('refuses reordered frames', async () => {
    const { deskSession, phoneSession } = await pair()
    const a = await phoneSession.sealJson({ n: 0 })
    const b = await phoneSession.sealJson({ n: 1 })
    await rejectsWith(deskSession.open(b), { code: 'counter' })
    assert.deepEqual((await deskSession.openJson(a)), { n: 0 })
  })

  it('refuses a reflected frame (each direction has its own key)', async () => {
    const { deskSession, phoneSession } = await pair()
    const frame = await phoneSession.sealJson({ n: 0 })
    await rejectsWith(phoneSession.open(frame), { code: 'decrypt' })
    assert.equal(deskSession.received, 0n)
  })

  it('refuses a tampered frame, and a failed open does not advance the counter', async () => {
    const { deskSession, phoneSession } = await pair()
    const frame = await phoneSession.sealJson({ n: 0 })
    const bad = frame.slice()
    bad[bad.length - 1]! ^= 1
    await rejectsWith(deskSession.open(bad), { code: 'decrypt' })
    assert.deepEqual(await deskSession.openJson(frame), { n: 0 })
  })

  it('refuses a frame from another session', async () => {
    const a = await pair()
    const b = await pair()
    await rejectsWith(b.deskSession.open(await a.phoneSession.sealJson({})), { code: 'decrypt' })
  })

  it('refuses garbage', async () => {
    const { deskSession } = await pair()
    await rejectsWith(deskSession.open(randomBytes(4)), { code: 'format' })
    const wrongType = new Uint8Array(40)
    wrongType[0] = FRAME_DATA + 1
    await rejectsWith(deskSession.open(wrongType), { code: 'format' })
  })

  it('binds the device signature to this session', async () => {
    const a = await pair()
    const b = await pair()
    const device = await generateSigningIdentity()
    const sig = await device.sign(handshakeDeviceMessage(a.phoneSession.th))
    assert.equal(await verifyEd25519(device.pub, sig, handshakeDeviceMessage(a.deskSession.th)), true)
    assert.equal(await verifyEd25519(device.pub, sig, handshakeDeviceMessage(b.deskSession.th)), false)
  })

  it('rejects an unknown version and a short HELLO on the desk side', async () => {
    const desk = await generateSigningIdentity()
    const phone = await startPhoneHandshake(desk.pub)
    const v2 = phone.hello.slice()
    v2[1] = 2
    await rejectsWith(acceptHandshake(v2, desk), { code: 'version' })
    await rejectsWith(acceptHandshake(phone.hello.slice(0, 10), desk), { code: 'format' })
  })

  it('rejects the all-zero peer key', async () => {
    const desk = await generateSigningIdentity()
    const phone = await startPhoneHandshake(desk.pub)
    const zero = phone.hello.slice()
    zero.fill(0, 2, 34)
    await assert.rejects(acceptHandshake(zero, desk), E2eeError)
  })
})

describe('tokens', () => {
  it('verifies, and rejects wrong key, expiry and tampering', async () => {
    const signer = await generateSigningIdentity()
    const other = await generateSigningIdentity()
    const token = await signToken({ kid: 'k1', iat: 800, exp: 1_000, typ: 'x' }, signer)
    assert.partialDeepStrictEqual(await verifyToken(token, { k1: signer.pub }, 900, 'x'), { typ: 'x' })
    await rejectsWith(verifyToken(token, { k1: other.pub }, 900, 'x'), { reason: 'signature' })
    await rejectsWith(verifyToken(token, { k2: signer.pub }, 900, 'x'), { reason: 'kid' })
    await rejectsWith(verifyToken(token, { k1: signer.pub }, 1_100, 'x'), { reason: 'expired' })
    assert.ok(await verifyToken(token, { k1: signer.pub }, 1_050, 'x')) // inside leeway
    const [payload, sig] = token.split('.')
    const forged = `${b64u(utf8(JSON.stringify({ kid: 'k1', iat: 800, exp: 9_999, typ: 'x' })))}.${sig}`
    await assert.rejects(verifyToken(forged, { k1: signer.pub }, 900, 'x'), TokenError)
    await rejectsWith(verifyToken(`${payload}`, { k1: signer.pub }, 900, 'x'), { reason: 'format' })
    await rejectsWith(verifyToken('a.b.c', { k1: signer.pub }, 900, 'x'), { reason: 'format' })
  })

  it('accepts only the purpose the verifier expects, and checks it after the signature', async () => {
    const signer = await generateSigningIdentity()
    const other = await generateSigningIdentity()
    const phone = await signToken({ kid: 'k1', iat: 800, exp: 1_000, typ: 'phone' }, signer)
    await rejectsWith(verifyToken(phone, { k1: signer.pub }, 900, 'desk'), { reason: 'typ' })
    await rejectsWith(verifyToken(phone, { k1: other.pub }, 900, 'desk'), { reason: 'signature' })
    const untyped = await signToken({ kid: 'k1', iat: 800, exp: 1_000 }, signer)
    await rejectsWith(verifyToken(untyped, { k1: signer.pub }, 900, 'desk'), { reason: 'typ' })
  })

  it('requires an issue time, and refuses a token issued in the future', async () => {
    const signer = await generateSigningIdentity()
    const noIat = await signToken({ kid: 'k1', exp: 1_000, typ: 'x' } as unknown as { kid: string; iat: number; exp: number }, signer)
    await rejectsWith(verifyToken(noIat, { k1: signer.pub }, 900, 'x'), { reason: 'format' })
    const later = await signToken({ kid: 'k1', iat: 2_000, exp: 3_000, typ: 'x' }, signer)
    await rejectsWith(verifyToken(later, { k1: signer.pub }, 900, 'x'), { reason: 'not-yet' })
    assert.ok(await verifyToken(later, { k1: signer.pub }, 1_950, 'x')) // inside leeway
  })

  it('does not treat prototype names as key ids', async () => {
    const signer = await generateSigningIdentity()
    const token = await signToken({ kid: 'constructor', iat: 800, exp: 1_000 }, signer)
    await rejectsWith(verifyToken(token, { k1: signer.pub }, 900, 'x'), { reason: 'kid' })
  })
})

describe('challenge', () => {
  it('accepts a fresh challenge, rejects expired, forged and wrong-key ones', async () => {
    const key = randomBytes(32)
    const { challenge } = await makeChallenge(key, 1_000, 60)
    assert.equal(await checkChallenge(key, challenge, 1_030), true)
    assert.equal(await checkChallenge(key, challenge, 1_061), false)
    assert.equal(await checkChallenge(randomBytes(32), challenge, 1_030), false)
    const raw = fromB64u(challenge)
    raw[17]! ^= 1
    assert.equal(await checkChallenge(key, b64u(raw), 1_030), false)
    assert.equal(await checkChallenge(key, 'short', 1_030), false)
  })

  it('a signature over one purpose does not verify for another', async () => {
    const desk = await generateSigningIdentity()
    const sig = await desk.sign(relayDeskProofMessage('id', 'c'))
    assert.equal(await verifyEd25519(desk.pub, sig, relayDeskProofMessage('id', 'c')), true)
    assert.equal(await verifyEd25519(desk.pub, sig, relayDeskProofMessage('id', 'd')), false)
  })
})

describe('push', () => {
  it('round-trips and binds to device and key id', async () => {
    const key = generatePushKey()
    const sealed = await sealPushJson(key, 1, 'device-a', { title: 'hi' })
    assert.deepEqual(await openPushJson(key, 'device-a', sealed), { title: 'hi' })
    await assert.rejects(openPushJson(key, 'device-b', sealed))
    await assert.rejects(openPushJson(key, 'device-a', { ...sealed, kid: 2 }))
    await assert.rejects(openPushJson(generatePushKey(), 'device-a', sealed))
  })

  it('refuses a plaintext over the cap', async () => {
    await assert.rejects(sealPushJson(generatePushKey(), 1, 'd', { x: 'a'.repeat(2100) }))
  })
})
