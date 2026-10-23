import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
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
import { readGit } from '../src/git-read.js'
import { commitDiff } from '../src/git-history.js'

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

test('parent status reads child changes without running child filters', async (t) => {
  const f = await fixture(t)
  const source = await fixture(t)
  await writeFile(join(source.root, '.gitattributes'), '*.txt filter=child\n')
  await source.git('add', '.')
  await source.git('commit', '-qm', 'Set child attributes')
  await f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.root, 'child')
  await f.git('commit', '-qam', 'Track child repository')
  const child = join(f.root, 'child')
  const childGit = async (...args: string[]) => (await run('git', ['-C', child,
    '-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', ...args])).stdout
  await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\ncat\n')
  await childGit('config', 'filter.child.clean', f.script)
  const later = new Date(Date.now() + 5_000)
  await utimes(join(child, 'page.txt'), later, later)
  assert.deepEqual((await status(f.root))?.files, [])
  assert.equal(await f.marker(), '')

  await writeFile(join(child, 'page.txt'), 'changed child content\n')
  const modified = [{ path: 'child', status: 'modified', staged: false }]
  assert.deepEqual((await status(f.root))?.files, modified, 'child content changes stay visible')
  await childGit('-c', 'filter.child.clean=cat', 'commit', '-qam', 'Change child content')
  assert.deepEqual((await status(f.root))?.files, modified, 'child commit changes stay visible')
  await f.git('add', 'child')
  assert.deepEqual((await status(f.root))?.files, [{ path: 'child', status: 'modified', staged: true }])
  await writeFile(join(child, 'new.txt'), 'untracked child content\n')
  assert.equal((await status(f.root))?.files.some(file => file.path === 'child' && !file.staged), true)
  assert.equal(await f.marker(), '')
})

test('isolated status retains submodule pathname spelling and ignore choices', async (t) => {
  const f = await fixture(t)
  const source = await fixture(t)
  const name = 'child -> café'
  await f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.root, name)
  await f.git('commit', '-qam', 'Track child repository')
  const child = join(f.root, name)
  await writeFile(join(child, 'new.txt'), 'untracked child content\n')
  const compare = async () => {
    for (const quoteHigh of [true, false]) {
      await f.git('config', 'core.quotePath', String(quoteHigh))
      for (const suffix of [[], ['-z'], ['--ignore-submodules=all'], ['--ignore-submodules=dirty'], ['--ignore-submodules=untracked']]) {
        const args = ['status', '--porcelain=v1', ...suffix]
        const expected = (await run('git', ['-C', f.root, ...args])).stdout
        assert.equal((await readGit(f.root, args)).stdout, expected, `${quoteHigh}: ${suffix.join(' ')}`)
      }
    }
  }
  await compare()
  await writeFile(join(child, 'page.txt'), 'changed child content\n')
  await compare()
  await run('git', ['-C', child, '-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'commit', '-qam', 'Change child content'])
  await compare()
  await f.git('config', `submodule.${name}.ignore`, 'all')
  await compare()
  await f.git('add', name)
  await compare()
})

test('working-file diff reads a path named status', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'status'), 'before\n')
  await f.git('add', '.')
  await f.git('commit', '-qm', 'Track status file')
  await writeFile(join(f.root, 'status'), 'after\n')
  assert.match(await diff(f.root, { path: 'status' }), /\+after/)
})

test('automatic parent and history diffs report gitlinks without child diff commands', async (t) => {
  const f = await fixture(t)
  const source = await fixture(t)
  await writeFile(join(source.root, '.gitattributes'), '*.txt diff=child\n')
  await source.git('add', '.')
  await source.git('commit', '-qm', 'Set child attributes')
  await f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.root, 'child')
  await f.git('commit', '-qam', 'Track child repository')
  const child = join(f.root, 'child')
  const childGit = async (...args: string[]) => run('git', ['-C', child,
    '-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', ...args])
  await writeFile(join(child, 'page.txt'), 'changed child content\n')
  await childGit('commit', '-qam', 'Change child content')
  await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\n')
  await childGit('config', 'diff.child.command', f.script)
  await f.git('config', 'diff.submodule', 'diff')
  const patch = await diff(f.root)
  assert.equal(await f.marker(), '')
  assert.match(patch, /Subproject commit/)
  await f.git('add', 'child')
  await f.git('commit', '-qm', 'Update child revision')
  const head = await f.git('rev-parse', 'HEAD')
  const historical = await commitDiff(f.root, head, 'child')
  assert.equal(await f.marker(), '')
  assert.match(historical, /Subproject commit/)
})

test('automatic status does not load a filter added immediately before its read', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.gitattributes'), '*.txt filter=late\n')
  await f.git('add', '.')
  await f.git('commit', '-qm', 'Set file attributes')
  await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\ncat\n')
  const later = new Date(Date.now() + 5_000)
  await utimes(join(f.root, 'page.txt'), later, later)
  const realGit = (await run('which', ['git'])).stdout.trim()
  const bin = join(f.base, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'git'), `#!${process.execPath}
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.includes('status')) execFileSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(f.root)}, 'config', 'filter.late.clean', ${JSON.stringify(f.script)}])
try { process.stdout.write(execFileSync(${JSON.stringify(realGit)}, args)) }
catch (error) { process.stderr.write(error.stderr || ''); process.exit(error.status || 1) }
`, { mode: 0o755 })
  const before = process.env.PATH
  process.env.PATH = `${bin}:${before}`
  try {
    assert.deepEqual((await status(f.root))?.files, [])
    assert.equal(await f.marker(), '')
  } finally {
    process.env.PATH = before
  }
  assert.equal(await f.git('config', '--get', 'filter.late.clean'), f.script, 'the new setting was present for the consuming process')
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
