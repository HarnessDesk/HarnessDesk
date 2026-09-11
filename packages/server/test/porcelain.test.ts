import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { commitAll } from '../src/git-actions.js'
import { diff, status } from '../src/git.js'
import { parsePorcelain } from '../src/porcelain.js'
import { inventory, list } from '../src/git-worktree.js'
import { changes } from '../src/worktree.js'

/**
 * `git status --porcelain=v1 -z` and the second path.
 *
 * A rename *or a copy* is two NUL-separated fields — the destination, then the
 * origin — and a reader that consumes only the first leaves a bare path in the
 * stream. The next turn of the loop reads that path as a status record, takes
 * three characters off the front of it, and reports a file that does not exist.
 *
 * The shape below is measured against git 2.50.1 rather than reasoned about,
 * because two plausible-sounding beliefs about it are both wrong: that copies
 * cannot appear (they can, under `status.renames=copies`), and that the
 * worktree column can carry the second path (it cannot — an unstaged rename is
 * reported as an ordinary delete beside an ordinary untracked file).
 */

const run = promisify(execFile)

/** A repository holding one copy that git will report as a copy. */
const repoWithACopy = async (t: { after: (fn: () => unknown) => void }): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-porcelain-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const git = (...args: string[]): Promise<unknown> => run('git', args, { cwd: dir })
  await git('init', '-q')
  await git('config', 'user.email', 't@example.com')
  await git('config', 'user.name', 'T')
  // Copy detection is off by default and is a documented setting; without it
  // git reports a copy as an ordinary add and this defect cannot be reached.
  await git('config', 'status.renames', 'copies')
  await writeFile(join(dir, 'src.txt'), 'alpha beta gamma delta epsilon zeta eta theta iota kappa\n', 'utf8')
  await git('add', '-A')
  await git('commit', '-qm', 'first')

  // A copy is only detected beside a change to its source.
  await writeFile(join(dir, 'dup.txt'), 'alpha beta gamma delta epsilon zeta eta theta iota kappa\n', 'utf8')
  await writeFile(join(dir, 'src.txt'), 'alpha beta gamma delta epsilon zeta eta theta iota kappa\nchanged\n', 'utf8')
  await git('add', '-A')
  return dir
}

test('the parser reads a copy as one record carrying its origin', () => {
  const parsed = parsePorcelain('C  dup.txt\0src.txt\0M  src.txt\0')
  assert.deepEqual(
    parsed.map((entry) => ({ index: entry.index, path: entry.path, origin: entry.origin })),
    [
      { index: 'C', path: 'dup.txt', origin: 'src.txt' },
      { index: 'M', path: 'src.txt', origin: null },
    ],
    'the origin belongs to the copy record, not to a record of its own',
  )
})

test('the parser reads a rename the same way', () => {
  const parsed = parsePorcelain('R  b.txt\0a.txt\0')
  assert.deepEqual(parsed, [{ index: 'R', worktree: ' ', path: 'b.txt', origin: 'a.txt' }])
})

test('only the index column carries a second path', () => {
  // Measured: an unstaged rename is ` D src.txt` beside `?? moved.txt`. There
  // is no worktree-column rename with an origin to skip, so a reader that
  // skips on the worktree column would swallow the next real record.
  const parsed = parsePorcelain(' D src.txt\0?? moved.txt\0')
  assert.deepEqual(
    parsed.map((entry) => entry.path),
    ['src.txt', 'moved.txt'],
    'both records survive',
  )
})

test('a partially staged file is one record, keeping both columns', () => {
  const parsed = parsePorcelain('MM orig.txt\0')
  assert.deepEqual(parsed, [{ index: 'M', worktree: 'M', path: 'orig.txt', origin: null }])
})

test('git.status does not invent a file from a copy record′s origin', async (t) => {
  const dir = await repoWithACopy(t)
  const found = await status(dir)
  const paths = (found?.files ?? []).map((file) => file.path).sort()
  assert.deepEqual(paths, ['dup.txt', 'src.txt'], `reported: ${JSON.stringify(paths)}`)
})

test('worktree.changes does not count a copy record′s origin as a file', async (t) => {
  const dir = await repoWithACopy(t)
  const found = await changes(dir)
  assert.deepEqual([...found.files].sort(), ['dup.txt', 'src.txt'], `reported: ${JSON.stringify(found.files)}`)
})

test('committing a copy does not drag its source into the commit', async (t) => {
  const dir = await repoWithACopy(t)
  // Both are staged: `dup.txt` (the copy) and a change to `src.txt` (its
  // source). Committing only the copy must leave the source's change alone.
  await commitAll(dir, 'just the copy', ['dup.txt'])

  const after = await status(dir)
  const left = (after?.files ?? []).map((file) => file.path)
  assert.deepEqual(
    left,
    ['src.txt'],
    `the source's change must survive; still uncommitted: ${JSON.stringify(left)}`,
  )
})

test('the ignored pass does not read a copy′s origin as an ignored path', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-ignored-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const git = (...args: string[]): Promise<unknown> => run('git', args, { cwd: dir })
  await git('init', '-q')
  await git('config', 'user.email', 't@example.com')
  await git('config', 'user.name', 'T')
  await git('config', 'status.renames', 'copies')

  /* A source whose *name* begins with the ignored marker. The ignored pass
     tested `entry.startsWith('!! ')` against every field, and an origin is a
     bare path — so this name made the origin look like an ignored record and
     `src.txt` appeared in `ignored` having never been ignored. */
  const source = '!! src.txt'
  await writeFile(join(dir, source), 'alpha beta gamma delta epsilon zeta eta theta iota kappa\n', 'utf8')
  await git('add', '-A')
  await git('commit', '-qm', 'first')
  await writeFile(join(dir, 'dup.txt'), 'alpha beta gamma delta epsilon zeta eta theta iota kappa\n', 'utf8')
  await writeFile(join(dir, source), 'alpha beta gamma delta epsilon zeta eta theta iota kappa\nchanged\n', 'utf8')
  await git('add', '-A')

  const found = await inventory(dir)
  assert.deepEqual([...found.ignored], [], `nothing is ignored here; reported: ${JSON.stringify(found.ignored)}`)
})

test('the worktree dirty count does not count a copy′s origin', async (t) => {
  const dir = await repoWithACopy(t)
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-wt-state-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  // `dirtyCount` is reached through `list`, which is the only way in.
  const found = await list(dir, stateDir)
  const here = found.find((entry) => entry.path === dir) ?? found[0]
  assert.equal(here?.dirty, 2, `two real files are dirty, not three; got ${here?.dirty}`)
})

test('a file changed on both sides is listed in each, and a conflict once, in the working tree', async (t) => {
  // #31: read as one entry, the index letter won, and the working tree's change was in no view.
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-status-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const git = (...args: string[]): Promise<unknown> =>
    run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: dir })
  await git('init', '-q', '-b', 'main')
  await writeFile(join(dir, 'both.txt'), 'one\n')
  await writeFile(join(dir, 'conflict.txt'), 'base\n')
  await git('add', '.')
  await git('commit', '-qm', 'base')
  // A merge that stops on a conflict: both sides changed the same line.
  await git('checkout', '-qb', 'theirs')
  await writeFile(join(dir, 'conflict.txt'), 'theirs\n')
  await git('commit', '-qam', 'theirs')
  await git('checkout', '-q', 'main')
  await writeFile(join(dir, 'conflict.txt'), 'ours\n')
  await git('commit', '-qam', 'ours')
  await git('merge', '-q', 'theirs').catch(() => {})
  // MM: staged, then changed again. AM: added, then changed again. And a file git does not track.
  await writeFile(join(dir, 'both.txt'), 'one\ntwo\n')
  await git('add', 'both.txt')
  await writeFile(join(dir, 'both.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(dir, 'new.txt'), 'a\n')
  await git('add', 'new.txt')
  await writeFile(join(dir, 'new.txt'), 'a\nb\n')
  await writeFile(join(dir, 'loose.txt'), 'x\n')

  const found = await status(dir)
  const entries = (found?.files ?? []).map((file) => `${file.staged ? 'staged' : 'worktree'} ${file.status} ${file.path}`).sort()
  assert.deepEqual(entries, [
    'staged added new.txt',
    'staged modified both.txt',
    'worktree conflicted conflict.txt',
    'worktree modified both.txt',
    'worktree modified new.txt',
    'worktree untracked loose.txt',
  ])
})

test('the working tree\'s diff names files a/ and b/, whatever the repository\'s diff settings say (#171)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-noprefix-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const git = (...args: string[]): Promise<{ stdout: string }> =>
    run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: dir })
  await git('init', '-q', '-b', 'main')
  await writeFile(join(dir, 'f.txt'), 'one\n')
  await git('add', '.')
  await git('commit', '-qm', 'base')
  await writeFile(join(dir, 'f.txt'), 'two\n')
  for (const setting of ['diff.noprefix', 'diff.mnemonicPrefix']) {
    await git('config', setting, 'true')
    // The control: the setting took, and git's own diff drops or changes the prefixes.
    const { stdout: plain } = await git('diff')
    assert.ok(!plain.includes('diff --git a/f.txt b/f.txt'), setting)
    const read = await diff(dir)
    assert.ok(read.includes('diff --git a/f.txt b/f.txt'), `${setting}: ${read.split('\n')[0]}`)
    assert.ok(read.includes('--- a/f.txt') && read.includes('+++ b/f.txt'), setting)
    await git('config', '--unset', setting)
  }
})
