import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { readTriggerBlob, readTriggerSource, type TriggerGit } from '../src/intake/source.js'
import { tempDir } from './scratch.js'

/*
 * A triggers file is policy that arrived with a clone. It is read only as
 * committed, one immutable object at a time, and anything that is not a
 * regular committed text file in a real committed folder is refused before a
 * parser or a consent ever sees it.
 */

const run = promisify(execFile)
const ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Jane Doe',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Jane Doe',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
}

const TRIGGERS = '- id: review\n  on: pull-request\n  opens: { flow: review-pr }\n'

const repo = async (): Promise<{ dir: string; git: (...args: string[]) => Promise<string> }> => {
  const dir = join(await realpath(tempDir('hd-intake-source-')), 'project')
  await mkdir(dir)
  const git = async (...args: string[]): Promise<string> => (await run('git', ['-C', dir, ...args], { env: ENV })).stdout.trim()
  await git('init', '-q', '-b', 'main')
  return { dir, git }
}

test('reads one committed regular blob', async () => {
  const { dir, git } = await repo()
  // No commit yet, and no file: nothing to read, nothing written.
  const empty = await readTriggerSource(dir)
  assert.equal(empty.revision, null)
  assert.equal(empty.text, null)
  assert.equal(empty.workingCopyChanged, false)

  await mkdir(join(dir, '.harnessdesk'))
  await writeFile(join(dir, '.harnessdesk', 'triggers.yml'), TRIGGERS)
  await git('add', '.')
  await git('commit', '-q', '-m', 'triggers')
  const head = await git('rev-parse', 'HEAD')
  const clean = await readTriggerSource(dir)
  assert.equal(clean.project, dir)
  assert.equal(clean.revision, head)
  assert.equal(clean.text, TRIGGERS)
  assert.match(clean.sourceDigest ?? '', /^[a-f0-9]{64}$/)
  assert.equal(clean.workingCopyChanged, false)

  // A working-copy edit is said, never read: the committed bytes are what runs.
  await writeFile(join(dir, '.harnessdesk', 'triggers.yml'), `${TRIGGERS}  concurrency: 32\n`)
  const dirty = await readTriggerSource(dir)
  assert.equal(dirty.text, TRIGGERS)
  assert.equal(dirty.sourceDigest, clean.sourceDigest)
  assert.equal(dirty.workingCopyChanged, true)
  // A file that exists only in the working copy is not committed policy.
  await git('rm', '-q', '--cached', '.harnessdesk/triggers.yml')
  await git('commit', '-q', '-m', 'untrack')
  const uncommitted = await readTriggerSource(dir)
  assert.equal(uncommitted.text, null)
  assert.equal(uncommitted.workingCopyChanged, true)

  // A reclone at the same path is a different project incarnation.
  const moved = `${dir}-old`
  await rename(dir, moved)
  await mkdir(dir)
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main'], { env: ENV })
  const recloned = await readTriggerSource(dir)
  assert.equal(recloned.project, dir)
  assert.notEqual(recloned.incarnation, clean.incarnation)
  // A moved folder is the same clone, under another project path.
  const movedSource = await readTriggerSource(moved)
  assert.equal(movedSource.incarnation, clean.incarnation)
  assert.equal(movedSource.project, moved)
  await rm(moved, { recursive: true, force: true })
})

test('links and invalid encodings never become declarations', async () => {
  const refused = async (setup: (dir: string, git: (...args: string[]) => Promise<string>) => Promise<void>, pattern: RegExp): Promise<void> => {
    const { dir, git } = await repo()
    await setup(dir, git)
    await git('add', '-A')
    await git('commit', '-q', '-m', 'setup')
    await assert.rejects(readTriggerSource(dir), pattern)
  }
  const regular = /Triggers must be a regular committed file in a committed directory/
  // `.harnessdesk` committed as a link to a folder elsewhere.
  await refused(async (dir) => {
    await mkdir(join(dir, 'elsewhere'))
    await writeFile(join(dir, 'elsewhere', 'triggers.yml'), TRIGGERS)
    await symlink('elsewhere', join(dir, '.harnessdesk'))
  }, regular)
  // `triggers.yml` committed as a link to a file elsewhere.
  await refused(async (dir) => {
    await mkdir(join(dir, '.harnessdesk'))
    await writeFile(join(dir, 'other.yml'), TRIGGERS)
    await symlink('../other.yml', join(dir, '.harnessdesk', 'triggers.yml'))
  }, regular)
  // An executable file.
  await refused(async (dir, git) => {
    await mkdir(join(dir, '.harnessdesk'))
    await writeFile(join(dir, '.harnessdesk', 'triggers.yml'), TRIGGERS)
    await chmod(join(dir, '.harnessdesk', 'triggers.yml'), 0o755)
    await git('config', 'core.fileMode', 'true')
  }, regular)
  // `triggers.yml` committed as a folder.
  await refused(async (dir) => {
    await mkdir(join(dir, '.harnessdesk', 'triggers.yml'), { recursive: true })
    await writeFile(join(dir, '.harnessdesk', 'triggers.yml', 'inner'), TRIGGERS)
  }, regular)
  // Larger than 64 KiB.
  await refused(async (dir) => {
    await mkdir(join(dir, '.harnessdesk'))
    await writeFile(join(dir, '.harnessdesk', 'triggers.yml'), `# ${'x'.repeat(65536)}\n`)
  }, /Triggers must fit in 64 KiB/)
  // Not UTF-8.
  await refused(async (dir) => {
    await mkdir(join(dir, '.harnessdesk'))
    await writeFile(join(dir, '.harnessdesk', 'triggers.yml'), Buffer.from([0x2d, 0x20, 0xff, 0xfe, 0x0a]))
  }, /not UTF-8 text/)

  // A short read — git answered fewer bytes than the size it reported.
  const tree = 'a'.repeat(40)
  const blob = 'b'.repeat(40)
  const short: TriggerGit = {
    read: async (args) => {
      const text = args[0] === 'ls-tree'
        ? args[2] === 'c'.repeat(40) ? `040000 tree ${tree}\t.harnessdesk\0` : `100644 blob ${blob}\ttriggers.yml\0`
        : args[1] === '-s' ? '10\n' : 'short'
      return new TextEncoder().encode(text)
    },
  }
  await assert.rejects(readTriggerBlob(short, 'c'.repeat(40)), /changed while it was read/)
})

test('Git arguments contain only fixed paths and validated object IDs', async () => {
  const calls: (readonly string[])[] = []
  const answering = (listing: (tree: string) => string): TriggerGit => ({
    read: async (args) => {
      calls.push(args)
      return new TextEncoder().encode(args[0] === 'ls-tree' ? listing(args[2]!) : args[1] === '-s' ? '0\n' : '')
    },
  })
  const good = 'c'.repeat(40)
  // A revision that is not an object id is refused before git is asked anything.
  for (const revision of ['HEAD', '--output=/tmp/x', `${good}^{tree}`, `${good} ${good}`, 'C'.repeat(40), '']) {
    calls.length = 0
    await assert.rejects(readTriggerBlob(answering(() => ''), revision), /revision is invalid/)
    assert.equal(calls.length, 0, `nothing read for ${JSON.stringify(revision)}`)
  }
  // A tree answer naming anything but the fixed entry, or carrying a bad id,
  // stops the read: no object it names is ever read.
  const hostile = [
    `040000 tree ${'d'.repeat(40)}\t../.harnessdesk\0`,
    `040000 tree ${'d'.repeat(40)}\t.harnessdesk/../x\0`,
    `040000 tree --output=/tmp/x\t.harnessdesk\0`,
    `040000 tree ${'D'.repeat(40)}\t.harnessdesk\0`,
    `040000 tree ${'d'.repeat(40)}\t.harnessdesk\x00040000 tree ${'e'.repeat(40)}\t.harnessdesk\0`,
    `160000 commit ${'d'.repeat(40)}\t.harnessdesk\0`,
    `120000 blob ${'d'.repeat(40)}\t.harnessdesk\0`,
    `040000 tree ${'d'.repeat(40)}\t.harnessdesk`,
  ]
  for (const listing of hostile) {
    calls.length = 0
    await assert.rejects(readTriggerBlob(answering(() => listing), good), /regular committed file/)
    assert.deepEqual(calls, [['ls-tree', '-z', good, '--', '.harnessdesk']], `one fixed read only for ${JSON.stringify(listing)}`)
  }
  // Every argument the reader sends is fixed or an object id git itself returned.
  calls.length = 0
  const dir = 'd'.repeat(40)
  const blob = 'f'.repeat(40)
  const text = await readTriggerBlob(answering((tree) => tree === good ? `040000 tree ${dir}\t.harnessdesk\0` : `100644 blob ${blob}\ttriggers.yml\0`), good)
  assert.equal(text, '')
  assert.deepEqual(calls, [
    ['ls-tree', '-z', good, '--', '.harnessdesk'],
    ['ls-tree', '-z', dir, '--', 'triggers.yml'],
    ['cat-file', '-s', blob],
    ['cat-file', 'blob', blob],
  ])
})
