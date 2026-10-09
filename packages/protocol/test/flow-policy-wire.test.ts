import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkRetryRefusal, isPersonReviewStep, parseClientMessage, ValidationError, type FlowPolicy, type HostParams } from '../src/index.js'

/*
 * The v2 flow wire refuses forged authority before any handler runs: a
 * caller-supplied `compiled`, ceiling, evidence or origin is not a
 * parameter this table declares at all, so `goalShape`'s "unexpected field"
 * check is what stands between a renderer and a wire method that would
 * otherwise trust it.
 */

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

const checkPolicy = (check: Record<string, unknown>) => ({
  version: 2, name: 'Checks', inputs: [], rules: [], messaging: 'board-only', wait: 60,
  roles: [{ id: 'verify', kind: 'check', check: { run: 'pnpm test', timeout: 60, exits: { 0: 'pass' }, otherwise: 'fail', ...check } }],
  seed: { role: 'verify', title: 'Verify' },
})

test('shape summaries are optional short single lines, with refusals at their field', () => {
  const policy = checkPolicy({})
  assert.doesNotThrow(() => request('authoring/shape/render', { policy }))
  const accepted = request('authoring/shape/render', { policy: { ...policy, summary: 'A short overview.' } })
  assert.equal((accepted.params as HostParams<'authoring/shape/render'>).policy.summary, 'A short overview.')
  for (const summary of ['', ' ', 'x'.repeat(241), 'Two\nlines', 1, [], null]) {
    assert.throws(() => request('authoring/shape/render', { policy: { ...policy, summary } }), (error: unknown) => {
      assert.ok(error instanceof ValidationError)
      assert.equal(error.path, 'message.params.policy.summary')
      return true
    })
  }
})

for (const onRequest of [undefined, true, false]) test(`authoring/shape/render preserves check onRequest ${String(onRequest)}`, () => {
  const policy = checkPolicy(onRequest === undefined ? {} : { onRequest })
  const message = request('authoring/shape/render', { policy })
  const parsed = (message.params as HostParams<'authoring/shape/render'>).policy
  // Optional fields may be normalized to undefined, but JSON must preserve the policy exactly.
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), policy)
})

test('authoring/shape/render refuses non-boolean check onRequest values at their own field', () => {
  for (const onRequest of ['true', 'false', 0, 1, [], {}]) {
    assert.throws(() => request('authoring/shape/render', { policy: checkPolicy({ onRequest }) }), (error: unknown) => {
      assert.ok(error instanceof ValidationError)
      assert.equal(error.path, 'message.params.policy.roles[0].check.onRequest')
      assert.match(error.message, /expected boolean/)
      return true
    })
  }
})

test('flow/start-goal accepts optional lineage, and keeps output metadata host-owned', () => {
  const params = { root: '/repo', source: 'version: 2', token: 't1', sentence: 'Go' }
  assert.doesNotThrow(() => request('flow/start-goal', { ...params, continues: 'flow-earlier' }))
  assert.doesNotThrow(() => request('flow/start-goal', { ...params, continues: null }))
  for (const continues of ['', 1, {}, []]) assert.throws(() => request('flow/start-goal', { ...params, continues }), ValidationError)
  for (const field of ['revision', 'brief', 'startedAt', 'endedAt', 'end']) {
    assert.throws(() => request('flow/start-goal', { ...params, [field]: null }), ValidationError)
  }
})

test('flow/preview and flow/start-goal reject a caller-supplied authority field outright', () => {
  const forgedFields = ['compiled', 'ceiling', 'evidence', 'commands', 'origin', 'authorization']
  for (const field of forgedFields) {
    assert.throws(
      () => request('flow/preview', { root: '/work/repo', source: 'version: 2', [field]: {} }),
      ValidationError,
      `flow/preview should reject an extra "${field}" field`,
    )
    assert.throws(
      () => request('flow/start-goal', { root: '/work/repo', source: 'version: 2', token: 't1', sentence: 'Go', [field]: {} }),
      ValidationError,
      `flow/start-goal should reject an extra "${field}" field`,
    )
  }
  // The declared shape alone is accepted.
  assert.doesNotThrow(() => request('flow/preview', { root: '/work/repo', source: 'version: 2' }))
  assert.doesNotThrow(() => request('flow/start-goal', { root: '/work/repo', source: 'version: 2', token: 't1', sentence: 'Go' }))
})

test('flow/check/retry rejects unknown fields, and its ids and card are bounded', () => {
  assert.throws(() => request('flow/check/retry', { run: 'flow-1', card: 1, token: 't1', origin: 'user' }), ValidationError)
  for (const card of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => request('flow/check/retry', { run: 'flow-1', card, token: 't1' }), ValidationError, `card ${card} should be refused`)
  }
  assert.throws(() => request('flow/check/retry', { run: '', card: 1, token: 't1' }), ValidationError, 'an empty run id is refused')
  assert.throws(() => request('flow/check/retry', { run: 'flow-1', card: 1, token: '' }), ValidationError, 'an empty token is refused')
  assert.doesNotThrow(() => request('flow/check/retry', { run: 'flow-1', card: 1, token: 't1' }))
})

test('flow/check/attempts takes a run and a card and nothing else, so a caller cannot ask for another card’s output by any other name', () => {
  for (const extra of [{ token: 't1' }, { round: 1 }, { name: 'verify' }, { goal: 'goal-1' }, { origin: 'user' }]) {
    assert.throws(() => request('flow/check/attempts', { run: 'flow-1', card: 1, ...extra }), ValidationError, `${Object.keys(extra)[0]} is not a parameter`)
  }
  for (const card of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined]) {
    assert.throws(() => request('flow/check/attempts', { run: 'flow-1', card }), ValidationError, `card ${String(card)} should be refused`)
  }
  for (const run of ['', '   ', 1, null, undefined]) {
    assert.throws(() => request('flow/check/attempts', { run, card: 1 }), ValidationError, `run ${String(run)} should be refused`)
  }
  assert.doesNotThrow(() => request('flow/check/attempts', { run: 'flow-1', card: 1 }))
})

test('a check is refused a retry in the host’s own sentence by what its run and its operation already say', () => {
  // A check that is not waiting — still running, or never started — says so whatever the run is doing.
  for (const run of ['running', 'stalled', 'settled', 'stopped'] as const) {
    for (const operation of ['started', 'prepared', null] as const) {
      assert.equal(checkRetryRefusal(run, operation), 'This check is not waiting to be run again.', `${run} run, ${String(operation)} check`)
    }
  }
  // A finished or interrupted check on a run that has ended asks for a new run instead.
  for (const run of ['settled', 'stopped'] as const) {
    for (const operation of ['finished', 'uncertain'] as const) {
      assert.equal(checkRetryRefusal(run, operation), `This run is ${run}. Start a new run to run this check again.`)
    }
  }
  // Neither says no, so the host is asked: it alone sees a checkout that moved, cleanup pending, or a held or wrapped Team.
  for (const run of ['running', 'stalled'] as const) {
    for (const operation of ['finished', 'uncertain'] as const) assert.equal(checkRetryRefusal(run, operation), null)
  }
})

test('flow/answer/continue accepts only a non-empty run id', () => {
  assert.throws(() => request('flow/answer/continue', { run: '' }), ValidationError)
  assert.throws(() => request('flow/answer/continue', { run: 'run-1', origin: 'user' }), ValidationError)
  assert.doesNotThrow(() => request('flow/answer/continue', { run: 'run-1' }))
})

test('person review candidate methods validate their complete request shapes', () => {
  assert.throws(() => request('flow/review/candidates', { run: '', card: 1 }), ValidationError)
  assert.throws(() => request('flow/review/candidates', { run: 'run-1', card: 0 }), ValidationError)
  assert.throws(() => request('flow/review/candidates', { run: 'run-1', card: 1, seat: 'forged' }), ValidationError)
  assert.doesNotThrow(() => request('flow/review/candidates', { run: 'run-1', card: 1 }))
  for (const params of [
    { run: '', card: 1, candidate: 'candidate-1', verdict: 'picked' },
    { run: 'run-1', card: 0, candidate: 'candidate-1', verdict: 'picked' },
    { run: 'run-1', card: 1, candidate: '', verdict: 'picked' },
    { run: 'run-1', card: 1, candidate: 'candidate-1', verdict: '' },
    { run: 'run-1', card: 1, candidate: 'candidate-1', verdict: 'picked', seat: 'forged' },
  ]) assert.throws(() => request('flow/review/decide', params), ValidationError)
  assert.doesNotThrow(() => request('flow/review/decide', { run: 'run-1', card: 1, candidate: 'candidate-1', verdict: 'picked' }))
})

test('person review policy is one shared predicate over the role and its review-guarded rules', () => {
  const policy = {
    roles: [{ id: 'judge', kind: 'person', outcomes: ['picked'] }, { id: 'referee', kind: 'person', outcomes: ['merged'] }],
    rules: [
      { id: 'referee-step', on: 'judge', when: { every: ['picked'], evidence: [{ review: 'picked' }] }, then: { role: 'referee', title: 'Merge' } },
      { id: 'ordinary', on: 'referee', when: { every: ['merged'] }, then: { role: 'next', title: 'Next' } },
    ],
  } as unknown as FlowPolicy
  assert.equal(isPersonReviewStep(policy, 'judge'), true)
  assert.equal(isPersonReviewStep(policy, 'referee'), false)
  assert.equal(isPersonReviewStep(policy, 'missing'), false)
  assert.equal(isPersonReviewStep({ ...policy, roles: [{ id: 'judge', kind: 'agent' }] } as unknown as FlowPolicy, 'judge'), false)
})

test('a token field never accepts anything but a filled string — no object, number or cross-type value stands in for it', () => {
  for (const token of [{ run: 'flow-1' }, 42, null, undefined, ['t1']]) {
    assert.throws(() => request('flow/start-goal', { root: '/r', source: 'x', token, sentence: 'Go' }), ValidationError)
    assert.throws(() => request('flow/check/retry', { run: 'flow-1', card: 1, token }), ValidationError)
    assert.throws(() => request('flow/update/apply', { root: '/r', token }), ValidationError)
  }
})

test('an oversized source is refused at the wire before any parser sees it', () => {
  const huge = 'x'.repeat(256 * 1024 + 1)
  assert.throws(() => request('flow/preview', { root: '/work/repo', source: huge }), ValidationError)
  assert.throws(() => request('flow/start-goal', { root: '/work/repo', source: huge, token: 't1', sentence: 'Go' }), ValidationError)
  // Exactly at the limit is still accepted; the refusal is the boundary, not "no large flows".
  const atLimit = 'x'.repeat(256 * 1024)
  assert.doesNotThrow(() => request('flow/preview', { root: '/work/repo', source: atLimit }))
})

test('flow/catalog, flow/source and the update/customize routes hold their own ids to the same rules', () => {
  assert.throws(() => request('flow/source', { root: '/r', id: '' }), ValidationError, 'an empty id is refused')
  assert.throws(() => request('flow/source', { root: '/r', id: 'x', origin: 'evil' }), ValidationError, 'an unknown origin is refused')
  assert.doesNotThrow(() => request('flow/source', { root: '/r', id: 'x', origin: 'project' }))
  assert.throws(() => request('flow/update/preview', { root: '/r', id: '', extra: 1 }), ValidationError)
  assert.throws(() => request('flow/customize/apply', { root: '/r', id: 'x', token: 't1', forced: true }), ValidationError)
})

test('preview and start accept seats and attendance, but validate each new field', () => {
  for (const method of ['flow/preview', 'flow/start-goal']) {
    const params = { root: '/repo', source: 'version: 2', ...(method === 'flow/start-goal' ? { token: 't1', sentence: 'Go' } : {}) }
    assert.doesNotThrow(() => request(method, { ...params, seats: { writer: [{ runtime: 'alpha', effort: 'high', thinking: true }] }, attended: false }))
    for (const extra of [{ attended: 'false' }, { seats: [] }, { seats: { writer: 'alpha' } }, { seats: { writer: [{ runtime: '' }] } }, { seats: { writer: [{ runtime: 'alpha', grant: 'merge' }] } }]) {
      assert.throws(() => request(method, { ...params, ...extra }), ValidationError)
    }
  }
})


test('seat override validation preserves prototype-named roles for semantic refusal', () => {
  const seats = JSON.parse('{"__proto__":[{"runtime":"fake"}]}')
  const preview = parseClientMessage({ id: 1, method: 'flow/preview', params: { root: '/tmp/demo', source: 'synthetic', seats } })
  assert.equal(preview.method, 'flow/preview')
  assert.deepEqual(Object.keys((preview.params as HostParams<'flow/preview'>).seats!), ['__proto__'])
})

test('successful outcome declarations cross the shape wire and malformed lists do not (#1548)', () => {
  const policy = { ...checkPolicy({}), complete: { verify: ['pass'] } }
  const accepted = request('authoring/shape/render', { policy })
  assert.deepEqual((accepted.params as HostParams<'authoring/shape/render'>).policy.complete, policy.complete)
  for (const complete of [null, [], {verify: 'pass'}, {verify: [3]}, {'bad.role': ['pass']}]) {
    assert.throws(() => request('authoring/shape/render', { policy: {...policy, complete} }), ValidationError)
  }
})
