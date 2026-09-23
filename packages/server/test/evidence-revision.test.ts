import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { diffOf, freshnessOf, projectOf, revisionOf, tipOf, upstreamTipOf } from '../src/evidence/revision.js'
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

/*
 * Work committed straight onto the default branch has no merge base behind
 * it — the branch *is* its base — so the diff is measured from where the work
 * began: the commit its Seat opened on. Without that, `{ diff: true }` could
 * never be satisfied for a step that stays on the default branch.
 */
test('work committed on the default branch is measured from the commit its step began at', async () => {
  const { dir, git } = await makeRepo()
  const began = await git('rev-parse', 'HEAD')
  // Nothing measured from nowhere: on the base branch with no starting point, there is no work to show.
  assert.equal((await diffOf(dir))?.files, 0)
  assert.equal((await diffOf(dir, began))?.files, 0, 'nothing committed since it began is no diff')
  await writeFile(join(dir, 'ANSWER.md'), 'the answer\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'answer')
  const to = await git('rev-parse', 'HEAD')
  assert.deepEqual(await diffOf(dir, began), { files: 1, added: 1, removed: 0, from: began, to })
  // A starting point history does not lead from is never trusted: it measures nothing.
  await git('checkout', '-q', '--orphan', 'elsewhere')
  await git('commit', '-q', '-m', 'unrelated')
  await git('checkout', '-q', 'main')
  const stray = await git('rev-parse', 'elsewhere')
  assert.equal((await diffOf(dir, stray))?.files, 0)
  // A branch that left its base is measured the same way: from where the card began, its own commits.
  await git('checkout', '-q', '-b', 'feature')
  await writeFile(join(dir, 'MORE.md'), 'more\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'more')
  assert.deepEqual({ from: (await diffOf(dir, began))?.from, files: (await diffOf(dir, began))?.files }, { from: began, files: 2 })
  // With no starting point, against the base it came from, as before.
  assert.equal((await diffOf(dir))?.from, await git('merge-base', 'main', 'HEAD'))
})

test('with no base branch at all, a diff is measured from the commit its step began at', async () => {
  const { dir, git } = await makeRepo()
  await git('branch', '-m', 'main', 'trunk')
  const began = await git('rev-parse', 'HEAD')
  assert.equal(await diffOf(dir), null, 'nothing to measure from')
  await writeFile(join(dir, 'ANSWER.md'), 'the answer\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'answer')
  assert.equal((await diffOf(dir, began))?.files, 1)
})

/*
 * What a step's diff counts, from the commit its card began at: the step's
 * own commits on the checkout's first-parent line. Work pulled from the
 * remote's default branch is not the step's, and a merge brings nothing of
 * its own; a Seat that took a second card is measured from that card's start.
 */
test('a diff from where a card began counts only the step’s own commits, never a pull from upstream', async () => {
  const upstream = await makeRepo('hd-evidence-up-')
  const dir = tempDir('hd-evidence-clone-')
  await run('git', ['clone', '-q', upstream.dir, dir])
  const git = async (...args: string[]): Promise<string> =>
    (await run('git', ['-C', dir, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])).stdout.trim()
  const began = await git('rev-parse', 'HEAD')
  // Someone else's work lands upstream and is pulled: nothing of the step's own.
  await writeFile(join(upstream.dir, 'THEIRS.md'), 'theirs\n')
  await upstream.git('add', '.')
  await upstream.git('commit', '-q', '-m', 'theirs')
  await git('pull', '-q', '--ff-only')
  assert.equal((await diffOf(dir, began))?.files, 0, 'a pull is not the step’s work')
  // The step's own commit counts, and only it.
  await writeFile(join(dir, 'MINE.md'), 'one\ntwo\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'mine')
  const mine = await git('rev-parse', 'HEAD')
  assert.deepEqual(await diffOf(dir, began), { files: 1, added: 2, removed: 0, from: began, to: mine })
  // A pull that merges brings nothing of its own either.
  await writeFile(join(upstream.dir, 'MORE.md'), 'more\n')
  await upstream.git('add', '.')
  await upstream.git('commit', '-q', '-m', 'more of theirs')
  await git('pull', '-q', '--no-rebase', '--no-edit')
  assert.equal((await diffOf(dir, began))?.files, 1)
  // Another line of work merged in is not the step's own either: only its first-parent line is.
  await git('checkout', '-q', '-b', 'elsewhere', began)
  await writeFile(join(dir, 'ELSEWHERE.md'), 'elsewhere\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'elsewhere')
  await git('checkout', '-q', 'main')
  await git('merge', '-q', '--no-ff', '--no-edit', 'elsewhere')
  assert.equal((await diffOf(dir, began))?.files, 1)
  // A second card, begun where the first ended, is measured from its own start.
  const second = await git('rev-parse', 'HEAD')
  assert.equal((await diffOf(dir, second))?.files, 0, 'the first card’s work is not the second’s')
  await writeFile(join(dir, 'NEXT.md'), 'next\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'next')
  assert.equal((await diffOf(dir, second))?.files, 1)
})

/*
 * A step that pushes its own commits keeps them: what tells the step's
 * commits from someone else's is how they came into the checkout — made
 * here (its own record of commits), or brought by a pull — never whether
 * the remote has them now.
 */
test('a step that pushes its own commits still has them as its diff, and a later pull still does not count', async () => {
  const upstream = await makeRepo('hd-evidence-up-')
  await upstream.git('config', 'receive.denyCurrentBranch', 'ignore')
  const dir = tempDir('hd-evidence-push-')
  await run('git', ['clone', '-q', upstream.dir, dir])
  const git = async (...args: string[]): Promise<string> =>
    (await run('git', ['-C', dir, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])).stdout.trim()
  const began = await git('rev-parse', 'HEAD')
  const tip = await upstreamTipOf(dir)
  assert.equal(tip, began, 'the remote’s copy of the base branch, as the card is taken')
  await writeFile(join(dir, 'MINE.md'), 'one\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'mine')
  await git('push', '-q', 'origin', 'main')
  assert.equal((await diffOf(dir, began, { upstream: tip }))?.files, 1, 'pushed, and still the step’s own')
  // Someone else's work, pulled after the push: not the step's.
  await upstream.git('reset', '-q', '--hard')
  await writeFile(join(upstream.dir, 'THEIRS.md'), 'theirs\n')
  await upstream.git('add', 'THEIRS.md')
  await upstream.git('commit', '-q', '-m', 'theirs')
  await git('pull', '-q', '--ff-only')
  assert.equal((await diffOf(dir, began, { upstream: tip }))?.files, 1)
  // With no record of how commits came in, the remote as it stood when the card was taken is what is set aside.
  await rm(join(dir, '.git', 'logs'), { recursive: true, force: true })
  assert.equal((await diffOf(dir, began, { upstream: tip }))?.files, 2, 'a pull cannot be told apart without that record')
})

test('the remote copy of the base branch is found by the branch’s own upstream, whatever it is called', async () => {
  const upstream = await makeRepo('hd-evidence-up-')
  await upstream.git('branch', '-m', 'main', 'trunk')
  const dir = tempDir('hd-evidence-trunk-')
  await run('git', ['clone', '-q', upstream.dir, dir])
  await run('git', ['-C', dir, 'remote', 'set-head', 'origin', '-d'])
  assert.equal(await upstreamTipOf(dir), await upstream.git('rev-parse', 'HEAD'))
})
