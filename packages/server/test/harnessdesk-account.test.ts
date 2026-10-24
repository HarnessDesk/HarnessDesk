import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { b64u, fromB64u, idFromPub, verifyEd25519, webDeskLinkProofMessage, webDeskProofMessage } from '@harnessdesk/crypto'
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
  let approved = options.approved ?? false; let denied = false; let name = 'Studio Mac'; let deskId = ''; let revoked = false
  let waitPath: string | null = null; let releasePath: (() => void) | null = null; let requestWait: Promise<void> | null = null
  let refuse = false; let deferPoll: (() => void) | null = null; let pollWait: Promise<void> | null = null
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>
    calls.push({ path: url.pathname, body })
    if (url.pathname === waitPath && requestWait) await requestWait
    if (url.pathname === '/v1/desk/challenge') return Response.json({ challenge: 'A'.repeat(43), expiresAt: 99999 })
    if (url.pathname === '/v1/desk-link/start') {
      deskId = await idFromPub(fromB64u(body.deskPub!))
      assert.equal(await verifyEd25519(fromB64u(body.deskPub!), fromB64u(body.sig!), webDeskLinkProofMessage(deskId, body.challenge!)), true)
      name = body.name!
      return Response.json({ userCode: 'ABCD-EFGH', pollSecret: 'p'.repeat(43), verifyUrl: options.verifyUrl ?? 'https://cloud.example.com/link#code=ABCD-EFGH', expiresAt: 99999, intervalSeconds: 3 })
    }
    if (url.pathname === '/v1/desk-link/poll') {
      if (pollWait) await pollWait
      return Response.json({ status: denied ? 'denied' : approved ? 'approved' : 'pending', ...(approved ? { deskId } : {}) })
    }
    if (url.pathname === '/v1/desk/session') {
      assert.equal(await verifyEd25519(fromB64u(body.deskPub!), fromB64u(body.sig!), webDeskProofMessage(deskId, body.challenge!)), true)
      return Response.json({ deskToken: 'fake-desk-session', expiresAt: 99999, relayUrl: 'wss://relay.example.com' })
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake-desk-session')
    if (refuse) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 })
    if (url.pathname === '/v1/desk/account') return Response.json({ account: { ...account, pictureUrl: options.pictureUrl ?? null }, desk: { deskId, name }, phones: revoked ? [] : [{ deviceId, name: 'Phone', lastSeenAt: null }] })
    if (url.pathname === '/v1/desk/rename') { name = body.name!; return Response.json({ deskId, name }) }
    if (url.pathname === '/v1/links/revoke') { assert.equal(body.deskId, deskId); revoked = true; return Response.json({ ok: true }) }
    if (url.pathname === '/v1/desks/revoke') { assert.equal(body.deskId, deskId); return Response.json({ ok: true }) }
    throw new Error('unexpected fake route')
  }
  const service = new HarnessDeskAccount({ state, readPicture: options.readPicture, cipher: options.plain ? undefined : cipher, cloudUrl: 'https://cloud.example.com', fetch: request, openExternal: async (url: string) => { opened.push(url) }, changed: (status: unknown) => changes.push(status), now: () => now, setTimer: (fn: () => Promise<void>) => { timers.push(fn); return fn }, clearTimer: () => {} })
  return { service, setPictureUrl: (url: string | undefined) => { options.pictureUrl = url }, setNow: (value: number) => { now = value }, state, request, cipher, opened, changes, calls, dir, timers, holdRequest: (path: string) => { waitPath = path; requestWait = new Promise<void>(r => { releasePath = r }); return () => releasePath!() }, approve: () => { approved = true }, deny: () => { denied = true }, refuse: () => { refuse = true }, holdPoll: () => { pollWait = new Promise<void>(r => { deferPoll = r }); return () => deferPoll!() } }
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
  const persisted = await readFile(join(r.dir, 'account.sealed'))
  assert.equal(persisted.includes('fake-desk-session'), false); assert.equal(persisted.includes('jane@example.com'), false)
  assert.equal(JSON.stringify(signedIn).includes('fake-desk-session'), false)
  assert.ok(r.changes.length >= 2); r.service.close()
})
test('cancel fences a late approved poll and never establishes a session', async () => {
  const r = await rig(); await r.service.signIn(); r.approve()
  const release = r.holdPoll(); const polling = r.timers.shift()!(); await r.service.cancel(); release(); await polling
  assert.equal((await r.service.status()).status, 'signedOut')
  assert.equal(r.calls.some(c => c.path === '/v1/desk/session'), false); r.service.close()
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
  await r.service.cancel(); release(); await polling; r.service.close()
  const reopened = new HarnessDeskAccount({ state: r.state, cipher: r.cipher, cloudUrl: 'https://cloud.example.com', fetch: r.request, changed: () => {} })
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
  const service = new HarnessDeskAccount({ state: r.state, cipher: r.cipher, cloudUrl: 'https://cloud.example.com', fetch: r.request, changed: () => {} })
  assert.deepEqual((await service.status()).desk, { name: 'Office Mac', reachable: true }); service.close()
})
test('cancel during the first profile read discards the new stored session', async () => {
  const r = await rig(); await r.service.signIn(); r.approve()
  const release = r.holdRequest('/v1/desk/account'); const polling = r.timers.shift()!()
  await until(() => r.calls.some(c => c.path === '/v1/desk/account'))
  await r.service.cancel(); release(); await polling; r.service.close()
  const reopened = new HarnessDeskAccount({ state: r.state, cipher: r.cipher, cloudUrl: 'https://cloud.example.com', fetch: r.request, changed: () => {} })
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
  assert.equal(r.calls.some(c => c.path === '/v1/desk-link/poll'), false); r.service.close()
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
