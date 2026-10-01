import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RuntimeHealth } from '@harnessdesk/protocol'

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

const makeHost = async (runtime: IdleRuntime, idleStopMs = 25) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-idle-runtime-'))
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    catalogRefreshMs: 0,
    idleStopMs,
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
