import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexAppServer, CodexError } from '../src/index.js'

/**
 * A start that finds Codex there and not answering yet, seen from the server
 * that owns the process: it waits and asks again while the app is open, and it
 * stops waiting the moment the app is not. `discovery-launcher.test.ts` has the
 * same facts one layer down.
 */

const skip = process.platform === 'win32'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const CLIENT_INFO = { name: 'harnessdesk-test', title: 'HarnessDesk (test)', version: '0.0.0' }

const folder = async (t: TestContext): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-codex-server-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A Codex that refuses its first `refusals` `--version` questions and is then
 * the scripted app-server, for every word after. Shell builtins only for the
 * count: the PATH discovery runs it with is the test's own, with nothing on it.
 */
const slowToAnswer = async (dir: string, count: string, refusals: number): Promise<string> => {
  const path = join(dir, 'codex')
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version)',
      `    echo run >> '${count}'`,
      '    n=0',
      `    while read -r _; do n=$((n + 1)); done < '${count}'`,
      `    if [ "$n" -le ${refusals} ]; then echo "starting up ($n)" >&2; exit 1; fi`,
      '    ;;',
      'esac',
      `exec '${process.execPath}' '${FAKE}' "$@"`,
      '',
    ].join('\n'),
  )
  await chmod(path, 0o755)
  return path
}

const runs = async (count: string): Promise<number> =>
  (await readFile(count, 'utf8').catch(() => '')).split('\n').filter((line) => line.length > 0).length

test('a Codex that answers a moment late is started once it does', { skip }, async (t) => {
  const dir = await folder(t)
  const count = join(dir, 'runs')
  const cli = await slowToAnswer(dir, count, 2)
  const server = new CodexAppServer({
    clientInfo: CLIENT_INFO,
    requestTimeoutMs: 5_000,
    discovery: { env: { PATH: dir }, locations: [], retryDelaysMs: [1, 1, 1] },
  })
  t.after(() => server.stop())
  const states: string[] = []
  server.onStateChange((state) => states.push(state.type))

  await server.start()

  assert.equal(server.state.type, 'ready')
  assert.equal(server.installation?.path, cli)
  assert.equal(await runs(count), 3, 'two refusals and the answer')
  assert.deepEqual(states, ['starting', 'ready'], 'it was starting the whole time, never failed in between')
})

test('stopping during the wait ends the start, spawns nothing, and leaves the server stopped', { skip }, async (t) => {
  const dir = await folder(t)
  const count = join(dir, 'runs')
  await slowToAnswer(dir, count, 99)
  const server = new CodexAppServer({
    clientInfo: CLIENT_INFO,
    discovery: { env: { PATH: dir }, locations: [], retryDelaysMs: [10_000] },
  })
  const starting = server.start().then(() => null, (error: unknown) => error)
  while ((await runs(count)) === 0) await new Promise((resolve) => setTimeout(resolve, 5))

  await server.stop()

  const error = await starting
  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'notRunning')
  assert.equal(server.state.type, 'stopped', 'a stop is not a failure')
  assert.equal(server.processId, null, 'and no app-server was born into it')
  assert.equal(await runs(count), 1)
})

test('a Codex that never answers fails the start with the reason, not with "not installed"', { skip }, async (t) => {
  const dir = await folder(t)
  const count = join(dir, 'runs')
  await slowToAnswer(dir, count, 99)
  const server = new CodexAppServer({
    clientInfo: CLIENT_INFO,
    discovery: { env: { PATH: dir }, locations: [], retryDelaysMs: [1] },
  })

  const error = await server.start().then(() => null, (thrown: unknown) => thrown)

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'spawnFailed')
  assert.match(error.message, /starting up \(2\)/)
  assert.equal(server.state.type, 'failed')
})
