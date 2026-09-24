import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceRecord, EvidenceView, FindingSeries, FindingView } from '@harnessdesk/protocol'

import {
  advanceProgress, closeSeries, decideLoop, progressKeys, QuestionDeadline, QUESTION_STOP, rejectedRepairs, type LoopSample,
} from '../src/findings/rounds.js'

/*
 * A bounded loop: every closed round is counted once, progress is what the
 * desk observed that it had not seen before, two rejected repairs are a design
 * problem, a later ordinary claim never grows the blocking set, and a
 * regression or security claim waits for a person. The decision is pure:
 * it cannot open a Seat or merge.
 */

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

const sample = (over: Partial<LoopSample> = {}): LoopSample => ({
  closed: 1, limit: 3, idle: 0, idleLimit: 2, newProgress: true, unresolvedRepairs: [], unresolved: 0,
  reviewComplete: true, freshGuards: true, pendingException: false, ...over,
})

test('ceiling wins over green merge', () => {
  assert.deepEqual(decideLoop(sample({ closed: 2 })), { idle: 0, next: 'merge-card', reason: null })
  const third = decideLoop(sample({ closed: 3 }))
  assert.equal(third.next, 'person', 'the third closed round stops at the person even with every guard green')
  assert.equal(third.reason, 'Round 3 ended with 0 open findings.')
  assert.equal(decideLoop(sample({ closed: 1, unresolved: 2 })).next, 'continue')
})

const view = (id: string, fact: EvidenceRecord['fact'], over: Partial<EvidenceRecord> = {}): EvidenceView => ({
  record: { id, fact, card: { board: 'goal-1', id: 1 }, checkout: null, seat: null, round: 1, observedAt: 1, posted: null, ...over },
  freshness: { state: 'fresh' },
  by: null,
})
const check = (id: string, exit: number, at = A): EvidenceView =>
  view(id, { kind: 'check', name: 'verify', run: 'pnpm verify', exit, timedOut: false, at, dirty: false, tail: '' })
const review = (id: string, seat: string, verdict: string, at = A): EvidenceView =>
  view(id, { kind: 'review', verdict, by: seat, at }, { seat, card: { board: 'goal-1', id: 2 } })
const slotOf = (seat: string): string => ({ 'seat-2': 'reviewer:0:code-reviewer', 'seat-5': 'reviewer:0:code-reviewer' }[seat] ?? seat)

test('repeated evidence does not reset idle count', () => {
  const first = progressKeys({ facts: [check('fact-1', 0), review('fact-2', 'seat-2', 'request-changes')], slotOf, confirmed: [] })
  let state = advanceProgress([], first, true)
  assert.equal(state.newProgress, true)
  // The same check and the same Agent's same verdict, at the same revision: new record ids, new times, a fresh Seat.
  const again = progressKeys({ facts: [check('fact-9', 0), { ...review('fact-10', 'seat-5', 'request-changes'), record: { ...review('fact-10', 'seat-5', 'request-changes').record, observedAt: 99 } }], slotOf, confirmed: [] })
  assert.deepEqual(again, first, 'the tuples are the same questions with the same answers')
  let idle = 0
  for (let round = 2; round <= 3; round += 1) {
    state = advanceProgress(state.progress, again, false)
    const decision = decideLoop(sample({ closed: round, limit: 10, idle, newProgress: state.newProgress, unresolved: 1 }))
    idle = decision.idle
    if (round === 3) {
      assert.equal(decision.next, 'person')
      assert.equal(decision.reason, '2 rounds ended without new evidence.')
    }
  }
  // A posting, a carry or a timestamp is never progress: those are not facts this reads.
  assert.deepEqual(progressKeys({ facts: [], slotOf, confirmed: [] }), [])
})

test('new failing check is progress once', () => {
  const pass = progressKeys({ facts: [check('fact-1', 0)], slotOf, confirmed: [] })
  let state = advanceProgress([], pass, true)
  const failed = progressKeys({ facts: [check('fact-1', 0), check('fact-2', 1)], slotOf, confirmed: [] })
  state = advanceProgress(state.progress, failed, false)
  assert.equal(state.newProgress, true, 'a changed result is new evidence')
  const decision = decideLoop(sample({ closed: 2, limit: 10, idle: 1, newProgress: state.newProgress, unresolved: 1 }))
  assert.equal(decision.idle, 0, 'and resets the idle count')
  state = advanceProgress(state.progress, failed, false)
  assert.equal(state.newProgress, false, 'the same failure again is not')
  assert.equal(decideLoop(sample({ closed: 3, limit: 10, idle: 0, newProgress: state.newProgress, unresolved: 1 })).idle, 1)
})

const finding = 'finding-00000000-0000-4000-8000-000000000001'
const origin = { goal: 'goal-1', run: 'run-1', round: 1, card: 2, seat: 'seat-2', at: A }
const event = (id: string, sequence: number, at: string, state: 'open' | 'repaired', event: NonNullable<EvidenceRecord['finding']>['event']): EvidenceRecord => ({
  id, fact: { kind: 'finding', id: finding, state, at }, card: { board: 'goal-1', id: 3 }, checkout: null,
  seat: event.kind === 'raise' ? 'seat-2' : event.kind === 'repair' ? 'seat-4' : 'seat-5', round: sequence, observedAt: sequence, posted: null,
  finding: { version: 1, sequence, operation: `op-${id}`, origin, event },
})

test('twice repaired and rejected stops', () => {
  const raise = event('r1', 1, A, 'open', { kind: 'raise', title: 'Unbounded', body: '', category: 'ordinary', blocking: true, related: null, anchor: null })
  const repairB = event('p1', 2, B, 'repaired', { kind: 'repair', note: 'first try' })
  const retryB = event('p2', 3, B, 'repaired', { kind: 'repair', note: 'same revision again' })
  const rejectB = event('v1', 4, B, 'open', { kind: 'verdict', state: 'open', note: 'still wrong', by: 'seat' })
  assert.equal(rejectedRepairs([raise, repairB, retryB, rejectB], finding), 1, 'a same-revision retry is one rejected attempt')
  const repairC = event('p3', 5, C, 'repaired', { kind: 'repair', note: 'second try' })
  assert.equal(rejectedRepairs([raise, repairB, retryB, rejectB, repairC], finding), 1, 'an unreviewed second claim is not yet a rejection')
  const rejectC = event('v2', 6, C, 'open', { kind: 'verdict', state: 'open', note: 'still wrong', by: 'seat' })
  const count = rejectedRepairs([raise, repairB, retryB, rejectB, repairC, rejectC], finding)
  assert.equal(count, 2)
  const decision = decideLoop(sample({ closed: 2, limit: 10, unresolved: 1, unresolvedRepairs: [count] }))
  assert.equal(decision.next, 'person')
  assert.equal(decision.reason, 'This is a design problem, not a patch problem.')
})

const raised = (id: string, category: FindingView['category'], blocking = true): FindingView => ({
  id, origin, ownerGoal: 'goal-1', title: id, body: '', category, blocking, related: null, anchor: null,
  lifecycle: { state: 'open', confirmed: false, repairs: [] }, sequence: 1, evidence: [], posted: [], restored: false, problem: null,
})
const fresh = (): FindingSeries => ({
  id: 'reviewer@/repo', role: 'reviewer', checkout: { cwd: '/repo', branch: 'fix' }, reviewedAt: null, reviewRounds: [], initial: [], exceptions: [], pending: [],
})

test('ordinary later findings cannot grow baseline', () => {
  const first = closeSeries(fresh(), { round: 2, at: A, raised: [raised('finding-a', 'ordinary'), raised('finding-nit', 'ordinary', false)], carried: [] })
  assert.deepEqual(first.initial, ['finding-a'], 'the first review freezes its blocking claims, and only those')
  assert.deepEqual(first.reviewRounds, [2])
  assert.equal(first.reviewedAt, A)
  const later = closeSeries(first, { round: 4, at: B, raised: [raised('finding-b', 'ordinary')], carried: [] })
  assert.deepEqual(later.initial, ['finding-a'], 'a later ordinary claim is advisory: the baseline does not grow')
  assert.deepEqual(later.pending, [])
  assert.deepEqual(later.exceptions, [])
  assert.equal(later.reviewedAt, B)
})

test('exception waits for person', () => {
  const first = closeSeries(fresh(), { round: 2, at: A, raised: [], carried: [] })
  const later = closeSeries(first, { round: 4, at: B, raised: [raised('finding-sec', 'security'), raised('finding-reg', 'regression')], carried: [] })
  assert.deepEqual(later.pending, ['finding-sec', 'finding-reg'], 'a model’s security label is a claim waiting for a person')
  assert.deepEqual(later.exceptions, [], 'never admitted by itself')
  assert.deepEqual(later.initial, [])
  const decision = decideLoop(sample({ closed: 2, limit: 10, pendingException: true }))
  assert.equal(decision.next, 'person')
  assert.equal(decision.reason, 'Review the new regression or security finding before continuing.')
})

test('carried unresolved findings join the first review’s blocking set', () => {
  const carried = { ...raised('finding-old', 'ordinary'), ownerGoal: 'goal-2', origin: { ...origin, goal: 'goal-1' } }
  const first = closeSeries(fresh(), { round: 1, at: A, raised: [], carried: [carried] })
  assert.deepEqual(first.initial, ['finding-old'])
})

test('unanswered question preserves partial output', async () => {
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  let now = 0
  const timers: { at: number; fire: () => void; cleared: boolean }[] = []
  const interrupts: string[] = []
  const stops: { key: string; reason: string }[] = []
  const deadline = new QuestionDeadline({
    ms: 20_000,
    setTimer: (fire, ms) => { const timer = { at: now + ms, fire, cleared: false }; timers.push(timer); return timer },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true },
    interrupt: async (key) => { interrupts.push(key) },
    stop: async (key, reason) => { stops.push({ key, reason }) },
  })
  const tick = (to: number): void => {
    now = to
    for (const timer of timers) if (!timer.cleared && timer.at <= now) { timer.cleared = true; timer.fire() }
  }
  deadline.asked('alpha:s1', 'approval-1')
  deadline.asked('alpha:s1', 'approval-1')
  tick(19_999)
  assert.deepEqual(interrupts, [], 'nothing happens before twenty seconds')
  tick(20_000)
  await settle()
  assert.deepEqual(interrupts, ['alpha:s1'], 'one interrupt, however often the question was seen')
  assert.deepEqual(stops, [{ key: 'alpha:s1', reason: QUESTION_STOP }])
  assert.equal(QUESTION_STOP, 'asked a question nobody can answer')
  tick(60_000)
  await settle()
  assert.deepEqual(interrupts, ['alpha:s1'], 'never a second one')
  // A question answered in time is not stopped at all.
  deadline.asked('alpha:s2', 'approval-2')
  deadline.answered('alpha:s2', 'approval-2')
  tick(90_000)
  await settle()
  assert.deepEqual(interrupts, ['alpha:s1'])
})
