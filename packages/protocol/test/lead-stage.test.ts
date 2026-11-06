import assert from 'node:assert/strict'
import test from 'node:test'
import { LEAD_MANAGEMENT_REASONS, LEAD_STAGE_TABLE, LEAD_WAIT_STAGES, isWaitingOnYou, leadStage, type LeadStageFacts } from '../src/index.js'

const booleans = [false, true]
const states = ['draft', 'planning', 'awaiting-plan', 'running', 'waiting-for-user', 'following', 'accepted', 'declined', 'stopped'] as const
const cards = [null, 'plan', 'permission-change', 'budget-change', 'branch-ownership', 'waiting'] as const
const base = { kind: 'lead', state: 'draft', pendingPersonCard: null, resultReady: false, workerApproval: false, checkToRun: false,
  waitReason: null, requestInFlight: false, chatEffectQueued: false } as const
const check = (facts: LeadStageFacts) => {
  const rows = LEAD_STAGE_TABLE.filter(row => row.kind === facts.kind && row.when(facts))
  assert.ok(rows.length > 0)
  const reading = leadStage(facts)
  assert.deepEqual(reading, { stage: rows[0]!.stage, reason: rows[0]!.reason })
  assert.ok(reading.reason.length > 0)
  assert.ok(['you-answer', 'you-review', 'you-blocked', 'working', 'queued', 'idle'].includes(reading.stage))
}

test('the closed first-match table covers every boolean and enum combination', () => {
  for (const state of states) for (const pendingPersonCard of cards) for (const waitReason of [null, ...LEAD_MANAGEMENT_REASONS])
    for (const resultReady of booleans) for (const workerApproval of booleans) for (const checkToRun of booleans)
      for (const requestInFlight of booleans) for (const chatEffectQueued of booleans)
        check({ kind: 'lead', state, pendingPersonCard, waitReason, resultReady, workerApproval, checkToRun, requestInFlight, chatEffectQueued })
  for (const archived of booleans) for (const waiting of booleans) for (const failed of booleans) for (const queuePaused of booleans) for (const running of booleans) for (const queued of booleans)
    check({ kind: 'session', archived, waiting, failed, queuePaused, running, queued })
  for (const status of ['needs-you', 'ready', 'stopped', 'working', 'done'] as const) for (const prepared of booleans)
    check({ kind: 'team', status, prepared })
  for (const kind of ['lead', 'session', 'team']) assert.ok(LEAD_STAGE_TABLE.filter(row => row.kind === kind).at(-1)!.when({ kind } as LeadStageFacts))
})

test('person cards, reviewed results and actions take precedence over activity', () => {
  assert.deepEqual(leadStage({ ...base, pendingPersonCard: 'plan', requestInFlight: true }), { stage: 'you-answer', reason: 'card-plan' })
  assert.equal(leadStage({ ...base, resultReady: true, workerApproval: true, state: 'running' }).stage, 'you-review')
  assert.deepEqual(leadStage({ ...base, workerApproval: true, checkToRun: true }), { stage: 'you-answer', reason: 'worker-approval' })
  assert.equal(leadStage({ ...base, waitReason: 'lead-request-failed', requestInFlight: true }).stage, 'you-blocked')
  assert.equal(leadStage({ ...base, chatEffectQueued: true }).stage, 'queued')
  assert.equal(leadStage({ ...base, state: 'running', chatEffectQueued: true }).stage, 'working')
  assert.equal(leadStage({ kind: 'session', archived: true, waiting: true, failed: true, queuePaused: true, running: true, queued: true }).stage, 'idle')
  assert.equal(leadStage({ kind: 'team', status: 'working', prepared: true }).stage, 'queued')
})

test('every management reason is explicitly classified and only you stages wait on the person', () => {
  assert.deepEqual(Object.keys(LEAD_WAIT_STAGES).sort(), [...LEAD_MANAGEMENT_REASONS].sort())
  for (const waitReason of LEAD_MANAGEMENT_REASONS) assert.equal(leadStage({ ...base, waitReason }).stage, LEAD_WAIT_STAGES[waitReason])
  for (const stage of ['you-answer', 'you-review', 'you-blocked', 'working', 'queued', 'idle'] as const)
    assert.equal(isWaitingOnYou(stage), stage.startsWith('you-'))
})
