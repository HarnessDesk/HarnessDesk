import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { turnId, type AgentItem, type FileChange, type Turn } from '@harnessdesk/protocol'

import { DirtyTreeError, RevertError, checkout, listBranches, reapplyTurn, revertTurn } from '../src/git-ops.js'

/**
 * Reverting a turn and switching branches against a real repository. The
 * properties: a revert puts back exactly the agent's edits and refuses when
 * the user has touched a file since; a redo writes exactly those edits again,
 * under the same refusal; a checkout never carries uncommitted work across.
 */

const run = promisify(execFile)
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' }
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, ...args], { env })).stdout

const repo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-git-ops-'))
  await git(dir, 'init', '-q', '-b', 'main')
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(dir, 'gone.txt'), 'bye\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'init')
  return dir
}

const fileChange = (dir: string, changes: FileChange[]): AgentItem =>
  ({ id: `fc-${changes.length}`, type: 'fileChange', changes, status: 'completed', origin: 'agent' }) as unknown as AgentItem

const turnOf = (items: AgentItem[], diff?: string): Turn => ({ id: turnId('t1'), items, status: 'completed', diff: diff ?? null })

test('reverts an update, an add and a delete from the reported changes', async () => {
  const dir = await repo()
  try {
    // The agent's edits, as it reported them.
    await writeFile(join(dir, 'a.txt'), 'one\n2\nthree\n')
    await writeFile(join(dir, 'new.txt'), 'fresh\n')
    await rm(join(dir, 'gone.txt'))
    const turn = turnOf([
      fileChange(dir, [
        { path: join(dir, 'a.txt'), kind: { type: 'update' }, diff: '@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n' },
        { path: join(dir, 'new.txt'), kind: { type: 'add' }, diff: 'fresh\n' },
        { path: join(dir, 'gone.txt'), kind: { type: 'delete' }, diff: 'bye\n' },
      ]),
    ])
    const reverted = await revertTurn(dir, turn)
    assert.deepEqual(reverted.sort(), ['a.txt', 'gone.txt', 'new.txt'])
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n')
    assert.equal(await readFile(join(dir, 'gone.txt'), 'utf8'), 'bye\n')
    await assert.rejects(stat(join(dir, 'new.txt')))
    assert.equal((await git(dir, 'status', '--porcelain')).trim(), '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('uses the aggregated diff when the turn has one, all or nothing', async () => {
  const dir = await repo()
  try {
    await writeFile(join(dir, 'a.txt'), 'one\n2\nthree\n')
    await writeFile(join(dir, 'new.txt'), 'fresh\n')
    await git(dir, 'add', '-N', 'new.txt')
    const diff = await git(dir, 'diff')
    await git(dir, 'reset', '-q')
    const turn = turnOf(
      [fileChange(dir, [{ path: join(dir, 'a.txt'), kind: { type: 'update' }, diff: '' }, { path: join(dir, 'new.txt'), kind: { type: 'add' }, diff: 'fresh\n' }])],
      diff,
    )
    await revertTurn(dir, turn)
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n')
    await assert.rejects(stat(join(dir, 'new.txt')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('refuses when the user edited the file since, naming what was put back', async () => {
  const dir = await repo()
  try {
    await writeFile(join(dir, 'a.txt'), 'one\n2\nthree\n')
    await writeFile(join(dir, 'new.txt'), 'fresh, then edited by hand\n')
    const turn = turnOf([
      fileChange(dir, [
        { path: join(dir, 'new.txt'), kind: { type: 'add' }, diff: 'fresh\n' },
        { path: join(dir, 'a.txt'), kind: { type: 'update' }, diff: '@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n' },
      ]),
    ])
    await assert.rejects(revertTurn(dir, turn), (error: unknown) => {
      assert.ok(error instanceof RevertError)
      assert.match(error.message, /new\.txt has been edited since/)
      assert.deepEqual(error.reverted, ['a.txt'])
      return true
    })
    // The hand edit is untouched; the agent's update is gone.
    assert.equal(await readFile(join(dir, 'new.txt'), 'utf8'), 'fresh, then edited by hand\n')
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('redo writes the same edits again, from the reported changes', async () => {
  const dir = await repo()
  try {
    await writeFile(join(dir, 'a.txt'), 'one\n2\nthree\n')
    await writeFile(join(dir, 'new.txt'), 'fresh\n')
    await rm(join(dir, 'gone.txt'))
    const turn = turnOf([
      fileChange(dir, [
        { path: join(dir, 'a.txt'), kind: { type: 'update' }, diff: '@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n' },
        { path: join(dir, 'new.txt'), kind: { type: 'add' }, diff: 'fresh\n' },
        { path: join(dir, 'gone.txt'), kind: { type: 'delete' }, diff: 'bye\n' },
      ]),
    ])
    await revertTurn(dir, turn)
    const redone = await reapplyTurn(dir, turn)
    assert.deepEqual(redone.sort(), ['a.txt', 'gone.txt', 'new.txt'])
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\n2\nthree\n')
    assert.equal(await readFile(join(dir, 'new.txt'), 'utf8'), 'fresh\n')
    await assert.rejects(stat(join(dir, 'gone.txt')))
    // And back again: undo and redo are the same diff, either way round.
    await revertTurn(dir, turn)
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('redo uses the aggregated diff when the turn has one, all or nothing', async () => {
  const dir = await repo()
  try {
    await writeFile(join(dir, 'a.txt'), 'one\n2\nthree\n')
    await writeFile(join(dir, 'new.txt'), 'fresh\n')
    await git(dir, 'add', '-N', 'new.txt')
    const diff = await git(dir, 'diff')
    await git(dir, 'reset', '-q')
    const turn = turnOf(
      [fileChange(dir, [{ path: join(dir, 'a.txt'), kind: { type: 'update' }, diff: '' }, { path: join(dir, 'new.txt'), kind: { type: 'add' }, diff: 'fresh\n' }])],
      diff,
    )
    await revertTurn(dir, turn)
    await reapplyTurn(dir, turn)
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\n2\nthree\n')
    assert.equal(await readFile(join(dir, 'new.txt'), 'utf8'), 'fresh\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('redo refuses to overwrite what the user put in the way, naming what it wrote', async () => {
  const dir = await repo()
  try {
    await writeFile(join(dir, 'a.txt'), 'one\n2\nthree\n')
    await writeFile(join(dir, 'new.txt'), 'fresh\n')
    const turn = turnOf([
      fileChange(dir, [
        { path: join(dir, 'a.txt'), kind: { type: 'update' }, diff: '@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n' },
        { path: join(dir, 'new.txt'), kind: { type: 'add' }, diff: 'fresh\n' },
      ]),
    ])
    await revertTurn(dir, turn)
    // The user writes their own file where the agent's used to be.
    await writeFile(join(dir, 'new.txt'), 'mine now\n')
    await assert.rejects(reapplyTurn(dir, turn), (error: unknown) => {
      assert.ok(error instanceof RevertError)
      assert.match(error.message, /new\.txt exists again/)
      assert.deepEqual(error.reverted, ['a.txt'])
      return true
    })
    // The user's file is untouched; the update that went first stands.
    assert.equal(await readFile(join(dir, 'new.txt'), 'utf8'), 'mine now\n')
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\n2\nthree\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a turn without file changes cannot be reverted', async () => {
  const dir = await repo()
  try {
    await assert.rejects(revertTurn(dir, turnOf([])), RevertError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('lists branches with the current one marked, and checks out only on a clean tree', async () => {
  const dir = await repo()
  try {
    await checkout(dir, 'feature/x', { create: true })
    assert.equal((await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'feature/x')
    const branches = await listBranches(dir)
    assert.deepEqual(branches.map((branch) => [branch.name, branch.current]).sort(), [['feature/x', true], ['main', false]])

    await writeFile(join(dir, 'a.txt'), 'dirty\n')
    /* The refusal names what it is refusing over. It carried only a count,
       and the surface above it could then say no more than "the working tree
       may have uncommitted changes" — a guess about something this error
       already knew exactly. Removing a worktree has named the work it would
       discard since it was written. */
    await assert.rejects(checkout(dir, 'main'), (error: unknown) => {
      assert.ok(error instanceof DirtyTreeError)
      assert.match(error.message, /1 uncommitted change — a\.txt;/)
      assert.deepEqual(error.files, ['a.txt'])
      return true
    })
    assert.equal((await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'feature/x')
    await git(dir, 'checkout', '-q', '--', 'a.txt')
    await checkout(dir, 'main')
    assert.equal((await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'main')
    await assert.rejects(checkout(dir, '--evil'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a deletion recorded with no content is not put back as an empty file', async () => {
  // #29: Codex reports a deleted file with an empty diff, and the undo wrote that back.
  const dir = await repo()
  try {
    await writeFile(join(dir, 'new.txt'), 'fresh\n')
    await rm(join(dir, 'gone.txt'))
    const turn = turnOf([
      fileChange(dir, [
        { path: join(dir, 'new.txt'), kind: { type: 'add' }, diff: 'fresh\n' },
        { path: join(dir, 'gone.txt'), kind: { type: 'delete' }, diff: '' },
      ]),
    ])
    await assert.rejects(
      revertTurn(dir, turn),
      (error: unknown) => error instanceof RevertError && /gone\.txt: the agent recorded no content/.test(error.message),
    )
    // Refused before anything was touched: no empty gone.txt, and the added file still there.
    await assert.rejects(stat(join(dir, 'gone.txt')))
    assert.equal(await readFile(join(dir, 'new.txt'), 'utf8'), 'fresh\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
