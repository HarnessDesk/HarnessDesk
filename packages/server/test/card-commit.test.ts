import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import { commitCardWork } from '../src/card-commit.js'
import { diff as diffOf } from '../src/git.js'
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

/** Parse the stored message with Git's default divider handling, as the commit tool does. */
const parsedTrailers = async (cwd: string): Promise<string> => {
  const message = await git(cwd, 'log', '-1', '--format=%B')
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', cwd, 'interpret-trailers', '--parse'], (error, stdout) =>
      error ? reject(error) : resolve(stdout))
    child.stdin?.end(message)
  })
}

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
  assert.equal((await git(root, 'log', '-1', '--format=%cn <%ce>')).trim(), 'Jane Doe <dev@example.com>', 'the checkout’s configured committer')

  assert.deepEqual(await commitCardWork(root, before, 'Again'), {
    refused: 'Nothing to commit: no file changed since this card was claimed is uncommitted.',
  })
})

const coauthor = 'Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>'

test('commit_work adds exactly one co-author trailer after a blank line', async (t) => {
  for (const ending of ['', '\n', '\n\n', '\r\n']) {
    const root = await repo(t)
    const before = await snapshot(root)
    await writeFile(join(root, 'notes.md'), 'x\n')
    const message = `Write the notes${ending}`
    const done = await commitCardWork(root, before, message)
    assert.ok('commit' in done, JSON.stringify(done))
    const stored = await git(root, 'log', '-1', '--format=%B')
    assert.ok(stored.startsWith(message), 'the supplied message is preserved')
    assert.match(stored, /\r?\n\r?\nCo-authored-by: HarnessDesk Agent <agent@harnessdesk\.app>\n\n$/)
    assert.equal(stored.split(coauthor).length - 1, 1)
    assert.equal((await git(root, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>')).trim(),
      'Jane Doe <dev@example.com>\nJane Doe <dev@example.com>')
    assert.equal((await git(root, 'log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)')).trim(),
      'HarnessDesk Agent <agent@harnessdesk.app>', 'git recognizes the trailer')
  }
})

test('commit_work preserves a message that already carries the exact co-author trailer', async (t) => {
  for (const newline of ['\n', '\r\n']) {
    for (const ending of ['', newline, `${newline}${newline}`]) {
      const root = await repo(t)
      const before = await snapshot(root)
      await writeFile(join(root, 'notes.md'), 'x\n')
      const message = `Write the notes${newline}${newline}${coauthor}${ending}`
      const done = await commitCardWork(root, before, message)
      assert.ok('commit' in done, JSON.stringify(done))
      const stored = await git(root, 'log', '-1', '--format=%B')
      assert.equal(stored, `${message}\n`)
      assert.equal(stored.split(coauthor).length - 1, 1)
      assert.equal((await git(root, 'log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)')).trim(),
        'HarnessDesk Agent <agent@harnessdesk.app>', 'git recognizes the existing trailer')
    }
  }
})

test('mentioning the co-author text inside the body does not replace the trailer', async (t) => {
  const root = await repo(t)
  const before = await snapshot(root)
  await writeFile(join(root, 'notes.md'), 'x\n')
  const message = `Write the notes\n\nThe tool adds "${coauthor}" itself.`
  const done = await commitCardWork(root, before, message)
  assert.ok('commit' in done, JSON.stringify(done))
  assert.equal(await git(root, 'log', '-1', '--format=%B'), `${message}\n\n${coauthor}\n\n`)
})

test('an exact co-author line outside the final trailer block does not suppress attribution', async (t) => {
  for (const newline of ['\n', '\r\n']) {
    for (const message of [
      `Write the notes${newline}${newline}${coauthor}${newline}${newline}This is quoted credit, followed by more body text.`,
      `Write the notes${newline}${coauthor}`,
      `Write the notes${newline}${newline}This paragraph quotes the credit:${newline}${coauthor}${newline}The explanation continues here.`,
    ]) {
      const root = await repo(t)
      const before = await snapshot(root)
      await writeFile(join(root, 'notes.md'), 'x\n')
      const done = await commitCardWork(root, before, message)
      assert.ok('commit' in done, JSON.stringify(done))
      assert.equal((await git(root, 'log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)')).trim(),
        'HarnessDesk Agent <agent@harnessdesk.app>', 'git recognizes exactly one actual co-author trailer')
      assert.equal(await git(root, 'log', '-1', '--format=%B'), `${message}\n\n${coauthor}\n\n`,
        'the body is preserved and receives a final attribution block')
    }
  }
})

test('an exact co-author trailer alongside other final trailers remains unchanged', async (t) => {
  const root = await repo(t)
  const before = await snapshot(root)
  await writeFile(join(root, 'notes.md'), 'x\n')
  const message = `Write the notes\n\nReviewed-by: Jane Doe <dev@example.com>\n${coauthor}\nSigned-off-by: Jane Doe <dev@example.com>\n`
  const done = await commitCardWork(root, before, message)
  assert.ok('commit' in done, JSON.stringify(done))
  assert.equal(await git(root, 'log', '-1', '--format=%B'), `${message}\n`)
  assert.equal((await git(root, 'log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)')).trim(),
    'HarnessDesk Agent <agent@harnessdesk.app>')
})

test('commit_work inserts parsed credit before Git’s message divider, preserving the suffix', async (t) => {
  for (const newline of ['\n', '\r\n']) {
    for (const divider of ['---', '--- details', '---\tdetails']) {
      const root = await repo(t)
      const before = await snapshot(root)
      await writeFile(join(root, 'notes.md'), 'x\n')
      const body = `Write the notes${newline}${newline}Summary${newline}`
      const suffix = `${divider}${newline}Details${newline}---${newline}More details`
      const done = await commitCardWork(root, before, body + suffix)
      assert.ok('commit' in done, JSON.stringify(done))
      assert.equal(await parsedTrailers(root), `${coauthor}\n`, 'git recognizes exactly one co-author trailer before the divider')
      assert.equal(await git(root, 'log', '-1', '--format=%B'), `${body}\n${coauthor}\n\n${suffix}\n`,
        'all supplied text stays in order around the inserted trailer')
    }
  }
})

test('only existing parsed credit before Git’s message divider suppresses attribution', async (t) => {
  for (const newline of ['\n', '\r\n']) {
    for (const creditedBefore of [true, false]) {
      const root = await repo(t)
      const before = await snapshot(root)
      await writeFile(join(root, 'notes.md'), 'x\n')
      const body = `Write the notes${newline}${newline}Summary${newline}${newline}`
      const suffix = `---${newline}Details${newline}${newline}${coauthor}${newline}`
      const message = creditedBefore ? `${body}${coauthor}${newline}${newline}${suffix}` : body + suffix
      const done = await commitCardWork(root, before, message)
      assert.ok('commit' in done, JSON.stringify(done))
      assert.equal(await parsedTrailers(root), `${coauthor}\n`, 'credit in the ignored suffix does not count as attribution')
      assert.equal(await git(root, 'log', '-1', '--format=%B'),
        creditedBefore ? `${message}\n` : `${body}${coauthor}\n\n${suffix}\n`)
    }
  }
})

test('commit_work appends credit after lines Git does not recognize as a message divider', async (t) => {
  for (const ending of ['---details', '----', ' ---', '---\u00a0details', '---\vdetails', '---\fdetails']) {
    const root = await repo(t)
    const before = await snapshot(root)
    await writeFile(join(root, 'notes.md'), 'x\n')
    const message = `Write the notes\n\nSummary\n${ending}`
    const done = await commitCardWork(root, before, message)
    assert.ok('commit' in done, JSON.stringify(done))
    assert.equal(await parsedTrailers(root), `${coauthor}\n`)
    assert.equal(await git(root, 'log', '-1', '--format=%B'), `${message}\n\n${coauthor}\n\n`)
  }
})

test('commit_work handles a message divider at the start or without a final newline', async (t) => {
  for (const body of ['', 'Write the notes\n\nSummary\n']) {
    const root = await repo(t)
    const before = await snapshot(root)
    await writeFile(join(root, 'notes.md'), 'x\n')
    const done = await commitCardWork(root, before, `${body}---`)
    assert.ok('commit' in done, JSON.stringify(done))
    assert.equal(await parsedTrailers(root), `${coauthor}\n`)
    assert.equal(await git(root, 'log', '-1', '--format=%B'), `${body}${body ? '\n' : '\n\n'}${coauthor}\n\n---\n`)
  }
})

test('a hand commit keeps the person’s message and identity without a co-author trailer', async (t) => {
  const root = await repo(t)
  await writeFile(join(root, 'notes.md'), 'x\n')
  await git(root, 'add', 'notes.md')
  await git(root, 'commit', '-q', '-m', 'Write the notes by hand')
  assert.equal(await git(root, 'log', '-1', '--format=%B'), 'Write the notes by hand\n\n')
  assert.equal((await git(root, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>')).trim(),
    'Jane Doe <dev@example.com>\nJane Doe <dev@example.com>')
})

test('commit_work uses the global identity when the checkout has none, ignoring host git author overrides', async (t) => {
  const root = await repo(t)
  await git(root, 'config', '--unset', 'user.name')
  await git(root, 'config', '--unset', 'user.email')
  const global = join(root, '..', 'global.gitconfig')
  await writeFile(global, '[user]\n\tname = Jane Doe\n\temail = dev@example.com\n')
  const overrides = {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Agent Override',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Agent Override',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
  }
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]))
  Object.assign(process.env, overrides)
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const before = await snapshot(root)
  await writeFile(join(root, 'notes.md'), 'x\n')
  const done = await commitCardWork(root, before, 'Use the person’s global identity')
  assert.ok('commit' in done, JSON.stringify(done))
  assert.equal((await git(root, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>')).trim(),
    'Jane Doe <dev@example.com>\nJane Doe <dev@example.com>')
  assert.equal((await git(root, 'log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)')).trim(),
    'HarnessDesk Agent <agent@harnessdesk.app>')
})

test('a message with shell metacharacters and newlines is preserved before the automatic trailer', async (t) => {
  const root = await repo(t)
  const before = await snapshot(root)
  await writeFile(join(root, 'notes.md'), 'x\n')
  const message = 'Subject; $(touch pwned) `id` && rm -rf / | cat\n\n# not a comment\n  indented "quoted" \'single\' \\ back\n-F --amend\n'
  const done = await commitCardWork(root, before, message)
  assert.ok('commit' in done, JSON.stringify(done))
  assert.equal(await git(root, 'log', '-1', '--format=%B'), `${message}\n${coauthor}\n\n`)
  assert.equal(await exists(join(root, 'pwned')), false)
})

/** Writes an executable script that appends `said` to the marker file, and passes stdin through when asked. */
const marking = async (at: string, marker: string, said: string, passThrough = false): Promise<string> => {
  await writeFile(at, `#!/bin/sh\necho ${said} >> '${marker}'\n${passThrough ? 'cat\n' : 'exit 0\n'}`)
  await chmod(at, 0o755)
  return at
}

/** A repository whose configuration points its hooks, filesystem monitor, a filter and signing at scripts that leave a mark. */
const poison = async (root: string, attributes: string): Promise<{ readonly marker: string; readonly said: () => Promise<string> }> => {
  const base = join(root, '..')
  const marker = join(base, 'ran')
  const hooks = join(base, 'hooks')
  await mkdir(hooks)
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change', 'post-checkout']) {
    await marking(join(hooks, hook), marker, hook)
  }
  await git(root, 'config', 'core.fsmonitor', await marking(join(base, 'fsmonitor.sh'), marker, 'fsmonitor'))
  await git(root, 'config', 'core.hooksPath', hooks)
  await git(root, 'config', 'filter.evil.clean', await marking(join(base, 'filter.sh'), marker, 'filter', true))
  await git(root, 'config', 'commit.gpgSign', 'true')
  await git(root, 'config', 'gpg.program', await marking(join(base, 'gpg.sh'), marker, 'gpg'))
  await git(root, 'config', 'diff.external', await marking(join(base, 'diff.sh'), marker, 'external-diff'))
  await writeFile(join(root, '.gitattributes'), attributes)
  await run('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.evil.clean=cat', 'add', '-A'])
  await run('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.evil.clean=cat', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'attributes'])
  await rm(marker, { force: true })
  return { marker, said: async () => [...new Set((await readFile(marker, 'utf8').catch(() => '')).split('\n').filter(Boolean))].sort().join(' ') }
}

test('a poisoned repository configuration runs nothing during commit_work', async (t) => {
  const root = await repo(t)
  const { said } = await poison(root, '*.bin filter=evil\n')
  const before = await snapshot(root)
  assert.equal(await said(), '', 'the claim’s own read ran nothing')

  await writeFile(join(root, 'notes.md'), '# Notes\n')
  const done = await commitCardWork(root, before, 'Write the notes')
  assert.ok('commit' in done, JSON.stringify(done))
  assert.equal(await said(), '', 'no hook, filesystem monitor, filter or signing program ran')
})

/*
 * What the host's own reads are held to, stated exactly: no hook, filesystem
 * monitor or external diff runs, but a filter the configuration defines still
 * does when a status re-reads a file whose stat information changed. That is
 * a limit of the floor (git-hardening.ts), shown here rather than claimed away.
 */
test('the host’s own git reads run no hook or filesystem monitor, but a configured filter still runs on a stat-dirty file', async (t) => {
  const root = await repo(t)
  await writeFile(join(root, 'page.md'), 'page\n')
  const { said } = await poison(root, '*.md filter=evil\n')
  // The same bytes, a new modification time: status has to look at the content.
  const later = new Date(Date.now() + 5_000)
  await utimes(join(root, 'page.md'), later, later)

  await revisionOf(root)
  await repositoryOf(root)
  await diffOf(root)
  assert.equal(await said(), 'filter', 'only the filter ran: no hook, no filesystem monitor, no external diff')
})

test('commit_work refuses work that goes through a git filter, such as LFS, and commits nothing', async (t) => {
  const root = await repo(t)
  await writeFile(join(root, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
  await git(root, 'add', '.gitattributes')
  await git(root, 'commit', '-q', '-m', 'track binaries')
  const head = (await git(root, 'rev-parse', 'HEAD')).trim()
  const before = await snapshot(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'assets', 'model.bin'), Buffer.alloc(64, 7))
  await writeFile(join(root, 'notes.md'), '# Notes\n')

  assert.deepEqual(await commitCardWork(root, before, 'Add the model'), {
    refused: 'Refused: some of this card’s files go through a git filter (such as LFS), so nothing was committed. Commit them yourself, or ask the person to.',
  })
  assert.equal((await git(root, 'rev-parse', 'HEAD')).trim(), head, 'nothing was committed')
  assert.equal(await git(root, 'diff', '--cached', '--name-only'), '', 'and nothing was staged')
})

test('commit_work never commits inside a submodule, or the submodule’s new state', async (t) => {
  const root = await repo(t)
  const library = join(root, '..', 'library')
  await run('git', ['init', '-q', '-b', 'main', library])
  await git(library, 'config', 'user.name', 'Jane Doe')
  await git(library, 'config', 'user.email', 'dev@example.com')
  await writeFile(join(library, 'lib.txt'), 'lib\n')
  await git(library, 'add', '-A')
  await git(library, 'commit', '-q', '-m', 'lib')
  await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendor/library')
  await git(root, 'commit', '-q', '-m', 'add the library')
  const sub = join(root, 'vendor', 'library')
  const subHead = (await git(sub, 'rev-parse', 'HEAD')).trim()
  const before = await snapshot(root)
  // The card changes a file inside the submodule, commits there, and writes one of its own.
  await writeFile(join(sub, 'lib.txt'), 'changed\n')
  await writeFile(join(sub, 'extra.txt'), 'extra\n')
  await writeFile(join(root, 'notes.md'), '# Notes\n')

  const done = await commitCardWork(root, before, 'Write the notes')
  assert.ok('commit' in done, JSON.stringify(done))
  assert.deepEqual(done.paths, ['notes.md'])
  assert.equal((await git(root, 'show', '--name-only', '--format=', 'HEAD')).trim(), 'notes.md')
  assert.equal((await git(sub, 'rev-parse', 'HEAD')).trim(), subHead, 'the submodule has no new commit')
  assert.match(await git(sub, 'status', '--porcelain=v1'), /lib\.txt/, 'and its change is left as it was')
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
