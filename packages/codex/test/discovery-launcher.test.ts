import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { CodexError, discoverCodex, requireCodex } from '../src/index.js'

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

test('a copy that is there but cannot run is not reported as missing', { skip }, async (t) => {
  const bin = await folder(t)
  const cli = await program(bin, 'codex', NODE_LAUNCHER)

  // The PATH it is run with has no `node` on it: the launcher cannot start.
  const error = await failure(requireCodex(null, { env: { PATH: bin }, locations: [], retryDelaysMs: [] }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'spawnFailed', 'a copy that exists is not "not installed"')
  assert.ok(error.message.includes(cli), `the message names the copy it found: ${error.message}`)
  assert.match(error.message, /\b127\b/, 'and what it said when run')
  assert.doesNotMatch(error.message, /not installed/i)
})

test('a copy that fails to answer once is asked again before anything is concluded', { skip }, async (t) => {
  const bin = await folder(t)
  const count = join(bin, 'runs')
  const cli = await program(bin, 'codex', flaky(count, 2))

  const found = await requireCodex(null, { env: { PATH: bin }, locations: [], retryDelaysMs: [1, 1, 1] })

  assert.equal(found.path, cli)
  assert.deepEqual(found.semver, [99, 1, 0])
  assert.equal(await runs(count), 3, 'two refusals and the answer')
})

test('a copy that never answers gives up after its waits, and says why', { skip }, async (t) => {
  const bin = await folder(t)
  const count = join(bin, 'runs')
  await program(bin, 'codex', flaky(count, 99))

  const error = await failure(requireCodex(null, { env: { PATH: bin }, locations: [], retryDelaysMs: [1, 1] }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'spawnFailed')
  assert.equal(await runs(count), 3, 'the first run and one more after each wait')
  assert.match(error.message, /starting up \(3\)/, 'it carries the last thing the copy said')
})

test('a machine with no copy says so at once and waits for nothing', { skip }, async (t) => {
  const bin = await folder(t)
  const started = Date.now()

  const error = await failure(requireCodex(null, { env: { PATH: bin }, locations: [join(bin, 'nowhere')], retryDelaysMs: [60_000] }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'notInstalled')
  assert.ok(Date.now() - started < 5_000, 'a missing install is not worth a retry')
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

test('a quit during the wait ends the start without another run', { skip }, async (t) => {
  const bin = await folder(t)
  const count = join(bin, 'runs')
  await program(bin, 'codex', flaky(count, 99))
  const quit = new AbortController()

  const starting = failure(requireCodex(null, { env: { PATH: bin }, locations: [], retryDelaysMs: [10_000], signal: quit.signal }))
  while ((await runs(count)) === 0) await new Promise((resolve) => setTimeout(resolve, 5))
  quit.abort()

  const error = await starting
  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'notRunning')
  assert.equal(await runs(count), 1, 'nothing was run after the quit')
})

test('a configured path that will not answer is named, not called missing', { skip }, async (t) => {
  const bin = await folder(t)
  const cli = await program(bin, 'codex', NODE_LAUNCHER)

  const error = await failure(requireCodex(cli, { env: { PATH: bin }, retryDelaysMs: [] }))

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'spawnFailed')
  assert.ok(error.message.includes(cli), error.message)
})
