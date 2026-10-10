import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import type { EvidenceRecord, EvidenceView, ReviewInput } from '@harnessdesk/protocol'

import { FlowReview, PERSON_REVIEWER_ID, type ReviewAppendOutcome, type ReviewBinding, type ReviewSubjectPort } from '../src/flow-evidence.js'
import { evidenceRecordOf, factOf } from '../src/evidence/records.js'
import type { TeamCallScope } from '../src/team.js'

/*
 * `record_review` is bound to the caller's own claimed card and an observed
 * candidate this process minted — never a candidate or a Seat a caller
 * merely names. The port below stands in for the real Team/EvidencePlane
 * integration, exactly as the plan's proof needs call for: an in-process
 * gateway scope and a fake evidence ledger, not a real listener.
 */

// Real-looking revisions: `record` now runs the whole finished record through the
// reader's own `evidenceRecordOf` before it is ever appended (#1029), so a fixture
// `at` has to be one the reader would actually accept, not a placeholder string.
const SHA_A = 'a'.repeat(40)
const SHA_B = 'f'.repeat(40)

class FakePort implements ReviewSubjectPort {
  readonly facts_ = new Map<string, EvidenceRecord[]>()
  bindings = new Map<string, ReviewBinding>()
  personBindings = new Map<string, ReviewBinding>()
  now_ = 1

  key(runtime: string | undefined, sessionId: string | undefined): string {
    return `${runtime ?? ''}\u0000${sessionId ?? ''}`
  }

  async bindingFor(intent: number, scope: TeamCallScope): Promise<ReviewBinding | null> {
    return this.bindings.get(`${intent}\u0000${this.key(scope.runtime, scope.sessionId)}`) ?? null
  }

  async personBindingFor(run: string, card: number): Promise<ReviewBinding | null> {
    return this.personBindings.get(`${run}\u0000${card}`) ?? null
  }

  async facts(goal: string): Promise<readonly EvidenceView[]> {
    return (this.facts_.get(goal) ?? []).map((record) => ({ record, freshness: { state: 'fresh' as const }, by: null }))
  }

  async append(goal: string, record: EvidenceRecord): Promise<ReviewAppendOutcome> {
    const list = this.facts_.get(goal) ?? []
    const existing = list.filter(
      (one) =>
        one.fact.kind === 'review' &&
        record.fact.kind === 'review' &&
        one.fact.by === record.fact.by &&
        one.fact.at === record.fact.at &&
        one.card?.id === record.card?.id &&
        one.round === record.round,
    )
    const matching = existing.find((one) => one.fact.kind === 'review' && record.fact.kind === 'review' && one.fact.verdict === record.fact.verdict)
    if (matching) return { outcome: 'duplicate', record: matching }
    if (existing.length > 0) return { outcome: 'conflict' }
    this.facts_.set(goal, [...list, record])
    return { outcome: 'added', record }
  }

  now(): number {
    return this.now_
  }
}

const scopeOf = (runtime: string, sessionId: string): TeamCallScope => ({ runtime, sessionId })

test('record_review is bound to the caller and an observed candidate: claimant versus sibling', async () => {
  const port = new FakePort()
  const claimant = scopeOf('alpha', 's1')
  const sibling = scopeOf('alpha', 's2')
  const binding: ReviewBinding = {
    goal: 'goal-1', seat: 'seat-reviewer', answers: ['approve', 'request-changes'], round: 2,
    subjects: [{ card: 1, round: 2, checkout: { cwd: '/repo', branch: 'work' }, at: SHA_A }],
  }
  port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, binding)
  // The sibling holds no binding for this card at all — a different conversation, no claim.
  const review = new FlowReview(port)

  const candidates = await review.candidates(3, claimant)
  assert.equal(candidates.length, 1)
  const candidateId = candidates[0]!.id

  await assert.rejects(
    () => review.record({ intent: 3, candidate: candidateId, verdict: 'approve' }, sibling),
    /do not hold this card/,
    'a sibling conversation with no binding for this card cannot record against it',
  )

  // A forged candidate id — one this process never minted for this card — is refused too.
  await assert.rejects(
    () => review.record({ intent: 3, candidate: 'forged-id', verdict: 'approve' }, claimant),
    /no longer being offered/,
  )

  const record = await review.record({ intent: 3, candidate: candidateId, verdict: 'approve' }, claimant)
  assert.equal(record.fact.kind, 'review')
  assert.equal(record.fact.kind === 'review' ? record.fact.by : null, 'seat-reviewer')
  assert.equal(record.fact.kind === 'review' ? record.fact.at : null, SHA_A)
})

test('record_review refuses a candidate whose head moved since it was offered', async () => {
  const port = new FakePort()
  const scope = scopeOf('alpha', 's1')
  const binding: ReviewBinding = {
    goal: 'goal-1', seat: 'seat-reviewer', answers: ['approve'], round: 1,
    subjects: [{ card: 1, round: 1, checkout: { cwd: '/repo', branch: 'work' }, at: SHA_A }],
  }
  port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, binding)
  const review = new FlowReview(port)
  const [candidate] = await review.candidates(3, scope)

  // HEAD moved between the read and the record: the binding now offers a different revision.
  port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, { ...binding, subjects: [{ ...binding.subjects[0]!, at: SHA_B }] })
  await assert.rejects(
    () => review.record({ intent: 3, candidate: candidate!.id, verdict: 'approve' }, scope),
    /moved on/,
  )
})

for (const changed of ['branch', 'cwd'] as const) {
  test(`record_review refuses a candidate whose ${changed} changed at the same commit`, async () => {
    const port = new FakePort()
    const scope = scopeOf('alpha', 's1')
    const binding: ReviewBinding = {
      goal: 'goal-1', seat: 'seat-reviewer', answers: ['approve'], round: 1,
      subjects: [{ card: 1, round: 1, checkout: { cwd: '/repo', branch: 'work' }, at: SHA_A }],
    }
    port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, binding)
    const review = new FlowReview(port)
    const [candidate] = await review.candidates(3, scope)
    port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, {
      ...binding, subjects: [{ ...binding.subjects[0]!, checkout: { ...binding.subjects[0]!.checkout, [changed]: 'elsewhere' } }],
    })
    assert.equal(await review.held(candidate!.id, 3, scope), null, 'findings cannot retain the old checkout either')
    await assert.rejects(() => review.record({ intent: 3, candidate: candidate!.id, verdict: 'approve' }, scope), /moved on/)
    const [fresh] = await review.candidates(3, scope)
    const recorded = await review.record({ intent: 3, candidate: fresh!.id, verdict: 'approve' }, scope)
    assert.equal(recorded.checkout![changed], 'elsewhere')
  })
}

test('a verdict outside the Agent’s declared answers is refused', async () => {
  const port = new FakePort()
  const scope = scopeOf('alpha', 's1')
  port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, {
    goal: 'goal-1', seat: 'seat-reviewer', answers: ['approve', 'request-changes'], round: 1,
    subjects: [{ card: 1, round: 1, checkout: { cwd: '/repo', branch: 'work' }, at: SHA_A }],
  })
  const review = new FlowReview(port)
  const [candidate] = await review.candidates(3, scope)
  await assert.rejects(
    () => review.record({ intent: 3, candidate: candidate!.id, verdict: 'looks great' }, scope),
    /not an answer this step accepts/,
  )
})

test('duplicate verdict is idempotent through what is already durable; a conflicting second verdict refuses', async () => {
  const port = new FakePort()
  const scope = scopeOf('alpha', 's1')
  port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, {
    goal: 'goal-1', seat: 'seat-reviewer', answers: ['approve', 'request-changes'], round: 1,
    subjects: [{ card: 1, round: 1, checkout: { cwd: '/repo', branch: 'work' }, at: SHA_A }],
  })
  const review = new FlowReview(port)
  const [candidate] = await review.candidates(3, scope)
  const input: ReviewInput = { intent: 3, candidate: candidate!.id, verdict: 'approve' }

  const first = await review.record(input, scope)
  const second = await review.record(input, scope)
  assert.equal(second.id, first.id, 'a repeated identical call is a no-op, not a second record')
  assert.equal(port.facts_.get('goal-1')?.length, 1, 'exactly one line was ever appended')

  // Simulate a restart between the durable append and the run's own operation finishing: a fresh
  // FlowReview instance (no in-memory state) sees the same durable fact and stays idempotent.
  const afterRestart = new FlowReview(port)
  const [candidateAgain] = await afterRestart.candidates(3, scope)
  assert.equal(candidateAgain!.at, SHA_A)
  const third = await afterRestart.record({ intent: 3, candidate: candidateAgain!.id, verdict: 'approve' }, scope)
  assert.equal(third.id, first.id, 'idempotent through durable storage, not a process-local cache')

  // A different verdict for the same (round, card, seat, revision) is a genuine conflict.
  await assert.rejects(
    () => afterRestart.record({ intent: 3, candidate: candidateAgain!.id, verdict: 'request-changes' }, scope),
    /A different verdict is already recorded/,
  )
  assert.equal(port.facts_.get('goal-1')?.length, 1, 'the conflicting attempt never overwrote or duplicated the record')
})

test('candidates offered for a card with no binding are empty, and recording against it is refused', async () => {
  const port = new FakePort()
  const review = new FlowReview(port)
  const scope = scopeOf('alpha', 's1')
  assert.deepEqual(await review.candidates(9, scope), [])
  await assert.rejects(() => review.record({ intent: 9, candidate: 'anything', verdict: 'approve' }, scope), /do not hold this card/)
})

test('a person review records the stable person marker on a held candidate and refuses stale, unknown, and conflicting choices', async () => {
  const port = new FakePort()
  const binding: ReviewBinding = {
    goal: 'goal-1', seat: PERSON_REVIEWER_ID, answers: ['picked', 'rejected'], round: 4,
    subjects: [{ card: 7, round: 2, checkout: { cwd: '/repo/attempt', branch: 'attempt-one' }, at: SHA_A }],
  }
  port.personBindings.set('run-1\u00005', binding)
  port.facts_.set('goal-1', [{
    id: 'check-evidence', fact: { kind: 'check', name: 'verify', run: 'test -s attempt.txt', exit: 0, timedOut: false, at: SHA_A, dirty: false, tail: '' },
    card: { board: 'goal-1', id: 7 }, observedAt: 1, posted: null,
  }])
  const review = new FlowReview(port)
  const candidates = await review.personCandidates('run-1', 5)
  assert.equal(candidates.length, 1)
  assert.deepEqual(candidates[0], { ...candidates[0], card: 7, at: SHA_A, branch: 'attempt-one', evidence: ['check-evidence'] })

  port.personBindings.set('run-2\u00005', { ...binding, goal: 'goal-2' })
  await assert.rejects(() => review.recordPerson('run-2', 5, candidates[0]!.id, 'picked'), /no longer being offered/)
  await assert.rejects(() => review.recordPerson('run-1', 5, 'unknown', 'picked'), /no longer being offered/)
  await assert.rejects(() => review.recordPerson('run-1', 5, candidates[0]!.id, 'approve'), /not an answer this step accepts/)

  const record = await review.recordPerson('run-1', 5, candidates[0]!.id, 'picked')
  assert.equal(record.fact.kind, 'review')
  if (record.fact.kind === 'review') assert.equal(record.fact.by, PERSON_REVIEWER_ID)
  assert.equal(record.seat, null)
  assert.ok(evidenceRecordOf(JSON.parse(JSON.stringify(record))))
  await assert.rejects(
    () => review.recordPerson('run-1', 5, candidates[0]!.id, 'rejected'),
    /A different verdict is already recorded/,
    'the compare-and-swap path reports a second conflicting verdict without another append',
  )
  assert.equal(port.facts_.get('goal-1')?.length, 2)
})

for (const changed of ['branch', 'cwd'] as const) {
  test(`a person review refuses a candidate whose ${changed} changed at the same commit`, async () => {
    const port = new FakePort()
    const binding: ReviewBinding = {
      goal: 'goal-1', seat: PERSON_REVIEWER_ID, answers: ['picked'], round: 4,
      subjects: [{ card: 7, round: 2, checkout: { cwd: '/repo/attempt', branch: 'attempt-one' }, at: SHA_A }],
    }
    port.personBindings.set('run-1\u00005', binding)
    const review = new FlowReview(port)
    const [candidate] = await review.personCandidates('run-1', 5)
    port.personBindings.set('run-1\u00005', {
      ...binding, subjects: [{ ...binding.subjects[0]!, checkout: { ...binding.subjects[0]!.checkout, [changed]: 'elsewhere' } }],
    })
    await assert.rejects(() => review.recordPerson('run-1', 5, candidate!.id, 'picked'), /moved on/)
    assert.equal(port.facts_.get('goal-1')?.length ?? 0, 0)
  })
}

test('a person review candidate that moved after it was offered is refused with the agent-review wording', async () => {
  const port = new FakePort()
  port.personBindings.set('run-1\u00005', {
    goal: 'goal-1', seat: PERSON_REVIEWER_ID, answers: ['picked'], round: 4,
    subjects: [{ card: 7, round: 2, checkout: { cwd: '/repo/attempt', branch: 'attempt-one' }, at: SHA_A }],
  })
  const review = new FlowReview(port)
  const [candidate] = await review.personCandidates('run-1', 5)
  port.personBindings.set('run-1\u00005', {
    goal: 'goal-1', seat: PERSON_REVIEWER_ID, answers: ['picked'], round: 4,
    subjects: [{ card: 7, round: 2, checkout: { cwd: '/repo/attempt', branch: 'attempt-one' }, at: SHA_B }],
  })
  await assert.rejects(
    () => review.recordPerson('run-1', 5, candidate!.id, 'picked'),
    /That candidate has moved on\. Ask for review candidates again\./,
  )
  assert.equal(port.facts_.get('goal-1')?.length ?? 0, 0)
})

/*
 * #1029: `against` names revisions a review was judged against, and the
 * reader (`lineOf`'s `review` case in evidence/records.ts) has always
 * required every one of them to be a full commit id — a rule the writer used
 * to ignore, so a candidate UUID passed as `against` produced a line the
 * reader would skip forever. `record` now refuses at write time with the
 * reader's own predicate (`isSha`), before any candidate lookup, so a caller
 * that would have corrupted the ledger gets a plain refusal instead.
 */

const reviewRig = async (): Promise<{ readonly port: FakePort; readonly review: FlowReview; readonly scope: TeamCallScope; readonly candidateId: string }> => {
  const port = new FakePort()
  const scope = scopeOf('alpha', 's1')
  const binding: ReviewBinding = {
    goal: 'goal-1', seat: 'seat-reviewer', answers: ['approve'], round: 1,
    subjects: [{ card: 1, round: 1, checkout: { cwd: '/repo', branch: 'work' }, at: SHA_A }],
  }
  port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, binding)
  const review = new FlowReview(port)
  const [candidate] = await review.candidates(3, scope)
  return { port, review, scope, candidateId: candidate!.id }
}

test('a candidate id (a UUID) passed as `against` is refused at write time, naming its position', async () => {
  const { review, scope, candidateId } = await reviewRig()
  const uuid = randomUUID()
  await assert.rejects(
    () => review.record({ intent: 3, candidate: candidateId, verdict: 'approve', against: [uuid] }, scope),
    /against\[0\] must be a full commit id \(run `git rev-parse <rev>` to get one\); got a value that is not one\./,
  )
})

test('a full 40-hex commit id in `against` is accepted and recorded', async () => {
  const { review, scope, candidateId } = await reviewRig()
  const sha = 'b'.repeat(40)
  const record = await review.record({ intent: 3, candidate: candidateId, verdict: 'approve', against: [sha] }, scope)
  assert.equal(record.fact.kind, 'review')
  assert.deepEqual(record.fact.kind === 'review' ? record.fact.against : null, [sha])
})

test('a 64-character SHA-256 commit id in `against` is accepted — no fixed length is assumed', async () => {
  const { review, scope, candidateId } = await reviewRig()
  const sha256 = 'c'.repeat(64)
  const record = await review.record({ intent: 3, candidate: candidateId, verdict: 'approve', against: [sha256] }, scope)
  assert.deepEqual(record.fact.kind === 'review' ? record.fact.against : null, [sha256])
})

test('an upper-case full commit id in `against` is accepted and stored lower case, as git prints one', async () => {
  const { review, scope, candidateId } = await reviewRig()
  const upper = 'B'.repeat(40)
  const record = await review.record({ intent: 3, candidate: candidateId, verdict: 'approve', against: [upper] }, scope)
  assert.deepEqual(record.fact.kind === 'review' ? record.fact.against : null, [upper.toLowerCase()])
})

test('an abbreviated id in `against` — the kind `git log --oneline` prints — is refused, the same as the reader refuses it, and points at a way out', async () => {
  const { review, scope, candidateId } = await reviewRig()
  const short = 'b'.repeat(12)
  await assert.rejects(
    () => review.record({ intent: 3, candidate: candidateId, verdict: 'approve', against: [short] }, scope),
    /against\[0\] must be a full commit id \(run `git rev-parse <rev>` to get one\)/,
  )
})

test('a second, later entry names its own position when the first is fine', async () => {
  const { review, scope, candidateId } = await reviewRig()
  const sha = 'c'.repeat(40)
  await assert.rejects(
    () => review.record({ intent: 3, candidate: candidateId, verdict: 'approve', against: [sha, 'not-a-revision'] }, scope),
    /against\[1\] must be a full commit id \(run `git rev-parse <rev>` to get one\)/,
  )
})

test('the write refusal and the reader’s skip agree: what one refuses (once lower-cased, as the writer stores it), the other would never read back', async () => {
  const samples: readonly string[] = [
    'd'.repeat(40), // a full SHA-1
    'd'.repeat(64), // a full SHA-256
    randomUUID(), // a candidate id, exactly the shape #1029 reported
    'd'.repeat(12), // an abbreviated id
    'D'.repeat(40), // upper case: normalized before either side judges it
  ]
  for (const sample of samples) {
    // A fresh port and Seat per sample: idempotency would otherwise fold a second accepted call
    // into the first one's already-durable record, hiding whether this sample's own against was read.
    const { review, scope, candidateId } = await reviewRig()
    let record: EvidenceRecord | null = null
    let refused = false
    try {
      record = await review.record({ intent: 3, candidate: candidateId, verdict: 'approve', against: [sample] }, scope)
    } catch {
      refused = true
    }
    // Whatever the writer decided, the reader's own rule is asked to agree with it, on an otherwise
    // well-formed `review` fact — never the writer's own boolean, which could drift on its own. Only
    // `against` varies; a well-formed `at` here isolates that field, since `record`'s own `at` is this
    // rig's fixture. The writer stores the lower-cased form, so that is what the reader is asked about.
    const wouldRead = factOf({ kind: 'review', verdict: 'approve', by: 'seat-reviewer', at: 'e'.repeat(40), against: [sample.toLowerCase()] }) !== null
    assert.equal(refused, !wouldRead, `sample ${JSON.stringify(sample)}: writer and reader disagreed`)
    if (record) assert.equal(record.fact.kind === 'review' ? record.fact.against?.[0] : null, sample.toLowerCase())
  }
})

test('a field the reader would refuse, other than `against`, is caught by the same final check before anything is written', async () => {
  // `against` is refused by its own named check well before this point; this proves the net behind
  // it catches a different field too — here, a verdict over the reader's own text limit — with a
  // plain generic refusal, never the specific `against` sentence.
  const port = new FakePort()
  const scope = scopeOf('alpha', 's1')
  const tooLong = 'y'.repeat(4_097)
  port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, {
    goal: 'goal-1', seat: 'seat-reviewer', answers: [tooLong], round: 1,
    subjects: [{ card: 1, round: 1, checkout: { cwd: '/repo', branch: 'work' }, at: SHA_A }],
  })
  const review = new FlowReview(port)
  const [candidate] = await review.candidates(3, scope)
  await assert.rejects(
    () => review.record({ intent: 3, candidate: candidate!.id, verdict: tooLong }, scope),
    /This review could not be recorded in a form the ledger reads\.$/,
  )
  assert.equal(port.facts_.get('goal-1'), undefined, 'nothing was appended')
})
