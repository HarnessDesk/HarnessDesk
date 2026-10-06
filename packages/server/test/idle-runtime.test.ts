import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { membersOf, type GoalView, type IdleRuntimeRead, type RuntimeHealth, type SeatRecord, type WireNotification } from '@harnessdesk/protocol'

import { Host, Logger, StateStore } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { makeRepo } from './fixtures/evidence-desk.js'

const silent = new Logger('test', { level: 'error', console: false })

class IdleRuntime extends FakeRuntime {
  starts = 0
  stops = 0
  nextFailure: string | null = null
  startBarrier: Promise<void> | null = null
  releaseStart: (() => void) | null = null
  stopBarrier: Promise<void> | null = null
  releaseStop: (() => void) | null = null

  override async start(): Promise<void> {
    this.starts += 1
    const barrier = this.startBarrier
    if (barrier) await barrier
    if (this.nextFailure) {
      const reason = this.nextFailure
      this.nextFailure = null
      throw new Error(reason)
    }
    await super.start()
  }

  holdNextStart(): void {
    this.startBarrier = new Promise<void>((resolve) => { this.releaseStart = resolve })
  }

  continueStart(): void {
    this.startBarrier = null
    this.releaseStart?.()
    this.releaseStart = null
  }

  holdNextStop(): void {
    this.stopBarrier = new Promise<void>((resolve) => { this.releaseStop = resolve })
  }

  continueStop(): void {
    this.stopBarrier = null
    this.releaseStop?.()
    this.releaseStop = null
  }

  async stopForIdle(): Promise<boolean> {
    this.stops += 1
    const barrier = this.stopBarrier
    if (barrier) await barrier
    this.setHealth({ state: 'idle' } as unknown as RuntimeHealth)
    return true
  }
}

const makeHost = async (runtime: FakeRuntime, idleStopMs = 25, seatRestMs = 25) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-idle-runtime-'))
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    catalogRefreshMs: 0,
    idleStopMs,
    ...{ seatRestMs },
  })
  host.register(runtime)
  return { host, stateDir }
}

test('stops an unused runtime and starts it again when a session is created', async (t) => {
  const runtime = new IdleRuntime({ id: 'idle-test' as never, name: 'Idle Test' })
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  await host.start()
  await new Promise((resolve) => setTimeout(resolve, 80))

  assert.equal(runtime.stops, 1)
  assert.equal(runtime.health().state, 'idle')

  const created = await host.call('session/create', {
    runtime: runtime.info.id,
    options: { cwd: '/w' },
  })

  assert.equal(runtime.starts, 2)
  assert.equal((created as { runtime: string }).runtime, runtime.info.id)
})

test('a single conversation process loss preserves its queue and other working handles', async (t) => {
  const runtime = new IdleRuntime()
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => { await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  await host.start()
  const first = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } }) as { id: string }
  const second = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } }) as { id: string }
  const record = host.registry.get(runtime.info.id, first.id as never)!
  const working = host.registry.get(runtime.info.id, second.id as never)!
  await host.call('turn/send', { runtime: runtime.info.id, sessionId: second.id as never,
    input: [{ type: 'text', text: 'Keep working' }] })
  host.registry.enqueue(record, 'waiting', [{ type: 'text', text: 'Follow up' }])
  const live = working.live
  const notifications: WireNotification[] = []
  const unsubscribe = host.addBroadcaster((notification) => notifications.push(notification))
  t.after(unsubscribe)
  runtime.emit({ type: 'session/detached', sessionId: first.id as never })
  assert.equal(record.live, null)
  assert.equal(record.detached, true)
  assert.equal(record.queue.status, 'paused')
  assert.equal(record.queue.messages[0]?.id, 'waiting')
  const queue = notifications.flatMap((one) => one.method === 'event' ? [one.params.event] : [])
    .find((event) => event.type === 'session/queue' && event.sessionId === first.id)
  assert.ok(queue && queue.type === 'session/queue', 'detach pushes the queue to connected windows')
  assert.equal(queue.queue.status, 'paused')
  assert.equal(queue.queue.messages[0]?.id, 'waiting')
  assert.equal(working.live, live)
  assert.ok(working.running.size > 0)
  assert.equal(runtime.stops, 0)
  await host.call('session/resume', { runtime: runtime.info.id, sessionId: first.id as never })
  assert.equal(host.registry.get(runtime.info.id, first.id as never)?.live?.id, first.id)
  assert.equal(record.detached, false)
})

test('resumes an idle-stopped conversation and serves its cached history without starting', async (t) => {
  const runtime = new IdleRuntime({ id: 'resume-idle-test' as never, name: 'Resume Idle Test' })
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  const opened = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } }) as { id: string }
  host.registry.detachAll(runtime.info.id)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.health().state, 'idle')

  const history = await host.call('session/list', { runtime: runtime.info.id, archived: 'exclude' }) as unknown as { data: readonly { id: string }[] }
  assert.ok(history.data.some((row) => row.id === opened.id), 'the host transcript remains in the history list')
  assert.equal(runtime.starts, 1, 'history does not wake an idle runtime')

  const resumed = await host.call('session/resume', { runtime: runtime.info.id, sessionId: opened.id as never }) as { id: string }
  assert.equal(resumed.id, opened.id)
  assert.equal(runtime.starts, 2)
  assert.equal(runtime.resumes, 1)
})

test('reads during an idle stop wait for the stop and use runtime caches without starting', async (t) => {
  const runtime = new IdleRuntime({ id: 'read-stop-test' as never, name: 'Read Stop Test' })
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    runtime.continueStop()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  runtime.holdNextStop()
  while (runtime.stops === 0) await new Promise((resolve) => setTimeout(resolve, 1))

  const done = new Set<string>()
  const watch = <T>(name: string, call: Promise<T>): Promise<T> => call.then((value) => { done.add(name); return value })
  const history = watch('history', host.call('session/list', { runtime: runtime.info.id, archived: 'exclude' }))
  const models = watch('models', host.call('runtime/models', { runtime: runtime.info.id }))
  const options = watch('options', host.call('runtime/options', { runtime: runtime.info.id }))
  const defaults = watch('defaults', host.call('runtime/sessionDefaults', { runtime: runtime.info.id, cwd: '/w' }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual([...done], [], 'every read waits for the stop barrier')
  assert.equal(runtime.starts, 1, 'read-only calls do not start an idle runtime')

  runtime.continueStop()
  await Promise.all([history, models, options, defaults])
  assert.equal(runtime.health().state, 'idle')
  assert.equal(runtime.starts, 1)
})

test('queued messages keep a detached runtime from idle stop', async (t) => {
  const runtime = new IdleRuntime({ id: 'queued-idle-test' as never, name: 'Queued Idle Test' })
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } }) as { id: string }
  const record = host.registry.get(runtime.info.id, session.id as never)!
  host.registry.detachAll(runtime.info.id)
  host.registry.enqueue(record, 'queued-test', [{ type: 'text', text: 'waiting' }])
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.stops, 0)
})

test('cached skills are served from an idle runtime without restarting it', async (t) => {
  const runtime = new IdleRuntime({ id: 'skills-idle-test' as never, name: 'Skills Idle Test' })
  Object.assign(runtime, {
    listSkills: async () => [{ name: 'cached', description: '', enabled: true, toggleable: false }],
    listSkillProblems: async () => [],
  })
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.health().state, 'idle')
  const skills = await host.call('runtime/skills', { runtime: runtime.info.id, cwd: '/w' })
  assert.deepEqual(skills, [{ name: 'cached', description: '', enabled: true, toggleable: false }])
  assert.equal(runtime.starts, 1)
})

test('cached reads join a restart already triggered by an unobserved history page', async (t) => {
  class SnapshotRuntime extends IdleRuntime {
    canReadWhileIdle(read: IdleRuntimeRead): boolean {
      return read.method !== 'listSessions' || !read.query?.cursor
    }
    override async start(): Promise<void> {
      if (this.starts > 0) this.setHealth({ state: 'starting' })
      await super.start()
    }
  }
  const runtime = new SnapshotRuntime({ id: 'read-start-test' as never, name: 'Read Start Test' })
  Object.assign(runtime, { listSkills: async () => [] })
  for (const method of ['listSessions', 'listModels', 'listOptions', 'defaultSessionOptions', 'getAccount', 'listSkills'] as const) {
    const read = Reflect.get(runtime, method) as (...args: unknown[]) => Promise<unknown>
    Object.assign(runtime, { [method]: (...args: unknown[]) => {
      assert.notEqual(runtime.health().state, 'starting', 'the host must wait for startup before reading')
      return Reflect.apply(read, runtime, args)
    } })
  }
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    runtime.continueStart()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.health().state, 'idle')
  runtime.holdNextStart()
  const history = host.call('session/list', { runtime: runtime.info.id, cursor: 'unread' })
  while (runtime.starts < 2) await new Promise((resolve) => setTimeout(resolve, 1))
  let settled = false
  const reads = Promise.allSettled([
    host.call('session/list', { runtime: runtime.info.id }),
    host.call('runtime/models', { runtime: runtime.info.id }),
    host.call('runtime/options', { runtime: runtime.info.id }),
    host.call('runtime/sessionDefaults', { runtime: runtime.info.id, cwd: '/w' }),
    host.call('runtime/account', { runtime: runtime.info.id }),
    host.call('runtime/skills', { runtime: runtime.info.id }),
  ]).then((results) => { settled = true; return results })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(settled, false, 'a concurrent cached read waits on the same startup')
  runtime.continueStart()
  await history
  assert.ok((await reads).every((read) => read.status === 'fulfilled'))
  assert.equal(runtime.starts, 2)
})

test('account activity waits for a held restart before usage refresh reads it', async (t) => {
  class ActivityRuntime extends IdleRuntime {
    canReadWhileIdle(read: IdleRuntimeRead): boolean {
      return read.method !== 'listSessions' || !read.query?.cursor
    }
    override async start(): Promise<void> {
      if (this.starts > 0) this.setHealth({ state: 'starting' })
      await super.start()
    }
    override getAccountActivity = async () => {
      if (this.health().state !== 'ready') return null
      return { days: [], lifetimeTokens: 4200, peakDailyTokens: null, currentStreakDays: null, longestStreakDays: null }
    }
  }
  const runtime = new ActivityRuntime()
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    runtime.continueStart()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  await until(() => runtime.health().state === 'idle')
  runtime.holdNextStart()
  const history = host.call('session/list', { runtime: runtime.info.id, cursor: 'unread' })
  await until(() => runtime.starts === 2)
  let settled = false
  const usage = host.call('usage/refresh', { runtime: runtime.info.id }).then((value) => { settled = true; return value })
  await pause(10)
  assert.equal(settled, false, 'account activity joins the in-flight restart')
  runtime.continueStart()
  await history
  assert.equal((await usage)[0]?.accountActivity?.lifetimeTokens, 4200)
  assert.equal(runtime.starts, 2)
})

test('Dashboard usage polling every two minutes permits idle release and never wakes the runtime', async (t) => {
  const runtime = new IdleRuntime({ capabilities: { metered: true } })
  Object.assign(runtime, {
    getAccountActivity: async () => ({ days: [], lifetimeTokens: 4200, peakDailyTokens: null, currentStreakDays: null, longestStreakDays: null }),
  })
  const { host, stateDir } = await makeHost(runtime, 10 * 60_000)
  t.after(async () => { await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  await host.start()
  t.mock.timers.tick(1_000)
  await pause(5)
  let observedAt = 0
  for (let n = 0; n < 6; n++) {
    const idle = runtime.health().state === 'idle'
    const reports = await host.call('usage/refresh', { runtime: runtime.info.id })
    assert.equal(reports[0]?.accountActivity?.lifetimeTokens, 4200)
    if (idle) assert.equal(reports[0]?.fetchedAt, observedAt, 'an idle snapshot retains its observation time')
    else observedAt = reports[0]!.fetchedAt
    await host.call('session/list', { runtime: runtime.info.id })
    await host.call('runtime/models', { runtime: runtime.info.id })
    t.mock.timers.tick(120_000)
    await pause(5)
  }
  assert.equal(runtime.stops, 1, 'scheduled observation does not restart the ten-minute quiet interval')
  assert.equal(runtime.health().state, 'idle')
  await host.call('usage/refresh', { runtime: runtime.info.id })
  assert.equal(runtime.starts, 1, 'usage polls do not wake a resting runtime')
})

test('an in-flight account activity read delays idle release without resetting the quiet interval', async (t) => {
  const runtime = new IdleRuntime()
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let reading = false
  Object.assign(runtime, { getAccountActivity: async () => { reading = true; await barrier; return null } })
  const { host, stateDir } = await makeHost(runtime, 10 * 60_000)
  t.after(async () => { release(); await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  await host.start()
  t.mock.timers.tick(1_000)
  await pause(5)
  const usage = host.call('usage/refresh', { runtime: runtime.info.id })
  await until(() => reading)
  t.mock.timers.tick(11 * 60_000)
  await pause(5)
  assert.equal(runtime.stops, 0, 'a read still needs the live process')
  release()
  await usage
  t.mock.timers.tick(1_000)
  await pause(5)
  assert.equal(runtime.stops, 1, 'completion permits shutdown at the original quiet deadline')
})

test('a room post resumes an idle-stopped member and delivers to it', async (t) => {
  const runtime = new IdleRuntime({ id: 'room-idle-test' as never, name: 'Room Idle Test' })
  const { host, stateDir } = await makeHost(runtime, 0)
  const repo = await makeRepo('hd-room-idle-test-')
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(repo.dir, { recursive: true, force: true })
  })
  await host.start()
  await host.call('workspace/open', { path: repo.dir })
  const created = await host.call('goal/create', { root: repo.dir, sentence: 'Idle room member' }) as unknown as { board: { id: string } }
  const room = created.board.id
  const card = await host.call('team/add', { room, title: 'Keep working' }) as { id: number }
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: repo.dir } }) as { id: string }
  await host.call('goal/assign', {
    goal: room,
    card: card.id,
    session: { runtime: runtime.info.id, sessionId: session.id },
  })
  host.registry.detachAll(runtime.info.id)
  runtime.setHealth({ state: 'idle' } as unknown as RuntimeHealth)
  await host.call('team/post', { room, text: 'Wake and deliver.' })
  const state = await host.call('team/state', { room }) as { channel: readonly { kind: string; state?: string }[] }
  assert.equal(state.channel.filter((entry) => entry.kind === 'message').at(-1)?.state, 'delivered')
  assert.equal(runtime.starts, 2)
  assert.equal(runtime.resumes, 1)
})

test('an open session prevents idle stop', async (t) => {
  const runtime = new IdleRuntime({ id: 'open-idle-test' as never, name: 'Open Idle Test' })
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  await host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.stops, 0)
})

test('a running turn and pending approval keep a detached session out of idle stop', async (t) => {
  const runtime = new IdleRuntime({ id: 'active-state-test' as never, name: 'Active State Test' })
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } }) as { id: string }
  const record = host.registry.get(runtime.info.id, session.id as never)!
  host.registry.detachAll(runtime.info.id)
  record.running.add('turn-running' as never)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.stops, 0)
  record.running.clear()
  record.approvals.set('pending' as never, {} as never)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.stops, 0)
  record.approvals.clear()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.stops, 1)
})

test('a live Seat prevents idle stop even after its session handle detaches', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-idle-seat-'))
  const repo = await makeRepo('hd-idle-seat-repo-')
  const runtime = new IdleRuntime({ id: 'idle-seat-test' as never, name: 'Idle Seat Test' })
  await mkdir(join(stateDir, 'agents', 'scout'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'scout', 'AGENT.md'), [
    '---', 'name: Scout', 'permission: read', 'prefer: [idle-seat-test]', '---', 'Inspect the project.', '',
  ].join('\n'))
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: join(stateDir, 'builtin'),
    catalogRefreshMs: 0,
    idleStopMs: 25,
  })
  host.register(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(repo.dir, { recursive: true, force: true })
  })
  await host.start()
  await host.call('workspace/open', { path: repo.dir })
  const session = await host.call('agent/seat', { id: 'scout', cwd: repo.dir }) as { id: string }
  const seat = await host.call('evidence/seat', { runtime: runtime.info.id, sessionId: session.id as never }) as { session: { runtime: string }; closed: unknown }
  assert.equal(seat.session.runtime, runtime.info.id)
  assert.equal(seat.closed, null)
  const stopsBeforeDetach = runtime.stops
  host.registry.detachAll(runtime.info.id)
  const stillOpen = await host.call('evidence/seat', { runtime: runtime.info.id, sessionId: session.id as never }) as { closed: unknown }
  assert.equal(stillOpen.closed, null)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.stops, stopsBeforeDetach)
  assert.ok(host.registry.get(runtime.info.id, session.id as never)?.live === null)
})

test('concurrent session creates share one restart after idle stop', async (t) => {
  const runtime = new IdleRuntime({ id: 'single-flight-test' as never, name: 'Single Flight Test' })
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    runtime.continueStart()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.health().state, 'idle')
  runtime.holdNextStart()
  const a = host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } })
  const b = host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } })
  while (runtime.starts < 2) await new Promise((resolve) => setTimeout(resolve, 1))
  runtime.continueStart()
  await Promise.all([a, b])
  assert.equal(runtime.starts, 2)
})

test('an on-demand start failure reaches the waiting operation with its reason', async (t) => {
  const runtime = new IdleRuntime({ id: 'failed-restart-test' as never, name: 'Failed Restart Test' })
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.health().state, 'idle')
  runtime.nextFailure = 'scripted bridge refusal'
  const [a, b] = await Promise.allSettled([
    host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } }),
    host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } }),
  ])
  for (const result of [a, b]) {
    assert.equal(result.status, 'rejected')
    assert.match(String(result.status === 'rejected' ? result.reason : ''), /scripted bridge refusal/)
  }
})

test('a session arriving during idle stop waits, then starts the helper', async (t) => {
  const runtime = new IdleRuntime({ id: 'stop-race-test' as never, name: 'Stop Race Test' })
  const { host, stateDir } = await makeHost(runtime)
  t.after(async () => {
    runtime.continueStop()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  runtime.holdNextStop()
  while (runtime.stops === 0) await new Promise((resolve) => setTimeout(resolve, 1))
  const opening = host.call('session/create', { runtime: runtime.info.id, options: { cwd: '/w' } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runtime.starts, 1, 'the operation waits while the process stop owns the lifecycle')
  runtime.continueStop()
  await opening
  assert.equal(runtime.starts, 2)
})

test('shutdown with an idle-stopped runtime completes cleanly', async () => {
  const runtime = new IdleRuntime({ id: 'idle-shutdown-test' as never, name: 'Idle Shutdown Test' })
  const { host, stateDir } = await makeHost(runtime)
  await host.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(runtime.health().state, 'idle')
  await host.dispose()
  assert.equal(runtime.starts, 1)
  await rm(stateDir, { recursive: true, force: true })
})


const pause = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'the idle lifecycle reached its expected state')
    await pause(5)
  }
}

const seated = async (t: TestContext, runtime = new IdleRuntime(), seatRestMs = 25) => {
  const { host, stateDir } = await makeHost(runtime, 25, seatRestMs)
  const repo = await makeRepo('hd-rest-seat-')
  const hostsToDispose = [host]
  t.after(async () => {
    for (const current of [...hostsToDispose].reverse()) await current.dispose()
    await rm(stateDir, { recursive: true, force: true })
    await rm(repo.dir, { recursive: true, force: true })
  })
  await host.start()
  await host.call('workspace/open', { path: repo.dir })
  const goal = await host.call('goal/create', { root: repo.dir, sentence: 'Finish the work' }) as GoalView
  const card = await host.call('team/add', { room: goal.goal.id, title: 'Inspect' }) as { id: number }
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: repo.dir } }) as { id: string }
  const seat = await host.call('goal/assign', { goal: goal.goal.id, card: card.id,
    session: { runtime: runtime.info.id, sessionId: session.id } }) as SeatRecord
  const record = host.registry.get(runtime.info.id, session.id as never)!
  const finish = () => host.call('team/intent', { room: goal.goal.id, id: card.id, action: 'done' })
  return { host, stateDir, runtime, goal: goal.goal, card, seat, record, finish, repo, hostsToDispose }
}

test('a finished Seat releases its handle, idle-stops, and remains a Goal member', async (t) => {
  const d = await seated(t)
  await d.finish()
  await until(() => d.record.live === null && d.runtime.health().state === 'idle')
  assert.equal(d.record.detached, false)
  const view = await d.host.call('goal/read', { goal: d.goal.id }) as GoalView
  assert.equal(membersOf(view.goal, view.members).length, 1)
  assert.equal(view.members[0]?.closed, null)
})

test('a settled Flow keeps its finished Seats while their runtime rests', async (t) => {
  const runtime = new IdleRuntime()
  const { host, stateDir } = await makeHost(runtime)
  const repo = await makeRepo('hd-rest-flow-')
  t.after(async () => { await host.dispose(); await rm(stateDir, { recursive: true, force: true }); await rm(repo.dir, { recursive: true, force: true }) })
  await mkdir(join(stateDir, 'agents', 'scout'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'scout', 'AGENT.md'), '---\nname: Scout\nceiling: read\nprefer: [fake]\n---\nInspect.\n')
  runtime.onSend = (session) => queueMicrotask(() => session.finish())
  await host.start()
  await host.call('workspace/open', { path: repo.dir })
  const source = 'version: 2\nname: Rest\nroles:\n  inspect:\n    kind: agent\n    uses: [scout]\n    grant: read\n    independentOf: []\nseed: { role: inspect, title: Inspect }\nrules: []\n'
  const preview = await host.call('flow/preview', { root: repo.dir, source }) as { token: string }
  assert.ok(preview.token)
  const run = await host.call('flow/start-goal', { root: repo.dir, source, token: preview.token, sentence: 'Finish inspection' }) as { goal: string }
  let view: GoalView
  for (let n = 0; ; n++) {
    view = await host.call('goal/read', { goal: run.goal }) as GoalView
    if (view.board.intents[0]?.state === 'claimed') break
    assert.ok(n < 200); await pause(5)
  }
  const card = view.board.intents[0]!
  const record = host.registry.get(card.claim!.runtime, card.claim!.sessionId as never)!
  await host.call('team/intent', { room: run.goal, id: card.id, action: 'done' })
  await until(() => record.live === null && runtime.health().state === 'idle')
  view = await host.call('goal/read', { goal: run.goal }) as GoalView
  assert.equal(view.members.length, 1)
  assert.equal(view.members[0]?.closed, null)
})

for (const blocker of ['turn', 'approval', 'queue', 'task', 'card'] as const) {
  test(`a Seat with a ${blocker} never rests until that work ends`, async (t) => {
    const d = await seated(t)
    if (blocker === 'turn') d.record.running.add('running' as never)
    if (blocker === 'approval') d.record.approvals.set('pending', {} as never)
    if (blocker === 'queue') d.host.registry.enqueue(d.record, 'waiting', [{ type: 'text', text: 'Follow up' }])
    if (blocker === 'task') d.record.tasks = [{ id: 'task', label: 'Background work', kind: 'other', state: 'running', stoppable: true }]
    const handle = d.record.live
    assert.ok(handle)
    if (blocker !== 'card') await d.finish()
    await pause()
    assert.equal(d.record.live, handle)
    assert.equal(d.runtime.health().state, 'ready')
    d.record.running.clear(); d.record.approvals.clear(); d.host.registry.clearQueue(d.record); d.record.tasks = []
    if (blocker === 'card') await d.finish()
    await until(() => d.record.live === null && d.runtime.health().state === 'idle')
  })
}

for (const door of ['message', 'open', 'card'] as const) {
  test(`a ${door} reopens a resting Seat in its own conversation`, async (t) => {
    const d = await seated(t)
    await d.host.call('turn/send', { runtime: d.runtime.info.id, sessionId: d.record.session.id, input: [{ type: 'text', text: 'Prior context' }] })
    d.runtime.sessions.get(d.record.session.id)!.finish()
    await d.finish()
    await until(() => d.record.live === null && d.runtime.health().state === 'idle')
    const resumes = d.runtime.resumes
    if (door === 'open') await d.host.call('session/resume', { runtime: d.runtime.info.id, sessionId: d.record.session.id })
    else {
      if (door === 'card') await d.host.call('team/intent', { room: d.goal.id, id: d.card.id, action: 'reopen' })
      await d.host.call('team/post', { room: d.goal.id, text: door === 'card' ? 'Take your card again.' : 'Follow up.' })
    }
    assert.equal(d.runtime.resumes, resumes + 1)
    assert.equal(d.record.live?.id, d.seat.session.sessionId)
    assert.equal(d.record.session.cwd, d.repo.dir)
    assert.ok(d.record.session.turns.some((turn) => turn.items.some((item) => item.type === 'userMessage')))
    assert.equal((await d.host.call('goal/read', { goal: d.goal.id }) as GoalView).members.length, 1)
  })
}

test('a reopen refusal is surfaced without closing the resting Seat', async (t) => {
  const d = await seated(t)
  await d.finish()
  await until(() => d.record.live === null && d.runtime.health().state === 'idle')
  d.runtime.resumeFailure = new Error('scripted resume refusal')
  await assert.rejects(d.host.call('turn/send', { runtime: d.runtime.info.id, sessionId: d.record.session.id,
    input: [{ type: 'text', text: 'Follow up' }] }), /scripted resume refusal/)
  assert.equal((await d.host.call('goal/read', { goal: d.goal.id }) as GoalView).members[0]?.closed, null)
})

test('a working session keeps a runtime shared with a resting Seat running', async (t) => {
  const d = await seated(t)
  const working = await d.host.call('session/create', { runtime: d.runtime.info.id, options: { cwd: d.repo.dir } }) as { id: string }
  await d.host.call('turn/send', { runtime: d.runtime.info.id, sessionId: working.id as never, input: [{ type: 'text', text: 'Work' }] })
  await d.finish()
  await until(() => d.record.live === null)
  assert.equal(d.runtime.health().state, 'ready')
})

for (const capability of ['resume', 'stopForIdle'] as const) {
  test(`a runtime without ${capability} keeps a finished Seat live`, async (t) => {
    const runtime = new IdleRuntime({ capabilities: { resume: capability !== 'resume' } })
    if (capability === 'stopForIdle') Object.defineProperty(runtime, 'stopForIdle', { value: undefined })
    const d = await seated(t, runtime)
    const handle = d.record.live
    assert.ok(handle)
    await d.finish()
    await pause()
    assert.equal(d.record.live, handle)
    assert.equal(runtime.health().state, 'ready')
  })
}

test('the Seat rest interval is independent of the runtime idle interval', { timeout: 10_000 }, async (t) => {
  const d = await seated(t, new IdleRuntime(), 60_000)
  await d.finish()
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  await pause(50) // Let the real reaper observe quietness while its clock stands still.
  t.mock.timers.tick(100)
  await pause(50)
  assert.ok(d.record.live)
  t.mock.timers.tick(60_000)
  await until(() => d.record.live === null)
})

test('an open card a Seat previously held prevents rest', async (t) => {
  const d = await seated(t)
  const handle = d.record.live
  assert.ok(handle)
  await d.host.call('team/intent', { room: d.goal.id, id: d.card.id, action: 'release' })
  await pause()
  assert.equal(d.record.live, handle)
  assert.equal(d.runtime.health().state, 'ready')
  await d.finish()
  await until(() => d.record.live === null)
})

test('a send arriving during release waits, then resumes instead of using the closing handle', async (t) => {
  const d = await seated(t)
  const live = d.record.live!
  let release!: () => void
  let closing = false
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const close = live.close.bind(live)
  live.close = async () => { closing = true; await barrier; await close() }
  t.after(() => release())
  await d.finish()
  await until(() => closing)
  const resumes = d.runtime.resumes
  let sent = false
  const sending = d.host.call('turn/send', { runtime: d.runtime.info.id, sessionId: d.record.session.id,
    input: [{ type: 'text', text: 'Follow up while resting' }] }).then(() => { sent = true })
  await pause(20)
  assert.equal(sent, false)
  release()
  await sending
  assert.equal(d.runtime.resumes, resumes + 1)
  assert.ok(d.record.live)
})

test('a Team message waiting for acceptance keeps a finished Seat live', async (t) => {
  const d = await seated(t)
  const session = d.runtime.sessions.get(d.record.session.id)!
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  t.after(() => release())
  let accepting = false
  const send = session.send.bind(session)
  session.send = async (...args) => { accepting = true; await barrier; return send(...args) }
  await d.finish()
  const post = d.host.call('team/post', { room: d.goal.id, text: 'Follow up' })
  t.after(() => post.catch(() => {}))
  await until(() => accepting)
  const handle = d.record.live
  await pause(100)
  assert.ok(handle)
  assert.equal(d.record.live, handle)
  assert.equal(d.runtime.health().state, 'ready')
  release()
  await post
})

test('a task that starts and ends between reaper ticks restarts the quiet interval', { timeout: 10_000 }, async (t) => {
  const d = await seated(t, new IdleRuntime(), 60_000)
  await d.finish()
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  await pause(50)
  t.mock.timers.tick(59_900)
  const task = { id: 'brief-task', label: 'Brief work', kind: 'other' as const, state: 'running' as const, stoppable: true }
  d.runtime.tasks.put(d.record.session.id, [task])
  d.runtime.tasks.put(d.record.session.id, [])
  t.mock.timers.tick(200)
  await pause(50)
  assert.ok(d.record.live)
  t.mock.timers.tick(60_000)
  await until(() => d.record.live === null)
})


test('history and cached reads do not restart a finished Seat quiet interval', async (t) => {
  const d = await seated(t, new IdleRuntime(), 60_000)
  await d.finish()
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  await pause(50)
  t.mock.timers.tick(59_900)
  await d.host.call('session/list', { runtime: d.runtime.info.id })
  await d.host.call('runtime/models', { runtime: d.runtime.info.id })
  await d.host.call('runtime/options', { runtime: d.runtime.info.id })
  await d.host.call('runtime/skills', { runtime: d.runtime.info.id, cwd: d.repo.dir })
  t.mock.timers.tick(200)
  await pause(50)
  assert.equal(d.record.live, null, 'reads leave the completed Seat quiet for the full interval')
})

for (const recoverRecord of [false, true]) {
  test(`a manually assigned completed Seat rests after restart ${recoverRecord ? 'with' : 'without'} a registry record`, async (t) => {
    const d = await seated(t, new IdleRuntime(), 60_000)
    await d.finish()
    await d.host.dispose()
    const runtime = new IdleRuntime()
    const host = new Host({ logger: silent, state: new StateStore(join(d.stateDir, 'state.json')),
      catalogRefreshMs: 0, idleStopMs: 25, seatRestMs: 25 })
    // Reuse the fake agent's store, as a real agent retains its own history.
    runtime.sessions.set(d.record.session.id, d.runtime.sessions.get(d.record.session.id)!)
    host.register(runtime)
    d.hostsToDispose.push(host)
    await host.start()
    if (recoverRecord) {
      await host.call('session/resume', { runtime: runtime.info.id, sessionId: d.record.session.id })
    } else assert.equal(host.registry.get(runtime.info.id, d.record.session.id), undefined)
    await pause(150)
    assert.equal(runtime.health().state, 'idle', 'durable held-card history does not need a live registry record')
    const view = await host.call('goal/read', { goal: d.goal.id }) as GoalView
    assert.equal(view.members[0]?.closed, null)
  })
}

test('a completed held card trimmed from the board does not prevent Seat rest', async (t) => {
  const d = await seated(t, new IdleRuntime(), 60_000)
  await d.finish()
  // Seed the capacity boundary through the Team's existing writer, then let one real add trim it.
  await d.host.teamPlane.goalPlaneWrite(d.goal.id, (cards) => [...cards,
    ...Array.from({ length: 200 }, (_, n) => ({ ...cards[0]!, id: n + 2, title: `Later work ${n}`,
      state: 'open' as const, claim: null })),
  ], async () => {})
  await d.host.call('team/add', { room: d.goal.id, title: 'Trim the settled row' })
  const view = await d.host.call('goal/read', { goal: d.goal.id }) as GoalView
  assert.ok(!view.board.intents.some((card) => card.id === d.card.id), 'the real board trimmed the settled card')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  await pause(50)
  t.mock.timers.tick(60_001)
  await pause(50)
  assert.equal(d.record.live, null, 'a known completed trimmed card remains completed')
})

test('ordinary completion and trimming retain held-card history through restart', async (t) => {
  const d = await seated(t, new IdleRuntime(), 60_000)
  // Fill the board through its ordinary save path before completing the held card.
  for (let n = 0; n < 199; n++) {
    await d.host.call('team/add', { room: d.goal.id, title: `Later work ${n}` })
  }
  await d.finish()
  await d.host.call('team/add', { room: d.goal.id, title: 'Trim the completed card' })
  const view = await d.host.call('goal/read', { goal: d.goal.id }) as GoalView
  assert.ok(!view.board.intents.some((card) => card.id === d.card.id))
  await d.host.dispose()
  const history = JSON.parse(await readFile(join(d.stateDir, 'seat-held-cards.json'), 'utf8'))
  assert.equal(history.seats.find((seat: { seat: string }) => seat.seat === d.seat.id).cards[0].state, 'done')
  const runtime = new IdleRuntime()
  const host = new Host({ logger: silent, state: new StateStore(join(d.stateDir, 'state.json')),
    catalogRefreshMs: 0, idleStopMs: 25, seatRestMs: 25 })
  host.register(runtime)
  d.hostsToDispose.push(host)
  await host.start()
  await until(() => runtime.health().state === 'idle')
  assert.equal((await host.call('goal/read', { goal: d.goal.id }) as GoalView).members[0]?.closed, null)
})

test('an ordinary later claim is retained when released before restart', async (t) => {
  const d = await seated(t, new IdleRuntime(), 60_000)
  await d.finish()
  const later = await d.host.call('team/add', { room: d.goal.id, title: 'Follow-up work' }) as { id: number }
  assert.match(await d.host.teamPlane.claim(later.id, { runtime: d.runtime.info.id, sessionId: d.record.session.id }), /^Claimed/)
  await d.host.teamPlane.flush()
  await d.host.call('team/intent', { room: d.goal.id, id: later.id, action: 'release' })
  await d.host.dispose()
  const history = JSON.parse(await readFile(join(d.stateDir, 'seat-held-cards.json'), 'utf8'))
  const held = history.seats.find((seat: { seat: string }) => seat.seat === d.seat.id).cards
  assert.equal(held.find((card: { id: number }) => card.id === later.id)?.state, 'open')
  const runtime = new IdleRuntime()
  const host = new Host({ logger: silent, state: new StateStore(join(d.stateDir, 'state.json')),
    catalogRefreshMs: 0, idleStopMs: 25, seatRestMs: 25 })
  host.register(runtime)
  d.hostsToDispose.push(host)
  await host.start()
  await pause(150)
  assert.equal(runtime.health().state, 'ready', 'unfinished prior ownership still prevents rest')
})

for (const corruption of ['json', 'null', 'root', 'seat', 'cards', 'card'] as const) {
  test(`malformed ${corruption} held-card history does not prevent startup or prove completion`, async (t) => {
    const d = await seated(t, new IdleRuntime(), 60_000)
    await d.finish()
    await d.host.dispose()
    const valid = { seat: d.seat.id, cards: [{ id: d.card.id, state: 'done', updatedAt: Date.now() }] }
    const invalid = corruption === 'seat' ? null : corruption === 'cards'
      ? { seat: 'other-seat', cards: {} } : { seat: 'other-seat', cards: [null] }
    const text = corruption === 'json' ? '{' : corruption === 'null' ? 'null' : corruption === 'root'
      ? JSON.stringify({ version: 1, seats: {} }) : JSON.stringify({ version: 1, seats: [valid, invalid] })
    const file = join(d.stateDir, 'seat-held-cards.json')
    await writeFile(file, text)
    const runtime = new IdleRuntime()
    const host = new Host({ logger: silent, state: new StateStore(join(d.stateDir, 'state.json')),
      catalogRefreshMs: 0, idleStopMs: 25, seatRestMs: 25 })
    host.register(runtime)
    d.hostsToDispose.push(host)
    await host.start()
    await pause(150)
    assert.equal(runtime.health().state, 'ready', 'a partially valid file cannot prove the Seat finished')
    assert.equal(await readFile(file, 'utf8'), text, 'startup leaves the malformed history intact')
    assert.equal((await host.call('goal/read', { goal: d.goal.id }) as GoalView).members[0]?.closed, null)
  })
}


test('a history read in flight does not interrupt a finished Seat quiet interval', async (t) => {
  const d = await seated(t, new IdleRuntime(), 60_000)
  await d.finish()
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  await pause(50)
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  t.after(() => release())
  let reading = false
  const list = d.runtime.listSessions.bind(d.runtime)
  d.runtime.listSessions = async (...args) => { reading = true; await barrier; return list(...args) }
  const history = d.host.call('session/list', { runtime: d.runtime.info.id })
  await until(() => reading)
  t.mock.timers.tick(60_001)
  await pause(50)
  assert.equal(d.record.live, null, 'an in-flight read does not count as work on every Seat')
  assert.equal(d.runtime.health().state, 'ready', 'the read still protects the runtime from stopping')
  release()
  await history
})

test('a terminal beside another runtime wakes its idle process provider exactly once', async (t) => {
  const provider = new IdleRuntime({ id: 'terminal-provider' as never, name: 'Terminal Provider' })
  const requested = new FakeRuntime({ id: 'conversation-agent' as never, name: 'Conversation Agent' })
  Object.defineProperty(requested, 'processes', { value: undefined })
  const { host, stateDir } = await makeHost(provider)
  host.register(requested)
  t.after(async () => {
    provider.continueStart()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.call('workspace/open', { path: stateDir })
  await host.start()
  await until(() => provider.health().state === 'idle')
  const starts = provider.starts
  provider.holdNextStart()
  const opened = host.call('terminal/open', {
    runtime: requested.info.id, cwd: stateDir, size: { rows: 24, cols: 80 }, sessionId: 'conversation' as never,
  })
  // Observe rejections immediately so the pre-fix refusal fails this assertion.
  const result = Promise.allSettled([opened])
  await pause(10)
  assert.equal(provider.starts, starts + 1, 'the fallback reaches the managed restart')
  assert.equal(provider.spawned.length, 0, 'spawn waits for startup to finish')
  provider.continueStart()
  assert.equal((await result)[0]?.status, 'fulfilled')
  const terminal = await opened as { terminalId: string; runtime: string }
  assert.equal(terminal.runtime, provider.info.id)
  assert.ok(terminal.terminalId)
  assert.equal(provider.starts, starts + 1, 'opening the terminal restarts only once')
  assert.equal(provider.spawned.length, 1)
  assert.equal(provider.spawned[0]?.sessionUsed, undefined, 'the other runtime does not receive the conversation id')
  const attached = await host.call('terminal/attach', { terminalId: terminal.terminalId }) as { exitCode: number | null }
  assert.equal(attached.exitCode, null)
})

test('two terminals opened during a provider startup share the same start', async (t) => {
  class StartingRuntime extends IdleRuntime {
    override async start(): Promise<void> {
      if (this.starts > 0) this.setHealth({ state: 'starting' })
      await super.start()
    }
  }
  const provider = new StartingRuntime({ id: 'starting-terminal-provider' as never, name: 'Terminal Provider' })
  const requested = new FakeRuntime({ id: 'starting-conversation-agent' as never, name: 'Conversation Agent' })
  Object.defineProperty(requested, 'processes', { value: undefined })
  const { host, stateDir } = await makeHost(provider)
  host.register(requested)
  t.after(async () => {
    provider.continueStart()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.call('workspace/open', { path: stateDir })
  await host.start()
  await until(() => provider.health().state === 'idle')

  const starting = new Promise<void>((resolve) => {
    const unsubscribe = provider.onHealthChange((health) => {
      if (health.state !== 'starting') return
      unsubscribe()
      resolve()
    })
  })
  const starts = provider.starts
  provider.holdNextStart()
  const first = host.call('terminal/open', {
    runtime: requested.info.id, cwd: stateDir, size: { rows: 24, cols: 80 },
  })
  await starting
  const second = host.call('terminal/open', {
    runtime: requested.info.id, cwd: stateDir, size: { rows: 24, cols: 80 },
  })
  const results = Promise.allSettled([first, second])

  assert.equal(provider.starts, starts + 1, 'both terminal opens share the held start')
  assert.equal(provider.spawned.length, 0, 'both spawns wait for the startup handshake')
  provider.continueStart()
  const settled = await results
  assert.ok(settled.every((result) => result.status === 'fulfilled'), 'both opens succeed after startup')
  assert.equal(provider.starts, starts + 1, 'opening both terminals starts the provider only once')
  assert.equal(provider.spawned.length, 2)
})

for (const surface of ['hooks', 'files', 'extensions', 'processes'] as const) {
  test(`${surface} wait for idle stop and shared startup, and protect in-flight work`, async (t) => {
    const runtime = new IdleRuntime({ id: `surface-${surface}` as never, name: 'Surface Test' })
    const { host, stateDir } = await makeHost(runtime)
    let releaseOperation: (() => void) | undefined
    let entered = false
    const operationBarrier = new Promise<void>((resolve) => { releaseOperation = resolve })
    const enter = async () => {
      assert.equal(runtime.health().state, 'ready', 'runtime-backed calls require completed startup')
      entered = true
      await operationBarrier
    }
    Object.assign(runtime, {
      listHooks: async () => { await enter(); return [] },
      files: { stat: async () => { await enter(); return { kind: 'file', size: 0, isSymlink: false, modifiedAt: null } } },
      extensions: { catalog: async () => { await enter(); return { plugins: [], marketplaces: [], loadErrors: [], featured: [] } } },
      processes: { spawn: async () => {
        await enter()
        return { id: 'process', onOutput: () => () => {}, onExit: () => () => {}, kill: async () => {}, write: async () => {}, resize: async () => {} }
      } },
    })
    t.after(async () => {
      releaseOperation?.(); runtime.continueStop(); runtime.continueStart()
      await host.dispose()
      await rm(stateDir, { recursive: true, force: true })
    })
    // This synthetic workspace is enough for the host's path confinement.
    await host.call('workspace/open', { path: stateDir })
    await host.start()
    runtime.holdNextStop()
    await until(() => runtime.stops === 1)
    runtime.holdNextStart()
    const call = surface === 'hooks' ? host.call('runtime/hooks', { runtime: runtime.info.id })
      : surface === 'extensions' ? host.call('runtime/catalog', { runtime: runtime.info.id })
      : surface === 'files' ? host.call('workspace/stat', { runtime: runtime.info.id, path: join(stateDir, 'fixture.txt') })
      : host.call('terminal/open', { runtime: runtime.info.id, cwd: stateDir, size: { rows: 24, cols: 80 } })
    const result = Promise.allSettled([call])
    await pause(10)
    assert.equal(entered, false, 'a surface cannot enter while the process is stopping')
    assert.equal(runtime.starts, 1)
    runtime.continueStop()
    await until(() => runtime.starts === 2)
    assert.equal(entered, false, 'a surface cannot enter during handshake')
    const concurrent = host.call('session/list', { runtime: runtime.info.id })
    runtime.continueStart()
    await until(() => entered)
    await pause(80)
    assert.equal(runtime.stops, 1, 'the reaper preserves the in-flight surface call')
    releaseOperation?.()
    assert.equal((await result)[0]?.status, 'fulfilled')
    await concurrent
    assert.equal(runtime.starts, 2, 'the surface shares the normal restart')
  })
}

test('manual recycling refuses a live conversation and shares the stop barrier with new work', async (t) => {
  const runtime = new IdleRuntime({ id: 'idle-test' as never, name: 'Idle Test' })
  const { host, stateDir } = await makeHost(runtime, 0, 0)
  t.after(async () => { runtime.continueStop(); await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  await host.start()
  const params = { runtime: runtime.info.id }
  const first = await host.call('session/create', { ...params, options: { cwd: '/w' } }) as { id: string }
  assert.deepEqual(await host.call('runtime/recycle', params), { recycled: false })
  assert.equal(runtime.stops, 0)
  await host.call('session/close', { ...params, sessionId: first.id as never })
  runtime.holdNextStop()
  const stopping = host.call('runtime/recycle', params)
  await until(() => runtime.stops === 1)
  const starting = host.call('session/create', { ...params, options: { cwd: '/w' } })
  assert.deepEqual(await host.call('runtime/recycle', params), { recycled: false })
  assert.equal(runtime.starts, 1)
  runtime.continueStop()
  assert.deepEqual(await stopping, { recycled: true })
  await starting
  assert.equal(runtime.starts, 2)
})

test('resource polling reports unsupported measurement and never wakes an idle runtime', async (t) => {
  const runtime = new IdleRuntime({ id: 'idle-test' as never, name: 'Idle Test' })
  const { host, stateDir } = await makeHost(runtime, 0, 0)
  t.after(async () => { await host.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  await host.start()
  assert.deepEqual(await host.call('runtime/recycle', { runtime: runtime.info.id }), { recycled: true })
  const costs = await host.call('runtime/resources', {}) as readonly { processes: number | null; residentBytes: number | null; canRecycle: boolean }[]
  assert.equal(costs[0]?.processes, null)
  assert.equal(costs[0]?.residentBytes, null)
  assert.equal(costs[0]?.canRecycle, false)
  assert.equal(runtime.starts, 1)
})
