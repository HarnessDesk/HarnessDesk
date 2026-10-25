import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { b64u, fromB64u, idFromPub, utf8, verifyEd25519 } from '@harnessdesk/crypto'
import { loadOrCreateDeskIdentity } from '@harnessdesk/phone-link'
import { AccountLink } from '../src/account-link.js'

const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (check: () => boolean) => { for (let i = 0; i < 400; i++) { if (check()) return; await pause(10) }; assert.fail('state did not arrive') }
const rig = async (outcome: 'approved' | 'denied' | 'expired' | 'pending' = 'approved', startStatus = 200, ttl = 60) => {
  const root = join(process.cwd(), 'output/desk-link'); await mkdir(root, { recursive: true })
  const home = await mkdtemp(join(root, 'host-'))
  let polls = 0, proofs = 0, release: (() => void) | undefined, held = false
  let deskId = ''
  const challenge = b64u(new Uint8Array(32).fill(3)), secret = 'local_fixture_poll_secret_1234567890123456'
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/desk/challenge') return void res.end(JSON.stringify({ challenge, expiresAt: Math.floor(Date.now() / 1000) + 60 }))
    if (req.url === '/desk-link/start') {
      deskId = await idFromPub(fromB64u(body.deskPub))
      assert.equal(await verifyEd25519(fromB64u(body.deskPub), fromB64u(body.sig), utf8(`hd-web-1/link\0${deskId}\0${challenge}`)), true)
      proofs++
      if (startStatus !== 200) { res.statusCode = startStatus; return void res.end('{}') }
      return void res.end(JSON.stringify({ userCode: 'ABCD-EFGH', pollSecret: secret, verifyUrl: 'https://example.com/link#code=ABCD-EFGH', expiresAt: Math.floor(Date.now() / 1000) + ttl, intervalSeconds: 1 }))
    }
    assert.equal(req.url, '/desk-link/poll'); assert.equal(body.pollSecret, secret); polls++
    if (held) await new Promise<void>(r => { release = r })
    if (outcome === 'expired') { res.statusCode = 410; return void res.end('{}') }
    res.end(JSON.stringify(outcome === 'approved' ? { status: outcome, deskId } : { status: outcome }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const changes: unknown[] = []
  const link = new AccountLink({ home, baseUrl: url, name: 'Studio', changed: s => changes.push(s) })
  await link.load()
  return { link, home, url, changes, get polls() { return polls }, get proofs() { return proofs }, hold() { held = true }, release() { release?.() },
    async done() { await link.close(); release?.(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(home, { recursive: true, force: true }) } }
}

test('a real proof uses the phone identity; approval persists without the poll secret and survives restart', async () => {
  const r = await rig()
  try {
    const phone = await loadOrCreateDeskIdentity(join(r.home, 'phone-link'))
    const waiting = await r.link.start(); assert.equal(waiting.status, 'waiting'); assert.equal(r.proofs, 1)
    assert.equal(JSON.stringify(waiting).includes('pollSecret'), false)
    await until(() => r.link.state().status === 'linked')
    const state = r.link.state(); assert.equal(state.status === 'linked' && state.deskId, phone.id)
    const stored = await readFile(join(r.home, 'account-link.json'), 'utf8'); assert.equal(stored.includes('pollSecret'), false); assert.equal(stored.includes('local_fixture'), false)
    await r.link.close()
    const restarted = new AccountLink({ home: r.home, baseUrl: r.url, changed() {} }); await restarted.load()
    assert.deepEqual(restarted.state(), state); await restarted.close()
    assert.ok(r.changes.length >= 3)
  } finally { await r.done() }
})
for (const outcome of ['denied', 'expired'] as const) test(`${outcome} ends polling`, async () => {
  const r = await rig(outcome)
  try { await r.link.start(); await until(() => r.link.state().status === outcome); const n = r.polls; await pause(1100); assert.equal(r.polls, n) } finally { await r.done() }
})
test('cancel aborts a poll in flight and ignores its late approval', async () => {
  const r = await rig(); r.hold()
  try { await r.link.start(); await until(() => r.polls > 0); assert.equal((await r.link.cancel()).status, 'idle'); r.release(); await pause(1100); assert.equal(r.link.state().status, 'idle'); assert.equal(r.polls, 1); assert.equal((await readdir(r.home)).includes('account-link.json'), false) } finally { await r.done() }
})
test('shutdown stops polling', async () => {
  const r = await rig('pending')
  try { await r.link.start(); await r.link.close(); await pause(1100); assert.equal(r.polls, 0) } finally { await r.done() }
})
for (const status of [401, 429]) test(`HTTP ${status} is a plain error state`, async () => {
  const r = await rig('pending', status)
  try { const state = await r.link.start(); assert.equal(state.status, 'error'); assert.match(state.status === 'error' ? state.reason : '', status === 401 ? /proof/i : /too many/i) } finally { await r.done() }
})
test('offline is a plain error state and an unset URL creates no files or calls', async () => {
  const r = await rig()
  try {
    const off = new AccountLink({ home: join(r.home, 'off'), changed() {} }); await off.load()
    assert.equal((await off.start()).status, 'unavailable'); assert.equal(off.enabled, false); await off.close()
    assert.equal((await readdir(r.home)).includes('off'), false)
    const offline = new AccountLink({ home: r.home, baseUrl: 'http://127.0.0.1:1', changed() {} }); await offline.load()
    assert.equal((await offline.start()).status, 'error'); await offline.close()
  } finally { await r.done() }
})

test('the real host advertises linking without LAN, dispatches controls, broadcasts approval and restores it', async () => {
  const r = await rig()
  const { Host } = await import('../src/host.js')
  const { StateStore } = await import('../src/state.js')
  const { Logger } = await import('../src/log.js')
  const { writeFile } = await import('node:fs/promises')
  const original = process.env['HARNESSDESK_CLOUD_URL']
  const open = async (url: string | undefined) => {
    if (url === undefined) delete process.env['HARNESSDESK_CLOUD_URL']; else process.env['HARNESSDESK_CLOUD_URL'] = url
    await mkdir(join(r.home, 'cache'), { recursive: true })
    await writeFile(join(r.home, 'cache/model-pricing.json'), JSON.stringify({ fetchedAt: Date.now(), catalogue: {} }))
    const host = new Host({ state: new StateStore(join(r.home, 'state.json')), logger: new Logger('test', { console: false }), builtinAgents: join(r.home, 'agents'), libraryHome: join(r.home, 'library'), catalogRefreshMs: 0 })
    await host.start(); return host
  }
  let host: InstanceType<typeof Host> | undefined
  try {
    host = await open(r.url)
    const hello = await host.call('host/hello', { clientVersion: 'fixture' })
    assert.equal(hello.capabilities?.accountLink, true); assert.equal(hello.capabilities?.phone, undefined)
    const changes: string[] = []; host.addBroadcaster(n => { if (n.method === 'account/link/changed') changes.push(n.params.status) })
    assert.equal((await host.call('account/link/start', {})).status, 'waiting')
    await until(() => changes.includes('linked'))
    assert.ok(changes.includes('starting')); assert.ok(changes.includes('waiting'))
    const approved = await host.call('account/link/state', {}); await host.dispose()
    host = await open(r.url); assert.deepEqual(await host.call('account/link/state', {}), approved); await host.dispose()
    host = await open(undefined)
    assert.equal((await host.call('host/hello', { clientVersion: 'fixture' })).capabilities?.accountLink, undefined)
    assert.equal((await host.call('account/link/start', {})).status, 'unavailable')
    assert.equal((await host.call('account/link/cancel', {})).status, 'unavailable')
  } finally {
    await host?.dispose(); if (original === undefined) delete process.env['HARNESSDESK_CLOUD_URL']; else process.env['HARNESSDESK_CLOUD_URL'] = original
    await r.done()
  }
})

test('the local deadline expires without needing a poll response', async () => {
  const r = await rig('pending', 200, 1)
  try { await r.link.start(); await until(() => r.link.state().status === 'expired'); assert.equal(r.polls, 0) } finally { await r.done() }
})
test('a second start shares the active grant; cancel during a start ignores its late result', async () => {
  const r = await rig('pending')
  try {
    await r.link.start(); assert.equal((await r.link.start()).status, 'waiting'); assert.equal(r.proofs, 1)
    await r.link.cancel()
    const starting = r.link.start(); await r.link.cancel(); await starting
    assert.equal(r.link.state().status, 'idle')
  } finally { await r.done() }
})
test('a saved link belongs to its service URL', async () => {
  const r = await rig()
  try {
    await r.link.start(); await until(() => r.link.state().status === 'linked')
    const other = new AccountLink({ home: r.home, baseUrl: 'http://127.0.0.1:1', changed() {} })
    await other.load(); assert.equal(other.state().status, 'idle'); await other.close()
  } finally { await r.done() }
})
