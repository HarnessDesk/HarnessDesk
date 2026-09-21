import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LaneAllocator } from '../src/goals/lanes.js'
import type { Lane } from '@harnessdesk/protocol'

function rig(state: Lane['state'] = 'reserved') {
  let rows: Lane[] = [{ id: 'a', goal: 'g', seat: null, cwd: '', branch: '', ports: { start: 30000, end: 30019 }, browserProfile: 'lane-a', state, createdAt: 1 }]
  const allocator = new LaneAllocator({
    list: () => structuredClone(rows), save: async lane => { rows = rows.map(row => row.id === lane.id ? structuredClone(lane) : row) },
    available: async () => true, create: async () => { throw new Error('recovery must not create') },
    locate: async () => ({ cwd: '/work/lane-a', branch: 'harnessdesk/lane-a' }), active: () => false, busy: () => false,
  })
  return { allocator, read: () => rows[0]! }
}
const seat = (id = 's', restored?: unknown) => ({ id, board: 'g', closed: null, checkout: { cwd: '/work/lane-a' }, ...(restored ? { restored } : {}) })

test('restart finds the actual checkout and binds the unique kept Seat without creating work', async () => {
  const { allocator, read } = rig(); await allocator.recover([seat()]); assert.equal(read().cwd, '/work/lane-a'); assert.equal(read().seat, 's'); assert.equal(read().state, 'active')
})
test('a restored opening cannot reactivate a reservation and released descriptors stay released', async () => {
  const { allocator, read } = rig(); await allocator.recover([seat('history', { at: 1 })]); assert.equal(read().seat, null); assert.equal(read().state, 'retained')
  const released = rig('released'); await released.allocator.recover([seat()]); assert.equal(released.read().state, 'released'); assert.equal(released.read().cwd, '')
})
test('two matching kept Seats refuse dispatch instead of choosing a new owner', async () => {
  const { allocator, read } = rig(); await assert.rejects(allocator.recover([seat('a'), seat('b')]), /conflicting Seat/); assert.equal(read().state, 'reserved'); assert.equal(read().seat, null)
})
