import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { CodexError, discoverCodex, isTransientFailure, requireCodex, type UnreadableCopy } from '../src/index.js'

/**
 * What the desk meets when the Codex it finds is a program that has to be
 * *run* to say what it is.
 *
 * The npm and Homebrew installs of Codex are a Node script, `#!/usr/bin/env
 * node`, not a binary. Whether it answers `--version` depends on the machine at
 * that moment — a `node` on the PATH it is run with, a machine that is not
 * mid-boot — and discovery used to read every way it could fail as the one
 * thing it knew: "Codex is not installed". The window said so about a Codex
 * that `ls` could see, and the verdict stood until the app was restarted.
 *
 * Discovery asks once and says which it is. A copy that is there and would not
 * answer is `unreadable` when a later ask could differ, so the host asks again,
 * and `spawnFailed` when it could not. Either way the window is told at once:
 * nothing here waits.
 *
 * Each test builds the whole machine in a temp folder and hands discovery the
 * PATH and the install locations that machine has, so none of them depends on
 * what is installed where these tests run.
 */

const skip = process.platform === 'win32'

const folder = async (t: TestContext): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-codex-launcher-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const program = async (dir: string, name: string, text: string): Promise<string> => {
  const path = join(dir, name)
  await writeFile(path, text)
  await chmod(path, 0o755)
  return path
}

/** A Node-script launcher, as `npm i -g @openai/codex` leaves it. */
const NODE_LAUNCHER = '#!/usr/bin/env node\nconsole.log("codex-cli 99.1.0")\n'

/** A copy that refuses its first `refusals` runs and then answers, noting every run as a line in `count`. */
const flaky = (count: string, refusals: number): string =>
  [
    '#!/bin/sh',
    // Shell builtins only: the PATH it is run with is the test's own, with nothing on it.
    `echo run >> '${count}'`,
    'n=0',
    `while read -r _; do n=$((n + 1)); done < '${count}'`,
    `if [ "$n" -le ${refusals} ]; then echo "starting up ($n)" >&2; exit 1; fi`,
    'echo "codex-cli 99.1.0"',
    '',
  ].join('\n')

const runs = async (count: string): Promise<number> =>
  (await readFile(count, 'utf8').catch(() => '')).split('\n').filter((line) => line.length > 0).length

const failure = (attempt: Promise<unknown>): Promise<unknown> => attempt.then(() => null, (error: unknown) => error)

const copiesOf = (error: CodexError): readonly UnreadableCopy[] => error.details as readonly UnreadableCopy[]

test('a copy that is there but cannot run is not reported as missing', { skip }, async (t) => {
  const bin = await folder(t)
  const cli = await program(bin, 'codex', NODE_LAUNCHER)

  // The PATH it is run with has no `node` on it: the launcher cannot start.
  const error = await failure(requireCodex(null, { env: { PATH: bin }, locations: [] }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'unreadable', 'a copy that exists is not "not installed", and a PATH can change this')
  assert.ok(error.message.includes(cli), `the message names the copy it found: ${error.message}`)
  assert.match(error.message, /\b127\b/, 'and what it said when run')
  assert.doesNotMatch(error.message, /not installed/i)
})

test('a copy that will not answer is run once and reported at once', { skip }, async (t) => {
  const bin = await folder(t)
  const count = join(bin, 'runs')
  await program(bin, 'codex', flaky(count, 99))

  // The defaults, as the desk runs them: a window waits for this answer.
  const error = await failure(requireCodex(null, { env: { PATH: bin }, locations: [] }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'unreadable')
  assert.equal(await runs(count), 1, 'asking again is the host\'s, in the background, not a wait inside the start')
  assert.match(error.message, /starting up \(1\)/, 'it carries what the copy said')
})

test('a machine with no copy says so at once', { skip }, async (t) => {
  const bin = await folder(t)

  const error = await failure(requireCodex(null, { env: { PATH: bin }, locations: [join(bin, 'nowhere')] }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'notInstalled')
  assert.equal(await discoverCodex(null, { env: { PATH: bin }, locations: [] }), null)
})

test('one copy reached two ways is run once', { skip }, async (t) => {
  const bin = await folder(t)
  const other = join(bin, 'other')
  await mkdir(other)
  const count = join(bin, 'runs')
  const cli = await program(bin, 'codex', flaky(count, 0))
  await symlink(cli, join(other, 'codex'))

  const found = await discoverCodex(null, { env: { PATH: `${bin}:${other}` }, locations: [cli, join(other, 'codex')] })

  assert.equal(found?.path, cli)
  assert.equal(await runs(count), 1, 'the PATH hit, the install location and the link are one file')
})

test('a copy that prints no version is named, and is not one a later ask could change', { skip }, async (t) => {
  const bin = await folder(t)
  const count = join(bin, 'runs')
  const cli = await program(bin, 'codex', `#!/bin/sh\necho run >> '${count}'\necho "hello"\n`)

  const error = await failure(requireCodex(null, { env: { PATH: bin }, locations: [] }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'spawnFailed', 'found, and nothing about it will pass: said once and left')
  assert.ok(error.message.includes(cli), error.message)
  assert.match(error.message, /printed no version number \("hello"\)/)
  assert.deepEqual(copiesOf(error).map((copy) => copy.transient), [false])
  assert.equal(await runs(count), 1)
})

test('a copy that does not answer in time, or is ended, is one a later ask could change', { skip }, async (t) => {
  const bin = await folder(t)
  const stuck = join(bin, 'stuck')
  const ended = join(bin, 'ended')
  await mkdir(stuck)
  await mkdir(ended)
  // `read` waits on the stdin nobody writes to: a copy that never answers, with no CPU spent on it.
  await program(stuck, 'codex', '#!/bin/sh\nread -r _\n')
  await program(ended, 'codex', '#!/bin/sh\nkill -TERM $$\n')

  const slow = await failure(requireCodex(null, { env: { PATH: stuck }, locations: [], probeTimeoutMs: 150 }))
  const killed = await failure(requireCodex(null, { env: { PATH: ended }, locations: [] }))

  assert.ok(slow instanceof CodexError && killed instanceof CodexError, `${String(slow)} ${String(killed)}`)
  assert.equal(slow.code, 'unreadable')
  assert.match(slow.message, /did not answer within 0\.15 seconds/)
  assert.equal(killed.code, 'unreadable')
  assert.match(killed.message, /was ended by SIGTERM/)
})

test('one copy a later ask could change is enough to keep asking', { skip }, async (t) => {
  const bin = await folder(t)
  const other = join(bin, 'other')
  await mkdir(other)
  const junk = await program(bin, 'codex', '#!/bin/sh\necho "hello"\n')
  const launcher = await program(other, 'codex', NODE_LAUNCHER)

  const error = await failure(requireCodex(null, { env: { PATH: bin }, locations: [launcher] }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'unreadable')
  assert.deepEqual(
    copiesOf(error).map((copy) => [copy.path, copy.transient]),
    [[junk, false], [launcher, true]],
    'each copy is judged on its own',
  )
})

test('only what a moment or a PATH can change is a failure worth asking about again', () => {
  const passes = [
    { killed: true, signal: 'SIGTERM' },
    { signal: 'SIGKILL' },
    { code: 127 },
    { code: 1 },
    { code: 'EAGAIN' },
    { code: 'EMFILE' },
    { code: 'ENFILE' },
    { code: 'ENOMEM' },
    { code: 'EBUSY' },
  ]
  const stays = [{ code: 'EACCES' }, { code: 'ENOEXEC' }, { code: 'ENOENT' }, { code: 'EISDIR' }, new Error('nothing to go on'), {}]

  assert.deepEqual(passes.map(isTransientFailure), passes.map(() => true))
  assert.deepEqual(stays.map(isTransientFailure), stays.map(() => false))
})

test('a configured path that will not answer is named, not called missing', { skip }, async (t) => {
  const bin = await folder(t)
  const cli = await program(bin, 'codex', NODE_LAUNCHER)

  const error = await failure(requireCodex(cli, { env: { PATH: bin } }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'unreadable')
  assert.ok(error.message.includes(cli), error.message)
})

test('a configured path that is not Codex is named, and is said once', { skip }, async (t) => {
  const bin = await folder(t)
  const cli = await program(bin, 'not-codex', '#!/bin/sh\necho "hello"\n')

  const error = await failure(requireCodex(cli, { env: { PATH: bin } }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'spawnFailed')
  assert.ok(error.message.includes(cli), error.message)
})

test('a successful probe with empty output remains retryable', { skip }, async (t) => {
  const bin = await folder(t)
  const cli = await program(bin, 'codex', '#!/bin/sh\nexit 0\n')
  const error = await failure(requireCodex(cli, { env: { PATH: bin }, locations: [] }))
  assert.ok(error instanceof CodexError)
  assert.equal(error.code, 'unreadable')
  assert.deepEqual(copiesOf(error).map((copy) => copy.transient), [true])
})

for (const output of ['', 'hello', 'codex-cli 99.1.0']) {
  test(`a successful probe past its deadline is retryable (${output || 'empty'})`, { skip }, async (t) => {
    const bin = await folder(t)
    const cli = await program(bin, 'codex', `#!/bin/sh\necho '${output}'\n`)
    // Coalesced callbacks can report success after the timeout. Advance only
    // the monotonic clock; no busy event loop or real agent is needed.
    let now = 0
    t.mock.method(performance, 'now', () => { const value = now; now += 10_001; return value })
    const error = await failure(requireCodex(cli, { env: { PATH: bin }, locations: [], probeTimeoutMs: 10_000 }))
    assert.ok(error instanceof CodexError)
    assert.equal(error.code, 'unreadable')
    assert.match(error.message, /did not answer within 10 seconds/)
  })
}
