import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { commitCardWork } from '../src/card-commit.js'
import { revisionOf } from '../src/evidence/revision.js'
import { repositoryOf } from '../src/worktree.js'

/**
 * Issue #1074, against real repositories. The host commits a card's own work
 * for its Seat (`commit_work`) instead of a sandbox being widened to `.git`,
 * which would hand the agent the repository's configuration and hooks. So the
 * commit takes only what changed since the claim, stores the agent's message
 * as text, and runs git so nothing the repository configures can run — and
 * the host's own git reads of a checkout an agent can write are held to the
 * same floor.
 */

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> => (await run('git', ['-C', cwd, ...args])).stdout

const repo = async (t: TestContext): Promise<string> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'harnessdesk-card-commit-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'repo')
  await run('git', ['init', '-q', '-b', 'main', root])
  await git(root, 'config', 'user.name', 'Jane Doe')
  await git(root, 'config', 'user.email', 'dev@example.com')
  await writeFile(join(root, 'shared.txt'), 'original\n')
  await writeFile(join(root, 'a.txt'), 'a\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'init')
  return root
}

/** The claim's snapshot, read the way the desk reads it at claim. */
const snapshot = async (cwd: string): Promise<readonly string[]> => (await revisionOf(cwd))!.dirtyPaths!

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

test('commit_work commits only what changed since the claim, and leaves what was already dirty', async (t) => {
  const root = await repo(t)
  // Somebody's own leftovers, there before the card was claimed.
  await writeFile(join(root, '.env'), 'SECRET=1\n')
  await writeFile(join(root, 'shared.txt'), 'edited by a person\n')
  const before = await snapshot(root)
  // The card's own work.
  await writeFile(join(root, 'notes.md'), '# Notes\n')
  await writeFile(join(root, 'a.txt'), 'a, changed\n')

  const done = await commitCardWork(root, before, 'Write the notes')
  assert.ok('commit' in done, JSON.stringify(done))
  assert.equal(done.commit, (await git(root, 'rev-parse', 'HEAD')).trim())
  assert.deepEqual((await git(root, 'show', '--name-only', '--format=', 'HEAD')).trim().split('\n').sort(), ['a.txt', 'notes.md'])
  const left = (await git(root, 'status', '--porcelain=v1')).split('\n').filter(Boolean).sort()
  assert.deepEqual(left, [' M shared.txt', '?? .env'], 'what was dirty at the claim is still dirty, and not committed')
  assert.equal((await git(root, 'log', '-1', '--format=%an <%ae>')).trim(), 'Jane Doe <dev@example.com>', 'the checkout’s configured author')

  assert.deepEqual(await commitCardWork(root, before, 'Again'), {
    refused: 'Nothing to commit: no file changed since this card was claimed is uncommitted.',
  })
})

test('a message with shell metacharacters and newlines is stored exactly as written', async (t) => {
  const root = await repo(t)
  const before = await snapshot(root)
  await writeFile(join(root, 'notes.md'), 'x\n')
  const message = 'Subject; $(touch pwned) `id` && rm -rf / | cat\n\n# not a comment\n  indented "quoted" \'single\' \\ back\n-F --amend\n'
  const done = await commitCardWork(root, before, message)
  assert.ok('commit' in done, JSON.stringify(done))
  assert.equal(await git(root, 'log', '-1', '--format=%B'), `${message}\n`)
  assert.equal(await exists(join(root, 'pwned')), false)
})

test('a poisoned repository configuration runs nothing — not in commit_work, not in the host’s own git reads', async (t) => {
  const root = await repo(t)
  const marker = join(root, '..', 'ran')
  const script = join(root, '..', 'evil.sh')
  await writeFile(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 0\n`)
  await chmod(script, 0o755)
  const hooks = join(root, '..', 'hooks')
  await mkdir(hooks)
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change']) {
    await writeFile(join(hooks, hook), `#!/bin/sh\necho ${hook} >> '${marker}'\n`)
    await chmod(join(hooks, hook), 0o755)
  }
  await git(root, 'config', 'core.fsmonitor', script)
  await git(root, 'config', 'core.hooksPath', hooks)
  await git(root, 'config', 'filter.evil.clean', script)
  await git(root, 'config', 'filter.evil.process', script)
  await git(root, 'config', 'commit.gpgSign', 'true')
  await git(root, 'config', 'gpg.program', script)
  await writeFile(join(root, '.gitattributes'), '*.md filter=evil\n')
  // The same checkout as a lane sees it, too.
  const lane = join(root, '..', 'lane')
  await run('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'lane', lane])
  await rm(marker, { force: true })

  const before = await snapshot(root)
  await revisionOf(lane)
  await repositoryOf(lane)
  assert.equal(await exists(marker), false, 'the host’s own reads ran nothing')

  await writeFile(join(root, 'notes.md'), '# Notes\n')
  const done = await commitCardWork(root, before, 'Write the notes')
  assert.ok('commit' in done, JSON.stringify(done))
  assert.equal(await exists(marker), false, `nothing ran: ${await readFile(marker, 'utf8').catch(() => '')}`)
})

test('commit_work commits inside a worktree lane, on the lane’s branch', async (t) => {
  const root = await repo(t)
  const lane = join(root, '..', 'lane')
  await git(root, 'worktree', 'add', '-q', '-b', 'lane', lane)
  const main = (await git(root, 'rev-parse', 'main')).trim()
  const before = await snapshot(lane)
  await mkdir(join(lane, 'docs'))
  await writeFile(join(lane, 'docs', 'answer.md'), '# Answer\n')

  const done = await commitCardWork(lane, before, 'Answer the question')
  assert.ok('commit' in done, JSON.stringify(done))
  assert.equal((await git(root, 'rev-parse', 'lane')).trim(), done.commit, 'the lane’s branch moved')
  assert.equal((await git(root, 'rev-parse', 'main')).trim(), main, 'and the main checkout’s did not')
  assert.deepEqual((await git(lane, 'show', '--name-only', '--format=', 'HEAD')).trim(), 'docs/answer.md')
})

test('commit_work refuses an empty or oversized message, and a checkout with no author', async (t) => {
  const root = await repo(t)
  const before = await snapshot(root)
  await writeFile(join(root, 'notes.md'), 'x\n')
  assert.match(JSON.stringify(await commitCardWork(root, before, '  \n')), /needs a message/)
  assert.match(JSON.stringify(await commitCardWork(root, before, 'x'.repeat(8_001))), /longer than 8000 characters/)

  await git(root, 'config', '--unset', 'user.name')
  const saved = { global: process.env['GIT_CONFIG_GLOBAL'], system: process.env['GIT_CONFIG_NOSYSTEM'] }
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null'
  process.env['GIT_CONFIG_NOSYSTEM'] = '1'
  t.after(() => {
    for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.system]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  assert.deepEqual(await commitCardWork(root, before, 'No author'), {
    refused: 'Refused: this checkout has no git author (user.name and user.email), so nothing was committed. Set one, then call commit_work again.',
  })
  assert.equal((await git(root, 'rev-list', '--count', 'HEAD')).trim(), '1', 'nothing was committed')
})
