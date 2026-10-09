import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile, access, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { Logger } from '../src/log.js'
import { Worktrees } from '../src/worktree.js'
import { SessionWorktrees } from '../src/session-worktrees.js'
import { SessionIndex } from '../src/session-index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Jane Doe', GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'Jane Doe', GIT_COMMITTER_EMAIL: 'dev@example.com' },
}).trim()
const exists = async (path: string) => access(path).then(() => true, () => false)
async function fixture(t: { after(fn: () => Promise<void>): void }, detached = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hd-session-trees-')))
  const repo = join(root, 'repo'), home = join(root, 'home')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  await writeFile(join(repo, 'tracked.txt'), 'original\n')
  await writeFile(join(repo, '.gitignore'), '.env\nignored/\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Synthetic initial commit')
  const host = new Host({ state: new StateStore(join(home, 'state.json')), builtinAgents: join(home, 'agents'),
    libraryHome: join(home, 'library'), logger: new Logger('test', { level: 'error', console: false }) })
  const runtime = new FakeRuntime()
  host.register(runtime)
  t.after(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }) })
  await host.start()
  const worktrees = new Worktrees(home)
  const tree = await worktrees.create(repo, { name: 'Synthetic task' })
  if (detached) await detachCommit(tree.path)
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: tree.path } })
  const pointer = { runtime: runtime.info.id, sessionId: session.id }
  return { root, repo, home, host, runtime, worktrees, tree, session, pointer }
}

async function detachCommit(path: string) {
  git(path, 'checkout', '--detach')
  await writeFile(join(path, 'tracked.txt'), 'synthetic detached commit\n')
  git(path, 'commit', '-am', 'Keep synthetic detached work')
}

test('Archive removes a clean managed worktree, retains its branch, and Unarchive puts it back', async t => {
  const { host, pointer, tree, repo } = await fixture(t)
  await host.call('session/archive', { ...pointer, archived: true })
  assert.equal(await exists(tree.path), false)
  assert.equal(git(repo, 'rev-parse', tree.branch!), tree.head)
  const row = (await host.call('session/index', { archived: 'only' })).data[0]!
  assert.equal((row as unknown as { worktree: { state: string } }).worktree.state, 'removed')
  await host.call('session/archive', { ...pointer, archived: false })
  assert.equal(await exists(tree.path), true)
  assert.equal(git(tree.path, 'branch', '--show-current'), tree.branch)
})

test('Archive keeps dirty and ignored content and marks the worktree kept', async t => {
  for (const file of ['tracked.txt', '.env', 'ignored/file.txt']) await t.test(file, async t => {
    const { host, pointer, tree } = await fixture(t)
    if (file.includes('/')) await mkdir(join(tree.path, 'ignored'))
    await writeFile(join(tree.path, file), 'keep this\n')
    await host.call('session/archive', { ...pointer, archived: true })
    assert.equal(await exists(join(tree.path, file)), true)
    const row = (await host.call('session/index', { archived: 'only' })).data[0]!
    assert.equal((row as unknown as { worktree: { state: string } }).worktree.state, 'kept')
  })
})

test('a shared worktree survives until the last conversation is archived', async t => {
  const { host, pointer, tree, runtime } = await fixture(t)
  const second = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: tree.path } })
  await host.call('session/archive', { ...pointer, archived: true })
  assert.equal(await exists(tree.path), true)
  await host.call('session/archive', { runtime: runtime.info.id, sessionId: second.id, archived: true })
  assert.equal(await exists(tree.path), false)
})

test('Remove waits for the body sweep, and Delete retains the worktree inventory', async t => {
  const { host, pointer, tree, home } = await fixture(t)
  await writeFile(join(tree.path, '.env'), 'synthetic ignored value')
  await host.call('session/remove', { ...pointer, removed: true })
  assert.equal(await exists(tree.path), true)
  await host.call('session/remove', { ...pointer, removed: false })
  await host.call('session/delete', pointer)
  assert.equal(await exists(tree.path), true)
  const db = new DatabaseSync(join(home, 'sessions.sqlite'))
  try { assert.equal(db.prepare('SELECT state FROM session_worktrees WHERE id=?').get(pointer.sessionId)?.state, 'kept') }
  finally { db.close() }
})

test('an unmanaged worktree is untouched and a Git removal failure still archives', async t => {
  const { host, runtime, pointer, tree, repo, root } = await fixture(t)
  git(tree.path, 'worktree', 'lock', tree.path)
  const outcome = await host.call('session/archive', { ...pointer, archived: true })
  assert.match(outcome?.warning ?? '', /worktree stayed/)
  assert.equal(await exists(tree.path), true)
  assert.equal((await host.call('session/index', { archived: 'only' })).data[0]?.archived, true)
  const own = join(root, 'person-checkout')
  git(repo, 'worktree', 'add', '-b', 'person-work', own)
  const conversation = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: own } })
  await host.call('session/archive', { runtime: runtime.info.id, sessionId: conversation.id, archived: true })
  assert.equal(await exists(own), true)
})

test('a failed inventory refresh does not refuse Archive, Remove or Delete', async t => {
  for (const method of ['session/archive', 'session/remove', 'session/delete'] as const) await t.test(method, async t => {
    const { host, pointer } = await fixture(t)
    t.mock.method(SessionWorktrees.prototype, 'remember', async () => { throw new Error('Synthetic inventory refusal') })
    if (method === 'session/archive') await host.call(method, { ...pointer, archived: true })
    else if (method === 'session/remove') await host.call(method, { ...pointer, removed: true })
    else await host.call(method, pointer)
    assert.equal((await host.call('session/index', {})).data.length, 0)
  })
})

test('a missing retained branch reopens in the main checkout with an explanation', async t => {
  const { host, pointer, tree, repo, runtime } = await fixture(t)
  await host.call('session/archive', { ...pointer, archived: true })
  git(repo, 'branch', '-m', tree.branch!, 'retained-under-another-name')
  const restored = await host.call('session/resume', pointer)
  assert.equal(restored.cwd, repo)
  assert.match(restored.worktreeWarning ?? '', /branch is gone.*main checkout/)
  assert.equal(runtime.lastResumeOptions?.cwd, repo)
  assert.equal(await exists(tree.path), false)
})

test('Discard is bound to the confirmed inventory, asks again on changes and preserves the branch', async t => {
  const { host, pointer, tree, repo } = await fixture(t)
  await writeFile(join(tree.path, '.env'), 'synthetic value')
  await host.call('session/archive', { ...pointer, archived: true })
  await assert.rejects(host.call('session/discardWorktree', { ...pointer, stamp: 'not-confirmed' }), /Review/)
  assert.equal(await exists(tree.path), true)
  const preview = await host.call('session/worktreePreview', pointer)
  assert.deepEqual(preview.changes.ignored, ['.env'])
  await writeFile(join(tree.path, 'new.txt'), 'new change')
  const changed = await host.call('session/discardWorktree', { ...pointer, stamp: preview.stamp })
  assert.equal(changed.discarded, false)
  assert.deepEqual(changed.preview?.changes.files, ['new.txt'])
  assert.equal(await exists(tree.path), true)
  const removed = await host.call('session/discardWorktree', { ...pointer, stamp: changed.preview!.stamp })
  assert.equal(removed.discarded, true)
  assert.equal(await exists(tree.path), false)
  assert.equal(git(repo, 'rev-parse', tree.branch!), tree.head)
})

test('Discard asks again for new files inside already listed untracked or ignored directories', async t => {
  for (const directory of ['untracked', 'ignored']) await t.test(directory, async t => {
    const { host, pointer, tree } = await fixture(t)
    await mkdir(join(tree.path, directory))
    await writeFile(join(tree.path, directory, 'first.txt'), 'first synthetic file')
    await host.call('session/archive', { ...pointer, archived: true })
    const preview = await host.call('session/worktreePreview', pointer)
    await writeFile(join(tree.path, directory, 'second.txt'), 'new synthetic file')
    const result = await host.call('session/discardWorktree', { ...pointer, stamp: preview.stamp })
    assert.equal(result.discarded, false)
    assert.ok(result.preview?.stamp)
    assert.notEqual(result.preview.stamp, preview.stamp)
    assert.equal(await exists(join(tree.path, directory, 'second.txt')), true)
    assert.equal((await host.call('session/discardWorktree', { ...pointer, stamp: result.preview.stamp })).discarded, true)
  })
})

test('automatic cleanup keeps a detached checkout and its unique HEAD', async t => {
  for (const method of ['session/archive', 'session/remove', 'session/delete'] as const) await t.test(method, async t => {
    const { host, pointer, tree, repo, home } = await fixture(t)
    git(tree.path, 'checkout', '--detach')
    await writeFile(join(tree.path, 'tracked.txt'), 'synthetic detached commit\n')
    git(tree.path, 'commit', '-am', 'Keep synthetic detached work')
    const head = git(tree.path, 'rev-parse', 'HEAD')
    assert.equal(git(repo, 'for-each-ref', '--contains', head), '')
    if (method === 'session/archive') await host.call(method, { ...pointer, archived: true })
    else if (method === 'session/delete') await host.call(method, pointer)
    else {
      await host.call(method, { ...pointer, removed: true })
      // Run the same cleanup entry the delayed body sweep uses, after expiry.
      const index = new SessionIndex(join(home, 'sessions.sqlite'))
      try { await new SessionWorktrees(index, home, () => false).cleanup(pointer.runtime, pointer.sessionId) }
      finally { index.close() }
    }
    assert.equal(await exists(tree.path), true)
    assert.equal(git(tree.path, 'rev-parse', 'HEAD'), head)
    const db = new DatabaseSync(join(home, 'sessions.sqlite'))
    try { assert.equal(db.prepare('SELECT state FROM session_worktrees WHERE id=?').get(pointer.sessionId)?.state, 'kept') }
    finally { db.close() }
  })
})

test('Discard refuses a detached checkout even when its recorded branch is stale', async t => {
  for (const detached of [true, false]) await t.test(detached ? 'admitted detached' : 'detached after admission', async t => {
    const { host, pointer, tree, repo } = await fixture(t, detached)
    if (!detached) await writeFile(join(tree.path, '.env'), 'synthetic ignored file')
    await host.call('session/archive', { ...pointer, archived: true })
    if (!detached) await detachCommit(tree.path)
    const head = git(tree.path, 'rev-parse', 'HEAD')
    assert.equal(git(repo, 'for-each-ref', '--contains', head), '')
    const row = (await host.call('session/index', { archived: 'only' })).data[0]!
    assert.equal(row.worktree?.branch, detached ? null : tree.branch)
    const preview = await host.call('session/worktreePreview', pointer)
    await assert.rejects(host.call('session/discardWorktree', { ...pointer, stamp: preview.stamp }), /detached worktree/)
    assert.equal(await exists(tree.path), true)
    assert.equal(git(tree.path, 'rev-parse', 'HEAD'), head)
    assert.equal(git(repo, 'for-each-ref', '--contains', head), '')
    assert.equal((await host.call('session/index', { archived: 'only' })).data[0]?.worktree?.state, 'kept')
    // Attaching HEAD to a branch makes Discard safe, with a fresh confirmation.
    git(tree.path, 'checkout', '-b', 'retained-detached-work')
    const attached = await host.call('session/worktreePreview', pointer)
    assert.equal((await host.call('session/discardWorktree', { ...pointer, stamp: attached.stamp })).discarded, true)
    assert.equal(await exists(tree.path), false)
    assert.equal(git(repo, 'rev-parse', 'retained-detached-work'), head)
  })
})

test('cleanup and Discard keep a checkout admitted while removal reads are pending', async t => {
  for (const discard of [false, true]) await t.test(discard ? 'Discard' : 'Archive', async t => {
    const { host, pointer, tree, runtime } = await fixture(t)
    let stamp = ''
    if (discard) {
      await writeFile(join(tree.path, '.env'), 'synthetic ignored file')
      await host.call('session/archive', { ...pointer, archived: true })
      stamp = (await host.call('session/worktreePreview', pointer)).stamp
    }
    const original = SessionIndex.prototype.worktreeInUse
    let admitted: ReturnType<typeof host.call<'session/create'>> | undefined
    // Start admission just after the first ownership check. Git's asynchronous
    // inventory reads let the new session attach before the removal executes.
    t.mock.method(SessionIndex.prototype, 'worktreeInUse', function (this: SessionIndex, path: string) {
      const result = original.call(this, path)
      if (!admitted) admitted = host.call('session/create', { runtime: runtime.info.id, options: { cwd: tree.path } })
      return result
    })
    if (discard) await assert.rejects(host.call('session/discardWorktree', { ...pointer, stamp }), /still uses/)
    else {
      const result = await host.call('session/archive', { ...pointer, archived: true })
      assert.match(result?.warning ?? '', /worktree stayed/i)
    }
    assert.ok(admitted)
    const second = await admitted
    assert.equal(second.cwd, tree.path)
    assert.equal(await exists(tree.path), true)
    if (discard) assert.equal(await exists(join(tree.path, '.env')), true)
    assert.equal((await host.call('session/index', { archived: 'only' })).data[0]?.worktree?.state, 'kept')
  })
})

test('launch sweeps an expired removal even without a stored body, preserving ignored content', async t => {
  for (const ignored of [false, true]) await t.test(String(ignored), async t => {
    const { host, pointer, tree, home, runtime } = await fixture(t)
    if (ignored) await writeFile(join(tree.path, '.env'), 'synthetic value')
    await host.call('session/remove', { ...pointer, removed: true })
    assert.equal(await exists(tree.path), true)
    await host.dispose()
    const db = new DatabaseSync(join(home, 'sessions.sqlite'))
    db.prepare('UPDATE sessions SET removed_at=? WHERE id=?').run(Date.now() - 60_000, pointer.sessionId)
    db.close()
    const reopened = new Host({ state: new StateStore(join(home, 'state.json')), builtinAgents: join(home, 'agents'),
      libraryHome: join(home, 'library'), logger: new Logger('test', { level: 'error', console: false }) })
    reopened.register(runtime)
    t.after(() => reopened.dispose())
    await reopened.start()
    assert.equal(await exists(tree.path), ignored)
    assert.deepEqual((await reopened.call('session/index', {})).data, [])
  })
})

test('Team wrap archives idle members and reports a working member that stayed', async t => {
  const { host, runtime, session, pointer, repo, tree } = await fixture(t)
  await host.call('workspace/open', { path: repo })
  const team = await host.call('goal/create', { root: repo, sentence: 'Finish the synthetic Team' })
  await host.teamPlane.joinRoom(team.goal.id, runtime.info.id, String(session.id))
  const working = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: tree.path } })
  await host.teamPlane.joinRoom(team.goal.id, runtime.info.id, String(working.id))
  await runtime.sessions.get(String(working.id))!.send([{ type: 'text', text: 'Synthetic work still in progress' }])
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.after(() => t.mock.timers.reset())
  await new Promise(resolve => setTimeout(resolve, 50))
  const choices = { summary: 'The idle work is complete.', cards: [] }
  let receipt: import('@harnessdesk/protocol').GoalReceipt | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    const preview = await host.call('goal/preview', { goal: team.goal.id, choices })
    try { receipt = await host.call('goal/wrap', { goal: team.goal.id, stamp: preview.stamp, choices }); break }
    catch (error) { if (!(error instanceof Error) || !/changed while you reviewed/.test(error.message)) throw error }
  }
  assert.ok(receipt, 'the wrap settles after pending projection writes')
  assert.deepEqual(receipt.conversations, { archived: 1, stayed: 1 })
  assert.equal(runtime.archived.has(String(pointer.sessionId)), true)
  assert.equal(runtime.archived.has(String(working.id)), false)
  assert.equal(await exists(tree.path), true)
})

test('a completed native reconciliation reads omitted ids without adopting unrelated history', async t => {
  const { host, runtime, session, pointer, home } = await fixture(t)
  runtime.archived.add(String(session.id))
  const db = new DatabaseSync(join(home, 'sessions.sqlite'))
  db.prepare('UPDATE sessions SET archived=NULL WHERE id=?').run(session.id)
  db.close()
  const nativeRead = runtime.readSession.bind(runtime)
  let reads = 0
  runtime.readSession = async id => { reads++; return { ...await nativeRead(id), archived: runtime.archived.has(String(id)) } }
  runtime.listSessions = async () => ({ data: [], nextCursor: null })
  // Re-register readiness to begin a fresh reconciliation pass.
  await host.call('session/list', { runtime: runtime.info.id, archived: 'only' })
  for (let i = 0; i < 50 && !(await host.call('session/index', { archived: 'only' })).data.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok((await host.call('session/index', { archived: 'only' })).data.some(row => row.id === pointer.sessionId))
  assert.ok(reads > 0)
})

test('automatic cleanup never requests force; only the confirmed Discard path does', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../src/session-worktrees.ts', import.meta.url), 'utf8')
  assert.equal((source.match(/force:\s*true/g) ?? []).length, 1)
  assert.ok(source.indexOf('force: true') > source.indexOf('discard(runtime:'))
  assert.ok(source.includes('keepIgnored: true'))
})
