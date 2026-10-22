import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CloseCode, DeskId, DeskToRelay, PairingOffer, RelayToDesk, SendPushRequest, decodeDeskFrame, decodePairingOffer, encodeDeskFrame, encodePairingOffer,
  FirstPhoneMessage, PUSH_PLAINTEXT_MAX_BYTES, PublicKey, PushPlaintext,
} from '../src/index.js'

const key = 'A'.repeat(43)
const offer = { v: 1 as const, deskPub: key, name: 'Studio Mac', enroll: 'B'.repeat(21) + 'A', invite: 'x'.repeat(32), exp: 1_800_000_000 }

describe('contract', () => {
  it('round-trips a pairing link', () => {
    assert.deepEqual(decodePairingOffer(encodePairingOffer(offer)), offer)
  })

  it('rejects a pairing link with a bad key, a wrong scheme and junk', () => {
    assert.throws(() => encodePairingOffer({ ...offer, deskPub: 'short' }))
    assert.throws(() => decodePairingOffer('https://example.com'))
    assert.throws(() => decodePairingOffer('harnessdesk://pair?c=!!'))
    assert.equal(PairingOffer.safeParse({ ...offer, v: 2 }).success, false)
  })

  it('frames carry the connection id in front', () => {
    const f = encodeDeskFrame(0xdeadbeef, Uint8Array.of(1, 2, 3))
    assert.deepEqual(decodeDeskFrame(f), { conn: 0xdeadbeef, payload: Uint8Array.of(1, 2, 3) })
    assert.equal(decodeDeskFrame(Uint8Array.of(1, 2)), null)
  })

  it('validates control messages strictly', () => {
    assert.equal(RelayToDesk.safeParse({ t: 'open', conn: 1, dev: 'd' }).success, true)
    assert.equal(RelayToDesk.safeParse({ t: 'open', conn: -1, dev: 'd' }).success, false)
    assert.equal(DeskToRelay.safeParse({ t: 'close', conn: 1, code: 4401 }).success, true)
    assert.equal(DeskToRelay.safeParse({ t: 'close', conn: 1, code: 1000 }).success, false)
    assert.equal(DeskToRelay.safeParse({ t: 'nope' }).success, false)
  })

  it('close codes are in the private range and unique', () => {
    const codes = Object.values(CloseCode)
    assert.equal(new Set(codes).size, codes.length)
    for (const c of codes) assert.ok(c >= 4000)
  })

  it('ids have exactly the lengths the derivation produces', () => {
    assert.equal(DeskId.safeParse('A'.repeat(22)).success, true)
    assert.equal(DeskId.safeParse('A'.repeat(21)).success, false)
    assert.equal(DeskId.safeParse('A'.repeat(21) + '+').success, false)
  })

  it('ids have one spelling: the unused bits of the last character are zero', () => {
    assert.equal(DeskId.safeParse('A'.repeat(21) + 'Q').success, true)
    assert.equal(DeskId.safeParse('A'.repeat(21) + 'B').success, false)
    assert.equal(PublicKey.safeParse('A'.repeat(42) + 'E').success, true)
    assert.equal(PublicKey.safeParse('A'.repeat(42) + 'B').success, false)
  })

  it('bounds the push request so the APNs payload stays under 4 KB', () => {
    const base = { deviceId: 'A'.repeat(22), kid: 1, nonce: 'A'.repeat(16) }
    assert.equal(SendPushRequest.safeParse({ ...base, ciphertext: 'A'.repeat(2752) }).success, true)
    assert.equal(SendPushRequest.safeParse({ ...base, ciphertext: 'A'.repeat(2900) }).success, false)
    assert.equal(PushPlaintext.safeParse({ v: 1, id: 'a', ts: 1, kind: 'done', title: 't', body: 'b' }).success, true)
  })

  it('refuses a push body that is short in characters but too big once escaped', () => {
    // A control character is six bytes in JSON, so 80 + 240 of them, with the other fields full, pass a character
    // limit and overflow the 2048-byte cap that sealing enforces.
    const esc = '\u001b'
    const heavy = { v: 1, id: 'i'.repeat(64), ts: 1, kind: 'done', title: esc.repeat(80), body: esc.repeat(240), card: 'c'.repeat(64), deep: 'd'.repeat(200) }
    assert.equal(PushPlaintext.safeParse(heavy).success, false)
    assert.equal(PushPlaintext.safeParse({ ...heavy, title: 't', body: 'b' }).success, true)
    assert.equal(PUSH_PLAINTEXT_MAX_BYTES, 2048)
  })

  it('accepts only auth or enroll as a first phone message', () => {
    assert.equal(FirstPhoneMessage.safeParse({ t: 'req', id: '1', method: 'x' }).success, false)
    assert.equal(FirstPhoneMessage.safeParse({ t: 'auth', dev: 'A'.repeat(22), sig: 'A'.repeat(86) }).success, true)
  })
})
