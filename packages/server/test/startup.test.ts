import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RuntimeHealth, RuntimeId, Unsubscribe } from '@harnessdesk/protocol'

import { Host, Logger, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { shippedAgentsCopy } from './fixtures/harness.js'

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

test('a folder of rooms that cannot be read refuses the launch, and stops no flow on its way out', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-startup-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const rooms = join(stateDir, 'team')
  await symlink(rooms, rooms)
  /* A run still going in a room this launch cannot see. The flow engine asks
     whether each running run's room exists, and stops the ones whose room is
     gone — so a desk that read "cannot open the rooms" as "no rooms" stopped
     every flow it had, on disk, for good. */
  await mkdir(join(stateDir, 'flows'))
  const run = join(stateDir, 'flows', 'live-run.json')
  await writeFile(
    run,
    JSON.stringify({
      version: 1,
      id: 'live-run',
      room: 'room-1',
      flow: { name: 'Fix and review', roles: [], rules: [], inputs: [] },
      state: 'running',
      vars: {},
      seats: [],
      rounds: [],
      record: [],
      startedAt: 1,
    }),
  )
  const logger = new ErrorsKept()
  const host = new Host({
    logger,
    state: new StateStore(join(stateDir, 'state.json')),
    startTimeoutMs: 40,
    catalogRefreshMs: 0,
  })

  const refused = await host.start().then(
    () => null,
    (error: unknown) => error,
  )
  // A quit after a refused start has to work: it is what the shell does next.
  await host.dispose()

  const kept = JSON.parse(await readFile(run, 'utf8')) as { state: string }
  assert.equal(kept.state, 'running', 'the run is still live on disk, not stopped for a room nobody could see')
  /* Refused rather than degraded, because rooms are what the rest of the desk
     stands on and a desk without them does damage: the run above, and every
     room's conversations taken as belonging to none. The shell answers a
     start that rejects with "could not start" and this sentence. */
  assert.ok(refused instanceof Error, 'the launch was refused')
  assert.ok(refused.message.includes(rooms), 'naming the folder')
  assert.match(refused.message, /ELOOP/, 'and the reason')
  assert.ok(
    logger.errors.some((line) => JSON.stringify(line.details).includes('ELOOP')),
    'and the log a diagnostics bundle ships records it',
  )
})

/**
 * F6 of the Task 8 fix: pointing the roster's watch at every open project
 * asks git about each remembered folder — its repository, and its own top
 * level (`gitOps.topLevel`, for a linked worktree). Nothing below `start()`
 * needs that answer before it can run, so `start()` must not wait on it: a
 * stalled volume, or a checkout with many linked worktrees, must never sit
 * between a window opening and any runtime starting.
 *
 * A real `git` answers a folder that is not a repository in a few
 * milliseconds, so proving "does not wait" by counting remembered folders
 * would have to spawn dozens of real processes to get a gap worth measuring —
 * and on a machine already busy (another agent's own build, a concurrent
 * review), spawning that many competes for the same CPU `start()` itself
 * needs, which widens `start()`'s own time too and erases the very gap the
 * count was meant to create. So this stands a slow stand-in for `git` on
 * `PATH` instead — one remembered folder is enough once the answer to "is
 * this a repository" deliberately takes noticeably long to arrive — which
 * makes the delay exact, known ahead of time, and unaffected by how loaded
 * the machine happens to be.
 */
test('start() does not wait on a slow answer to whether a remembered folder is a repository', async (t) => {
  // A stand-in for `git`, prepended onto PATH, that always takes a fixed 3s
  // to answer (and then refuses, as it would for a folder git cannot place):
  // `execFile('git', …)` resolves the bare name from PATH, so this reaches it
  // in the same way the real one would.
  const fakeGitDir = await mkdtemp(join(tmpdir(), 'hd-startup-fakegit-'))
  const fakeGit = join(fakeGitDir, 'git')
  await writeFile(fakeGit, '#!/bin/sh\nsleep 3\nexit 1\n')
  await chmod(fakeGit, 0o755)
  const realPath = process.env['PATH']
  process.env['PATH'] = `${fakeGitDir}:${realPath ?? ''}`
  t.after(() => {
    process.env['PATH'] = realPath
  })

  const stateDir = await mkdtemp(join(tmpdir(), 'hd-startup-'))
  const project = join(stateDir, 'project')
  await mkdir(join(project, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), '---\nname: Scout\n---\nLook.\n')
  await writeFile(
    join(stateDir, 'state.json'),
    JSON.stringify({
      version: 1,
      installId: 'hd-startup-test',
      workspaces: [{ id: 'w0', path: project, name: 'project', lastOpenedAt: Date.now() }],
      preferences: {},
    }),
  )

  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    catalogRefreshMs: 0,
    // Waited on below: a copy, so no edit to the real shipped folder can be it.
    builtinAgents: await shippedAgentsCopy(),
  })
  const pushed: unknown[] = []
  host.addBroadcaster((notification) => pushed.push(notification))
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(fakeGitDir, { recursive: true, force: true })
  })

  const startedAt = Date.now()
  await host.start()
  const took = Date.now() - startedAt
  assert.ok(took < 1_500, `start() returned in ${took}ms while the one remembered folder's git probe was still sleeping for 3s`)

  // The background work start() was freed from waiting on still finishes,
  // once the slow answer finally arrives: an Agent written into the project
  // among them is eventually noticed.
  const isProjectChanged = (one: unknown): boolean =>
    typeof one === 'object' &&
    one !== null &&
    'method' in one &&
    (one as { method: unknown }).method === 'agent/changed' &&
    (one as { params?: { project?: unknown } }).params?.project === project
  const end = Date.now() + 8_000
  let n = 0
  for (;;) {
    await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), `---\nname: Scout\n---\nAgain ${n++}.\n`)
    const attemptEnd = Math.min(Date.now() + 800, end)
    while (!pushed.some(isProjectChanged) && Date.now() <= attemptEnd) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (pushed.some(isProjectChanged)) break
    if (Date.now() > end) throw new Error('timed out waiting for the roster watch to catch up on its own, in the background')
  }
})
