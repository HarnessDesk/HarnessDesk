import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, realpath, rm, writeFile, mkdir, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { Logger } from '../src/log.js'
import { Worktrees } from '../src/worktree.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

if (process.platform === 'darwin') {
  const binary = execFileSync('xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim()
  process.env.PATH = `${dirname(binary)}${delimiter}${process.env.PATH ?? ''}`
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Jane Doe', GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Jane Doe', GIT_COMMITTER_EMAIL: 'dev@example.com' },
}).trim()
const exists = (path: string) => access(path).then(() => true, () => false)
const call = async <T>(host: Host, method: string, params: unknown = {}): Promise<T> => await host.call(method as never, params as never) as T
interface Candidate { path: string; clean: boolean; changes: { ignoredCount: number }; bytes: number }
interface Preview { candidates: Candidate[]; inventoryToken: string; cleanBytes: number }
interface Result { removed: number; kept: number; freedBytes: number; refused: { path: string; reason: string }[] }
const days = 24 * 60 * 60 * 1000
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hd-storage-')))
  const repo = join(root, 'repo'), home = join(root, 'home')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  await writeFile(join(repo, 'tracked.txt'), 'original\n')
  await writeFile(join(repo, '.gitignore'), '.env\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Synthetic initial commit')
  const host = new Host({ state: new StateStore(join(home, 'state.json')), builtinAgents: join(home, 'agents'),
    libraryHome: join(home, 'library'), logger: new Logger('test', { level: 'error', console: false }) })
  const runtime = new FakeRuntime(); host.register(runtime); await host.start()
  const db = new DatabaseSync(join(home, 'sessions.sqlite'))
  t.after(async () => { db.close(); await host.dispose(); await rm(root, { recursive: true, force: true }) })
  const worktrees = new Worktrees(home)
  const create = async (name: string, age = 100) => {
    const tree = await worktrees.create(repo, { name })
    const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: tree.path } })
    await host.call('session/close', { runtime: runtime.info.id, sessionId: session.id })
    await call(host, 'storage/kept')
    db.prepare('UPDATE sessions SET title=?,updated_at=? WHERE runtime=? AND id=?').run(name, Date.now() - age * days, runtime.info.id, session.id)
    return { tree, session, pointer: { runtime: runtime.info.id, sessionId: session.id } }
  }
  const preview = (exclude: unknown[] = [], olderThanDays = 30) => call<Preview>(host, 'storage/cleanupPreview', { olderThanDays, exclude })
  const cleanup = (p: Preview, includeDirty = false, exclude: unknown[] = [], olderThanDays = 30) => call<Result>(host, 'storage/cleanup', { olderThanDays, exclude, includeDirty, inventoryToken: p.inventoryToken })
  return { repo, home, host, runtime, db, create, preview, cleanup }
}

test('Storage selects inactive normal, archived, removed and deleted owners; excludes live, pinned and young owners', async t => {
  const { create, preview, host, db, runtime } = await fixture(t)
  const normal = await create('Normal'), archived = await create('Archived'), removed = await create('Removed'), deleted = await create('Deleted')
  db.prepare('UPDATE sessions SET archived=1 WHERE id=?').run(archived.session.id)
  db.prepare('UPDATE sessions SET removed_at=? WHERE id=?').run(Date.now(), removed.session.id)
  db.prepare('DELETE FROM sessions WHERE id=?').run(deleted.session.id)
  await create('Young', 20)
  const pinned = await create('Pinned'), live = await create('Live')
  await host.call('session/resume', live.pointer)
  const p = await preview([pinned.pointer])
  assert.deepEqual(p.candidates.map(c => c.path).sort(), [normal, archived, removed, deleted].map(c => c.tree.path).sort())
  const shared = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: normal.tree.path } })
  assert.equal((await preview()).candidates.some(c => c.path === normal.tree.path), false)
  await host.call('session/close', { runtime: runtime.info.id, sessionId: shared.id })
  db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now(), shared.id)
  assert.equal((await preview()).candidates.some(c => c.path === normal.tree.path), false, 'young shared owner blocks cleanup')
})

test('clean cleanup keeps branches and conversations, records removal and recreates the checkout on reopen', async t => {
  const { create, preview, cleanup, host, db, repo } = await fixture(t)
  const { tree, pointer } = await create('Clean')
  const result = await cleanup(await preview())
  assert.equal(result.removed, 1); assert.ok(result.freedBytes > 0)
  assert.equal(await exists(tree.path), false)
  assert.equal(git(repo, 'rev-parse', tree.branch!), tree.head)
  assert.equal(db.prepare('SELECT worktree_state FROM sessions WHERE id=?').get(pointer.sessionId)?.worktree_state, 'removed')
  await host.call('session/resume', pointer)
  assert.equal(await exists(tree.path), true)
  assert.equal(git(tree.path, 'branch', '--show-current'), tree.branch)
})

test('a settled room Seat with no live handle stays through renderer exclusions at preview and confirmation', async t => {
  const { create, preview, cleanup, host } = await fixture(t)
  const shown = await create('Shown Seat'), other = await create('Inactive task')
  const record = host.registry.get(shown.pointer.runtime, shown.pointer.sessionId)
  assert.ok(record, 'the host retains the settled conversation')
  assert.equal(record.live, null)
  assert.equal((await preview()).candidates.some(row => row.path === shown.tree.path), true, 'a released handle alone cannot protect a displayed transcript')
  assert.deepEqual((await preview([shown.pointer])).candidates.map(row => row.path), [other.tree.path])
  const beforeOpening = await preview()
  const result = await cleanup(beforeOpening, false, [shown.pointer])
  assert.equal(result.removed, 1)
  assert.equal(await exists(shown.tree.path), true, 'a tile opened during review is kept')
  assert.equal(await exists(other.tree.path), false)
})

test('ignored content needs confirmation and an unchanged inventory; clean trees becoming dirty stay', async t => {
  const { create, preview, cleanup } = await fixture(t)
  const dirty = await create('Ignored'), clean = await create('Clean')
  await writeFile(join(dirty.tree.path, '.env'), 'synthetic value')
  const p = await preview()
  assert.equal(p.candidates.find(c => c.path === dirty.tree.path)?.clean, false)
  assert.equal(p.candidates.find(c => c.path === dirty.tree.path)?.changes.ignoredCount, 1)
  await writeFile(join(clean.tree.path, 'new.txt'), 'new work')
  const first = await cleanup(p)
  assert.equal(first.removed, 0); assert.equal(first.kept, 2)
  assert.equal(await exists(dirty.tree.path), true)
  const shown = await preview()
  await writeFile(join(dirty.tree.path, 'another.txt'), 'new inventory')
  const changed = await cleanup(shown, true)
  assert.equal(changed.removed, 1)
  assert.match(changed.refused.find(r => r.path === dirty.tree.path)?.reason ?? '', /changed since you looked/)
  const confirmed = await cleanup(await preview(), true)
  assert.equal(confirmed.removed, 1)
})

test('reopened candidates are skipped and one removal failure leaves other worktrees removable', async t => {
  const { create, preview, cleanup, host } = await fixture(t)
  const locked = await create('Locked'), clean = await create('Other'), reopened = await create('Reopened')
  const p = await preview()
  git(locked.tree.path, 'worktree', 'lock', locked.tree.path)
  await host.call('session/resume', reopened.pointer)
  const result = await cleanup(p)
  assert.equal(result.removed, 1); assert.equal(result.refused.length, 1)
  assert.equal(result.refused[0]?.path, locked.tree.path)
  assert.equal(await exists(locked.tree.path), true)
  assert.equal(await exists(reopened.tree.path), true)
  assert.equal(await exists(clean.tree.path), false)
})

test('storage usage returns computing immediately then emits measured database, snapshot, cache and checkout sizes', async t => {
  const { create, host, home, db } = await fixture(t)
  await create('Sized')
  await writeFile(join(home, 'sessions-2026-10-08.sqlite'), 'snapshot')
  db.prepare("INSERT INTO sessions(runtime,id,origin,cwd,created_at,updated_at,body,body_bytes) VALUES('alpha','cached','imported','',0,0,'cached',123)").run()
  const event = new Promise<{ worktrees: { computing: boolean; bytes: number; count: number }; database: { bytes: number }; snapshots: { bytes: number; count: number }; cachedPreviews: { count: number; bytes: number } }>(resolve => {
    const off = host.addBroadcaster(n => { if ((n as { method: string }).method === 'storage/usageChanged') { off(); resolve((n as unknown as { params: Awaited<typeof event> }).params) } })
  })
  const initial = await call<{ worktrees: { computing: boolean } }>(host, 'storage/usage')
  assert.equal(initial.worktrees.computing, true)
  const measured = await event
  assert.equal(measured.worktrees.computing, false); assert.equal(measured.worktrees.count, 1); assert.ok(measured.worktrees.bytes > 0)
  assert.ok(measured.database.bytes > 0); assert.ok(measured.snapshots.count >= 1); assert.ok(measured.snapshots.bytes >= 8)
  assert.deepEqual(measured.cachedPreviews, { count: 1, bytes: 123 })
})

test('age choices use 30, 60 and 90 days, candidates are ordered by path and a shared checkout is counted once', async t => {
  const { create, preview, host, runtime, db } = await fixture(t)
  const a = await create('Forty', 40), b = await create('Seventy', 70), c = await create('Hundred', 100)
  assert.deepEqual((await preview([], 30)).candidates.map(row => row.path), [a.tree.path, c.tree.path, b.tree.path])
  assert.deepEqual((await preview([], 60)).candidates.map(row => row.path), [c.tree.path, b.tree.path])
  assert.deepEqual((await preview([], 90)).candidates.map(row => row.path), [c.tree.path])
  const shared = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: a.tree.path } })
  await host.call('session/close', { runtime: runtime.info.id, sessionId: shared.id })
  await call(host, 'storage/kept')
  db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now() - 100 * days, shared.id)
  assert.deepEqual((await preview()).candidates.map(row => row.path), [a.tree.path, c.tree.path, b.tree.path])
})

test('the removal spy sees force only after Discard or confirmed dirty cleanup; unmanaged paths are refused', async t => {
  const { create, home, db, repo } = await fixture(t)
  const { SessionIndex } = await import('../src/session-index.js')
  const { SessionWorktrees } = await import('../src/session-worktrees.js')
  const { remove } = await import('../src/worktree.js')
  const index = new SessionIndex(join(home, 'sessions.sqlite')); t.after(() => index.close())
  const calls: Parameters<typeof remove>[1][] = []
  const manager = new SessionWorktrees(index, home, () => false, () => false, (path, options) => { calls.push(options); return remove(path, options) })
  const clean = await create('Automatic')
  db.prepare('UPDATE sessions SET archived=1 WHERE id=?').run(clean.session.id)
  await manager.cleanup(clean.pointer.runtime, clean.pointer.sessionId)
  assert.equal(calls.at(-1)?.force, undefined)
  const discard = await create('Discard')
  await writeFile(join(discard.tree.path, '.env'), 'synthetic value')
  db.prepare('UPDATE sessions SET archived=1 WHERE id=?').run(discard.session.id)
  await manager.cleanup(discard.pointer.runtime, discard.pointer.sessionId)
  assert.equal(calls.at(-1)?.force, undefined)
  const approval = await manager.preview(discard.pointer.runtime, discard.pointer.sessionId)
  await manager.discard(discard.pointer.runtime, discard.pointer.sessionId, approval.stamp)
  assert.equal(calls.at(-1)?.force, true)
  assert.ok(calls.at(-1)?.expectedInventory)
  const dirty = await create('Dirty bulk')
  await writeFile(join(dirty.tree.path, '.env'), 'synthetic value')
  const params = { olderThanDays: 30 as const, exclude: [] }
  const shown = await manager.cleanupPreview(params)
  const before = calls.length
  await manager.cleanupInactive({ ...params, includeDirty: false, inventoryToken: shown.inventoryToken })
  assert.equal(calls.length, before)
  const confirmed = await manager.cleanupPreview(params)
  await manager.cleanupInactive({ ...params, includeDirty: true, inventoryToken: confirmed.inventoryToken })
  assert.equal(calls.at(-1)?.force, true)
  assert.ok(calls.at(-1)?.expectedInventory)
  const own = join(home, 'person-checkout')
  git(repo, 'worktree', 'add', '-b', 'person-branch', own)
  index.rememberWorktree({ runtime: dirty.pointer.runtime, id: dirty.pointer.sessionId, root: repo, path: own, branch: 'person-branch', state: 'present' })
  db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run(own, dirty.session.id)
  const unmanaged = await manager.cleanupPreview(params)
  const refused = await manager.cleanupInactive({ ...params, includeDirty: true, inventoryToken: unmanaged.inventoryToken })
  assert.match(refused.refused[0]?.reason ?? '', /not created by HarnessDesk/)
  assert.equal(await exists(own), true)
})

test('a shown non-clean checkout is not selected without discard even if it becomes clean', async t => {
  const { create, preview, cleanup } = await fixture(t)
  const { tree } = await create('Becomes clean')
  await writeFile(join(tree.path, '.env'), 'synthetic value')
  const shown = await preview()
  await rm(join(tree.path, '.env'))
  assert.equal((await cleanup(shown)).removed, 0)
  assert.equal(await exists(tree.path), true)
})

test('a live registry owner keeps a shared checkout even before its index row is recorded', async t => {
  const { create, preview, host, runtime, db } = await fixture(t)
  const owner = await create('Closed indexed owner')
  const live = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: owner.tree.path } })
  await call(host, 'storage/kept')
  // Model the boundary while registry admission has happened but indexing has not.
  db.prepare('DELETE FROM sessions WHERE id=?').run(live.id)
  db.prepare('DELETE FROM session_worktrees WHERE id=?').run(live.id)
  assert.equal((await preview()).candidates.some(row => row.path === owner.tree.path), false)
})

test('usage sums all database sidecars and snapshots, caches the walk and never follows a symlink', async t => {
  const { SessionIndex } = await import('../src/session-index.js')
  const { Storage } = await import('../src/storage.js')
  const { runtimeId, sessionId } = await import('@harnessdesk/protocol')
  const home = await realpath(await mkdtemp(join(tmpdir(), 'hd-storage-usage-')))
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  const runtime = runtimeId('alpha'), id = sessionId('synthetic')
  const path = join(home, 'worktrees', 'repo-container', 'task')
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'data.txt'), 'payload')
  const outside = join(home, 'outside.txt')
  await writeFile(outside, 'content outside the worktree must not be followed')
  await symlink(outside, join(path, 'link'))
  await writeFile(join(home, 'sessions-2026-10-08.sqlite'), 'snapshot')
  index.upsert({ runtime, id, title: 'Synthetic', cwd: path, createdAt: 1, updatedAt: 1, status: { type: 'notLoaded' } })
  index.rememberWorktree({ runtime, id, path, branch: 'synthetic', root: home, state: 'kept' })
  let deliver!: (usage: import('@harnessdesk/protocol').StorageUsage) => void, events = 0
  const reading = new Promise<import('@harnessdesk/protocol').StorageUsage>(resolve => { deliver = resolve })
  const storage = new Storage(index, home, usage => { events++; deliver(usage) })
  t.after(async () => { await storage.close(); index.close(); await rm(home, { recursive: true, force: true }) })
  assert.equal(storage.usage().database.computing, true)
  assert.equal(storage.usage().worktrees.computing, true)
  const result = await reading
  let databaseBytes = 0
  for (const suffix of ['', '-wal', '-shm']) databaseBytes += await lstat(join(home, `sessions.sqlite${suffix}`)).then(stat => stat.size, () => 0)
  assert.equal(result.database.bytes, databaseBytes)
  assert.deepEqual(result.snapshots, { count: 1, bytes: 8, computing: false })
  assert.deepEqual(result.worktrees, { count: 1, bytes: 7 + (await lstat(join(path, 'link'))).size, kept: 1, computing: false })
  await writeFile(join(path, 'new.txt'), 'new bytes')
  assert.equal(storage.usage().worktrees.bytes, result.worktrees.bytes)
  assert.equal(events, 1)
  const refreshed = new Promise<import('@harnessdesk/protocol').StorageUsage>(resolve => { deliver = resolve })
  await storage.refresh()
  assert.equal((await refreshed).worktrees.bytes, result.worktrees.bytes + 9)
})
