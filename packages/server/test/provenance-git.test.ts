import assert from 'node:assert/strict'
import { access, appendFile, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  admitProject, gitReader, oid, runChild, type GitReader,
} from '../src/provenance/git.js'
import { makeRepo, type Repo } from './fixtures/provenance-repo.js'

const signal = () => new AbortController().signal
const readerFor = async (repo: Repo): Promise<GitReader> =>
  gitReader(await admitProject(repo.dir, repo.stateDir, [repo.dir]))
const absent = async (path: string) => assert.rejects(access(path), { code: 'ENOENT' })

test('only full object IDs reach object-reading commands', () => {
  for (const value of ['HEAD~1', '--output=/work/escape', 'a'.repeat(41), 'A'.repeat(40)]) {
    assert.throws(() => oid(value), /Expected a full object id/)
  }
  assert.equal(oid('a'.repeat(40)), 'a'.repeat(40))
  assert.equal(oid('b'.repeat(64)), 'b'.repeat(64))
})

test('root, message amend and whitespace fingerprints use real immutable objects', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const first = await repo.commitTree(base, { one: 'base\nseat one\n' }, 'first')
  const amended = await repo.git('commit-tree', `${first}^{tree}`, '-p', base, '-m', '$(touch escaped)')
  const whitespace = await repo.commitTree(base, { one: 'base\nseat  one\n' }, 'whitespace')
  const empty = await repo.commitTree(first, {}, 'empty')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  const patch = await reader.patch(base, first, signal())
  assert.deepEqual(await reader.patch(base, amended, signal()), patch)
  const spaced = await reader.patch(base, whitespace, signal())
  assert.equal(spaced.stable, patch.stable)
  assert.notEqual(spaced.exact, patch.exact)
  assert.deepEqual((await reader.patch(null, base, signal())).files, ['one'])
  assert.deepEqual(await reader.patch(first, empty, signal()), { stable: '', exact: '', files: [] })
  assert.deepEqual((await reader.commit(first, signal()))?.parents, [base])
  assert.equal(await reader.commit('f'.repeat(40), signal()), null)
  await absent(join(repo.dir, 'escaped'))
})

test('binary, mode, Unicode, newline, option-like, symlink and gitlink paths stay object data', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.commitTree(base, {
    '--output=elsewhere': 'literal\n', 'line\nbreak': 'newline\n', '雪': 'unicode\n',
    binary: Buffer.from([0, 255, 1]),
  }, 'populate index')
  const blob = await repo.input(['hash-object', '-w', '--stdin'], '/work/outside')
  await repo.git('update-index', '--add', '--cacheinfo', '120000', blob, 'link')
  await repo.git('update-index', '--add', '--cacheinfo', '160000', base, 'module')
  await repo.git('update-index', '--cacheinfo', '100755', await repo.git('rev-parse', `${base}:one`), 'one')
  const target = await repo.git('commit-tree', await repo.git('write-tree'), '-p', base, '-m', 'special entries')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  const files = await reader.files(base, target, signal())
  assert.deepEqual(files.map((file) => file.path), [
    '--output=elsewhere', 'binary', 'line\nbreak', 'link', 'module', 'one', '雪',
  ])
  assert.ok(files.every((file) => file.stable && file.exact))
  await absent(join(repo.dir, 'elsewhere'))
  await absent(join(repo.dir, 'link'))
})

test('invalid UTF-8 tree names are refused instead of being aliased', async (t) => {
  const repo = await makeRepo()
  const blob = await repo.input(['hash-object', '-w', '--stdin'], 'bytes')
  const tree = await repo.input(['mktree', '-z'], Buffer.concat([
    Buffer.from(`100644 blob ${blob}\t`), Buffer.from([255, 0]),
  ]))
  const commit = await repo.git('commit-tree', tree, '-m', 'invalid path bytes')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  await assert.rejects(reader.files(null, commit, signal()), /unsupported-path/)
})

test('private configuration ignores source commands, include files and replacement refs', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const target = await repo.commitTree(base, { one: 'changed\n', '.gitattributes': '* diff=evil\n' }, 'change')
  const marker = join(repo.stateDir, 'executed')
  const helper = join(repo.stateDir, 'helper.sh')
  await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 })
  await repo.git('config', 'diff.external', helper)
  await repo.git('config', 'diff.evil.textconv', helper)
  await repo.git('config', 'include.path', join(repo.stateDir, 'absent-config'))
  await repo.git('replace', target, base)
  await appendFile(join(repo.dir, '.git/config'), '\n[core]\nrepositoryformatversion = 999\n')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  assert.deepEqual((await reader.patch(base, target, signal())).files, ['.gitattributes', 'one'])
  await reader.files(base, target, signal())
  await absent(marker)
})

test('symlinked metadata, alternates, external gitdirs and unsupported storage are refused', async () => {
  const linked = await makeRepo()
  await symlink(linked.stateDir, join(linked.dir, '.git/objects/outside'))
  await assert.rejects(admitProject(linked.dir, linked.stateDir, [linked.dir]), /Linked metadata/)
  const alternate = await makeRepo()
  await writeFile(join(alternate.dir, '.git/objects/info/alternates'), alternate.stateDir)
  await assert.rejects(admitProject(alternate.dir, alternate.stateDir, [alternate.dir]), /external-objects/)
  const external = await makeRepo()
  await rename(join(external.dir, '.git'), join(external.stateDir, 'metadata'))
  await writeFile(join(external.dir, '.git'), `gitdir: ${join(external.stateDir, 'metadata')}\n`)
  await assert.rejects(admitProject(external.dir, external.stateDir, [external.dir]), /Open its main checkout/)
  const storage = await makeRepo()
  await appendFile(join(storage.dir, '.git/config'), '\n[extensions]\nrefStorage = reftable\n')
  await assert.rejects(admitProject(storage.dir, storage.stateDir, [storage.dir]), /unsupported-ref-storage/)
  const format = await makeRepo()
  await appendFile(join(format.dir, '.git/config'), '\n[extensions]\nobjectFormat = other\n')
  await assert.rejects(admitProject(format.dir, format.stateDir, [format.dir]), /unsupported-object-format/)
})

test('linked worktrees require an explicit root and the common-directory backlink', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const linked = join(dirname(repo.dir), 'linked')
  await repo.git('worktree', 'add', '-q', '--detach', linked, base)
  await assert.rejects(admitProject(linked, repo.stateDir, [linked]), /Open its main checkout/)
  const handle = await admitProject(linked, repo.stateDir, [repo.dir, linked])
  assert.equal(handle.project, repo.dir)
  assert.equal(handle.checkouts.size, 2)
  const reader = gitReader(handle)
  t.after(() => reader.close())
  assert.equal((await reader.snapshot(signal())).heads.get(linked), base)
  const gitdir = handle.checkouts.get(linked)!
  await writeFile(join(gitdir, 'gitdir'), join(repo.stateDir, 'not-a-checkout'))
  await assert.rejects(reader.snapshot(signal()), /metadata-changed/)
})

test('loose and packed refs preserve raw tags and peel HEAD without trusting names as paths', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  await repo.git('tag', '-a', 'v1', base, '-m', 'tag')
  const tag = await repo.git('rev-parse', 'refs/tags/v1')
  await repo.git('pack-refs', '--all')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  const snapshot = await reader.snapshot(signal())
  assert.equal(snapshot.refs.get('refs/tags/v1'), tag)
  assert.equal(snapshot.heads.get(repo.dir), base)
  await mkdir(join(repo.dir, '.git/refs/heads'), { recursive: true })
  await writeFile(join(repo.dir, '.git/refs/heads/cycle-a'), 'ref: refs/heads/cycle-b\n')
  await writeFile(join(repo.dir, '.git/refs/heads/cycle-b'), 'ref: refs/heads/cycle-a\n')
  await assert.rejects(reader.snapshot(signal()), /symbolic-ref-cycle/)
})

test('reflog cursors recover A to B to A and detect replacement and incomplete tails', async (t) => {
  const repo = await makeRepo()
  const a = await repo.commitTree(null, { one: 'a\n' }, 'a')
  const b = await repo.commitTree(a, { one: 'b\n' }, 'b')
  await repo.git('update-ref', '--create-reflog', 'refs/heads/topic', a)
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  const first = await reader.reflogs(new Map(), signal())
  await repo.git('update-ref', 'refs/heads/topic', b)
  await repo.git('update-ref', 'refs/heads/topic', a)
  const second = await reader.reflogs(first.cursors, signal())
  assert.deepEqual(second.moves.map((move) => [move.before, move.after]), [[a, b], [b, a]])
  assert.equal(new Set(second.moves.map((move) => move.id)).size, 2)
  assert.deepEqual((await reader.reflogs(second.cursors, signal())).moves, [])
  const log = join(repo.dir, '.git/logs/refs/heads/topic')
  const bytes = await readFile(log)
  await appendFile(log, 'incomplete')
  const partial = await reader.reflogs(second.cursors, signal())
  assert.equal(partial.cursors.get('common:refs/heads/topic')?.offset, bytes.length)
  assert.ok(partial.gaps.includes('incomplete-reflog'))
  await writeFile(`${log}.new`, bytes)
  await rename(`${log}.new`, log)
  const replaced = await reader.reflogs(partial.cursors, signal())
  assert.ok(replaced.gaps.includes('reflog-replaced'))
  await rm(log)
  assert.ok((await reader.reflogs(replaced.cursors, signal())).gaps.includes('reflog-missing'))
})

test('metadata replacement after admission refuses before reading another object', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  await rename(join(repo.dir, '.git/objects'), join(repo.stateDir, 'moved-objects'))
  await symlink(join(repo.stateDir, 'moved-objects'), join(repo.dir, '.git/objects'))
  await assert.rejects(reader.commit(base, signal()), /Linked metadata/)
})

test('bounded children wait for exit on timeout, cancellation and overflow; stderr is never exposed', async () => {
  const controller = new AbortController()
  const running = runChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(running, /capture-aborted/)
  await assert.rejects(runChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: signal(), timeoutMs: 30,
  }), /git-timeout/)
  await assert.rejects(runChild(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
    signal: signal(), stdoutLimit: 64,
  }), /limit-exceeded/)
  await assert.rejects(runChild(process.execPath, ['-e', 'process.stderr.write("private"); process.exit(1)'], {
    signal: signal(),
  }), (error: unknown) => error instanceof Error && error.message === 'git-failed')
  let active = 0
  let maximum = 0
  await Promise.all([1, 2, 3, 4].map(() => runChild(process.execPath, ['-e', 'setTimeout(() => {}, 30)'], {
    signal: signal(),
    started: () => { active += 1; maximum = Math.max(maximum, active) },
    stopped: () => { active -= 1 },
  })))
  assert.equal(maximum, 2)
  assert.equal(active, 0)
})

test('ancestors are bounded, stop at known objects and close removes only the private view', async () => {
  const repo = await makeRepo()
  const a = await repo.commitTree(null, { one: 'a\n' }, 'a')
  const b = await repo.commitTree(a, { one: 'b\n' }, 'b')
  const c = await repo.commitTree(b, { one: 'c\n' }, 'c')
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const reader = gitReader(handle)
  assert.deepEqual(await reader.ancestors([c], new Set([a]), 2, signal()), [b, c])
  assert.equal((await reader.ancestors([c], new Set(), 1, signal())).length, 1)
  await reader.close()
  await absent(handle.viewDir)
  await access(join(repo.dir, '.git/objects'))
  await assert.rejects(reader.commit(c, signal()), /capture-aborted/)
})

test('SHA-256 repositories use their own object width and private-view format', async (t) => {
  let repo: Repo
  try {
    repo = await makeRepo('sha256')
  } catch (error) {
    if (error instanceof Error && /unknown hash algorithm|unknown option.*object-format/.test(error.message)) {
      t.skip('installed Git does not support SHA-256 repositories')
      return
    }
    throw error
  }
  const a = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const b = await repo.commitTree(a, { one: 'changed\n' }, 'changed')
  const reader = await readerFor(repo)
  t.after(() => reader.close())
  assert.equal(a.length, 64)
  assert.deepEqual((await reader.patch(a, b, signal())).files, ['one'])
})


test('unrelated registered folders do not prevent admitting this project', async () => {
  const repo = await makeRepo()
  const other = await makeRepo()
  await rename(join(other.dir, '.git'), join(other.stateDir, 'separate'))
  await writeFile(join(other.dir, '.git'), `gitdir: ${join(other.stateDir, 'separate')}\n`)
  const handle = await admitProject(repo.dir, repo.stateDir, [
    repo.dir, other.dir, other.stateDir, join(other.stateDir, 'missing'),
  ])
  assert.equal(handle.project, repo.dir)
  assert.equal(handle.checkouts.size, 1)
  await gitReader(handle).close()
})
