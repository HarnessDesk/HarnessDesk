import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import { admitMemoryRoot, listMemoryFiles, memoryPath, readMemoryBlob } from '../src/memory/git.js'
import { tempDir } from './scratch.js'

const exec = promisify(execFile)
const git = (root: string, args: string[]) => exec('git', args, { cwd: root })

/**
 * `readMemoryBlob`: a literal, bounded, no-follow reader for exactly one
 * committed revision of exactly one memory file — never the working tree,
 * never anything reached by following a link.
 */

const repo = async (prefix: string): Promise<string> => {
  const root = tempDir(prefix)
  await git(root, ['init', '-q'])
  await git(root, ['-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'config', 'commit.gpgsign', 'false'])
  return root
}

const commit = async (root: string, message: string): Promise<string> => {
  await git(root, ['add', '.'])
  await git(root, ['-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'commit', '-qm', message])
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
}

test('reads exactly the cited revision', async () => {
  const root = await repo('hd-memory-git-revision-')
  await mkdir(join(root, '.harnessdesk', 'memory'), { recursive: true })
  const file = join(root, '.harnessdesk', 'memory', 'note.md')
  await writeFile(file, 'version A\n')
  const a = await commit(root, 'A')
  await writeFile(file, 'version B\n')
  await commit(root, 'B')

  const text = await readMemoryBlob(root, a, '.harnessdesk/memory/note.md')
  assert.equal(text, 'version A\n')
})

test('rejects links at every tree level', async () => {
  // Level 1: `.harnessdesk` itself is a link.
  {
    const root = await repo('hd-memory-git-link-top-')
    const outside = join(root, 'outside')
    await mkdir(join(outside, 'memory'), { recursive: true })
    await writeFile(join(outside, 'memory', 'note.md'), 'OUTSIDE\n')
    await symlink('outside', join(root, '.harnessdesk'))
    const at = await commit(root, 'link at top')
    await assert.rejects(readMemoryBlob(root, at, '.harnessdesk/memory/note.md'), /no links/)
  }
  // Level 2: the memory directory itself is a link.
  {
    const root = await repo('hd-memory-git-link-mid-')
    const outside = join(root, 'outside-memory')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'note.md'), 'OUTSIDE\n')
    await mkdir(join(root, '.harnessdesk'), { recursive: true })
    await symlink('../outside-memory', join(root, '.harnessdesk', 'memory'))
    const at = await commit(root, 'link in middle')
    await assert.rejects(readMemoryBlob(root, at, '.harnessdesk/memory/note.md'), /no links/)
  }
  // Level 3: the file itself is a link.
  {
    const root = await repo('hd-memory-git-link-leaf-')
    await mkdir(join(root, '.harnessdesk', 'memory'), { recursive: true })
    await writeFile(join(root, 'outside.md'), 'OUTSIDE\n')
    await symlink('../../outside.md', join(root, '.harnessdesk', 'memory', 'note.md'))
    const at = await commit(root, 'link at leaf')
    await assert.rejects(readMemoryBlob(root, at, '.harnessdesk/memory/note.md'), /no links/)
  }
})

test('bounds paths bytes and decoding', async () => {
  const root = await repo('hd-memory-git-bounds-')
  await mkdir(join(root, '.harnessdesk', 'memory'), { recursive: true })
  await writeFile(join(root, 'outside.md'), 'not memory\n')
  await writeFile(join(root, '.harnessdesk', 'memory', 'note.md'), 'fine\n')
  await writeFile(join(root, '.harnessdesk', 'memory', 'huge.md'), 'x'.repeat(65537))
  const invalid = Buffer.concat([Buffer.from('bad '), Buffer.from([0xff]), Buffer.from(' bytes')])
  await writeFile(join(root, '.harnessdesk', 'memory', 'invalid.md'), invalid)
  await writeFile(join(root, '.harnessdesk', 'memory', 'nul.md'), Buffer.concat([Buffer.from('a'), Buffer.from([0]), Buffer.from('b')]))
  const at = await commit(root, 'bounds fixtures')

  await assert.rejects(readMemoryBlob(root, at, 'outside.md'), /\.harnessdesk\/memory/)
  await assert.rejects(readMemoryBlob(root, at, '.harnessdesk/memory/../../etc/passwd'), /\.harnessdesk\/memory/)
  await assert.rejects(readMemoryBlob(root, at, '.harnessdesk/memory/*.md'), /\.harnessdesk\/memory/)
  await assert.rejects(readMemoryBlob(root, 'not-a-sha', '.harnessdesk/memory/note.md'), /full commit revision/)
  await assert.rejects(readMemoryBlob(root, at, '.harnessdesk/memory/huge.md'), /.+/)
  await assert.rejects(readMemoryBlob(root, at, '.harnessdesk/memory/invalid.md'), /utf-8/i)
  await assert.rejects(readMemoryBlob(root, at, '.harnessdesk/memory/nul.md'), /NUL/)
  assert.equal(await readMemoryBlob(root, at, '.harnessdesk/memory/note.md'), 'fine\n')
})

test('memoryPath refuses everything outside the one shape memory files may have', () => {
  assert.equal(memoryPath('.harnessdesk/memory/note.md'), '.harnessdesk/memory/note.md')
  for (const bad of [
    'note.md',
    '.harnessdesk/memory/note.txt',
    '.harnessdesk/memory/../escape.md',
    '.harnessdesk/memory/UPPER.md',
    '.harnessdesk/memory/sub/note.md',
    '.harnessdesk/memory/.md',
    `.harnessdesk/memory/${'a'.repeat(65)}.md`,
  ]) {
    assert.throws(() => memoryPath(bad), /Markdown file directly inside/, bad)
  }
})

test('admitMemoryRoot refuses a symlinked .git, an unregistered worktree pointer, and external alternates', async () => {
  const ordinary = await repo('hd-memory-admit-ordinary-')
  assert.equal(await admitMemoryRoot(ordinary), await import('node:fs/promises').then((m) => m.realpath(ordinary)))

  const linkedDotGit = tempDir('hd-memory-admit-linked-dotgit-')
  const elsewhere = tempDir('hd-memory-admit-elsewhere-')
  await symlink(elsewhere, join(linkedDotGit, '.git'))
  await assert.rejects(admitMemoryRoot(linkedDotGit), /link/)

  // A `.git` file naming a worktree the repository never registered.
  const worktree = tempDir('hd-memory-admit-worktree-')
  await writeFile(join(worktree, '.git'), `gitdir: ${ordinary}/.git/worktrees/fake\n`)
  await assert.rejects(admitMemoryRoot(worktree), /linked worktree/)

  const alternates = await repo('hd-memory-admit-alternates-')
  await mkdir(join(alternates, '.git', 'objects', 'info'), { recursive: true })
  await writeFile(join(alternates, '.git', 'objects', 'info', 'alternates'), '/tmp/somewhere-else\n')
  await assert.rejects(admitMemoryRoot(alternates), /external object alternates/)
})

test('listMemoryFiles enumerates only the flat memory folder, bounded, never reading contents', async () => {
  const root = await repo('hd-memory-git-list-')
  await mkdir(join(root, '.harnessdesk', 'memory', 'nested'), { recursive: true })
  await writeFile(join(root, '.harnessdesk', 'memory', 'a.md'), 'A\n')
  await writeFile(join(root, '.harnessdesk', 'memory', 'nested', 'b.md'), 'B\n')
  await writeFile(join(root, '.harnessdesk', 'memory', 'BAD NAME.md'), 'bad\n')
  const at = await commit(root, 'list fixtures')

  const files = await listMemoryFiles(root, at)
  const byPath = new Map(files.map((one) => [one.path, one]))
  assert.equal(byPath.get('.harnessdesk/memory/a.md')?.problem, null)
  assert.match(byPath.get('.harnessdesk/memory/BAD NAME.md')?.problem ?? '', /Markdown file directly inside/)
  assert.equal(byPath.has('.harnessdesk/memory/nested'), false, 'a nested directory is not itself a listed file')
})

/** A real linked worktree of a real repository, the way an Agent lane is made. */
const laneOf = async (prefix: string): Promise<{ readonly main: string; readonly lane: string }> => {
  const main = await repo(prefix)
  await mkdir(join(main, '.harnessdesk', 'memory'), { recursive: true })
  await writeFile(join(main, '.harnessdesk', 'memory', 'decisions.md'), 'We chose the flat file.\n')
  await commit(main, 'memory')
  const lane = join(tempDir(`${prefix}lanes-`), 'lane')
  await git(main, ['worktree', 'add', '-q', lane])
  return { main, lane }
}

test('a linked worktree — an Agent lane — is admitted, and its citations read the shared history', async () => {
  const { main, lane } = await laneOf('hd-memory-admit-lane-')
  const admitted = await admitMemoryRoot(lane)
  assert.equal(admitted, await realpath(lane))
  const at = (await git(lane, ['rev-parse', 'HEAD'])).stdout.trim()
  assert.equal(await readMemoryBlob(admitted, at, '.harnessdesk/memory/decisions.md'), 'We chose the flat file.\n')
  assert.deepEqual((await listMemoryFiles(admitted, at)).map((one) => one.path), ['.harnessdesk/memory/decisions.md'])
  void main
})

test('a linked worktree is refused when any hop points outside its repository’s own common directory, or goes through a link', async () => {
  // gitdir → a directory that is not under the common directory's worktrees/.
  {
    const { main, lane } = await laneOf('hd-memory-admit-outside-')
    const elsewhere = await repo('hd-memory-admit-outside-other-')
    const gitdir = (await git(lane, ['rev-parse', '--git-dir'])).stdout.trim()
    const stray = join(elsewhere, '.git', 'worktrees', 'stray')
    await mkdir(stray, { recursive: true })
    await writeFile(join(stray, 'commondir'), '../..\n')
    await writeFile(join(stray, 'gitdir'), `${await realpath(lane)}/.git\n`)
    await writeFile(join(stray, 'HEAD'), (await readFile(join(gitdir, 'HEAD'), 'utf8')))
    await writeFile(join(lane, '.git'), `gitdir: ${await realpath(stray)}\n`)
    // Registered in *another* repository: admitted only as that one's lane, never
    // as this one — so a commondir that points back at a third repository fails.
    await writeFile(join(stray, 'commondir'), `${await realpath(main)}/.git\n`)
    await assert.rejects(admitMemoryRoot(lane), /outside|linked worktree/)
  }
  // The gitdir path goes through a link.
  {
    const { main, lane } = await laneOf('hd-memory-admit-viaLink-')
    const gitdir = (await git(lane, ['rev-parse', '--git-dir'])).stdout.trim()
    const linkRoot = tempDir('hd-memory-admit-link-')
    await symlink(join(await realpath(main), '.git'), join(linkRoot, 'git'))
    await writeFile(join(lane, '.git'), `gitdir: ${join(await realpath(linkRoot), 'git', 'worktrees', basename(gitdir))}\n`)
    await assert.rejects(admitMemoryRoot(lane), /link/)
  }
  // commondir points at another repository's metadata.
  {
    const { lane } = await laneOf('hd-memory-admit-common-')
    const other = await repo('hd-memory-admit-common-other-')
    const gitdir = await realpath((await git(lane, ['rev-parse', '--git-dir'])).stdout.trim())
    await writeFile(join(gitdir, 'commondir'), `${await realpath(other)}/.git\n`)
    await assert.rejects(admitMemoryRoot(lane), /outside/)
  }
  // The worktree's back-pointer names a different checkout: not this one's registration.
  {
    const { lane } = await laneOf('hd-memory-admit-back-')
    const gitdir = await realpath((await git(lane, ['rev-parse', '--git-dir'])).stdout.trim())
    await writeFile(join(gitdir, 'gitdir'), '/somewhere/else/.git\n')
    await assert.rejects(admitMemoryRoot(lane), /linked worktree/)
  }
  // The shared object store declares alternates.
  {
    const { main, lane } = await laneOf('hd-memory-admit-lane-alternates-')
    await mkdir(join(main, '.git', 'objects', 'info'), { recursive: true })
    await writeFile(join(main, '.git', 'objects', 'info', 'alternates'), '/tmp/somewhere-else\n')
    await assert.rejects(admitMemoryRoot(lane), /external object alternates/)
  }
})

/*
 * #895. `.git` as an ordinary folder skipped the `commondir` check a linked
 * worktree gets, and Git follows a `commondir` there too: the checkout's
 * history would be read from wherever it points.
 */
test('admitMemoryRoot refuses an ordinary .git folder that names a commondir', async () => {
  const elsewhere = await repo('hd-memory-commondir-elsewhere-')
  await mkdir(join(elsewhere, '.harnessdesk', 'memory'), { recursive: true })
  await writeFile(join(elsewhere, '.harnessdesk', 'memory', 'notes.md'), 'Not this project’s.\n')
  await commit(elsewhere, 'elsewhere')
  const project = await repo('hd-memory-commondir-')
  await writeFile(join(project, '.git', 'commondir'), `${join(elsewhere, '.git')}\n`)
  await assert.rejects(admitMemoryRoot(project), /points at another repository/)
})
