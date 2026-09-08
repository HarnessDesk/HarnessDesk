import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '../src/index.js'

/**
 * Nothing is spawned after the host has finished with the runtime.
 *
 * The twin of `adapter-acp/test/dispose.test.ts`, and the same door: a
 * `checkInstallation` that finds a newer Codex on disk restarts onto it, and
 * it asks the machine what is installed *first*. Quit inside that question and
 * the runtime has nothing in flight, so `Host.dispose()`'s stop returns at
 * once and the quit goes on; then the answer arrives and starts an app-server,
 * and every MCP server Codex launches behind it, with nobody left to end them.
 *
 * The ordering is arranged rather than waited for: the stand-in holds its own
 * `--version` answer until this file releases it, so the shutdown is inside
 * the window by construction. What is asked afterwards is settled before it is
 * asked — every app-server writes its pid down before it reads a word from
 * stdin, and the handshake that would follow is awaited.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

interface Desk {
  /** Every app-server that has ever run, by pid, in the order they came up. */
  readonly generations: () => Promise<number[]>
  /** Holds a `--version` answer open while it exists; `release()` deletes it. */
  readonly hold: (this: void) => Promise<string>
  readonly release: (this: void) => Promise<void>
}

const desk = async (t: TestContext): Promise<Desk> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-codex-dispose-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const claims = join(dir, 'generations')
  await writeFile(claims, '')
  const holding = join(dir, 'hold')
  process.env['FAKE_CODEX_CLAIMS'] = claims
  t.after(() => {
    delete process.env['FAKE_CODEX_CLAIMS']
    delete process.env['FAKE_CODEX_VERSION']
    delete process.env['FAKE_CODEX_HOLD']
  })
  return {
    hold: async () => {
      await writeFile(holding, '')
      process.env['FAKE_CODEX_HOLD'] = holding
      return holding
    },
    release: () => rm(holding, { force: true }),
    generations: async () =>
      (await readFile(claims, 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => Number.parseInt(line, 10)),
  }
}

/** Whether that process is still around — the question, and the OS answers it. */
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a build check parked when the app quits starts no app-server behind the quit', async (t) => {
  if (process.platform === 'win32') return

  const desks = await desk(t)
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())
  await runtime.start()
  assert.equal((await desks.generations()).length, 1, 'one app-server to begin with')

  // A newer Codex appears on disk, and the probe that would find it is held.
  process.env['FAKE_CODEX_VERSION'] = '0.150.0'
  await desks.hold()
  const check = runtime.checkInstallation()

  // The quit, landing inside the question. Nothing is in flight for it to
  // wait on — the app-server it stops is the one that is still up.
  await runtime.dispose()
  await desks.release()

  const outcome = await check.then(
    () => 'the runtime reported a restart',
    (error: unknown) => String(error),
  )

  const born = await desks.generations()
  assert.equal(
    born.length,
    1,
    `a second app-server was started into the quit, and nothing will end it (pids: ${born.join(', ')})`,
  )
  // `stop()` waits for the exit, and Node emits that only after the child has
  // been reaped — so this is a fact about a process, not about a zombie.
  assert.equal(running(born[0]!), false, 'and the one that did run is gone')
  assert.match(outcome, /has been shut down/, 'and the refusal is reported, not passed off as a restart')
})

/**
 * The window one layer down, found by Codex 5.3 in the review of this change.
 *
 * The first guard is welded to `#server.start()` — but that call has an await
 * of its own before *its* spawn: `requireCodex` asks the machine which Codex
 * is installed, and the answer comes back long after the question. A quit
 * landing there takes a `#child` that is still null, returns at once believing
 * there is nothing to end, and the woken start spawns anyway. The crash-
 * recovery path had the same gap with a guard one step short of it — it
 * checked after its backoff and not after the lookup — which is why the check
 * that closes this is inside `#spawnAndHandshake`, the one place a process is
 * born, rather than at either caller.
 */
test('a start parked in the version probe when the app quits spawns no app-server', async (t) => {
  if (process.platform === 'win32') return

  const desks = await desk(t)
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())

  // Held before the first start, so the quit lands inside `requireCodex` —
  // the await between "which Codex?" and the spawn that answer feeds.
  await desks.hold()
  const starting = runtime.start()

  await runtime.dispose()
  await desks.release()

  const outcome = await starting.then(
    () => 'it started',
    (error: unknown) => String(error),
  )

  assert.deepEqual(
    await desks.generations(),
    [],
    'an app-server was spawned behind the quit, and nothing will end it',
  )
  assert.match(outcome, /stopped while it was starting/, 'and the start says why it did not')

  /* And a stop is the state it is left in. The refusal travels as a throw, so
     the catch that files a failed start would have written `failed` over the
     `stopped` the stop had just set — which reads back as an agent somebody
     deliberately stopped being reported as one that is broken. */
  const health = runtime.health()
  assert.equal(
    health.state === 'unavailable' ? health.message : health.state,
    'The Codex runtime is not running.',
  )
})

test('a Codex runtime the host has finished with will not start again', async (t) => {
  if (process.platform === 'win32') return

  const desks = await desk(t)
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const born = await desks.generations()
  assert.equal(born.length, 1)

  await runtime.dispose()
  await assert.rejects(runtime.start(), /has been shut down/)

  assert.deepEqual(await desks.generations(), born, 'no app-server was started to find that out')
  assert.equal(running(born[0]!), false)
})
