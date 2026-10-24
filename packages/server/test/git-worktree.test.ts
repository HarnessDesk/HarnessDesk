import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { add, inventory, inventoryOf, list, move, prune, remove, setLock } from '../src/git-worktree.js'
import { list as sessionList, repositoryOf, worktreeHome } from '../src/worktree.js'
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

// -------------------------------------------------------------------- list

test('newline-containing checkout paths stay exact through both listings and shell identity', async () => {
  const { repo, state } = await seedRepo('repo\n ')
  const home = await worktreeHome(repo, state)
  await mkdir(home, { recursive: true })
  const side = join(home, 'side\n ')
  await git(repo, 'worktree', 'add', '-q', '-b', 'harnessdesk/side', side)

  for (const from of [repo, side]) {
    assert.deepEqual(await repositoryOf(from), { root: repo, worktree: from === side })
    assert.deepEqual(
      (await list(from, state)).map((row) => [row.path, row.isMain, row.isCurrent, row.managed, row.dirty]),
      [[repo, true, from === repo, false, 0], [side, false, from === side, true, 0]],
    )
    assert.deepEqual(
      (await sessionList(from, state)).map((row) => [row.path, row.isMain, row.managed]),
      [[repo, true, false], [side, false, true]],
    )
    const identity = await captureShellProject(from)
    assert.equal(identity.project, repo)
    assert.equal(identity.checkoutRoot, from)
    assert.equal(await shellProjectUnchanged(from, identity), true)
  }
})

test('a resolved submodule main folder must belong to the repository before it can be listed or used', async () => {
  const { repo: origin, beside, state } = await seedRepo()
  const superproject = join(beside, 'super')
  await mkdir(superproject)
  await git(superproject, 'init', '-q', '-b', 'main')
  await git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'sub')
  const sub = join(superproject, 'sub')
  const home = await worktreeHome(sub, state)
  await mkdir(home, { recursive: true })
  const side = join(home, 'side')
  await git(sub, 'worktree', 'add', '-q', '-b', 'harnessdesk/side', side)
  const common = join(superproject, '.git', 'modules', 'sub')
  const config = join(common, 'config')
  const alias = join(beside, 'sub-link')
  await symlink(sub, alias, 'dir')

  for (const valid of ['../../../sub', alias]) {
    await git(beside, 'config', '--file', config, 'core.worktree', valid)
    assert.deepEqual(await repositoryOf(side), { root: sub, worktree: true })
    assert.equal((await list(side, state))[0]?.path, sub)
    assert.equal((await captureShellProject(side)).project, sub)
  }

  const before = await git(origin, 'status', '--porcelain=v1', '-z')
  const branches = await git(side, 'branch', '--list')
  for (const invalid of [origin, join(beside, 'missing'), side]) {
    await git(beside, 'config', '--file', config, 'core.worktree', invalid)
    assert.equal(await repositoryOf(side), null)
    await assert.rejects(list(side, state), /main checkout|repository/)
    assert.deepEqual(await sessionList(side, state), [])
    await assert.rejects(inventoryOf(side, invalid, state), /main checkout|repository/)
    await assert.rejects(add(side, 'unwanted', { kind: 'new', branch: 'unwanted' }, state), /main checkout|repository/)
    await assert.rejects(captureShellProject(side), /changed its repository/)
    assert.equal(await shellProjectUnchanged(side, { project: side, checkoutRoot: side, gitCommonDir: common }), false)
    assert.equal(await git(origin, 'status', '--porcelain=v1', '-z'), before)
    assert.equal(await git(side, 'branch', '--list'), branches)
    assert.equal(await gone(join(beside, 'unwanted')), true)
  }
})

test('the listing preserves a main checkout path ending in whitespace', async () => {
  const { repo, beside, state } = await seedRepo('repo ')
  // A trimmed sibling must never supply the main row's status or location.
  const sibling = join(beside, 'repo')
  await mkdir(sibling)
  await git(sibling, 'init', '-q', '-b', 'main')
  await writeFile(join(sibling, 'untracked.txt'), 'sibling\n')
  const home = await worktreeHome(repo, state)
  await mkdir(home, { recursive: true })
  const side = join(home, 'side')
  await git(repo, 'worktree', 'add', '-q', '-b', 'harnessdesk/side', side)

  for (const from of [repo, side]) {
    const rows = await list(from, state)
    assert.deepEqual(
      rows.map((row) => [row.path, row.isMain, row.isCurrent, row.managed, row.dirty]),
      [
        [repo, true, from === repo, false, 0],
        [side, false, from === side, true, 0],
      ],
      `read from ${from}`,
    )
  }
})

test('the listing names every checkout, which is main, and which one we are reading from', async () => {
  const { repo, state } = await seedRepo()
  await git(repo, 'branch', 'feature')
  await add(repo, 'side', { kind: 'existing', branch: 'feature' }, state)

  const fromMain = await list(repo, state)
  assert.equal(fromMain.length, 2)
  assert.equal(fromMain[0]?.isMain, true)
  assert.equal(fromMain[0]?.branch, 'main')
  assert.equal(fromMain[0]?.isCurrent, true)
  assert.equal(fromMain[1]?.isMain, false)
  assert.equal(fromMain[1]?.branch, 'feature')
  assert.equal(fromMain[1]?.isCurrent, false)

  // Asked from inside the linked checkout, the same list comes back with the
  // "you are here" mark moved — git is happy to be asked from either.
  const fromSide = await list(fromMain[1]!.path, state)
  assert.equal(fromSide[0]?.isMain, true)
  assert.equal(fromSide[0]?.isCurrent, false)
  assert.equal(fromSide[1]?.isCurrent, true)
})

test('the listing reads what each checkout is holding, and a rename counts once', async () => {
  const { repo, state } = await seedRepo()
  await add(repo, 'side', { kind: 'new', branch: 'work' }, state)
  const side = (await list(repo, state))[1]!.path

  assert.equal((await list(repo, state))[1]?.dirty, 0)

  await git(side, 'mv', 'a.txt', 'b.txt')
  await writeFile(join(side, 'fresh.txt'), 'new\n')
  const held = (await list(repo, state))[1]
  // One rename and one untracked file: two files, not three — the rename's
  // origin arrives as its own NUL field and must not be counted again.
  assert.equal(held?.dirty, 2)
})

test('a locked worktree carries its reason, and a lost one is prunable rather than clean', async () => {
  const { repo, state } = await seedRepo()
  await add(repo, 'pinned', { kind: 'new', branch: 'pinned' }, state)
  await add(repo, 'lost', { kind: 'new', branch: 'lost' }, state)
  const lost = at(await list(repo, state), '/lost')!.path

  await setLock(repo, at(await list(repo, state), '/pinned')!.path, true, 'on a removable drive', state)
  await rm(lost, { recursive: true, force: true })

  const worktrees = await list(repo, state)
  assert.equal(at(worktrees, '/pinned')?.locked?.reason, 'on a removable drive')
  assert.equal(at(worktrees, '/pinned')?.prunable, null)
  assert.match(at(worktrees, '/lost')?.prunable?.reason ?? '', /non-existent/)
  // Not zero: there is no tree left to read, and "clean" would be a lie.
  assert.equal(at(worktrees, '/lost')?.dirty, null)
})

test('a checkout under HarnessDesk’s own directory reads as managed', async () => {
  const { repo, state } = await seedRepo()
  const home = await worktreeHome(repo, state)
  await mkdir(home, { recursive: true })
  // The session plane's shape, made the way the session plane makes it.
  await git(repo, 'worktree', 'add', '-q', '-b', 'harnessdesk/task', join(home, 'task'))

  const worktrees = await list(repo, state)
  assert.equal(worktrees[0]?.managed, false)
  assert.equal(at(worktrees, '/task')?.managed, true)
  assert.equal(at(worktrees, '/task')?.branch, 'harnessdesk/task')
})

/**
 * Git names a submodule's main checkout by its git directory, and one made with
 * `--separate-git-dir` by the directory kept apart. The row for it carries the
 * folder someone works in, as the session plane's listing does: it is what
 * "Open" opens, what a new worktree lands beside, and what decides which of
 * the others HarnessDesk made.
 */
test('the main checkout of a submodule, or of a separate git directory, is named by its folder', async () => {
  const { repo: origin, beside, state } = await seedRepo()
  const superproject = join(beside, 'super')
  await mkdir(superproject)
  await git(superproject, 'init', '-q', '-b', 'main')
  await git(superproject, 'commit', '-q', '--allow-empty', '-m', 'root')
  await git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'sub')
  const sub = join(superproject, 'sub')
  const home = await worktreeHome(sub, state)
  await mkdir(home, { recursive: true })
  const side = join(home, 'side')
  await git(sub, 'worktree', 'add', '-q', '-b', 'harnessdesk/side', side)

  for (const from of [sub, side]) {
    const rows = await list(from, state)
    assert.deepEqual(
      rows.map((row) => [row.path, row.isMain, row.isCurrent, row.managed]),
      [
        [sub, true, from === sub, false],
        [side, false, from === side, true],
      ],
      `read from ${from}`,
    )
  }
  // The folder can be read, which a git directory with no working tree cannot.
  assert.equal((await list(sub, state))[0]?.dirty, 0)

  // Beside the repository is beside the folder, not inside the superproject's .git.
  const made = await add(sub, 'feature', { kind: 'new', branch: 'feature' }, state)
  assert.equal(made.path, join(superproject, 'feature'))
})

test('a checkout with a separate git directory is listed by its folder when asked from it', async () => {
  const { beside, state } = await seedRepo()
  const work = join(beside, 'work')
  const apart = join(beside, 'apart.git')
  await git(beside, 'init', '-q', '-b', 'main', `--separate-git-dir=${apart}`, work)
  await git(work, 'commit', '-q', '--allow-empty', '-m', 'root')

  const rows = await list(work, state)
  assert.deepEqual(
    rows.map((row) => [row.path, row.isMain, row.isCurrent, row.dirty]),
    [[work, true, true, 0]],
  )
})

// --------------------------------------------------------------------- add

test('add makes a branch for the worktree, or takes one that exists, or detaches', async () => {
  const { repo, beside, state } = await seedRepo()

  const made = await add(repo, 'fresh', { kind: 'new', branch: 'fresh-work' }, state)
  assert.equal(made.branch, 'fresh-work')
  assert.equal(made.path, join(beside, 'fresh'))
  assert.equal((await git(repo, 'rev-parse', '--verify', 'fresh-work')).trim().length, 40)

  await git(repo, 'branch', 'already')
  const taken = await add(repo, 'existing', { kind: 'existing', branch: 'already' }, state)
  assert.equal(taken.branch, 'already')
  assert.equal((await git(taken.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'already')

  const loose = await add(repo, 'reading', { kind: 'detach', at: 'HEAD' }, state)
  assert.equal(loose.branch, null)
  const entry = at(await list(repo, state), '/reading')
  assert.equal(entry?.detached, true)
  assert.equal(entry?.branch, null)
})

test('add starts a new branch from the base it is given, not from HEAD', async () => {
  const { repo, state } = await seedRepo()
  const root = (await git(repo, 'rev-parse', 'HEAD')).trim()
  await writeFile(join(repo, 'a.txt'), 'two\n')
  await git(repo, 'commit', '-qam', 'second')

  const made = await add(repo, 'older', { kind: 'new', branch: 'from-root', base: root }, state)
  assert.equal((await git(made.path, 'rev-parse', 'HEAD')).trim(), root)
})

test('add passes on git’s refusal when the branch is checked out somewhere else', async () => {
  const { repo, state } = await seedRepo()
  await git(repo, 'branch', 'shared')
  const first = await add(repo, 'one', { kind: 'existing', branch: 'shared' }, state)

  await assert.rejects(
    () => add(repo, 'two', { kind: 'existing', branch: 'shared' }, state),
    (error: Error) => {
      // Git versions differ in how they describe the same branch conflict.
      assert.match(error.message, /already (?:used by worktree|checked out at)/)
      assert.ok(error.message.includes('shared'))
      // Where it is already checked out is the useful half of that sentence.
      assert.ok(error.message.includes(first.path))
      return true
    },
  )
})

test('a new worktree lands beside the repository and nowhere else', async () => {
  const { repo, beside, state } = await seedRepo()

  const outside = join(await tempDir(), 'elsewhere')
  await assert.rejects(
    () => add(repo, outside, { kind: 'new', branch: 'x' }, state),
    /New worktrees are made beside the repository/,
  )
  // The escape that looks like a relative path is the same refusal.
  await assert.rejects(
    () => add(repo, '../../escape', { kind: 'new', branch: 'x' }, state),
    /New worktrees are made beside the repository/,
  )
  // Inside the repository itself is legal git and a permanent nuisance.
  await assert.rejects(
    () => add(repo, 'repo/nested', { kind: 'new', branch: 'x' }, state),
    /is inside the checkout at/,
  )
  await assert.rejects(
    () => add(repo, 'repo', { kind: 'new', branch: 'x' }, state),
    /is inside the checkout at/,
  )
  // Nothing was created by any of those.
  assert.equal((await list(repo, state)).length, 1)
  assert.ok(await gone(join(beside, 'escape')))
})

test('a symlinked ancestor does not walk the destination out of the repository', async () => {
  const { repo, beside, state } = await seedRepo()
  const outside = await realpath(await tempDir())
  await symlink(outside, join(beside, 'link'))

  // Lexically `beside/link/added` is inside; really it is `outside/added`.
  await assert.rejects(
    () => add(repo, 'link/added', { kind: 'new', branch: 'sneaky' }, state),
    /New worktrees are made beside the repository/,
  )
  assert.ok(await gone(join(outside, 'added')))

  const made = await add(repo, 'honest', { kind: 'new', branch: 'honest' }, state)
  await assert.rejects(
    () => move(repo, made.path, 'link/moved', state),
    /New worktrees are made beside the repository/,
  )
  assert.ok(await gone(join(outside, 'moved')))
  assert.equal((await list(repo, state)).length, 2)
})

test('add refuses a folder that is already there rather than merging into it', async () => {
  const { repo, beside, state } = await seedRepo()
  await mkdir(join(beside, 'taken'))
  await writeFile(join(beside, 'taken', 'mine.txt'), 'not git’s\n')

  await assert.rejects(() => add(repo, 'taken', { kind: 'new', branch: 'x' }, state), /already exists/)
  assert.equal((await list(repo, state)).length, 1)
})

// ------------------------------------------------------------------ remove

test('the main checkout is never removed', async () => {
  const { repo, state } = await seedRepo()
  await assert.rejects(() => remove(repo, repo, false, undefined, state), /main checkout/)
  await assert.rejects(() => remove(repo, repo, true, undefined, state), /main checkout/)
  assert.equal((await list(repo, state)).length, 1)
})

test('uncommitted work is named before it can be discarded, and the branch outlives the worktree', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'busy', { kind: 'new', branch: 'busy-work' }, state)
  await writeFile(join(made.path, 'a.txt'), 'edited\n')
  await writeFile(join(made.path, 'scratch.txt'), 'untracked\n')

  const seen = await confirmed(made.path)
  await assert.rejects(
    () => remove(repo, made.path, false, seen, state),
    (error: Error) => {
      assert.match(error.message, /1 modified file/)
      assert.match(error.message, /1 untracked file/)
      return true
    },
  )
  assert.equal((await list(repo, state)).length, 2)

  const { branch } = await remove(repo, made.path, true, await confirmed(made.path), state)
  assert.equal(branch, 'busy-work')
  assert.equal((await list(repo, state)).length, 1)
  assert.ok(await gone(made.path))
  // The branch is cheap to keep and expensive to lose.
  assert.equal((await git(repo, 'rev-parse', '--verify', 'busy-work')).trim().length, 40)
})

test('a clean worktree removes without force', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'clean', { kind: 'new', branch: 'clean-work' }, state)

  // Nothing to lose, so nothing to confirm: the clean path stays one step.
  await remove(repo, made.path, false, undefined, state)
  assert.equal((await list(repo, state)).length, 1)
  assert.ok(await gone(made.path))
})

test('a locked worktree refuses to be removed until it is unlocked', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'pinned', { kind: 'new', branch: 'pinned' }, state)
  await setLock(repo, made.path, true, 'mid-experiment', state)

  await assert.rejects(() => remove(repo, made.path, true, undefined, state), /locked \(mid-experiment\)/)

  await setLock(repo, made.path, false, undefined, state)
  await remove(repo, made.path, false, undefined, state)
  assert.equal((await list(repo, state)).length, 1)
})

test('a path that is not a worktree of this repository is refused', async () => {
  const { repo, state } = await seedRepo()
  const stranger = await tempDir()
  await assert.rejects(
    () => remove(repo, stranger, true, undefined, state),
    /is not a worktree of this repository/,
  )
})

test('ignored files are inventoried, because git deletes them without being forced', async () => {
  const { repo, state } = await seedRepo()
  await writeFile(join(repo, '.gitignore'), 'local-secret.txt\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-qm', 'ignore the secret')
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  await writeFile(join(made.path, 'local-secret.txt'), 'API_KEY=hunter2\n')

  // Status alone calls this clean, and `git worktree remove` would empty it.
  assert.equal(at(await list(repo, state), '/holding')?.dirty, 0)
  const held = await inventory(made.path)
  assert.equal(held.changeCount, 0)
  assert.deepEqual(held.ignored, ['local-secret.txt'])

  // So an unconfirmed removal is refused, force or no force — nothing that
  // would be destroyed goes without having been named first.
  await assert.rejects(
    () => remove(repo, made.path, false, undefined, state),
    /1 ignored file or folder.*Read what is there/s,
  )
  assert.ok(!(await gone(made.path)))

  await remove(repo, made.path, false, held.stateId, state)
  assert.ok(await gone(made.path))
})

test('a confirmation is void once the folder has changed under it', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'busy', { kind: 'new', branch: 'busy' }, state)
  await writeFile(join(made.path, 'one.txt'), 'seen\n')
  const seen = await confirmed(made.path)

  // Another hand puts work in between the looking and the clicking. The old
  // digest is authority over a state that no longer exists.
  await writeFile(join(made.path, 'two.txt'), 'never seen\n')
  await assert.rejects(
    () => remove(repo, made.path, true, seen, state),
    /changed since you looked.*2 uncommitted files/s,
  )
  assert.ok(!(await gone(made.path)))

  // Looking again is what makes it removable.
  await remove(repo, made.path, true, await confirmed(made.path), state)
  assert.ok(await gone(made.path))
})

test('a confirmation is void after a file is added inside an ignored directory', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  await writeFile(join(made.path, '.gitignore'), 'drafts/\n')
  await mkdir(join(made.path, 'drafts', 'nested'), { recursive: true })
  await writeFile(join(made.path, 'drafts', 'one.txt'), 'seen\n')
  const held = await inventory(made.path)
  assert.deepEqual(held.ignored, ['drafts/'])

  const added = join(made.path, 'drafts', 'nested', 'two.txt')
  await writeFile(added, 'new notes\n')
  await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
  assert.equal(await readFile(added, 'utf8'), 'new notes\n')
  await remove(repo, made.path, true, await confirmed(made.path), state)
  assert.ok(await gone(made.path))
})

// Work git reports as changed, tracked or not, is held to its contents. What git
// ignores is held to its names, types and sizes instead: see "writers" below.
test('a confirmation is void after listed file contents change', async (t) => {
  for (const path of ['a.txt', 'loose.txt']) {
    await t.test(path, async () => {
      const { repo, state } = await seedRepo()
      const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
      const file = join(made.path, path)
      await writeFile(file, 'seen\n')
      const held = await inventory(made.path)
      const before = await stat(file)
      await writeFile(file, 'edit\n')
      await utimes(file, before.atime, before.mtime)

      await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
      assert.equal(await readFile(file, 'utf8'), 'edit\n')
      await remove(repo, made.path, true, await confirmed(made.path), state)
      assert.ok(await gone(made.path))
    })
  }
})

test('inventory can confirm unreadable working and ignored files from their metadata', async (t) => {
  for (const path of ['a.txt', 'cache/one.bin']) {
    await t.test(path, async () => {
      const { repo, state } = await seedRepo()
      const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
      await writeFile(join(made.path, '.gitignore'), 'cache/\n')
      await mkdir(join(made.path, 'cache'))
      const file = join(made.path, path)
      await writeFile(file, 'local notes\n')
      await chmod(file, 0o000)
      try {
        await remove(repo, made.path, true, await confirmed(made.path), state)
        assert.ok(await gone(made.path))
      } finally {
        await chmod(file, 0o644).catch(() => {})
      }
    })
  }
})

test('inventory does not open checked files after a path replacement', async (t) => {
  for (const path of ['a.txt', 'cache/one.bin']) {
    await t.test(path, async (t) => {
      const { repo, state } = await seedRepo()
      const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
      await writeFile(join(made.path, '.gitignore'), 'cache/\n')
      await mkdir(join(made.path, 'cache'))
      const file = join(made.path, path)
      await writeFile(file, 'local notes\n')
      const outside = join(await tempDir('hd-inventory-outside-'), 'one.bin')
      await writeFile(outside, 'outside notes\n')
      const original = fs.createReadStream
      let opened = 0
      t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
        if (args[0] === file) {
          opened++
          fs.unlinkSync(file)
          fs.symlinkSync(outside, file)
        }
        return original(...args)
      })
      syncBuiltinESMExports()
      try {
        await inventory(made.path)
        assert.equal(opened, 0, 'inventory only needs file metadata')
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()
      }
      assert.equal(await readFile(outside, 'utf8'), 'outside notes\n')
    })
  }
})

test('a confirmation covers file contents beyond the inventory display cap', async () => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  for (let index = 0; index < 45; index += 1) {
    await writeFile(join(made.path, `f${index.toString().padStart(2, '0')}.txt`), 'seen\n')
  }
  const held = await inventory(made.path)
  assert.equal(held.changes.length, 40)
  assert.equal(held.changeCount, 45)
  await writeFile(join(made.path, 'f44.txt'), 'edit\n')

  await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
  assert.equal(await readFile(join(made.path, 'f44.txt'), 'utf8'), 'edit\n')
})

test('inventory survives a reader held back beyond the Git listing deadline', { timeout: 30_000 }, async (t) => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  await writeFile(join(made.path, '.gitignore'), 'cache/\n')
  const directory = `cache/${'a'.repeat(200)}/${'b'.repeat(200)}`
  await mkdir(join(made.path, directory), { recursive: true })
  const seed = join(made.path, directory, 'seed')
  await writeFile(seed, '')
  for (let start = 0; start < 4096; start += 64) {
    await Promise.all(Array.from({ length: 64 }, (_, offset) =>
      link(seed, join(made.path, directory, `${start + offset}-${'x'.repeat(180)}`))))
  }

  const spawn = childProcess.spawn
  let listing: ReturnType<typeof spawn> | undefined
  t.mock.method(childProcess, 'spawn', ((command, args, options) => {
    // Compress the production deadline so this regression takes milliseconds,
    // while keeping real Git, pipes, backpressure and the child kill timer.
    const ignored = args?.includes('--ignored')
    const child = spawn(command, args!, ignored && options?.timeout
      ? { ...options, timeout: 250 } : options!)
    if (ignored) listing = child
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
    const reading = inventory(made.path)
    await blocked
    assert.ok(listing)
    assert.equal(listing.exitCode, null, 'Git is still writing when the reader stops')
    await delay(500)
    release()
    assert.deepEqual((await reading).ignored, ['cache/'])
  } finally {
    release()
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  await remove(repo, made.path, true, await confirmed(made.path), state)
  assert.ok(await gone(made.path))
})

test('inventory checks shared parents once before and after each metadata batch', async (t) => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  await writeFile(join(made.path, '.gitignore'), 'cache/\n')
  await mkdir(join(made.path, 'cache', 'deep'), { recursive: true })
  await Promise.all(Array.from({ length: 64 }, (_, index) =>
    writeFile(join(made.path, 'cache', 'deep', `${index}.bin`), 'notes\n')))
  const lstat = fsPromises.lstat
  const reads = new Map<string, number>()
  t.mock.method(fsPromises, 'lstat', (async (...args: Parameters<typeof lstat>) => {
    const path = String(args[0])
    reads.set(path, (reads.get(path) ?? 0) + 1)
    return lstat(...args)
  }) as typeof lstat)
  syncBuiltinESMExports()
  try {
    await inventory(made.path)
    assert.equal(reads.get(join(made.path, 'cache')), 2)
    assert.equal(reads.get(join(made.path, 'cache', 'deep')), 2)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('inventory refuses a parent changed during a metadata batch', async (t) => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  await writeFile(join(made.path, '.gitignore'), 'cache/\n')
  const directory = join(made.path, 'cache')
  await mkdir(directory)
  const file = join(directory, 'one.bin')
  await writeFile(file, 'notes\n')
  const lstat = fsPromises.lstat
  t.mock.method(fsPromises, 'lstat', (async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]) === file) await chmod(directory, (await stat(directory)).mode ^ 0o040)
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

test('forced removal refuses when inventory metadata cannot be read', async (t) => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  const file = join(made.path, 'a.txt')
  await writeFile(file, 'notes\n')
  const held = await confirmed(made.path)
  const lstat = fsPromises.lstat
  t.mock.method(fsPromises, 'lstat', (async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]) === file) throw Object.assign(new Error('inventory metadata refused'), { code: 'EACCES' })
    return lstat(...args)
  }) as typeof lstat)
  syncBuiltinESMExports()
  try {
    await assert.rejects(remove(repo, made.path, true, held, state), /inventory metadata refused/)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(await readFile(file, 'utf8'), 'notes\n')
})

test('inventory walks nested repository folders in parallel', async (t) => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  const nested = join(made.path, 'nested')
  await mkdir(nested)
  await git(nested, 'init', '-q', '-b', 'main')
  for (let index = 0; index < 8; index++) {
    const directory = join(nested, `folder${index}`)
    await mkdir(directory)
    await writeFile(join(directory, 'one.txt'), 'notes\n')
  }
  const lstat = fsPromises.lstat
  let active = 0
  let peak = 0
  let reverse = false
  t.mock.method(fsPromises, 'lstat', (async (...args: Parameters<typeof lstat>) => {
    if (!String(args[0]).endsWith('/one.txt')) return lstat(...args)
    active++
    peak = Math.max(peak, active)
    try {
      const index = Number(String(args[0]).match(/folder(\d+)/)?.[1] ?? 0)
      await delay(reverse ? 8 - index : index + 1)
      return await lstat(...args)
    } finally {
      active--
    }
  }) as typeof lstat)
  syncBuiltinESMExports()
  try {
    const held = await inventory(made.path)
    reverse = true
    assert.equal(held.stateId, await confirmed(made.path), 'completion order cannot change the digest')
    assert.ok(peak > 1, `nested folders were checked ${peak} at a time`)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('inventory handles large ignored listings and clean indexes', { timeout: 120_000 }, async (t) => {
  const { repo, state } = await seedRepo()
  const made = await add(repo, 'holding', { kind: 'new', branch: 'holding' }, state)
  await writeFile(join(made.path, '.gitignore'), 'cache/\n')
  const directory = `cache/${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}`
  await mkdir(join(made.path, directory), { recursive: true })
  const seed = join(made.path, 'cache', 'seed.bin')
  await writeFile(seed, '')
  const count = 22_000
  let bytes = 0
  for (let start = 0; start < count; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, count - start) }, async (_, offset) => {
      const file = `${directory}/f${String(start + offset).padStart(5, '0')}-${'x'.repeat(170)}`
      bytes += Buffer.byteLength(file) + 1
      await link(seed, join(made.path, file))
    }))
  }
  assert.ok(bytes > 16 * 1024 * 1024, 'the ignored listing exceeds the buffered output limit')

  await t.test('ignored listing', async () => {
    const held = await inventory(made.path)
    assert.deepEqual(held.ignored, ['cache/'])
    const added = join(made.path, directory, 'later.bin')
    await writeFile(added, 'later notes\n')
    await assert.rejects(() => remove(repo, made.path, true, held.stateId, state), /changed since you looked/)
    assert.equal(await readFile(added, 'utf8'), 'later notes\n')
  })
  await git(made.path, 'add', '-f', '.')
  await git(made.path, 'commit', '-qm', 'keep the local files')
  await t.test('clean index', async () => {
    const held = await inventory(made.path)
    assert.equal(held.changeCount, 0)
    assert.equal(held.ignoredCount, 0)
    await remove(repo, made.path, false, undefined, state)
    assert.ok(await gone(made.path))
  })
})

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
 * it, so a confirmation holds it to its names, types and sizes. What git
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

test('a status read that never ends is stopped at the deadline and its child is killed', { timeout: 30_000, skip: process.platform === 'win32' }, async (t) => {
  const { repo, state, made } = await withCache('holding')
  const held = await inventory(made.path)
  // A git that goes quiet on the read which lists what is ignored, as it would on a stalled mount.
  const bin = await tempDir('hd-git-shim-')
  const pidFile = join(bin, 'stuck.pid')
  const real = (await run('sh', ['-c', 'command -v git'])).stdout.trim()
  await writeFile(join(bin, 'git'), [
    '#!/bin/sh',
    'for arg in "$@"; do',
    `  if [ "$arg" = "--ignored" ]; then echo $$ > '${pidFile}'; exec sleep 60; fi`,
    'done',
    `exec '${real}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path ?? ''}`
  let pid = 0
  try {
    await assert.rejects(remove(repo, made.path, true, held.stateId, state, { deadlineMs: 4_000 }), DEADLINE)
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
