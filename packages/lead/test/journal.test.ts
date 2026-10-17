import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLeadAcceptanceContract, parseLeadPermissionPolicy } from '@harnessdesk/protocol'
import * as lead from '../src/index.js'

const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Repair check',
  project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
  steps: [{ id: 'implement', title: 'Implement', flow: 'lead-reviewed-result', sourceRevision: 'source-1',
    variables: {}, attendance: 'attended', assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] }],
  assertions: [{ id: 'check', kind: 'check', description: 'Checks pass' }], caps: { usdMicros: 500, rounds: 3 } })
const policy = parseLeadPermissionPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
const context = { desk: policy, projectPolicy: null, project: contract.project,
  approved: null, now: 100, policyInterpretation: 'idle', budget: { version: 1, revision: 1, caps: contract.caps,
    leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known', stop: null } }
const request = { method: 'flow/start-goal', params: { root: contract.project.path, source: 'synthetic recipe', token: 'preview-1',
  sentence: contract.goal, vars: {}, attended: true, seats: { implement: [{ runtime: 'fixture' }] } },
  project: contract.project, runId: null, start: contract.steps[0] }
const plan = { version: 1, id: 'plan-1', revision: 1, type: 'plan', contractDigest: contract.digest, contract }
const click = { version: 1, cardId: 'plan-1', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }

// Initial red run must identify the absent crash-safe journal, before effects can run.
const open = async (storage: unknown): Promise<any> => {
  const factory = (lead as Record<string, unknown>).createLeadJournal
  assert.equal(typeof factory, 'function', 'createLeadJournal must gate effects on durable records')
  return (factory as (port: unknown) => Promise<unknown>)(storage)
}
const memory = () => {
  const records: any[] = []
  let fail: string | null = null
  return { records, failOn(type: string | null) { fail = type },
    async read() { return structuredClone(records) },
    async append(record: any) { if (record.type === fail) throw new Error('simulated disk refusal'); records.push(structuredClone(record)) } }
}
const prepare = async (storage: ReturnType<typeof memory>) => {
  const journal = await open(storage)
  await journal.setPolicy(policy)
  await journal.offerCard(plan)
  await journal.decideCard(click, 200)
  return journal
}

test('crash after successful start before recording response never starts a second Flow', async () => {
  const storage = memory(), journal = await prepare(storage)
  let starts = 0
  const identity = { correlationId: 'attempt-1', runId: 'run-1', teamId: 'team-1' }
  storage.failOn('result')
  await assert.rejects(journal.execute({ id: 'attempt-1', request, context, stepId: 'implement' }, async () => {
    starts++; return { value: { run: 'run-1' }, identity }
  }))
  storage.failOn(null)
  const recovered = await open(storage)
  const actions = await recovered.recover(async (attempt: any) => attempt.correlationId === identity.correlationId ? identity : null)
  assert.equal(starts, 1)
  assert.equal(actions[0].type, 'reconciled')
  assert.equal(recovered.state.steps[0].state, 'completed')
  const duplicate = await recovered.execute({ id: 'attempt-2', request, context, stepId: 'implement' }, async () => {
    starts++; return { value: null, identity }
  })
  assert.equal(duplicate.decision.effect, 'deny')
  assert.equal(starts, 1)
})

test('failed attempt append prevents the original call and poisons this writer', async () => {
  const storage = memory(), journal = await prepare(storage)
  storage.failOn('attempt')
  let calls = 0
  await assert.rejects(journal.execute({ id: 'attempt-1', request, context, stepId: 'implement' }, async () => { calls++; return { value: null, identity: null } }))
  storage.failOn(null)
  await assert.rejects(journal.execute({ id: 'attempt-2', request, context, stepId: 'implement' }, async () => { calls++; return { value: null, identity: null } }))
  assert.equal(calls, 0)
})

test('every malformed, denied, asked, successful and failed call has four ordered audit records', async () => {
  const storage = memory(), journal = await prepare(storage)
  const probes = [
    { method: 'session/send', params: {}, outcome: 'denied' },
    { method: 'library/usage', params: null, outcome: 'malformed' },
    { method: 'library/usage', params: {}, outcome: 'succeeded' },
  ]
  for (let n = 0; n < probes.length; n++) {
    const p = probes[n]!, before = storage.records.length
    const result = await journal.execute({ id: `read-${n}`, request: { ...request, method: p.method, params: p.params, project: null, runId: null, start: null }, context },
      async () => ({ value: 'raw text never persisted', identity: null }))
    assert.equal(result.outcome, p.outcome)
    assert.equal(storage.records[before].method, p.method)
    assert.deepEqual(storage.records.slice(before).map(record => record.type), ['attempt', 'decision', 'dispatch-start', 'result'])
  }
  const before = storage.records.length
  const result = await journal.execute({ id: 'failed-read', request: { ...request, method: 'library/usage', params: {}, project: null, runId: null, start: null }, context },
    async () => { throw new Error('raw provider body with secret') })
  assert.equal(result.outcome, 'failed')
  assert.deepEqual(storage.records.slice(before).map(record => record.type), ['attempt', 'decision', 'dispatch-start', 'result'])
  assert.ok(!JSON.stringify(storage.records).includes('raw'))
})

test('each journal failure boundary prevents effects and card decisions precede effects', async () => {
  for (const type of ['attempt', 'decision', 'dispatch-start']) {
    const storage = memory(), journal = await prepare(storage)
    storage.failOn(type)
    let calls = 0
    await assert.rejects(journal.execute({ id: 'attempt-1', request, context, stepId: 'implement' }, async () => { calls++; return { value: null, identity: null } }))
    assert.equal(calls, 0, type)
  }
  const storage = memory(), journal = await open(storage)
  await journal.setPolicy(policy); await journal.offerCard(plan)
  storage.failOn('card-decision')
  let effects = 0
  await assert.rejects(journal.decideCard(click, 200).then(() => { effects++ }))
  assert.equal(effects, 0)
  assert.equal(journal.state.contract, null)
})

test('recovery stops for unproved mutations, while reads can be retried', async () => {
  for (const proof of [null, { correlationId: 'different', runId: 'run-other', teamId: 'team-other' }]) {
    const storage = memory(), journal = await prepare(storage)
    await journal.execute({ id: 'attempt-1', request, context, stepId: 'implement' }, async () => { throw new Error('response lost') })
    const recovered = await open(storage), actions = await recovered.recover(async () => proof)
    assert.equal(actions[0].type, 'needs-user')
    assert.equal(recovered.state.phase, 'waiting-for-user')
    let calls = 0
    assert.equal((await recovered.execute({ id: 'attempt-2', request, context, stepId: 'implement' }, async () => { calls++; return { value: null, identity: null } })).decision.effect, 'deny')
    assert.equal(calls, 0)
  }
  const storage = memory(), journal = await prepare(storage)
  storage.failOn('result')
  const read = { ...request, method: 'library/usage', params: {}, project: null, runId: null, start: null }
  await assert.rejects(journal.execute({ id: 'read-1', request: read, context }, async () => ({ value: 1, identity: null })))
  storage.failOn(null)
  const recovered = await open(storage)
  assert.equal((await recovered.recover(async () => { throw new Error('reads need no mutation proof') }))[0].type, 'retry-read')
  assert.equal((await recovered.execute({ id: 'read-2', request: read, context }, async () => ({ value: 2, identity: null }))).value, 2)
})

test('concurrent starts serialize and only the approved next step is admitted', async () => {
  const storage = memory(), journal = await prepare(storage)
  let calls = 0
  const dispatch = async (_call: unknown, correlationId: string) => { calls++; return { value: null, identity: { correlationId, runId: 'run-1', teamId: 'team-1' } } }
  const [first, second] = await Promise.all([
    journal.execute({ id: 'attempt-1', request, context, stepId: 'implement' }, dispatch),
    journal.execute({ id: 'attempt-2', request, context, stepId: 'implement' }, dispatch),
  ])
  assert.equal(first.outcome, 'succeeded'); assert.equal(second.decision.effect, 'deny'); assert.equal(calls, 1)
  assert.equal(journal.state.steps[0].state, 'completed')
  assert.deepEqual(journal.state.teams, ['team-1'])
})

test('asked calls are audited, failed approvals do not grant consent and state snapshots are detached', async () => {
  const storage = memory(), journal = await prepare(storage)
  await journal.setPolicy({ ...policy, revision: 2, mode: 'default' })
  const before = storage.records.length
  const result = await journal.execute({ id: 'asked-1', request, context, stepId: 'implement' }, async () => { throw new Error('must not dispatch') })
  assert.equal(result.outcome, 'asked')
  assert.deepEqual(storage.records.slice(before).map(record => record.type), ['attempt', 'decision', 'dispatch-start', 'result'])
  const copy = journal.state
  copy.steps[0].state = 'completed'
  assert.equal(journal.state.steps[0].state, 'pending')
  await assert.rejects(journal.decideCard(click, 200))
})

test('Team membership can be durably bound before its first Flow starts', async () => {
  const storage = memory(), journal = await prepare(storage)
  await journal.bindTeam('team-1', contract.digest)
  const recovered = await open(storage)
  assert.deepEqual(recovered.state.teams, ['team-1'])
  assert.deepEqual(recovered.state.runs, [])
  const result = await recovered.execute({ id: 'team-read', request: { ...request, method: 'flow/executions', params: { team: 'team-1' }, runId: null, start: null }, context },
    async () => ({ value: [], identity: null }))
  assert.equal(result.decision.effect, 'allow')
  await assert.rejects(recovered.bindTeam('team-other', 'b'.repeat(64)))
})


test('permission audit preserves its matched rule reference without persisting the dispatch call', async () => {
  const storage = memory(), journal = await prepare(storage)
  const result = await journal.execute({ id: 'denied-read', request: { ...request, method: 'library/usage', params: {}, project: null, runId: null, start: null },
    context: { ...context, projectPolicy: { ...policy, revision: 7, rules: [{ id: 'deny-read', method: 'library/usage', action: null, project: null, effect: 'deny' }] } } },
    async () => { throw new Error('denied') })
  assert.equal(result.decision.effect, 'deny')
  const attempt = storage.records.find(record => record.id === 'denied-read' && record.type === 'attempt')
  const decision = storage.records.find(record => record.id === 'denied-read' && record.type === 'decision')
  assert.equal(attempt.projectPolicyRevision, 7)
  assert.deepEqual(decision.rule, { layer: 'project', id: 'deny-read' })
  assert.equal(decision.call, undefined)
})

test('the audited policy revision and permission decision use the same detached input snapshot', async () => {
  const storage = memory(), journal = await prepare(storage)
  const projectPolicy = { ...policy, revision: 7, rules: [{ id: 'deny-read', method: 'library/usage', action: null, project: null, effect: 'deny' }] }
  const c = { ...context, projectPolicy }
  const append = storage.append.bind(storage)
  storage.append = async record => {
    await append(record)
    if (record.type === 'attempt') { c.projectPolicy = { ...projectPolicy, revision: 8, rules: [] } }
  }
  let calls = 0
  const result = await journal.execute({ id: 'snapshot-1', request: { ...request, method: 'library/usage', params: {}, project: null, runId: null, start: null }, context: c },
    async () => { calls++; return { value: null, identity: null } })
  assert.equal(result.decision.effect, 'deny')
  assert.equal(calls, 0)
  assert.equal(storage.records.find(record => record.type === 'attempt')?.projectPolicyRevision, 7)
})
