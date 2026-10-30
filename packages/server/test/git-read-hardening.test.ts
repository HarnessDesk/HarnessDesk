import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import type { FindingSeries } from '@harnessdesk/protocol'
import { DELTA_LIMIT, repairPacket } from '../src/findings/packet.js'
import { inventory, list } from '../src/git-worktree.js'
import { assertCleanTree } from '../src/git-ops.js'
import { diff, status } from '../src/git.js'
import { revisionOf } from '../src/evidence/revision.js'
import { WorktreeDirtyError, changes, create, createDetached, remove } from '../src/worktree.js'
import { hostContextPort } from '../src/authoring/start.js'
import { automaticCheckout, readGit } from '../src/git-read.js'
import { patch as commitPatch } from '../src/git-actions.js'
import { commit as openCommit, commitDiff, forgetKnown, log as historyLog, refs as historyRefs } from '../src/git-history.js'

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

test('ordinary status preserves changes beside an incomplete untracked submodule file', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'page.txt'), 'changed\n')
  await writeFile(join(f.root, '.gitmodules'), '[submodule "unfinished"\n')
  const args = ['status', '--porcelain=v1', '-z']
  const native = (await run('git', ['-C', f.root, ...args])).stdout
  assert.equal((await readGit(f.root, args)).stdout, native)
  assert.deepEqual((await status(f.root))?.files.map(file => file.path).sort(), ['.gitmodules', 'page.txt'])
})

test('parent status propagates its untracked selection to child repositories', async (t) => {
  const f = await fixture(t)
  const source = await fixture(t)
  await f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.root, 'child')
  await f.git('commit', '-qam', 'Track child repository')
  await writeFile(join(f.root, 'child', 'new.txt'), 'new\n')
  for (const flags of [['--untracked-files=no'], ['-uno']]) {
    const args = ['status', '--porcelain=v1', '-z', ...flags]
    const native = (await run('git', ['-C', f.root, ...args])).stdout
    assert.equal((await readGit(f.root, args)).stdout, native, flags.join(' '))
  }
  await assertCleanTree(f.root)
  await f.git('config', 'status.showUntrackedFiles', 'no')
  assert.equal((await readGit(f.root, ['status', '--porcelain=v1', '-z'])).stdout, '')
  assert.equal((await readGit(f.root, ['status', '--porcelain=v1', '-z', '-uall'])).stdout, ' M child\0')
})

for (const detached of [false, true]) {
  test(`automatic ${detached ? 'detached' : 'branch'} checkout preserves inherited sparse selection`, async (t) => {
    const f = await fixture(t)
    await mkdir(join(f.root, 'keep'))
    await mkdir(join(f.root, 'omit'))
    await writeFile(join(f.root, 'keep', 'page.txt'), 'selected\n')
    await writeFile(join(f.root, 'omit', 'page.txt'), 'excluded\n')
    await f.git('add', '.')
    await f.git('commit', '-qm', 'Add selected and excluded directories')
    const at = await f.git('rev-parse', 'HEAD')
    await f.git('sparse-checkout', 'set', '--cone', 'keep')
    await assert.rejects(readFile(join(f.root, 'omit', 'page.txt')), { code: 'ENOENT' })
    const stateDir = join(f.base, 'state')
    const tree = detached
      ? await createDetached(f.root, { name: 'sparse', at, stateDir })
      : (await create(f.root, { name: 'sparse', stateDir })).path
    assert.equal(await readFile(join(tree, 'keep', 'page.txt'), 'utf8'), 'selected\n')
    assert.equal(await readFile(join(tree, 'page.txt'), 'utf8'), 'page\n')
    await assert.rejects(readFile(join(tree, 'omit', 'page.txt')), { code: 'ENOENT' })
    const git = async (...args: string[]) => (await run('git', ['-C', tree, ...args])).stdout
    assert.equal(await git('ls-files', '-t', 'omit/page.txt'), 'S omit/page.txt\n')
    assert.equal(await git('sparse-checkout', 'list'), 'keep\n')
    assert.equal(await git('status', '--porcelain=v1'), '')
  })

  for (const name of ['unset', 'unspecified']) {
    test(`automatic ${detached ? 'detached' : 'branch'} checkout refuses the literal filter name ${name}`, async (t) => {
      const f = await fixture(t)
      await writeFile(join(f.root, '.gitattributes'), `*.txt filter=${name}\n`)
      await f.git('add', '.')
      await f.git('commit', '-qm', 'Set target attributes')
      const at = await f.git('rev-parse', 'HEAD')
      const stateDir = join(f.base, 'state')
      await assert.rejects(detached
        ? createDetached(f.root, { name: 'literal', at, stateDir })
        : create(f.root, { name: 'literal', base: at, stateDir }), /filter/i)
      assert.equal((await f.git('worktree', 'list', '--porcelain')).split('worktree ').length - 1, 1)
      assert.equal(await f.git('branch', '--list', 'harnessdesk/literal'), '')
    })
  }

  test(`automatic ${detached ? 'detached' : 'branch'} checkout keeps later configuration out of materialization`, async (t) => {
    const f = await fixture(t)
    await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\ncat\n')
    const attributes = join(f.base, 'attributes')
    await writeFile(attributes, '*.txt filter=late\n')
    const realGit = (await run('which', ['git'])).stdout.trim()
    const bin = join(f.base, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'git'), `#!${process.execPath}
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.includes('reset') || args.includes('checkout-index') || (args.includes('read-tree') && args.includes('-u'))) {
  execFileSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(f.root)}, 'config', 'core.attributesFile', ${JSON.stringify(attributes)}])
  execFileSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(f.root)}, 'config', 'filter.late.smudge', ${JSON.stringify(f.script)}])
}
try { process.stdout.write(execFileSync(${JSON.stringify(realGit)}, args)) }
catch (error) { process.stderr.write(error.stderr || ''); process.exit(error.status || 1) }
`, { mode: 0o755 })
    const before = process.env.PATH
    process.env.PATH = `${bin}:${before}`
    try {
      const stateDir = join(f.base, 'state')
      const tree = detached
        ? await createDetached(f.root, { name: 'later', at: f.head, stateDir })
        : (await create(f.root, { name: 'later', stateDir })).path
      assert.equal(await f.marker(), '')
      assert.equal(await readFile(join(tree, 'page.txt'), 'utf8'), 'page\n')
      assert.equal((await readGit(tree, ['status', '--porcelain=v1'])).stdout, '')
    } finally {
      process.env.PATH = before
    }
    assert.equal(await f.git('config', '--get', 'filter.late.smudge'), f.script)
  })

  for (const attribute of ['-filter', '!filter']) {
    test(`automatic ${detached ? 'detached' : 'branch'} checkout accepts ${attribute} attributes`, async (t) => {
      const f = await fixture(t)
      await writeFile(join(f.root, '.gitattributes'), `*.txt ${attribute}\n`)
      await f.git('add', '.')
      await f.git('commit', '-qm', 'Unset file filtering')
      const at = await f.git('rev-parse', 'HEAD')
      const stateDir = join(f.base, 'state')
      const tree = detached
        ? await createDetached(f.root, { name: 'plain', at, stateDir })
        : (await create(f.root, { name: 'plain', stateDir })).path
      assert.equal(await readFile(join(tree, 'page.txt'), 'utf8'), 'page\n')
    })
  }

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

test('a failed automatic checkout leaves unrelated missing worktrees registered', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.gitattributes'), '*.txt filter=unset\n')
  await f.git('add', '.')
  await f.git('commit', '-qm', 'Set target attributes')
  const at = await f.git('rev-parse', 'HEAD')
  // A person's checkout on a volume that is not mounted right now: registered,
  // folder absent, metadata — including a staged index — still theirs.
  const unattached = join(f.base, 'unmounted')
  await f.git('worktree', 'add', '-q', '--no-checkout', '-b', 'elsewhere', unattached, f.head)
  const admin = (await run('git', ['-C', unattached, 'rev-parse', '--path-format=absolute', '--git-dir'])).stdout.trim()
  await rm(unattached, { recursive: true, force: true })
  const stateDir = join(f.base, 'state')
  await assert.rejects(create(f.root, { name: 'pruning', base: at, stateDir }), /filter/i)
  assert.equal(await stat(admin).then(() => true, () => false), true, 'the unrelated entry keeps its metadata')
  const listed = await f.git('worktree', 'list', '--porcelain')
  assert.equal(listed.includes(unattached), true, 'and it is still registered')
  assert.equal(await f.git('branch', '--list', 'harnessdesk/pruning'), '')
})

test('a failed automatic checkout from a remote-tracking base leaves no branch configuration behind', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.gitattributes'), '*.txt filter=unset\n')
  await f.git('add', '.')
  await f.git('commit', '-qm', 'Set target attributes')
  const target = await f.git('rev-parse', 'HEAD')
  await f.git('remote', 'add', 'origin', 'https://example.invalid/widgets.git')
  await f.git('update-ref', 'refs/remotes/origin/trunk', target)
  await f.git('checkout', '-q', f.head)
  // Someone else's branch and its upstream: the cleanup must not touch it.
  await f.git('branch', '--track', 'keeper', 'origin/trunk')
  const stateDir = join(f.base, 'state')
  await assert.rejects(create(f.root, { name: 'tracked.lane', base: 'origin/trunk', stateDir }), /filter/i)
  assert.equal(await f.git('branch', '--list', 'harnessdesk/tracked.lane'), '', 'no branch was left behind')
  await assert.rejects(
    run('git', ['-C', f.root, 'config', '--get-regexp', '^branch\\.harnessdesk/tracked\\.lane\\.']),
    (error: { code?: number }) => error.code === 1,
    'and no upstream setting for it',
  )
  assert.equal(await f.git('config', '--get', 'branch.keeper.remote'), 'origin', 'another branch keeps its own')
})

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

type Fixture = Awaited<ReturnType<typeof fixture>>

/** Git with `input` on its standard input; the rest of the arguments follow `git -C`. */
const feed = (cwd: string, args: readonly string[], input: string | Buffer) => {
  const pending = run('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })
  pending.child.stdin?.end(input)
  return pending
}

/**
 * Commit `count` more tracked paths that have no file on disk: the tree and
 * index of a large repository without writing one. They are marked
 * skip-worktree, so status stays clean, and are long enough that the index
 * listing passes a megabyte at about ten thousand of them.
 */
const trackMany = async (f: Fixture, count: number): Promise<void> => {
  const blob = await f.git('rev-parse', 'HEAD:page.txt')
  const paths = Array.from({ length: count }, (_, i) => `generated/${'x'.repeat(60)}/entry-${String(i).padStart(6, '0')}.txt`)
  await feed(f.root, ['update-index', '--index-info'], paths.map((path) => `100644 ${blob}\t${path}\n`).join(''))
  await feed(f.root, ['update-index', '--skip-worktree', '-z', '--stdin'], `${paths.join('\0')}\0`)
  await f.git('commit', '-qm', 'Track many generated paths')
}

/** The length of the listing a status reads to find gitlinks. */
const indexListing = async (f: Fixture): Promise<number> =>
  (await run('git', ['-C', f.root, 'ls-files', '--stage', '--full-name', '-z'], { maxBuffer: 64 * 1024 * 1024 })).stdout.length

/** A target worktree, registered but not written, for `automaticCheckout` to materialize. */
const unwritten = async (f: Fixture, at: string): Promise<string> => {
  const tree = join(f.base, 'tree')
  await f.git('worktree', 'add', '-q', '--no-checkout', '-b', 'copy', tree, at)
  return tree
}

/**
 * A `git` ahead of the real one on PATH. It records each call's arguments,
 * runs `intercept` (the body of a function with `args` in scope; returning true
 * ends the call), and otherwise hands the call to the real git with its own
 * standard streams.
 */
const withGitShim = async <T>(
  f: Fixture, intercept: string, use: (calls: () => Promise<string[][]>) => Promise<T>,
): Promise<T> => {
  const realGit = (await run('which', ['git'])).stdout.trim()
  const bin = join(f.base, 'bin')
  const log = join(f.base, 'git-calls.log')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'git'), String.raw`#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\n')
const handled = (() => { ${intercept} })()
if (!handled) process.exit(spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1)
`, { mode: 0o755 })
  const before = process.env.PATH
  process.env.PATH = `${bin}:${before}`
  try {
    return await use(async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]))
  } finally {
    process.env.PATH = before
  }
}

const seriesAt = (f: Fixture, reviewedAt: string): FindingSeries => ({
  id: 'reviewer', role: 'reviewer', checkout: { cwd: f.root, branch: 'main' },
  reviewedAt, reviewRounds: [], initial: [], exceptions: [], pending: [],
})

test('a repair packet is made for a clean repository whose index outgrows the packet limit', async (t) => {
  const f = await fixture(t)
  await trackMany(f, 10_000)
  assert.ok(await indexListing(f) > DELTA_LIMIT + 1, 'the index listing alone is longer than the output a packet reads')
  const to = await f.git('rev-parse', 'HEAD')
  const packet = await repairPacket({ run: 'run', round: 2, series: seriesAt(f, to), to, findings: [], evidence: [] })
  assert.equal(packet.diff, '')
})

test('status does not count its search for submodules against the caller output limit', async (t) => {
  const f = await fixture(t)
  await trackMany(f, 10_000)
  assert.ok(await indexListing(f) > DELTA_LIMIT + 1)
  const clean = await readGit(f.root, ['status', '--porcelain', '--untracked-files=no'], { maxBuffer: DELTA_LIMIT + 1 })
  assert.equal(clean.stdout, '')
})

test('status output still counts against the caller output limit', async (t) => {
  const f = await fixture(t)
  const names = Array.from({ length: 400 }, (_, i) => `untracked-${'y'.repeat(50)}-${String(i).padStart(3, '0')}.txt`)
  for (const name of names) await writeFile(join(f.root, name), 'new\n')
  // Room for everything else the read asks git, so only the status itself can pass the limit.
  const settings = (await run('git', ['-C', f.root, 'config', '--null', '--list', '--includes'])).stdout.length
  const limit = settings + 4 * 1024
  await assert.rejects(readGit(f.root, ['status', '--porcelain', '-uall'], { maxBuffer: limit }), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  assert.equal((await readGit(f.root, ['status', '--porcelain', '-uall'], { maxBuffer: limit + 64 * 1024 })).stdout.split('\n').length, names.length + 1)
})

test('a changed submodule is still found when the index listing outgrows the caller output limit', async (t) => {
  const f = await fixture(t)
  const source = await fixture(t)
  await trackMany(f, 2_000)
  const limit = 64 * 1024
  assert.ok(await indexListing(f) > limit)
  await f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.root, 'child')
  await f.git('commit', '-qm', 'Track child repository')
  await writeFile(join(f.root, 'child', 'page.txt'), 'changed\n')
  assert.equal((await readGit(f.root, ['status', '--porcelain=v1', '-z'], { maxBuffer: limit })).stdout, ' M child\0')
})

test('a failed search for submodules fails the status instead of reading as none', async (t) => {
  const f = await fixture(t)
  await withGitShim(f, `
    if (args.includes('ls-files') && args.includes('--stage')) { process.stderr.write('fatal: simulated listing failure\\n'); return process.exit(128) }
  `, async () => {
    await assert.rejects(readGit(f.root, ['status', '--porcelain', '--untracked-files=no']), /simulated listing failure/)
  })
})

for (const materialize of [false, true]) {
  test(`automatic checkout ${materialize ? 'materialization' : 'preflight'} lists paths and attributes beyond the caller output limit`, async (t) => {
    const f = await fixture(t)
    await writeFile(join(f.root, '.gitattributes'), '* text=auto eol=lf\n')
    await f.git('add', '.gitattributes')
    await trackMany(f, 400)
    const limit = 16 * 1024
    assert.ok(await indexListing(f) > limit, 'the path listing alone is longer than the limit')
    const at = await f.git('rev-parse', 'HEAD')
    const tree = materialize ? await unwritten(f, at) : f.root
    const target = await automaticCheckout(tree, at, { materialize, maxBuffer: limit })
    assert.equal(target.at, at)
    if (materialize) {
      assert.equal(await readFile(join(tree, 'page.txt'), 'utf8'), 'page\n')
      assert.equal(await readFile(join(tree, 'generated', 'x'.repeat(60), 'entry-000399.txt'), 'utf8'), 'page\n')
    }
  })
}

test('a broad unset filter rule is checked in bulk, not once per path', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.gitattributes'), '* -filter\n')
  await f.git('add', '.gitattributes')
  await trackMany(f, 60)
  const at = await f.git('rev-parse', 'HEAD')
  const tree = await unwritten(f, at)
  const loose = async () => /^count: (\d+)$/m.exec(await f.git('count-objects', '-v'))?.[1]
  const before = await loose()
  await withGitShim(f, '', async (calls) => {
    await automaticCheckout(tree, at, { materialize: true })
    const probes = (await calls()).filter((args) => args.includes('filter.unset.required=true'))
    assert.equal(probes.length, 1, 'one process checked every path')
  })
  assert.equal(await loose(), before, 'the check wrote no object into the repository')
  assert.equal(await readFile(join(tree, 'page.txt'), 'utf8'), 'page\n')
})

for (const name of ['unset', 'unspecified']) {
  test(`one literal filter name ${name} among many unset paths still refuses the checkout`, async (t) => {
    const f = await fixture(t)
    await writeFile(join(f.root, '.gitattributes'), `* -filter\nzzz-last.txt filter=${name}\n`)
    await writeFile(join(f.root, 'zzz-last.txt'), 'last\n')
    await f.git('add', '.')
    await trackMany(f, 40)
    const at = await f.git('rev-parse', 'HEAD')
    await assert.rejects(automaticCheckout(await unwritten(f, at), at, { materialize: true }), /zzz-last\.txt: (clean|smudge) filter '?(unset|unspecified)'? failed/)
  })
}

// Names that need care on a line-oriented question: blanks, a newline, a carriage return, and non-ASCII.
const UNUSUAL = [' leading.txt', 'line\nbreak.txt', 'trailing.txt\r', 'with space.txt', 'ünï.txt'] as const

for (const odd of UNUSUAL) {
  test(`a literal filter name on the path ${JSON.stringify(odd)} still refuses the checkout`, async (t) => {
    const f = await fixture(t)
    await writeFile(join(f.root, '.gitattributes'), `* -filter\n${JSON.stringify(odd)} filter=unset\n`)
    await writeFile(join(f.root, odd), 'odd\n')
    await f.git('add', '.')
    await f.git('commit', '-qm', 'Name an unusual path')
    const at = await f.git('rev-parse', 'HEAD')
    await assert.rejects(automaticCheckout(await unwritten(f, at), at, { materialize: true }), /filter '?unset'? failed/)
  })
}

test('unusual path names beside an unset filter rule are written, not refused', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.gitattributes'), '* -filter\n')
  for (const name of UNUSUAL) await writeFile(join(f.root, name), `${JSON.stringify(name)}\n`)
  await f.git('add', '.')
  await f.git('commit', '-qm', 'Name unusual paths')
  const at = await f.git('rev-parse', 'HEAD')
  const tree = await unwritten(f, at)
  await automaticCheckout(tree, at, { materialize: true })
  for (const name of UNUSUAL) assert.equal(await readFile(join(tree, name), 'utf8'), `${JSON.stringify(name)}\n`)
})

test('a filter found early in a long listing refuses the checkout without waiting for the rest of it', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.gitattributes'), '* text=auto eol=lf\n.gitattributes filter=demo\n')
  await f.git('add', '.gitattributes')
  // More paths than a pipe holds, so a listing nobody reads stays blocked until something stops it.
  await trackMany(f, 4_000)
  const timeout = 30_000
  const started = Date.now()
  await assert.rejects(automaticCheckout(f.root, 'HEAD', { timeout }), /needs a git filter/)
  assert.ok(Date.now() - started < timeout / 2, 'the listing was stopped, not waited out')
})

test('a refused attribute reader drains the stopped writer before removing its private view', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t)
  const pidFile = join(f.base, 'writer.pid')
  const exited = join(f.base, 'writer-exited')
  await withGitShim(f, `
    if (args.includes('ls-files')) {
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
      const view = args.find(arg => arg.startsWith('--git-dir=')).slice('--git-dir='.length)
      const keepAlive = setInterval(() => {}, 1000)
      process.on('SIGTERM', () => {
        // The reader has time to close and unpipe before the writer finishes its output.
        setTimeout(() => process.stdout.write(Buffer.alloc(1024 * 1024, 120), () => {
          writeFileSync(${JSON.stringify(exited)}, String(require('node:fs').existsSync(view)))
          clearInterval(keepAlive)
          process.exit(1)
        }), 100)
      })
      process.stdout.write(Buffer.alloc(1024 * 1024, 120))
      return true
    }
    if (args.includes('check-attr')) {
      process.stdin.once('data', () => {
        process.stdin.pause()
        process.stdout.write('page.txt\\0filter\\0demo\\0')
      })
      return true
    }
  `, async () => {
    const read = automaticCheckout(f.root, 'HEAD', { timeout: 30_000 })
    const refused = assert.rejects(read, /needs a git filter/)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        refused,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the stopped writer was not drained')), 10_000) }),
      ])
      assert.equal(await readFile(exited, 'utf8'), 'true', 'the private view remained until the writer finished')
    } finally {
      clearTimeout(timer)
      const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''))
      if (pid) {
        try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      await refused.catch(() => undefined)
    }
  })
})

test('a path that cannot be spelled to git is refused rather than checked under another name', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.gitattributes'), '* -filter\n')
  await mkdir(join(f.root, 'keep'))
  await writeFile(join(f.root, 'keep', 'page.txt'), 'selected\n')
  await f.git('add', '.')
  // Not valid UTF-8 and holding a newline, so only a one-path-per-process question could name it.
  // Sparse selection leaves it unwritten, which keeps the filesystem out of the test.
  const odd = Buffer.concat([Buffer.from('omit/'), Buffer.from([0xff, 0x0a]), Buffer.from('bad.txt')])
  const blob = await f.git('rev-parse', 'HEAD:page.txt')
  await feed(f.root, ['update-index', '-z', '--index-info'], Buffer.concat([Buffer.from(`100644 ${blob}\t`), odd, Buffer.alloc(1)]))
  await f.git('commit', '-qm', 'Track a path with an unspellable name')
  await f.git('sparse-checkout', 'set', '--cone', 'keep')
  const at = await f.git('rev-parse', 'HEAD')
  await assert.rejects(automaticCheckout(f.root, at, { materialize: true }), /could not be checked for git filters/)
})

test('a filter check answered with less than one acknowledgement per path refuses the checkout', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, '.gitattributes'), '* -filter\n')
  await f.git('add', '.gitattributes')
  await f.git('commit', '-qm', 'Unset file filtering')
  const at = await f.git('rev-parse', 'HEAD')
  const tree = await unwritten(f, at)
  await withGitShim(f, `
    if (args.includes('cat-file') && args.includes('--filters')) { process.stdout.write('0'.repeat(40) + ' missing\\n'); return process.exit(0) }
  `, async () => {
    await assert.rejects(automaticCheckout(tree, at, { materialize: true }), /could not be checked for git filters/)
  })
})

test('a failed path listing fails the checkout instead of reading as no paths', async (t) => {
  const f = await fixture(t)
  await withGitShim(f, `
    if (args.includes('ls-files')) { process.stdout.write('page.txt\\0'); process.stderr.write('fatal: simulated listing failure\\n'); return process.exit(128) }
  `, async () => {
    await assert.rejects(automaticCheckout(f.root, 'HEAD'), /simulated listing failure/)
  })
})

// Git exits cleanly in both, so only the shape of what it printed shows the answer is short.
for (const [cut, where] of [
  ['page.txt\0filter\0', 'before the value'],
  ['page.txt\0filter\0unset\0later.txt', 'inside a path'],
] as const) {
  test(`an attribute listing that stops ${where} fails the checkout instead of reading as complete`, async (t) => {
    const f = await fixture(t)
    await withGitShim(f, `
      if (args.includes('check-attr')) { process.stdout.write(${JSON.stringify(cut)}); return process.exit(0) }
    `, async () => {
      await assert.rejects(automaticCheckout(f.root, 'HEAD'), /middle of a record/)
    })
  })
}

test('an index listing that stops inside a record fails the status instead of reading as complete', async (t) => {
  const f = await fixture(t)
  await withGitShim(f, `
    if (args.includes('ls-files') && args.includes('--stage')) { process.stdout.write('100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\\tpage.txt'); return process.exit(0) }
  `, async () => {
    await assert.rejects(readGit(f.root, ['status', '--porcelain', '--untracked-files=no']), /middle of a record/)
  })
})

for (const stop of ['abort', 'timeout'] as const) {
  test(`${stop === 'abort' ? 'an abort' : 'a timeout'} during the path listing ends the checkout read after git has exited`, { skip: process.platform === 'win32' }, async (t) => {
    const f = await fixture(t)
    const started = join(f.base, 'started')
    const exited = join(f.base, 'exited')
    await withGitShim(f, `
      if (args.includes('ls-files')) {
        process.on('SIGTERM', () => setTimeout(() => { writeFileSync(${JSON.stringify(exited)}, 'exited'); process.exit(1) }, 100))
        writeFileSync(${JSON.stringify(started)}, 'started')
        setInterval(() => {}, 1000)
        return true
      }
    `, async () => {
      const controller = new AbortController()
      const read = automaticCheckout(f.root, 'HEAD', stop === 'abort' ? { signal: controller.signal } : { timeout: 1_500 })
      const stopped = assert.rejects(read, (error: { name?: string; killed?: boolean; code?: unknown }) => {
        if (stop === 'abort') assert.equal(error.name, 'AbortError')
        else {
          assert.equal(error.killed, true)
          assert.notEqual(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        }
        return true
      })
      try {
        const deadline = Date.now() + 10_000
        while (await readFile(started, 'utf8').catch(() => '') === '') {
          assert.ok(Date.now() < deadline, 'git stand-in started')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        if (stop === 'abort') controller.abort()
        await stopped
        assert.equal(await readFile(exited, 'utf8'), 'exited', 'the child exited before the read settled')
      } finally {
        controller.abort()
        await stopped.catch(() => undefined)
      }
    })
  })
}

/**
 * A commit with a signature header, put on top of the fixture's and made the
 * branch tip. The bytes between the armor lines are not read until a program
 * is asked to verify them, so any text will do: what matters is that git has
 * a signature to hand to one.
 */
const signedCommit = async (f: Fixture): Promise<string> => {
  await writeFile(join(f.root, 'page.txt'), 'signed content\n')
  await f.git('add', 'page.txt')
  const lines = [
    `tree ${await f.git('write-tree')}`,
    `parent ${f.head}`,
    'author Jane Doe <dev@example.com> 1700000000 +0000',
    'committer Jane Doe <dev@example.com> 1700000000 +0000',
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' AAAA',
    ' -----END PGP SIGNATURE-----',
    '',
    'Signed change',
    '',
  ]
  const sha = (await feed(f.root, ['hash-object', '-t', 'commit', '-w', '--stdin'], lines.join('\n'))).stdout.trim()
  await f.git('update-ref', 'refs/heads/main', sha)
  return sha
}

type Read = readonly [name: string, read: () => Promise<unknown>]

/** The names of the reads that started the fixture's program, each run with its marker cleared first. */
const startedBy = async (f: Fixture, reads: readonly Read[]): Promise<string[]> => {
  const started: string[] = []
  for (const [name, read] of reads) {
    await rm(`${f.script}.mark`, { force: true })
    await read()
    if (await f.marker() !== '') started.push(name)
  }
  return started
}

test('history reads do not start the signature program a repository names', async (t) => {
  const f = await fixture(t)
  const signed = await signedCommit(f)
  await f.git('update-ref', '--create-reflog', '-m', 'WIP on main', 'refs/stash', signed)
  await f.git('config', 'log.showSignature', 'true')
  await f.git('config', 'gpg.program', f.script)
  // The repository does what it says when git is asked on its own terms.
  await run('git', ['-C', f.root, 'log', '--max-count=1', '--pretty=format:%H'])
  assert.equal(await f.marker(), 'called', 'a plain git log starts the repository program')
  await rm(`${f.script}.mark`)

  const reads: Read[] = [
    ['the history list', () => historyLog(f.root)],
    ['one commit by id', () => historyLog(f.root, { query: signed, search: 'sha' })],
    ['the refs and stashes', () => historyRefs(f.root)],
    ['an opened commit', () => openCommit(f.root, signed)],
    ['one file of a commit', async () => { forgetKnown(); return commitDiff(f.root, signed, 'page.txt') }],
    ['a commit as a mail patch', () => commitPatch(f.root, signed)],
    ['a one-commit log', () => readGit(f.root, ['log', '--max-count=1', '--pretty=format:%H'])],
    ['the parents of a commit', () => readGit(f.root, ['show', '-s', '--format=%P', 'HEAD'])],
    ['a log with its patch', () => readGit(f.root, ['log', '-p', '-1'])],
  ]
  assert.deepEqual(await startedBy(f, reads), [], 'no read started the program')
})

test('history reads that print a patch leave the text conversion a repository names off', async (t) => {
  const f = await fixture(t)
  const signed = await signedCommit(f)
  await writeFile(join(f.root, '.git', 'info', 'attributes'), '*.txt diff=conv\n')
  await f.git('config', 'diff.conv.textconv', f.script)
  // The repository does what it says when git is asked on its own terms.
  await run('git', ['-C', f.root, 'log', '-p', '-1'])
  assert.equal(await f.marker(), 'called', 'a plain git log -p starts the repository program')
  await rm(`${f.script}.mark`)

  const reads: Read[] = [
    ['an opened commit', () => openCommit(f.root, signed)],
    ['one file of a commit', async () => { forgetKnown(); return commitDiff(f.root, signed, 'page.txt') }],
    ['a commit as a mail patch', () => commitPatch(f.root, signed)],
    ['the working-file diff', () => diff(f.root)],
  ]
  assert.deepEqual(await startedBy(f, reads), [], 'no read started the program')
})

/**
 * The files git reads for the person's own configuration, for the rest of the
 * test: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` name them, so the machine's
 * own files are not consulted. The environment is put back when the test ends.
 */
const userConfig = async (
  t: TestContext, f: Fixture, files: { readonly global?: string; readonly system?: string },
): Promise<void> => {
  const names = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'] as const
  const saved = names.map((name) => [name, process.env[name]] as const)
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const global = join(f.base, 'user.gitconfig')
  const system = join(f.base, 'system.gitconfig')
  await writeFile(global, files.global ?? '')
  await writeFile(system, files.system ?? '')
  process.env['GIT_CONFIG_GLOBAL'] = global
  process.env['GIT_CONFIG_SYSTEM'] = system
  delete process.env['GIT_CONFIG_NOSYSTEM']
}

const inScope = (scope: 'global' | 'system', text: string): { readonly global?: string; readonly system?: string } =>
  scope === 'global' ? { global: text } : { system: text }

/**
 * A filter a person's configuration could hold, as a pair of `sed` programs:
 * what is committed starts `short:` and what is checked out starts `expanded:`.
 * A file that went through one cannot be judged without running it.
 */
const converter = (name: string, extra = ''): string =>
  `[filter "${name}"]\n\tclean = sed 's/^expanded:/short:/'\n\tsmudge = sed 's/^short:/expanded:/'\n${extra}`

/** A filter that changes nothing and leaves a mark when git starts it; `f.script` is the program. */
const marking = async (f: Fixture, extra = ''): Promise<string> => {
  await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\ncat\n')
  const program = JSON.stringify(f.script)
  return `[filter "p"]\n\tclean = ${program}\n\tsmudge = ${program}\n${extra}`
}

/** A commit whose tracked `data.dat` goes through the driver `name`, stored short and checked out expanded. */
const convertedCommit = async (f: Fixture, name = 'p'): Promise<string> => {
  await writeFile(join(f.root, '.gitattributes'), `*.dat filter=${name}\n`)
  await writeFile(join(f.root, 'data.dat'), 'expanded:hello\n')
  await f.git('add', '.')
  await f.git('commit', '-qm', 'Add a converted file')
  return f.git('rev-parse', 'HEAD')
}

/** Newer than the index remembers, so git has to read the file's content to know it is unchanged. */
const touched = async (path: string): Promise<void> => {
  const later = new Date(Date.now() + 5_000)
  await utimes(path, later, later)
}

test('consecutive views use the current user filter and report config errors', async (t) => {
  const f = await fixture(t)
  await userConfig(t, f, { global: await marking(f) })
  await convertedCommit(f)
  await rm(`${f.script}.mark`, { force: true })
  await touched(join(f.root, 'data.dat'))
  await readGit(f.root, ['status', '--porcelain'])
  assert.equal(await f.marker(), 'called')

  await rm(`${f.script}.mark`)
  await writeFile(join(f.base, 'user.gitconfig'), '')
  await touched(join(f.root, 'data.dat'))
  await readGit(f.root, ['status', '--porcelain'])
  assert.equal(await f.marker(), '', 'a removed user filter is not executed on the next view')

  await writeFile(join(f.base, 'user.gitconfig'), '[broken\n')
  await assert.rejects(readGit(f.root, ['status', '--porcelain']), /bad config|config file/i)
})

for (const scope of ['global', 'system'] as const) {
  test(`a filter the ${scope} configuration defines converts a touched file when status reads it`, async (t) => {
    const f = await fixture(t)
    await userConfig(t, f, inScope(scope, converter('p')))
    await convertedCommit(f)
    assert.equal(await f.git('cat-file', 'blob', 'HEAD:data.dat'), 'short:hello', 'the stand-in stored the short form')
    await touched(join(f.root, 'data.dat'))
    assert.deepEqual((await status(f.root))?.files, [])
    assert.equal((await readGit(f.root, ['status', '--porcelain=v1'])).stdout, '')
    await writeFile(join(f.root, 'data.dat'), 'expanded:changed\n')
    assert.deepEqual((await status(f.root))?.files.map((file) => file.path), ['data.dat'], 'a real change is still seen')
  })

  test(`a filter the ${scope} configuration conditionally includes for this repository is honoured`, async (t) => {
    const f = await fixture(t)
    const more = join(f.base, 'conditional-filters.gitconfig')
    await writeFile(more, converter('p'))
    await userConfig(t, f, inScope(scope,
      `[includeIf ${JSON.stringify(`gitdir:${f.root}/`)}]\n\tpath = ${JSON.stringify(more)}\n`))
    const at = await convertedCommit(f)
    assert.equal(await f.git('cat-file', 'blob', 'HEAD:data.dat'), 'short:hello')
    await touched(join(f.root, 'data.dat'))
    assert.deepEqual((await status(f.root))?.files, [])
    const tree = await createDetached(f.root, { name: 'conditional-user', at, stateDir: join(f.base, 'state') })
    assert.equal(await readFile(join(tree, 'data.dat'), 'utf8'), 'expanded:hello\n')
  })

  for (const detached of [false, true]) {
    test(`a ${detached ? 'detached ' : ''}lane is cut from a tree that names a filter the ${scope} configuration defines`, async (t) => {
      const f = await fixture(t)
      await userConfig(t, f, inScope(scope, converter('p')))
      const at = await convertedCommit(f)
      const stateDir = join(f.base, 'state')
      const tree = detached
        ? await createDetached(f.root, { name: 'converted', at, stateDir })
        : (await create(f.root, { name: 'converted', stateDir })).path
      assert.equal(await readFile(join(tree, 'data.dat'), 'utf8'), 'expanded:hello\n', 'converted on the way out')
      assert.equal((await readGit(tree, ['status', '--porcelain=v1'])).stdout, '')
      assert.equal((await run('git', ['-C', tree, 'status', '--porcelain'])).stdout, '', 'and git itself agrees')
    })
  }
}

test("a filter in a file the person's configuration includes counts as the person's own", async (t) => {
  const f = await fixture(t)
  const more = join(f.base, 'filters.gitconfig')
  await writeFile(more, converter('p'))
  await userConfig(t, f, { global: `[include]\n\tpath = ${JSON.stringify(more)}\n` })
  const at = await convertedCommit(f)
  const tree = await createDetached(f.root, { name: 'included', at, stateDir: join(f.base, 'state') })
  assert.equal(await readFile(join(tree, 'data.dat'), 'utf8'), 'expanded:hello\n')
})

test('a filter only the repository defines never runs, and a tree that names it is still refused', async (t) => {
  const f = await fixture(t)
  await userConfig(t, f, { global: converter('p') })
  await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\ncat\n')
  await writeFile(join(f.root, '.gitattributes'), '*.dat filter=q\n')
  await writeFile(join(f.root, 'data.dat'), 'expanded:hello\n')
  await f.git('add', '.')
  await f.git('commit', '-qm', 'Name a filter nobody has defined yet')
  const at = await f.git('rev-parse', 'HEAD')
  await f.git('config', 'filter.q.clean', f.script)
  await f.git('config', 'filter.q.smudge', f.script)
  await touched(join(f.root, 'data.dat'))
  const stateDir = join(f.base, 'state')
  assert.deepEqual((await status(f.root))?.files, [])
  await assert.rejects(create(f.root, { name: 'needs-q', stateDir }), /filter/i)
  await assert.rejects(createDetached(f.root, { name: 'needs-q', at, stateDir }), /filter/i)
  assert.equal(await f.marker(), '', 'the repository program never started')
  assert.equal(await f.git('branch', '--list', 'harnessdesk/needs-q'), '')
})

test('a repository cannot replace or add to a filter the person defines', async (t) => {
  const f = await fixture(t)
  await userConfig(t, f, { global: converter('p') })
  await convertedCommit(f)
  await writeFile(f.script, '#!/bin/sh\nprintf called > "$0.mark"\ncat\n')
  await f.git('config', 'filter.p.clean', f.script)
  await f.git('config', 'filter.p.smudge', f.script)
  await f.git('config', 'filter.p.process', f.script)
  await f.git('config', 'filter.p.required', 'true')
  await touched(join(f.root, 'data.dat'))
  assert.deepEqual((await status(f.root))?.files, [], "the person's program converted it, not the repository's")
  const tree = (await create(f.root, { name: 'kept', stateDir: join(f.base, 'state') })).path
  assert.equal(await readFile(join(tree, 'data.dat'), 'utf8'), 'expanded:hello\n')
  assert.equal(await f.marker(), '', 'the repository program never started')
})

test("the system configuration is not read when the person's own git would not read it", async (t) => {
  const f = await fixture(t)
  await userConfig(t, f, { system: converter('p') })
  await convertedCommit(f)
  process.env['GIT_CONFIG_NOSYSTEM'] = '1'
  await assert.rejects(create(f.root, { name: 'no-system', stateDir: join(f.base, 'state') }), /filter/i)
  assert.equal(await f.git('branch', '--list', 'harnessdesk/no-system'), '')
})

test('a person with no global or system configuration file still gets status and lanes', async (t) => {
  const f = await fixture(t)
  await userConfig(t, f, {})
  process.env['GIT_CONFIG_GLOBAL'] = join(f.base, 'absent-global.gitconfig')
  process.env['GIT_CONFIG_SYSTEM'] = join(f.base, 'absent-system.gitconfig')
  await writeFile(join(f.root, 'page.txt'), 'changed\n')
  assert.deepEqual((await status(f.root))?.files.map((file) => file.path), ['page.txt'])
  const tree = (await create(f.root, { name: 'bare', stateDir: join(f.base, 'state') })).path
  assert.equal(await readFile(join(tree, 'page.txt'), 'utf8'), 'page\n')
})

for (const scope of ['global', 'system'] as const) {
  for (const absent of ['missing file']) {
    test(`an empty ${scope} filter scope through a Git wrapper allows status and lanes: ${absent}`, async (t) => {
      const f = await fixture(t)
      await userConfig(t, f, {})
      process.env[scope === 'global' ? 'GIT_CONFIG_GLOBAL' : 'GIT_CONFIG_SYSTEM'] = join(f.base, `absent-${scope}.gitconfig`)
      const answer = `process.stderr.write("unable to read config file 'test': No such file or directory"); process.exit(128)`
      await withGitShim(f, `
        if (args.includes('config') && args.includes('--${scope}')) { ${answer} }
      `, async () => {
        assert.equal((await readGit(f.root, ['status', '--porcelain=v1'])).stdout, '')
        await writeFile(join(f.root, 'page.txt'), 'changed\n')
        assert.deepEqual((await status(f.root))?.files.map((file) => file.path), ['page.txt'])
        const tree = (await create(f.root, { name: 'empty-scope', stateDir: join(f.base, 'state') })).path
        assert.equal(await readFile(join(tree, 'page.txt'), 'utf8'), 'page\n')
        assert.equal(await f.marker(), '', 'no filter program started')
      })
    })
  }
}

for (const failure of [
  { label: 'silent exit 1', code: 1, stderr: '' },
  { label: 'permission denied', code: 128, stderr: "unable to read config file 'test': Permission denied" },
  { label: 'not a directory', code: 128, stderr: "unable to read config file 'test': Not a directory" },
  { label: 'exit 1 missing file', code: 1, stderr: "unable to read config file 'test': No such file or directory" },
]) {
  test(`user config failure is visible: ${failure.label}`, async (t) => {
    const f = await fixture(t)
    await userConfig(t, f, {})
    await withGitShim(f, `if (args.includes('config') && args.includes('--global')) { process.stderr.write(${JSON.stringify(failure.stderr)}); process.exit(${failure.code}) }`, async () => {
      await assert.rejects(readGit(f.root, ['status', '--porcelain=v1']))
    })
  })
}

test('removing a lane does not start a filter the person defines', async (t) => {
  const f = await fixture(t)
  await userConfig(t, f, { global: await marking(f, '\trequired = true\n') })
  await convertedCommit(f)
  const tree = (await create(f.root, { name: 'plain', stateDir: join(f.base, 'state') })).path
  await rm(`${f.script}.mark`, { force: true }) // cutting the lane ran it
  await touched(join(tree, 'data.dat'))
  await readGit(f.root, ['worktree', 'remove', tree])
  await assert.rejects(stat(tree), { code: 'ENOENT' })
  assert.equal(await f.marker(), '', 'git removed the lane without starting the program')
})

test('a filter the person defines that no longer works does not keep a lane from being discarded', async (t) => {
  const f = await fixture(t)
  const stateDir = join(f.base, 'state')
  await userConfig(t, f, { global: converter('p', '\trequired = true\n') })
  await convertedCommit(f)
  const tree = (await create(f.root, { name: 'stale', stateDir })).path
  // The program is gone, but the configuration still says the file cannot be read without it.
  await writeFile(join(f.base, 'user.gitconfig'), '[filter "p"]\n\tclean = exit 1\n\tsmudge = exit 1\n\trequired = true\n')
  await touched(join(tree, 'data.dat'))
  assert.deepEqual((await changes(tree)).files, ['data.dat'], 'it reads as changed, which is the safe answer')
  await assert.rejects(remove(tree, { stateDir }), WorktreeDirtyError)
  await remove(tree, { stateDir, force: true })
  await assert.rejects(stat(tree), { code: 'ENOENT' })
})
