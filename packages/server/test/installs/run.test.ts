import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { findInstalls } from '../../src/installs/locate.js'
import { runForOutput } from '../../src/installs/run.js'

/**
 * A probe comes back no matter what the command does. The command under
 * test ignores SIGTERM and hands its stdout to a grandchild that sleeps —
 * the shape of the Homebrew-cask cursor-agent that held the catalogue for
 * eleven minutes — and the probe must still give up on time.
 */

const stubborn = async (dir: string): Promise<string> => {
  const path = join(dir, 'stubborn')
  await writeFile(
    path,
    `#!/bin/sh
trap '' TERM
sleep 30 &
echo "stubborn 9.9.9"
wait
`,
  )
  await chmod(path, 0o755)
  return path
}

test('a command that ignores the timeout signal is killed as a group, and reported as timed out', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-run-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = await stubborn(dir)
  const started = Date.now()
  const result = await runForOutput(path, ['--version'], { timeoutMs: 500 })
  assert.equal(result.timedOut, true)
  assert.equal(result.ok, false)
  assert.ok(Date.now() - started < 5_000, 'came back well before the grandchild would have')
})

test('a copy that hangs on --version is listed as unreadable and never chosen', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-run-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = await stubborn(dir)
  const good = join(dir, 'good')
  await writeFile(good, '#!/bin/sh\necho "good 1.0.0"\n')
  await chmod(good, 0o755)
  // Generous on purpose: the stubborn script sleeps for thirty seconds, so
  // any budget separates it from a script that answers at once — and a tight
  // one only makes the *good* script flaky when the suite runs spawn-heavy
  // tests side by side.
  const found = await findInstalls(
    { commands: ['x'] },
    { env: { PATH: '' }, home: dir, also: [path, good], timeoutMs: 2_000 },
  )
  assert.deepEqual(
    found.map((copy) => [copy.path, copy.version]),
    [
      [good, '1.0.0'],
      [path, null],
    ],
  )
})

test('an ordinary command answers with its output and exit code', async () => {
  const result = await runForOutput('/bin/sh', ['-c', 'echo out; echo err 1>&2; exit 3'], { timeoutMs: 5_000 })
  assert.equal(result.code, 3)
  assert.equal(result.ok, false)
  assert.equal(result.stdout.trim(), 'out')
  assert.equal(result.stderr.trim(), 'err')
  assert.equal(result.timedOut, false)
  const missing = await runForOutput('/no/such/command', [], { timeoutMs: 1_000 })
  assert.equal(missing.ok, false)
})

test('output written right before a fast exit arrives whole', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-run-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // Several kilobytes and an immediate exit: the shape a version probe has,
  // and the one where settling on `exit` rather than `close` drops the
  // answer. A copy whose version line went missing is marked unreadable and
  // never run, so this is the difference between a working agent and a dead
  // row — and it is silent, which is why it is pinned here.
  const path = join(dir, 'chatty')
  const line = 'x'.repeat(200)
  await writeFile(path, `#!/bin/sh\nfor i in $(seq 1 40); do echo "${line}"; done\nexit 0\n`)
  await chmod(path, 0o755)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await runForOutput(path, [], { timeoutMs: 5_000 })
    assert.equal(result.ok, true)
    assert.equal(result.timedOut, false)
    assert.equal(result.stdout.split('\n').filter((one) => one.length > 0).length, 40)
  }
})

test('a version line printed by a slow-to-close child is still read', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-run-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // Prints, exits — and leaves a grandchild holding the pipe, so `close`
  // never comes. The grace after `exit` is what turns this from a timeout
  // into an answer.
  const path = join(dir, 'lingering')
  await writeFile(path, `#!/bin/sh\nsleep 30 &\necho "lingering 4.5.6"\nexit 0\n`)
  await chmod(path, 0o755)
  const started = Date.now()
  const result = await runForOutput(path, ['--version'], { timeoutMs: 10_000 })
  assert.match(result.stdout, /lingering 4\.5\.6/)
  assert.equal(result.timedOut, false)
  assert.ok(Date.now() - started < 3_000, 'answered on the grace, not on the deadline')
})
