import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { WorktreeDirtyError, Worktrees, repositoryOf, slugify } from '../src/worktree.js'

/**
 * Worktrees against a real git repository in a temporary directory. The
 * property under test is the one that can destroy someone's work: removal
 * never discards uncommitted changes unless told to, and says what it would
 * discard first.
 */

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } })).stdout

interface Fixture {
  readonly repo: string
  readonly stateDir: string
  readonly worktrees: Worktrees
}

const fixture = async (t: { after(fn: () => Promise<void>): void }): Promise<Fixture> => {
  // Real path, because git reports real paths and macOS's tmpdir is a symlink.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'harnessdesk-worktree-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const repo = join(base, 'repo')
  const stateDir = join(base, 'state')
  await run('git', ['init', '-q', '-b', 'main', repo])
  await writeFile(join(repo, 'shared.txt'), 'original\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', 'init')
  return { repo, stateDir, worktrees: new Worktrees(stateDir) }
}

/**
 * What the session list groups on. Every checkout of a repository has to name
 * the same project — otherwise a conversation in a worktree becomes a project
 * of its own — and only a linked checkout may be called a worktree, because
 * that is what the row's mark claims.
 */
test('every checkout of a repository names the same project, and only a linked one is a worktree', async (t) => {
  const { repo, worktrees } = await fixture(t)
  const tree = await worktrees.create(repo, { name: 'Fix the parser' })
  await mkdir(join(repo, 'packages', 'desktop'), { recursive: true })

  assert.deepEqual(await repositoryOf(repo), { root: repo, worktree: false })
  assert.deepEqual(
    await repositoryOf(join(repo, 'packages', 'desktop')),
    { root: repo, worktree: false },
    'a subfolder is the same working copy, not a worktree',
  )
  assert.deepEqual(await repositoryOf(tree.path), { root: repo, worktree: true })
  await mkdir(join(tree.path, 'packages', 'desktop'), { recursive: true })
  assert.deepEqual(
    await repositoryOf(join(tree.path, 'packages', 'desktop')),
    { root: repo, worktree: true },
    'and a subfolder of a worktree is still that worktree',
  )
  assert.equal(await repositoryOf(tmpdir()), null, 'nothing to say outside a repository')
})

/**
 * The root has to be a folder someone works in, not wherever git keeps its
 * state. `dirname(--git-common-dir)` is the checkout only for the ordinary
 * layout: a submodule's common dir is `<super>/.git/modules/<path>`, and
 * `git worktree list` names that same directory rather than the folder the
 * submodule is checked out at — so both shortcuts hand the interface a path
 * inside `.git` to name a project after and start conversations in.
 */
test('a submodule names the folder it is checked out at, not the git directory under it', async (t) => {
  const { repo: child, stateDir } = await fixture(t)
  const base = join(child, '..')
  const superRepo = join(base, 'super')
  await mkdir(superRepo, { recursive: true })
  await run('git', ['init', '-q', '-b', 'main', superRepo])
  await writeFile(join(superRepo, 'top.txt'), 'top\n')
  await git(superRepo, 'add', '-A')
  await git(superRepo, 'commit', '-q', '-m', 'init')
  // A file:// submodule needs the transport turned on explicitly since 2.38.
  await git(superRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/child')
  await git(superRepo, 'commit', '-q', '-m', 'add the submodule')
  const inside = join(superRepo, 'vendor', 'child')

  assert.deepEqual(await repositoryOf(inside), { root: inside, worktree: false })
  assert.deepEqual(
    await repositoryOf(superRepo),
    { root: superRepo, worktree: false },
    'and the superproject is a project of its own',
  )

  // The same again from a linked worktree of the submodule, where the answer
  // has to come from the listing rather than from where we are standing.
  const linked = join(base, 'submodule-worktree')
  await git(inside, 'worktree', 'add', '-q', linked, '-b', 'side')
  assert.deepEqual(await repositoryOf(linked), { root: inside, worktree: true })
  assert.equal(await new Worktrees(stateDir).list(linked).then((all) => all[0]?.isMain), true)
})

/** A repository whose git directory is somewhere else entirely. */
test('a checkout with a separate git directory names the checkout', async (t) => {
  const { repo } = await fixture(t)
  const base = join(repo, '..')
  const work = join(base, 'work')
  const gitDir = join(base, 'elsewhere')
  await run('git', ['init', '-q', '-b', 'main', `--separate-git-dir=${gitDir}`, work])
  await writeFile(join(work, 'a.txt'), 'a\n')
  await git(work, 'add', '-A')
  await git(work, 'commit', '-q', '-m', 'init')

  assert.deepEqual(await repositoryOf(work), { root: work, worktree: false })
})

test('two conversations in two worktrees edit the same path without seeing each other', async (t) => {
  const { repo, stateDir, worktrees } = await fixture(t)
  const a = await worktrees.create(repo, { name: 'Fix the parser' })
  const b = await worktrees.create(repo, { name: 'Fix the parser' })

  assert.notEqual(a.path, b.path)
  assert.equal(a.branch, 'harnessdesk/fix-the-parser')
  assert.equal(b.branch, 'harnessdesk/fix-the-parser-2', 'a second worktree of the same name gets its own branch')
  assert.ok(a.path.startsWith(join(stateDir, 'worktrees')), 'worktrees live outside the repository')

  await writeFile(join(a.path, 'shared.txt'), 'from a\n')
  await writeFile(join(b.path, 'shared.txt'), 'from b\n')
  assert.equal(await readFile(join(a.path, 'shared.txt'), 'utf8'), 'from a\n')
  assert.equal(await readFile(join(b.path, 'shared.txt'), 'utf8'), 'from b\n')
  assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'original\n', 'the main checkout is untouched')

  const listed = await worktrees.list(repo)
  assert.deepEqual(
    listed.map((entry) => [entry.isMain, entry.managed]).sort(),
    [
      [false, true],
      [false, true],
      [true, false],
    ],
  )
})

test('a branch left behind by a removed worktree still counts as taken', async (t) => {
  // `worktree add -b` refuses an existing branch whether or not anything has
  // it checked out — so the collision check has to see every local branch,
  // not just the ones tied to a current worktree.
  const { repo, worktrees } = await fixture(t)
  await git(repo, 'branch', 'harnessdesk/left-behind')
  const wt = await worktrees.create(repo, { name: 'Left behind' })
  assert.equal(wt.branch, 'harnessdesk/left-behind-2', 'the bare branch was stepped around, not tripped over')
})

test('removing a worktree with uncommitted work is refused, naming what would be lost', async (t) => {
  const { repo, worktrees } = await fixture(t)
  const wt = await worktrees.create(repo, { name: 'risky' })
  await writeFile(join(wt.path, 'shared.txt'), 'edited\n')
  await writeFile(join(wt.path, 'new.txt'), 'new\n')

  const pending = await worktrees.changes(wt.path)
  assert.equal(pending.modified, 1)
  assert.equal(pending.untracked, 1)
  assert.deepEqual([...pending.files].sort(), ['new.txt', 'shared.txt'])

  await assert.rejects(
    () => worktrees.remove(wt.path),
    (error: unknown) => {
      assert.ok(error instanceof WorktreeDirtyError)
      assert.match(error.message, /1 modified file, 1 untracked file/)
      assert.deepEqual([...error.changes.files].sort(), ['new.txt', 'shared.txt'])
      return true
    },
  )
  // Still there, edits intact: a refusal must not be half a removal.
  assert.equal(await readFile(join(wt.path, 'shared.txt'), 'utf8'), 'edited\n')
  assert.ok((await worktrees.list(repo)).some((entry) => entry.path === wt.path))

  // With force, gone — but the branch survives, because a branch is cheap to
  // keep and `git branch -d` is one command away.
  const removed = await worktrees.remove(wt.path, { force: true })
  assert.equal(removed.branch, 'harnessdesk/risky')
  await assert.rejects(() => stat(wt.path))
  assert.match(await git(repo, 'branch', '--list', 'harnessdesk/risky'), /harnessdesk\/risky/)
})

test('a clean worktree is removed without force, and its commits are noted first', async (t) => {
  const { repo, worktrees } = await fixture(t)
  const wt = await worktrees.create(repo, { name: 'done' })
  await writeFile(join(wt.path, 'shared.txt'), 'committed\n')
  await git(wt.path, 'commit', '-q', '-am', 'work')

  const pending = await worktrees.changes(wt.path)
  assert.equal(pending.modified + pending.untracked, 0)
  assert.equal(pending.unpushedCommits, 1, 'a commit the main branch lacks is reported, not hidden')

  await worktrees.remove(wt.path)
  await assert.rejects(() => stat(wt.path))
  assert.match(await git(repo, 'branch', '--list', 'harnessdesk/done'), /harnessdesk\/done/)
})

test('only worktrees HarnessDesk created can be removed from here', async (t) => {
  const { repo, worktrees } = await fixture(t)
  await assert.rejects(() => worktrees.remove(repo), /main checkout/)

  const theirs = join(repo, '..', 'theirs')
  await git(repo, 'worktree', 'add', '-q', '-b', 'theirs', theirs)
  await assert.rejects(() => worktrees.remove(theirs, { force: true }), /not created by HarnessDesk/)
  assert.ok((await stat(theirs)).isDirectory())

  await assert.rejects(() => worktrees.remove(join(repo, '..', 'nowhere')), /not a git worktree/)
})

test('a directory that is not a repository cannot get a worktree', async (t) => {
  const { worktrees } = await fixture(t)
  const plain = await mkdtemp(join(tmpdir(), 'harnessdesk-plain-'))
  t.after(() => rm(plain, { recursive: true, force: true }))
  await assert.rejects(() => worktrees.create(plain, { name: 'x' }), /not inside a git repository/)
  assert.deepEqual(await worktrees.list(plain), [])
})

test('names become branch-safe slugs', () => {
  assert.equal(slugify('Fix the parser!'), 'fix-the-parser')
  assert.equal(slugify('  ..weird/../name..  '), 'weird-.-name')
  assert.match(slugify(''), /^work-/)
  assert.equal(slugify('a'.repeat(80)).length, 48)
})

test('a worktree starts from the branch it was told to, not from HEAD', async (t) => {
  const { repo, worktrees } = await fixture(t)
  // A second branch with a commit the main branch does not have, so "which
  // branch did this start from" has an answer the file system can give.
  await git(repo, 'checkout', '-q', '-b', 'feature')
  await writeFile(join(repo, 'only-on-feature.txt'), 'yes\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', 'feature work')
  await git(repo, 'checkout', '-q', 'main')

  const off = await worktrees.create(repo, { name: 'from feature', base: 'feature' })
  await stat(join(off.path, 'only-on-feature.txt'))

  // And without a base it is still whatever is checked out.
  const here = await worktrees.create(repo, { name: 'from head' })
  await assert.rejects(() => stat(join(here.path, 'only-on-feature.txt')))
})
