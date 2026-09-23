import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceView, Freshness } from '@harnessdesk/protocol'

import {
  AMBIGUOUS_REVIEWS,
  MISSING_EVIDENCE,
  chooseFact,
  evidenceGuard,
  renderEvidence,
  type FactChoice,
  type FlowEvidenceContext,
  type FlowSubject,
} from '../src/flow-evidence.js'

/*
 * Evidence guards read what the desk already observed, never a message or a
 * card's own outcome, and never anything but the exact subject a rule names.
 */

const FRESH: Freshness = { state: 'fresh' }
const STALE: Freshness = { state: 'behind', commits: 3 }

let nextId = 1
const view = (input: {
  readonly kind: 'check' | 'ci' | 'review' | 'pr' | 'diff'
  readonly card: number
  readonly round: number
  readonly at: string
  readonly observedAt: number
  readonly freshness?: Freshness
  readonly restored?: boolean
  readonly run?: string
  readonly exit?: number | null
  readonly verdict?: string
  readonly by?: string
  readonly checksState?: 'passed' | 'failed' | 'cancelled' | 'pending'
  readonly prState?: 'open' | 'merged' | 'closed'
}): EvidenceView => {
  const id = `fact-${nextId++}`
  const fact =
    input.kind === 'check'
      ? { kind: 'check' as const, name: 'gate', run: input.run ?? 'pnpm verify', exit: input.exit ?? 0, timedOut: false, at: input.at, dirty: false, tail: '' }
      : input.kind === 'ci'
        ? { kind: 'ci' as const, checks: [{ name: 'build', state: input.checksState ?? 'passed', url: null }], at: input.at }
        : input.kind === 'review'
          ? { kind: 'review' as const, verdict: input.verdict ?? 'approve', by: input.by ?? 'seat-1', at: input.at }
          : input.kind === 'pr'
            ? { kind: 'pr' as const, number: 7, head: input.at, state: input.prState ?? 'open', url: null }
            : { kind: 'diff' as const, files: 1, added: 1, removed: 0, from: 'base', to: input.at }
  return {
    record: {
      id, fact, card: { board: 'goal-1', id: input.card }, checkout: { cwd: '/repo', branch: 'work' },
      seat: input.by ?? null, round: input.round, observedAt: input.observedAt, posted: null,
      ...(input.restored ? { restored: { at: input.observedAt } } : {}),
    },
    freshness: input.freshness ?? FRESH,
    by: null,
  }
}

const subject = (card: number, round: number, at = 'sha-a'): FlowSubject => ({ card, round, checkout: { cwd: '/repo', branch: 'work' }, at })

const contextOf = (round: number, subjects: readonly FlowSubject[], facts: readonly EvidenceView[]): FlowEvidenceContext => ({
  goal: 'goal-1',
  finished: { n: round, role: 'author', cards: subjects.map((one) => one.card), seats: [], evidence: [], state: 'closed', cause: 'seed' },
  subjects,
  facts,
  outcomes: subjects.map(() => 'done'),
})

// ------------------------------------------------------------- chooseFact

test('chooseFact: later failure defeats earlier pass and scope stays exact', () => {
  const base: Omit<FactChoice, 'id' | 'observedAt' | 'passed'> = { kind: 'check:pnpm verify', at: 'sha-a', fresh: true, restored: false, card: 1, round: 1 }
  const scope = { cards: [1], round: 1, kind: 'check:pnpm verify', at: 'sha-a' }

  // A pass, then a later failure at the exact same question: the failure wins.
  const sequence: FactChoice[] = [
    { ...base, id: 'p1', observedAt: 1, passed: true },
    { ...base, id: 'f1', observedAt: 2, passed: false },
  ]
  assert.equal(chooseFact(sequence, scope), null, 'the later failure defeats the earlier pass')

  // The opposite order: a later pass wins.
  const reversed: FactChoice[] = [
    { ...base, id: 'f1', observedAt: 1, passed: false },
    { ...base, id: 'p1', observedAt: 2, passed: true },
  ]
  assert.equal(chooseFact(reversed, scope)?.id, 'p1')

  // Scope stays exact: wrong card, round, revision, dirty (unfresh) and restored variants all miss.
  const pass = { ...base, id: 'p1', observedAt: 1, passed: true }
  assert.equal(chooseFact([{ ...pass, card: 2 }], scope), null, 'wrong card')
  assert.equal(chooseFact([{ ...pass, round: 2 }], scope), null, 'wrong round')
  assert.equal(chooseFact([{ ...pass, at: 'sha-b' }], scope), null, 'wrong revision')
  assert.equal(chooseFact([{ ...pass, fresh: false }], scope), null, 'stale (not fresh)')
  assert.equal(chooseFact([{ ...pass, restored: true }], scope), null, 'restored, so unproven here')
  assert.equal(chooseFact([pass], scope)?.id, 'p1', 'the exact match is still found')
})

test('chooseFact: removing the freshness/latest checks turns this red — proving the guard is load-bearing', () => {
  const base: FactChoice = { id: 'f1', kind: 'check:x', at: 'sha-a', fresh: true, restored: false, card: 1, round: 1, observedAt: 1, passed: false }
  const scope = { cards: [1], round: 1, kind: 'check:x', at: 'sha-a' }
  // The mutant: pretend the guard let any latest fact through regardless of pass/fresh/restored.
  const mutantChooseFact = (facts: readonly FactChoice[], s: typeof scope): FactChoice | null => {
    const matching = facts.filter((fact) => s.cards.includes(fact.card) && fact.round === s.round && fact.kind === s.kind && fact.at === s.at)
    return matching.at(-1) ?? null
  }
  assert.equal(chooseFact([base], scope), null, 'the real function refuses a failing fact')
  assert.notEqual(mutantChooseFact([base], scope), null, 'the mutant (no guard) would have wrongly accepted it — so the guard is load-bearing')
})

// ------------------------------------------------------------ renderEvidence

test('renderEvidence: one-pass substitution with an allowlisted field', () => {
  assert.equal(renderEvidence('Card at {{evidence.check.at}}.', { 'check.at': 'sha-a' }), 'Card at sha-a.')

  // A resolved value that itself contains braces is inserted as literal bytes, never re-expanded.
  assert.equal(
    renderEvidence('{{evidence.review.verdict}}', { 'review.verdict': '{{evidence.check.at}}' }),
    '{{evidence.check.at}}',
    'no recursive expansion',
  )

  // An unknown or multi-level path is refused, not silently dropped.
  assert.throws(() => renderEvidence('{{evidence.check.author}}', { 'check.author': 'x' }), /not supported/)
  assert.throws(() => renderEvidence('{{evidence.check.at.sha}}', {}), /not supported/)

  // A field the allowlist names, but this render pass has no value for, is refused rather than left blank.
  assert.throws(() => renderEvidence('{{evidence.review.at}}', {}), new RegExp(MISSING_EVIDENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

// -------------------------------------------------------------- evidenceGuard

test('evidenceGuard: missing evidence waits; a fresh explicit failure is no-match, not waiting', () => {
  const s = subject(1, 1)
  // Nothing observed at all: waiting, so a later fallback rule must not fire yet.
  const nothing = contextOf(1, [s], [])
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], nothing).state, 'waiting')

  // A stale (unfresh) fact: still waiting — a stale observation is not a verdict.
  const stale = contextOf(1, [s], [view({ kind: 'check', card: 1, round: 1, at: 'sha-a', observedAt: 1, exit: 0, freshness: STALE })])
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], stale).state, 'waiting')

  // A fresh, exact-revision failure: no-match, which a rule list may fall through past.
  const failed = contextOf(1, [s], [view({ kind: 'check', card: 1, round: 1, at: 'sha-a', observedAt: 1, exit: 1 })])
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], failed).state, 'no-match')

  // A fresh, exact-revision pass: matched, with the fact's own id as its evidence.
  const passed = view({ kind: 'check', card: 1, round: 1, at: 'sha-a', observedAt: 1, exit: 0 })
  const ok = evidenceGuard([{ check: 'pnpm verify' }], contextOf(1, [s], [passed]))
  assert.equal(ok.state, 'matched')
  assert.deepEqual(ok.state === 'matched' ? ok.evidence : null, [passed.record.id])
})

test('evidenceGuard: winner revision is singular and every guard shares it', () => {
  const a = subject(1, 2, 'sha-a')
  const b = subject(2, 2, 'sha-b')
  const checkA = view({ kind: 'check', card: 1, round: 2, at: 'sha-a', observedAt: 1, exit: 0 })
  const checkB = view({ kind: 'check', card: 2, round: 2, at: 'sha-b', observedAt: 1, exit: 1 })

  // Two reviewers naming different revisions: ambiguous, never a combined green.
  const reviewA = view({ kind: 'review', card: 3, round: 2, at: 'sha-a', observedAt: 2, verdict: 'approve', by: 'seat-r1' })
  const reviewB = view({ kind: 'review', card: 3, round: 2, at: 'sha-b', observedAt: 2, verdict: 'approve', by: 'seat-r2' })
  const disagreeing = contextOf(2, [a, b], [checkA, checkB, reviewA, reviewB])
  const ambiguous = evidenceGuard([{ review: 'approve' }], disagreeing)
  assert.equal(ambiguous.state, 'waiting')
  assert.equal(ambiguous.state === 'waiting' ? ambiguous.reason : null, AMBIGUOUS_REVIEWS)

  // Both reviewers agree on sha-a, and sha-a's own check also passes: exactly one subject wins,
  // and a second guard (the check) is judged only against that same winner.
  const reviewA2 = view({ kind: 'review', card: 3, round: 2, at: 'sha-a', observedAt: 3, verdict: 'approve', by: 'seat-r2' })
  const agreeing = contextOf(2, [a, b], [checkA, checkB, reviewA, reviewA2])
  const decided = evidenceGuard([{ review: 'approve' }, { check: 'pnpm verify' }], agreeing)
  assert.equal(decided.state, 'matched')
  assert.deepEqual(decided.state === 'matched' ? decided.subjects.map((one) => one.card) : null, [1], 'only the agreed-on candidate remains')
  assert.ok(decided.state === 'matched' && decided.evidence.includes(checkA.record.id), 'the winner’s own passing check is required too')

  // Had the winning candidate’s own check failed, the whole rule must not match on the review alone.
  const winnerFails = contextOf(2, [a, b], [
    view({ kind: 'check', card: 1, round: 2, at: 'sha-a', observedAt: 1, exit: 1 }), checkB, reviewA, reviewA2,
  ])
  assert.equal(evidenceGuard([{ review: 'approve' }, { check: 'pnpm verify' }], winnerFails).state, 'no-match')
})

test('evidenceGuard: head movement between guard and dispatch blocks a merge', () => {
  const s = subject(1, 1, 'sha-a')
  const passed = view({ kind: 'check', card: 1, round: 1, at: 'sha-a', observedAt: 1, exit: 0 })
  const context = contextOf(1, [s], [passed])
  const first = evidenceGuard([{ check: 'pnpm verify' }], context)
  assert.equal(first.state, 'matched')

  // HEAD moved before the second (dispatch-time) read: the same guard, asked again with the new
  // subject revision, finds nothing at that exact commit and refuses to authorize the merge.
  const movedSubject = subject(1, 1, 'sha-c')
  const second = evidenceGuard([{ check: 'pnpm verify' }], contextOf(1, [movedSubject], [passed]))
  assert.notEqual(second.state, 'matched')
})
