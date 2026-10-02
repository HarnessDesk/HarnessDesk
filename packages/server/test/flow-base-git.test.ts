import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { fetchFlowBase } from '../src/flow-base.js'
import { Worktrees } from '../src/worktree.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { git } from './fixtures/flow-host-evidence.js'
import { tempDir } from './scratch.js'

test('a fetched base cuts a real worktree while cached refs, HEAD, index and dirty files stay put', async () => {
  const repo = await makeRepo('hd-base-local-')
  const remote = tempDir('hd-base-remote-')
  await repo.git('clone', '--no-hardlinks', repo.dir, remote)
  await repo.git('remote', 'add', 'origin', remote)
  await repo.git('fetch', 'origin')
  const stale = await repo.git('rev-parse', 'HEAD')
  const fetchHead = await readFile(join(repo.dir, '.git', 'FETCH_HEAD'), 'utf8')
  await git(remote, 'checkout', '-b', 'trunk')
  await writeFile(join(remote, 'fresh.txt'), 'remote-only\n')
  await git(remote, 'add', '.')
  await git(remote, 'commit', '-m', 'remote advance')
  const fresh = await git(remote, 'rev-parse', 'HEAD')
  await writeFile(join(repo.dir, 'README.md'), 'staged\n')
  await repo.git('add', '.')
  await writeFile(join(repo.dir, 'README.md'), 'unstaged\n')
  const status = await repo.git('status', '--porcelain=v1')

  const base = await fetchFlowBase(repo.dir, { remote: 'origin' }, 'flow-git-test')
  assert.equal(base.at, fresh)
  const tree = await new Worktrees(tempDir('hd-base-state-')).create(repo.dir, { name: 'fresh', base: base.at })
  assert.equal(await git(tree.path, 'rev-parse', 'HEAD'), fresh)
  assert.equal(await readFile(join(tree.path, 'fresh.txt'), 'utf8'), 'remote-only\n')
  assert.equal(await repo.git('rev-parse', 'HEAD'), stale)
  assert.equal(await repo.git('rev-parse', 'origin/main'), stale)
  assert.equal(await readFile(join(repo.dir, '.git', 'FETCH_HEAD'), 'utf8'), fetchHead)
  assert.equal(await repo.git('status', '--porcelain=v1'), status)
  assert.equal(await repo.git('show', ':README.md'), 'staged')
  assert.equal(await readFile(join(repo.dir, 'README.md'), 'utf8'), 'unstaged\n')
})

test('parallel starts retain separate fetched branch commits in the same repository', async () => {
  const repo = await makeRepo('hd-base-parallel-')
  const remote = tempDir('hd-base-parallel-remote-')
  await repo.git('clone', '--no-hardlinks', repo.dir, remote)
  await repo.git('remote', 'add', 'origin', remote)
  await git(remote, 'commit', '--allow-empty', '-m', 'main advance')
  const main = await git(remote, 'rev-parse', 'HEAD')
  await git(remote, 'checkout', '-b', 'feature')
  await git(remote, 'commit', '--allow-empty', '-m', 'feature advance')
  const feature = await git(remote, 'rev-parse', 'HEAD')
  const [one, two] = await Promise.all([
    fetchFlowBase(repo.dir, { remote: 'origin', branch: 'main' }, 'flow-one'),
    fetchFlowBase(repo.dir, { remote: 'origin', branch: 'feature' }, 'flow-two'),
  ])
  assert.equal(one.at, main)
  assert.equal(two.at, feature)
  assert.equal(await repo.git('rev-parse', 'refs/harnessdesk/flow-base/flow-one'), main)
  assert.equal(await repo.git('rev-parse', 'refs/harnessdesk/flow-base/flow-two'), feature)
})
