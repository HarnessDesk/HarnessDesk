import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import type { InsightQuery, InsightReport } from '@harnessdesk/protocol'

import { InsightPlane } from '../src/insight/plane.js'
import type { UsageSample } from '../src/ledger/insight.js'
import { sameCanonicalPath } from '../src/path-identity.js'

const source = { id: 'source', kind: 'corpus' as const, label: 'Recorded usage', observedAt: 10, checkedAt: 10, stale: false, problem: null }
const exact = (value: number) => ({ value, quality: 'exact' as const })
const sample = (project: string, sessionId: string, usd: number): UsageSample => ({
  key: `${sessionId}-${usd}`, source, runtime: 'runtime', sessionId, turnId: null, requestId: null, project, model: null, from: 10, to: 11,
  scope: 'call', includesChildren: false, input: exact(1), output: exact(1), cacheRead: exact(0), cacheWrite: exact(0), usd: exact(usd), moneyBasis: 'vendorMetered',
}) as UsageSample

/** A Seat whose window is counted each time it is built. */
const counted = (windows: { built: number }) => (id: string, board: string, project: string) => ({
  id, agent: { id: board, name: board, origin: 'project' as const }, briefDigest: 'same', seat: { runtime: 'runtime' }, seatLabel: id,
  checkout: { project }, board, session: { runtime: 'runtime', sessionId: id }, closed: null, restored: null,
  get openedAt() { windows.built += 1; return 0 },
})

const documents = [
  { goal: { id: 'goal-a', root: '/repo', sentence: 'A', state: 'open' } },
  { goal: { id: 'goal-b', root: '/repo', sentence: 'B', state: 'wrapped' }, receipt: { id: 'receipt-b', seats: ['seat-b'] } },
  { goal: { id: 'goal-c', root: '/other', sentence: 'C', state: 'open' } },
]
const goals = { store: { list: () => documents, read: (id: string) => {
  const found = documents.find((one) => one.goal.id === id)
  if (!found) throw new Error(`Unknown Goal ${id}`)
  return found
} } }
const samples = [
  ...Array.from({ length: 20 }, (_, index) => sample('/repo', index % 2 ? 'seat-a' : 'seat-b', index + 1)),
  ...Array.from({ length: 10 }, (_, index) => sample('/other', 'seat-c', 100)),
]
const without = ({ id: _id, ...report }: InsightReport) => report

test('many Teams on one project share one ledger read and one attribution, and each keeps its own report', async () => {
  const windows = { built: 0 }
  const seat = counted(windows)
  const seats = [seat('seat-a', 'goal-a', '/repo'), seat('seat-b', 'goal-b', '/repo'), seat('seat-c', 'goal-c', '/other')]
  const reads: string[] = []
  const plane = new InsightPlane({
    ledger: () => ({ readInsight: async (query: InsightQuery) => {
      reads.push(query.root)
      return { samples: samples.filter((one) => one.project === query.root), sources: [source], gaps: [], complete: true }
    } }) as never,
    goals: goals as never, seats: () => seats as never, seating: {} as never, now: () => 90 * 86_400_000 + 20,
  })

  const batch = await plane.goals(['goal-a', 'goal-b', 'goal-c', 'missing'])
  assert.deepEqual(reads.sort(), ['/other', '/repo'], 'one read per project, not one per Team')
  assert.equal(windows.built, 3, 'each Seat window is built once per read, not once per sample')
  assert.deepEqual(batch.failed, ['missing'])
  assert.deepEqual(batch.reports.map((report) => report.goal).sort(), ['goal-a', 'goal-b', 'goal-c'])
  assert.deepEqual(batch.reports.map((report) => [report.goal, report.totals.usd.value]).sort(), [['goal-a', 110], ['goal-b', 100], ['goal-c', 1000]])

  reads.length = 0
  for (const id of ['goal-a', 'goal-b', 'goal-c']) {
    assert.deepEqual(without(batch.reports.find((report) => report.goal === id)!), without(await plane.goal(id)), `${id} reads the same together as alone`)
  }
  assert.equal(reads.length, 3)
})

test('a project whose ledger cannot be read fails only its own Teams', async () => {
  const seat = counted({ built: 0 })
  const plane = new InsightPlane({
    ledger: () => ({ readInsight: async (query: InsightQuery) => {
      if (query.root === '/other') throw new Error('Recorded usage could not be read.')
      return { samples: samples.filter((one) => one.project === query.root), sources: [source], gaps: [], complete: true }
    } }) as never,
    goals: goals as never, seats: () => [seat('seat-a', 'goal-a', '/repo'), seat('seat-c', 'goal-c', '/other')] as never, seating: {} as never, now: () => 20,
  })
  const batch = await plane.goals(['goal-c', 'goal-a'])
  assert.deepEqual(batch.failed, ['goal-c'])
  assert.deepEqual(batch.reports.map((report) => report.goal), ['goal-a'])
})

test('one read resolves each folder once, the ledger’s own comparisons included', async (t) => {
  const native = fs.realpathSync.native
  let resolved = 0
  fs.realpathSync.native = ((path: fs.PathLike, options?: fs.EncodingOption) => { resolved += 1; return native(path, options) }) as typeof native
  t.after(() => { fs.realpathSync.native = native })
  // Spelled apart from the root, so every comparison has to resolve a folder.
  const elsewhere = Array.from({ length: 200 }, (_, index) => sample(index % 2 ? '/repo/./' : '/unrelated', 'seat-a', 1))
  const seat = counted({ built: 0 })
  const plane = new InsightPlane({
    ledger: () => ({ readInsight: async (query: InsightQuery) =>
      ({ samples: elsewhere.filter((one) => sameCanonicalPath(one.project!, query.root)), sources: [source], gaps: [], complete: true }) }) as never,
    goals: goals as never, seats: () => [seat('seat-a', 'goal-a', '/repo')] as never, seating: {} as never, now: () => 20,
  })
  const batch = await plane.goals(['goal-a', 'goal-b'])
  assert.equal(batch.reports.find((report) => report.goal === 'goal-a')!.totals.turns.value, 100)
  assert.ok(resolved <= 5, `${resolved} folder resolutions for ${elsewhere.length} samples`)
})
