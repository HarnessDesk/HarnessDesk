import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { commit, commitDiff, createBranch, log, refs } from '../src/git-history.js'

/**
 * The history reader against a real repository, built once: two branches, a
 * merge, a rename, a binary file, an annotated and a lightweight tag, a
 * stash, and a fabricated remote with the branch tracking it. The properties
 * under test are the ones the pane leans on: order and paging, decorations,
 * scoped search, a merge read against its first parent, and every "not a
 * repository / no commits yet" edge answering gently rather than throwing.
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

const sha = async (cwd: string, ref: string): Promise<string> => (await git(cwd, 'rev-parse', ref)).trim()

const scratch: string[] = []
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-git-history-'))
  scratch.push(dir)
  return dir
}

/** The one rich repository every test reads. Built lazily, exactly once. */
let built: Promise<string> | null = null
const repo = (): Promise<string> => {
  built ??= (async () => {
    const dir = await tempDir()
    await git(dir, 'init', '-q', '-b', 'main')
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-qm', 'root: the first commit')

    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    await writeFile(join(dir, 'b.txt'), 'notes\n')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-qm', 'second: grows a.txt and adds b.txt')

    // A side branch with a binary file, merged back without fast-forward.
    await git(dir, 'checkout', '-qb', 'feat/pictures')
    await writeFile(join(dir, 'pic.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-qm', 'pictures: a binary lands')
    await git(dir, 'checkout', '-q', 'main')
    await git(dir, 'merge', '-q', '--no-ff', '-m', 'merge feat/pictures', 'feat/pictures')

    // A rename on top, so name-status carries two paths.
    await git(dir, 'mv', 'b.txt', 'renamed.txt')
    await git(dir, 'commit', '-qm', 'rename: b.txt moves')

    // A branch nobody merged, to tell scope=all from scope=head apart.
    await git(dir, 'checkout', '-qb', 'feat/unmerged', 'main~1')
    await writeFile(join(dir, 'only-here.txt'), 'alone\n')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-qm', 'unmerged: a commit HEAD cannot reach')
    await git(dir, 'checkout', '-q', 'main')

    await git(dir, 'tag', '-a', 'v1', '-m', 'first release', 'main~1')
    await git(dir, 'tag', 'lightweight', 'main')

    // A remote-tracking ref without a network: main tracks origin/main,
    // which sits two commits behind, so ahead/behind have known values.
    await git(dir, 'remote', 'add', 'origin', dir)
    await git(dir, 'update-ref', 'refs/remotes/origin/main', await sha(dir, 'main~2'))
    await git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    await git(dir, 'config', 'branch.main.remote', 'origin')
    await git(dir, 'config', 'branch.main.merge', 'refs/heads/main')

    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    await git(dir, 'stash', 'push', '-qm', 'work in flight')
    return dir
  })()
  return built
}

test('log walks newest first with parents, identities and decorations', async () => {
  const dir = await repo()
  const page = await log(dir)
  const subjects = page.commits.map((entry) => entry.subject)
  assert.equal(subjects[0], 'unmerged: a commit HEAD cannot reach')
  assert.ok(subjects.includes('merge feat/pictures'))
  assert.equal(subjects.at(-1), 'root: the first commit')
  assert.equal(page.hasMore, false)

  const head = page.commits.find((entry) => entry.refs.some((ref) => ref.startsWith('HEAD -> ')))
  assert.ok(head, 'HEAD decorates the current branch tip')
  assert.ok(head.refs.includes('tag: lightweight'))
  const merge = page.commits.find((entry) => entry.subject === 'merge feat/pictures')
  assert.equal(merge?.parents.length, 2)
  assert.equal(merge?.author, 'Ada')
  assert.equal(merge?.authorEmail, 'ada@x')
  assert.ok((merge?.committedAt ?? 0) > 0)
})

test('log pages, and says when history continues', async () => {
  const dir = await repo()
  const first = await log(dir, { limit: 2 })
  assert.equal(first.commits.length, 2)
  assert.equal(first.hasMore, true)
  const second = await log(dir, { limit: 2, skip: 2 })
  assert.equal(second.commits[0]?.sha === first.commits[0]?.sha, false)
  const far = await log(dir, { skip: 999 })
  assert.deepEqual(far, { commits: [], hasMore: false })
})

test('scope=head hides what HEAD cannot reach; scope=all shows every branch', async () => {
  const dir = await repo()
  const all = await log(dir, { scope: 'all' })
  const head = await log(dir, { scope: 'head' })
  const lonely = (page: { commits: readonly { subject: string }[] }): boolean =>
    page.commits.some((entry) => entry.subject.startsWith('unmerged:'))
  assert.equal(lonely(all), true)
  assert.equal(lonely(head), false)
})

test('search: message is a case-insensitive fixed string', async () => {
  const dir = await repo()
  const hit = await log(dir, { query: 'BINARY LANDS', search: 'message' })
  assert.equal(hit.commits.length, 1)
  // A regex metacharacter matches itself or nothing — never everything.
  const dot = await log(dir, { query: '.*', search: 'message' })
  assert.equal(dot.commits.length, 0)
  const literal = await log(dir, { query: 'b.txt', search: 'message' })
  assert.equal(literal.commits.length, 2)
})

test('search: author, sha prefix, and touched file', async () => {
  const dir = await repo()
  assert.ok((await log(dir, { query: 'ada', search: 'author' })).commits.length > 0)
  assert.equal((await log(dir, { query: 'nobody', search: 'author' })).commits.length, 0)

  const merge = await sha(dir, 'main~1')
  const bySha = await log(dir, { query: merge.slice(0, 7), search: 'sha' })
  assert.equal(bySha.commits.length, 1)
  assert.equal(bySha.commits[0]?.sha, merge)
  assert.deepEqual(await log(dir, { query: 'not-a-sha', search: 'sha' }), { commits: [], hasMore: false })

  const byFile = await log(dir, { query: 'B.TXT', search: 'file' })
  const subjects = byFile.commits.map((entry) => entry.subject)
  assert.ok(subjects.some((entry) => entry.startsWith('second:')))
  assert.ok(subjects.some((entry) => entry.startsWith('rename:')))
})

test('search: file treats glob characters as characters', async () => {
  const dir = await tempDir()
  await git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'a1.txt'), 'x\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'digit file')
  await writeFile(join(dir, 'a[1].txt'), 'y\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'bracketed file')

  // Unescaped, `[1]` is a character class and would match both files.
  const bracket = await log(dir, { query: '[1]', search: 'file' })
  assert.deepEqual(
    bracket.commits.map((entry) => entry.subject),
    ['bracketed file'],
  )
  // And a bare star would match every path in every commit.
  const star = await log(dir, { query: '*', search: 'file' })
  assert.equal(star.commits.length, 0)
})

test('a broken read throws instead of rendering an empty history', async () => {
  // `-C` into a regular file is an operational failure, not one of git's
  // gentle refusals — an empty page here would be a lie about the repository.
  const dir = await tempDir()
  const file = join(dir, 'not-a-directory')
  await writeFile(file, 'x\n')
  await assert.rejects(log(file))
  await assert.rejects(refs(file))
})

test('refs: branches with tracking, remotes without origin/HEAD, peeled tags, stashes', async () => {
  const dir = await repo()
  const summary = await refs(dir)
  assert.ok(summary)
  assert.equal(summary.branch, 'main')
  assert.equal(summary.headSha, await sha(dir, 'main'))

  const main = summary.branches.find((entry) => entry.name === 'main')
  assert.ok(main)
  assert.equal(main.current, true)
  assert.equal(main.upstream, 'origin/main')
  // Ahead counts everything reachable: the merge, the rename, and the side
  // branch's own commit the merge carried in.
  assert.equal(main.ahead, 3)
  assert.equal(main.behind, 0)
  assert.ok(summary.branches.some((entry) => entry.name === 'feat/pictures' && !entry.current))

  assert.deepEqual(
    summary.remotes.map((entry) => `${entry.remote}/${entry.name}`),
    ['origin/main'],
  )

  const annotated = summary.tags.find((entry) => entry.name === 'v1')
  assert.equal(annotated?.sha, await sha(dir, 'main~1'), 'an annotated tag peels to its commit')
  assert.ok(summary.tags.some((entry) => entry.name === 'lightweight'))

  assert.equal(summary.stashes.length, 1)
  assert.match(summary.stashes[0]!.message, /work in flight/)
  assert.match(summary.stashes[0]!.ref, /^stash@\{0\}$/)
})

test('a folder outside git: refs says so, log stays an empty page', async () => {
  const dir = await tempDir()
  assert.equal(await refs(dir), null)
  assert.deepEqual(await log(dir), { commits: [], hasMore: false })
})

test('a repository before its first commit: the branch is known, history is empty', async () => {
  const dir = await tempDir()
  await git(dir, 'init', '-q', '-b', 'main')
  const summary = await refs(dir)
  assert.ok(summary)
  assert.equal(summary.branch, 'main')
  assert.equal(summary.headSha, null)
  assert.deepEqual(await log(dir), { commits: [], hasMore: false })
})

test('commit: full message, both identities, files with counts', async () => {
  const dir = await repo()
  const second = await commit(dir, await sha(dir, 'main~2'))
  assert.equal(second.message, 'second: grows a.txt and adds b.txt')
  assert.equal(second.author, 'Ada')
  assert.equal(second.committer, 'Ada')
  assert.equal(second.parents.length, 1)
  assert.deepEqual(
    second.files.map((file) => [file.path, file.status, file.added, file.removed]),
    [
      ['a.txt', 'modified', 1, 0],
      ['b.txt', 'added', 1, 0],
    ],
  )
})

test('commit: a merge reads against its first parent, a root against nothing', async () => {
  const dir = await repo()
  const merge = await commit(dir, await sha(dir, 'main~1'))
  // Against the first parent, landing the merge added exactly the branch's file.
  assert.deepEqual(
    merge.files.map((file) => [file.path, file.status]),
    [['pic.bin', 'added']],
  )
  assert.equal(merge.files[0]?.added, null, 'binary counts are null, not zero')

  const root = await commit(dir, await sha(dir, 'main~3'))
  assert.deepEqual(
    root.files.map((file) => [file.path, file.status, file.added]),
    [['a.txt', 'added', 2]],
  )
})

test('commit: a rename carries both paths', async () => {
  const dir = await repo()
  const rename = await commit(dir, await sha(dir, 'main'))
  const moved = rename.files.find((file) => file.status === 'renamed')
  assert.equal(moved?.path, 'renamed.txt')
  assert.equal(moved?.oldPath, 'b.txt')
})

test('commitDiff: one file at one commit, merges against the first parent', async () => {
  const dir = await repo()
  const patch = await commitDiff(dir, await sha(dir, 'main~2'), 'a.txt')
  assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt/m)
  assert.match(patch, /\+three/)
  assert.equal(patch.includes('b.txt'), false)

  const mergePatch = await commitDiff(dir, await sha(dir, 'main~1'), 'pic.bin')
  assert.match(mergePatch, /Binary files .* differ/)

  await assert.rejects(commitDiff(dir, '--not-a-sha', 'a.txt'))
})

test('createBranch: lands at the commit, refuses bad names and bad ids', async () => {
  const dir = await repo()
  const at = await sha(dir, 'main~2')
  await createBranch(dir, 'from-history', at)
  assert.equal(await sha(dir, 'from-history'), at)
  await assert.rejects(createBranch(dir, '-oops', at))
  await assert.rejects(createBranch(dir, 'twice..dotted', at))
  await assert.rejects(createBranch(dir, 'fine', 'HEAD'))
})

test('a repository that names its commits in SHA-256 opens them', async (t) => {
  // #67: the id check stopped at 40 characters, a SHA-1's length.
  const dir = await tempDir()
  // Git makes SHA-256 repositories from 2.29; an older one has nothing to test here.
  const made = await git(dir, 'init', '-q', '--object-format=sha256', '-b', 'main').then(() => true, () => false)
  if (!made) return t.skip('this git cannot make a SHA-256 repository')
  await writeFile(join(dir, 'a.txt'), 'a\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'one')
  const head = await sha(dir, 'HEAD')
  assert.equal(head.length, 64, 'the control: this repository really is SHA-256')
  assert.equal((await commit(dir, head)).sha, head)
  assert.match(await commitDiff(dir, head, 'a.txt'), /^\+a$/m)
  // And a commit after it, read against its 64-character parent.
  await writeFile(join(dir, 'a.txt'), 'a\nb\n')
  await git(dir, 'commit', '-qam', 'two')
  const next = await sha(dir, 'HEAD')
  assert.equal((await commit(dir, next)).parents[0], head)
  assert.match(await commitDiff(dir, next, 'a.txt'), /^\+b$/m)
  // Review of #150: and a branch made at a 64-character id.
  await createBranch(dir, 'from-256', head)
  assert.equal(await sha(dir, 'from-256'), head)
})

test('a renamed file opens as the rename it was, not as a file added from nothing', async () => {
  // #68: only the new path was in the pathspec, so git had nothing to pair it with.
  const dir = await tempDir()
  await git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'old.txt'), 'one\ntwo\nthree\nfour\nfive\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'one')
  await git(dir, 'mv', 'old.txt', 'new.txt')
  await writeFile(join(dir, 'new.txt'), 'one\ntwo\nthree\nfour\nFIVE\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'rename, with one line changed')
  const head = await sha(dir, 'HEAD')
  const listedAs = (await commit(dir, head)).files.find((file) => file.path === 'new.txt')
  assert.equal(listedAs?.oldPath, 'old.txt', 'the control: the file list calls it a rename')

  const patch = await commitDiff(dir, head, 'new.txt')
  assert.match(patch, /^rename from old\.txt$/m)
  assert.match(patch, /^rename to new\.txt$/m)
  assert.doesNotMatch(patch, /^new file mode/m)
  assert.deepEqual(patch.split('\n').filter((line) => /^[+-](?![+-])/.test(line)), ['-five', '+FIVE'])
})

test('a branch whose upstream was deleted says so, rather than reading as level', async () => {
  // #98: `[gone]` parsed as zero ahead and zero behind.
  const remote = await tempDir()
  await git(remote, 'init', '-q', '--bare', '-b', 'main')
  const dir = await tempDir()
  await git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'a.txt'), 'a\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'one')
  await git(dir, 'remote', 'add', 'origin', remote)
  await git(dir, 'push', '-q', '-u', 'origin', 'main')
  await git(dir, 'checkout', '-qb', 'feat/merged')
  await git(dir, 'push', '-q', '-u', 'origin', 'feat/merged')
  await git(remote, 'branch', '-D', 'feat/merged')
  await git(dir, 'fetch', '-q', '--prune')

  const branches = (await refs(dir))?.branches ?? []
  const named = (name: string) => branches.find((branch) => branch.name === name)
  assert.equal(named('feat/merged')?.upstream, 'origin/feat/merged')
  assert.equal(named('feat/merged')?.gone, true)
  assert.equal(named('main')?.gone, false, 'the control: level with a remote branch that exists')
})

test('a copied file opens as itself, without the edits made to its source', async () => {
  // Round 1 of #150: a copy's source was paired into the pathspec like a
  // rename's, and brought its own changes into the copy's patch.
  const dir = await tempDir()
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'config', 'diff.renames', 'copies')
  await writeFile(join(dir, 'old.txt'), 'one\ntwo\nthree\nfour\nfive\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'one')
  await writeFile(join(dir, 'new.txt'), 'one\ntwo\nthree\nfour\nfive\n')
  await writeFile(join(dir, 'old.txt'), 'one\ntwo\nthree\nfour\nFIVE\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'copy it, and edit the source')
  const head = await sha(dir, 'HEAD')
  const listedAs = (await commit(dir, head)).files.find((file) => file.path === 'new.txt')
  assert.equal(listedAs?.oldPath, 'old.txt', 'the control: git lists it as a copy')

  const patch = await commitDiff(dir, head, 'new.txt')
  assert.match(patch, /new\.txt/)
  assert.doesNotMatch(patch, /FIVE/, "the source's edit is not in the copy's patch")
})

/**
 * A `git` on PATH that writes each call to a log and hands it to the real one.
 * With `old`, it answers the object-format question the way a git before 2.29
 * does, by echoing the flag back. The count it returns is of the calls holding
 * `words`.
 */
const loggedGit = async (t: TestContext, old: boolean): Promise<(words: string) => Promise<number>> => {
  const real = (await promisify(execFile)('sh', ['-c', 'command -v git'])).stdout.trim()
  const dir = await mkdtemp(join(tmpdir(), 'hd-logged-git-'))
  const log = join(dir, 'calls.log')
  const echo = old ? `if [ "$3" = rev-parse ] && [ "$4" = --show-object-format ]; then echo --show-object-format; exit 0; fi\n` : ''
  await writeFile(join(dir, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\n${echo}exec '${real}' "$@"\n`, { mode: 0o755 })
  const was = process.env['PATH']
  process.env['PATH'] = `${dir}:${was ?? ''}`
  t.after(async () => {
    if (was === undefined) delete process.env['PATH']
    else process.env['PATH'] = was
    await rm(dir, { recursive: true, force: true })
  })
  return async (words) => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line.includes(words)).length
}

test("a repository's object format is asked once, and a git that doesn't know the question reads as SHA-1 (review of #150)", async (t) => {
  const dir = await tempDir()
  await git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'a.txt'), 'a\n')
  await writeFile(join(dir, 'b.txt'), 'b\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'one')
  const head = await sha(dir, 'HEAD')
  const calls = await loggedGit(t, true)
  // Two files of a root commit, each read against the empty tree, before the commit itself is opened.
  assert.match(await commitDiff(dir, head, 'a.txt'), /^\+a$/m)
  assert.match(await commitDiff(dir, head, 'b.txt'), /^\+b$/m)
  assert.equal(await calls('rev-parse --show-object-format'), 1, 'asked once for the repository')
})

test("the files of an opened commit reuse its own list rather than asking for it again (review of #150)", async (t) => {
  const dir = await tempDir()
  await git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'a.txt'), 'a\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'one')
  await writeFile(join(dir, 'a.txt'), 'a\nb\n')
  await writeFile(join(dir, 'c.txt'), 'c\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'two')
  const head = await sha(dir, 'HEAD')
  const calls = await loggedGit(t, false)
  assert.equal((await commit(dir, head)).files.length, 2)
  assert.match(await commitDiff(dir, head, 'a.txt'), /^\+b$/m)
  assert.match(await commitDiff(dir, head, 'c.txt'), /^\+c$/m)
  assert.equal(await calls('diff --name-status'), 1, "the commit's own list, reused by each file it opens")
})

test('a branch whose local upstream was deleted reads as gone too (review of #150)', async () => {
  const dir = await tempDir()
  await git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'a.txt'), 'a\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'one')
  await git(dir, 'branch', 'base')
  await git(dir, 'branch', '--track', 'topic', 'base')
  await git(dir, 'branch', '-D', 'base')
  const branches = (await refs(dir))?.branches ?? []
  const named = (name: string) => branches.find((branch) => branch.name === name)
  assert.equal(named('topic')?.gone, true)
  assert.equal(named('main')?.gone, false, 'the control: no upstream, nothing gone')
})
