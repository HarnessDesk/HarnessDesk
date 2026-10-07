import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'

import { sessionId, type Lane } from '@harnessdesk/protocol'

import { SeatBook } from '../src/evidence/seats.js'
import { LaneStore } from '../src/goals/lanes.js'
import { GoalStore, type GoalDocument } from '../src/goals/store.js'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { FakeRuntime, FakeSession } from './fixtures/fake-runtime.js'
import { goal, seat } from './fixtures/goals.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

test('host lists resolve folders, not every Goal or session', async (t) => {
  const base = await realpath(tempDir('hd-path-cost-'))
  const folders = [0, 1, 2].map(n => join(base, `folder-${n}`))
  const aliases = [0, 1, 2].map(n => join(base, `alias-${n}`))
  for (let n = 0; n < folders.length; n++) {
    await mkdir(folders[n]!)
    await symlink(folders[n]!, aliases[n]!, 'dir')
  }
  const documents: GoalDocument[] = Array.from({ length: 300 }, (_, n) => ({
    version: 1, goal: goal(`goal-${n}`, { root: folders[n % 3]!, cwd: aliases[n % 3]! }),
    board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
    citations: [], receipt: null, operation: null,
  }))
  const byId = new Map(documents.map(document => [document.goal.id, document]))
  // Hold the synthetic documents in memory, as the store does after startup.
  // Leave host projection, evidence reads and runtime history merging real.
  t.mock.method(GoalStore.prototype, 'list', () => documents)
  t.mock.method(GoalStore.prototype, 'read', (id: string) => byId.get(id)!)
  const host = new Host({ logger: silent, state: new StateStore(join(base, 'state', 'state.json')),
    builtinAgents: join(base, 'agents'), libraryHome: join(base, 'library') })
  const runtime = new FakeRuntime()
  host.register(runtime)
  t.after(() => host.dispose())
  for (let n = 0; n < 300; n++) {
    const live = new FakeSession(runtime, sessionId(`session-${n}`), { cwd: aliases[n % 3]!, model: 'fake-1' }, {})
    host.registry.upsert(live.snapshot(), null)
  }
  let calls = 0
  const stacks: string[] = []
  const native = realpathSync.native
  t.mock.method(realpathSync, 'native', new Proxy(native, {
    apply(target, receiver, args) {
      calls++
      if (stacks.length < 2) stacks.push(new Error().stack ?? '')
      return Reflect.apply(target, receiver, args)
    },
  }))
  await t.test('300 Goal projections across three folders', async (t) => {
    calls = 0
    const started = performance.now()
    const views = await host.call('goal/list', {})
    t.diagnostic(`goal/list: ${calls} native realpath calls, ${(performance.now() - started).toFixed(2)} ms`)
    t.diagnostic(stacks.join('\n'))
    assert.equal(views.length, 300)
    assert.ok(views.every(view => view.board.cwd === undefined), 'aliases are the same folder as their roots')
    assert.ok(calls <= 6, `${calls} calls must scale with distinct folders`)
  })
  await t.test('300 host-owned sessions across three folders', async (t) => {
    calls = 0
    const started = performance.now()
    const page = await host.call('session/list', { runtime: runtime.info.id, cwd: folders[0]! })
    t.diagnostic(`session/list: ${calls} native realpath calls, ${(performance.now() - started).toFixed(2)} ms`)
    assert.equal(page.data.length, 100)
    assert.ok(page.data.every(row => row.cwd === aliases[0]))
    assert.ok(calls <= 4, `${calls} calls must scale with distinct folders`)
  })
  const lane: Lane = { id: 'lane-cost', goal: 'goal-0', seat: null, cwd: folders[2]!, branch: 'lane-cost',
    ports: { start: 41000, end: 41003 }, browserProfile: null, state: 'retained', createdAt: 1 }
  await t.test('a lane scans 300 active Seats across three folders', async (t) => {
    t.mock.method(LaneStore.prototype, 'list', () => [lane])
    const seats = Array.from({ length: 300 }, (_, n) => seat(`seat-${n}`, { board: lane.goal,
      checkout: { cwd: aliases[n === 299 ? 2 : n % 2]!, project: folders[0]!, branch: null, head: null } }))
    t.mock.method(SeatBook.prototype, 'all', () => seats)
    calls = 0
    await assert.rejects(host.call('lane/release', { lane: lane.id }), /Release this lane’s active Seat/)
    t.diagnostic(`lane active: ${calls} native realpath calls`)
    assert.ok(calls <= 4, `${calls} calls must scale with distinct folders`)
  })
  await t.test('a lane scans 300 busy sessions across three folders', async (t) => {
    t.mock.method(LaneStore.prototype, 'list', () => [lane])
    const records = host.registry.all()
    const sessions = records.map(record => record.session)
    t.after(() => records.forEach((record, n) => { record.session = sessions[n]! }))
    records.forEach((record, n) => {
      record.session = { ...record.session, status: { type: 'active' }, cwd: aliases[n === 299 ? 2 : n % 2]! }
    })
    calls = 0
    await assert.rejects(host.call('lane/release', { lane: lane.id }), /Wait for this conversation/)
    t.diagnostic(`lane busy: ${calls} native realpath calls`)
    assert.ok(calls <= 4, `${calls} calls must scale with distinct folders`)
  })
  await t.test('session filtering sees retargeted, renamed and missing folders on its next list', async () => {
    const list = (cwd: string) => host.call('session/list', { runtime: runtime.info.id, cwd })
    await rm(aliases[0]!)
    await symlink(folders[1]!, aliases[0]!, 'dir')
    assert.equal((await list(folders[0]!)).data.length, 0)
    assert.equal((await list(folders[1]!)).data.length, 200)
    await rename(folders[1]!, join(base, 'renamed'))
    assert.equal((await list(folders[1]!)).data.length, 0)
    assert.equal((await list(aliases[1]!)).data.length, 100, 'missing historical folders keep lexical identity')
  })
})
