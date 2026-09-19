import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { diffOf, freshnessOf, projectOf, revisionOf, tipOf } from '../src/evidence/revision.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * What a fact is bound to, and how it stands later: the commit it was true
 * at, and how many commits its branch has taken since — or why nobody can say.
 */

const run = promisify(execFile)

test('a revision is the commit, the branch, and whether the tree holds changes not committed', async () => {
  const { dir, git } = await makeRepo()
  const head = await git('rev-parse', 'HEAD')
  assert.deepEqual(await revisionOf(dir), { head, branch: 'main', dirty: false })
  await writeFile(join(dir, 'new.txt'), 'x\n')
  assert.deepEqual(await revisionOf(dir), { head, branch: 'main', dirty: true })
  await git('checkout', '-q', '--detach')
  assert.equal((await revisionOf(dir))?.branch, null)
  // No commit to bind anything to: outside a repository, or before its first commit.
  assert.equal(await revisionOf(tempDir('hd-evidence-plain-')), null)
  const empty = tempDir('hd-evidence-empty-')
  await run('git', ['-C', empty, 'init', '-q'])
  assert.equal(await revisionOf(empty), null)
})

test('a fact is fresh at its branch tip, behind by the commits since, and moved when rewritten', async () => {
  const { dir, git } = await makeRepo()
  const at = await git('rev-parse', 'HEAD')
  const checkout = { cwd: dir, branch: 'main' }
  assert.deepEqual(await freshnessOf(checkout, at), { state: 'fresh' })
  for (const n of [2, 3]) {
    await writeFile(join(dir, 'README.md'), `${n}\n`)
    await git('commit', '-q', '-am', `change ${n}`)
  }
  assert.deepEqual(await freshnessOf(checkout, at), { state: 'behind', commits: 2 })
  // An amend rewrites history under the fact: it is no longer on the branch.
  const later = await git('rev-parse', 'HEAD')
  await git('commit', '-q', '--amend', '-m', 'changed again')
  assert.deepEqual(await freshnessOf(checkout, later), { state: 'moved' })
})

test('a fact that ran on uncommitted changes is stale whatever the branch does', async () => {
  const { dir, git } = await makeRepo()
  const at = await git('rev-parse', 'HEAD')
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: 'main' }, at, { dirty: true }), { state: 'uncommitted' })
})

test('unknown says why: the checkout is gone, the branch is gone, or it left the project', async () => {
  const { dir, git } = await makeRepo()
  const at = await git('rev-parse', 'HEAD')
  await git('checkout', '-q', '-b', 'work')
  await git('branch', '-q', '-D', 'main')
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: 'main' }, at), {
    state: 'unknown',
    why: 'the branch main is gone',
  })
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: 'work' }, at, { project: '/somewhere/else' }), {
    state: 'unknown',
    why: 'its checkout is no longer part of this project',
  })
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: 'work' }, at, { project: await projectOf(dir) }), { state: 'fresh' })
  await rm(dir, { recursive: true, force: true })
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: 'work' }, at), { state: 'unknown', why: 'its checkout is gone' })
})

test('a merged pull request is final only when its branch is gone; commits after the merge still leave it behind', async () => {
  const { dir, git } = await makeRepo()
  await git('checkout', '-q', '-b', 'work')
  await writeFile(join(dir, 'README.md'), 'work\n')
  await git('commit', '-q', '-am', 'the work')
  const head = await git('rev-parse', 'HEAD')
  const checkout = { cwd: dir, branch: 'work' }
  // Merged, and its branch still here and where it was: fresh, like any fact.
  assert.deepEqual(await freshnessOf(checkout, head, { merged: true }), { state: 'fresh' })
  // A commit on the branch after the merge is work the pull request never carried.
  await writeFile(join(dir, 'README.md'), 'after\n')
  await git('commit', '-q', '-am', 'after the merge')
  assert.deepEqual(await freshnessOf(checkout, head, { merged: true }), { state: 'behind', commits: 1 })
  // Its branch deleted after the merge: nothing can land on it now, so it stands as it is.
  await git('checkout', '-q', 'main')
  await git('branch', '-q', '-D', 'work')
  assert.deepEqual(await freshnessOf(checkout, head, { merged: true }), { state: 'final' })
  // Only a merged pull request is ever final: any other fact on a gone branch is unknown.
  assert.deepEqual(await freshnessOf(checkout, head), { state: 'unknown', why: 'the branch work is gone' })
  // And a detached checkout has no branch to be gone.
  assert.deepEqual(await freshnessOf({ cwd: dir, branch: null }, head, { merged: true }), { state: 'moved' })
})

test('a branch name that could be read as an option never reaches git', async () => {
  const { dir } = await makeRepo()
  assert.equal(await tipOf(dir, '--output=/tmp/x'), null)
  assert.equal(await tipOf(dir, 'a..b'), null)
})

test("a branch's diff is its committed work against the base it came from", async () => {
  const { dir, git } = await makeRepo()
  await git('checkout', '-q', '-b', 'feature')
  await writeFile(join(dir, 'README.md'), 'hello\ntwo\nthree\n')
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'b.txt'), 'b\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'work')
  const from = await git('merge-base', 'main', 'HEAD')
  const to = await git('rev-parse', 'HEAD')
  assert.deepEqual(await diffOf(dir), { files: 2, added: 3, removed: 0, from, to })
  // Uncommitted edits are not the branch's work.
  await writeFile(join(dir, 'README.md'), 'changed\n')
  assert.deepEqual(await diffOf(dir), { files: 2, added: 3, removed: 0, from, to })
})
