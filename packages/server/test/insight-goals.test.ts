import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import type { InsightQuery, InsightReport } from '@harnessdesk/protocol'

import { CONSULT_UNKNOWN_GAP, InsightPlane } from '../src/insight/plane.js'
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
const detailOf = (root: string) => ({ samples: samples.filter((one) => one.project === root), sources: [source], gaps: [], complete: true })

test('many Teams share one ledger read and one attribution per project, and each keeps its own report', async () => {
  const windows = { built: 0 }
  const seat = counted(windows)
  const seats = [seat('seat-a', 'goal-a', '/repo'), seat('seat-b', 'goal-b', '/repo'), seat('seat-c', 'goal-c', '/other')]
  const reads: string[][] = []
  const plane = new InsightPlane({
    ledger: () => ({
      readInsight: async (query: InsightQuery) => { reads.push([query.root]); return detailOf(query.root) },
      readInsights: async (queries: readonly InsightQuery[]) => { reads.push(queries.map((query) => query.root)); return queries.map((query) => detailOf(query.root)) },
    }) as never,
    goals: goals as never, seats: () => seats as never, seating: {} as never, now: () => 90 * 86_400_000 + 20,
  })

  const batch = await plane.goals(['goal-a', 'goal-b', 'goal-c', 'missing'])
  assert.deepEqual(reads, [['/repo', '/repo', '/other']], 'one ledger read for every Team, a query each so each keeps its budget')
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

test('a ledger read that fails names every Team it was for, never a zero, and an unknown Team fails alone', async () => {
  const seat = counted({ built: 0 })
  const plane = new InsightPlane({
    ledger: () => ({ readInsights: async () => { throw new Error('Recorded usage could not be read.') } }) as never,
    goals: goals as never, seats: () => [seat('seat-a', 'goal-a', '/repo'), seat('seat-c', 'goal-c', '/other')] as never, seating: {} as never, now: () => 20,
  })
  const batch = await plane.goals(['goal-c', 'missing', 'goal-a'])
  assert.deepEqual(batch.failed, ['goal-c', 'missing', 'goal-a'])
  assert.deepEqual(batch.reports, [])
  const alone = await plane.goals(['missing'])
  assert.deepEqual(alone, { reports: [], failed: ['missing'] }, 'nothing to read is not a read')
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
    ledger: () => ({ readInsights: async (queries: readonly InsightQuery[]) => queries.map((query) =>
      ({ samples: elsewhere.filter((one) => sameCanonicalPath(one.project!, query.root)), sources: [source], gaps: [], complete: true })) }) as never,
    goals: goals as never, seats: () => [seat('seat-a', 'goal-a', '/repo')] as never, seating: {} as never, now: () => 20,
  })
  const batch = await plane.goals(['goal-a', 'goal-b'])
  assert.equal(batch.reports.find((report) => report.goal === 'goal-a')!.totals.turns.value, 100)
  assert.ok(resolved <= 5, `${resolved} folder resolutions for ${elsewhere.length} samples`)
})

test('a consult a Seat opened with ask_agent is that Seat’s: its conversation’s usage folds into the asking Seat’s row', async () => {
  const seat = counted({ built: 0 })
  const consultSample = (from: number): UsageSample => ({ ...sample('/repo', 'consult-1', 5), key: `consult-${from}`, from, to: from + 1 })
  const detail = { samples: [sample('/repo', 'seat-a', 1), consultSample(10), consultSample(40)], sources: [source], gaps: [], complete: true }
  const plane = (consults?: () => readonly import('../src/evidence/records.js').SeatConsult[]) => new InsightPlane({
    ledger: () => ({ readInsight: async () => detail, readInsights: async (queries: readonly InsightQuery[]) => queries.map(() => detail) }) as never,
    goals: goals as never, seats: () => [seat('seat-a', 'goal-a', '/repo')] as never, seating: {} as never, now: () => 90 * 86_400_000 + 20,
    ...(consults ? { consults } : {}),
  })
  const seatRow = (report: InsightReport) => report.breakdowns.find((one) => one.dimension === 'seat')!.rows.find((one) => one.seat === 'seat-a')!

  const query = { root: '/repo', from: 0, to: 86_400_000 }
  const linked = await plane(() => [{ seat: 'seat-a', n: 1, runtime: 'runtime', sessionId: 'consult-1', openedAt: 5, closedAt: 20 }]).usage(query)
  assert.equal(seatRow(linked).amounts.usd.value, 6, 'the Seat’s own 1 and its consult’s 5, inside the consult’s window')
  assert.equal(linked.breakdowns[0]!.unattributed.usd.value, 5, 'a sample of that conversation outside its window stays unattributed')

  assert.equal((await plane(() => [{ seat: 'seat-a', n: 1, runtime: 'runtime', sessionId: 'consult-1', openedAt: 5, closedAt: 20 }]).goal('goal-a')).totals.usd.value, 6, 'and on the Seat’s Goal')
  const unlinked = await plane().usage(query)
  assert.equal(seatRow(unlinked).amounts.usd.value, 1, 'without the link the consult is nobody’s')
})

test('an ephemeral consult’s spend is kept with its link and folded into the asking Seat once — the larger of it and the corpus, never both', async () => {
  const seat = counted({ built: 0 })
  const consultSample = (sessionId: string, usd: number): UsageSample => ({ ...sample('/repo', sessionId, usd), key: `${sessionId}-corpus` })
  const detail = { samples: [sample('/repo', 'seat-a', 1), consultSample('consult-low', 0.1), consultSample('consult-high', 0.5)], sources: [source], gaps: [], complete: true }
  const usage = (usd: number) => ({ model: 'model-a', usd, basis: 'vendorMetered' as const, input: 10, output: 10, cacheRead: 0, cacheWrite: null })
  const consults = [
    // Ephemeral: nothing of it in the corpus, only what its live conversation reported.
    { seat: 'seat-a', n: 1, runtime: 'runtime', sessionId: 'consult-gone', openedAt: 5, closedAt: 20, usage: usage(0.42) },
    // The corpus read $0.10 of it; its final live total was $0.42.
    { seat: 'seat-a', n: 2, runtime: 'runtime', sessionId: 'consult-low', openedAt: 5, closedAt: 20, usage: usage(0.42) },
    // The corpus counted more than the live total: the corpus stands.
    { seat: 'seat-a', n: 3, runtime: 'runtime', sessionId: 'consult-high', openedAt: 5, closedAt: 20, usage: usage(0.42) },
  ]
  const plane = (more: readonly import('../src/evidence/records.js').SeatConsult[] = []) => new InsightPlane({
    ledger: () => ({ readInsight: async () => detail, readInsights: async (queries: readonly InsightQuery[]) => queries.map(() => detail) }) as never,
    goals: goals as never, seats: () => [seat('seat-a', 'goal-a', '/repo')] as never, seating: {} as never, now: () => 90 * 86_400_000 + 20,
    consults: () => [...consults, ...more],
  })
  const query = { root: '/repo', from: 0, to: 86_400_000 }
  const report = await plane().usage(query)
  const seatRow = report.breakdowns.find((one) => one.dimension === 'seat')!.rows.find((one) => one.seat === 'seat-a')!
  assert.ok(Math.abs(seatRow.amounts.usd.value! - (1 + 0.42 + 0.42 + 0.5)) < 1e-9, `the Seat’s 1, then 0.42, 0.42 and 0.50: ${seatRow.amounts.usd.value}`)
  assert.ok(!report.breakdowns[0]!.unattributed.usd.value, 'nothing of the consults is left unattributed')
  assert.deepEqual(report.gaps, [])
  // A consult that closed with no usage and left nothing in the corpus is a named gap, not a zero.
  const unknown = await plane([{ seat: 'seat-a', n: 4, runtime: 'runtime', sessionId: 'consult-unknown', openedAt: 5, closedAt: 20, usage: null }]).usage(query)
  assert.deepEqual(unknown.gaps, [CONSULT_UNKNOWN_GAP])
  // Two readings of one running session total are its largest, not their sum: 0.40 read is less than 0.42 live.
  const running = (usd: number, to: number): UsageSample => ({ ...sample('/repo', 'consult-running', usd), key: `running-${usd}`, scope: 'session', to })
  detail.samples.push(running(0.3, 11), running(0.4, 12))
  const twice = await plane([{ seat: 'seat-a', n: 5, runtime: 'runtime', sessionId: 'consult-running', openedAt: 5, closedAt: 20, usage: usage(0.42) }]).usage(query)
  const twiceRow = twice.breakdowns.find((one) => one.dimension === 'seat')!.rows.find((one) => one.seat === 'seat-a')!
  assert.ok(Math.abs(twiceRow.amounts.usd.value! - (1 + 0.42 + 0.42 + 0.5 + 0.42)) < 1e-9, `the running consult counts its live 0.42: ${twiceRow.amounts.usd.value}`)
})
