import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage, parseLeadAcceptanceContract, parseLeadPermissionPolicy } from '@harnessdesk/protocol'
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
const open = async (storage: unknown, security: unknown = {}): Promise<any> => {
  const factory = (lead as Record<string, unknown>).createLeadJournal
  assert.equal(typeof factory, 'function', 'createLeadJournal must gate effects on durable records')
  return (factory as (port: unknown, security: unknown) => Promise<unknown>)(storage, security)
}
const memory = () => {
  const records: any[] = []
  let fail: string | null = null
  return { records, failOn(type: string | null) { fail = type },
    async read() { return structuredClone(records) },
    async append(record: any) { if (record.type === fail) throw new Error('simulated disk refusal'); records.push(structuredClone(record)) } }
}
const initializeBudget = async (journal: any) => {
  if (!journal.state.budget) await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: contract.caps, freshnessMs: 50 })
}
const prepare = async (storage: ReturnType<typeof memory>) => {
  const journal = await open(storage)
  await journal.setPolicy(policy)
  await journal.offerCard(plan)
  await initializeBudget(journal)
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
  const actions = await recovered.recover(async (attempt: any) => attempt.correlationId === identity.correlationId ? [identity] : [])
  assert.equal(starts, 1)
  assert.equal(actions[0].type, 'reconciled')
  assert.equal(recovered.state.steps[0].state, 'started')
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
    assert.equal(storage.records[before].method, p.method === 'session/send' ? 'invalid' : p.method)
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
    const recovered = await open(storage), actions = await recovered.recover(async () => proof === null ? [] : [proof])
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
  assert.equal(journal.state.steps[0].state, 'started')
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
  copy.steps[0].state = 'started'
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

test('validation refusals never poison an intact writer and Stop remains durable', async () => {
  for (const invalid of ['card', 'id', 'policy']) {
    const storage = memory(), journal = await prepare(storage)
    if (invalid === 'card') await assert.rejects(journal.offerCard({ ...plan, revision: 1 }))
    if (invalid === 'id') await assert.rejects(journal.execute({ id: 'bad id', request, context }, async () => ({ value: null, identity: null })))
    if (invalid === 'policy') {
      await journal.setPolicy({ ...policy, revision: 2, mode: 'plan' })
      await assert.rejects(journal.setPolicy({ ...policy, revision: 3 }))
    }
    await journal.stop()
    assert.equal((await open(storage)).state.phase, 'stopped', invalid)
  }
})


test('ordinary authorization prose and sk-ending names persist approve and execute', async () => {
  for (const text of ['Fix authorization middleware', 'Support bearer tokens', 'desk-workers-app', 'task-implementation', 'risk-assessment']) {
    const storage = memory(), journal = await open(storage)
    const approved = { ...contract, goal: text, project: { ...contract.project, path: '/workspace/' + text.replaceAll(' ', '-') },
      steps: [{ ...contract.steps[0], id: text.replaceAll(' ', '-') }] }
    await journal.setPolicy(policy)
    await journal.offerCard({ ...plan, contract: approved })
    await initializeBudget(journal)
    await journal.decideCard(click, 200)
    const result = await journal.execute({ id: 'attempt-1', stepId: approved.steps[0]!.id, context: { ...context, project: approved.project },
      request: { ...request, project: approved.project, start: approved.steps[0], params: { ...request.params, root: approved.project.path, sentence: text } } },
      async () => ({ value: null, identity: { correlationId: 'attempt-1', runId: 'run-1', teamId: 'team-1' } }))
    assert.equal(result.outcome, 'succeeded', text)
  }
})

test('exact canaries refuse one record without latching and secret variables use broker references', async () => {
  const canary = 'synthetic-provider-canary-0123456789'
  const storage = memory(), journal = await open(storage, { canaries: [canary], digestContract: () => 'b'.repeat(64),
    brokerReference: (_value: string, name: string) => name === 'api_key' ? 'broker:input-1' : null })
  await journal.setPolicy(policy)
  await assert.rejects(journal.offerCard({ ...plan, contract: { ...contract, goal: canary } }))
  const offered = await journal.offerCard({ ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], variables: { api_key: 'SYNTHETIC_INPUT' } }] } })
  assert.equal(offered.contract.steps[0].variables.api_key, 'broker:input-1')
  assert.equal(offered.contractDigest, 'b'.repeat(64))
  assert.ok(!JSON.stringify(storage.records).includes(canary))
  await journal.stop()
  assert.equal(journal.state.phase, 'stopped')
})

test('token-shaped prose and credential headers are masked before approval', async () => {
  const tokens = ['gho_' + 'A'.repeat(36), 'github_pat_' + 'B'.repeat(60), 'sk-ant-' + 'c'.repeat(30), 'sk_live_' + 'D'.repeat(30),
    'xoxb-' + '1'.repeat(12) + '-' + '2'.repeat(12) + '-' + 'A'.repeat(24), 'AKIA' + 'E'.repeat(16), 'eyJ' + 'A'.repeat(20) + '.' + 'B'.repeat(24) + '.' + 'C'.repeat(32),
    'Cookie: session=synthetic-cookie-91b0c2d3', 'Authorization: Bearer synthetic-header-value',
    'x-api-key: synthetic-api-value', 'api_key=synthetic-api-value-91b0c2d3', 'token=synthetic-token-value']
  for (const token of tokens) {
    const storage = memory(), journal = await open(storage, { digestContract: () => 'b'.repeat(64) })
    await journal.setPolicy(policy)
    const offered = await journal.offerCard({ ...plan, contract: { ...contract, goal: 'Review ' + token } })
    assert.ok(!JSON.stringify(storage.records).includes(token), token.split(':')[0]!)
    assert.ok(offered.contract.goal.includes('[redacted]'))
    await assert.rejects(journal.decideCard(click, 200))
    await journal.decideCard({ ...click, contractDigest: offered.contractDigest }, 200)
  }
})

test('cancellation bypasses uncertain mutation fencing and thrown cancellation is failed', async () => {
  for (const method of ['flow/execution/stop', 'team/intent']) {
    const storage = memory(), journal = await prepare(storage)
    await journal.bindTeam('team-1', contract.digest)
    await journal.execute({ id: 'attempt-1', request, context, stepId: 'implement' }, async () => ({ value: null,
      identity: { correlationId: 'attempt-1', runId: 'run-1', teamId: 'team-1' } }))
    // A host-admitted cancellation whose response is lost is already safe to retry.
    const cancel = { ...request, method, params: method === 'team/intent' ? { room: 'team-1', id: 1, action: 'abandon' } : { run: 'run-1', reason: 'Stop work' }, runId: 'run-1', start: null }
    const first = await journal.execute({ id: 'cancel-1', request: cancel, context }, async () => { throw new Error('lost response') })
    assert.equal(first.outcome, 'failed', method)
    // A genuinely uncertain non-cancellation must also leave cancellation available.
    const record = (type: string, fields: object) => storage.records.push({ version: 1, seq: storage.records.length + 1, type, ...fields })
    record('attempt', { id: 'uncertain-1', correlationId: 'uncertain-1', method: 'workspace/open', action: null, arguments: { type: 'object', size: 0, fields: [] }, kind: 'mutation', stepId: null, policyRevision: 1, projectPolicyRevision: null, contractRevision: 1 })
    record('decision', { id: 'uncertain-1', effect: 'allow', reason: 'policy', rule: null })
    record('dispatch-start', { id: 'uncertain-1', dispatched: true })
    record('result', { id: 'uncertain-1', outcome: 'uncertain', identity: null })
    const recovered = await open(storage)
    assert.equal((await recovered.execute({ id: 'cancel-2', request: cancel, context }, async () => ({ value: null, identity: null }))).outcome, 'succeeded', method)
  }
})

test('pending plan blocks mutations and stopped state still permits status reads', async () => {
  const storage = memory(), journal = await prepare(storage)
  await journal.offerCard({ ...plan, revision: 2, contract: { ...contract, revision: 2 } })
  assert.equal((await journal.execute({ id: 'start-1', request, context, stepId: 'implement' }, async () => ({ value: null, identity: null }))).outcome, 'denied')
  await journal.stop()
  assert.equal((await journal.execute({ id: 'status-1', request: { ...request, method: 'library/usage', params: {}, start: null }, context }, async () => ({ value: 1, identity: null }))).outcome, 'succeeded')
})

test('unknown method names are represented by invalid in the audit', async () => {
  const storage = memory(), journal = await prepare(storage)
  await journal.execute({ id: 'invalid-1', request: { ...request, method: 'unknown/private-provider', params: {} }, context }, async () => { throw new Error('unreachable') })
  assert.equal(storage.records.find(record => record.type === 'attempt').method, 'invalid')
})

test('recovery requires exactly one identity and records unchanged evidence only once', async () => {
  for (const count of [0, 1, 2]) {
    const storage = memory(), journal = await prepare(storage)
    await journal.execute({ id: 'attempt-1', request, context, stepId: 'implement' }, async () => { throw new Error('lost response') })
    const recovered = await open(storage)
    const matches = Array.from({ length: count }, (_, i) => ({ correlationId: 'attempt-1', runId: `run-${i}`, teamId: 'team-1' }))
    const result = await recovered.recover(async () => matches)
    assert.equal(result[0].type, count === 1 ? 'reconciled' : 'needs-user')
    assert.equal(result[0].count, count)
    const seq = recovered.state.seq
    assert.deepEqual(await recovered.recover(async () => matches), [])
    assert.equal(recovered.state.seq, seq)
    assert.deepEqual(await (await open(storage)).recover(async () => matches), [])
  }
})

test('recovered reads are reported only once across restarts', async () => {
  const storage = memory(), journal = await prepare(storage)
  storage.failOn('result')
  await assert.rejects(journal.execute({ id: 'read-1', request: { ...request, method: 'library/usage', params: {}, start: null }, context }, async () => ({ value: 1, identity: null })))
  storage.failOn(null)
  const recovered = await open(storage)
  assert.equal((await recovered.recover(async () => []))[0].type, 'retry-read')
  assert.deepEqual(await recovered.recover(async () => []), [])
  assert.deepEqual(await (await open(storage)).recover(async () => []), [])
})

test('card revisions and retained finished attempts are bounded', async () => {
  const storage = memory(), journal = await prepare(storage)
  for (let revision = 2; revision <= 32; revision++) await journal.offerCard({ ...plan, revision, contract: { ...contract, revision: 2 } })
  await assert.rejects(journal.offerCard({ ...plan, revision: 33, contract: { ...contract, revision: 2 } }))
  await journal.stop()
  for (let i = 0; i < 300; i++) await journal.execute({ id: `read-${i}`, request: { ...request, method: 'library/usage', params: {}, start: null }, context }, async () => ({ value: 1, identity: null }))
  assert.ok(journal.state.attempts instanceof Map)
  assert.ok(journal.state.attempts.size <= 64)
})

test('a quarantine block fences starts while reads and cancellation remain available', async () => {
  const storage = memory(), journal = await open(storage)
  const second = { ...contract.steps[0]!, id: 'second' }
  await journal.setPolicy(policy)
  await journal.offerCard({ ...plan, contract: { ...contract, steps: [...contract.steps, second] } })
  await initializeBudget(journal)
  await journal.decideCard(click, 200)
  await journal.execute({ id: 'attempt-1', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'attempt-1', runId: 'run-1', teamId: 'team-1' } }))
  storage.records.push({ version: 1, seq: storage.records.length + 1, type: 'recovery-block' })
  const recovered = await open(storage)
  assert.equal((await recovered.execute({ id: 'start-2', request: { ...request, start: second }, context, stepId: 'second' }, async () => { throw new Error('must not start') })).decision.effect, 'deny')
  const cancel = { ...request, method: 'flow/execution/stop', params: { run: 'run-1', reason: 'Stop work' }, runId: 'run-1', start: null }
  assert.equal((await recovered.execute({ id: 'stop-1', request: cancel, context }, async () => ({ value: null, identity: null }))).outcome, 'succeeded')
  await recovered.stop()
  assert.equal((await recovered.execute({ id: 'status-1', request: { ...request, method: 'flow/execution', params: { run: 'run-1' }, runId: 'run-1', start: null }, context }, async () => ({ value: 1, identity: null }))).outcome, 'succeeded')
})


test('a conflicting reconciliation identity refuses one call and leaves Stop writable', async () => {
  const storage = memory(), journal = await open(storage), second = { ...contract.steps[0]!, id: 'second' }
  await journal.setPolicy(policy)
  await journal.offerCard({ ...plan, contract: { ...contract, steps: [...contract.steps, second] } })
  await initializeBudget(journal)
  await journal.decideCard(click, 200)
  await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'first', runId: 'run-1', teamId: 'team-1' } }))
  await observeStarted(journal, 'run-1')
  await journal.execute({ id: 'second', request: { ...request, start: second }, context, stepId: 'second' }, async () => { throw new Error('lost response') })
  await assert.rejects(journal.recover(async () => [{ correlationId: 'second', runId: 'run-1', teamId: 'team-1' }]))
  await journal.stop()
  assert.equal((await open(storage)).state.phase, 'stopped')
})

test('undecided plan survives waiting decisions and reconciliation and can replace only pending steps', async () => {
  const storage = memory(), journal = await open(storage)
  const second = { ...contract.steps[0]!, id: 'second' }
  const original = { ...contract, steps: [...contract.steps, second] }
  await journal.setPolicy(policy)
  await journal.offerCard({ ...plan, contract: original })
  await initializeBudget(journal)
  await journal.decideCard(click, 200)
  await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => { throw new Error('response lost') })
  const updatedSecond = { ...second, variables: { target: 'revised' } }
  const revised = { ...original, revision: 2, digest: 'b'.repeat(64), goal: 'Revised pending work', steps: [original.steps[0]!, updatedSecond] }
  await journal.offerCard({ ...plan, revision: 2, contractDigest: revised.digest, contract: revised })
  await journal.offerCard({ version: 1, id: 'waiting-1', revision: 1, type: 'waiting', kind: 'person', runId: 'run-1', personCardId: 'gate-1',
    contractDigest: original.digest, summary: 'Person gate', assertions: [] })
  await journal.decideCard({ version: 1, cardId: 'waiting-1', cardType: 'waiting', expectedRevision: 1, choice: 'accept', contractDigest: original.digest })
  await journal.recover(async () => [{ correlationId: 'first', runId: 'run-1', teamId: 'team-1' }])
  await observeStarted(journal, 'run-1')
  const nextRequest = { ...request, start: second }
  const blocked = await journal.execute({ id: 'blocked', request: nextRequest, context, stepId: 'second' }, async () => { throw new Error('must not dispatch') })
  assert.equal(blocked.outcome, 'denied', 'a pending plan is independent of phase')
  await journal.decideCard({ ...click, expectedRevision: 2, contractDigest: revised.digest }, 300)
  assert.equal(journal.state.steps[0].state, 'started')
  assert.deepEqual(journal.state.runs, [{ correlationId: 'first', runId: 'run-1', teamId: 'team-1' }])
  assert.equal(journal.state.contract.digest, revised.digest)
  assert.equal((await journal.execute({ id: 'second', request: { ...nextRequest, start: updatedSecond,
    params: { ...request.params, sentence: revised.goal, vars: updatedSecond.variables } }, context, stepId: 'second' },
    async () => ({ value: null, identity: { correlationId: 'second', runId: 'run-2', teamId: 'team-1' } }))).outcome, 'succeeded')
})

test('plan revision approval preserves admitted steps and refuses changes to their project or definition', async () => {
  for (const change of ['definition', 'project']) {
    const storage = memory(), journal = await prepare(storage)
    await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => { throw new Error('lost response') })
    const revised = { ...contract, revision: 2, digest: 'b'.repeat(64),
      ...(change === 'project' ? { project: { ...contract.project, path: '/workspace/other' } } : { steps: [{ ...contract.steps[0]!, title: 'Changed admitted work' }] }) }
    await assert.rejects(journal.offerCard({ ...plan, revision: 2, contractDigest: revised.digest, contract: revised }))
    await journal.stop()
    assert.equal((await open(storage)).state.phase, 'stopped')
  }
})

test('a running plan revision approves without resetting started steps or run identities', async () => {
  const storage = memory(), journal = await prepare(storage)
  await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'first', runId: 'run-1', teamId: 'team-1' } }))
  const revised = { ...contract, revision: 2, digest: 'b'.repeat(64), steps: [...contract.steps, { ...contract.steps[0]!, id: 'second' }] }
  await journal.offerCard({ ...plan, revision: 2, contractDigest: revised.digest, contract: revised })
  await journal.decideCard({ ...click, expectedRevision: 2, contractDigest: revised.digest }, 300)
  assert.deepEqual(journal.state.steps.map((step: any) => step.state), ['started', 'pending'])
  assert.equal(journal.state.runs[0].runId, 'run-1')
  assert.deepEqual(journal.state.teams, ['team-1'])
})

test('an undecided plan cannot be replaced by a different card kind', async () => {
  const storage = memory(), journal = await prepare(storage)
  await journal.offerCard({ ...plan, revision: 2, contract: { ...contract, revision: 2 } })
  await assert.rejects(journal.offerCard({ version: 1, id: plan.id, revision: 3, type: 'waiting', kind: 'person', runId: 'run-1', personCardId: 'gate-1',
    contractDigest: contract.digest, summary: 'Person gate', assertions: [] }))
  await journal.stop()
})

test('canaries are refused in every raw key and value before any broker or masking work', async () => {
  const canary = 'synthetic-provider-canary-91b0c2d3'
  const variants = [
    { ...plan, contract: { ...contract, goal: canary } },
    { ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], variables: { issue: canary } }] } },
    { ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], variables: { api_key: canary } }] } },
    { ...plan, id: canary },
    { ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], sourceRevision: canary }] } },
    { ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], variables: { [canary]: 'ordinary' } }] } },
    { ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], variables: { api_key: 'SYNTHETIC_INPUT' } }], assertions: [{ ...contract.assertions[0], description: canary }] } },
    { ...plan, id: canary, contract: { ...contract, goal: canary, steps: [{ ...contract.steps[0], variables: { api_key: canary } }] } },
  ]
  for (const card of variants) {
    const storage = memory()
    let brokers = 0
    const journal = await open(storage, { canaries: [canary], digestContract: () => 'b'.repeat(64), brokerReference: () => { brokers++; return 'broker:input-1' } })
    await journal.setPolicy(policy)
    await assert.rejects(journal.offerCard(card), /canary/)
    assert.equal(brokers, 0)
    await journal.stop()
    assert.ok(!JSON.stringify(storage.records).includes(canary))
  }
})

test('recognized tokens refuse opaque strings and keys even when duplicated into prose or variables', async () => {
  const token = 'ghp_' + 'A'.repeat(36)
  const variants = [
    { ...plan, id: token },
    { ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], id: token }] } },
    { ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], sourceRevision: token }] } },
    { ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], assignments: [{ ...contract.steps[0]!.assignments[0], seat: { runtime: 'fixture', model: token } }] }] } },
    { ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], variables: { [token]: 'ordinary' } }] } },
    { ...plan, id: token, contract: { ...contract, goal: `Review ${token}`, steps: [{ ...contract.steps[0], variables: { api_key: token } }] } },
  ]
  for (const card of variants) {
    const storage = memory(), journal = await open(storage, { digestContract: () => 'b'.repeat(64), brokerReference: () => 'broker:input-1' })
    await journal.setPolicy(policy)
    await assert.rejects(journal.offerCard(card), /credential/)
    await journal.stop()
    assert.ok(!JSON.stringify(storage.records).includes(token))
  }
})

test('secret variable names are anchored and cookie authorization bearer values require broker references', async () => {
  for (const name of ['api_key', 'apikey', 'access_token', 'token', 'secret', 'password', 'Cookie', 'AUTHORIZATION', 'bearer', 'provider_api_key']) {
    const storage = memory(), journal = await open(storage, { digestContract: () => 'b'.repeat(64), brokerReference: () => 'broker:input-1' })
    await journal.setPolicy(policy)
    const offered = await journal.offerCard({ ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], variables: { [name]: 'SYNTHETIC_INPUT' } }] } })
    assert.equal(offered.contract.steps[0].variables[name], 'broker:input-1', name)
    const withoutBroker = await open(memory())
    await withoutBroker.setPolicy(policy)
    await assert.rejects(withoutBroker.offerCard({ ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], variables: { [name]: 'SYNTHETIC_INPUT' } }] } }), /broker-reference/)
  }
})

test('ordinary token-related variable names stay literal with or without a broker', async () => {
  for (const brokerReference of [undefined, () => 'broker:must-not-be-used']) {
    const journal = await open(memory(), { brokerReference, digestContract: () => 'b'.repeat(64) })
    await journal.setPolicy(policy)
    const offered = await journal.offerCard({ ...plan, contract: { ...contract, steps: [{ ...contract.steps[0], variables: { max_tokens: '4096', tokenizer: 'ordinary' } }] } })
    assert.deepEqual(offered.contract.steps[0].variables, { max_tokens: '4096', tokenizer: 'ordinary' })
  }
})

test('header masking preserves prose after one optional scheme and credential token', async () => {
  for (const [header, expected] of [
    ['Authorization: Bearer synthetic-value and add tests', 'Authorization: [redacted] and add tests'],
    ['Authorization: Basic synthetic-value then retry', 'Authorization: [redacted] then retry'],
    ['x-api-key: Token synthetic-value and continue', 'x-api-key: [redacted] and continue'],
    ['Cookie: session=synthetic-value; keep the sentence', 'Cookie: [redacted]; keep the sentence'],
    ['Authorization: headers are dropped by the proxy and add tests', 'Authorization: [redacted] are dropped by the proxy and add tests'],
  ]) {
    const journal = await open(memory(), { digestContract: () => 'b'.repeat(64) })
    await journal.setPolicy(policy)
    const offered = await journal.offerCard({ ...plan, contract: { ...contract, goal: `Fix ${header}` } })
    assert.equal(offered.contract.goal, `Fix ${expected}`)
  }
})

test('loading validates historical prose without running current write masks', async () => {
  const history = [
    { version: 1, seq: 1, type: 'policy', policy },
    { version: 1, seq: 2, type: 'card', card: { ...plan, contract: { ...contract, goal: 'Historical Authorization: synthetic-value and keep reading' } } },
    { version: 1, seq: 3, type: 'card-decision', decision: click, expiresAt: 200 },
  ]
  const journal = await open({ async read() { return history }, async append() {} })
  assert.equal(journal.state.contract.goal, history[1]!.card!.contract.goal)
  await journal.stop()
})

test('card preparation and its returned card use one snapshot despite a broker mutating the caller', async () => {
  const storage = memory(), input: any = structuredClone(plan)
  const journal = await open(storage, { canaries: ['synthetic-caller-canary'], digestContract: () => 'b'.repeat(64), brokerReference: () => {
    input.id = 'synthetic-caller-canary'; input.contract.goal = 'synthetic-caller-canary'
    return 'broker:input-1'
  } })
  input.contract.steps[0]!.variables = { api_key: 'SYNTHETIC_INPUT' }
  await journal.setPolicy(policy)
  const offered = await journal.offerCard(input)
  assert.equal(offered.id, plan.id)
  assert.equal(offered.contract.goal, contract.goal)
  assert.ok(!JSON.stringify(storage.records).includes('synthetic-caller-canary'))
})

const runningTwoStepPlan = async () => {
  const storage = memory(), journal = await open(storage)
  const original = { ...contract, steps: [...contract.steps, { ...contract.steps[0]!, id: 'second' }] }
  await journal.setPolicy(policy)
  await journal.offerCard({ ...plan, contract: original })
  await initializeBudget(journal)
  await journal.decideCard(click, 200)
  await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'first', runId: 'run-1', teamId: 'team-1' } }))
  return { journal, storage, original, next: { ...request, start: original.steps[1]! } }
}

test('declining a running plan revision keeps the approved contract and permits its next step', async () => {
  const { journal, storage, original, next } = await runningTwoStepPlan()
  await observeStarted(journal, 'run-1')
  const revised = { ...original, revision: 2, digest: 'b'.repeat(64) }
  await journal.offerCard({ ...plan, revision: 2, contractDigest: revised.digest, contract: revised })
  await journal.decideCard({ ...click, expectedRevision: 2, contractDigest: revised.digest, choice: 'decline' })
  assert.equal(journal.state.phase, 'running')
  assert.equal(journal.state.contract.digest, original.digest)
  const reopened = await open(storage)
  assert.equal((await reopened.execute({ id: 'second', request: next, context, stepId: 'second' }, async () => ({ value: null,
    identity: { correlationId: 'second', runId: 'run-2', teamId: 'team-1' } }))).outcome, 'succeeded')
})

test('a plan made stale by a later policy change can be declined without ending the thread', async () => {
  const { journal, original } = await runningTwoStepPlan()
  const revised = { ...original, revision: 2, digest: 'b'.repeat(64) }
  await journal.offerCard({ ...plan, revision: 2, contractDigest: revised.digest, contract: revised })
  await journal.setPolicy({ ...policy, revision: 2 })
  await journal.decideCard({ ...click, expectedRevision: 2, contractDigest: revised.digest, choice: 'decline' })
  assert.equal(journal.state.phase, 'running')
  assert.equal(journal.state.contract.digest, original.digest)
  assert.ok(journal.state.decidedCards.includes('plan-1:2'))
  const fresh = { ...revised, policyRevision: 2 }
  await journal.offerCard({ ...plan, revision: 3, contractDigest: fresh.digest, contract: fresh })
  await journal.decideCard({ ...click, expectedRevision: 3, contractDigest: fresh.digest }, 300)
  assert.equal(journal.state.contract.policyRevision, 2)
})

test('approving a newer plan durably supersedes every lower pending contract revision', async () => {
  const { journal, storage, original, next } = await runningTwoStepPlan()
  await observeStarted(journal, 'run-1')
  const second = { ...original, revision: 2, digest: 'b'.repeat(64) }, third = { ...original, revision: 3, digest: 'c'.repeat(64) }
  await journal.offerCard({ ...plan, id: 'plan-2', contractDigest: second.digest, contract: second })
  await journal.offerCard({ ...plan, id: 'plan-3', contractDigest: third.digest, contract: third })
  await journal.decideCard({ ...click, cardId: 'plan-3', contractDigest: third.digest }, 300)
  const reopened = await open(storage)
  assert.ok(reopened.state.decidedCards.includes('plan-2:1'))
  await assert.rejects(reopened.decideCard({ ...click, cardId: 'plan-2', contractDigest: second.digest }, 300))
  assert.equal((await reopened.execute({ id: 'second', request: next, context, stepId: 'second' }, async () => ({ value: null,
    identity: { correlationId: 'second', runId: 'run-2', teamId: 'team-1' } }))).outcome, 'succeeded')
})

test('unapprovable plan revisions are refused at offer time without leaving a pending fence', async () => {
  for (const problem of ['old-revision', 'stale-policy', 'started-prefix', 'project']) {
    const { journal, original, next } = await runningTwoStepPlan()
    await observeStarted(journal, 'run-1')
    const revised = { ...original, revision: 2, digest: 'b'.repeat(64),
      ...(problem === 'old-revision' ? { revision: 1 } : problem === 'stale-policy' ? { policyRevision: 2 } :
        problem === 'project' ? { project: { ...contract.project, path: '/workspace/other' } } :
          { steps: [{ ...original.steps[0]!, title: 'Changed started work' }, original.steps[1]!] }) }
    await assert.rejects(journal.offerCard({ ...plan, revision: 2, contractDigest: revised.digest, contract: revised }))
    assert.equal((await journal.execute({ id: 'second', request: next, context, stepId: 'second' }, async () => ({ value: null,
      identity: { correlationId: 'second', runId: 'run-2', teamId: 'team-1' } }))).outcome, 'succeeded', problem)
  }
})

test('ordinary header-like ids and short token-like project names remain valid opaque fields', async () => {
  for (const field of ['assertion', 'step', 'project', 'source']) {
    const storage = memory(), journal = await open(storage)
    const approved = { ...contract,
      ...(field === 'assertion' ? { assertions: [{ ...contract.assertions[0]!, id: 'cookie:consent' }] } :
        field === 'step' ? { steps: [{ ...contract.steps[0]!, id: 'authorization:middleware' }] } :
          field === 'project' ? { project: { ...contract.project, path: '/workspace/ghs_tools_repo' } } :
            { steps: [{ ...contract.steps[0]!, sourceRevision: 'token=published-summary' }] }) }
    await journal.setPolicy(policy)
    const offered = await journal.offerCard({ ...plan, contract: approved })
    assert.deepEqual(offered.contract, approved)
    await initializeBudget(journal)
    await journal.decideCard(click, 200)
    assert.equal((await journal.execute({ id: 'first', context: { ...context, project: approved.project }, stepId: approved.steps[0]!.id,
      request: { ...request, project: approved.project, start: approved.steps[0], params: { ...request.params, root: approved.project.path } } },
      async () => ({ value: null, identity: { correlationId: 'first', runId: 'run-1', teamId: 'team-1' } }))).outcome, 'succeeded', field)
  }
})

test('pagination token names stay literal while credential-shaped pagination values still require a broker', async () => {
  const variables = { page_token: 'cursor-1', next_token: 'cursor-2', continuation_token: 'cursor-3', page_cursor: 'cursor-4', next_cursor: 'cursor-5', continuation_cursor: 'cursor-6' }
  for (const configured of [false, true]) {
    let calls = 0
    const journal = await open(memory(), configured ? { brokerReference: () => { calls++; return 'broker:must-not-be-used' } } : {})
    await journal.setPolicy(policy)
    const offered = await journal.offerCard({ ...plan, contract: { ...contract, steps: [{ ...contract.steps[0]!, variables }] } })
    assert.deepEqual(offered.contract.steps[0].variables, variables)
    assert.equal(calls, 0)
  }
  const journal = await open(memory())
  await journal.setPolicy(policy)
  await assert.rejects(journal.offerCard({ ...plan, contract: { ...contract, steps: [{ ...contract.steps[0]!, variables: { page_token: 'ghp_' + 'A'.repeat(36) } }] } }), /broker-reference/)
  await journal.stop()
})

test('historical unapprovable proposals remain dismissible after recovery', async () => {
  const { storage, original, next } = await runningTwoStepPlan()
  // Earlier writers admitted this same-contract revision. Loading the durable
  // proposal must still permit its decline; new offer calls refuse it up front.
  storage.records.push({ version: 1, seq: storage.records.length + 1, type: 'card', card: { ...plan, revision: 2, contract: original } })
  const journal = await open(storage)
  await observeStarted(journal, 'run-1')
  await journal.decideCard({ ...click, expectedRevision: 2, choice: 'decline' })
  assert.equal(journal.state.phase, 'running')
  assert.equal((await journal.execute({ id: 'second', request: next, context, stepId: 'second' }, async () => ({ value: null,
    identity: { correlationId: 'second', runId: 'run-2', teamId: 'team-1' } }))).outcome, 'succeeded')
})

test('declining the first plan remains a durable terminal decision', async () => {
  const storage = memory(), journal = await open(storage)
  await journal.setPolicy(policy)
  await journal.offerCard(plan)
  await journal.decideCard({ ...click, choice: 'decline' })
  const reopened = await open(storage)
  assert.equal(reopened.state.phase, 'declined')
  assert.equal(reopened.state.contract, null)
  assert.equal((await reopened.execute({ id: 'denied', request, context, stepId: 'implement' }, async () => { throw new Error('must not dispatch') })).outcome, 'denied')
})

for (const source of ['flow-seat-validator', 'raw-optional']) test(`undefined object properties from ${source} seats are omitted before offering approving and executing`, async () => {
  // agent/create uses flowSeatValidator directly; retain its actual returned seat.
  const parsed = parseClientMessage({ id: 1, method: 'agent/create', params: {
    name: 'Builder', ceiling: 'edit', seat: { runtime: 'fixture' }, to: 'user',
  } }) as any
  const seat = source === 'flow-seat-validator' ? parsed.params.seat : { runtime: 'fixture', model: undefined }
  assert.ok(Object.hasOwn(seat, 'model'))
  assert.equal(seat.model, undefined)
  const storage = memory(), journal = await open(storage)
  const proposed = { ...contract, steps: [{ ...contract.steps[0]!, assignments: [{ ...contract.steps[0]!.assignments[0]!, seat }] }] }
  await journal.setPolicy(policy)
  const offered = await journal.offerCard({ ...plan, contract: proposed })
  assert.deepEqual(offered.contract.steps[0].assignments[0].seat, { runtime: 'fixture' })
  await initializeBudget(journal)
  await journal.decideCard(click, 200)
  assert.equal((await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'first', runId: 'run-1', teamId: 'team-1' } }))).outcome, 'succeeded')
  assert.equal((await open(storage)).state.steps[0].state, 'started')
})

test('undefined array entries and holes remain refused without latching the writer', async () => {
  for (const assertions of [[undefined], new Array(1)]) {
    const storage = memory(), journal = await open(storage)
    await journal.setPolicy(policy)
    await assert.rejects(journal.offerCard({ ...plan, contract: { ...contract, assertions } }))
    await journal.stop()
    assert.equal((await open(storage)).state.phase, 'stopped')
  }
})

test('approval durably supersedes equal-revision sibling plans without a pending fence', async () => {
  const { journal, storage, original, next } = await runningTwoStepPlan()
  await observeStarted(journal, 'run-1')
  const revised = { ...original, revision: 3, digest: 'c'.repeat(64) }
  await journal.offerCard({ ...plan, id: 'plan-left', contractDigest: revised.digest, contract: revised })
  await journal.offerCard({ ...plan, id: 'plan-right', contractDigest: revised.digest, contract: revised })
  await journal.decideCard({ ...click, cardId: 'plan-right', contractDigest: revised.digest }, 300)
  const reopened = await open(storage)
  assert.ok(reopened.state.decidedCards.includes('plan-left:1'))
  assert.equal(reopened.state.phase, 'running')
  await assert.rejects(reopened.decideCard({ ...click, cardId: 'plan-left', contractDigest: revised.digest }, 300))
  assert.equal((await reopened.execute({ id: 'second', request: next, context, stepId: 'second' }, async () => ({ value: null,
    identity: { correlationId: 'second', runId: 'run-2', teamId: 'team-1' } }))).outcome, 'succeeded')
})

test('pagination prefixes never exempt credential variable names from brokering', async () => {
  const names = ['next_api_key', 'page_secret', 'next_password', 'page_access_token']
  for (const name of names) {
    const journal = await open(memory())
    await journal.setPolicy(policy)
    await assert.rejects(journal.offerCard({ ...plan, contract: { ...contract,
      steps: [{ ...contract.steps[0]!, variables: { [name]: 'SYNTHETIC_INPUT' } }] } }), /broker-reference/)
    await journal.stop()
  }
  const brokered: string[] = [], storage = memory()
  const journal = await open(storage, { digestContract: () => 'b'.repeat(64), brokerReference: (_value: string, name: string) => {
    brokered.push(name); return `broker:${name}`
  } })
  await journal.setPolicy(policy)
  const offered = await journal.offerCard({ ...plan, contract: { ...contract,
    steps: [{ ...contract.steps[0]!, variables: Object.fromEntries(names.map(name => [name, 'SYNTHETIC_INPUT'])) }] } })
  assert.deepEqual(brokered, names)
  assert.deepEqual(offered.contract.steps[0].variables, Object.fromEntries(names.map(name => [name, `broker:${name}`])))
  assert.ok(!JSON.stringify(storage.records).includes('SYNTHETIC_INPUT'))
})

test('execute captures caller attempt id and step id once at entry', async () => {
  const storage = memory(), journal = await prepare(storage)
  let idReads = 0, stepReads = 0
  const input = { request, context, get id() { return `attempt-${++idReads}` },
    get stepId() { return ++stepReads === 1 ? 'implement' : 'different-step' } }
  const result = journal.execute(input, async (_call: unknown, correlationId: string) => ({ value: null,
    identity: { correlationId, runId: 'run-1', teamId: 'team-1' } }))
  const entryReads = [idReads, stepReads]
  // Drain a failed old implementation too, so this probe never leaks a rejection.
  const outcome = await result.catch((error: unknown) => error)
  assert.deepEqual(entryReads, [1, 1])
  assert.deepEqual([idReads, stepReads], [1, 1])
  assert.equal(outcome.outcome, 'succeeded')
  const records = storage.records.filter(record => ['attempt', 'decision', 'dispatch-start', 'result'].includes(record.type))
  assert.deepEqual(records.map(record => record.id), Array(4).fill('attempt-1'))
  assert.equal(journal.state.steps[0].attemptId, 'attempt-1')
})

test('durable unknown spend overrides caller headroom and blocks mutation dispatch', async () => {
  const storage = memory(), journal = await prepare(storage)
  assert.equal(typeof journal.updateBudget, 'function')
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'goal-1', executionId: 'run-previous' })
  const result = await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => { throw new Error('must not dispatch') })
  assert.equal(result.outcome, 'denied')
  assert.equal(result.decision.floor, 'budget')
})

test('missing durable budget and invalid budget time refuse with four audit records', async () => {
  for (const state of ['missing', 'time']) {
    const storage = memory(), journal = await prepare(storage)
    const legacy = memory()
    legacy.records.push(...storage.records.filter(record => record.type !== 'budget').map((record, i) => ({ ...record, seq: i + 1 })))
    const writer = state === 'missing' ? await open(legacy) : journal
    if (state === 'time') {
      await writer.updateBudget({ version: 1, type: 'bind', now: 151, goalId: 'goal-1', executionId: 'run-previous' })
      await writer.updateBudget({ version: 1, type: 'observe', now: 151, at: 100, revision: 1, source: 'insight/goal', sourceIds: ['corpus-1'],
        goalId: 'goal-1', executionIds: ['run-previous'], quality: 'known', usdMicros: 0 })
    }
    const before = writer.state.seq
    const result = await writer.execute({ id: 'first', request, context: { ...context, now: state === 'time' ? 99 : 100 }, stepId: 'implement' },
      async () => { throw new Error('must not dispatch') })
    assert.equal(result.outcome, 'denied')
    assert.equal(result.decision.floor, 'budget')
    assert.equal(writer.state.seq, before + 4)
  }
})

const observeStarted = async (journal: any, runId: string, revision = 1) => {
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'goal-1', executionId: runId })
  await journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'goal-1', executionIds: journal.state.budget.executionIds, quality: 'known', usdMicros: 0 })
}

test('a start atomically admits its first round and unbound spend fences a second start', async () => {
  const { journal, next } = await runningTwoStepPlan()
  assert.equal(journal.state.budget.roundsAdmitted, 1)
  assert.equal(journal.state.budget.spend, 'unknown')
  const result = await journal.execute({ id: 'second', request: next, context, stepId: 'second' }, async () => { throw new Error('must not dispatch') })
  assert.equal(result.decision.floor, 'budget')
})

for (const moneyStop of [false, true]) test(`cap-one reviewed result accepts after ${moneyStop ? 'money stop' : 'its admitted round'} without new work`, async () => {
  const storage = memory(), journal = await open(storage)
  const approved = { ...contract, caps: { usdMicros: 500, rounds: 1 }, steps: [...contract.steps, { ...contract.steps[0]!, id: 'second' }] }
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: approved.caps, freshnessMs: 50 })
  await journal.offerCard({ ...plan, contract: approved })
  await journal.decideCard(click, 200)
  assert.equal((await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'first', runId: 'run-1', teamId: 'team-1' } }))).outcome, 'succeeded')
  await observeStarted(journal, 'run-1')
  const refused = await journal.execute({ id: 'second-before-result', request: { ...request, start: approved.steps[1]! }, context, stepId: 'second' },
    async () => { throw new Error('round two must not dispatch') })
  assert.equal(refused.decision.floor, 'budget')
  await journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'review', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
  if (moneyStop) await journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 0, rounds: 1 } })
  await journal.offerCard({ version: 1, id: 'result-1', revision: 1, type: 'result', contractDigest: approved.digest,
    outcome: 'reviewed', summary: 'Reviewed result', assertions: [], budget: lead.leadBudgetProjection(journal.state.budget, 100) })
  await journal.decideCard({ version: 1, cardId: 'result-1', cardType: 'result', expectedRevision: 1, contractDigest: approved.digest, choice: 'accept' })
  assert.equal(journal.state.phase, 'accepted')
  assert.equal((await journal.execute({ id: 'second', request: { ...request, start: approved.steps[1]! }, context, stepId: 'second' },
    async () => { throw new Error('must not dispatch') })).outcome, 'denied')
})

for (const via of ['budget-card', 'plan']) test(`${via} increase updates the effective permission cap while preserving start authority`, async () => {
  const { journal, original, next } = await runningTwoStepPlan()
  await observeStarted(journal, 'run-1')
  const caps = { usdMicros: 700, rounds: 4 }
  if (via === 'budget-card') {
    const card = await journal.changeBudgetCaps(caps, { id: 'raise', revision: 1 }, 100)
    await journal.decideCard({ version: 1, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' })
  } else {
    const revised = { ...original, revision: 2, digest: 'b'.repeat(64), caps }
    await journal.offerCard({ ...plan, revision: 2, contractDigest: revised.digest, contract: revised })
    await journal.decideCard({ ...click, expectedRevision: 2, contractDigest: revised.digest }, 200)
  }
  assert.deepEqual(journal.state.budget.caps, caps)
  assert.equal((await journal.execute({ id: 'second', request: next, context, stepId: 'second' }, async () => ({ value: null,
    identity: { correlationId: 'second', runId: 'run-2', teamId: 'team-1' } }))).outcome, 'succeeded')
})

test('processed budget time cannot roll consent back to an unexpired instant', async () => {
  const journal = await prepare(memory())
  await journal.updateBudget({ version: 1, type: 'bind', now: 250, goalId: 'goal-1', executionId: 'run-previous' })
  await journal.updateBudget({ version: 1, type: 'observe', now: 250, at: 250, revision: 1, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'goal-1', executionIds: ['run-previous'], quality: 'known', usdMicros: 0 })
  const result = await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'first', runId: 'run-1', teamId: 'team-1' } }))
  assert.equal(result.decision.floor, 'consent')
})

test('budget-stop result acceptance never reverses a terminal person decline', async () => {
  const journal = await prepare(memory())
  await journal.offerCard({ version: 1, id: 'waiting-1', revision: 1, type: 'waiting', contractDigest: contract.digest,
    kind: 'person', runId: 'run-1', personCardId: 'gate-1', summary: 'Person decision', assertions: [] })
  await journal.decideCard({ version: 1, cardId: 'waiting-1', cardType: 'waiting', expectedRevision: 1, contractDigest: contract.digest, choice: 'decline' })
  await journal.offerCard({ version: 1, id: 'reviewed-1', revision: 1, type: 'result', contractDigest: contract.digest,
    outcome: 'reviewed', summary: 'Reviewed result', assertions: [], budget: lead.leadBudgetProjection(journal.state.budget, 100) })
  await journal.decideCard({ version: 1, cardId: 'reviewed-1', cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' })
  assert.equal(journal.state.phase, 'declined')
})
