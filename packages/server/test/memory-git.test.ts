import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

test('admitMemoryRoot refuses a symlinked .git, a linked worktree, and external alternates', async () => {
  const ordinary = await repo('hd-memory-admit-ordinary-')
  assert.equal(await admitMemoryRoot(ordinary), await import('node:fs/promises').then((m) => m.realpath(ordinary)))

  const linkedDotGit = tempDir('hd-memory-admit-linked-dotgit-')
  const elsewhere = tempDir('hd-memory-admit-elsewhere-')
  await symlink(elsewhere, join(linkedDotGit, '.git'))
  await assert.rejects(admitMemoryRoot(linkedDotGit), /link/)

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
