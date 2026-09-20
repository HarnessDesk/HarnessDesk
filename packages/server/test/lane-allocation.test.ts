import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LaneAllocator, firstBlock, laneEnvironment } from '../src/goals/lanes.js'
import { lanePreferences, type Lane, type LanePreferences } from '@harnessdesk/protocol'

const prefs: LanePreferences = { start: 65500, width: 18, browserProfile: true }

const rig = () => {
  const saved = new Map<string, Lane>()
  const created: string[] = []
  let occupied = false
  let broken = false
  let active = false
  let busy = false
  const allocator = new LaneAllocator({
    list: () => [...saved.values()],
    save: async (lane) => { saved.set(lane.id, structuredClone(lane)) },
    available: async (ports) => !occupied || ports.start !== 65500,
    create: async (id) => {
      created.push(id)
      if (broken) throw new Error('checkout failed')
      return { cwd: `/work/${id}`, branch: `harnessdesk/lane-${id}` }
    },
    active: () => active,
    busy: () => busy,
  })
  return {
    allocator, saved, created,
    occupied: (value: boolean) => { occupied = value },
    broken: (value: boolean) => { broken = value },
    active: (value: boolean) => { active = value },
    busy: (value: boolean) => { busy = value },
  }
}

test('concurrent allocations across Goals reserve whole disjoint intervals', async () => {
  const proof = rig()
  const [a, b] = await Promise.all([
    proof.allocator.allocate('g1', 'a', prefs),
    proof.allocator.allocate('g2', 'b', prefs),
  ])
  assert.deepEqual(a.ports, { start: 65500, end: 65517 })
  assert.deepEqual(b.ports, { start: 65518, end: 65535 })
  assert.notEqual(a.browserProfile, b.browserProfile)
  assert.match(a.browserProfile!, /^lane-[a-f0-9-]{36}$/)
  await assert.rejects(proof.allocator.allocate('g3', 'c', prefs), /No lane port block is free/)
  assert.deepEqual(proof.created, ['a', 'b'])
})

test('retained reservations keep absolute intervals after preferences change', async () => {
  const proof = rig()
  const lane = await proof.allocator.allocate('g1', 'a', prefs)
  await proof.allocator.retain(lane.id)
  assert.deepEqual(firstBlock({ ...prefs, start: 65501 }, proof.allocator.list()), null)
  assert.deepEqual(firstBlock(prefs, [{ ...lane, state: 'released' }]), lane.ports)
})

test('occupied blocks are skipped before a checkout is made', async () => {
  const proof = rig()
  proof.occupied(true)
  const lane = await proof.allocator.allocate('g1', 'a', prefs)
  assert.equal(lane.ports.start, 65518)
  assert.deepEqual(proof.created, ['a'])
})

test('a failed checkout retains its reservation and retry cannot overwrite it', async () => {
  const proof = rig()
  proof.broken(true)
  await assert.rejects(proof.allocator.allocate('g1', 'a', prefs), /checkout failed/)
  assert.equal(proof.saved.get('a')?.state, 'retained')
  assert.equal(proof.saved.get('a')?.ports.start, 65500)
  await assert.rejects(proof.allocator.allocate('g1', 'a', prefs), /already recorded/)
  assert.deepEqual(proof.created, ['a'])
})

test('reservation persistence failure opens no checkout and does not poison the queue', async () => {
  let saves = 0
  let creates = 0
  const saved: Lane[] = []
  const allocator = new LaneAllocator({
    list: () => saved,
    save: async (lane) => { if (++saves === 1) throw new Error('disk full'); saved.push(lane) },
    available: async () => true,
    create: async () => { creates++; return { cwd: '/work/a', branch: 'lane-a' } },
    active: () => false,
    busy: () => false,
  })
  await assert.rejects(allocator.allocate('g1', 'a', prefs), /disk full/)
  assert.equal(creates, 0)
  await allocator.allocate('g1', 'b', prefs)
  assert.equal(creates, 1)
})

test('binding is idempotent for its Seat and refuses replacement', async () => {
  const proof = rig()
  await proof.allocator.allocate('g1', 'a', prefs)
  await proof.allocator.bind('a', 's1')
  await proof.allocator.bind('a', 's1')
  await assert.rejects(proof.allocator.bind('a', 's2'), /another Seat/)
  assert.equal(proof.allocator.forSeat('s1')?.id, 'a')
})

test('release refuses active, busy and listening lanes and retains their resources', async () => {
  const proof = rig()
  const lane = await proof.allocator.allocate('g1', 'a', prefs)
  proof.active(true)
  await assert.rejects(proof.allocator.release('a'), /active Seat/)
  proof.active(false)
  proof.busy(true)
  await assert.rejects(proof.allocator.release('a'), /finish its turn/)
  proof.busy(false)
  proof.occupied(true)
  await assert.rejects(proof.allocator.release('a'), /still in use/)
  proof.occupied(false)
  const released = await proof.allocator.release('a')
  assert.deepEqual(released, { ...lane, state: 'released' })
  assert.deepEqual(await proof.allocator.release('a'), released)
})

test('lane environment has exactly six values and refuses released leases', async () => {
  const proof = rig()
  const lane = await proof.allocator.allocate('g1', 'a', prefs)
  assert.deepEqual(laneEnvironment(lane), {
    HARNESSDESK_GOAL_ID: 'g1', HARNESSDESK_LANE_ID: 'a',
    HARNESSDESK_PORT_START: '65500', HARNESSDESK_PORT_END: '65517',
    HARNESSDESK_PORT_COUNT: '18', PORT: '65500',
  })
  assert.throws(() => laneEnvironment({ ...lane, state: 'released' }), /released/)
  assert.throws(() => laneEnvironment({ ...lane, state: 'reserved' }), /not ready/)
})

test('profile sharing is an explicit allocation choice, unaffected by later preferences', async () => {
  const proof = rig()
  const a = await proof.allocator.allocate('g1', 'a', { ...prefs, browserProfile: false })
  const b = await proof.allocator.allocate('g1', 'b', prefs)
  assert.equal(a.browserProfile, null)
  assert.notEqual(b.browserProfile, null)
  assert.equal(proof.saved.get('a')?.browserProfile, null)
})

test('preferences reject incomplete, noncanonical and out-of-range values', () => {
  for (const invalid of [
    null, [], {}, { ...prefs, start: 1023 }, { ...prefs, start: 65536 },
    { ...prefs, width: 0 }, { ...prefs, width: 1001 }, { ...prefs, width: 1.5 },
    { ...prefs, start: 65535, width: 2 }, { ...prefs, browserProfile: 'yes' }, { ...prefs, extra: true },
  ]) assert.throws(() => lanePreferences(invalid), /starting port/)
  assert.deepEqual(lanePreferences({ start: 65535, width: 1, browserProfile: true }), {
    start: 65535, width: 1, browserProfile: true,
  })
})

test('a deadline aborts scanning without saving a guessed allocation', async () => {
  const saved: Lane[] = []
  let time = 0
  const allocator = new LaneAllocator({
    list: () => saved, save: async (lane) => { saved.push(lane) },
    available: async () => { time = 5001; return false },
    create: async () => { throw new Error('must not create') }, active: () => false, busy: () => false,
  }, () => time)
  await assert.rejects(allocator.allocate('g1', 'a', prefs), /five seconds/)
  assert.deepEqual(saved, [])
})
