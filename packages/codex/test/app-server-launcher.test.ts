import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexAppServer, CodexError } from '../src/index.js'

/**
 * A start that finds Codex there and not answering, seen from the server that
 * owns the process: it fails at once and says why, and a failed start is not
 * final — the next one asks again. `discovery-launcher.test.ts` has the same
 * facts one layer down; who asks again, and when, is the host's.
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

test('a Codex that will not answer fails the start at once, with the reason, not with "not installed"', { skip }, async (t) => {
  const dir = await folder(t)
  const count = join(dir, 'runs')
  await slowToAnswer(dir, count, 99)
  const server = new CodexAppServer({
    clientInfo: CLIENT_INFO,
    discovery: { env: { PATH: dir }, locations: [] },
  })

  const error = await server.start().then(() => null, (thrown: unknown) => thrown)

  assert.ok(error instanceof CodexError, String(error))
  assert.equal(error.code, 'unreadable')
  assert.match(error.message, /starting up \(1\)/)
  assert.equal(server.state.type, 'failed')
  assert.equal(await runs(count), 1, 'asked once: the start does not wait on a second ask')
})

test('a failed start is not final: the next one starts the Codex that has since answered', { skip }, async (t) => {
  const dir = await folder(t)
  const count = join(dir, 'runs')
  const cli = await slowToAnswer(dir, count, 1)
  const server = new CodexAppServer({
    clientInfo: CLIENT_INFO,
    requestTimeoutMs: 5_000,
    discovery: { env: { PATH: dir }, locations: [] },
  })
  t.after(() => server.stop())
  const states: string[] = []
  server.onStateChange((state) => states.push(state.type))

  await assert.rejects(server.start(), (error: unknown) => error instanceof CodexError && error.code === 'unreadable')
  await server.start()

  assert.equal(server.state.type, 'ready')
  assert.equal(server.installation?.path, cli)
  assert.deepEqual(states, ['starting', 'failed', 'starting', 'ready'])
  assert.equal(await runs(count), 2, 'the refusal and the answer')
})
