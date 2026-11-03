import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { CloseCode } from '@harnessdesk/contract'
import { PhoneLinkService, RelayLink, RelayUnavailableError, type PhonePolicy, type RelayCredentials, type RelayState } from '../src/index.js'
import { CHALLENGE, RelaySim } from '../src/relay-sim.js'
import { PhoneSim } from '../src/sim.js'
import WebSocket from 'ws'

const policy: PhonePolicy = {
  methods: { 'lead/thread/read': 'read', 'lead/thread/send': 'run' },
  topics: { lead: 'read' },
  defaultTiers: ['read', 'run'],
}

const DESK = 'desk-'.padEnd(22, 'x')

let dir = ''
let relay: RelaySim
let service: PhoneLinkService
let link: RelayLink | null = null
const states: RelayState[] = []
const asked: boolean[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hd-phone-relay-'))
  relay = await RelaySim.start(DESK)
  service = await PhoneLinkService.start({
    dir, policy, host: '127.0.0.1', name: 'Test desk', confirmTimeoutMs: 2000,
    call: async method => ({ echoed: method }),
  })
  states.length = 0
  asked.length = 0
})
afterEach(async () => {
  link?.stop()
  link = null
  await service.close()
  await relay.close()
  await rm(dir, { recursive: true, force: true })
})

const credentials = (token = () => 'desk-token') => async (fresh: boolean): Promise<RelayCredentials> => {
  asked.push(fresh)
  return { url: relay.url, deskId: DESK, token: token(), prove: async challenge => `proof-of-${challenge.slice(0, 4)}` }
}

const startLink = (extra: Partial<ConstructorParameters<typeof RelayLink>[0]> = {}) => {
  link = new RelayLink({
    credentials: credentials(), attach: (conn, dev, transport) => service.attachRelay(conn, dev, transport),
    onState: state => states.push(state), random: () => 0, heartbeatMs: 40, ...extra,
  })
  link.start()
  return link
}

const until = async (check: () => boolean, what: string, ms = 3000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; states ${states.join(' → ')}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

const allowNext = async () => {
  await until(() => service.pending().length > 0, 'the phone to wait for the person')
  assert.ok(service.allow(service.pending()[0]!.id))
}

/** Pairs a phone through the relay alone, with the code's secret and the person's answer, as away from home. */
const pairThroughRelay = async () => {
  const code = service.createPairingCode()
  const phone = await PhoneSim.fromCode(code.url)
  await phone.connect(`${relay.url}/v1/phone/${DESK}`, phone.offer!.deskPub, { authorization: `Bearer ${await relay.ticketFor(phone)}` })
  await phone.enroll(phone.offer!.enroll, 'Jane’s phone')
  await allowNext()
  await phone.next(m => m.t === 'enroll.ok')
  return phone
}

/** A bare socket on the phone side, for tests about the room rather than the session; resolves with its close code. */
const rawPhone = async (): Promise<number> => {
  const ticket = await relay.ticketFor(await PhoneSim.create())
  const ws = new WebSocket(`${relay.url}/v1/phone/${DESK}`, { headers: { authorization: `Bearer ${ticket}` } })
  return new Promise(resolve => ws.once('close', code => resolve(code)))
}

describe('the relay link', () => {
  test('connects with the desk token and a signed challenge, and says so once the room is ready', async () => {
    startLink()
    await until(() => link!.state === 'connected', 'connected')
    assert.deepEqual(relay.desks, [{ token: 'desk-token', proof: `proof-of-${CHALLENGE.slice(0, 4)}` }])
    assert.deepEqual(states, ['connecting', 'connected'])
  })

  test('a phone away from home pairs, waits for the person, and runs the same session', async () => {
    startLink()
    await until(() => link!.state === 'connected', 'connected')
    const phone = await pairThroughRelay()
    assert.equal(service.devices().length, 1)
    assert.equal(service.routeOf(phone.id), 'account')
    assert.deepEqual((await phone.request('lead/thread/read')).result, { echoed: 'lead/thread/read' })
    phone.close()
    await until(() => service.routeOf(phone.id) === null, 'the phone to leave')
    assert.equal(link!.phones, 0)
  })

  test('a paired phone signs back in through the relay', async () => {
    startLink()
    await until(() => link!.state === 'connected', 'connected')
    const first = await pairThroughRelay()
    first.close()
    const again = await PhoneSim.create(first.key)
    await again.connect(`${relay.url}/v1/phone/${DESK}`, service.deskPub, { authorization: `Bearer ${await relay.ticketFor(again)}` })
    await again.auth()
    await again.next(m => m.t === 'auth.ok')
    assert.equal(service.routeOf(again.id), 'account')
    again.close()
  })

  test('a key other than the one the account linked is refused, and the pairing code is left for the right phone', async () => {
    startLink()
    await until(() => link!.state === 'connected', 'connected')
    const code = service.createPairingCode()
    const linked = await PhoneSim.fromCode(code.url)
    const ticket = await relay.ticketFor(linked)
    const impostor = await PhoneSim.fromCode(code.url)
    await impostor.connect(`${relay.url}/v1/phone/${DESK}`, service.deskPub, { authorization: `Bearer ${ticket}` })
    await impostor.enroll(impostor.offer!.enroll)
    assert.equal((await impostor.next(m => m.t === 'error')).code, CloseCode.UNAUTHORIZED)
    assert.equal(service.pending().length, 0)
    await linked.connect(`${relay.url}/v1/phone/${DESK}`, service.deskPub, { authorization: `Bearer ${ticket}` })
    await linked.enroll(linked.offer!.enroll)
    await allowNext()
    await linked.next(m => m.t === 'enroll.ok')
    linked.close()
  })

  test('removing a phone on the Mac closes its relay session too', async () => {
    startLink()
    await until(() => link!.state === 'connected', 'connected')
    const phone = await pairThroughRelay()
    await service.revoke(phone.id)
    assert.equal((await phone.closedWith()).code, CloseCode.REVOKED)
  })

  test('another copy of this desk taking the room stops this one, and it does not fight back', async () => {
    startLink()
    await until(() => link!.state === 'connected', 'connected')
    const other = new RelayLink({ credentials: credentials(), attach: () => ({ receive: () => {}, gone: () => {} }), random: () => 0 })
    other.start()
    try {
      await until(() => link!.state === 'replaced', 'replaced')
      await new Promise(r => setTimeout(r, 100))
      assert.equal(relay.desks.length, 2)
      assert.equal(other.state, 'connected')
    } finally { other.stop() }
  })

  test('a refused token is renewed once; refused again, the desk stops trying', async () => {
    relay.tokens.clear()
    let turn = 0
    startLink({ credentials: credentials(() => (turn++ === 0 ? 'stale' : 'desk-token')) })
    relay.tokens.add('desk-token')
    await until(() => link!.state === 'connected', 'connected after a fresh session')
    assert.deepEqual(asked, [false, true])
    link!.stop()
    relay.tokens.clear()
    asked.length = 0
    startLink()
    await until(() => link!.state === 'refused', 'refused')
    assert.deepEqual(asked, [false, true])
  })

  test('a relay that stops answering is probed, then left, then found again', async () => {
    startLink()
    await until(() => link!.state === 'connected', 'connected')
    relay.answerPings = false
    const first = relay.desk
    await until(() => relay.desks.length === 2 && relay.desk !== first, 'a second connection', 2000)
    relay.answerPings = true
    await until(() => link!.state === 'connected', 'connected again')
  })

  test('a relay that is down reads as connecting at first, and as unreachable only after a few tries', async () => {
    relay.down = true
    startLink({ maxBackoffMs: 20 })
    await until(() => link!.state === 'unreachable', 'unreachable')
    assert.equal(states[0], 'connecting')
    assert.ok(asked.length > 3, `tried ${asked.length} times`)
    relay.down = false
    await until(() => link!.state === 'connected', 'connected once it is back')
  })

  test('holds at the number of phones the relay allows', async () => {
    relay.maxPhones = 1
    startLink()
    await until(() => link!.state === 'connected', 'connected')
    const phone = await pairThroughRelay()
    const extra = await PhoneSim.create()
    await assert.rejects(extra.connect(`${relay.url}/v1/phone/${DESK}`, service.deskPub, { authorization: `Bearer ${await relay.ticketFor(extra)}` }))
    assert.equal(extra.closed?.code, CloseCode.RATE_LIMITED)
    phone.close()
  })

  test('a late close of an old socket leaves the new one, its phones and its heartbeat alone', async () => {
    startLink({ closeGraceMs: 150 })
    await until(() => link!.state === 'connected', 'connected')
    relay.holdDesk()
    link!.stop()
    link!.start()
    await until(() => link!.state === 'connected' && relay.desks.length === 2, 'the second socket')
    const phone = await pairThroughRelay()
    // The held socket gives up after its grace and closes late, after the new one is in use.
    await new Promise(r => setTimeout(r, 300))
    assert.equal(link!.state, 'connected')
    assert.equal(link!.phones, 1)
    assert.deepEqual((await phone.request('lead/thread/read')).result, { echoed: 'lead/thread/read' })
    relay.answerPings = false
    await until(() => relay.desks.length === 3, 'the heartbeat to notice a silent relay', 2000)
    relay.answerPings = true
  })

  test('a phone the desk refuses while it attaches is closed on the relay, not left hanging', async () => {
    startLink({ attach: (_conn, _dev, transport) => { transport.close(CloseCode.RATE_LIMITED, 'too many attempts'); return { receive: () => {}, gone: () => {} } } })
    await until(() => link!.state === 'connected', 'connected')
    const code = await rawPhone()
    assert.equal(code, CloseCode.RATE_LIMITED)
    assert.equal(link!.phones, 0)
  })

  test('a message larger than the relay allows ends only that phone, and the desk stays up', async () => {
    relay.maxFrame = 2048
    startLink({ attach: (_conn, _dev, transport) => { setTimeout(() => transport.send(new Uint8Array(4096)), 10); return { receive: () => {}, gone: () => {} } } })
    await until(() => link!.state === 'connected', 'connected')
    assert.equal(await rawPhone(), CloseCode.FRAME_TOO_LARGE)
    assert.equal(link!.state, 'connected')
    assert.equal(relay.desks.length, 1)
  })

  test('frames past the relay’s rate wait their turn instead of costing the socket', async () => {
    let sent = 0
    startLink({ framesPerSecond: 200, attach: (_conn, _dev, transport) => {
      setTimeout(() => { for (let i = 0; i < 150; i++) { transport.send(new Uint8Array([i])); sent++ } }, 10)
      return { receive: () => {}, gone: () => {} }
    } })
    await until(() => link!.state === 'connected', 'connected')
    const ticket = await relay.ticketFor(await PhoneSim.create())
    const ws = new WebSocket(`${relay.url}/v1/phone/${DESK}`, { headers: { authorization: `Bearer ${ticket}` } })
    let got = 0
    ws.on('message', () => { got++ })
    const started = Date.now()
    await until(() => got === 150, 'every frame', 3000)
    assert.equal(sent, 150)
    assert.ok(Date.now() - started >= 200, 'the frames past the burst were paced')
    ws.close()
  })

  test('a phone the desk closes gets what was already queued for it before the close', async () => {
    startLink({ framesPerSecond: 200, attach: (_conn, _dev, transport) => {
      setTimeout(() => {
        for (let i = 0; i < 120; i++) transport.send(new Uint8Array([i]))
        transport.close(CloseCode.REVOKED, 'removed')
      }, 10)
      return { receive: () => {}, gone: () => {} }
    } })
    await until(() => link!.state === 'connected', 'connected')
    const ticket = await relay.ticketFor(await PhoneSim.create())
    const ws = new WebSocket(`${relay.url}/v1/phone/${DESK}`, { headers: { authorization: `Bearer ${ticket}` } })
    let got = 0
    let closedAfter = -1
    ws.on('message', () => { got++ })
    ws.on('close', code => { if (code === CloseCode.REVOKED) closedAfter = got })
    await until(() => closedAfter >= 0, 'the close', 3000)
    assert.equal(closedAfter, 120, 'the paced frames arrived before the close')
  })

  test('a relay that drops the desk right after ready still backs off, and says it cannot be reached', async () => {
    relay.dropAfterReady = true
    startLink({ maxBackoffMs: 20 })
    await until(() => link!.state === 'unreachable', 'unreachable')
    assert.ok(states.includes('connected'))
    relay.dropAfterReady = false
    await until(() => link!.state === 'connected' && relay.desk !== null, 'connected once it holds')
  })

  test('a room that admits the desk but never says ready is left and tried again', async () => {
    relay.withholdReady = true
    startLink({ readyMs: 30, maxBackoffMs: 20 })
    await until(() => relay.desks.length >= 2, 'a second connection')
    assert.ok(!states.includes('connected'))
    relay.withholdReady = false
    await until(() => link!.state === 'connected', 'connected once the room is ready')
  })

  test('an account that names no relay leaves the link off instead of asking again and again', async () => {
    let calls = 0
    startLink({ credentials: async () => { calls++; throw new RelayUnavailableError('no relay') }, maxBackoffMs: 20 })
    await until(() => link!.state === 'off', 'off')
    await new Promise(r => setTimeout(r, 100))
    assert.equal(calls, 1)
    assert.deepEqual(states, ['connecting', 'off'])
    assert.equal(relay.desks.length, 0)
  })

  test('a phone the relay names with something other than a device id is never attached', async () => {
    let attached = 0
    const logged: string[] = []
    startLink({ attach: () => { attached++; return { receive: () => {}, gone: () => {} } }, log: message => logged.push(message) })
    await until(() => link!.state === 'connected', 'connected')
    relay.tickets.set('bad', 'x'.repeat(5000))
    const ws = new WebSocket(`${relay.url}/v1/phone/${DESK}`, { headers: { authorization: 'Bearer bad' } })
    await new Promise(resolve => ws.once('open', resolve))
    await until(() => logged.includes('relay sent a message this desk does not know'), 'the refusal')
    assert.equal(attached, 0)
    ws.terminate()
  })

  test('a pairing code from a desk with an account carries the invite, and ends when the invite does', async () => {
    const expiresAt = Date.now() + 60_000
    const { offer, expiresAt: ends } = service.createPairingCode(600, { invite: 'i'.repeat(32), api: 'https://api.example.com', relay: 'wss://relay.example.com', expiresAt })
    assert.equal(offer.invite, 'i'.repeat(32))
    assert.equal(offer.relay, 'wss://relay.example.com')
    assert.equal(offer.api, 'https://api.example.com')
    assert.equal(ends, Math.floor(expiresAt / 1000) * 1000)
    assert.equal(offer.exp, Math.floor(expiresAt / 1000))
    // The desk refuses the secret once the code says it ended, even from a phone that ignores what the code says.
    assert.equal(service.registry.takeOffer(offer.enroll, ends), false)
    const next = service.createPairingCode(600, { invite: 'i'.repeat(32), api: 'https://api.example.com', relay: 'wss://relay.example.com', expiresAt })
    assert.equal(service.registry.takeOffer(next.offer.enroll, next.expiresAt - 1), true)
  })
})
