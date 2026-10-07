import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileAtRevision } from '../src/git-history.js'
const run = promisify(execFile)
test('reads bounded prose at its immutable revision, refusing symlinks, binary and invalid inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hd-document-')); t.after(() => rm(root, { recursive: true, force: true }))
  const git = async (...args: string[]) => (await run('git', ['-C', root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'Jane Doe', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Jane Doe', GIT_COMMITTER_EMAIL: 'dev@example.com' } })).stdout.trim()
  await git('init', '-q'); await writeFile(join(root, 'answer.md'), 'first answer\n'); await writeFile(join(root, 'large.md'), 'x'.repeat(128 * 1024 + 1)); await writeFile(join(root, 'binary.md'), Buffer.from([0, 1, 2]))
  await symlink('answer.md', join(root, 'link.md'))
  await git('add', '.'); await git('commit', '-qm', 'Synthetic documents'); const revision = await git('rev-parse', 'HEAD')
  await writeFile(join(root, 'answer.md'), 'new worktree words')
  assert.deepEqual(await fileAtRevision(root, revision, 'answer.md'), { text: 'first answer\n', bytes: 13 })
  assert.equal(await fileAtRevision(root, revision, 'large.md'), null)
  assert.equal(await fileAtRevision(root, revision, 'binary.md'), null)
  assert.equal(await fileAtRevision(root, revision, 'link.md'), null)
  assert.equal(await fileAtRevision(root, revision, 'missing.md'), null)
  await assert.rejects(() => fileAtRevision(root, '--help', 'answer.md'))
  await assert.rejects(() => fileAtRevision(root, revision, '../answer.md'))
  await assert.rejects(() => fileAtRevision(root, revision, '/answer.md'))
})
