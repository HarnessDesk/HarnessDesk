import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { Lane } from '@harnessdesk/protocol'
import { LaneAllocator, LaneStore, availablePorts, laneEnvironment } from '../src/goals/lanes.js'
import { Worktrees } from '../src/worktree.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

const fixture = `import http from 'node:http';const s=http.createServer((_q,r)=>r.end(JSON.stringify({lane:process.env.HARNESSDESK_LANE_ID,port:process.env.PORT,cwd:process.cwd()})));s.listen(Number(process.env.PORT),'127.0.0.1',()=>process.stdout.write('ready\\n'));process.on('SIGTERM',()=>s.close(()=>process.exit(0)))`

async function childFor(t: TestContext, file: string, lane: Lane): Promise<ChildProcess> {
  const child = spawn(process.execPath, [file], { cwd: lane.cwd, env: { ...process.env, ...laneEnvironment(lane) }, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lane server did not start')), 5000)
    child.once('error', reject); child.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready\n')) { clearTimeout(timer); resolve() } })
  })
  return child
}

test('two projects run the same server concurrently from distinct managed checkouts and ports', async (t) => {
  const left = await makeRepo('hd-lane-left-'); const right = await makeRepo('hd-lane-right-')
  const home = tempDir('hd-lane-desk-'); const file = join(home, 'server.mjs'); await writeFile(file, fixture)
  const store = new LaneStore(home); await store.load(); const worktrees = new Worktrees(home)
  const allocator = new LaneAllocator({
    list: () => store.list(), save: lane => store.save(lane), available: availablePorts,
    create: async (id, goal) => { const made = await worktrees.create(goal === 'g1' ? left.dir : right.dir, { name: `lane-${id}` }); assert.ok(made.branch); return { cwd: made.path, branch: made.branch } },
    active: () => false, busy: () => false,
  })
  const [a, b] = await Promise.all([allocator.allocate('g1', 'a', { start: 30000, width: 2, browserProfile: true }), allocator.allocate('g2', 'b', { start: 30000, width: 2, browserProfile: true })])
  await Promise.all([childFor(t, file, a), childFor(t, file, b)])
  const replies = await Promise.all([a, b].map(async lane => (await fetch(`http://127.0.0.1:${lane.ports.start}`)).json()))
  assert.deepEqual(replies, [{ lane: 'a', port: String(a.ports.start), cwd: a.cwd }, { lane: 'b', port: String(b.ports.start), cwd: b.cwd }])
  assert.notEqual(a.cwd, b.cwd); assert.ok(a.ports.end < b.ports.start || b.ports.end < a.ports.start)
  assert.equal(await availablePorts(a.ports, Date.now() + 5000), false)
})

test('an unrelated listener makes its block unavailable and probes leave no handles', async (t) => {
  const occupied = createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening')
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())))
  const address = occupied.address(); assert.ok(address && typeof address !== 'string')
  const leases: Lane[] = []
  const allocator = new LaneAllocator({ list: () => leases, save: async lane => { const i = leases.findIndex(one => one.id === lane.id); if (i < 0) leases.push(lane); else leases[i] = lane }, available: availablePorts, create: async () => ({ cwd: '/work/lane', branch: 'harnessdesk/lane' }), active: () => false, busy: () => false })
  const lane = await allocator.allocate('g1', 'a', { start: address.port, width: 1, browserProfile: true })
  assert.ok(lane.ports.start > address.port); assert.equal(await availablePorts(lane.ports, Date.now() + 5000), true)
})
