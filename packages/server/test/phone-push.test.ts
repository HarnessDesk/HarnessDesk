import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PushPlaintext, SendPushRequest } from '@harnessdesk/contract'
import { b64u, fromB64u, generatePushKey, openPushJson, randomBytes } from '@harnessdesk/crypto'
import type { Device } from '@harnessdesk/phone-link'
import type { AgentEvent, HarnessDeskAccountStatus, LeadInbox, LeadInboxItem, WireNotification } from '@harnessdesk/protocol'
import type { PhonePushStatus, SealedPhonePush } from '../src/harnessdesk-account.js'
import { Logger } from '../src/log.js'
import { startPhoneLink, type PhoneLinkControl, type PhoneRelayAccount } from '../src/phone-link.js'
import { PhonePushSender, PUSH_BODY_CHARS, PUSH_TITLE_CHARS, pushCollapse } from '../src/phone-push.js'

const device = (name: string, extra: Partial<Device> = {}): Device => ({
  id: b64u(randomBytes(16)), pub: b64u(randomBytes(32)), name, tiers: ['read', 'run', 'answer'], pushKey: b64u(generatePushKey()), kid: 1,
  createdAt: 1, lastSeenAt: null, ...extra,
})
const signedIn = (linked: readonly Device[], reachable = true): HarnessDeskAccountStatus => ({
  status: 'signedIn', account: { name: 'Jane Doe', email: 'dev@example.com', pictureUrl: null }, desk: { name: 'Test desk', reachable },
  phones: linked.map(one => ({ deviceId: one.id, name: one.name, lastSeenAt: null })),
})
const waiting = (id: string, kind: LeadInboxItem['kind'], title: string, extra: Partial<LeadInboxItem> = {}): LeadInboxItem =>
  ({ id, kind, title, at: 1, needsYou: true, ...extra })
const inboxOf = (...items: LeadInboxItem[]): LeadInbox => ({ version: 1, needsYou: items.filter(item => item.needsYou).length, items })

interface Sent { readonly push: SealedPhonePush }
/** The account service as the sender sees it: what it was handed, and the answer the test chooses. */
class FakeAccount {
  sent: Sent[] = []
  answer: (push: SealedPhonePush) => Promise<PhonePushStatus> = async () => 'sent'
  constructor(public snapshot: HarnessDeskAccountStatus) {}
  async status() { return this.snapshot }
  async sendPush(push: SealedPhonePush) {
    // Whatever the desk hands the account must be a request the service would accept.
    SendPushRequest.parse(push)
    this.sent.push({ push })
    return this.answer(push)
  }
}

const rig = (devices: Device[], linked: Device[], options: { reachable?: boolean } = {}) => {
  const account = new FakeAccount(signedIn(linked, options.reachable ?? true))
  let inbox = inboxOf()
  const logs: string[] = []
  const sender = new PhonePushSender({
    account, devices: () => devices, inbox: async () => inbox, leadName: async () => 'Dex', log: message => { logs.push(message) }, delayMs: 1,
  })
  const round = async (next: LeadInbox) => {
    inbox = next
    sender.poke()
    await new Promise(resolve => setTimeout(resolve, 10))
    await sender.settled()
  }
  return { account, sender, round, logs }
}
/** Opens a push as the phone would, checks it is the contract's `PushPlaintext`, and returns it without its per-push id and time. */
const open = async (target: Device, push: SealedPhonePush) => {
  const opened = PushPlaintext.parse(await openPushJson(fromB64u(target.pushKey), push.deviceId, { kid: push.kid, nonce: push.nonce, ciphertext: push.ciphertext }))
  assert.match(opened.id, /^[A-Za-z0-9_-]{22}$/)
  assert.ok(Number.isInteger(opened.ts) && opened.ts > 0)
  const { id: _id, ts: _ts, ...rest } = opened
  return rest
}

test('a newly waiting item sends one sealed push to each phone the account linked, and only to those', async () => {
  const linked = device('Linked phone')
  const second = device('Second linked phone')
  const nearby = device('Nearby only')
  const keyless = device('No push key', { pushKey: '' })
  const readless = device('Answer only', { tiers: ['answer'] })
  const { account, round, sender } = rig([linked, second, nearby, keyless, readless], [linked, second, keyless, readless])
  // What already waited when the sender started looking is the baseline: nothing is pushed for it.
  await round(inboxOf(waiting('team:g1', 'team', 'Ship the release')))
  assert.equal(account.sent.length, 0)
  await round(inboxOf(waiting('team:g1', 'team', 'Ship the release'), waiting('chat:codex:s1', 'chat', 'Fix the login page', { target: 'codex:s1' })))
  assert.deepEqual(account.sent.map(one => one.push.deviceId).sort(), [linked.id, second.id].sort())
  for (const { push } of account.sent) {
    const target = push.deviceId === linked.id ? linked : second
    assert.deepEqual(await open(target, push), { v: 1, title: 'Fix the login page', body: 'Waiting on you', kind: 'needs-you', deep: 'chat:codex:s1' })
    assert.equal(push.priority, 'high')
    assert.equal(push.collapse, pushCollapse('chat:codex:s1'))
    assert.match(push.collapse!, /^[A-Za-z0-9_-]{1,64}$/)
    // Sealed for its own phone: another phone's key does not open it.
    const other = push.deviceId === linked.id ? second : linked
    await assert.rejects(open(other, push))
  }
  sender.dispose()
})

test('an item is pushed once: not again while it waits, nor when it comes back soon after', async () => {
  const linked = device('Linked phone')
  const { account, round } = rig([linked], [linked])
  await round(inboxOf())
  const ask = waiting('ask:m1', 'ask', 'Which branch should the release go to?')
  await round(inboxOf(ask))
  await round(inboxOf(ask))
  await round(inboxOf())
  await round(inboxOf(ask))
  assert.equal(account.sent.length, 1)
  assert.deepEqual(await open(linked, account.sent[0]!.push), { v: 1, title: 'Dex', body: 'Which branch should the release go to?', kind: 'needs-you', deep: 'ask:m1' })
  // Nothing changed: no push.
  await round(inboxOf(ask))
  assert.equal(account.sent.length, 1)
})

test('a chat that waits on an approval says what it asks for, trimmed to one line', async () => {
  const linked = device('Linked phone')
  const { account, round, sender } = rig([linked], [linked])
  await round(inboxOf())
  const event = {
    type: 'approval/requested',
    approval: { type: 'command', id: 'a1', sessionId: 's2', requestedAt: 1, command: `npm test -- ${'--flag '.repeat(40)}`, cwd: '/tmp/project', actions: [], options: [] },
  } as unknown as AgentEvent
  sender.noteEvent('claude', event)
  await round(inboxOf(waiting('chat:claude:s2', 'chat', `A very long conversation title ${'x'.repeat(200)}`, { target: 'claude:s2' })))
  const body = await open(linked, account.sent[0]!.push) as { title: string; body: string }
  assert.match(body.body, /^Asks to run npm test -- --flag/)
  assert.ok(body.body.length <= PUSH_BODY_CHARS)
  assert.ok(body.title.length <= PUSH_TITLE_CHARS)
  assert.ok(account.sent[0]!.push.ciphertext.length <= 2752)
  // Settled approvals are forgotten, so a later push about the chat does not repeat an old request.
  sender.noteEvent('claude', { type: 'approval/resolved', sessionId: 's2', approvalId: 'a1', resolution: { outcome: 'timedOut' } } as unknown as AgentEvent)
})

test('failures are logged and dropped: network, refused, too many, no push token', async () => {
  const linked = device('Linked phone')
  const other = device('Other phone')
  const { account, round, logs } = rig([linked, other], [linked, other])
  await round(inboxOf())
  account.answer = async push => {
    if (push.deviceId === linked.id) throw new Error('network down')
    return 'unregistered'
  }
  await round(inboxOf(waiting('team:g1', 'team', 'One')))
  assert.equal(account.sent.length, 2)
  assert.ok(logs.includes('phone push failed'))
  // The phone with no push token is left alone for a while; the other is tried again for the next item.
  account.answer = async () => 'sent'
  await round(inboxOf(waiting('team:g1', 'team', 'One'), waiting('team:g2', 'team', 'Two')))
  assert.deepEqual(account.sent.slice(2).map(one => one.push.deviceId), [linked.id])
  // Not the item that failed, though: a failed push is never retried into a second one.
  assert.equal(account.sent.filter(one => one.push.collapse === pushCollapse('team:g1')).length, 2)
})

test('a 403 leaves that phone alone until the account changes, and a 429 holds every push back for a while', async () => {
  const linked = device('Linked phone')
  const other = device('Other phone')
  const account = new FakeAccount(signedIn([linked, other]))
  let inbox = inboxOf()
  let clock = 1_000_000
  const sender = new PhonePushSender({
    account, devices: () => [linked, other], inbox: async () => inbox, leadName: async () => 'Dex', log: () => {}, delayMs: 1,
    now: () => clock, refusalStatus: error => (error as { status?: number }).status,
  })
  const round = async (next: LeadInbox) => { inbox = next; sender.poke(); await new Promise(resolve => setTimeout(resolve, 10)); await sender.settled() }
  const refuse = (status: number) => Object.assign(new Error('refused'), { status })
  const items: LeadInboxItem[] = []
  const add = (id: string) => { items.push(waiting(id, 'team', id)); return inboxOf(...items) }
  await round(inboxOf())
  account.answer = async push => { if (push.deviceId === linked.id) throw refuse(403); return 'sent' }
  await round(add('team:a'))
  assert.equal(account.sent.length, 2)
  // Refused as not linked: that phone is left alone, the other still hears.
  await round(add('team:b'))
  assert.deepEqual(account.sent.slice(2).map(one => one.push.deviceId), [other.id])
  // The account says something new: the refused phone is tried again.
  account.answer = async () => 'sent'
  sender.accountChanged()
  await round(add('team:c'))
  assert.deepEqual(account.sent.slice(3).map(one => one.push.deviceId).sort(), [linked.id, other.id].sort())
  // Too many: nothing more goes out for a minute, then pushes resume.
  account.answer = async () => { throw refuse(429) }
  await round(add('team:d'))
  const before = account.sent.length
  account.answer = async () => 'sent'
  await round(add('team:e'))
  assert.equal(account.sent.length, before)
  clock += 61_000
  await round(add('team:f'))
  assert.equal(account.sent.length, before + 2)
  sender.dispose()
})

test('a phone link that stops mid-round sends nothing more', async () => {
  const first = device('First phone')
  const second = device('Second phone')
  const { account, sender } = rig([first, second], [first, second])
  let inbox = inboxOf()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  account.answer = async () => { await held; return 'sent' }
  const stopping = new PhonePushSender({
    account, devices: () => [first, second], inbox: async () => inbox, leadName: async () => 'Dex', log: () => {}, delayMs: 1,
  })
  sender.dispose()
  stopping.poke(); await new Promise(resolve => setTimeout(resolve, 10)); await stopping.settled()
  inbox = inboxOf(waiting('team:g1', 'team', 'Ship the release'))
  stopping.poke(); await new Promise(resolve => setTimeout(resolve, 10))
  // The first phone's send is under way; the link stops before the second phone's.
  assert.equal(account.sent.length, 1)
  stopping.dispose()
  release()
  await stopping.settled()
  assert.equal(account.sent.length, 1)
})

test('a phone removed while another phone is being pushed to gets nothing', async () => {
  const first = device('First phone')
  const second = device('Second phone')
  const paired = [first, second]
  const { account, round } = rig(paired, [first, second])
  await round(inboxOf())
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  account.answer = async () => { await held; return 'sent' }
  const pending = round(inboxOf(waiting('team:g1', 'team', 'Ship the release')))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(account.sent.length, 1)
  // Removed here while the first phone's send waits; the account's unlink has not gone through yet.
  paired.splice(paired.findIndex(one => one.id !== account.sent[0]!.push.deviceId), 1)
  release()
  await pending
  assert.equal(account.sent.length, 1)
})

test('the Lead waiting on several things says how many', async () => {
  const linked = device('Linked phone')
  const { account, round } = rig([linked], [linked])
  await round(inboxOf())
  await round(inboxOf(waiting('lead', 'lead', 'Dex is waiting for you', { count: 3 })))
  assert.deepEqual(await open(linked, account.sent[0]!.push), { v: 1, title: 'Dex', body: 'Waiting for you on 3 things', kind: 'needs-you', deep: 'lead' })
})

test('nothing is pushed while signed out or with Reachable from your phone off', async () => {
  const linked = device('Linked phone')
  const off = rig([linked], [linked], { reachable: false })
  await off.round(inboxOf())
  await off.round(inboxOf(waiting('team:g1', 'team', 'One')))
  assert.equal(off.account.sent.length, 0)
  const out = rig([linked], [linked])
  out.account.snapshot = { status: 'signedOut', desk: { name: 'Test desk', reachable: true }, phones: [] }
  await out.round(inboxOf())
  await out.round(inboxOf(waiting('team:g1', 'team', 'One')))
  assert.equal(out.account.sent.length, 0)
  // Signing in later starts from what waits then, so nothing that already waited is pushed.
  out.account.snapshot = signedIn([linked])
  await out.round(inboxOf(waiting('team:g1', 'team', 'One')))
  assert.equal(out.account.sent.length, 0)
  await out.round(inboxOf(waiting('team:g1', 'team', 'One'), waiting('team:g2', 'team', 'Two')))
  assert.equal(out.account.sent.length, 1)
})

test('the phone link pushes through the account when the Inbox changes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-phone-push-'))
  const linked = device('Linked phone')
  const nearby = device('Nearby only')
  await mkdir(join(home, 'phone-link'), { recursive: true })
  await writeFile(join(home, 'phone-link', 'phone-devices.json'), JSON.stringify({ v: 1, devices: [linked, nearby], revoked: {} }))
  const pushes: SealedPhonePush[] = []
  // Reachable is on, as pushes need; the relay it would also open is refused here and is not part of this test.
  const status = signedIn([linked])
  const account: PhoneRelayAccount = {
    status: async () => status, onChange: () => () => {},
    relayAccess: async () => { throw new Error('no relay in this test') },
    createPhoneInvite: async () => { throw new Error('no invites in this test') },
    unlinkPhone: async () => status,
    sendPush: async push => { pushes.push(push); return 'sent' },
  }
  let inbox = inboxOf()
  let broadcast: (notification: WireNotification) => void = () => {}
  const host = {
    call: async (method: string) => {
      if (method === 'lead/inbox/read') return inbox
      if (method === 'lead/thread/read') return { settings: { name: 'dex' } }
      return {}
    },
    addBroadcaster: (listener: (notification: WireNotification) => void) => { broadcast = listener; return () => {} },
    attachPhoneLink: (_control: PhoneLinkControl) => {},
  }
  const running = await startPhoneLink(host as never, new Logger('test', { console: false }), { home, host: '127.0.0.1', name: 'Test desk', account, pushDelayMs: 5 })
  try {
    const settle = () => new Promise(resolve => setTimeout(resolve, 60))
    broadcast({ method: 'lead/changed', params: {} } as never)
    await settle()
    inbox = inboxOf(waiting('ask:m9', 'ask', 'Merge it now?'))
    broadcast({ method: 'lead/changed', params: {} } as never)
    await settle()
    assert.equal(pushes.length, 1)
    assert.equal(pushes[0]!.deviceId, linked.id)
    assert.deepEqual(await open(linked, pushes[0]!), { v: 1, title: 'Dex', body: 'Merge it now?', kind: 'needs-you', deep: 'ask:m9' })
  } finally {
    await running.close()
    await rm(home, { recursive: true, force: true })
  }
})
