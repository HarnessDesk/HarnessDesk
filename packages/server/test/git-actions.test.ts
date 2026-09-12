import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'

import {
  checkoutCommit,
  cherryPick,
  commitAll,
  createTag,
  deleteBranch,
  deleteTag,
  diffRange,
  fetch,
  merge,
  patch,
  pull,
  pullRequestUrl,
  push,
  rebase,
  renameBranch,
  reset,
  revertCommit,
  stashApply,
  stashDrop,
  stashSave,
} from '../src/git-actions.js'
import { status } from '../src/git.js'

/**
 * The write verbs against real repositories, one small repository per
 * property. The properties held are the module's own promises: partial
 * commits take exactly the named files, network verbs work against a local
 * bare remote and a first push sets upstream, a conflicted merge *stays*
 * with its files named while a conflicted rebase *aborts* leaving nothing,
 * hard reset erases and soft keeps, refusals arrive in words rather than
 * git's stderr, and a stash entry survives a conflicted apply.
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
  const dir = await mkdtemp(join(tmpdir(), 'hd-git-actions-'))
  scratch.push(dir)
  return dir
}

/** A one-commit repository on `main`, the floor every test builds on. */
const seedRepo = async (): Promise<string> => {
  const dir = await tempDir()
  await git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'root')
  return dir
}

/** A bare origin with one clone attached, for the network verbs. */
const seedRemote = async (): Promise<{ origin: string; work: string }> => {
  const origin = await tempDir()
  await git(origin, 'init', '-q', '--bare', '-b', 'main')
  const parent = await tempDir()
  const work = join(parent, 'work')
  await run('git', ['clone', '-q', origin, work], { env })
  await writeFile(join(work, 'a.txt'), 'one\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-qm', 'root')
  await git(work, 'push', '-qu', 'origin', 'main')
  return { origin, work }
}

// ------------------------------------------------------------------- commit

test('commitAll with paths commits exactly those files, untracked included', async () => {
  const dir = await seedRepo()
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(dir, 'new.txt'), 'fresh\n')
  await writeFile(join(dir, 'left-out.txt'), 'later\n')

  const { sha: committed } = await commitAll(dir, 'partial: a and new', ['a.txt', 'new.txt'])
  assert.equal(committed, await sha(dir, 'HEAD'))

  const shown = await git(dir, 'show', '--name-only', '--format=%s', 'HEAD')
  assert.ok(shown.includes('partial: a and new'))
  assert.ok(shown.includes('a.txt'))
  assert.ok(shown.includes('new.txt'))
  assert.ok(!shown.includes('left-out.txt'))
  // The file left out is still waiting, untracked.
  const status = await git(dir, 'status', '--porcelain')
  assert.ok(status.includes('left-out.txt'))
})

test('commitAll without paths takes everything, and an empty tree refuses in words', async () => {
  const dir = await seedRepo()
  await writeFile(join(dir, 'b.txt'), 'b\n')
  await commitAll(dir, 'everything')
  assert.equal((await git(dir, 'status', '--porcelain')).trim(), '')

  await assert.rejects(commitAll(dir, 'nothing here'), /Could not commit/)
  await assert.rejects(commitAll(dir, '   '), /needs a message/)
})

test('commitAll refuses an explicitly empty selection instead of widening to everything', async () => {
  const dir = await seedRepo()
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nedited\n')
  await assert.rejects(commitAll(dir, 'empty selection', []), /No files were chosen/)
  // Nothing moved: the edit is still waiting, uncommitted.
  assert.match(await git(dir, 'status', '--porcelain'), /a\.txt/)
})

/**
 * A repository mid-merge with its conflict resolved and staged — the state a
 * person is in when they press Commit — and an `AD` path beside it: added to
 * the index, then deleted from the working tree.
 */
const repoConcludingAMerge = async (): Promise<string> => {
  const dir = await seedRepo()
  await git(dir, 'checkout', '-qb', 'side')
  await writeFile(join(dir, 'a.txt'), 'side\n')
  await git(dir, 'commit', '-qam', 'side')
  await git(dir, 'checkout', '-q', 'main')
  await writeFile(join(dir, 'a.txt'), 'main\n')
  await git(dir, 'commit', '-qam', 'main')
  await git(dir, 'merge', 'side').catch(() => {})
  await writeFile(join(dir, 'a.txt'), 'settled\n')
  await git(dir, 'add', 'a.txt')
  await writeFile(join(dir, 'ghost.txt'), 'x\n')
  await git(dir, 'add', 'ghost.txt')
  await rm(join(dir, 'ghost.txt'))
  return dir
}

test('status names what a commit here would conclude, and nothing when it would not (#248)', async () => {
  const plain = await seedRepo()
  assert.equal((await status(plain))?.concluding, null)

  assert.equal((await status(await repoConcludingAMerge()))?.concluding, 'merge')

  // A cherry-pick that conflicts: `CHERRY_PICK_HEAD`, and git refuses a
  // partial commit here too — "cannot do a partial commit during a cherry-pick".
  const picking = await seedRepo()
  await git(picking, 'checkout', '-qb', 'side')
  await writeFile(join(picking, 'a.txt'), 'side\n')
  await git(picking, 'commit', '-qam', 'side')
  await git(picking, 'checkout', '-q', 'main')
  await writeFile(join(picking, 'a.txt'), 'main\n')
  await git(picking, 'commit', '-qam', 'main')
  await git(picking, 'cherry-pick', 'side').catch(() => {})
  assert.equal((await status(picking))?.concluding, 'cherry-pick')

  /* A revert, which git would let a partial commit through — it never reads
     `REVERT_HEAD` — and which is reported all the same, because that commit
     clears the pseudo-ref and claims the whole revert while holding part. */
  const reverting = await seedRepo()
  await writeFile(join(reverting, 'a.txt'), 'second\n')
  await git(reverting, 'commit', '-qam', 'second')
  await git(reverting, 'revert', '--no-commit', 'HEAD')
  assert.equal((await status(reverting))?.concluding, 'revert')
})

test('a conclusion inside a linked worktree is found where git keeps it (#248)', async () => {
  const dir = await seedRepo()
  await git(dir, 'checkout', '-qb', 'side')
  await writeFile(join(dir, 'a.txt'), 'side\n')
  await git(dir, 'commit', '-qam', 'side')
  await git(dir, 'checkout', '-q', 'main')
  await writeFile(join(dir, 'a.txt'), 'main\n')
  await git(dir, 'commit', '-qam', 'main')

  const linked = join(await tempDir(), 'linked')
  await git(dir, 'worktree', 'add', '-q', '-b', 'work', linked, 'main')
  await git(linked, 'merge', 'side').catch(() => {})

  /* `.git` here is a *file*, and the merge's pseudo-ref lives under the main
     repository's `worktrees/<name>/` — so a check that opened
     `<root>/.git/MERGE_HEAD` would report an ordinary commit and send
     pathspecs into a merge. */
  assert.match(await readFile(join(linked, '.git'), 'utf8'), /^gitdir:/)
  assert.equal((await status(linked))?.concluding, 'merge')
})

test('a commit cannot be narrowed while a merge is being concluded (#248)', async () => {
  const dir = await repoConcludingAMerge()

  // The control, and the measurement the refusal stands on: git's own answer
  // to the shape the dialog used to send once an `AD` path was in the tree.
  await assert.rejects(
    run('git', ['-C', dir, 'commit', '-m', 'partial', '--', 'a.txt'], { env }),
    /cannot do a partial commit during a merge/,
  )
  await assert.rejects(commitAll(dir, 'partial', ['a.txt']), /cannot be narrowed to some files/)
  // Refused, not half-done: the merge is still there to conclude.
  assert.equal((await status(dir))?.concluding, 'merge')

  // The shape that concludes it, which is the one the dialog now sends.
  await commitAll(dir, 'settle the merge')
  assert.equal((await status(dir))?.concluding, null)
  assert.equal((await git(dir, 'rev-parse', 'HEAD^@')).trim().split('\n').length, 2)
})

test('a partial commit of a rename carries both of its paths', async () => {
  const dir = await seedRepo()
  await git(dir, 'mv', 'a.txt', 'moved.txt')
  await writeFile(join(dir, 'bystander.txt'), 'left out\n')

  await commitAll(dir, 'partial: the rename alone', ['moved.txt'])

  // Both sides landed in the one commit — a rename, not a copy.
  const shown = await git(dir, 'show', '--name-status', '--no-renames', '--format=', 'HEAD')
  assert.match(shown, /A\tmoved\.txt/)
  assert.match(shown, /D\ta\.txt/)
  // Nothing of the old path lingers staged, and the bystander stayed out.
  const status = await git(dir, 'status', '--porcelain')
  assert.ok(!status.includes('a.txt'), `a.txt still in status:\n${status}`)
  assert.ok(status.includes('bystander.txt'))
})

// ------------------------------------------------------------ pull and push

test('push sets upstream on the first push and counts commits after', async () => {
  const { work } = await seedRemote()
  await git(work, 'checkout', '-qb', 'feature')
  await writeFile(join(work, 'f.txt'), 'feature\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-qm', 'feature work')

  const first = await push(work)
  assert.match(first.summary, /Pushed feature to origin and set it to track origin\/feature/)

  await writeFile(join(work, 'f.txt'), 'feature more\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-qm', 'more feature work')
  const second = await push(work)
  assert.match(second.summary, /Pushed 1 commit to origin\/feature/)
})

test('pull brings a clean fast-forward down, and fetch reads the remote', async () => {
  const { origin, work } = await seedRemote()
  // A second clone advances the shared history.
  const parent = await tempDir()
  const other = join(parent, 'other')
  await run('git', ['clone', '-q', origin, other], { env })
  await writeFile(join(other, 'a.txt'), 'one\ntwo\n')
  await git(other, 'add', '.')
  await git(other, 'commit', '-qm', 'from the other clone')
  await git(other, 'push', '-q')

  const fetched = await fetch(work)
  assert.match(fetched.summary, /Fetched origin/)

  const pulled = await pull(work)
  assert.match(pulled.summary, /Pulled 1 commit/)
  assert.deepEqual(pulled.conflicts, [])

  const again = await pull(work)
  assert.equal(again.summary, 'Already up to date.')
})

test('a conflicted pull stays in the tree with its files named', async () => {
  const { origin, work } = await seedRemote()
  const parent = await tempDir()
  const other = join(parent, 'other')
  await run('git', ['clone', '-q', origin, other], { env })
  await writeFile(join(other, 'a.txt'), 'theirs\n')
  await git(other, 'add', '.')
  await git(other, 'commit', '-qm', 'their line')
  await git(other, 'push', '-q')

  await writeFile(join(work, 'a.txt'), 'ours\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-qm', 'our line')

  const outcome = await pull(work)
  assert.deepEqual(outcome.conflicts, ['a.txt'])
  assert.match(outcome.summary, /1 conflict/)
  const content = await readFile(join(work, 'a.txt'), 'utf8')
  assert.ok(content.includes('<<<<<<<'))
})

// --------------------------------------------------------- merge and rebase

test('merge concludes cleanly or stays with named conflicts', async () => {
  const dir = await seedRepo()
  await git(dir, 'checkout', '-qb', 'side')
  await writeFile(join(dir, 'side.txt'), 'side\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'side work')
  await git(dir, 'checkout', '-q', 'main')

  const clean = await merge(dir, 'side')
  assert.match(clean.summary, /Merged side/)
  assert.deepEqual(clean.conflicts, [])

  // Now a real conflict: both branches rewrite the same line.
  await git(dir, 'checkout', '-qb', 'clash', 'HEAD~1')
  await writeFile(join(dir, 'a.txt'), 'clash\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'clash line')
  await git(dir, 'checkout', '-q', 'main')
  await writeFile(join(dir, 'a.txt'), 'main line\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'main line')

  const conflicted = await merge(dir, 'clash')
  assert.deepEqual(conflicted.conflicts, ['a.txt'])
  // The merge is in progress, concluded by a commit — exactly what commitAll
  // without paths does.
  await writeFile(join(dir, 'a.txt'), 'settled\n')
  await commitAll(dir, 'settle the merge')
  assert.equal((await git(dir, 'status', '--porcelain')).trim(), '')
})

test('a conflicted rebase aborts itself and leaves nothing changed', async () => {
  const dir = await seedRepo()
  await git(dir, 'checkout', '-qb', 'topic')
  await writeFile(join(dir, 'a.txt'), 'topic\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'topic line')
  await git(dir, 'checkout', '-q', 'main')
  await writeFile(join(dir, 'a.txt'), 'mainline\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'main moves')
  await git(dir, 'checkout', '-q', 'topic')

  const before = await sha(dir, 'topic')
  await assert.rejects(rebase(dir, 'main'), (error: Error) => {
    assert.match(error.message, /aborted; nothing changed/)
    // The abort is what makes the verb safe and also what destroys the
    // evidence, so the files are read before it runs and named after.
    assert.match(error.message, /The file that clashed: a\.txt\./)
    // git draws progress over its own line — `Rebasing (1\/1)\rerror: …` —
    // so a reason parsed line-first falls back to the exec's own words and
    // reports the command instead of the failure.
    assert.match(error.message, /could not apply/)
    assert.doesNotMatch(error.message, /Command failed/)
    return true
  })
  assert.equal(await sha(dir, 'topic'), before)
  assert.equal((await git(dir, 'status', '--porcelain')).trim(), '')

  // And a clean rebase goes through.
  const cleanDir = await seedRepo()
  await git(cleanDir, 'checkout', '-qb', 'quiet')
  await writeFile(join(cleanDir, 'quiet.txt'), 'quiet\n')
  await git(cleanDir, 'add', '.')
  await git(cleanDir, 'commit', '-qm', 'quiet work')
  await git(cleanDir, 'checkout', '-q', 'main')
  await writeFile(join(cleanDir, 'other.txt'), 'other\n')
  await git(cleanDir, 'add', '.')
  await git(cleanDir, 'commit', '-qm', 'main other')
  await git(cleanDir, 'checkout', '-q', 'quiet')
  const done = await rebase(cleanDir, 'main')
  assert.match(done.summary, /Rebased onto main/)
})

// ------------------------------------------------- revert and cherry-pick

test('revert makes the undoing commit; cherry-pick refuses merges and takes others', async () => {
  const dir = await seedRepo()
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'grow a.txt')

  const grown = await sha(dir, 'HEAD')
  const undone = await revertCommit(dir, grown)
  assert.match(undone.summary, /Reverted/)
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\n')

  // A commit on a side branch cherry-picks onto main.
  await git(dir, 'checkout', '-qb', 'donor', 'HEAD~2')
  await writeFile(join(dir, 'donated.txt'), 'gift\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'the donated commit')
  const donated = await sha(dir, 'HEAD')
  await git(dir, 'checkout', '-q', 'main')
  const picked = await cherryPick(dir, donated)
  assert.match(picked.summary, /Cherry-picked/)
  assert.equal(await readFile(join(dir, 'donated.txt'), 'utf8'), 'gift\n')

  // A merge commit is refused with advice, not attempted.
  await git(dir, 'checkout', '-qb', 'wing', 'HEAD~1')
  await writeFile(join(dir, 'wing.txt'), 'wing\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'wing work')
  await git(dir, 'checkout', '-q', 'main')
  await git(dir, 'merge', '-q', '--no-ff', '-m', 'merge wing', 'wing')
  await assert.rejects(cherryPick(dir, await sha(dir, 'HEAD')), /merge commit/)
})

// -------------------------------------------------------------------- reset

test('reset soft keeps the work staged; hard erases it', async () => {
  const dir = await seedRepo()
  const root = await sha(dir, 'HEAD')
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'second')

  await reset(dir, root, 'soft')
  assert.equal(await sha(dir, 'HEAD'), root)
  const staged = await git(dir, 'diff', '--cached', '--name-only')
  assert.ok(staged.includes('a.txt'))

  await git(dir, 'commit', '-qm', 'second again')
  await reset(dir, root, 'hard')
  assert.equal(await sha(dir, 'HEAD'), root)
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\n')
  assert.equal((await git(dir, 'status', '--porcelain')).trim(), '')

  await assert.rejects(reset(dir, root, 'onto-the-floor' as never), /not a reset mode/)
})

// ----------------------------------------------------------------- branches

test('branches rename, refuse deleting the checked-out or unmerged, and force through', async () => {
  const dir = await seedRepo()
  await git(dir, 'branch', 'old-name')
  await renameBranch(dir, 'old-name', 'new-name')
  const branches = await git(dir, 'branch', '--list')
  assert.ok(branches.includes('new-name'))
  assert.ok(!branches.includes('old-name'))

  await assert.rejects(deleteBranch(dir, 'main'), /checked out/)

  // Unmerged work refuses plainly, then goes when forced.
  await git(dir, 'checkout', '-qb', 'risky')
  await writeFile(join(dir, 'risk.txt'), 'risk\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'unmerged risk')
  await git(dir, 'checkout', '-q', 'main')
  await assert.rejects(deleteBranch(dir, 'risky'), /Could not delete risky/)
  await deleteBranch(dir, 'risky', true)
  assert.ok(!(await git(dir, 'branch', '--list')).includes('risky'))

  await deleteBranch(dir, 'new-name')
})

// --------------------------------------------------------------------- tags

test('tags are lightweight or annotated by the message, and delete by name', async () => {
  const dir = await seedRepo()
  const head = await sha(dir, 'HEAD')
  await createTag(dir, 'light', head)
  await createTag(dir, 'v1.0', head, 'the first release')

  assert.equal((await git(dir, 'cat-file', '-t', 'light')).trim(), 'commit')
  assert.equal((await git(dir, 'cat-file', '-t', 'v1.0')).trim(), 'tag')

  await assert.rejects(createTag(dir, 'no spaces allowed', head), /not a usable tag name/)
  await deleteTag(dir, 'light')
  assert.ok(!(await git(dir, 'tag', '--list')).includes('light'))
})

// ------------------------------------------------------------------ stashes

test('stashes save with untracked files, apply, pop, and drop', async () => {
  const dir = await seedRepo()
  await assert.rejects(stashSave(dir), /nothing to stash/)

  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nchanged\n')
  await writeFile(join(dir, 'loose.txt'), 'untracked\n')
  await stashSave(dir, 'the work in flight')
  assert.equal((await git(dir, 'status', '--porcelain')).trim(), '')

  const applied = await stashApply(dir, 'stash@{0}')
  assert.deepEqual(applied.conflicts, [])
  assert.equal(await readFile(join(dir, 'loose.txt'), 'utf8'), 'untracked\n')
  // Applied, not popped: the entry is still there to drop.
  assert.ok((await git(dir, 'stash', 'list')).includes('the work in flight'))

  await git(dir, 'checkout', '-q', '--', '.')
  await rm(join(dir, 'loose.txt'))
  const popped = await stashApply(dir, 'stash@{0}', true)
  assert.match(popped.summary, /dropped/)
  assert.equal((await git(dir, 'stash', 'list')).trim(), '')

  await stashSave(dir, 'to drop')
  await stashDrop(dir, 'stash@{0}')
  assert.equal((await git(dir, 'stash', 'list')).trim(), '')
  await assert.rejects(stashDrop(dir, 'stash@{0}'), /Could not drop/)
  await assert.rejects(stashApply(dir, '--not-a-ref'), /not a stash reference/)
})

// ---------------------------------------------------------- patch and diff

test('patch is mail-format text and diffRange compares two revisions', async () => {
  const dir = await seedRepo()
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'the patched change')

  const text = await patch(dir, await sha(dir, 'HEAD'))
  assert.ok(text.includes('Subject: [PATCH] the patched change'))
  assert.ok(text.includes('+three'))

  /* `HEAD~1`, passed as it is. This test used to make a branch called
     `marker` at `HEAD~1` and diff against that instead — a workaround for the
     very defect #28 reported, since `HEAD~1` was refused as "not a usable
     revision name". Found in review; the workaround was the evidence. */
  const diff = await diffRange(dir, 'HEAD~1', 'main')
  assert.ok(diff.includes('+three'))
  assert.equal(await diffRange(dir, 'HEAD^', 'main'), diff, 'HEAD^ names the same commit')
  await assert.rejects(diffRange(dir, 'no-such-ref', 'main'), /does not name a commit/)
})

// ------------------------------------------------------------- pull request

test('pullRequestUrl knows the forges and says null for the rest', async () => {
  const dir = await seedRepo()
  await git(dir, 'remote', 'add', 'origin', 'git@github.com:openma/harnessdesk.git')
  /* `feat/thing`, not `feat%2Fthing`. This assertion used to expect the
     escaped form and so pinned the defect: GitHub's compare route does not
     decode `%2F` back to a separator, and the page 404s or shows an empty
     diff. The branch is a path segment here and the slash is part of the
     path. */
  assert.equal(
    await pullRequestUrl(dir, 'feat/thing'),
    'https://github.com/openma/harnessdesk/compare/feat/thing?expand=1',
  )

  await git(dir, 'remote', 'set-url', 'origin', 'https://gitlab.com/openma/harnessdesk.git')
  /* A query parameter keeps full encoding — `%2F` is right here, unlike in
     GitHub's path. Pinned exactly, because a refactor that applied GitHub's
     per-segment rule to every forge would still match `merge_requests/new`.
     Raised in review, as was Bitbucket having no assertion at all. */
  assert.equal(
    await pullRequestUrl(dir, 'feat/thing'),
    'https://gitlab.com/openma/harnessdesk/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fthing',
  )

  await git(dir, 'remote', 'set-url', 'origin', 'git@bitbucket.org:openma/harnessdesk.git')
  assert.equal(
    await pullRequestUrl(dir, 'feat/thing'),
    'https://bitbucket.org/openma/harnessdesk/pull-requests/new?source=feat%2Fthing',
  )

  await git(dir, 'remote', 'set-url', 'origin', 'ssh://git@code.internal/team/repo.git')
  assert.equal(await pullRequestUrl(dir, 'feat/thing'), null)
})

test('pullRequestUrl strips embedded credentials and matches forge hosts exactly', async () => {
  const dir = await seedRepo()
  // A token in the https remote must never reach the browser's history.
  await git(dir, 'remote', 'add', 'origin', 'https://review-user:fake-secret@github.com/openma/harnessdesk.git')
  assert.equal(
    await pullRequestUrl(dir, 'feat/thing'),
    'https://github.com/openma/harnessdesk/compare/feat/thing?expand=1',
  )

  // A hostname that merely contains a forge's name is not that forge.
  await git(dir, 'remote', 'set-url', 'origin', 'https://github.com.evil.example/openma/harnessdesk.git')
  assert.equal(await pullRequestUrl(dir, 'feat/thing'), null)
  await git(dir, 'remote', 'set-url', 'origin', 'https://gitlab.internal.example/team/repo.git')
  assert.equal(await pullRequestUrl(dir, 'feat/thing'), null)
})

/**
 * A remote whose colon is a port, and one whose colon is a path.
 *
 * `ssh://git@host:22/owner/repo` is a URL and its colon introduces a port;
 * `git@host:owner/repo` is scp-like syntax and its colon separates the path.
 * One regex read both, so a remote carrying an explicit port produced
 * `https://github.com/22/owner/repo` — a pull-request link to a repository
 * nobody owns.
 */
test('an ssh remote with a port does not put the port in the path', async () => {
  const dir = await seedRepo()
  await git(dir, 'remote', 'add', 'origin', 'ssh://git@github.com:22/openma/harnessdesk.git')
  assert.equal(
    await pullRequestUrl(dir, 'main'),
    'https://github.com/openma/harnessdesk/compare/main?expand=1',
  )

  // A non-standard port is the shape a self-hosted forge actually uses.
  await git(dir, 'remote', 'set-url', 'origin', 'ssh://git@gitlab.com:2222/openma/harnessdesk.git')
  assert.match((await pullRequestUrl(dir, 'main')) ?? '', /^https:\/\/gitlab\.com\/openma\/harnessdesk\//)
})

test('the scp-like and portless ssh spellings still resolve the same way', async () => {
  // The control: both of these worked before and must go on working, because
  // they are what almost every remote actually looks like.
  const dir = await seedRepo()
  for (const remote of ['git@github.com:openma/harnessdesk.git', 'ssh://git@github.com/openma/harnessdesk.git']) {
    await git(dir, 'remote', 'remove', 'origin').catch(() => {})
    await git(dir, 'remote', 'add', 'origin', remote)
    assert.equal(
      await pullRequestUrl(dir, 'main'),
      'https://github.com/openma/harnessdesk/compare/main?expand=1',
      remote,
    )
  }
})

test('a branch segment is still escaped, even though the separator is not', async () => {
  /* Keeping the slashes must not turn off escaping: a `#` inside a segment
     would end the path and turn the rest into a fragment. A space would too,
     but git refuses a branch name containing one, so `#` is the character
     that is both legal to git and dangerous in a URL. */
  const dir = await seedRepo()
  await git(dir, 'remote', 'add', 'origin', 'git@github.com:openma/harnessdesk.git')
  await git(dir, 'branch', 'feat/a#c')
  assert.equal(
    await pullRequestUrl(dir, 'feat/a#c'),
    'https://github.com/openma/harnessdesk/compare/feat/a%23c?expand=1',
  )
})

test('an ssh remote under any user name resolves, not only git@', async () => {
  /* The old pattern required `git@`. Parsing `ssh://` as a URL takes any user,
     which is what deploy keys and self-hosted forges use — a widening, and
     pinned as one. Raised in review as correct and untested. */
  const dir = await seedRepo()
  await git(dir, 'remote', 'add', 'origin', 'ssh://deploy@github.com/openma/harnessdesk.git')
  assert.equal(await pullRequestUrl(dir, 'main'), 'https://github.com/openma/harnessdesk/compare/main?expand=1')
})

test('an ssh remote that names no repository, or cannot be parsed, has no pull-request page', async () => {
  /* `https://github.com/compare/main` is a page that does not exist — the same
     kind of wrong link #65 was about. Raised in review. */
  const dir = await seedRepo()
  await git(dir, 'remote', 'add', 'origin', 'ssh://git@github.com')
  assert.equal(await pullRequestUrl(dir, 'main'), null)
  await git(dir, 'remote', 'set-url', 'origin', 'ssh://git@github.com:22')
  assert.equal(await pullRequestUrl(dir, 'main'), null)
  // One `new URL` refuses outright, which is the catch path.
  await git(dir, 'remote', 'set-url', 'origin', 'ssh://git@[not-a-host/openma/harnessdesk.git')
  assert.equal(await pullRequestUrl(dir, 'main'), null)
})

test('the write verbs take a SHA-256 commit by its full id', async (t) => {
  // #67 let 64-character ids through one check for every verb; these are the verbs that write with one.
  const dir = await tempDir()
  const made = await git(dir, 'init', '-q', '--object-format=sha256', '-b', 'main').then(() => true, () => false)
  if (!made) return t.skip('this git cannot make a SHA-256 repository')
  await writeFile(join(dir, 'a.txt'), 'a\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'one')
  const first = await sha(dir, 'HEAD')
  await writeFile(join(dir, 'a.txt'), 'a\nb\n')
  await git(dir, 'commit', '-qam', 'two')
  const second = await sha(dir, 'HEAD')
  assert.equal(second.length, 64, 'the control: this repository really is SHA-256')

  assert.match(await patch(dir, second), /^\+b$/m)
  await createTag(dir, 'v1', first)
  assert.equal(await sha(dir, 'v1^{commit}'), first)
  assert.deepEqual((await revertCommit(dir, second)).conflicts, [])
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'a\n')
  assert.deepEqual((await cherryPick(dir, second)).conflicts, [])
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'a\nb\n')
  // Review of #150: and checking one out, detached.
  await checkoutCommit(dir, first)
  assert.equal(await sha(dir, 'HEAD'), first)
})

test('diffRange names files a/ and b/, whatever the repository\'s diff settings say (#171)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-noprefix-range-'))
  try {
    const git = (...args: string[]) => promisify(execFile)('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd: dir })
    await git('init', '-q', '-b', 'main')
    await writeFile(join(dir, 'f.txt'), 'one\n')
    await git('add', '.')
    await git('commit', '-qm', 'one')
    await writeFile(join(dir, 'f.txt'), 'two\n')
    await git('commit', '-qam', 'two')
    await git('config', 'diff.noprefix', 'true')
    const { stdout: plain } = await git('diff', 'HEAD~1', 'HEAD')
    assert.ok(!plain.includes('a/f.txt'), 'the control: the setting took')
    assert.ok((await diffRange(dir, 'HEAD~1', 'HEAD')).includes('diff --git a/f.txt b/f.txt'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
