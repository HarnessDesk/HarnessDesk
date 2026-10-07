import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexAppServer, CodexError, type ConnectionState } from '../src/index.js'

/**
 * A restart is a start. A `start()` that arrives while the server is restarting
 * — the host sees `restarting` as not ready and asks for one — used to begin a
 * second start beside it, and the two spawned an app-server each into a single
 * `#child`: one of them was no longer anybody's to stop.
 */

const skip = process.platform === 'win32'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const CLIENT_INFO = { name: 'harnessdesk-test', title: 'HarnessDesk (test)', version: '0.0.0' }

/** The scripted Codex, noting the process id of each app-server it is asked to be as a line in `spawns`. */
const counting = async (dir: string, spawns: string): Promise<string> => {
  const path = join(dir, 'codex')
  await writeFile(
    path,
    ['#!/bin/sh', `if [ "$1" = app-server ]; then echo "$$" >> '${spawns}'; fi`, `exec '${process.execPath}' '${FAKE}' "$@"`, ''].join('\n'),
  )
  await chmod(path, 0o755)
  return path
}

const pids = async (spawns: string): Promise<number[]> =>
  (await readFile(spawns, 'utf8').catch(() => '')).split('\n').filter((line) => line.length > 0).map(Number)

const spawned = async (spawns: string): Promise<number> => (await pids(spawns)).length

const waitForState = (server: CodexAppServer, predicate: (state: ConnectionState) => boolean): Promise<ConnectionState> =>
  new Promise((resolve, reject) => {
    if (predicate(server.state)) return resolve(server.state)
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timed out waiting for state; last was ${server.state.type}`))
    }, 15_000)
    const off = server.onStateChange((state) => {
      if (!predicate(state)) return
      clearTimeout(timer)
      off()
      resolve(state)
    })
  })

/** A server that has started and is made to crash, and is now restarting. */
const restarting = async (t: TestContext, restartDelayMs: number): Promise<{ server: CodexAppServer; spawns: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-codex-restart-'))
  const spawns = join(dir, 'spawns')
  const server = new CodexAppServer({
    clientInfo: CLIENT_INFO,
    binaryPath: await counting(dir, spawns),
    env: { FAKE_CODEX_MODE: 'crash-on-request' },
    requestTimeoutMs: 5_000,
    restartDelayMs,
  })
  // Whatever the server loses track of is still ended here, before the folder that names it goes,
  // so a failing run ends instead of holding the runner open behind an app-server nobody owns.
  t.after(async () => {
    await server.stop()
    for (const pid of await pids(spawns)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await rm(dir, { recursive: true, force: true })
  })
  await server.start()
  await assert.rejects(
    () => server.request('thread/start', { cwd: '/tmp' } as never),
    (error: unknown) => error instanceof CodexError && error.code === 'crashed',
  )
  await waitForState(server, (state) => state.type === 'restarting')
  return { server, spawns }
}

test('a start that arrives while the server restarts joins the restart', { skip }, async (t) => {
  // A backoff long enough that this start lands inside it, however slow the machine is.
  const { server, spawns } = await restarting(t, 100)

  await Promise.all([server.start(), server.start()])

  assert.equal(server.state.type, 'ready')
  // Long enough for the restart's own backoff to have run out, had a second start left it standing.
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(await spawned(spawns), 2, 'the first app-server and the one restart: never two beside each other')
})

test('stopping during a restart ends it, and a start that joined it is told the server was stopped', { skip }, async (t) => {
  const { server, spawns } = await restarting(t, 60_000)
  const joined = server.start().then(() => 'started', (thrown: unknown) => thrown)

  await server.stop()

  // The backoff is the longest the restart will wait; a quit does not sit it out.
  const outcome = await Promise.race([joined, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5_000))])
  assert.ok(outcome instanceof CodexError, String(outcome))
  assert.equal(outcome.code, 'notRunning')
  assert.equal(server.state.type, 'stopped', 'a stop is not a failure')
  assert.equal(await spawned(spawns), 1, 'and no app-server was born into it')
})
