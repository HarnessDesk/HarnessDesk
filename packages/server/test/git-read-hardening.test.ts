import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import type { FindingSeries } from '@harnessdesk/protocol'
import { repairPacket } from '../src/findings/packet.js'
import { inventory, list } from '../src/git-worktree.js'
import { assertCleanTree } from '../src/git-ops.js'

const run = promisify(execFile)

const fixture = async (t: TestContext) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hd-git-reads-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  const git = async (...args: string[]) => (await run('git', ['-C', root,
    '-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', ...args])).stdout.trim()
  await run('git', ['init', '-q', '-b', 'main', root])
  await writeFile(join(root, 'page.txt'), 'page\n')
  await git('add', '.')
  await git('commit', '-qm', 'Initial content')
  const head = await git('rev-parse', 'HEAD')
  const script = join(base, 'monitor.sh')
  await writeFile(script, '#!/bin/sh\nprintf called > "$0.mark"\n', { mode: 0o755 })
  const marker = () => readFile(`${script}.mark`, 'utf8').catch(() => '')
  return { base, root, git, head, script, marker }
}

for (const operation of ['repair packet', 'worktree list', 'worktree inventory', 'checkout preflight'] as const) {
  test(`${operation} leaves the repository filesystem monitor off`, async (t) => {
    const f = await fixture(t)
    await f.git('config', 'core.fsmonitor', f.script)
    if (operation === 'repair packet') {
      const series: FindingSeries = {
        id: 'reviewer', role: 'reviewer', checkout: { cwd: f.root, branch: 'main' },
        reviewedAt: f.head, reviewRounds: [], initial: [], exceptions: [], pending: [],
      }
      const packet = await repairPacket({ run: 'run', round: 2, series, to: f.head, findings: [], evidence: [] })
      assert.equal(packet.diff, '')
    } else if (operation === 'worktree list') {
      assert.equal((await list(f.root, join(f.base, 'state')))[0]?.dirty, 0)
    } else if (operation === 'worktree inventory') {
      assert.equal((await inventory(f.root)).changeCount, 0)
    } else {
      await assertCleanTree(f.root)
    }
    assert.equal(await f.marker(), '')
  })
}
