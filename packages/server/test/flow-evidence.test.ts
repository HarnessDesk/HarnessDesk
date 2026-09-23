import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceView, Freshness } from '@harnessdesk/protocol'

import {
  AMBIGUOUS_REVIEWS,
  MISSING_EVIDENCE,
  NO_SUBJECT,
  chooseFact,
  evidenceGuard,
  evidenceValues,
  renderCardTemplate,
  renderEvidence,
  type FactChoice,
  type FlowEvidenceContext,
  type FlowSubject,
} from '../src/flow-evidence.js'

/*
 * Evidence guards read what the desk already observed, never a message or a
 * card's own outcome, and only facts the invariant at `FlowSubject` lets
 * speak: filed on a card of the finished round's dependency walk, at the
 * subject's own revision, fresh, and observed here.
 *
 * The shape used throughout: writers on cards 1 and 2 (round 1), a check on
 * cards 3 and 4 (round 2), a judge on card 5 (round 3, Seat `seat-judge`).
 * Every fact is filed where the desk really files it — a check on its check
 * card, a review on the judge's card, an observed diff or pull request on the
 * writer's card with no round.
 */

const FRESH: Freshness = { state: 'fresh' }
const STALE: Freshness = { state: 'behind', commits: 3 }

let nextId = 1
const view = (input: {
  readonly kind: 'check' | 'ci' | 'review' | 'pr' | 'diff'
  readonly card: number
  readonly round?: number | null
  readonly at: string
  readonly freshness?: Freshness
  readonly restored?: boolean
  readonly board?: string
  readonly run?: string
  readonly exit?: number | null
  readonly verdict?: string
  readonly by?: string
  readonly checksState?: 'passed' | 'failed' | 'cancelled' | 'pending'
  readonly prState?: 'open' | 'merged' | 'closed'
  readonly files?: number
}): EvidenceView => {
  const id = `fact-${nextId++}`
  const fact =
    input.kind === 'check'
      ? { kind: 'check' as const, name: 'gate', run: input.run ?? 'pnpm verify', exit: input.exit === undefined ? 0 : input.exit, timedOut: false, at: input.at, dirty: false, tail: '' }
      : input.kind === 'ci'
        ? { kind: 'ci' as const, checks: [{ name: 'build', state: input.checksState ?? 'passed', url: null }], at: input.at }
        : input.kind === 'review'
          ? { kind: 'review' as const, verdict: input.verdict ?? 'picked', by: input.by ?? 'seat-judge', at: input.at }
          : input.kind === 'pr'
            ? { kind: 'pr' as const, number: 7, head: input.at, state: input.prState ?? 'open', url: null }
            : { kind: 'diff' as const, files: input.files ?? 1, added: 1, removed: 0, from: 'base', to: input.at }
  return {
    record: {
      id, fact, card: { board: input.board ?? 'goal-1', id: input.card }, checkout: { cwd: '/repo', branch: 'work' },
      seat: input.kind === 'review' ? (input.by ?? 'seat-judge') : null,
      round: input.round === undefined ? null : input.round, observedAt: nextId, posted: null,
      ...(input.restored ? { restored: { at: 1 } } : {}),
    },
    freshness: input.freshness ?? FRESH,
    by: null,
  }
}

const subject = (card: number, at: string): FlowSubject => ({ card, round: 1, checkout: { cwd: `/repo/.lanes/${card}`, branch: `lane-${card}` }, at })

const A = subject(1, 'sha-a')
const B = subject(2, 'sha-b')

/** The judge round finished, over the writers `subjects`, with the check cards between. */
const judged = (subjects: readonly FlowSubject[], facts: readonly EvidenceView[], extra: Partial<FlowEvidenceContext> = {}): FlowEvidenceContext => ({
  goal: 'goal-1',
  finished: { n: 3, role: 'judge', cards: [5], seats: ['seat-judge'], evidence: [], state: 'closed', cause: 'after:2:to-judge' },
  subjects,
  unsettled: [],
  cards: [5, 3, 4, ...subjects.map((one) => one.card)],
  reviewers: ['seat-judge'],
  facts,
  outcomes: ['picked'],
  ...extra,
})

/** The check round finished, over the writers `subjects`. */
const checked = (subjects: readonly FlowSubject[], facts: readonly EvidenceView[]): FlowEvidenceContext => ({
  ...judged(subjects, facts),
  finished: { n: 2, role: 'verify', cards: [3, 4], seats: [], evidence: [], state: 'closed', cause: 'after:1:to-verify' },
  cards: [3, 4, ...subjects.map((one) => one.card)],
  reviewers: [],
  outcomes: ['pass', 'pass'],
})

// ------------------------------------------------------------- chooseFact

test('chooseFact: the last observation of one question decides, and a stale last one waits', () => {
  const pass = (id: string): FactChoice => ({ id, question: 'check', at: 'sha-a', fresh: true, passed: true })
  const fail = (id: string): FactChoice => ({ id, question: 'check', at: 'sha-a', fresh: true, passed: false })
  const scope = { question: 'check', at: 'sha-a' }
  assert.equal(chooseFact([pass('p1'), fail('f1')], scope).state, 'fail', 'a later failure defeats an earlier pass')
  const later = chooseFact([fail('f1'), pass('p1')], scope)
  assert.equal(later.state === 'pass' ? later.fact.id : null, 'p1', 'a later pass wins')
  assert.equal(chooseFact([pass('p1'), { ...pass('p2'), fresh: false }], scope).state, 'missing', 'a stale last observation hides an older fresh pass')
  assert.equal(chooseFact([pass('p1')], { question: 'check', at: 'sha-b' }).state, 'missing', 'another revision is another question')
  assert.equal(chooseFact([{ ...pass('p1'), passed: null }], scope).state, 'missing', 'not a verdict yet')
})

// ---------------------------------------------------------- where facts come from

test('a check filed on the check card speaks for the writer it checked, by revision', () => {
  const onA = view({ kind: 'check', card: 3, round: 2, at: 'sha-a' })
  const onB = view({ kind: 'check', card: 4, round: 2, at: 'sha-b' })
  const both = evidenceGuard([{ check: 'pnpm verify' }], checked([A, B], [onA, onB]))
  assert.equal(both.state, 'matched', 'the facts are on cards 3 and 4, the subjects are cards 1 and 2')
  assert.deepEqual(both.state === 'matched' ? [...both.evidence].sort() : null, [onA.record.id, onB.record.id].sort())

  // One writer without its passing check: every subject must pass.
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A, B], [onA])).state, 'waiting')
  // Another command's pass is not this check's.
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [view({ kind: 'check', card: 3, round: 2, at: 'sha-a', run: 'true' })])).state, 'waiting')
})

test('a fact outside the dependency walk, on another Goal, or brought by a backup never speaks', () => {
  const pass = (extra: Partial<Parameters<typeof view>[0]>) => view({ kind: 'check', card: 3, round: 2, at: 'sha-a', ...extra })
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [pass({ card: 9 })])).state, 'waiting', 'a card this walk never crossed')
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [pass({ board: 'goal-2' })])).state, 'waiting', 'another Goal’s card with the same number')
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [pass({ restored: true })])).state, 'waiting', 'restored, so unproven here')
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [pass({ freshness: STALE })])).state, 'waiting', 'stale')
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [pass({ at: 'sha-old' })])).state, 'waiting', 'an older revision of the same writer')
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [pass({})])).state, 'matched', 'the exact fact is still found')
})

test('missing evidence waits; a fresh explicit failure is no-match so a failure route can fire', () => {
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [])).state, 'waiting')
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [view({ kind: 'check', card: 3, round: 2, at: 'sha-a', exit: 1 })])).state, 'no-match')
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [
    view({ kind: 'check', card: 3, round: 2, at: 'sha-a' }), view({ kind: 'check', card: 3, round: 2, at: 'sha-a', exit: 1 }),
  ])).state, 'no-match', 'the later failure at the same revision wins')
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [view({ kind: 'check', card: 3, round: 2, at: 'sha-a', exit: null })])).state, 'no-match', 'a check that never exited did not pass')
})

test('observed facts carry no round, and are found on the writer’s own card by revision', () => {
  const research: FlowEvidenceContext = {
    ...judged([A], []), finished: { n: 1, role: 'research', cards: [1], seats: ['seat-1'], evidence: [], state: 'closed', cause: 'seed' },
    cards: [1], reviewers: ['seat-1'], outcomes: ['gathered'],
  }
  const diff = view({ kind: 'diff', card: 1, at: 'sha-a' })
  const matched = evidenceGuard([{ diff: true }], { ...research, facts: [diff] })
  assert.deepEqual(matched.state === 'matched' ? matched.evidence : null, [diff.record.id])
  assert.equal(evidenceGuard([{ diff: true }], { ...research, facts: [view({ kind: 'diff', card: 1, at: 'sha-a', files: 0 })] }).state, 'no-match', 'an empty diff is an observed "nothing changed"')
  assert.equal(evidenceGuard([{ diff: true }], { ...research, facts: [view({ kind: 'diff', card: 1, at: 'sha-old' })] }).state, 'waiting', 'a diff of an older head')

  const ci = (state: 'passed' | 'failed' | 'cancelled' | 'pending') => ({ ...research, facts: [view({ kind: 'ci', card: 1, at: 'sha-a', checksState: state })] })
  assert.equal(evidenceGuard([{ ci: 'green' }], ci('passed')).state, 'matched')
  assert.equal(evidenceGuard([{ ci: 'green' }], ci('pending')).state, 'waiting', 'still running is not a verdict')
  assert.equal(evidenceGuard([{ ci: 'green' }], ci('failed')).state, 'no-match')
  assert.equal(evidenceGuard([{ ci: 'green' }], ci('cancelled')).state, 'no-match', 'cancelled is never green')

  const pr = (state: 'open' | 'merged' | 'closed') => ({ ...research, facts: [view({ kind: 'pr', card: 1, at: 'sha-a', prState: state })] })
  assert.equal(evidenceGuard([{ pr: 'open' }], pr('open')).state, 'matched')
  assert.equal(evidenceGuard([{ pr: 'merged' }], pr('open')).state, 'waiting', 'an open pull request may still merge')
  assert.equal(evidenceGuard([{ pr: 'merged' }], pr('closed')).state, 'no-match', 'a closed one will not')
  assert.equal(evidenceGuard([{ pr: 'open' }], pr('merged')).state, 'no-match')
})

// ------------------------------------------------------------------ reviews

test('a review filed on the judge’s card speaks for the one candidate it names', () => {
  const review = view({ kind: 'review', card: 5, round: 3, at: 'sha-a' })
  const one = evidenceGuard([{ review: 'picked' }], judged([A], [review]))
  assert.equal(one.state, 'matched', 'the review is on card 5, the subject on card 1')
  assert.deepEqual(one.state === 'matched' ? one.evidence : null, [review.record.id], 'the review id is carried as the rule’s evidence')
  assert.equal(evidenceGuard([{ review: 'picked' }], judged([A], [view({ kind: 'review', card: 5, round: 3, at: 'sha-a', verdict: 'neither' })])).state, 'no-match')
  assert.equal(evidenceGuard([{ review: 'picked' }], judged([A], [view({ kind: 'review', card: 5, round: 3, at: 'sha-a', by: 'seat-other' })])).state, 'waiting', 'a Seat that is not this round’s reviewer')
})

test('the winner revision is singular and every guard shares it', () => {
  const checkA = view({ kind: 'check', card: 3, round: 2, at: 'sha-a' })
  const checkB = view({ kind: 'check', card: 4, round: 2, at: 'sha-b', exit: 1 })
  const two = { reviewers: ['seat-r1', 'seat-r2'], finished: { n: 3, role: 'judge', cards: [5, 6], seats: ['seat-r1', 'seat-r2'], evidence: [], state: 'closed' as const, cause: 'x' }, cards: [5, 6, 3, 4, 1, 2] }
  const reviewA1 = view({ kind: 'review', card: 5, round: 3, at: 'sha-a', by: 'seat-r1' })
  const reviewB2 = view({ kind: 'review', card: 6, round: 3, at: 'sha-b', by: 'seat-r2' })
  const split = evidenceGuard([{ review: 'picked' }], judged([A, B], [checkA, checkB, reviewA1, reviewB2], two))
  assert.deepEqual(split, { state: 'waiting', reason: AMBIGUOUS_REVIEWS }, 'never a partial match at each')

  const reviewA2 = view({ kind: 'review', card: 6, round: 3, at: 'sha-a', by: 'seat-r2' })
  const agreed = evidenceGuard([{ check: 'pnpm verify' }, { review: 'picked' }], judged([A, B], [checkA, checkB, reviewA1, reviewA2], two))
  assert.equal(agreed.state, 'matched', 'the review narrows first, whatever order the rule lists its guards in')
  assert.deepEqual(agreed.state === 'matched' ? agreed.subjects.map((one) => one.card) : null, [1])
  assert.deepEqual(agreed.state === 'matched' ? [...agreed.evidence].sort() : null, [reviewA1.record.id, reviewA2.record.id, checkA.record.id].sort())

  const onlyOne = evidenceGuard([{ review: 'picked' }], judged([A, B], [reviewA1], two))
  assert.equal(onlyOne.state, 'waiting', 'every required reviewer must have judged the chosen revision')

  const aFails = view({ kind: 'check', card: 3, round: 2, at: 'sha-a', exit: 1 })
  assert.equal(evidenceGuard([{ review: 'picked' }, { check: 'pnpm verify' }], judged([A, B], [aFails, reviewA1, reviewA2], two)).state, 'no-match', 'the winner’s own check failed')
})

test('a writer with no clean head waits, unless a review already chose another', () => {
  const dirty = { unsettled: [{ card: 2, why: 'its checkout has changes that are not committed' }] }
  const checks = [view({ kind: 'check', card: 3, round: 2, at: 'sha-a' })]
  const waits = evidenceGuard([{ check: 'pnpm verify' }], { ...checked([A], checks), ...dirty })
  assert.equal(waits.state, 'waiting', 'card 2 is not quietly left out of “every subject”')
  assert.match(waits.state === 'waiting' ? waits.reason : '', /card #2: its checkout has changes/)
  const review = view({ kind: 'review', card: 5, round: 3, at: 'sha-a' })
  assert.equal(evidenceGuard([{ review: 'picked' }], judged([A], [review], dirty)).state, 'matched')
  assert.deepEqual(evidenceGuard([{ check: 'pnpm verify' }], checked([], [])), { state: 'waiting', reason: NO_SUBJECT })
})

test('head movement between guard and dispatch leaves nothing to authorize', () => {
  const passed = view({ kind: 'check', card: 3, round: 2, at: 'sha-a' })
  assert.equal(evidenceGuard([{ check: 'pnpm verify' }], checked([A], [passed])).state, 'matched')
  assert.notEqual(evidenceGuard([{ check: 'pnpm verify' }], checked([subject(1, 'sha-c')], [passed])).state, 'matched')
})

// ------------------------------------------------------------------ rendering

test('renderEvidence and card templates are one pass over an allowlisted field', () => {
  assert.equal(renderEvidence('Card at {{evidence.check.at}}.', { 'check.at': 'sha-a' }), 'Card at sha-a.')
  assert.equal(renderEvidence('{{evidence.review.verdict}}', { 'review.verdict': '{{evidence.check.at}}' }), '{{evidence.check.at}}', 'no recursive expansion')
  assert.throws(() => renderEvidence('{{evidence.check.author}}', { 'check.author': 'x' }), /not supported/)
  assert.throws(() => renderEvidence('{{evidence.check.at.sha}}', {}), /not supported/)
  assert.throws(() => renderEvidence('{{evidence.review.at}}', {}), (error: Error) => error.message === MISSING_EVIDENCE)

  assert.equal(
    renderCardTemplate('{{task}} at {{evidence.review.at}} {{unknown}}', { task: 'Ship {{evidence.review.at}}' }, { 'review.at': 'sha-a' }),
    'Ship {{evidence.review.at}} at sha-a {{unknown}}',
    'an input that looks like a field stays literal; an unknown ordinary slot stays as written',
  )
  assert.throws(() => renderCardTemplate('Merge {{evidence.review.at}}', {}, {}), (error: Error) => error.message === MISSING_EVIDENCE)
})

test('evidence values are only the fields every fact agrees on', () => {
  const a = view({ kind: 'review', card: 5, round: 3, at: 'sha-a' }).record
  const b = view({ kind: 'review', card: 6, round: 3, at: 'sha-b', by: 'seat-2' }).record
  const check = view({ kind: 'check', card: 3, round: 2, at: 'sha-a' }).record
  assert.deepEqual(evidenceValues([a, check]), {
    'review.at': 'sha-a', 'review.verdict': 'picked', 'review.by': 'seat-judge', 'check.at': 'sha-a', 'check.name': 'gate', 'check.exit': '0',
  })
  assert.equal(evidenceValues([a, b])['review.at'], undefined, 'two revisions give no single one')
  assert.equal(evidenceValues([a, b])['review.verdict'], 'picked')
})
