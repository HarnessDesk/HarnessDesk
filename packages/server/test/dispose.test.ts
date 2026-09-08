import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { runtimeId, type CatalogRefresh, type RuntimeId } from '@harnessdesk/protocol'

import { Host, Logger, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * The quit reaches every runtime before a catalogue re-read can resume.
 *
 * `AcpRuntime` and `CodexRuntime` each refuse to spawn once disposed, and both
 * refusals rest on one claim about the host that neither adapter can check
 * from where it stands: that by the time a re-read parked mid-restart wakes
 * up, `dispose()` has already run on the runtime it is about to restart.
 * `Host.dispose()` disposes runtimes with `Promise.all(map(…))`, and the flag
 * each adapter sets is written before its first `await` — so the claim is that
 * `map` gets every `dispose()` to its first yield before any parked work is
 * let go. That is the seam the adapters' guards are bolted to, and this is the
 * only test that stands on both sides of it.
 *
 * The refusal itself belongs to the adapters and is pinned there, against real
 * process families — `adapter-acp/test/dispose.test.ts` and
 * `adapter-codex/test/dispose.test.ts`. What is proved here is the ordering
 * they depend on, through the real refresher, the real wire method and the
 * real `Host.dispose()`, with nothing of the runtime faked but the agent.
 */

const silent = new Logger('test', { level: 'error', console: false })

/**
 * An agent whose catalogue re-read parks, and which keeps the two adapters'
 * bargain: the disposed flag is written before `dispose()`'s first `await`,
 * and a start after that is refused rather than quietly skipped.
 */
class RestartingRuntime extends FakeRuntime {
  starts = 0
  /** Whether `dispose()` had already run when the parked re-read woke. */
  quitFirst: boolean | null = null
  disposed = false
  /** Set by a test that wants this runtime's shutdown to fail. */
  disposeThrows = false
  #disposed = false
  #open: () => void = () => undefined
  #arrived: () => void = () => undefined
  readonly parked: Promise<void>

  constructor(info: { id: RuntimeId; name: string }) {
    super(info)
    this.parked = new Promise<void>((resolve) => {
      this.#arrived = resolve
    })
  }

  override async start(): Promise<void> {
    if (this.#disposed) throw new Error(`${this.info.name} has been shut down.`)
    this.starts += 1
    await super.start()
  }

  override async dispose(): Promise<void> {
    // Before the first `await`, as both real adapters do.
    this.#disposed = true
    this.disposed = true
    if (this.disposeThrows) throw new Error('this runtime will not go quietly')
    await super.dispose()
  }

  /** The refresher's door: an ACP agent re-reads by stopping and starting. */
  async refreshCatalog(): Promise<CatalogRefresh> {
    const held = new Promise<void>((resolve) => {
      this.#open = resolve
    })
    this.#arrived()
    await held
    // Waking on the far side of the quit, which is the whole scenario.
    this.quitFirst = this.#disposed
    await this.start()
    return { refreshed: true }
  }

  release(): void {
    this.#open()
  }
}

const hostWith = async (t: TestContext, runtimes: readonly RestartingRuntime[]): Promise<Host> => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-dispose-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    startTimeoutMs: 2_000,
    // The timer is off; this drives the refresher through its wire method
    // instead, so the tick is arranged rather than waited for.
    catalogRefreshMs: 0,
  })
  for (const runtime of runtimes) host.register(runtime as never)
  return host
}

/**
 * Released *during* the quit, not after it.
 *
 * The first version of this test awaited the whole of `host.dispose()` before
 * letting the parked re-read go, which all three reviewers of round two said
 * the same thing about: it proves only that a runtime disposed in the past is
 * still disposed in the future. The teardown's own awaits — terminals,
 * transcripts, gateways — were the gap, and nothing stood in it.
 *
 * So the release happens on `dispose()`'s first yield. `dispose()` runs
 * synchronously as far as its first `await` and then hands control back here;
 * that is the exact moment a parked re-read would wake in production, and it
 * is reached by construction rather than by timing.
 *
 * Two runtimes, and the parked one is the last registered. `Promise.all` over
 * `map` is only worth claiming if `map` reaches every runtime before any of
 * them yields — with one runtime that claim cannot fail.
 */
test('a re-read that wakes inside the quit finds its runtime already disposed', async (t) => {
  const first = new RestartingRuntime({ id: runtimeId('fake'), name: 'Fake' })
  const last = new RestartingRuntime({ id: runtimeId('fake-two'), name: 'Fake Two' })
  const host = await hostWith(t, [first, last])
  await host.start()
  assert.deepEqual([first.starts, last.starts], [1, 1], 'both up once')

  const refresh = host.call('runtime/refreshCatalog', { runtime: last.info.id })
  await last.parked

  const quitting = host.dispose()
  // The first yield of the teardown. Nothing waits for the re-read — a check
  // that has reached the agent is unbounded — so being armed before this is
  // the only thing between it and a spawn.
  last.release()
  await quitting
  const result = await refresh

  assert.equal(last.quitFirst, true, 'the quit had reached it before its re-read woke')
  assert.equal(last.starts, 1, 'so nothing was started inside the quit')
  assert.equal(first.starts, 1, 'and the runtime registered ahead of it is untouched')
  // The refresher never throws; the reason is where the truth is.
  assert.equal(result.refreshed, false)
  assert.match(result.reason ?? '', /has been shut down/)
})

/** And a runtime whose shutdown throws does not abandon the rest of the quit. */
test('one runtime that will not shut down cleanly does not strand the others', async (t) => {
  const angry = new RestartingRuntime({ id: runtimeId('angry'), name: 'Angry' })
  angry.disposeThrows = true
  const calm = new RestartingRuntime({ id: runtimeId('calm'), name: 'Calm' })
  const host = await hostWith(t, [angry, calm])
  await host.start()

  await host.dispose()

  assert.equal(calm.disposed, true, 'the runtime behind the throwing one was still disposed')
})
