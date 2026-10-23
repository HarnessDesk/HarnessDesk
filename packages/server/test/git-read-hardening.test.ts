import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import type { FindingSeries } from '@harnessdesk/protocol'
import { repairPacket } from '../src/findings/packet.js'
import { inventory, list } from '../src/git-worktree.js'
import { assertCleanTree } from '../src/git-ops.js'
import { diff, status } from '../src/git.js'
import { revisionOf } from '../src/evidence/revision.js'
import { changes, create, createDetached } from '../src/worktree.js'
import { hostContextPort } from '../src/authoring/start.js'

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

for (const driver of ['clean', 'process'] as const) {
  test(`automatic reads leave a configured ${driver} filter off on a stat-dirty file`, async (t) => {
    const f = await fixture(t)
    await writeFile(join(f.root, '.gitattributes'), '*.txt filter=demo.driver\n')
    await f.git('add', '.')
    await f.git('commit', '-qm', 'Set file attributes')
    const head = await f.git('rev-parse', 'HEAD')
    await writeFile(f.script, `#!/bin/sh\nprintf called > "$0.mark"\n${driver === 'clean' ? 'cat' : 'exit 1'}\n`)
    await f.git('config', `filter.demo.driver.${driver}`, f.script)
    await f.git('config', 'filter.demo.driver.required', 'true')
    const later = new Date(Date.now() + 5_000)
    await utimes(join(f.root, 'page.txt'), later, later)

    const readers = [
      () => status(f.root),
      () => revisionOf(f.root),
      () => diff(f.root),
      () => changes(f.root),
      () => list(f.root, join(f.base, 'state')),
      () => inventory(f.root),
      () => assertCleanTree(f.root),
      () => hostContextPort(async () => ({ stdout: '', exitCode: 0 })).git(f.root, ['status', '--porcelain']),
      () => repairPacket({
        run: 'run', round: 2, to: head, findings: [], evidence: [],
        series: { id: 'reviewer', role: 'reviewer', checkout: { cwd: f.root, branch: 'main' },
          reviewedAt: head, reviewRounds: [], initial: [], exceptions: [], pending: [] },
      }),
    ]
    for (const [index, read] of readers.entries()) {
      const changed = new Date(later.getTime() + (index + 1) * 1_000)
      await utimes(join(f.root, 'page.txt'), changed, changed)
      await read()
      assert.equal(await f.marker(), '', 'the read did not run a filter')
    }
    await writeFile(join(f.root, 'page.txt'), 'changed content\n')
    assert.equal((await status(f.root))?.files[0]?.path, 'page.txt', 'ordinary changes remain visible')
  })
}

test('a filter name that cannot be overridden refuses the read before running it', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.gitattributes'), '*.txt filter=demo=driver\n')
  await f.git('add', '.')
  await f.git('commit', '-qm', 'Set file attributes')
  await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\ncat\n')
  await f.git('config', 'filter.demo=driver.clean', f.script)
  const later = new Date(Date.now() + 5_000)
  await utimes(join(f.root, 'page.txt'), later, later)
  await assert.rejects(assertCleanTree(f.root), /filter/i)
  assert.equal(await f.marker(), '')
})

test('automatic status leaves an empty-name filter off on a stat-dirty file', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.gitattributes'), '*.txt filter=\n')
  await f.git('add', '.')
  await f.git('commit', '-qm', 'Set file attributes')
  await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\ncat\n')
  await f.git('config', 'filter..clean', f.script)
  const later = new Date(Date.now() + 5_000)
  await utimes(join(f.root, 'page.txt'), later, later)
  assert.deepEqual((await status(f.root))?.files, [])
  assert.equal(await f.marker(), '')
})

for (const detached of [false, true]) {
  test(`automatic ${detached ? 'detached' : 'branch'} checkout refuses target files with a filter`, async (t) => {
    const f = await fixture(t)
    await writeFile(join(f.root, '.gitattributes'), '*.txt filter=demo\n')
    await f.git('add', '.')
    await f.git('commit', '-qm', 'Set target attributes')
    const target = await f.git('rev-parse', 'HEAD')
    await f.git('checkout', '-q', f.head)
    await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\ncat\n')
    await f.git('config', 'filter.demo.smudge', f.script)
    const stateDir = join(f.base, 'state')
    await assert.rejects(detached
      ? createDetached(f.root, { name: 'filtered', at: target, stateDir })
      : create(f.root, { name: 'filtered', base: target, stateDir }), /filter/i)
    assert.equal(await f.marker(), '')
    assert.equal((await f.git('worktree', 'list', '--porcelain')).split('worktree ').length - 1, 1)
    assert.equal(await f.git('branch', '--list', 'harnessdesk/filtered'), '', 'no branch was left behind')
  })

  test(`automatic ${detached ? 'detached' : 'branch'} checkout checks configuration selected by its new git directory`, async (t) => {
    const f = await fixture(t)
    const attributes = join(f.base, 'attributes')
    const config = join(f.base, 'drivers.config')
    await writeFile(attributes, '*.txt filter=demo\n')
    await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\ncat\n')
    await f.git('config', '--file', config, 'core.attributesFile', attributes)
    await f.git('config', '--file', config, 'filter.demo.smudge', f.script)
    await f.git('config', 'includeIf.gitdir:**/worktrees/**.path', config)
    const stateDir = join(f.base, 'state')
    await assert.rejects(detached
      ? createDetached(f.root, { name: 'conditional', at: f.head, stateDir })
      : create(f.root, { name: 'conditional', stateDir }), /filter/i)
    assert.equal(await f.marker(), '')
    assert.equal((await f.git('worktree', 'list', '--porcelain')).split('worktree ').length - 1, 1)
    assert.equal(await f.git('branch', '--list', 'harnessdesk/conditional'), '')
  })
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
