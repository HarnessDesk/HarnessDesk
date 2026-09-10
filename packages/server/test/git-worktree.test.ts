import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'

import { add, inventory, list, move, prune, remove, setLock } from '../src/git-worktree.js'
import { worktreeHome } from '../src/worktree.js'

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
const seedRepo = async (): Promise<{ repo: string; beside: string; state: string }> => {
  // Canonical: git reports real paths, and on macOS the temp dir is reached
  // through a symlink — so an expectation built on the raw path would fail
  // over /var vs /private/var rather than over anything this module does.
  const beside = await realpath(await tempDir())
  const repo = join(beside, 'repo')
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
      assert.match(error.message, /already used by worktree/)
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
