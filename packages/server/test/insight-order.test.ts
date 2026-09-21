import assert from 'node:assert/strict'
import test from 'node:test'

import { INSIGHT_DIMENSIONS } from '@harnessdesk/protocol'

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
  let rightInput = 1
  const sample = (sessionId: string, usd: number) => ({
    key: sessionId, source, runtime: 'runtime', sessionId, turnId: null, requestId: null, project: '/repo', model: null,
    from: 10, to: 11, scope: 'call' as const, includesChildren: false,
    input: { value: sessionId === 'right' ? rightInput : 1, quality: 'exact' as const }, output: { value: 1, quality: 'exact' as const }, cacheRead: { value: 0, quality: 'exact' as const }, cacheWrite: { value: 0, quality: 'exact' as const },
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
  assert.deepEqual(preview.labels, ['expensive', 'cheap'], 'the displayed current order is not the proposed swap')
  assert.deepEqual(preview.proposed, [right, left])
  assert.equal(preview.report.leftPerGoalUsd.value, 10)
  assert.equal(preview.report.rightPerGoalUsd.value, 2)
  rightInput = 2
  await assert.rejects(() => plane.applyOrder(preview.stamp!), /recorded usage changed/i)
  assert.equal(writes, 0, 'a non-USD change is refused before the seating writer')
})

test('comparison sides retain their own complete provenance across multiple Goals', async () => {
  const left = { runtime: 'runtime', model: 'left' } as const
  const right = { runtime: 'runtime', model: 'right' } as const
  const source = (id: string) => ({ id, kind: 'corpus' as const, label: 'Recorded usage', observedAt: 10, checkedAt: 10, stale: false, problem: null })
  const sample = (session: string, board: string, choice: typeof left | typeof right, usd: number, sourceId: string) => ({
    key: session, source: source(sourceId), runtime: 'runtime', sessionId: session, turnId: null, requestId: null, project: '/repo', model: choice.model, from: 10, to: 11, scope: 'call' as const, includesChildren: false,
    input: { value: 1, quality: 'exact' as const }, output: { value: 1, quality: 'exact' as const }, cacheRead: { value: 0, quality: 'exact' as const }, cacheWrite: { value: 0, quality: 'exact' as const }, usd: { value: usd, quality: 'exact' as const }, moneyBasis: 'vendorMetered' as const,
  })
  const seat = (id: string, board: string, choice: typeof left | typeof right) => ({ id, agent: { id: 'reviewer', name: 'Reviewer', origin: 'project' as const }, briefDigest: 'same', seat: choice, seatLabel: choice.model, checkout: { project: '/repo' }, board, session: { runtime: 'runtime', sessionId: id }, openedAt: 0, closed: null, restored: null })
  const seats = [seat('left-a', 'a', left), seat('right-a', 'a', right), seat('left-b', 'b', left), seat('right-b', 'b', right)]
  const samples = [sample('left-a', 'a', left, 10, 'left-a-source'), sample('right-a', 'a', right, 4, 'right-a-source'), sample('left-b', 'b', left, 8, 'left-b-source'), sample('right-b', 'b', right, 3, 'right-b-source')]
  const plane = new InsightPlane({
    ledger: () => ({ readInsight: async () => ({ samples, sources: samples.map((entry) => entry.source), gaps: [], complete: true }) }) as never,
    goals: { store: { list: () => ['a', 'b'].map((id) => ({ goal: { id, root: '/repo', sentence: id, state: 'wrapped' } })) } } as never,
    seats: () => seats as never, seating: {} as never, now: () => 20,
  })
  const compared = await plane.compare({ root: '/repo', from: 0, to: 20, goals: ['a', 'b'], left: { agent: 'reviewer', origin: 'project', briefDigest: 'same', seat: left }, right: { agent: 'reviewer', origin: 'project', briefDigest: 'same', seat: right } })
  assert.deepEqual([...compared.left.usd.sourceIds].sort(), ['left-a-source', 'left-b-source'])
  assert.deepEqual([...compared.right.usd.sourceIds].sort(), ['right-a-source', 'right-b-source'])
  assert.deepEqual([...compared.leftPerGoalUsd.sourceIds].sort(), ['left-a-source', 'left-b-source'])
  assert.deepEqual([...compared.rightPerGoalUsd.sourceIds].sort(), ['right-a-source', 'right-b-source'])
  assert.deepEqual([...compared.differenceUsd.sourceIds].sort(), ['left-a-source', 'left-b-source', 'right-a-source', 'right-b-source'])
})

test('a default preference can be reviewed and applied when no seating override exists', async () => {
  const expensive = { runtime: 'runtime', model: 'expensive' } as const
  const cheap = { runtime: 'runtime', model: 'cheap' } as const
  const source = { id: 'source', kind: 'corpus' as const, label: 'Recorded usage', observedAt: 10, checkedAt: 10, stale: false, problem: null }
  const sample = (id: string, usd: number) => ({ key: id, source, runtime: 'runtime', sessionId: id, turnId: null, requestId: null, project: '/repo', model: null, from: 10, to: 11, scope: 'call' as const, includesChildren: false, input: { value: 1, quality: 'exact' as const }, output: { value: 1, quality: 'exact' as const }, cacheRead: { value: 0, quality: 'exact' as const }, cacheWrite: { value: 0, quality: 'exact' as const }, usd: { value: usd, quality: 'exact' as const }, moneyBasis: 'vendorMetered' as const })
  const seat = (id: string, choice: typeof expensive | typeof cheap) => ({ id, agent: { id: 'reviewer', name: 'Reviewer', origin: 'project' as const }, briefDigest: 'same', seat: choice, seatLabel: choice.model, checkout: { project: '/repo' }, board: 'goal', session: { runtime: 'runtime', sessionId: id }, openedAt: 0, closed: null, restored: null })
  let written: readonly unknown[] = []
  const plane = new InsightPlane({
    ledger: () => ({ readInsight: async () => ({ samples: [sample('expensive', 10), sample('cheap', 2)], sources: [source], gaps: [], complete: true }) }) as never,
    goals: { store: { list: () => [{ goal: { id: 'goal', root: '/repo', sentence: 'Goal', state: 'wrapped' } }] } } as never,
    seats: () => [seat('expensive', expensive), seat('cheap', cheap)] as never,
    seating: { read: async () => ({ entries: [] }), fingerprint: async () => 'base', set: async (_agent: string, seats: readonly unknown[]) => { written = seats; return { seating: { entries: [] }, wrote: true } } } as never, now: () => 20,
  })
  const query = { root: '/repo', from: 0, to: 20, goals: ['goal'], agent: 'reviewer', origin: 'project' as const, current: [expensive, cheap], left: { agent: 'reviewer', origin: 'project' as const, briefDigest: 'same', seat: expensive }, right: { agent: 'reviewer', origin: 'project' as const, briefDigest: 'same', seat: cheap } }
  const preview = await plane.previewOrder(query)
  assert.ok(preview.stamp, preview.reason ?? 'a default preference with comparable seats should issue a review stamp')
  await plane.applyOrder(preview.stamp!)
  assert.deepEqual(written, [cheap, expensive])
})

test('an Agent report contains only that Agent’s historical Seats and measurements', async () => {
  const source = { id: 'source', kind: 'corpus' as const, label: 'Recorded usage', observedAt: 10, checkedAt: 10, stale: false, problem: null }
  const sample = (sessionId: string, usd: number) => ({ key: sessionId, source, runtime: 'runtime', sessionId, turnId: null, requestId: null, project: '/repo', model: null, from: 10, to: 11, scope: 'call' as const, includesChildren: false, input: { value: 1, quality: 'exact' as const }, output: { value: 1, quality: 'exact' as const }, cacheRead: { value: 0, quality: 'exact' as const }, cacheWrite: { value: 0, quality: 'exact' as const }, usd: { value: usd, quality: 'exact' as const }, moneyBasis: 'vendorMetered' as const })
  const seat = (id: string, agent: string, sessionId: string, board: string) => ({ id, agent: { id: agent, name: agent, origin: 'project' as const }, briefDigest: 'same', seat: { runtime: 'runtime', model: agent }, seatLabel: agent, checkout: { project: '/repo' }, board, session: { runtime: 'runtime', sessionId }, openedAt: 0, closed: null, restored: null })
  const selected = seat('selected-seat', 'selected', 'selected-session', 'goal-selected')
  const other = seat('other-seat', 'other', 'other-session', 'goal-other')
  const plane = new InsightPlane({
    ledger: () => ({ readInsight: async () => ({ samples: [sample('selected-session', 7), sample('other-session', 11)], sources: [source], gaps: [], complete: true }) }) as never,
    goals: { store: { list: () => [{ goal: { id: 'goal-selected', root: '/repo', sentence: 'Selected', state: 'wrapped' } }, { goal: { id: 'goal-other', root: '/repo', sentence: 'Other', state: 'wrapped' } }] } } as never,
    seats: () => [selected, other] as never,
    seating: {} as never,
    now: () => 90 * 86_400_000 + 20,
  })

  const report = await plane.agent('/repo', 'selected', 'project')
  assert.deepEqual(report.seats.map((entry) => entry.id), ['selected-seat'])
  assert.equal(report.totals.usd.value, 7, 'another Agent’s spend is absent from the total')
  assert.deepEqual(report.breakdowns.map((breakdown) => breakdown.dimension), INSIGHT_DIMENSIONS, 'the protocol declares exactly the partitions the plane returns')
  assert.deepEqual(report.breakdowns.flatMap((breakdown) => breakdown.rows.map((row) => row.label)), ['selected', 'Selected', 'selected'])
  assert.ok(report.breakdowns.every((breakdown) => breakdown.unattributed.usd.value === null), 'unattributed amounts do not retain another Agent’s usage')
})

test('an unwrapped Goal contains only its own historical Seats and measurements', async () => {
  const source = { id: 'source', kind: 'corpus' as const, label: 'Recorded usage', observedAt: 10, checkedAt: 10, stale: false, problem: null }
  const sample = (sessionId: string, usd: number) => ({ key: sessionId, source, runtime: 'runtime', sessionId, turnId: null, requestId: null, project: '/repo', model: null, from: 10, to: 11, scope: 'call' as const, includesChildren: false, input: { value: 1, quality: 'exact' as const }, output: { value: 1, quality: 'exact' as const }, cacheRead: { value: 0, quality: 'exact' as const }, cacheWrite: { value: 0, quality: 'exact' as const }, usd: { value: usd, quality: 'exact' as const }, moneyBasis: 'vendorMetered' as const })
  const seat = (id: string, board: string) => ({ id, agent: { id: board, name: board, origin: 'project' as const }, briefDigest: 'same', seat: { runtime: 'runtime', model: board }, seatLabel: board, checkout: { project: '/repo' }, board, session: { runtime: 'runtime', sessionId: id }, openedAt: 0, closed: null, restored: null })
  const selected = seat('selected-seat', 'goal-selected')
  const other = seat('other-seat', 'goal-other')
  const docs = [{ goal: { id: 'goal-selected', root: '/repo', sentence: 'Selected', state: 'open' } }, { goal: { id: 'goal-other', root: '/repo', sentence: 'Other', state: 'wrapped' } }]
  const plane = new InsightPlane({
    ledger: () => ({ readInsight: async () => ({ samples: [sample('selected-seat', 7), sample('other-seat', 11)], sources: [source], gaps: [], complete: true }) }) as never,
    goals: { store: { list: () => docs, read: (id: string) => docs.find((doc) => doc.goal.id === id)! } } as never,
    seats: () => [selected, other] as never,
    seating: {} as never,
    now: () => 90 * 86_400_000 + 20,
  })

  const report = await plane.goal('goal-selected')
  assert.deepEqual(report.seats.map((entry) => entry.id), ['selected-seat'])
  assert.equal(report.totals.usd.value, 7, 'another Goal’s spend is absent from the total')
  assert.deepEqual(report.breakdowns.flatMap((breakdown) => breakdown.rows.map((row) => row.label)), ['goal-selected', 'Selected', 'goal-selected'])
  assert.ok(report.breakdowns.every((breakdown) => breakdown.unattributed.usd.value === null), 'unattributed amounts do not retain another Goal’s usage')
})

test('one Goal receipt and comparison include every one of its Seats, never another Goal', async () => {
  const source = { id: 'source', kind: 'corpus' as const, label: 'Transcript', observedAt: 10, checkedAt: 10, stale: false, problem: null }
  const sample = (sessionId: string, usd: number) => ({ key: sessionId, source, runtime: 'runtime', sessionId, turnId: null, requestId: null, project: '/repo', model: null, from: 10, to: 11, scope: 'call' as const, includesChildren: false, input: { value: 1, quality: 'exact' as const }, output: { value: 1, quality: 'exact' as const }, cacheRead: { value: 0, quality: 'exact' as const }, cacheWrite: { value: 0, quality: 'exact' as const }, usd: { value: usd, quality: 'exact' as const }, moneyBasis: 'vendorMetered' as const })
  const choices = { left: { runtime: 'runtime', model: 'left' }, right: { runtime: 'runtime', model: 'right' } } as const
  const seat = (id: string, board: string, choice: typeof choices.left | typeof choices.right) => ({ id, agent: { id: 'reviewer', name: 'Reviewer', origin: 'project' as const }, briefDigest: 'same', seat: choice, seatLabel: choice.model, checkout: { project: '/repo' }, board, session: { runtime: 'runtime', sessionId: id }, openedAt: 0, closed: null, restored: null })
  const seats = [seat('left-a', 'goal-a', choices.left), seat('left-b', 'goal-a', choices.left), seat('right-a', 'goal-a', choices.right), seat('right-b', 'goal-a', choices.right), seat('other', 'goal-b', choices.left)]
  const docs = [{ goal: { id: 'goal-a', root: '/repo', sentence: 'A', state: 'wrapped' }, receipt: { id: 'receipt-a', seats: ['left-a', 'left-b', 'right-a', 'right-b'] } }, { goal: { id: 'goal-b', root: '/repo', sentence: 'B', state: 'wrapped' }, receipt: { id: 'receipt-b', seats: ['other'] } }]
  const plane = new InsightPlane({ ledger: () => ({ readInsight: async () => ({ samples: [sample('left-a', 10), sample('left-b', 10), sample('right-a', 5), sample('right-b', 20), sample('other', 99)], sources: [source], gaps: [], complete: true }) }) as never, goals: { store: { list: () => docs, read: (id: string) => docs.find(doc => doc.goal.id === id)! } } as never, seats: () => seats as never, seating: {} as never, now: () => 20 })
  const receipt = await plane.goal('goal-a')
  assert.equal(receipt.totals.usd.value, 45)
  assert.equal(receipt.breakdowns.find(row => row.dimension === 'goal')?.rows.length, 1)
  const compared = await plane.compare({ root: '/repo', from: 0, to: 20, goals: ['goal-a'], left: { agent: 'reviewer', origin: 'project', briefDigest: 'same', seat: choices.left }, right: { agent: 'reviewer', origin: 'project', briefDigest: 'same', seat: choices.right } })
  assert.equal(compared.left.usd.value, 20)
  assert.equal(compared.right.usd.value, 25)
  assert.equal(compared.left.tokens.value, 4, 'left totals include only its selected historical Seats')
  assert.equal(compared.right.tokens.value, 4, 'right totals include only its selected historical Seats')
  assert.equal(compared.left.turns.value, 2, 'left turn count does not copy the whole-project total')
  assert.equal(compared.right.turns.value, 2, 'right turn count does not copy the whole-project total')
})
