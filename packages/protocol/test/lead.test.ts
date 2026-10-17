import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as protocol from '../src/index.js'

// Look up the boundary parsers so the red run reports the missing contract.
const validator = (name: string): ((value: unknown) => unknown) => {
  const parse = (protocol as Record<string, unknown>)[name]
  assert.equal(typeof parse, 'function', `${name} must be exported`)
  return parse as (value: unknown) => unknown
}
const digest = 'a'.repeat(64)
const caps = { usdMicros: 5_000_000, rounds: 3 }
const policy = { version: 1, revision: 0, mode: 'default', rules: [] }
const contract = {
  version: 1, revision: 1, digest, goal: 'Repair the failing check',
  project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 0,
  steps: [{ id: 'implement', title: 'Implement and review', flow: 'lead-reviewed-result', sourceRevision: 'source-1',
    variables: { task: 'Repair the check' }, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'builder', seat: 'worker-1', ceiling: 'edit' }] }],
  assertions: [{ id: 'tests', kind: 'check', description: 'Required checks pass' }], caps,
}
const budget = { version: 1, revision: 1, caps, leadUsdMicros: 20, workerUsdMicros: 50,
  reservedUsdMicros: 100, roundsAdmitted: 1, spend: 'known', stop: null }
const result = { assertionId: 'tests', status: 'unknown', revision: 2, contractRevision: 1,
  evidence: [{ kind: 'check', id: 'check-1', revision: 'source-1' }], reason: 'Check still running' }
const base = { version: 1, id: 'card-1', revision: 1, contractDigest: digest }
const cards = [
  { ...base, type: 'plan', contract },
  { ...base, type: 'permission-change', previous: policy, proposed: { ...policy, revision: 1, mode: 'manage' } },
  { ...base, type: 'waiting', kind: 'person', runId: 'run-1', personCardId: 'person-1', summary: 'Review the result', assertions: [result] },
  { ...base, type: 'result', outcome: 'reviewed', summary: 'Ready for acceptance', assertions: [result], budget },
  { ...base, type: 'stopped', reason: 'budget', summary: 'Reported spend reached the cap', budget },
]

test('Lead caps reject non-finite, fractional, unsafe and out-of-range values', () => {
  const parse = validator('parseLeadCaps')
  assert.deepEqual(parse(caps), caps)
  assert.deepEqual(parse({ usdMicros: 0, rounds: 1 }), { usdMicros: 0, rounds: 1 })
  for (const usdMicros of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '5'])
    assert.throws(() => parse({ ...caps, usdMicros }), protocol.ValidationError)
  for (const rounds of [NaN, Infinity, -1, 0, 1.5, 101, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => parse({ ...caps, rounds }), protocol.ValidationError)
})

test('Lead card decisions require a version, current revision and contract digest', () => {
  const parse = validator('parseLeadCardDecision')
  const decision = { version: 1, cardId: 'card-1', expectedRevision: 1, contractDigest: digest, choice: 'approve' }
  assert.deepEqual(parse(decision), decision)
  for (const patch of [{ version: undefined }, { version: 2 }, { expectedRevision: -1 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { cardId: '' }, { contractDigest: '' },
    { contractDigest: 'not-a-digest' }, { choice: 'run' }, { apiKey: 'synthetic-secret' }])
    assert.throws(() => parse({ ...decision, ...patch }), protocol.ValidationError)
})

test('Lead acceptance contracts bind the ordered work, project, evidence and caps', () => {
  const parse = validator('parseLeadAcceptanceContract')
  assert.deepEqual(parse(contract), contract)
  for (const patch of [{ version: 2 }, { revision: Infinity }, { goal: '' }, { goal: 'x'.repeat(16_385) },
    { steps: [] }, { steps: Array(65).fill(contract.steps[0]) }, { assertions: Array(129).fill(contract.assertions[0]) },
    { project: { id: 'project-demo', path: '' } }, { caps: { ...caps, rounds: 0 } }])
    assert.throws(() => parse({ ...contract, ...patch }), protocol.ValidationError)
  assert.throws(() => parse({ ...contract, steps: [{ ...contract.steps[0], variables: { task: 'x'.repeat(16_385) } }] }), protocol.ValidationError)
  assert.throws(() => parse({ ...contract, steps: [{ ...contract.steps[0], assignments: [{ role: 'implement', agent: 'builder', seat: 'worker-1', ceiling: 'root' }] }] }), protocol.ValidationError)
})

test('Lead assertion results preserve all four statuses and revision-qualified evidence', () => {
  const parse = validator('parseLeadAssertionResult')
  for (const status of ['pending', 'passed', 'failed', 'unknown'])
    assert.deepEqual(parse({ ...result, status }), { ...result, status })
  for (const patch of [{ status: 'success' }, { revision: -1 }, { contractRevision: 0.5 },
    { evidence: [{ kind: 'check', id: 'check-1' }] }, { evidence: Array(129).fill(result.evidence[0]) }])
    assert.throws(() => parse({ ...result, ...patch }), protocol.ValidationError)
})

test('Lead cards validate their branch and approval binding', () => {
  const parse = validator('parseLeadCard')
  for (const card of cards) {
    assert.deepEqual(parse(card), card)
    assert.throws(() => parse({ ...card, version: 2 }), protocol.ValidationError)
  }
  assert.throws(() => parse({ ...cards[0], contractDigest: 'b'.repeat(64) }), protocol.ValidationError)
  assert.throws(() => parse({ ...base, type: 'worker-approval', approval: 'approval-1' }), protocol.ValidationError)
})

test('Lead policies and budget projections reject malformed numeric and authority fields', () => {
  const parsePolicy = validator('parseLeadPermissionPolicy')
  assert.deepEqual(parsePolicy(policy), policy)
  assert.throws(() => parsePolicy({ ...policy, mode: 'unrestricted' }), protocol.ValidationError)
  assert.throws(() => parsePolicy({ ...policy, rules: [{ id: 'r1', effect: 'allow', method: 'shell/run', action: null, project: null }] }), protocol.ValidationError)
  const parseBudget = validator('parseLeadBudgetState')
  assert.deepEqual(parseBudget(budget), budget)
  for (const patch of [{ version: 2 }, { workerUsdMicros: NaN }, { leadUsdMicros: -1 },
    { reservedUsdMicros: 0.5 }, { roundsAdmitted: Number.MAX_SAFE_INTEGER + 1 }, { spend: 'free' }])
    assert.throws(() => parseBudget({ ...budget, ...patch }), protocol.ValidationError)
})

test('Lead revisions only advance by safe integers and refuse overflow', () => {
  const next = validator('nextLeadRevision')
  assert.equal(next(0), 1)
  assert.equal(next(4), 5)
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => next(value), protocol.ValidationError)
})

test('Lead thread, settings and child projections have no credential or human decision field', () => {
  const thread = { version: 1, id: 'thread-1', revision: 2, state: 'awaiting-plan', project: contract.project,
    messages: [{ version: 1, id: 'message-1', revision: 1, role: 'user', text: 'Repair the check' }], cards }
  const settings = { version: 1, model: 'model-demo', key: { configured: true, protection: 'encrypted' }, policy, caps }
  const projection = { version: 1, revision: 2, thread, settings }
  assert.deepEqual(validator('parseLeadHostProjection')(projection), projection)
  for (const apiKey of ['synthetic-secret']) {
    assert.throws(() => validator('parseLeadHostProjection')({ ...projection, apiKey }), protocol.ValidationError)
    assert.throws(() => validator('parseLeadHostProjection')({ ...projection, settings: { ...settings, apiKey } }), protocol.ValidationError)
    assert.throws(() => validator('parseLeadHostProjection')({ ...projection, thread: { ...thread, messages: [{ ...thread.messages[0], apiKey }] } }), protocol.ValidationError)
  }
  const control = { version: 1, type: 'initialize', thread, model: 'model-demo', policy, budget }
  assert.deepEqual(validator('parseLeadChildControl')(control), control)
  assert.throws(() => validator('parseLeadChildControl')({ ...control, apiKey: 'synthetic-secret' }), protocol.ValidationError)
  assert.throws(() => validator('parseLeadChildControl')({ version: 1, type: 'decide', cardId: 'person-1' }), protocol.ValidationError)
  assert.throws(() => validator('parseLeadChildEvent')({ version: 1, type: 'decide', cardId: 'person-1' }), protocol.ValidationError)
  assert.throws(() => validator('parseLeadHostProjection')({ ...projection, thread: { ...thread, messages: Array(257).fill(thread.messages[0]) } }), protocol.ValidationError)
})
