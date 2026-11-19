import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { add, inventory, inventoryOf, list, move, prune, remove, setLock } from '../src/git-worktree.js'
import { list as sessionList, repositoryOf, Worktrees, worktreeHome } from '../src/worktree.js'
import { captureShellProject, shellProjectUnchanged } from '../src/shell-project.js'

/**
 * The client's worktree verbs against real repositories.
 *
 * The properties held are this module's own promises: the listing tells the
 * whole truth about each checkout (which is main, which one we are reading
 * from, what it is holding, whether it is locked or already lost), a new
 * worktree lands beside the repository and nowhere else, the main checkout is
 * never removed, uncommitted work is never taken without being named first,
 * and the branch survives the worktree that held it.
 */

const run = promisify(execFile)
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@x',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@x',
}
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, ...args], { env })).stdout

const scratch: string[] = []
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

const tempDir = async (prefix = 'hd-git-worktree-'): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/**
 * A one-commit repository inside a parent of its own, because "beside the
 * repository" is the rule under test: the parent is the whole allowed world.
 */
const seedRepo = async (name = 'repo'): Promise<{ repo: string; beside: string; state: string }> => {
  // Canonical: git reports real paths, and on macOS the temp dir is reached
  // through a symlink — so an expectation built on the raw path would fail
  // over /var vs /private/var rather than over anything this module does.
  const beside = await realpath(await tempDir())
  const repo = join(beside, name)
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'root')
  return { repo, beside, state: await tempDir('hd-state-') }
}

const at = <T extends { path: string }>(worktrees: readonly T[], path: string): T | undefined =>
  worktrees.find((entry) => entry.path.endsWith(path))

/** What the interface does before it offers a removal: look, then confirm. */
const confirmed = async (path: string): Promise<string> => (await inventory(path)).stateId

const gone = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return false
  } catch {
    return true
  }
}

test('a confirmation is void after the index changes with the same working contents', async (t) => {
  for (const change of ['contents', 'mode']) {
    await t.test(change, async () => {
      const { repo, state } = await seedRepo()
      const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
      const file = join(made.path, 'a.txt')
      await git(made.path, 'config', 'core.filemode', 'true')
      await writeFile(file, 'staged notes\n')
      await git(made.path, 'add', 'a.txt')
      await writeFile(file, 'working notes\n')
      const status = await git(made.path, 'status', '--porcelain=v1', '-z')
      assert.equal(status, 'MM a.txt\0')
      const held = await inventory(made.path)
      const before = await git(made.path, 'ls-files', '--stage', '-z')

      if (change === 'contents') {
        await writeFile(file, 'different staged notes\n')
        await git(made.path, 'add', 'a.txt')
        await writeFile(file, 'working notes\n')
      } else {
        await git(made.path, 'update-index', '--chmod=+x', 'a.txt')
      }
      const staged = await git(made.path, 'ls-files', '--stage', '-z')
      assert.notEqual(staged, before)
      assert.equal(await git(made.path, 'status', '--porcelain=v1', '-z'), status)
      assert.equal(await readFile(file, 'utf8'), 'working notes\n')

      await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
      assert.equal(await git(made.path, 'ls-files', '--stage', '-z'), staged)
      assert.equal(await readFile(file, 'utf8'), 'working notes\n')
      await remove(repo, made.path, true, await confirmed(made.path), state)
      assert.ok(await gone(made.path))
    })
  }
})

test('a confirmation includes every unmerged index stage', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  const base = (await git(made.path, 'rev-parse', 'HEAD:a.txt')).trim()
  const blobs: string[] = []
  for (const content of ['left\n', 'right\n', 'later\n']) {
    await writeFile(join(made.path, 'a.txt'), content)
    blobs.push((await git(made.path, 'hash-object', '-w', 'a.txt')).trim())
  }
  await writeFile(join(made.path, 'a.txt'), 'working notes\n')
  const update = async (input: string): Promise<void> => {
    const child = run('git', ['-C', made.path, 'update-index', '--index-info'], { env })
    child.child.stdin?.end(input)
    await child
  }
  await update(`0 ${'0'.repeat(base.length)}\ta.txt\n100644 ${base} 1\ta.txt\n100644 ${blobs[0]} 2\ta.txt\n100644 ${blobs[1]} 3\ta.txt\n`)
  const status = await git(made.path, 'status', '--porcelain=v1', '-z')
  assert.equal(status, 'UU a.txt\0')
  const held = await inventory(made.path)
  await update(`100644 ${blobs[2]} 3\ta.txt\n`)
  assert.equal(await git(made.path, 'status', '--porcelain=v1', '-z'), status)

  await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
  assert.equal(await readFile(join(made.path, 'a.txt'), 'utf8'), 'working notes\n')
  await remove(repo, made.path, true, await confirmed(made.path), state)
  assert.ok(await gone(made.path))
})

test('a confirmation covers descendants of an untracked nested repository', async (t) => {
  for (const change of ['edit', 'add']) {
    await t.test(change, async () => {
      const { repo, state } = await seedRepo()
      const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
      const nested = join(made.path, 'nested')
      await mkdir(join(nested, 'src'), { recursive: true })
      await git(nested, 'init', '-q', '-b', 'main')
      await writeFile(join(nested, 'src', 'a.ts'), 'seen\n')
      await git(nested, 'add', '.')
      await git(nested, 'commit', '-qm', 'keep the nested file')
      const outside = join(await tempDir('hd-inventory-outside-'), 'one.bin')
      await writeFile(outside, 'outside notes\n')
      await symlink(dirname(outside), join(nested, 'src', 'linked'), 'dir')
      const held = await inventory(made.path)
      assert.deepEqual(held.changes, [{ path: 'nested/', status: '??' }])
      await writeFile(outside, 'different outside notes\n')
      assert.equal(await confirmed(made.path), held.stateId)
      const file = join(nested, 'src', change === 'edit' ? 'a.ts' : 'later.ts')
      await writeFile(file, 'edit\n')

      await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
      assert.equal(await readFile(file, 'utf8'), 'edit\n')
      await remove(repo, made.path, true, await confirmed(made.path), state)
      assert.ok(await gone(made.path))
      assert.equal(await readFile(outside, 'utf8'), 'different outside notes\n')
    })
  }
})

test('the inventory names what is there and counts what it could not show', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'lots', { kind: 'new', branch: 'lots' }, state)
  await writeFile(join(made.path, '.gitignore'), 'junk/\n')
  await mkdir(join(made.path, 'junk'))
  for (let index = 0; index < 5; index += 1) {
    await writeFile(join(made.path, 'junk', `f${index}.txt`), 'x\n')
  }
  const held = await inventory(made.path)
  // The ignored directory collapses to one line rather than five: the point
  // is what a person can read, and `node_modules/` is not a list.
  assert.deepEqual(held.ignored, ['junk/'])
  assert.ok(held.changes.some((change) => change.path === '.gitignore'))
})

test('a confirmed inventory can remove a checkout with a tracked directory replaced by a file', async () => {
  const { repo, state } = await seedRepo()
  await mkdir(join(repo, 'drafts'))
  await writeFile(join(repo, 'drafts', 'one.txt'), 'original\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'add the draft')
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  await rm(join(made.path, 'drafts'), { recursive: true })
  await writeFile(join(made.path, 'drafts'), 'replacement\n')

  await remove(repo, made.path, true, await confirmed(made.path), state)
  assert.ok(await gone(made.path))
})

test('a confirmation tracks a dangling symbolic link without reading its destination', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  const link = join(made.path, 'draft.txt')
  await symlink('missing-one.txt', link)
  const held = await inventory(made.path)
  assert.equal(held.stateId, await confirmed(made.path))
  await rm(link)
  await symlink('missing-two.txt', link)

  await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
  await remove(repo, made.path, true, await confirmed(made.path), state)
  assert.ok(await gone(made.path))
})

test('a replaced directory keeps outside contents out of the inventory', async (t) => {
  for (const replaced of ['drafts', 'drafts/nested']) {
    await t.test(replaced, async () => {
      const { repo, state } = await seedRepo()
      await mkdir(join(repo, 'drafts', 'nested'), { recursive: true })
      await writeFile(join(repo, 'drafts', 'nested', 'one.txt'), 'original\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-qm', 'add the draft')
      const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
      const outside = await tempDir('hd-inventory-outside-')
      const directory = replaced === 'drafts' ? join(outside, 'nested') : outside
      await mkdir(directory, { recursive: true })
      const file = join(directory, 'one.txt')
      await writeFile(file, 'outside notes\n')
      await rm(join(made.path, replaced), { recursive: true })
      await symlink(outside, join(made.path, replaced), 'dir')
      const held = await inventory(made.path)
      assert.ok(held.changes.some((entry) => entry.path === replaced))

      await writeFile(file, 'different outside notes\n')
      assert.equal(await confirmed(made.path), held.stateId)
      await remove(repo, made.path, true, held.stateId, state)
      assert.ok(await gone(made.path))
      assert.equal(await readFile(file, 'utf8'), 'different outside notes\n')
    })
  }
})

test('a replaced directory can be removed while its outside destination is unreadable', async () => {
  const { repo, state } = await seedRepo()
  await mkdir(join(repo, 'drafts'))
  await writeFile(join(repo, 'drafts', 'one.txt'), 'original\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'add the draft')
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  const outside = await tempDir('hd-inventory-outside-')
  const file = join(outside, 'one.txt')
  await writeFile(file, 'outside notes\n')
  await rm(join(made.path, 'drafts'), { recursive: true })
  await symlink(outside, join(made.path, 'drafts'), 'dir')
  await chmod(file, 0o000)
  try {
    await remove(repo, made.path, true, await confirmed(made.path), state)
    assert.ok(await gone(made.path))
    assert.equal((await stat(file)).mode & 0o777, 0)
  } finally {
    await chmod(file, 0o644)
  }
  assert.equal(await readFile(file, 'utf8'), 'outside notes\n')
})

// ------------------------------------------------- writers and the deadline

/**
 * A dev server or a watcher writes into folders git ignores while a person
 * decides to remove the lane. What is ignored is made again by whatever made
 * it, so a confirmation holds it to its names, types, sizes and modes. What git
 * reports as changed, tracked or not, is the person's own work and stays held
 * to its contents and its times.
 */
const withCache = async (name: string) => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, name, { kind: 'new', branch: name }, state)
  await writeFile(join(made.path, '.gitignore'), 'cache/\n')
  const folder = join(made.path, 'cache', 'deep')
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'one.bin')
  await writeFile(file, 'seen\n')
  return { repo, state, made, folder, file }
}

/** Waits for something another process does, and says what it waited for when it does not happen. */
const eventually = async (settled: () => boolean, what: string, within = 10_000): Promise<void> => {
  const started = performance.now()
  while (!settled()) {
    assert.ok(performance.now() - started < within, what)
    await delay(25)
  }
}

test('a writer touching an ignored folder between looking and removing does not void the confirmation', async () => {
  const { repo, state, made, folder, file } = await withCache('dev-server')
  const held = await inventory(made.path)
  assert.deepEqual(held.ignored, ['cache/'])

  // The writer carries on: the same bytes again, the times moved on, a scratch
  // file made and taken away, and a file replaced by a copy of itself the way a
  // cache writes it. No name appeared and no size changed.
  const later = new Date(Date.now() + 60_000)
  await writeFile(file, 'seen\n')
  await utimes(file, later, later)
  await writeFile(join(folder, 'scratch.tmp'), 'x')
  await rm(join(folder, 'scratch.tmp'))
  await writeFile(join(folder, 'one.tmp'), 'seen\n')
  await rename(join(folder, 'one.tmp'), file)
  await utimes(folder, later, later)

  assert.equal((await inventory(made.path)).stateId, held.stateId)
  await remove(repo, made.path, true, held.stateId, state)
  assert.ok(await gone(made.path))
})

test('a confirmation is void after an ignored file changes mode', async () => {
  const { repo, state, made, file } = await withCache('holding-mode')
  const held = await inventory(made.path)
  await chmod(file, (await stat(file)).mode ^ 0o100)

  await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
  assert.ok(!(await gone(made.path)))
  await remove(repo, made.path, true, await confirmed(made.path), state)
  assert.ok(await gone(made.path))
})

test('a confirmation is void after an ignored file changes size, or appears, or goes', async (t) => {
  for (const change of ['grows', 'appears', 'goes']) {
    await t.test(change, async () => {
      const { repo, state, made, folder, file } = await withCache('holding')
      const held = await inventory(made.path)
      if (change === 'grows') await writeFile(file, 'seen and then some\n')
      else if (change === 'appears') await writeFile(join(folder, 'two.bin'), 'seen\n')
      else await rm(file)

      await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
      assert.ok(!(await gone(made.path)))
      await remove(repo, made.path, true, await confirmed(made.path), state)
      assert.ok(await gone(made.path))
    })
  }
})

test('an untracked file that is not ignored is still held to its contents and its times', async (t) => {
  for (const change of ['rewritten', 'touched']) {
    await t.test(change, async () => {
      const { repo, state, made } = await withCache('holding')
      const file = join(made.path, 'loose.txt')
      await writeFile(file, 'seen\n')
      const held = await inventory(made.path)
      const before = await stat(file)
      if (change === 'rewritten') {
        await writeFile(file, 'edit\n')
        await utimes(file, before.atime, before.mtime)
      } else {
        await utimes(file, before.atime, new Date(before.mtimeMs + 60_000))
      }

      await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
      assert.ok(!(await gone(made.path)))
      assert.equal(await readFile(file, 'utf8'), change === 'rewritten' ? 'edit\n' : 'seen\n')
    })
  }
})

/** What a cache writer does to a folder while it is read: a scratch file made and removed, the folder's times moved. */
const writerAt = (folder: string) => {
  let rounds = 0
  return {
    rounds: () => rounds,
    work: async (): Promise<void> => {
      const scratch = join(folder, `scratch-${rounds++}.tmp`)
      await writeFile(scratch, 'x')
      await rm(scratch)
      const later = new Date(Date.now() + 60_000 * rounds)
      await utimes(folder, later, later)
    },
  }
}

test('an inventory read while a writer works in an ignored folder does not fail', async (t) => {
  const { made, folder, file } = await withCache('dev-server')
  const writer = writerAt(folder)
  const lstat = fsPromises.lstat
  t.mock.method(fsPromises, 'lstat', (async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]) === file) await writer.work()
    return lstat(...args)
  }) as typeof lstat)
  syncBuiltinESMExports()
  try {
    assert.deepEqual((await inventory(made.path)).ignored, ['cache/'])
    assert.ok(writer.rounds() > 0, 'the writer ran while the folder was being read')
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('an inventory read while a writer works in an untracked folder still refuses', async (t) => {
  const { made } = await withCache('holding')
  const folder = join(made.path, 'loose')
  await mkdir(folder)
  const file = join(folder, 'one.bin')
  await writeFile(file, 'seen\n')
  const writer = writerAt(folder)
  const lstat = fsPromises.lstat
  t.mock.method(fsPromises, 'lstat', (async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]) === file) await writer.work()
    return lstat(...args)
  }) as typeof lstat)
  syncBuiltinESMExports()
  try {
    await assert.rejects(inventory(made.path), /changed while reading its inventory/)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('an ignored file that goes while the walk is reading it is held to nothing', async (t) => {
  const { made, folder } = await withCache('dev-server')
  const scratch = join(folder, 'scratch.tmp')
  await writeFile(scratch, 'x')
  const lstat = fsPromises.lstat
  t.mock.method(fsPromises, 'lstat', (async (...args: Parameters<typeof lstat>) => {
    // The writer renames or removes its scratch file after git listed it and before it is read.
    if (String(args[0]) === scratch) await rm(scratch)
    return lstat(...args)
  }) as typeof lstat)
  syncBuiltinESMExports()
  let during: string
  try {
    during = (await inventory(made.path)).stateId
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  // The same digest as a reading made once it is gone, which does not list it at all.
  assert.equal((await inventory(made.path)).stateId, during)
})

test('an ignored nested repository that goes while the walk reads it does not fail the inventory', async (t) => {
  const { made } = await withCache('dev-server')
  await writeFile(join(made.path, '.gitignore'), 'cache/\nvendor/\n')
  const nested = join(made.path, 'vendor', 'lib')
  await mkdir(nested, { recursive: true })
  await writeFile(join(made.path, 'vendor', 'keep.txt'), 'kept\n')
  await git(nested, 'init', '-q', '-b', 'main')
  await writeFile(join(nested, 'a.txt'), 'notes\n')
  const readdir = fsPromises.readdir
  t.mock.method(fsPromises, 'readdir', (async (...args: Parameters<typeof readdir>) => {
    if (String(args[0]) === nested) await rm(nested, { recursive: true })
    return readdir(...args)
  }) as typeof readdir)
  syncBuiltinESMExports()
  let during: string
  try {
    during = (await inventory(made.path)).stateId
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal((await inventory(made.path)).stateId, during)
})

const DEADLINE = /Couldn't list what this worktree holds in time; nothing was removed/

test('a git listing that never ends is stopped at the deadline, its child is killed and nothing is removed', { timeout: 30_000 }, async (t) => {
  const { repo, state, made, file } = await withCache('holding')
  await writeFile(join(made.path, 'notes.txt'), 'untracked\n')
  const held = await inventory(made.path)

  const spawn = childProcess.spawn
  const endless: ReturnType<typeof spawn>[] = []
  t.mock.method(childProcess, 'spawn', ((command, args, options) => {
    if (!args?.includes('--others')) return spawn(command, args!, options!)
    // Stands in for a git waiting on a mount that stopped answering: silent, and it does not exit.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], options!)
    endless.push(child)
    return child
  }) as typeof spawn)
  syncBuiltinESMExports()
  try {
    const started = performance.now()
    await assert.rejects(remove(repo, made.path, true, held.stateId, state, { deadlineMs: 2_000 }), DEADLINE)
    assert.ok(performance.now() - started < 20_000, 'refused at the deadline, not when the listing came back')
    assert.equal(endless.length, 1, 'the listing was started')
    await eventually(() => endless[0]!.exitCode !== null || endless[0]!.signalCode !== null, 'the listing child was killed')
  } finally {
    for (const child of endless) child.kill('SIGKILL')
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  // Nothing it did not list was taken.
  assert.ok(!(await gone(made.path)))
  assert.equal(await readFile(join(made.path, 'notes.txt'), 'utf8'), 'untracked\n')
  assert.equal(await readFile(file, 'utf8'), 'seen\n')
  assert.equal((await list(repo, state)).length, 2)
})

test('an inventory held up by a call on the disk is refused at the deadline, and the git child still writing is killed', { timeout: 30_000 }, async (t) => {
  const { repo, state, made } = await withCache('holding')
  // A listing far longer than a pipe holds, so git is still writing when the reader stops.
  const crowded = join(made.path, 'cache', 'a'.repeat(200), 'b'.repeat(200))
  await mkdir(crowded, { recursive: true })
  const seed = join(crowded, 'seed')
  await writeFile(seed, '')
  await Promise.all(Array.from({ length: 600 }, (_, index) => link(seed, join(crowded, `${index}-${'x'.repeat(180)}`))))

  const spawn = childProcess.spawn
  let listing: ReturnType<typeof spawn> | undefined
  t.mock.method(childProcess, 'spawn', ((command, args, options) => {
    const child = spawn(command, args!, options!)
    if (args?.includes('ls-files') && args.includes('--others')) listing = child
    return child
  }) as typeof spawn)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let reached!: () => void
  const blocked = new Promise<void>((resolve) => { reached = resolve })
  const lstat = fsPromises.lstat
  t.mock.method(fsPromises, 'lstat', (async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]) === join(made.path, 'cache')) {
      reached()
      await held
    }
    return lstat(...args)
  }) as typeof lstat)
  syncBuiltinESMExports()
  try {
    const reading = inventory(made.path, { deadlineMs: 3_000 })
    const outcome = reading.then(() => 'answered', (error: unknown) => error)
    await blocked
    assert.ok(listing, 'the listing was started')
    assert.equal(listing.exitCode, null, 'git is still writing when the reader stops')
    // The call on the disk is still out, and the inventory is refused all the same.
    assert.match(String(await outcome), DEADLINE)
    await eventually(() => listing!.exitCode !== null || listing!.signalCode !== null, 'the listing child was killed')
    release()
    await delay(200)
  } finally {
    release()
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  await remove(repo, made.path, true, await confirmed(made.path), state)
  assert.ok(await gone(made.path))
})

for (const stalledStatus of ['--untracked-files=all', '--ignored']) {
  test(`a ${stalledStatus} status read that ignores SIGTERM is stopped at the deadline and its child is killed`, { timeout: 30_000, skip: process.platform === 'win32' }, async () => {
    const { made } = await withCache('holding')
    // A quiet status process keeps running on SIGTERM, as a deadline must allow for.
    const bin = await tempDir('hd-git-shim-')
    const pidFile = join(bin, 'stuck.pid')
    const real = (await run('sh', ['-c', 'command -v git'])).stdout.trim()
    await writeFile(join(bin, 'git'), [
      '#!/bin/sh',
      'for arg in "$@"; do',
      `  if [ "$arg" = "${stalledStatus}" ]; then trap '' TERM; echo $$ > '${pidFile}'; exec sleep 60; fi`,
      'done',
      `exec '${real}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path ?? ''}`
    let pid = 0
    try {
      await assert.rejects(inventory(made.path, { deadlineMs: 4_000 }), DEADLINE)
      pid = Number(await readFile(pidFile, 'utf8'))
      assert.ok(pid > 0, 'the status read was started')
      await eventually(() => {
        try { process.kill(pid, 0); return false } catch { return true }
      }, 'the status read child was killed')
    } finally {
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
      if (pid > 0) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    assert.ok(!(await gone(made.path)))
  })
}

// ------------------------------------------------------------------- prune

test('prune names what it dropped, and says plainly when there is nothing to drop', async () => {
  const { repo, state } = await seedRepo()
  assert.match((await prune(repo)).summary, /Nothing to prune/)

  const made = await add(repo, 'lost', { kind: 'new', branch: 'lost' }, state)
  await rm(made.path, { recursive: true, force: true })
  assert.equal((await list(repo, state)).length, 2)

  const pruned = await prune(repo)
  assert.deepEqual(pruned.removed, ['lost'])
  assert.match(pruned.summary, /Pruned 1 stale worktree record: lost\./)
  assert.equal((await list(repo, state)).length, 1)
})

// -------------------------------------------------------------- lock, move

test('locking pins a worktree with its reason; the main checkout has nothing to pin', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'pinned', { kind: 'new', branch: 'pinned' }, state)

  await setLock(repo, made.path, true, '  on a USB stick  ', state)
  assert.equal(at(await list(repo, state), '/pinned')?.locked?.reason, 'on a USB stick')

  await setLock(repo, made.path, false, undefined, state)
  assert.equal(at(await list(repo, state), '/pinned')?.locked, null)

  await assert.rejects(() => setLock(repo, repo, true, 'why not', state), /main checkout is never pruned/)
})

test('move relocates the folder and git’s record of it together', async () => {
  const { repo, beside, state } = await seedRepo()
  const made = await add(repo, 'before', { kind: 'new', branch: 'moving' }, state)
  await writeFile(join(made.path, 'kept.txt'), 'still here\n')

  const moved = await move(repo, made.path, 'after', state)
  assert.equal(moved.path, join(beside, 'after'))
  assert.ok(await gone(made.path))
  // git knows where it went, which is the whole reason this is a git verb.
  assert.equal(at(await list(repo, state), '/after')?.branch, 'moving')
  assert.equal((await git(moved.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'moving')
  assert.equal(dirname(moved.path), await git(repo, 'rev-parse', '--show-toplevel').then((top) => dirname(top.trim())))
})

test('move obeys the same "beside the repository" rule an added worktree does', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'here', { kind: 'new', branch: 'staying' }, state)

  const far = join(await tempDir(), 'far')
  await assert.rejects(
    () => move(repo, made.path, far, state),
    /New worktrees are made beside the repository/,
  )
  await assert.rejects(() => move(repo, repo, 'anywhere', state), /main checkout is not moved/)
  assert.equal(at(await list(repo, state), '/here')?.path, made.path)
})

/**
 * A worktree at a relative revision.
 *
 * `add` shares its revision gate with the git verbs, and that gate refused
 * `HEAD~1` — so "a worktree at the commit before this one" was refused as
 * "not a usable revision name". Pinned end to end here, through `add`,
 * because a unit test of the gate cannot say that this caller reaches it.
 * Raised in review.
 */
/* Two tests rather than one, because `at` and `base` reach the gate by
   separate calls (`git-worktree.ts` resolves each on its own) and a failed
   assertion ends a test: written as one, only the first half could ever be
   shown to fail on the old gate, and the second was taken on trust. */
const twoCommits = async () => {
  const seeded = await seedRepo()
  const first = (await git(seeded.repo, 'rev-parse', 'HEAD')).trim()
  await writeFile(join(seeded.repo, 'a.txt'), 'two\n')
  await git(seeded.repo, 'commit', '-qam', 'second')
  return { ...seeded, first }
}

test('add detaches at a relative revision', async () => {
  const { repo, state, first } = await twoCommits()
  const loose = await add(repo, 'one-back', { kind: 'detach', at: 'HEAD~1' }, state)
  assert.equal((await git(loose.path, 'rev-parse', 'HEAD')).trim(), first)
})

test('add starts a new branch from a relative revision', async () => {
  const { repo, state, first } = await twoCommits()
  const made = await add(repo, 'from-parent', { kind: 'new', branch: 'from-parent', base: 'HEAD^' }, state)
  assert.equal((await git(made.path, 'rev-parse', 'HEAD')).trim(), first)
})


test('worktree destination confinement refuses a POSIX slash/backslash collision', { skip: process.platform === 'win32' }, async () => {
  const { repo, beside, state } = await seedRepo()
  const admitted = join(beside, 'a', 'b')
  const nestedRepo = join(admitted, 'repo')
  await mkdir(nestedRepo, { recursive: true })
  await git(nestedRepo, 'init', '-q', '-b', 'main')
  await git(nestedRepo, 'commit', '--allow-empty', '-qm', 'root')
  const foreign = join(beside, 'a\\b', 'side')
  await assert.rejects(() => add(nestedRepo, foreign, { kind: 'detach', at: 'HEAD' }, state), /New worktrees are made beside the repository/)
})
