import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { CloseCode, decodePairingOffer } from '@harnessdesk/contract'
import { RelaySim } from '@harnessdesk/phone-link/relay-sim'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import type { HarnessDeskAccountStatus, PhoneLinkState, WireNotification } from '@harnessdesk/protocol'
import { Logger } from '../src/log.js'
import { startPhoneLink, type PhoneLinkControl, type PhoneRelayAccount, type RunningPhoneLink } from '../src/phone-link.js'

const DESK = 'desk-'.padEnd(22, 'x')

/** The account as the phone link sees it, with the cloud's answers in the test's hands. */
class FakeAccount implements PhoneRelayAccount {
  snapshot: HarnessDeskAccountStatus = { status: 'signedOut', desk: { name: 'Studio Mac', reachable: false }, phones: [] }
  offline = false
  readonly unlinked: string[] = []
  readonly #listeners = new Set<(status: HarnessDeskAccountStatus) => void>()
  constructor(private readonly relay: RelaySim) {}

  emit(next: Partial<HarnessDeskAccountStatus>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.#listeners) listener(this.snapshot)
  }
  reachable(on: boolean): void { this.emit({ status: 'signedIn', desk: { name: 'Studio Mac', reachable: on } }) }
  async status() { return this.snapshot }
  onChange(listener: (status: HarnessDeskAccountStatus) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  async relayAccess() {
    if (this.offline) throw new Error('offline')
    return { url: this.relay.url, deskId: DESK, token: 'desk-token', prove: async () => 'proof' }
  }
  async createPhoneInvite() {
    if (this.offline) throw new Error('offline')
    return { invite: 'i'.repeat(43), api: 'https://cloud.example.com', relay: this.relay.url, expiresAt: Date.now() + 600_000 }
  }
  async unlinkPhone(deviceId: string) {
    if (this.offline) throw new Error('offline')
    this.unlinked.push(deviceId)
    this.snapshot = { ...this.snapshot, phones: this.snapshot.phones.filter(phone => phone.deviceId !== deviceId) }
    return this.snapshot
  }
}

let home = ''
let relay: RelaySim
let account: FakeAccount
let running: RunningPhoneLink | null = null
let control: PhoneLinkControl | null = null

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hd-phone-relay-host-'))
  relay = await RelaySim.start(DESK)
  account = new FakeAccount(relay)
})
afterEach(async () => {
  await running?.close()
  running = null
  await relay.close()
  await rm(home, { recursive: true, force: true })
})

const start = async () => {
  const host = {
    call: async (method: string) => ({ echoed: method }),
    addBroadcaster: (_listener: (notification: WireNotification) => void) => () => {},
    attachPhoneLink: (attached: PhoneLinkControl) => { control = attached },
  }
  running = await startPhoneLink(host as never, new Logger('test', { console: false }), {
    home, host: '127.0.0.1', name: 'Test desk', account, relay: { heartbeatMs: 40, random: () => 0, maxBackoffMs: 20 },
  })
  return control!
}

const until = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}
const relayIs = (state: PhoneLinkState['relay']) => until(() => control!.state().relay === state, `relay ${state}`)

test('the relay runs only while the desk is signed in and reachable, and the pairing code says whether it works away', async () => {
  const phone = await start()
  assert.equal(phone.state().relay, 'off')
  const nearOnly = await phone.pairing()
  assert.equal(nearOnly.away, false)
  assert.equal(decodePairingOffer(nearOnly.url).invite, undefined)
  account.reachable(true)
  await relayIs('connected')
  const away = await phone.pairing()
  assert.equal(away.away, true)
  assert.equal(decodePairingOffer(away.url).invite, 'i'.repeat(43))
  assert.equal(decodePairingOffer(away.url).relay, relay.url)
  account.offline = true
  assert.equal((await phone.pairing()).away, false, 'an invite that cannot be made leaves a code for this network')
  account.offline = false
  account.reachable(false)
  await relayIs('off')
  account.emit({ status: 'signedOut' })
  assert.equal(phone.state().relay, 'off')
})

test('a phone paired through the relay shows as connected through the account', async () => {
  const phone = await start()
  account.reachable(true)
  await relayIs('connected')
  const code = await phone.pairing()
  const sim = await PhoneSim.fromCode(code.url)
  await sim.connect(`${relay.url}/v1/phone/${DESK}`, sim.offer!.deskPub, { authorization: `Bearer ${await relay.ticketFor(sim)}` })
  await sim.enroll(sim.offer!.enroll, 'Jane’s phone')
  await until(() => phone.state().pending.length > 0, 'the phone to ask')
  phone.allow(phone.state().pending[0]!.id)
  await sim.next(m => m.t === 'enroll.ok')
  await until(() => phone.state().devices[0]?.route === 'account', 'the route')
  sim.close()
  await until(() => phone.state().devices[0]?.route === null, 'the phone to leave')
})

test('a desk another copy replaced stays stopped through later account refreshes, until Reachable is turned on again', async () => {
  const phone = await start()
  account.reachable(true)
  await relayIs('connected')
  const { RelayLink } = await import('@harnessdesk/phone-link')
  const other = new RelayLink({ credentials: () => account.relayAccess(), attach: () => ({ receive: () => {}, gone: () => {} }), random: () => 0 })
  other.start()
  try {
    await relayIs('replaced')
    // A phone away would reach the copy that took the room, so the code is for this network only.
    assert.equal((await phone.pairing()).away, false)
    account.reachable(true)
    account.reachable(true)
    await new Promise(r => setTimeout(r, 100))
    assert.equal(phone.state().relay, 'replaced')
  } finally { other.stop() }
  account.reachable(false)
  account.reachable(true)
  await relayIs('connected')
})

test('removing a phone on the Mac refuses it at once, and unlinks it from the account once the account can be reached, even when its list is stale', async () => {
  const phone = await start()
  account.reachable(true)
  await relayIs('connected')
  const code = await phone.pairing()
  const sim = await PhoneSim.fromCode(code.url)
  await sim.connect(`${relay.url}/v1/phone/${DESK}`, sim.offer!.deskPub, { authorization: `Bearer ${await relay.ticketFor(sim)}` })
  await sim.enroll(sim.offer!.enroll)
  await until(() => phone.state().pending.length > 0, 'the phone to ask')
  phone.allow(phone.state().pending[0]!.id)
  await sim.next(m => m.t === 'enroll.ok')
  // The account's last list predates this link, so the outbox cannot go by it.
  assert.deepEqual(account.snapshot.phones, [])
  account.offline = true
  await phone.revoke(sim.id)
  assert.equal((await sim.closedWith()).code, CloseCode.REVOKED)
  assert.deepEqual(account.unlinked, [])
  assert.deepEqual(JSON.parse(await readFile(join(home, 'phone-link', 'relay-unlinks.json'), 'utf8')), [sim.id])
  // A restart keeps the removal waiting.
  await running!.close()
  running = null
  account.offline = false
  await start()
  account.reachable(true)
  await until(() => account.unlinked.length === 1, 'the unlink')
  assert.deepEqual(account.unlinked, [sim.id])
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(JSON.parse(await readFile(join(home, 'phone-link', 'relay-unlinks.json'), 'utf8')), [])
})

test('a removal whose account unlink cannot be saved fails as a whole, and the phone stays', async () => {
  const phone = await start()
  account.reachable(true)
  await relayIs('connected')
  const code = await phone.pairing()
  const sim = await PhoneSim.fromCode(code.url)
  await sim.connect(`${relay.url}/v1/phone/${DESK}`, sim.offer!.deskPub, { authorization: `Bearer ${await relay.ticketFor(sim)}` })
  await sim.enroll(sim.offer!.enroll)
  await until(() => phone.state().pending.length > 0, 'the phone to ask')
  phone.allow(phone.state().pending[0]!.id)
  await sim.next(m => m.t === 'enroll.ok')
  // A directory where the outbox goes makes every save of it fail.
  const outbox = join(home, 'phone-link', 'relay-unlinks.json')
  await mkdir(outbox)
  await writeFile(join(outbox, 'keep'), '')
  await assert.rejects(phone.revoke(sim.id))
  assert.deepEqual(phone.state().devices.map(device => device.id), [sim.id])
  assert.deepEqual(account.unlinked, [])
  await rm(outbox, { recursive: true })
  await phone.revoke(sim.id)
  assert.equal((await sim.closedWith()).code, CloseCode.REVOKED)
  await until(() => account.unlinked.length === 1, 'the unlink')
})

test('a removal waits through an account the desk cannot use, and is sent once it signs in again', async () => {
  const phone = await start()
  account.reachable(true)
  await relayIs('connected')
  const code = await phone.pairing()
  const sim = await PhoneSim.fromCode(code.url)
  await sim.connect(`${relay.url}/v1/phone/${DESK}`, sim.offer!.deskPub, { authorization: `Bearer ${await relay.ticketFor(sim)}` })
  await sim.enroll(sim.offer!.enroll)
  await until(() => phone.state().pending.length > 0, 'the phone to ask')
  phone.allow(phone.state().pending[0]!.id)
  await sim.next(m => m.t === 'enroll.ok')
  // Storage the desk cannot read, or a session the account ended: signed out, with an error.
  account.emit({ status: 'signedOut', error: 'HarnessDesk could not read its saved sign-in.' })
  await phone.revoke(sim.id)
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(JSON.parse(await readFile(join(home, 'phone-link', 'relay-unlinks.json'), 'utf8')), [sim.id])
  account.snapshot = { status: 'signedIn', desk: { name: 'Studio Mac', reachable: true }, phones: [] }
  account.emit({})
  await until(() => account.unlinked.length === 1, 'the unlink')
  assert.deepEqual(account.unlinked, [sim.id])
})

test('removing a phone this desk never paired leaves nothing waiting for the account', async () => {
  const phone = await start()
  await phone.revoke('not-a-paired-device')
  await new Promise(r => setTimeout(r, 20))
  const saved = await readFile(join(home, 'phone-link', 'relay-unlinks.json'), 'utf8').catch(() => '[]')
  assert.deepEqual(JSON.parse(saved), [])
})
