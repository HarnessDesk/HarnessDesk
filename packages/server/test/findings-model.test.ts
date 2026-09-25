import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceRecord, FindingEvent, FindingOrigin, FindingPost } from '@harnessdesk/protocol'

import { changeFinding, foldFindings, isResolved, liveBlockers } from '../src/findings/model.js'

/*
 * The findings ledger's lifecycle: a raise, then claims and verdicts, each an
 * evidence record, folded in append order. A repair is a claim until a
 * reviewer confirms it; a confirmed finding never reopens; a damaged or
 * restored history never reads as zero blockers.
 */

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const ID = 'finding-00000000-0000-4000-8000-000000000001'
const origin: FindingOrigin = { goal: 'goal-1', run: 'run-1', round: 1, card: 4, seat: 'seat-reviewer', at: A }

const raise: FindingEvent = {
  kind: 'raise', title: 'The retry loop never ends', body: 'It retries on every status.', category: 'ordinary',
  blocking: true, related: null, anchor: { path: 'src/retry.ts', line: 12, side: 'RIGHT' },
}

let counter = 0
const event = (
  sequence: number,
  finding: FindingEvent,
  over: { state?: 'open' | 'repaired' | 'withdrawn'; at?: string; seat?: string | null; origin?: FindingOrigin; id?: string; posted?: { pr: number; comment: number } | null; restored?: boolean } = {},
): EvidenceRecord => {
  counter += 1
  const state = over.state ?? (finding.kind === 'repair' ? 'repaired' : finding.kind === 'verdict' ? finding.state : 'open')
  return {
    id: over.id ?? `record-${counter}`,
    fact: { kind: 'finding', id: ID, state, at: over.at ?? A },
    card: { board: 'goal-1', id: 4 },
    checkout: { cwd: '/work/repo', branch: 'fix' },
    seat: over.seat === undefined ? 'seat-reviewer' : over.seat,
    round: 1,
    observedAt: counter,
    posted: over.posted ?? null,
    ...(over.restored ? { restored: { at: 99 } } : {}),
    finding: { version: 1, sequence, operation: `op-${counter}`, origin: over.origin ?? origin, event: finding },
  }
}

const repair = (sequence: number, at: string, seat = 'seat-writer'): EvidenceRecord =>
  event(sequence, { kind: 'repair', note: 'Bounded the retries.' }, { at, seat })
const verdict = (sequence: number, state: 'open' | 'repaired' | 'withdrawn', at: string, seat: string | null = 'seat-reviewer-2', by: 'seat' | 'person' = 'seat'): EvidenceRecord =>
  event(sequence, { kind: 'verdict', state, note: 'Checked.', by }, { at, seat })

const only = (records: readonly EvidenceRecord[]) => {
  const views = foldFindings(records)
  assert.equal(views.length, 1)
  return views[0]!
}

test('repair remains an unconfirmed claim', () => {
  const view = only([event(1, raise), repair(2, B)])
  assert.equal(view.lifecycle.state, 'repaired')
  assert.equal(view.lifecycle.confirmed, false)
  assert.deepEqual(view.lifecycle.repairs, [B])
  assert.equal(isResolved(view), false, 'a claimed repair is still unresolved')
  assert.deepEqual(liveBlockers([view]).map((one) => one.id), [ID], 'and still blocks')
})

test('same revision is one repair attempt', () => {
  const view = only([event(1, raise), repair(2, B), repair(3, B)])
  assert.deepEqual(view.lifecycle.repairs, [B])
  assert.equal(view.sequence, 3, 'both events are in the ledger')
  assert.equal(view.evidence.length, 3)
  const direct = changeFinding({ state: 'repaired', confirmed: false, repairs: [B] }, { kind: 'repair', at: B })
  assert.deepEqual(direct.repairs, [B])
})

test('resolved identity cannot reopen', () => {
  const confirmed = changeFinding(changeFinding({ state: 'open', confirmed: false, repairs: [] }, { kind: 'repair', at: B }), { kind: 'verdict', state: 'repaired' })
  assert.equal(confirmed.confirmed, true)
  assert.throws(() => changeFinding(confirmed, { kind: 'verdict', state: 'open' }), /resolved\. Record a new linked finding/)
  const withdrawn = changeFinding({ state: 'open', confirmed: false, repairs: [] }, { kind: 'verdict', state: 'withdrawn' })
  assert.throws(() => changeFinding(withdrawn, { kind: 'repair', at: C }), /resolved/)
  // In the ledger, a later open verdict on a confirmed row is damage, and the row as confirmed is not silently kept.
  const view = only([event(1, raise), repair(2, B), verdict(3, 'repaired', B), verdict(4, 'open', C)])
  assert.match(view.problem ?? '', /resolved/)
  assert.equal(isResolved(view), false)
})

test('repair confirmation needs a repair', () => {
  assert.throws(() => changeFinding({ state: 'open', confirmed: false, repairs: [] }, { kind: 'verdict', state: 'repaired' }), /No repair has been recorded/)
  const view = only([event(1, raise), verdict(2, 'repaired', A)])
  assert.notEqual(view.problem, null)
  assert.equal(isResolved(view), false)
})

test('origin survives repair and carry', () => {
  const carry = event(4, { kind: 'carry', from: 'goal-1', receipt: 'receipt-1', to: 'goal-2' }, { state: 'open', at: B, seat: null })
  const view = only([event(1, raise), repair(2, B, 'seat-writer'), verdict(3, 'open', B, 'seat-reviewer-2'), carry])
  assert.deepEqual(view.origin, origin, 'the raiser, round and revision are the raise event’s')
  assert.equal(view.ownerGoal, 'goal-2')
  assert.equal(view.problem, null)
  // A later event naming another origin is corruption, not a new attribution.
  const forged = only([event(1, raise), event(2, { kind: 'repair', note: 'x' }, { at: B, seat: 'seat-writer', origin: { ...origin, seat: 'seat-writer' } })])
  assert.match(forged.problem ?? '', /origin/)
})

test('sequence damage remains blocking uncertainty', () => {
  const view = only([event(1, raise), verdict(3, 'withdrawn', A)])
  assert.notEqual(view.problem, null)
  assert.equal(isResolved(view), false)
  assert.deepEqual(liveBlockers([view]).map((one) => one.id), [ID], 'a damaged row blocks rather than disappearing')
  // Two different events claiming one sequence number are damage too.
  const doubled = only([event(1, raise), repair(2, B), verdict(2, 'withdrawn', B)])
  assert.notEqual(doubled.problem, null)
  // A history with no raise at all is damage.
  const headless = only([repair(2, B)])
  assert.notEqual(headless.problem, null)
})

test('post event does not change revision or lifecycle', () => {
  const location: FindingPost = { repo: 'acme/app', pr: 7, comment: 42, kind: 'issue-comment', url: 'https://example.com/acme/app/pull/7#c42', operation: 'publish-1' }
  const before = only([event(1, raise), repair(2, B)])
  const after = only([event(1, raise), repair(2, B), event(3, { kind: 'post', location }, { state: 'repaired', at: B, seat: null, posted: { pr: 7, comment: 42 } })])
  assert.deepEqual(after.lifecycle, before.lifecycle)
  assert.deepEqual(after.posted, [location])
  // A post that refreshes the revision or the state is damage.
  const moved = only([event(1, raise), repair(2, B), event(3, { kind: 'post', location }, { state: 'repaired', at: C, seat: null, posted: { pr: 7, comment: 42 } })])
  assert.notEqual(moved.problem, null)
})

test('restored resolved row is not live clearance', () => {
  const view = only([event(1, raise), repair(2, B), verdict(3, 'repaired', B, 'seat-reviewer-2', 'seat')].map((record) => ({ ...record, restored: { at: 5 } })))
  assert.equal(view.lifecycle.confirmed, true, 'the history says it was confirmed')
  assert.equal(view.restored, true)
  assert.equal(isResolved(view), false, 'but a restored confirmation clears nothing here')
  assert.deepEqual(liveBlockers([view]).map((one) => one.id), [ID])
  // One restored event anywhere in the chain is enough.
  const mixed = only([event(1, raise), repair(2, B), { ...verdict(3, 'repaired', B), restored: { at: 5 } }])
  assert.equal(isResolved(mixed), false)
})

test('a replayed record is one event, and a conflicting one under the same id is damage', () => {
  const first = event(1, raise)
  const view = only([first, first, repair(2, B)])
  assert.equal(view.problem, null)
  assert.equal(view.evidence.length, 2)
  const conflicting = only([first, { ...first, finding: { ...first.finding!, event: { ...raise, title: 'Other' } } }])
  assert.notEqual(conflicting.problem, null)
})

test('a person adjudicates without a Seat, and a Seat verdict needs one', () => {
  const person = only([event(1, raise), verdict(2, 'withdrawn', A, null, 'person')])
  assert.equal(person.problem, null)
  assert.equal(isResolved(person), true)
  const forged = only([event(1, raise), verdict(2, 'withdrawn', A, 'seat-reviewer-2', 'person')])
  assert.notEqual(forged.problem, null, 'a person verdict carried by a Seat is damage')
})
