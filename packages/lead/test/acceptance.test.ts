import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contract, evidence, exported } from './fixtures/loop.js'

test('acceptance refuses stale or incompatible evidence, missing checks, reviews, blockers and incomplete spend', () => {
  const evaluate = exported('evaluateLeadAcceptance')
  const fresh = evidence()
  assert.equal(evaluate(contract, fresh, { now: 100, freshnessMs: 50, revision: 1 }).status, 'reviewed')
  for (const patch of [ { observedAt: 0 }, { revision: 'head-2' }, { contractDigest: 'b'.repeat(64) }, { checks: [] }, { reviews: [] },
    { spendComplete: false }, { complete: false }, { findingsComplete: false },
    { checks: [{ ...fresh.checks[0], counted: false }] }, { checks: [{ ...fresh.checks[0], exit: 1 }] },
    { reviews: [{ ...fresh.reviews[0], verdict: 'request-changes' }] },
    { findings: [{ id: 'finding-1', revision: 'head-1', blocking: true, resolved: false }] } ]) {
    assert.notEqual(evaluate(contract, { ...fresh, ...patch }, { now: 100, freshnessMs: 50, revision: 1 }).status, 'reviewed', JSON.stringify(patch))
  }
})


test('omitting any mandatory acceptance gate cannot produce reviewed acceptance', () => {
  for (const kind of ['check', 'review', 'blocking-findings']) {
    const proposal = { ...contract, assertions: contract.assertions.filter(assertion => assertion.kind !== kind) }
    assert.equal(exported('evaluateLeadAcceptance')(proposal, evidence(), { now: 100, freshnessMs: 50, revision: 1 }).status, 'unknown', kind)
  }
})

const options = { now: 100, freshnessMs: 50, revision: 1 }
const evaluate = (patch: object = {}, plan = contract) => exported('evaluateLeadAcceptance')(plan, { ...evidence(), ...patch }, options)

test('missing facts differ from stale, incomplete or incompatible facts', () => {
  assert.equal(evaluate({ checks: [] }).assertions[0].status, 'no-evidence')
  for (const patch of [{ observedAt: 0 }, { contractDigest: 'b'.repeat(64) }, { complete: false },
    { checks: [{ ...evidence().checks[0], revision: 'old' }] }])
    assert.equal(evaluate(patch).assertions[0].status, 'unknown')
  assert.notEqual(evaluate({ checks: [] }).assertions[0].reason, evaluate({ observedAt: 0 }).assertions[0].reason)
})

test('checks that cannot run are errored, never a code failure', () => {
  for (const patch of [{ timedOut: true, exit: 1 }, { exit: null }]) {
    const result = evaluate({ checks: [{ ...evidence().checks[0], ...patch }] })
    assert.equal(result.assertions[0].status, 'errored')
    assert.equal(result.status, 'unknown')
    assert.deepEqual(exported('leadAssertionsToRerun')(result), ['unit'])
  }
  for (const patch of [{ exit: 1 }, { dirty: true }, { counted: false }])
    assert.equal(evaluate({ checks: [{ ...evidence().checks[0], ...patch }] }).assertions[0].status, 'failed')
  assert.deepEqual(exported('leadAssertionsToRerun')(evaluate({ checks: [] })), ['unit'])
  assert.deepEqual(exported('leadAssertionsToRerun')(evaluate({ checks: [{ ...evidence().checks[0], observedAt: 0 }] })), ['unit'])
})

test('approval must not hedge outside quoted code', () => {
  for (const text of ['This SHOULD WORK.', 'Probably correct', "I didn't run the tests"]) {
    const result = evaluate({ reviews: [{ ...evidence().reviews[0], text }] })
    assert.equal(result.status, 'failed', text)
    assert.equal(result.assertions[1].reason, 'hedged-approval')
  }
  for (const text of ['Verified the checks and inspected the diff.', 'The string `should work` is tested.',
    'Example: ``a `should work` string``.', '```ts\n// should work\n```', 'The mightiest test passed.'])
    assert.equal(evaluate({ reviews: [{ ...evidence().reviews[0], text }] }).status, 'reviewed', text)
})

test('repair input carries exactly failed assertions, with separate errored checks', () => {
  const plan = { ...contract, assertions: [...contract.assertions, { id: 'lint', kind: 'check', description: 'Lint passes' }] }
  const result = evaluate({ checks: [{ ...evidence().checks[0], exit: 1 }, { ...evidence().checks[0], assertionId: 'lint', id: 'lint-1' }] }, plan as typeof contract)
  assert.equal(result.status, 'failed')
  assert.deepEqual(exported('leadRepairInput')(result), { failed: [{ assertionId: 'unit', reason: 'Recorded evidence failed' }], errored: [] })
  assert.deepEqual(exported('leadAssertionsToRerun')(result), [])
})


test('errored and missing evidence request a check action, not a repair', () => {
  const errored = evaluate({ checks: [{ ...evidence().checks[0], exit: null }] })
  assert.deepEqual(exported('leadRepairInput')(errored), { failed: [], errored: ['unit'] })
  assert.match(exported('leadAcceptanceObservation')(errored), /Re-run these checks; they did not fail, they could not run/)
  assert.match(exported('leadAcceptanceObservation')(errored), /existing check action/)
  const mixed = evaluate({ checks: [{ ...evidence().checks[0], exit: null }, { ...evidence().checks[0], id: 'other', exit: 1 }] })
  assert.equal(mixed.status, 'failed', 'a real failure wins over a concurrent runner error')
})

test('repair brief carries failed ids and reasons without including passed checks', () => {
  const result = evaluate({ reviews: [{ ...evidence().reviews[0], text: 'should work' }] })
  const brief = exported('leadRepairDetail')(result)
  assert.match(brief, /"assertionId":"review","reason":"hedged-approval"/)
  assert.doesNotMatch(brief, /"assertionId":"unit"/)
  assert.doesNotMatch(brief, /Fix only/, 'per-run data does not repeat the recipe instructions')
})


test('an aggregate check assertion names only the checks whose verdict failed', () => {
  const result = evaluate({ checks: [{ ...evidence().checks[0], name: 'unit', exit: 1 },
    { ...evidence().checks[0], name: 'lint', id: 'lint', exit: 0 }] })
  assert.equal(result.assertions[0].reason, 'Recorded evidence failed: unit')
  assert.doesNotMatch(exported('leadRepairDetail')(result), /lint/)
})


test('a failed aggregate still carries the other check that could not run', () => {
  const result = evaluate({ checks: [{ ...evidence().checks[0], name: 'unit', exit: 1 },
    { ...evidence().checks[0], name: 'lint', id: 'lint', exit: null }] })
  assert.equal(result.status, 'failed')
  assert.deepEqual(exported('leadRepairInput')(result), {
    failed: [{ assertionId: 'unit', reason: 'Recorded evidence failed: unit' }], errored: ['lint'],
  })
})


test('a request for changes takes precedence over another reviewer hedging approval', () => {
  const result = evaluate({ reviews: [{ ...evidence().reviews[0], text: 'should work' },
    { ...evidence().reviews[0], id: 'review-2', verdict: 'request-changes', text: 'A defect remains.' }] })
  assert.equal(result.assertions[1].reason, 'Recorded evidence failed')
  assert.equal(result.checksCouldNotRun, false)
})


test('verified historical language is not a hedge', () => {
  for (const text of ['An earlier draft might have raced; I verified the fix.', 'The old branch seems to have differed; verified this revision.', 'I think the earlier report was mistaken; all checks verified.'])
    assert.equal(evaluate({ reviews: [{ ...evidence().reviews[0], text }] }).status, 'reviewed', text)
})

test('curly apostrophes and stray multiline backticks cannot hide a hedge', () => {
  for (const text of ['I didn’t run the check.', 'A stray ` marker.\nIt should work. Later ` marker.', '```incomplete fence\nIt should work.',
    'A mismatched `should work`` span.', 'A mismatched ``should work``` span.'])
    assert.equal(evaluate({ reviews: [{ ...evidence().reviews[0], text }] }).assertions[1].reason, 'hedged-approval', text)
  for (const text of ['An example: `should work`.', '```ts\n// should work\n```\nVerified the change.'])
    assert.equal(evaluate({ reviews: [{ ...evidence().reviews[0], text }] }).status, 'reviewed', text)
})

test('rerun observations use check names and keep assertion ids internal', () => {
  const result = evaluate({ checks: [{ ...evidence().checks[0], name: 'Unit tests', exit: null }] })
  const observation = exported('leadAcceptanceObservation')(result)
  assert.match(observation, /"Unit tests"/)
  assert.doesNotMatch(observation, /"unit"|"assertionId"/)
  const missing = evaluate({ checks: [] })
  const action = { kind: 'check', id: 'action', runId: 'run', name: 'Unit tests', command: 'node test' }
  assert.match(exported('leadAcceptanceObservation')(missing, [action]), /"Unit tests"/)
  assert.doesNotMatch(exported('leadAcceptanceObservation')(missing, [action]), /"unit"|"assertionId"/)
})

test('runner-only waiting excludes stale negative reviews and incomplete check verdicts', () => {
  assert.equal(evaluate({ checks: [] }).checksCouldNotRun, true)
  assert.equal(evaluate({ checks: [{ ...evidence().checks[0], exit: null }] }).checksCouldNotRun, true)
  assert.equal(evaluate({ checks: [{ ...evidence().checks[0], exit: 1, complete: false }] }).checksCouldNotRun, false)
  for (const patch of [{ observedAt: 0 }, { complete: false }]) {
    const result = evaluate({ checks: [], reviews: [{ ...evidence().reviews[0], verdict: 'request-changes', ...patch }] })
    assert.equal(result.status, 'unknown')
    assert.equal(result.checksCouldNotRun, false)
  }
})


test('a missing review is never runner trouble, while a check-only rejection waits for the check action', () => {
  assert.equal(evaluate({ checks: [], reviews: [] }).checksCouldNotRun, false)
  const reviews = [{ ...evidence().reviews[0], verdict: 'request-changes', text: 'Could not verify the required checks.' }]
  for (const checks of [[], [{ ...evidence().checks[0], name: 'Unit tests', exit: null }]]) {
    const result = evaluate({ checks, reviews })
    assert.equal(result.status, 'failed')
    assert.equal(result.checksCouldNotRun, true)
  }
  assert.equal(evaluate({ checks: [{ ...evidence().checks[0], exit: 1 }], reviews }).checksCouldNotRun, false)
  assert.equal(evaluate({ checks: [], reviews, findings: [{ id: 'blocker', revision: 'head-1', blocking: true, resolved: false }] }).checksCouldNotRun, false)
})

test('review hedges distinguish running checks from running into issues and ignore fenced examples', () => {
  for (const text of ['I did not run into issues. Verified all checks.', "I didn't run into issues. Verified all checks.",
    'An earlier draft probably raced. I verified this revision.', '~~~text\nprobably should work\n~~~\nVerified all checks.'])
    assert.equal(evaluate({ reviews: [{ ...evidence().reviews[0], text }] }).status, 'reviewed', text)
  for (const text of ["I didn't run the checks.", 'I did not run it.', 'Probably correct.',
    'An earlier draft probably raced. This should work.', '~~~incomplete\nshould work'])
    assert.equal(evaluate({ reviews: [{ ...evidence().reviews[0], text }] }).assertions[1].reason, 'hedged-approval', text)
})

test('a result says how to verify it from the commits its checks and review read, and says nothing without one', () => {
  const leadVerifyLine = exported('leadVerifyLine'), leadResultSummary = exported('leadResultSummary')
  const result = (status: 'passed' | 'failed', evidence: { kind: 'check' | 'review' | 'spend'; id: string; revision: string }[]) =>
    ({ assertionId: `a-${evidence[0]?.id ?? 'none'}`, status, revision: 1, contractRevision: 1, evidence, reason: null })
  const head = 'abcdef0123456789abcdef0123456789abcdef01'
  assert.equal(leadVerifyLine([result('passed', [{ kind: 'check', id: 'c1', revision: head }]), result('passed', [{ kind: 'review', id: 'r1', revision: head }])]),
    "How to verify: run the project's required checks at commit abcdef0. The review read the same commit.")
  // Checks alone say nothing about a review, and a review of another commit is named, never called the same.
  assert.equal(leadVerifyLine([result('passed', [{ kind: 'check', id: 'c1', revision: head }, { kind: 'check', id: 'c2', revision: '1234567890' }])]),
    "How to verify: run the project's required checks at commits abcdef0 and 1234567.")
  assert.equal(leadVerifyLine([result('passed', [{ kind: 'check', id: 'c1', revision: head }]), result('passed', [{ kind: 'review', id: 'r1', revision: '1234567890' }])]),
    "How to verify: run the project's required checks at commit abcdef0. The review read commit 1234567.")
  assert.equal(leadVerifyLine([result('passed', [{ kind: 'review', id: 'r1', revision: head }])]), 'How to verify: the review read commit abcdef0.')
  // Spend and opaque revisions name no commit.
  assert.equal(leadVerifyLine([result('passed', [{ kind: 'spend', id: 's', revision: head }, { kind: 'check', id: 'c', revision: 'r-7' }])]), null)
  assert.equal(leadResultSummary('Ready.', []), 'Ready.')
  assert.equal(leadResultSummary('Ready.', [result('passed', [{ kind: 'check', id: 'c1', revision: head }])]),
    "Ready.\nHow to verify: run the project's required checks at commit abcdef0.")
})
