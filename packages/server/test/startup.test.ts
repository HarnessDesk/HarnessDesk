import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RuntimeHealth, RuntimeId, Unsubscribe } from '@harnessdesk/protocol'

import { Host, Logger, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * Starting up when one agent will not.
 *
 * The failure this guards against is not a slow agent but a silent one: a
 * command that exists and speaks some other protocol, so `initialize` is never
 * answered and `start()` neither resolves nor rejects. That is an ordinary
 * mistake — a registry entry pointing at the wrong binary — and it used to
 * cost the entire app, because `start()` awaited every runtime and one of them
 * never came back. No window, no error, nothing written anywhere.
 */

const silent = new Logger('test', { level: 'error', console: false })

/** A runtime whose `start()` never settles, the way a wrong binary behaves. */
class MuteRuntime extends FakeRuntime {
  startCalled = false
  override async start(): Promise<void> {
    this.startCalled = true
    return new Promise<void>(() => {})
  }
}

/** A runtime that comes up, but only after the deadline has passed. */
class LateRuntime extends FakeRuntime {
  #resolve: (() => void) | null = null
  override async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#resolve = resolve
    })
    // Only now does it do what starting normally does, which is the point:
    // health goes ready after the host has already stopped waiting.
    await super.start()
  }
  arrive(): void {
    this.#resolve?.()
  }
}

const hostWith = async (
  runtimes: readonly { info: { id: RuntimeId } }[],
  startTimeoutMs: number,
) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-startup-'))
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    startTimeoutMs,
    catalogRefreshMs: 0,
  })
  for (const runtime of runtimes) host.register(runtime as never)
  return { host, stateDir }
}

test('one runtime that never starts does not hold the app shut', async (t) => {
  const mute = new MuteRuntime({ id: 'mute' as RuntimeId, name: 'Mute' })
  const good = new FakeRuntime({ id: 'good' as RuntimeId, name: 'Good' })
  const { host, stateDir } = await hostWith([mute, good], 40)
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  const startedAt = Date.now()
  await host.start()
  const took = Date.now() - startedAt

  assert.ok(mute.startCalled, 'the silent runtime was still asked to start')
  assert.ok(took < 2_000, `start() returned in ${took}ms rather than hanging`)
  assert.equal(good.health().state, 'ready', 'the agent that could start, did')
})

test('a runtime that arrives late is still announced', async (t) => {
  const late = new LateRuntime({ id: 'late' as RuntimeId, name: 'Late' })
  const { host, stateDir } = await hostWith([late], 30)
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  await host.start()

  // Giving up waiting is not giving up: the attempt is still running, so an
  // agent that comes up afterwards reports its health to a window that is by
  // then open to hear it.
  const seen: RuntimeHealth[] = []
  const off: Unsubscribe = late.onHealthChange((health) => seen.push(health))
  late.arrive()
  await new Promise((resolve) => setTimeout(resolve, 20))
  off()
  assert.equal(late.health().state, 'ready', 'the late runtime came up after start() returned')
  assert.deepEqual(
    seen.map((health) => health.state),
    ['ready'],
    'and said so on the channel the window listens to',
  )
})

/** Every error the host logs, whichever scope it logs it under. */
class ErrorsKept extends Logger {
  readonly errors: { message: string; details?: unknown }[] = []
  constructor() {
    super('test', { level: 'error', console: false })
  }
  override child(): Logger {
    return this
  }
  override error(message: string, details?: unknown): void {
    this.errors.push({ message, details })
  }
}

test('a folder of flow runs that cannot be read does not hold the app shut', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-startup-'))
  /* A folder that points at itself: every open of it is ELOOP, for any user —
     root included, whom a mode-000 folder would not refuse. */
  const runs = join(stateDir, 'flows')
  await symlink(runs, runs)
  const logger = new ErrorsKept()
  const host = new Host({
    logger,
    state: new StateStore(join(stateDir, 'state.json')),
    startTimeoutMs: 40,
    catalogRefreshMs: 0,
  })
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  /* Raised out of `load`, and not out of here: one folder that will not open
     costs flows, not every conversation and room on the desk, which is what a
     rejection here costs — the shell answers it with "could not start" and
     quits. */
  await host.start()

  /* Where somebody meets it: starting a flow, the one thing a desk that cannot
     read its runs must not do. The refusal carries the reason. */
  await assert.rejects(host.call('flow/start', { room: 'any', source: 'name: Tidy' }), /ELOOP/)
  assert.ok(
    logger.errors.some((line) => JSON.stringify(line.details).includes('ELOOP')),
    'and the log records it as an error, with the reason',
  )
})
