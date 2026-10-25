import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { b64u, fromB64u, idFromPub, verifyEd25519, webDeskLinkProofMessage, webDeskProofMessage } from '@harnessdesk/crypto'
import { Client, start, stop } from './fixtures/harness.js'
import { StateStore } from '../src/state.js'
import { HarnessDeskAccount } from '../src/harnessdesk-account.js'

const directories: string[] = []
after(async () => { for (const dir of directories) await rm(dir, { recursive: true, force: true }) })
const cipherKey = randomBytes(32)
const cipher = {
  protection: 'Test keystore',
  encrypt(text: string) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', cipherKey, iv); return Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]) },
  decrypt(blob: Buffer) { const d = createDecipheriv('aes-256-gcm', cipherKey, blob.subarray(0, 12)); d.setAuthTag(blob.subarray(-16)); return Buffer.concat([d.update(blob.subarray(12, -16)), d.final()]).toString('utf8') },
}
async function until(condition: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 2000
  while (!await condition()) {
    assert.ok(Date.now() < deadline, 'expected account work to settle')
    await new Promise(resolve => setImmediate(resolve))
  }
}
const account = { name: 'Jane Doe', email: 'jane@example.com', pictureUrl: null }
const deviceId = 'A'.repeat(22)
async function rig(options: { approved?: boolean; verifyUrl?: string; plain?: boolean; pictureUrl?: string; readPicture?: (url: string) => Promise<string | undefined> } = {}) {
  await mkdir('scratch/desktop-sign-in', { recursive: true })
  const dir = await mkdtemp('scratch/desktop-sign-in/account-test-')
  directories.push(dir)
  const state = new StateStore(join(dir, 'state.json')); await state.load()
  const opened: string[] = []; const changes: unknown[] = []; const calls: {path: string; body: Record<string, string>}[] = []
  const timers: (() => Promise<void>)[] = []
  let now = 1_000_000
  const faults = new Map<string, number | 'offline'>()
  let pollDeskId: string | undefined
  let lostDeleteReply: 'offline' | 500 | undefined
  let cloudRevoked = false
  let approved = options.approved ?? false; let denied = false; let name = 'Studio Mac'; let deskId = ''; let revoked = false
  let waitPath: string | null = null; let releasePath: (() => void) | null = null; let requestWait: Promise<void> | null = null
  let refuse = false; let deferPoll: (() => void) | null = null; let pollWait: Promise<void> | null = null
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>
    calls.push({ path: url.pathname, body })
    if (url.pathname === waitPath && requestWait) { const waiting = requestWait; requestWait = null; await waiting }
    const fault = faults.get(url.pathname)
    if (fault === 'offline') throw new Error('offline')
    if (fault) return Response.json({ error: { code: 'fake_failure' } }, { status: fault })
    if (url.pathname === '/v1/desk/challenge') return Response.json({ challenge: 'A'.repeat(43), expiresAt: 99999 })
    if (url.pathname === '/v1/desk-link/start') {
      deskId = await idFromPub(fromB64u(body.deskPub!))
      assert.equal(await verifyEd25519(fromB64u(body.deskPub!), fromB64u(body.sig!), webDeskLinkProofMessage(deskId, body.challenge!)), true)
      name = body.name!
      return Response.json({ userCode: 'ABCD-EFGH', pollSecret: 'p'.repeat(43), verifyUrl: options.verifyUrl ?? 'https://cloud.example.com/link#code=ABCD-EFGH', expiresAt: 99999, intervalSeconds: 3 })
    }
    if (url.pathname === '/v1/desk-link/poll') {
      if (pollWait) { const waiting = pollWait; pollWait = null; await waiting }
      return Response.json({ status: denied ? 'denied' : approved ? 'approved' : 'pending', ...(approved ? { deskId: pollDeskId ?? deskId } : {}) })
    }
    if (url.pathname === '/v1/desk/session') {
      if (!approved || cloudRevoked) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 })
      assert.equal(await verifyEd25519(fromB64u(body.deskPub!), fromB64u(body.sig!), webDeskProofMessage(deskId, body.challenge!)), true)
      return Response.json({ deskToken: 'fake-desk-session', expiresAt: Math.max(99999, Math.floor(now / 1000) + 3600), relayUrl: 'wss://relay.example.com' })
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-desk-session')
    if (refuse) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 })
    if (url.pathname === '/v1/desk/account') return Response.json({ account: { ...account, pictureUrl: options.pictureUrl ?? null }, desk: { deskId, name }, phones: revoked ? [] : [{ deviceId, name: 'Phone', lastSeenAt: null }] })
    if (url.pathname === '/v1/desk/rename') { name = body.name!; return Response.json({ deskId, name }) }
    if (url.pathname === '/v1/links/revoke') { assert.equal(body.deskId, deskId); revoked = true; return Response.json({ ok: true }) }
    if (url.pathname === '/v1/account/delete') {
      if (cloudRevoked) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 })
      cloudRevoked = true
      if (lostDeleteReply === 'offline') throw new Error('fake response lost after commit')
      if (lostDeleteReply === 500) return Response.json({ error: { code: 'fake_response_lost' } }, { status: 500 })
      return Response.json({ ok: true })
    }
    if (url.pathname === '/v1/desks/revoke') { assert.equal(body.deskId, deskId); cloudRevoked = true; return Response.json({ ok: true }) }
    throw new Error('unexpected fake route')
  }
  const service = new HarnessDeskAccount({ state, readPicture: options.readPicture, cipher: options.plain ? undefined : cipher, cloudUrl: 'https://cloud.example.com', fetch: request, openExternal: async (url: string) => { opened.push(url) }, changed: (status: unknown) => changes.push(status), now: () => now, setTimer: (fn: () => Promise<void>) => { timers.push(fn); return fn }, clearTimer: () => {} })
  return { service, loseDeleteReply: (failure: 'offline' | 500) => { lostDeleteReply = failure }, fault: (path: string, status: number | 'offline') => faults.set('/v1' + path, status), wrongDesk: () => { pollDeskId = 'B'.repeat(21) + 'A' }, setPictureUrl: (url: string | undefined) => { options.pictureUrl = url }, setNow: (value: number) => { now = value }, state, request, cipher, opened, changes, calls, dir, timers, holdRequest: (path: string) => { waitPath = path; requestWait = new Promise<void>(r => { releasePath = r }); return () => releasePath!() }, approve: () => { approved = true }, deny: () => { denied = true }, refuse: () => { refuse = true }, holdPoll: () => { pollWait = new Promise<void>(r => { deferPoll = r }); return () => deferPoll!() } }
}

test('browser sign-in shows matching code, proves key, polls, and persists only encrypted secrets', async () => {
  const r = await rig()
  const pending = await r.service.signIn()
  assert.equal(pending.status, 'pending'); assert.equal(pending.pending?.userCode, 'ABCD-EFGH')
  assert.equal(JSON.stringify(pending).includes('pollSecret'), false)
  assert.deepEqual(r.opened, ['https://cloud.example.com/link#code=ABCD-EFGH'])
  r.approve(); await r.timers.shift()!()
  const signedIn = await r.service.status()
  assert.equal(signedIn.status, 'signedIn'); assert.deepEqual(signedIn.account, account)
  const files = (await readdir(r.dir)).filter(file => file.endsWith('.sealed'))
  assert.equal(files.length, 1)
  const persisted = await readFile(join(r.dir, files[0]!))
  const syntheticSecrets = JSON.parse(cipher.decrypt(persisted)) as { key: string }
  assert.equal(persisted.includes(syntheticSecrets.key), false)
  assert.equal(persisted.includes(Buffer.from(fromB64u(syntheticSecrets.key))), false)
  assert.equal(persisted.includes('fake-desk-session'), false); assert.equal(persisted.includes('jane@example.com'), false)
  assert.equal(JSON.stringify(signedIn).includes('fake-desk-session'), false)
  assert.ok(r.changes.length >= 2); r.service.close()
})
test('cancel fences a late approved poll and revokes the approved desk', async () => {
  const r = await rig(); await r.service.signIn(); r.approve()
  const release = r.holdPoll(); const polling = r.timers.shift()!(); const cancelling = r.service.cancel(); release(); await cancelling; await polling
  assert.equal((await r.service.status()).status, 'signedOut')
  assert.equal(r.calls.some(c => c.path === '/v1/desks/revoke'), true); r.service.close()
})
test('untrusted verification URL is rejected before browser opening', async () => {
  const r = await rig({ verifyUrl: 'https://attacker.example.com/link#code=ABCD-EFGH' })
  await assert.rejects(r.service.signIn(), /page|verification|cloud/i)
  assert.equal(r.opened.length, 0); r.service.close()
})
test('account keys never use the standalone plaintext credential fallback', async () => {
  const r = await rig({ plain: true })
  await assert.rejects(r.service.signIn(), /secure|encrypted|keychain/i)
  assert.equal(r.calls.length, 0); r.service.close()
})
test('rename, reachable preference, unlink, and sign out use this desk scope', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!()
  assert.equal((await r.service.renameDesk('Office Mac')).desk.name, 'Office Mac')
  assert.equal((await r.service.setReachable(false)).desk.reachable, false)
  assert.deepEqual((await r.service.unlinkPhone(deviceId)).phones, [])
  assert.equal((await r.service.signOut()).status, 'signedOut')
  assert.ok(r.calls.some(c => c.path === '/v1/desks/revoke')); r.service.close()
})
test('denied approval returns signed out without a desk session', async () => {
  const r = await rig(); await r.service.signIn(); r.deny(); await r.timers.shift()!()
  assert.equal((await r.service.status()).status, 'signedOut'); assert.equal(r.calls.some(c => c.path === '/v1/desk/session'), false); r.service.close()
})

test('cancel during session creation never restores a canceled account on restart', async () => {
  const r = await rig(); await r.service.signIn(); r.approve()
  const release = r.holdRequest('/v1/desk/session'); const polling = r.timers.shift()!()
  await until(() => r.calls.some(c => c.path === '/v1/desk/session'))
  const cancelling = r.service.cancel(); release(); await cancelling; await polling; r.service.close()
  const reopened = new HarnessDeskAccount({ state: r.state, cipher: r.cipher, cloudUrl: 'https://cloud.example.com', now: () => 1_000_000, fetch: r.request, changed: () => {} })
  assert.equal((await reopened.status()).status, 'signedOut'); reopened.close()
})
test('revocation detected on metadata refresh clears the stored session', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!()
  r.refuse(); await r.timers.shift()!()
  assert.equal((await r.service.status()).status, 'signedOut'); r.service.close()
})
test('saved desk preferences are visible before any sign-in', async () => {
  const r = await rig(); r.service.close()
  await r.state.setPreferences({ accountDeskName: 'Office Mac', accountReachable: true })
  const service = new HarnessDeskAccount({ state: r.state, cipher: r.cipher, cloudUrl: 'https://cloud.example.com', now: () => 1_000_000, fetch: r.request, changed: () => {} })
  assert.deepEqual((await service.status()).desk, { name: 'Office Mac', reachable: true }); service.close()
})
test('cancel during the first profile read discards the new stored session', async () => {
  const r = await rig(); await r.service.signIn(); r.approve()
  const release = r.holdRequest('/v1/desk/account'); const polling = r.timers.shift()!()
  await until(() => r.calls.some(c => c.path === '/v1/desk/account'))
  const cancelling = r.service.cancel(); release(); await cancelling; await polling; r.service.close()
  const reopened = new HarnessDeskAccount({ state: r.state, cipher: r.cipher, cloudUrl: 'https://cloud.example.com', now: () => 1_000_000, fetch: r.request, changed: () => {} })
  assert.equal((await reopened.status()).status, 'signedOut'); reopened.close()
})
test('cancel fences a sign-in that has only been queued', async () => {
  const r = await rig()
  const signingIn = r.service.signIn(); await r.service.cancel(); await signingIn
  assert.equal((await r.service.status()).status, 'signedOut'); assert.equal(r.opened.length, 0); r.service.close()
})
test('an encrypted signed-in account survives an offline restart with a retry', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!(); r.service.close()
  const retries: unknown[] = []
  const service = new HarnessDeskAccount({ state: r.state, cipher: r.cipher, cloudUrl: 'https://cloud.example.com', fetch: async () => { throw new Error('offline') }, setTimer: fn => { retries.push(fn); return fn }, changed: () => {} })
  const restored = await service.status()
  assert.equal(restored.status, 'signedIn'); assert.deepEqual(restored.account, account); assert.equal(retries.length, 1); service.close()
})

test('account pictures reach the renderer as host-validated raster data and survive encrypted cache', async () => {
  const pictureUrl = 'https://images.example.com/jane.png'
  const pictureDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYVQAAAAASUVORK5CYII='
  let reads = 0
  const r = await rig({ pictureUrl, readPicture: async url => { assert.equal(url, pictureUrl); reads++; return pictureDataUrl } })
  await r.service.signIn(); r.approve(); await r.timers.shift()!()
  await until(async () => !!(await r.service.status()).account?.pictureDataUrl)
  assert.equal((await r.service.status()).account?.pictureDataUrl, pictureDataUrl); assert.equal(reads, 1)
  await r.timers.shift()!(); assert.equal(reads, 1); r.service.close()
  const reopened = new HarnessDeskAccount({ state: r.state, cipher: r.cipher, cloudUrl: 'https://cloud.example.com', fetch: async () => { throw new Error('offline') }, changed: () => {} })
  assert.equal((await reopened.status()).account?.pictureDataUrl, pictureDataUrl); reopened.close()
})
test('background account refresh and rename cannot overwrite each other out of order', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!()
  const release = r.holdRequest('/v1/desk/account'); const refreshing = r.timers.shift()!()
  await new Promise(resolve => setImmediate(resolve))
  const renaming = r.service.renameDesk('Office Mac'); release(); await refreshing; await renaming
  assert.equal((await r.service.status()).desk.name, 'Office Mac'); r.service.close()
})
test('a transient picture failure retries on the next account refresh', async () => {
  const pictureDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYVQAAAAASUVORK5CYII='
  let reads = 0
  const r = await rig({ pictureUrl: 'https://images.example.com/jane.png', readPicture: async () => ++reads === 1 ? undefined : pictureDataUrl })
  await r.service.signIn(); r.approve(); await r.timers.shift()!(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 1); assert.equal((await r.service.status()).account?.pictureDataUrl, undefined)
  await r.timers.shift()!()
  assert.equal(reads, 2)
  await until(async () => !!(await r.service.status()).account?.pictureDataUrl)
  r.service.close()
})

test('expired codes stop polling and require a new explicit sign-in', async () => {
  const r = await rig(); await r.service.signIn(); r.setNow(100_000_000)
  await r.timers.shift()!()
  assert.equal((await r.service.status()).status, 'signedOut')
  assert.equal(r.calls.filter(c => c.path === '/v1/desk-link/poll').length, 1); r.service.close()
})
test('desk sessions renew with a fresh signed challenge before expiry', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!()
  r.setNow(99_950_000); await r.timers.shift()!()
  assert.equal(r.calls.filter(c => c.path === '/v1/desk/session').length, 2)
  assert.equal((await r.service.status()).status, 'signedIn'); r.service.close()
})

test('an account picture is fetched again after its URL is removed and restored', async () => {
  const pictureDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYVQAAAAASUVORK5CYII='
  let reads = 0
  const url = 'https://images.example.com/jane.png'
  const r = await rig({ pictureUrl: url, readPicture: async () => { reads++; return pictureDataUrl } })
  await r.service.signIn(); r.approve(); await r.timers.shift()!()
  await until(async () => !!(await r.service.status()).account?.pictureDataUrl)
  r.setPictureUrl(undefined); await r.timers.shift()!()
  assert.equal((await r.service.status()).account?.pictureDataUrl, undefined)
  r.setPictureUrl(url); await r.timers.shift()!()
  assert.equal(reads, 2)
  await until(async () => !!(await r.service.status()).account?.pictureDataUrl); r.service.close()
})

test('an approved desk is revoked when cancelled before the first poll', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.service.cancel()
  assert.equal((await r.service.status()).status, 'signedOut')
  assert.equal(r.calls.filter(c => c.path === '/v1/desk-link/poll').length, 1)
  assert.equal(r.calls.filter(c => c.path === '/v1/desks/revoke').length, 1); r.service.close()
})
test('startup revokes a lost pending approval using the sealed identity', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); r.service.close()
  const reopened = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', now: () => 1_000_000, fetch: r.request, changed: () => {} })
  assert.equal((await reopened.status()).status, 'signedOut')
  assert.equal(r.calls.filter(c => c.path === '/v1/desks/revoke').length, 1); reopened.close()
})
for (const path of ['/desk/challenge', '/desk/session', '/desks/revoke']) for (const status of [401, 404]) {
  test(`sign-out clears the local account after ${path} returns ${status}`, async () => {
    const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!()
    r.setNow(99_950_000); r.fault(path, status)
    assert.equal((await r.service.signOut()).status, 'signedOut')
    assert.deepEqual((await readdir(r.dir)).filter(file => file.endsWith('.sealed')), []); r.service.close()
  })
}
test('offline sign-out exposes a structured fallback and local-only sign-out removes the key', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!()
  r.fault('/desks/revoke', 'offline')
  await assert.rejects(r.service.signOut(), error => error instanceof Error && (error as { wireCode?: string }).wireCode === 'accountCloudUnreachable')
  const priorCalls = r.calls.length
  assert.equal((await r.service.signOut(true)).status, 'signedOut')
  assert.equal(r.calls.length, priorCalls)
  assert.deepEqual((await readdir(r.dir)).filter(file => file.endsWith('.sealed')), []); r.service.close()
})
test('final expiry poll accepts an approval made before expiry', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); r.setNow(100_000_000)
  await r.timers.shift()!(); assert.equal((await r.service.status()).status, 'signedIn'); r.service.close()
})
test('429 at link start explains how to retry', async () => {
  const r = await rig(); r.fault('/desk-link/start', 429)
  await assert.rejects(r.service.signIn(), { message: 'Too many attempts. Try again in a few minutes.' }); r.service.close()
})
test('an approved poll for another desk never establishes an account', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); r.wrongDesk(); await r.timers.shift()!()
  assert.notEqual((await r.service.status()).status, 'signedIn')
  assert.equal(r.calls.some(c => c.path === '/v1/desk/session'), false); r.service.close()
})
for (const status of [401, 404]) test(`poll ${status} ends the pending flow without a session`, async () => {
  const r = await rig(); await r.service.signIn(); r.fault('/desk-link/poll', status); await r.timers.shift()!()
  assert.equal((await r.service.status()).status, 'signedOut')
  assert.equal(r.calls.some(c => c.path === '/v1/desk/session'), false); r.service.close()
})
test('unreadable sealed bytes are preserved and cannot be silently replaced by sign-in', async () => {
  const r = await rig(); await r.service.signIn(); r.service.close()
  const file = (await readdir(r.dir)).find(file => file.endsWith('.sealed'))!
  const opaque = Buffer.from('unreadable synthetic ciphertext'); await writeFile(join(r.dir, file), opaque)
  const reopened = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', now: () => 1_000_000, fetch: r.request, openExternal: async () => {}, changed: () => {} })
  const status = await reopened.status(); assert.equal(status.status, 'signedOut'); assert.match(status.error ?? '', /kept|preserv|could not be opened/i)
  await assert.rejects(reopened.signIn(), /kept|preserv|could not be opened/i)
  assert.deepEqual(await readFile(join(r.dir, file)), opaque); reopened.close()
})
test('staging and production keep separate sealed identities in the same desk', async () => {
  const r = await rig(); await r.service.signIn(); r.service.close()
  const filesBefore = (await readdir(r.dir)).filter(file => file.endsWith('.sealed'))
  const productionBlob = await readFile(join(r.dir, filesBefore[0]!))
  const staging = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://staging.example.com', now: () => 1_000_000, fetch: async (input, init) => {
    const response = await r.request(input, init)
    if (String(input).endsWith('/desk-link/start')) { const data = await response.json() as Record<string, unknown>; return Response.json({ ...data, verifyUrl: 'https://staging.example.com/link#code=ABCD-EFGH' }) }
    return response
  }, openExternal: async () => {}, changed: () => {} })
  await staging.signIn(); staging.close()
  const files = (await readdir(r.dir)).filter(file => file.endsWith('.sealed'))
  assert.equal(files.length, 2)
  assert.deepEqual(await readFile(join(r.dir, filesBefore[0]!)), productionBlob)
})

test('a readable legacy identity migrates without leaving a sign-out resurrection copy', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!(); r.service.close()
  const file = (await readdir(r.dir)).find(file => file.endsWith('.sealed'))!
  const blob = await readFile(join(r.dir, file))
  // Simulate a quit between writing the new origin file and removing the legacy copy.
  await writeFile(join(r.dir, 'account.sealed'), blob)
  const reopened = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', now: () => 1_000_000, fetch: r.request, changed: () => {} })
  await reopened.status(); await reopened.signOut(true); reopened.close()
  assert.deepEqual((await readdir(r.dir)).filter(file => file.endsWith('.sealed')), [])
})
test('a readable legacy-only identity moves to its origin file', async () => {
  const r = await rig(); await r.service.signIn(); r.service.close()
  const file = (await readdir(r.dir)).find(file => file.endsWith('.sealed'))!
  const blob = await readFile(join(r.dir, file)); await writeFile(join(r.dir, 'account.sealed'), blob); await rm(join(r.dir, file))
  const reopened = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', now: () => 1_000_000, fetch: r.request, changed: () => {} })
  await reopened.status(); reopened.close()
  const files = (await readdir(r.dir)).filter(file => file.endsWith('.sealed'))
  assert.deepEqual(files, [file])
})
test('a local-only sign-out after an offline restart never attempts cloud cleanup or restores its key', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!(); r.service.close()
  let requests = 0
  const offline = async () => { requests++; throw new Error('offline') }
  const reopened = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', fetch: offline, changed: () => {} })
  assert.equal((await reopened.signOut(true)).status, 'signedOut'); reopened.close(); assert.equal(requests, 0)
  const again = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', fetch: offline, changed: () => {} })
  assert.equal((await again.status()).status, 'signedOut'); again.close(); assert.equal(requests, 0)
})
test('an unfinished cleanup that cannot reach the cloud is retried from sealed state next startup', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); r.fault('/desks/revoke', 'offline')
  assert.equal((await r.service.cancel()).status, 'signedOut'); r.service.close()
  // Restore the fake peer and restart from the pending key without a local session.
  const reopened = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', now: () => 1_000_000, fetch: async (input, init) => {
    if (String(input).endsWith('/desks/revoke')) return Response.json({ ok: true })
    return r.request(input, init)
  }, changed: () => {} })
  await reopened.status(); reopened.close()
  assert.equal(r.calls.filter(c => c.path === '/v1/desk/session').length, 2)
})
for (const unavailable of [undefined, { protection: 'file permissions only', encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }]) {
  test(`a host with ${unavailable ? 'plaintext-only' : 'no'} cipher preserves the desktop identity in both sign-out modes`, async () => {
    const r = await rig(); await r.service.signIn(); r.service.close()
    const file = (await readdir(r.dir)).find(file => file.endsWith('.sealed'))!
    const blob = await readFile(join(r.dir, file))
    for (const localOnly of [false, true]) {
      const reopened = new HarnessDeskAccount({ state: r.state, cipher: unavailable, cloudUrl: 'https://cloud.example.com', fetch: async () => { assert.fail('no cloud calls without a secure cipher') }, changed: () => {} })
      assert.equal((await reopened.signOut(localOnly)).status, 'signedOut')
      assert.match((await reopened.status()).error ?? '', /kept|preserv|could not be opened/i)
      assert.deepEqual(await readFile(join(r.dir, file)), blob); reopened.close()
    }
  })
}
test('an unreadable legacy blob is kept and blocks silently minting a replacement identity', async () => {
  const r = await rig(); r.service.close()
  const blob = Buffer.from('opaque synthetic legacy data'); await writeFile(join(r.dir, 'account.sealed'), blob)
  const reopened = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', fetch: r.request, openExternal: async () => {}, changed: () => {} })
  assert.equal((await reopened.status()).status, 'signedOut')
  await assert.rejects(reopened.signIn(), /kept|preserv|could not be opened/i)
  assert.deepEqual(await readFile(join(r.dir, 'account.sealed')), blob); reopened.close()
})
test('an unreadable legacy sibling does not disable a valid origin identity or local sign-out', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!(); r.service.close()
  await mkdir(join(r.dir, 'account.sealed'))
  const reopened = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', now: () => 1_000_000, fetch: r.request, changed: () => {} })
  assert.equal((await reopened.status()).status, 'signedIn')
  assert.equal((await reopened.signOut(true)).status, 'signedOut'); reopened.close()
  assert.equal((await readdir(r.dir)).includes('account.sealed'), true)
  const again = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', fetch: r.request, changed: () => {} })
  assert.equal((await again.status()).status, 'signedOut'); again.close()
})
test('startup cleans an approved legacy key even when no pending record survived', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); r.service.close()
  const file = (await readdir(r.dir)).find(file => file.endsWith('.sealed'))!
  const data = JSON.parse(cipher.decrypt(await readFile(join(r.dir, file)))) as Record<string, unknown>
  delete data.pending; await writeFile(join(r.dir, file), cipher.encrypt(JSON.stringify(data)))
  const reopened = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', now: () => 1_000_000, fetch: r.request, changed: () => {} })
  assert.equal((await reopened.status()).status, 'signedOut'); reopened.close()
  assert.equal(r.calls.filter(c => c.path === '/v1/desks/revoke').length, 1)
})

test('account deletion clears this origin identity and notifies signed out only after cloud success', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!()
  const release = r.holdRequest('/v1/account/delete')
  const deleting = r.service.deleteAccount()
  await until(() => r.calls.some(c => c.path === '/v1/account/delete'))
  assert.equal((await r.service.status()).status, 'signedIn')
  assert.equal((await readdir(r.dir)).filter(file => file.endsWith('.sealed')).length, 1)
  release(); await deleting
  assert.equal((await r.service.status()).status, 'signedOut')
  assert.deepEqual(r.changes.at(-1), await r.service.status())
  assert.deepEqual((await readdir(r.dir)).filter(file => file.endsWith('.sealed')), [])
  assert.deepEqual(r.calls.find(c => c.path === '/v1/account/delete')!.body, {})
  r.service.close()
  const again = new HarnessDeskAccount({ state: r.state, cipher, cloudUrl: 'https://cloud.example.com', fetch: r.request, changed: () => {} })
  assert.equal((await again.status()).status, 'signedOut'); again.close()
})
for (const failure of ['offline', 404, 500] as const) test(`failed account deletion (${failure}) keeps the local identity`, async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!()
  const file = (await readdir(r.dir)).find(file => file.endsWith('.sealed'))!
  const saved = await readFile(join(r.dir, file)); const before = r.changes.length
  r.fault('/account/delete', failure)
  await assert.rejects(r.service.deleteAccount(), failure === 'offline' || failure === 500 ? { message: "Can't reach HarnessDesk. Try again when you're online." } : /HarnessDesk/)
  assert.equal((await r.service.status()).status, 'signedIn')
  assert.deepEqual(await readFile(join(r.dir, file)), saved)
  assert.equal(r.changes.length, before); r.service.close()
})
test('account deletion requires a signed-in account and never creates a new identity', async () => {
  const r = await rig()
  await assert.rejects(r.service.deleteAccount(), /Sign in to HarnessDesk first/)
  assert.equal(r.calls.length, 0)
  assert.deepEqual((await readdir(r.dir)).filter(file => file.endsWith('.sealed')), []); r.service.close()
})

for (const lostReply of ['offline', 500] as const) for (const retryPath of ['delete', 'session'] as const) {
  test(`delete retry clears local identity after committed deletion lost as ${lostReply} and ${retryPath} returns 401`, async () => {
    const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!()
    r.loseDeleteReply(lostReply)
    await assert.rejects(r.service.deleteAccount(), { message: "Can't reach HarnessDesk. Try again when you're online." })
    assert.equal((await r.service.status()).status, 'signedIn')
    assert.equal((await readdir(r.dir)).filter(file => file.endsWith('.sealed')).length, 1)
    if (retryPath === 'session') r.setNow(100_000_000)
    assert.equal((await r.service.deleteAccount()).status, 'signedOut')
    assert.deepEqual(r.changes.at(-1), await r.service.status())
    assert.deepEqual((await readdir(r.dir)).filter(file => file.endsWith('.sealed')), [])
    assert.equal(r.calls.filter(c => c.path === '/v1/account/delete').length, retryPath === 'delete' ? 2 : 1)
    r.service.close()
  })
}
test('delete rate limiting has a distinct retry message and preserves the sealed identity', async () => {
  const r = await rig(); await r.service.signIn(); r.approve(); await r.timers.shift()!()
  const file = (await readdir(r.dir)).find(file => file.endsWith('.sealed'))!
  const before = await readFile(join(r.dir, file)); const changes = r.changes.length
  r.fault('/account/delete', 429)
  await assert.rejects(r.service.deleteAccount(), { message: 'Too many attempts. Try again in a few minutes.' })
  assert.equal((await r.service.status()).status, 'signedIn')
  assert.deepEqual(await readFile(join(r.dir, file)), before)
  assert.equal(r.changes.length, changes); r.service.close()
})
for (const failure of ['offline', 500] as const) test(`delete ${failure} carries the preview's real error code over the renderer wire`, async t => {
  const r = await rig(); t.after(() => r.service.close())
  await r.service.signIn(); r.approve(); await r.timers.shift()!(); r.fault('/account/delete', failure)
  const wireDir = join(r.dir, 'wire-host'); await mkdir(wireDir)
  const harness = await start({}, wireDir); t.after(() => stop(harness))
  const call = harness.host.call.bind(harness.host)
  harness.host.call = ((method, params) => method === 'account/delete' ? r.service.deleteAccount() : call(method, params)) as typeof harness.host.call
  const client = await Client.connect(harness.server); t.after(() => client.close())
  await assert.rejects(client.call('account/delete', {}), { code: 'accountCloudUnreachable', message: "Can't reach HarnessDesk. Try again when you're online." })
})
