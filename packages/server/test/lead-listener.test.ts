import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Server } from 'node:http'
import test from 'node:test'
import { cleanupLeadClientDoors, openLeadClientDoor } from '../src/lead/client-authority.js'
import { silent } from './fixtures/harness.js'
import { Host, StateStore } from '../src/index.js'

test('host start sweeps stale private Lead listeners after acquiring the home writer', async t => {
  const home = await mkdtemp('/tmp/hd-l-')
  const parent = join(home, 'lead-clients'), stale = join(parent, 'hd-lead-ABC123')
  await mkdir(parent, { mode: 0o700 }); await mkdir(stale, { mode: 0o700 })
  await writeFile(join(stale, 'old.sock'), '')
  const host = new Host({ leadEnabled: true, logger: silent, state: new StateStore(join(home, 'state.json')), version: 'test', catalogRefreshMs: 0 })
  t.after(async () => { await host.dispose(); await rm(home, { recursive: true, force: true }) })
  await host.start()
  await assert.rejects(lstat(stale), { code: 'ENOENT' })
})

test('host-start cleanup removes only private Lead listener directories in this home', async t => {
  const home = await mkdtemp('/tmp/hd-l-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const parent = join(home, 'lead-clients')
  await mkdir(parent, { mode: 0o700 })
  const stale = join(parent, 'hd-lead-ABC123')
  await mkdir(stale, { mode: 0o700 }); await writeFile(join(stale, 'old.sock'), '')
  const foreign = join(parent, 'unrelated')
  await mkdir(foreign); await writeFile(join(foreign, 'keep'), 'foreign')
  const otherHome = join(home, 'other-home')
  await mkdir(otherHome); await writeFile(join(otherHome, 'keep'), 'other home')
  await symlink(otherHome, join(parent, 'hd-lead-LINK12'))
  await mkdir(join(parent, 'hd-lead-PUBLIC'), { mode: 0o755 })
  await chmod(join(parent, 'hd-lead-PUBLIC'), 0o755)
  await writeFile(join(parent, 'hd-lead-FILE12'), 'foreign file')
  await cleanupLeadClientDoors(home)
  await assert.rejects(lstat(stale), { code: 'ENOENT' })
  assert.equal(await readFile(join(foreign, 'keep'), 'utf8'), 'foreign')
  assert.equal(await readFile(join(otherHome, 'keep'), 'utf8'), 'other home')
  assert.equal((await lstat(join(parent, 'hd-lead-LINK12'))).isSymbolicLink(), true)
  assert.equal((await lstat(join(parent, 'hd-lead-PUBLIC'))).isDirectory(), true)
  assert.equal(await readFile(join(parent, 'hd-lead-FILE12'), 'utf8'), 'foreign file')
})

test('a private Lead listener lives beneath its home and closes its private directory', async t => {
  const home = await mkdtemp('/tmp/hd-l-')
  t.after(() => rm(home, { recursive: true, force: true }))
  t.mock.method(Server.prototype, 'listen', function (this: Server, path: string, ready: () => void) {
    void writeFile(path, '').then(ready)
    return this
  })
  t.mock.method(Server.prototype, 'close', function (this: Server, ready: () => void) { ready(); return this })
  const door = await openLeadClientDoor({ host: {} as any, home, logger: silent,
    hostVersion: 'test', authority: { identity: 'lead', maximumTiers: ['read'], authorize: async () => null } })
  assert.ok(door)
  t.after(() => door.close())
  assert.equal(dirname(dirname(door.socketPath)), join(await realpath(home), 'lead-clients'))
  assert.equal((await lstat(dirname(door.socketPath))).mode & 0o777, 0o700)
  await door.close()
  assert.deepEqual(await readdir(join(home, 'lead-clients')), [])
})

test('host-start cleanup refuses a linked Lead parent without touching its target', async t => {
  const home = await mkdtemp('/tmp/hd-l-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const target = join(home, 'foreign')
  await mkdir(target); await mkdir(join(target, 'hd-lead-ABC123'), { mode: 0o700 })
  await symlink(target, join(home, 'lead-clients'))
  await assert.rejects(cleanupLeadClientDoors(home), /lead-listener-parent/)
  assert.equal((await lstat(join(target, 'hd-lead-ABC123'))).isDirectory(), true)
})

test('unsafe Lead listener parent blocks Lead but preserves ordinary host startup', async t => {
  const { Host, StateStore } = await import('../src/index.js')
  const home = await mkdtemp('/tmp/hd-l-')
  await mkdir(join(home, 'lead-clients'), { mode: 0o755 })
  await chmod(join(home, 'lead-clients'), 0o755)
  const host = new Host({ leadEnabled: true, logger: silent, state: new StateStore(join(home, 'state.json')), version: 'test', catalogRefreshMs: 0 })
  t.after(async () => { try { await host.dispose() } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } })
  await host.start()
  assert.throws(() => host.createLeadService({} as any), /lead-listener-unavailable/)
  assert.equal((await lstat(join(home, 'lead-clients'))).mode & 0o777, 0o755)
})

test('Lead service cannot start a child before host recovery owns the desk', async t => {
  const home = await mkdtemp('/tmp/hd-l-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const host = new Host({ leadEnabled: true, logger: silent, state: new StateStore(join(home, 'state.json')), version: 'test', catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  assert.throws(() => host.createLeadService({} as any), /lead-host-starting/)
})

test('a home too deep for a socket path keeps its private Lead listener in a short per-user directory', async t => {
  const root = await mkdtemp('/tmp/hd-l-')
  const home = join(root, 'a-home-directory-deep-enough-that-a-unix-socket-path-beneath-it-overflows-the-limit')
  await mkdir(home)
  t.after(() => rm(root, { recursive: true, force: true }))
  t.mock.method(Server.prototype, 'listen', function (this: Server, path: string, ready: () => void) {
    void writeFile(path, '').then(ready)
    return this
  })
  t.mock.method(Server.prototype, 'close', function (this: Server, ready: () => void) { ready(); return this })
  const door = await openLeadClientDoor({ host: {} as any, home, logger: silent,
    hostVersion: 'test', authority: { identity: 'lead', maximumTiers: ['read'], authorize: async () => null } })
  assert.ok(door)
  const parent = dirname(dirname(door.socketPath))
  t.after(() => rm(parent, { recursive: true, force: true }))
  assert.ok(door.socketPath.length < 104, door.socketPath)
  assert.ok(parent.startsWith('/tmp/hd-lead-'), parent)
  await door.close()
  assert.deepEqual(await readdir(parent), [])
})
