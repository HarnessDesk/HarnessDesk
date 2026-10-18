import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as lead from '../src/index.js'
import { initialLeadState, parseLeadJournalRecord, reduceLeadRecord, replayLeadJournal, summarizeLeadArguments } from '../src/index.js'

test('state replay rejects a result without its durable attempt, decision and dispatch', () => {
  const replay = (lead as Record<string, unknown>).replayLeadJournal
  assert.equal(typeof replay, 'function', 'journal replay must validate transition order')
  assert.throws(() => (replay as (records: unknown[]) => unknown)([
    { version: 1, seq: 1, type: 'result', id: 'attempt-1', outcome: 'succeeded', identity: null },
  ]))
})

const contract = { version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Repair check',
  project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
  steps: ['first', 'second'].map(id => ({ id, title: id, flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {},
    attendance: 'attended', assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] })),
  assertions: [{ id: 'check', kind: 'check', description: 'Checks pass' }], caps: { usdMicros: 500, rounds: 3 } }
const prefix = () => [
  { type: 'policy', policy: { version: 1, revision: 1, mode: 'manage', rules: [] } },
  { type: 'card', card: { version: 1, id: 'plan-1', revision: 1, type: 'plan', contractDigest: contract.digest, contract } },
  { type: 'card-decision', decision: { version: 1, cardId: 'plan-1', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, expiresAt: 200 },
]
const started = (stepId = 'first') => [...prefix(),
  { type: 'attempt', id: 'attempt-1', correlationId: 'attempt-1', method: 'flow/start-goal', action: null,
    arguments: summarizeLeadArguments({}), kind: 'mutation', stepId, policyRevision: 1, projectPolicyRevision: null, contractRevision: 1 },
  { type: 'decision', id: 'attempt-1', effect: 'allow', reason: 'policy', rule: null },
  { type: 'dispatch-start', id: 'attempt-1', dispatched: true },
]
const records = (events: unknown[]) => events.map((event, i) => parseLeadJournalRecord({ version: 1, seq: i + 1, ...(event as object) }))

test('recovery cannot clear an explicit durable stop', () => {
  const history = records([...started(), { type: 'result', id: 'attempt-1', outcome: 'uncertain', identity: null }, { type: 'stop' },
    { type: 'reconciliation', id: 'attempt-1', count: 1, evidence: JSON.stringify([{ correlationId: 'attempt-1', runId: 'run-1', teamId: 'team-1', firstRoundId: '1', terminal: false }]), identity: { correlationId: 'attempt-1', runId: 'run-1', teamId: 'team-1' } }])
  const state = replayLeadJournal(history)
  assert.equal(state.steps[0]!.state, 'started')
  assert.equal(state.phase, 'stopped')
})

test('replay preserves its input and refuses gaps, stale cards, out-of-order starts and relabeled mutations', () => {
  const history = records(started()), before = JSON.stringify(history)
  const state = replayLeadJournal(history)
  assert.equal(state.steps[0]!.state, 'admitted')
  assert.equal(JSON.stringify(history), before)
  const previous = initialLeadState()
  assert.throws(() => reduceLeadRecord(previous, { ...history[0], seq: 2 }))
  assert.equal(previous.seq, 0)
  assert.throws(() => replayLeadJournal(records(started('second'))))
  const stale = prefix(); (stale[2] as any).decision.expectedRevision = 0
  assert.throws(() => replayLeadJournal(records(stale)))
  const relabeled = started(); (relabeled[3] as any).kind = 'read'
  assert.throws(() => replayLeadJournal(records(relabeled)))
  assert.throws(() => parseLeadJournalRecord({ version: 2, seq: 1, type: 'stop' }))
  assert.throws(() => parseLeadJournalRecord({ version: 1, seq: 1, type: 'stop', hidden: true }))
})

test('journal records bound card bytes and refuse credentials in domain data', () => {
  const card = { version: 1, id: 'plan-1', revision: 1, type: 'plan', contractDigest: contract.digest, contract }
  const variables = Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`input-${n}`, 'x'.repeat(16_384)]))
  const oversized = { ...card, contract: { ...contract, steps: [{ ...contract.steps[0], variables }] } }
  assert.throws(() => parseLeadJournalRecord({ version: 1, seq: 1, type: 'card', card: oversized }))
  assert.throws(() => lead.prepareLeadJournalRecord({ version: 1, seq: 1, type: 'card', card: { ...card, contract: { ...contract, goal: 'sk-ant-' + 'synthetic-secret-123456789' } } }))
})

test('checkpoints round trip reduced state and refuse malformed snapshots', () => {
  const state = replayLeadJournal(records(started()))
  const checkpoint = lead.leadCheckpoint(state, 'b'.repeat(64))
  assert.deepEqual(lead.parseLeadCheckpoint(JSON.parse(JSON.stringify(checkpoint))).state, state)
  for (const change of [
    (item: any) => { item.extra = true },
    (item: any) => { item.state.seq++ },
    (item: any) => { item.state.cardRevisions['plan-1'] = 33 },
    (item: any) => { item.state.attempts[0][1].phase = 'unrecognized' },
    (item: any) => { item.state.steps[0].state = 'completed' },
    (item: any) => { item.state.attempts[0][1].evidenceSeq = 1 },
  ]) {
    const malformed = structuredClone(checkpoint)
    change(malformed)
    assert.throws(() => lead.parseLeadCheckpoint(malformed))
  }
})

test('pending plan blocks every mutation dispatch in replay except stop and abandon', () => {
  for (const [method, action] of [['workspace/open', null], ['flow/execution/stop', null], ['team/intent', 'abandon']] as const) {
    const history = records([...prefix(),
      { type: 'card', card: { version: 1, id: 'plan-1', revision: 2, type: 'plan', contractDigest: contract.digest, contract: { ...contract, revision: 2 } } },
      { type: 'attempt', id: 'attempt-1', correlationId: 'attempt-1', method, action, arguments: summarizeLeadArguments({}), kind: 'mutation',
        stepId: null, policyRevision: 1, projectPolicyRevision: null, contractRevision: 1 },
      { type: 'decision', id: 'attempt-1', effect: 'allow', reason: 'policy', rule: null },
      { type: 'dispatch-start', id: 'attempt-1', dispatched: true },
    ])
    if (method === 'workspace/open') assert.throws(() => replayLeadJournal(history))
    else assert.doesNotThrow(() => replayLeadJournal(history))
  }
})

for (const transition of ['reconciliation', 'start-resolution']) {
  test(`${transition} preserves an explicit person wait`, () => {
    const identity = { correlationId: 'attempt-1', runId: 'run-1', teamId: 'team-1' }
    const uncertain = [...started(), { type: 'result', id: 'attempt-1', outcome: 'uncertain', identity: null }]
    const reconciliation = { type: 'reconciliation', id: 'attempt-1', count: 1,
      evidence: JSON.stringify([{ ...identity, firstRoundId: '1', terminal: false }]), identity }
    // No budget is needed for automatic reconciliation; window resolution uses
    // the no-run path to test its phase transition without inventing accounting.
    const events: any[] = transition === 'reconciliation' ? [...uncertain,
      { type: 'management', phase: 'waiting-for-user', reason: 'lead-request-cancelled' }, reconciliation] : [...uncertain,
      { ...reconciliation, count: 0, evidence: '[]', identity: null },
      { type: 'management', phase: 'waiting-for-user', reason: 'lead-request-cancelled' },
      { type: 'start-resolution', id: 'attempt-1', identity: null, goalId: null, evidenceSeq: uncertain.length + 1 }]
    const state = replayLeadJournal(records(events))
    assert.equal(state.phase, 'waiting-for-user')
    assert.equal(state.managementReason, 'lead-request-cancelled')
  })
}

test('every transition out of a person wait clears its management reason', () => {
  const state = replayLeadJournal(records([...prefix(), { type: 'management', phase: 'waiting-for-user', reason: 'lead-request-cancelled' }, { type: 'stop' }]))
  assert.equal(state.phase, 'stopped')
  assert.equal(state.managementReason, null)
})

test('restore-result refuses a card for a different contract digest', () => {
  const state = replayLeadJournal(records(prefix()))
  const card = { version: 1, id: 'result', revision: 1, type: 'result', contractDigest: 'b'.repeat(64), outcome: 'reviewed', summary: 'Reviewed', assertions: [], budget: { version: 1, revision: 1, caps: contract.caps, leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known', stop: null } }
  // A reducer input models a retained historical card from an older contract.
  const previous: any = { ...state, cards: [...state.cards, card], decidedCards: ['result:1'] }
  assert.throws(() => reduceLeadRecord(previous, { version: 1, seq: state.seq + 1, type: 'restore-result', id: 'result', revision: 1 }))
})

for (const phase of ['stopped', 'accepted', 'declined'] as const) {
  test(`restore-result refuses terminal phase ${phase}`, () => {
    const state = replayLeadJournal(records(prefix()))
    const card: any = { version: 1, id: 'result', revision: 1, type: 'result', contractDigest: contract.digest, outcome: 'reviewed', summary: 'Reviewed', assertions: [], budget: { version: 1, revision: 1, caps: contract.caps, leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known', stop: null } }
    const previous = { ...state, phase, cards: [...state.cards, card], decidedCards: ['result:1'] }
    assert.throws(() => reduceLeadRecord(previous, { version: 1, seq: state.seq + 1, type: 'restore-result', id: 'result', revision: 1 }))
  })
}

test('record parser refuses an unknown management reason', () => {
  assert.throws(() => parseLeadJournalRecord({ version: 1, seq: 1, type: 'management', phase: 'waiting-for-user', reason: 'lead-invented-reason' }))
})

test('checkpoint refuses an unknown management reason', () => {
  const state = replayLeadJournal(records([...prefix(), { type: 'management', phase: 'waiting-for-user', reason: 'lead-request-cancelled' }]))
  const checkpoint: any = lead.leadCheckpoint(state, 'b'.repeat(64))
  checkpoint.state.managementReason = 'lead-invented-reason'
  assert.throws(() => lead.parseLeadCheckpoint(checkpoint))
})

test('pending-plan derivation cannot override an explicit person wait during reconciliation', () => {
  const identity = { correlationId: 'attempt-1', runId: 'run-1', teamId: 'team-1' }
  const revised = { ...contract, revision: 2, digest: 'b'.repeat(64) }
  const events = [...started(), { type: 'result', id: 'attempt-1', outcome: 'uncertain', identity: null },
    { type: 'card', card: { version: 1, id: 'plan-1', revision: 2, type: 'plan', contractDigest: revised.digest, contract: revised } },
    { type: 'management', phase: 'waiting-for-user', reason: 'lead-request-cancelled' },
    { type: 'reconciliation', id: 'attempt-1', count: 1, evidence: JSON.stringify([{ ...identity, firstRoundId: '1', terminal: false }]), identity }]
  const state = replayLeadJournal(records(events))
  assert.equal(state.phase, 'waiting-for-user')
  assert.equal(state.managementReason, 'lead-request-cancelled')
})
