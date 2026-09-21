import assert from 'node:assert/strict'
import test from 'node:test'

import { rankKnownSlots } from '../src/insight/order.js'
import { InsightPlane } from '../src/insight/plane.js'

test('unknown slots and ties keep order', () => {
  const costs = new Map<string, number>([['a', 9], ['b', 2], ['c', 2], ['zero', 0]])
  assert.deepEqual(rankKnownSlots(['a', 'unknown', 'b', 'c', 'zero'], costs), ['zero', 'unknown', 'b', 'c', 'a'])
})

test('a reviewed order uses only the selected historical seats, never a copied project total', async () => {
  const left = { runtime: 'runtime', model: 'expensive' } as const
  const right = { runtime: 'runtime', model: 'cheap' } as const
  const source = { id: 'source', kind: 'corpus' as const, label: 'Transcript', observedAt: 10, checkedAt: 10, stale: false, problem: null }
  const sample = (sessionId: string, usd: number) => ({
    key: sessionId, source, runtime: 'runtime', sessionId, turnId: null, requestId: null, project: '/repo', model: null,
    from: 10, to: 11, scope: 'call' as const, includesChildren: false,
    input: { value: 1, quality: 'exact' as const }, output: { value: 1, quality: 'exact' as const }, cacheRead: { value: 0, quality: 'exact' as const }, cacheWrite: { value: 0, quality: 'exact' as const },
    usd: { value: usd, quality: 'exact' as const }, moneyBasis: 'vendorMetered' as const,
  })
  const seat = (id: string, sessionId: string, candidate: { readonly runtime: string; readonly model: string }) => ({
    id, agent: { id: 'reviewer', name: 'Reviewer', origin: 'project' as const }, briefDigest: 'same', seat: candidate, seatLabel: candidate.model,
    checkout: { project: '/repo' }, board: 'goal-1', session: { runtime: 'runtime', sessionId }, openedAt: 0, closed: null, restored: null,
  })
  const seating = { entries: [{ id: 'reviewer', seats: [left, right] }] }
  let rightUsd = 2
  let writes = 0
  const plane = new InsightPlane({
    ledger: () => ({ readInsight: async () => ({ samples: [sample('left', 10), sample('right', rightUsd)], sources: [source], gaps: [], complete: true }) }) as never,
    goals: { store: { list: () => [{ goal: { id: 'goal-1', root: '/repo', sentence: 'Review', state: 'wrapped' } }], read: () => ({ goal: { id: 'goal-1', root: '/repo', sentence: 'Review', state: 'wrapped' }, receipt: null }) } } as never,
    seats: () => [seat('left-seat', 'left', left), seat('right-seat', 'right', right)] as never,
    seating: { read: async () => seating, fingerprint: async () => 'unchanged', set: async () => { writes += 1; return { seating, wrote: false } } } as never,
    now: () => 20,
  })
  const query = {
    root: '/repo', from: 0, to: 20, goals: ['goal-1'], agent: 'reviewer', origin: 'project' as const,
    left: { agent: 'reviewer', origin: 'project' as const, briefDigest: 'same', seat: left },
    right: { agent: 'reviewer', origin: 'project' as const, briefDigest: 'same', seat: right },
  }
  const preview = await plane.previewOrder(query)
  assert.ok(preview.stamp, preview.reason ?? 'a comparable expensive seat should issue a review stamp')
  assert.deepEqual(preview.proposed, [right, left])
  assert.equal(preview.report.leftPerGoalUsd.value, 10)
  assert.equal(preview.report.rightPerGoalUsd.value, 2)
  rightUsd = 4
  await assert.rejects(() => plane.applyOrder(preview.stamp!), /recorded usage changed/i)
  assert.equal(writes, 0, 'a changed report is refused before the seating writer')
})
