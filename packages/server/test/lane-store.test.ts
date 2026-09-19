import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Lane } from '@harnessdesk/protocol'
import { LaneStore } from '../src/goals/lanes.js'

const temporary = () => mkdtemp(join(tmpdir(), 'hd-lane-store-'))
const lane = (): Lane => ({ id: 'a', goal: 'g1', seat: null, cwd: '', branch: '', ports: { start: 30000, end: 30019 }, browserProfile: null, state: 'reserved', createdAt: 1 })

test('a restart preserves reserved ownership and readers cannot change the registry', async () => {
  const home = await temporary()
  try {
    const first = new LaneStore(home); await first.load(); await first.save(lane())
    const next = new LaneStore(home); await next.load(); assert.deepEqual(next.list(), [lane()])
    ;(next.list()[0]!.ports as { start: number }).start = 40000
    assert.equal(next.list()[0]!.ports.start, 30000)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a failed save neither updates memory nor rewrites the last durable registry', async () => {
  const home = await temporary()
  try {
    const first = new LaneStore(home); await first.load(); await first.save(lane())
    const file = join(home, 'lanes', 'index.json'); const before = await readFile(file, 'utf8')
    const next = new LaneStore(home, async () => { throw new Error('disk full') }); await next.load()
    await assert.rejects(next.save({ ...lane(), state: 'retained' }), /disk full/)
    assert.equal(next.list()[0]!.state, 'reserved'); assert.equal(await readFile(file, 'utf8'), before)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a damaged, future or overlapping registry is refused whole', async () => {
  const home = await temporary()
  try {
    await mkdir(join(home, 'lanes')); const file = join(home, 'lanes', 'index.json')
    for (const raw of ['{ broken', JSON.stringify({ version: 2, lanes: [] }), JSON.stringify({ version: 1, lanes: [{ ...lane(), ports: { start: 0, end: 20 } }] }), JSON.stringify({ version: 1, lanes: [lane(), { ...lane(), id: 'b' }] })]) {
      await writeFile(file, raw); const store = new LaneStore(home); await assert.rejects(store.load())
      assert.throws(() => store.list(), /Read the lane registry/); assert.equal(await readFile(file, 'utf8'), raw)
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a released interval may be reused without erasing its descriptor', async () => {
  const home = await temporary()
  try {
    const first = new LaneStore(home); await first.load(); await first.save({ ...lane(), state: 'released' }); await first.save({ ...lane(), id: 'b' })
    const next = new LaneStore(home); await next.load(); assert.equal(next.list().length, 2)
  } finally { await rm(home, { recursive: true, force: true }) }
})
