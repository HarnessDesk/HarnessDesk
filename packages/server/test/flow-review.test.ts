import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import type { EvidenceRecord, EvidenceView, ReviewInput } from '@harnessdesk/protocol'

import { FlowReview, type ReviewAppendOutcome, type ReviewBinding, type ReviewSubjectPort } from '../src/flow-evidence.js'
import { factOf } from '../src/evidence/records.js'
import type { TeamCallScope } from '../src/team.js'

/*
 * `record_review` is bound to the caller's own claimed card and an observed
 * candidate this process minted — never a candidate or a Seat a caller
 * merely names. The port below stands in for the real Team/EvidencePlane
 * integration, exactly as the plan's proof needs call for: an in-process
 * gateway scope and a fake evidence ledger, not a real listener.
 */

class FakePort implements ReviewSubjectPort {
  readonly facts_ = new Map<string, EvidenceRecord[]>()
  bindings = new Map<string, ReviewBinding>()
  now_ = 1

  key(runtime: string | undefined, sessionId: string | undefined): string {
    return `${runtime ?? ''}\u0000${sessionId ?? ''}`
  }

  async bindingFor(intent: number, scope: TeamCallScope): Promise<ReviewBinding | null> {
    return this.bindings.get(`${intent}\u0000${this.key(scope.runtime, scope.sessionId)}`) ?? null
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
    subjects: [{ card: 1, round: 2, checkout: { cwd: '/repo', branch: 'work' }, at: 'sha-a' }],
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
  assert.equal(record.fact.kind === 'review' ? record.fact.at : null, 'sha-a')
})

test('record_review refuses a candidate whose head moved since it was offered', async () => {
  const port = new FakePort()
  const scope = scopeOf('alpha', 's1')
  const binding: ReviewBinding = {
    goal: 'goal-1', seat: 'seat-reviewer', answers: ['approve'], round: 1,
    subjects: [{ card: 1, round: 1, checkout: { cwd: '/repo', branch: 'work' }, at: 'sha-a' }],
  }
  port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, binding)
  const review = new FlowReview(port)
  const [candidate] = await review.candidates(3, scope)

  // HEAD moved between the read and the record: the binding now offers a different revision.
  port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, { ...binding, subjects: [{ ...binding.subjects[0]!, at: 'sha-b' }] })
  await assert.rejects(
    () => review.record({ intent: 3, candidate: candidate!.id, verdict: 'approve' }, scope),
    /moved on/,
  )
})

test('a verdict outside the Agent’s declared answers is refused', async () => {
  const port = new FakePort()
  const scope = scopeOf('alpha', 's1')
  port.bindings.set(`3\u0000${port.key('alpha', 's1')}`, {
    goal: 'goal-1', seat: 'seat-reviewer', answers: ['approve', 'request-changes'], round: 1,
    subjects: [{ card: 1, round: 1, checkout: { cwd: '/repo', branch: 'work' }, at: 'sha-a' }],
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
    subjects: [{ card: 1, round: 1, checkout: { cwd: '/repo', branch: 'work' }, at: 'sha-a' }],
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
  assert.equal(candidateAgain!.at, 'sha-a')
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

/*
 * #1029: `against` names revisions a review was judged against, and the
 * reader (`lineOf`'s `review` case in evidence/records.ts) has always
 * required every one of them to be a full commit SHA — a rule the writer
 * used to ignore, so a candidate UUID passed as `against` produced a line
 * the reader would skip forever. `record` now refuses at write time with the
 * reader's own predicate (`isSha`), before any candidate lookup, so a caller
 * that would have corrupted the ledger gets a plain refusal instead.
 */

const reviewRig = async (): Promise<{ readonly port: FakePort; readonly review: FlowReview; readonly scope: TeamCallScope; readonly candidateId: string }> => {
  const port = new FakePort()
  const scope = scopeOf('alpha', 's1')
  const binding: ReviewBinding = {
    goal: 'goal-1', seat: 'seat-reviewer', answers: ['approve'], round: 1,
    subjects: [{ card: 1, round: 1, checkout: { cwd: '/repo', branch: 'work' }, at: 'sha-a' }],
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
    /against\[0\] must be a full commit id, 40 hex characters; got a value that is not one\.$/,
  )
})

test('a full 40-hex commit id in `against` is accepted and recorded', async () => {
  const { review, scope, candidateId } = await reviewRig()
  const sha = 'b'.repeat(40)
  const record = await review.record({ intent: 3, candidate: candidateId, verdict: 'approve', against: [sha] }, scope)
  assert.equal(record.fact.kind, 'review')
  assert.deepEqual(record.fact.kind === 'review' ? record.fact.against : null, [sha])
})

test('an abbreviated SHA in `against` is refused, the same as the reader refuses it', async () => {
  const { review, scope, candidateId } = await reviewRig()
  const short = 'b'.repeat(12)
  await assert.rejects(
    () => review.record({ intent: 3, candidate: candidateId, verdict: 'approve', against: [short] }, scope),
    /against\[0\] must be a full commit id, 40 hex characters/,
  )
})

test('a second, later entry names its own position when the first is fine', async () => {
  const { review, scope, candidateId } = await reviewRig()
  const sha = 'c'.repeat(40)
  await assert.rejects(
    () => review.record({ intent: 3, candidate: candidateId, verdict: 'approve', against: [sha, 'not-a-revision'] }, scope),
    /against\[1\] must be a full commit id, 40 hex characters/,
  )
})

test('the write refusal and the reader’s skip agree: what one refuses, the other would never read back', async () => {
  const samples: readonly string[] = [
    'd'.repeat(40), // a full SHA-1
    'd'.repeat(64), // a full SHA-256
    randomUUID(), // a candidate id, exactly the shape #1029 reported
    'd'.repeat(12), // an abbreviated SHA
    'D'.repeat(40), // upper case is not how git prints one
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
    // rig's fixture ('sha-a'), not a real revision.
    const wouldRead = factOf({ kind: 'review', verdict: 'approve', by: 'seat-reviewer', at: 'e'.repeat(40), against: [sample] }) !== null
    assert.equal(refused, !wouldRead, `sample ${JSON.stringify(sample)}: writer and reader disagreed`)
    if (record) assert.equal(record.fact.kind === 'review' ? record.fact.against?.[0] : null, sample)
  }
})
