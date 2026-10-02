import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { FlowPreview, GoalView } from '@harnessdesk/protocol'

import { removeCheckoutsLeftBehind } from '../src/worktree.js'
import { tempDir } from './scratch.js'
import { claimed, cwdOf, desk, git, settled, start, TASK, type Desk } from './fixtures/flow-host-evidence.js'

const FLOW = `
version: 2
name: Fresh start
base: { remote: origin }
roles:
  dev: { kind: agent, uses: implementer, grant: edit }
seed: { role: dev, title: Work }
rules: []
`

// Local-only remote, sharing the checkout's history before it advances.
const remoteFor = async (d: Desk): Promise<string> => {
  const remote = tempDir('hd-flow-base-remote-')
  await git(d.root, 'clone', '--no-hardlinks', d.root, remote)
  await git(d.root, 'remote', 'add', 'origin', remote)
  await git(d.root, 'fetch', 'origin')
  return remote
}

const advance = async (remote: string, text: string): Promise<string> => {
  await writeFile(join(remote, 'fresh.txt'), `${text}\n`)
  await git(remote, 'add', 'fresh.txt')
  await git(remote, 'commit', '-m', text)
  return git(remote, 'rev-parse', 'HEAD')
}

test('start fetches the remote default into a lane without moving or cleaning a stale checkout', async (t) => {
  const d = await desk(t)
  const remote = await remoteFor(d)
  const stale = await git(d.root, 'rev-parse', 'HEAD')
  // A renamed default that the local checkout has never fetched.
  await git(remote, 'checkout', '-b', 'trunk')
  const fresh = await advance(remote, 'new default')
  await writeFile(join(d.root, 'README.md'), 'local staged change\n')
  await git(d.root, 'add', 'README.md')
  await writeFile(join(d.root, 'README.md'), 'local unstaged change\n')
  const dirt = await git(d.root, 'status', '--porcelain=v1')

  const run = await start(d, FLOW, TASK)
  assert.equal(run.state, 'running', run.reason ?? 'run did not start')
  const [card] = await claimed(d, run.goal, 'dev', 1)
  const cwd = cwdOf(d, card!)
  assert.equal(await git(cwd, 'rev-parse', 'HEAD'), fresh, 'the Seat is at the fetched default, not stale HEAD')
  assert.notEqual(cwd, d.root)
  assert.deepEqual(run.base, { remote: 'origin', at: fresh })
  assert.equal((await d.host.call('goal/read', { goal: run.goal }) as GoalView).goal.at, fresh)
  assert.equal(await git(cwd, 'show', 'HEAD:fresh.txt'), 'new default')
  assert.equal(await git(d.root, 'rev-parse', 'HEAD'), stale)
  assert.equal(await git(d.root, 'status', '--porcelain=v1'), dirt)
  assert.equal(await git(d.root, 'show', ':README.md'), 'local staged change')
  assert.equal(await git(d.root, 'rev-parse', `refs/harnessdesk/flow-base/${run.id}`), fresh, 'the base stays reachable for recovery and later rounds')
})

test('an explicit base branch is fetched instead of the remote default', async (t) => {
  const d = await desk(t)
  const remote = await remoteFor(d)
  await git(remote, 'checkout', 'main')
  const fresh = await advance(remote, 'named branch')
  await git(remote, 'checkout', 'work')
  const run = await start(d, FLOW.replace('{ remote: origin }', '{ remote: origin, branch: main }'), TASK)
  assert.equal(run.state, 'running', run.reason ?? 'run did not start')
  const [card] = await claimed(d, run.goal, 'dev', 1)
  assert.equal(await git(cwdOf(d, card!), 'rev-parse', 'HEAD'), fresh)
  assert.deepEqual(run.base, { remote: 'origin', branch: 'main', at: fresh })
})

test('a failed base fetch refuses before any Goal or Seat exists, even with a cached remote head', async (t) => {
  const d = await desk(t)
  await remoteFor(d)
  const before = await d.host.call('goal/list', {})
  for (const base of ['{ remote: missing }', '{ remote: origin, branch: absent }']) {
    const source = FLOW.replace('{ remote: origin }', base)
    const preview = await d.host.call('flow/preview', { root: d.root, source }) as FlowPreview
    assert.ok(preview.token)
    await assert.rejects(d.host.call('flow/start-goal', { root: d.root, source, token: preview.token!, sentence: 'Work' }), /base.*fetch|fetch.*base/i)
    assert.deepEqual(await d.host.call('goal/list', {}), before)
  }
  // A configured but unavailable remote must never use its cached work ref.
  await git(d.root, 'remote', 'set-url', 'origin', join(tempDir('hd-flow-base-offline-'), 'missing'))
  const preview = await d.host.call('flow/preview', { root: d.root, source: FLOW }) as FlowPreview
  assert.ok(preview.token)
  await assert.rejects(d.host.call('flow/start-goal', { root: d.root, source: FLOW, token: preview.token!, sentence: 'Work' }), /base.*fetch|fetch.*base/i)
  assert.deepEqual(await d.host.call('goal/list', {}), before)
})

test('a seed check actually runs against the fetched base, not the project HEAD', async (t) => {
  const d = await desk(t)
  const remote = await remoteFor(d)
  await advance(remote, 'check this')
  const source = `version: 2\nname: Base check\nbase: { remote: origin }\nroles:\n  gate: { kind: check, run: 'test -f fresh.txt' }\nseed: { role: gate, title: Check fresh }\nrules: []\n`
  const run = await start(d, source, {})
  await settled(d, run.id)
  const view = await d.host.call('goal/read', { goal: run.goal }) as GoalView
  assert.equal(view.board.intents[0]?.outcome, 'pass', 'the actual command sees the remote-only file')
  const snapshots = (await git(d.root, 'worktree', 'list', '--porcelain')).split('\n')
    .filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length)).slice(1)
  assert.equal(snapshots.length, 1)
  assert.deepEqual(await removeCheckoutsLeftBehind(d.stateDir), [], 'startup must retain a base-check snapshot')
  assert.equal(await git(snapshots[0]!, 'show', 'HEAD:fresh.txt'), 'check this')
})
