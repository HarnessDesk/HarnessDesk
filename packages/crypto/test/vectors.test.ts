import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  acceptHandshake, b64u, handshakeDeviceMessage, handshakeEnrollMessage, idFromPub, relayDeskProofMessage, sealPush, signToken, signingIdentityFromSeed,
  startPhoneHandshake, toHex, utf8, webDeskRegisterProofMessage,
} from '../src/index.js'

// Fixed inputs -> fixed outputs. The Swift and Node implementations must both reproduce this file.
// Regenerate on purpose with UPDATE_VECTORS=1; a diff here is a wire-format change.
// The test runs from dist/test, so the committed file is two directories up.
const seed = (n: number) => new Uint8Array(32).fill(n)
const path = fileURLToPath(new URL('../../test-vectors.json', import.meta.url))

async function build() {
  const desk = await signingIdentityFromSeed(seed(1))
  const device = await signingIdentityFromSeed(seed(2))
  const phone = await startPhoneHandshake(desk.pub, { seeds: { ephemeral: seed(3), nonce: new Uint8Array(16).fill(5) } })
  const { ready, session: deskSession } = await acceptHandshake(phone.hello, desk, { seeds: { ephemeral: seed(4), nonce: new Uint8Array(16).fill(6) } })
  const phoneSession = await phone.finish(ready)
  const p2d = await phoneSession.seal(utf8('{"t":"ping"}'))
  const d2p = await deskSession.seal(utf8('{"t":"pong"}'))
  await deskSession.open(p2d)
  await phoneSession.open(d2p)
  const tokenClaims = { kid: 'k1', iat: 1_999_999_000, exp: 2_000_000_000, typ: 'phone', desk: await idFromPub(desk.pub) }
  const token = await signToken(tokenClaims, desk)
  const push = await sealPush(seed(7), 1, 'device-1', utf8('{"title":"x"}'), new Uint8Array(12).fill(8))
  return {
    note: 'Seeds are filled bytes: desk=0x01*32 device=0x02*32 phoneEphemeral=0x03*32 deskEphemeral=0x04*32 pushKey=0x07*32',
    // Everything else an implementation needs to reproduce the outputs below.
    inputs: {
      phoneToDeskPlaintext: '{"t":"ping"}',
      deskToPhonePlaintext: '{"t":"pong"}',
      helloNonce: toHex(new Uint8Array(16).fill(5)),
      readyNonce: toHex(new Uint8Array(16).fill(6)),
      proofChallenge: 'challenge-1',
      tokenClaims,
      pushDeviceId: 'device-1',
      pushKid: 1,
      pushPlaintext: '{"title":"x"}',
      pushNonce: toHex(new Uint8Array(12).fill(8)),
      b64uSource: 'hello?',
    },
    deskPub: toHex(desk.pub),
    deskId: await idFromPub(desk.pub),
    devicePub: toHex(device.pub),
    deviceId: await idFromPub(device.pub),
    hello: toHex(phone.hello),
    ready: toHex(ready),
    th: toHex(phoneSession.th),
    phoneToDeskFrame0: toHex(p2d),
    deskToPhoneFrame0: toHex(d2p),
    deviceAuthSignature: toHex(await device.sign(handshakeDeviceMessage(phoneSession.th))),
    enrollSignature: toHex(await device.sign(handshakeEnrollMessage(phoneSession.th))),
    registerProofSignature: toHex(await desk.sign(webDeskRegisterProofMessage(await idFromPub(desk.pub), 'challenge-1'))),
    relayProofSignature: toHex(await desk.sign(relayDeskProofMessage(await idFromPub(desk.pub), 'challenge-1'))),
    token,
    push,
    tokenSigningNote: 'token signed by the desk key here only so the vector is deterministic',
    b64uExample: b64u(utf8('hello?')),
  }
}

it('matches the committed vectors', async () => {
  const actual = await build()
  if (process.env.UPDATE_VECTORS === '1') writeFileSync(path, JSON.stringify(actual, null, 2) + '\n')
  assert.deepEqual(actual, JSON.parse(readFileSync(path, 'utf8')))
})
