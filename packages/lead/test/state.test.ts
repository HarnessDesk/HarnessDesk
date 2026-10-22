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

test('a checkpoint defaults only absent name state and rejects a null name', () => {
  const state = lead.initialLeadState()
  const changed = lead.reduceLeadRecord(state, { version: 1, seq: 1, type: 'settings-changed', name: 'lex' })
  const checkpoint = lead.leadCheckpoint(changed, '0'.repeat(64))
  const legacy = JSON.parse(JSON.stringify(checkpoint)); delete legacy.state.name; delete legacy.state.decisionMessages
  assert.equal(lead.parseLeadCheckpoint(legacy).state.name, 'dex')
  const malformed = JSON.parse(JSON.stringify(checkpoint)); malformed.state.name = null
  assert.throws(() => lead.parseLeadCheckpoint(malformed))
})

const decidedHistory = (count: number) => {
  const events: unknown[] = [...prefix()]
  for (let i = 0; i < count; i++) {
    const policy = { version: 1, revision: i + 2, mode: 'manage', rules: [] }
    events.push({ type: 'card', card: { version: 1, id: `settings-${i}`, revision: 1, type: 'permission-change', contractDigest: contract.digest, previous: { ...policy, revision: i + 1 }, proposed: policy } },
      { type: 'card-decision', decision: { version: 1, cardId: `settings-${i}`, cardType: 'permission-change', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, expiresAt: null })
  }
  return records(events)
}
test('decided history retains exactly the newest 64 entries on reduction and journal replay', () => {
  const history = decidedHistory(70), state = replayLeadJournal(history)
  assert.equal(state.decisionMessages.length, 64)
  assert.deepEqual(state.decisionMessages.map(message => message.card.id), Array.from({ length: 64 }, (_, i) => `settings-${i + 6}`))
  const live = history.reduce(reduceLeadRecord, initialLeadState())
  assert.deepEqual(live.decisionMessages, state.decisionMessages)
  assert.deepEqual(lead.parseLeadCheckpoint(lead.leadCheckpoint(state, '0'.repeat(64))).state.decisionMessages, state.decisionMessages)
})
test('same-card decision replaces its history once at its original journal position', () => {
  const history = records([...prefix(), { type: 'card', card: { version: 1, id: 'plan-1', revision: 2, type: 'plan', contractDigest: contract.digest, contract: { ...contract, revision: 2 } } },
    { type: 'card-decision', decision: { version: 1, cardId: 'plan-1', cardType: 'plan', expectedRevision: 2, contractDigest: contract.digest, choice: 'approve' }, expiresAt: 300 }])
  const state = replayLeadJournal(history)
  assert.equal(state.decisionMessages.length, 1); assert.equal(state.decisionMessages[0]!.position, 2); assert.equal(state.decisionMessages[0]!.card.revision, 2)
})
test('decided history trims to 128 KiB on journal replay and drops one oversized entry', () => {
  // Each card fits the journal limit; the retained history as a whole does not.
  const history = decidedHistory(30).map(record => record.type === 'card' && record.card.type === 'permission-change' ? { ...record, card: { ...record.card,
    previous: { ...record.card.previous, rules: record.card.previous.revision === 1 ? [] : Array.from({ length: 32 }, (_, n) => ({ id: `rule-${n}`, effect: 'ask', method: 'flow/start-goal', action: null, project: '/workspace/' + 'x'.repeat(240) })) },
    proposed: { ...record.card.proposed, rules: Array.from({ length: 32 }, (_, n) => ({ id: `rule-${n}`, effect: 'ask', method: 'flow/start-goal', action: null, project: '/workspace/' + 'x'.repeat(240) })) } } } : record)
  const parsed = history.map(parseLeadJournalRecord), state = replayLeadJournal(parsed)
  assert.ok(state.decisionMessages.length < 31)
  assert.ok(new TextEncoder().encode(JSON.stringify(state.decisionMessages)).length <= 131072)
  const before = replayLeadJournal(records(prefix().slice(0, 2)))
  const giant = { ...before.cards[0]!, contract: { ...contract, steps: [{ ...contract.steps[0]!, variables: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`input-${i}`, 'x'.repeat(16384)])) }] } }
  const previous = { ...before, cards: [giant] } as typeof before
  const decision = records(prefix())[2]!
  assert.deepEqual(reduceLeadRecord(previous, decision).decisionMessages, [])
})
test('checkpoint rejects over 64 decisions, positions beyond seq, and extra decision keys', () => {
  const state = replayLeadJournal(decidedHistory(1)), checkpoint = lead.leadCheckpoint(state, '0'.repeat(64))
  for (const change of [(item: any) => { item.state.decisionMessages = Array.from({ length: 65 }, () => item.state.decisionMessages[0]) },
    (item: any) => { item.state.decisionMessages[0].position = item.state.seq + 1 }, (item: any) => { item.state.decisionMessages[0].extra = true }]) {
    const malformed = structuredClone(checkpoint); change(malformed); assert.throws(() => lead.parseLeadCheckpoint(malformed))
  }
})


test('canBeginLeadGoal shares every recovery and accounting fence with new-goal replay', async () => {
  const ready = (lead as unknown as { canBeginLeadGoal: (state: lead.LeadState) => boolean }).canBeginLeadGoal
  assert.equal(typeof ready, 'function')
  const journal = await lead.createLeadJournal({ async read() { return [] }, async append() {} })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'old', caps: { usdMicros: 100, rounds: 2 }, freshnessMs: 1000 })
  await journal.stop(async () => {})
  const state = journal.state, event = { version: 1 as const, seq: state.seq + 1, type: 'new-goal' as const, now: 100, id: 'new' }
  assert.equal(ready(state), true); assert.equal(lead.reduceLeadRecord(state, event).phase, 'draft')
  // Every finished goal leads to the next one, whatever ended it: an accepted or declined result, or an allowance stop.
  for (const finished of [{ ...state, phase: 'accepted' as const }, { ...state, phase: 'declined' as const },
    { ...state, budget: { ...state.budget!, stop: { reason: 'budget' as const, revision: state.budget!.revision } } },
    { ...state, budget: { ...state.budget!, stop: { reason: 'unknown-spend' as const, revision: state.budget!.revision } } }]) {
    assert.equal(ready(finished), true); assert.equal(lead.reduceLeadRecord(finished, event).phase, 'draft')
  }
  const attempt = { id: 'uncertain', correlationId: 'uncertain', method: 'flow/start-goal', action: null, kind: 'mutation' as const, stepId: 'first', arguments: summarizeLeadArguments({}),
    phase: 'finished' as const, effect: 'allow' as const, dispatched: true, outcome: 'uncertain' as const, recoveryReported: false,
    evidence: null, evidenceSeq: null, resolutionPending: false, contested: false }
  for (const blocked of [
    { ...state, recoveryBlocked: true }, { ...state, stopEffectsPending: state.seq }, { ...state, phase: 'running' as const },
    { ...state, completedBudgets: Array.from({ length: 64 }, () => state.budget!) },
    { ...state, attempts: new Map([[attempt.id, attempt]]) },
    { ...state, attempts: new Map([[attempt.id, { ...attempt, outcome: 'interrupted' } as lead.LeadAttemptState]]) },
    { ...state, attempts: new Map([[attempt.id, { ...attempt, recoveryReported: true, resolutionPending: true } as lead.LeadAttemptState]]) },
    { ...state, attempts: new Map([[attempt.id, { ...attempt, recoveryReported: true, contested: true } as lead.LeadAttemptState]]) },
  ]) {
    assert.equal(ready(blocked), false)
    assert.throws(() => lead.reduceLeadRecord(blocked, event), /lead-journal-transition/)
  }
})
