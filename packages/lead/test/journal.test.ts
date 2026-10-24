import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage, parseLeadAcceptanceContract, parseLeadPermissionPolicy } from '@harnessdesk/protocol'
import * as lead from '../src/index.js'

const runEvidence = (identity: lead.LeadRunIdentity, terminal = false): lead.LeadRunObservation => ({ ...identity, firstRoundId: '1', terminal })

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

test('refreshes with no outstanding result do not keep journaling invalidations', async () => {
  const journal = await prepare(memory()), seq = journal.state.seq
  await journal.invalidateResults(); await journal.invalidateResults()
  assert.equal(journal.state.seq, seq)
  await journal.offerCard({ version: 1, id: 'result', revision: 1, type: 'result', contractDigest: contract.digest,
    outcome: 'reviewed', summary: 'Reviewed', assertions: [], budget: lead.leadBudgetProjection(journal.state.budget!, 100) })
  await journal.invalidateResults()
  const invalidated = journal.state.seq
  await journal.invalidateResults(); await journal.invalidateResults()
  assert.equal(journal.state.seq, invalidated)
})

test('a failed person save protects its exact result until fresh retry validation refuses it', async () => {
  const journal = await prepare(memory())
  const card = { version: 1, id: 'result', revision: 1, type: 'result', contractDigest: contract.digest,
    outcome: 'reviewed', summary: 'Reviewed', assertions: [], budget: lead.leadBudgetProjection(journal.state.budget!, 100) }
  await journal.offerCard(card)
  const decision = { version: 1, cardId: card.id, cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' }
  await assert.rejects(journal.decideCard(decision, null, undefined, async () => {
    throw Object.assign(new Error('save refused'), { wireCode: 'lead-gate-save-failed' })
  }))
  await journal.invalidateResults()
  assert.equal(journal.state.decidedCards.includes('result:1'), false)
  await assert.rejects(journal.offerCard({ ...card, revision: 2 }), { wireCode: 'lead-card-stale' })
  await assert.rejects(journal.decideCard(decision, null, undefined, async () => {
    throw Object.assign(new Error('gate changed'), { wireCode: 'lead-gate-changed' })
  }))
  assert.equal(journal.state.decidedCards.includes('result:1'), true)
  await journal.offerCard({ ...card, revision: 2 })
  assert.equal(journal.state.cards.find((value: any) => value.id === card.id)!.revision, 2)
})

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
  const actions = await recovered.recover(async (attempt: any) => (attempt.correlationId === identity.correlationId ? [identity] : []).map(identity => runEvidence(identity)))
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
    const recovered = await open(storage), actions = await recovered.recover(async () => (proof === null ? [] : [proof]).map(identity => runEvidence(identity)))
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
  // An approved step starts in default mode; the person's own ask rule still asks.
  await journal.setPolicy({ ...policy, revision: 2, mode: 'default', rules: [{ id: 'ask-start', method: 'flow/start-goal', action: null, project: null, effect: 'ask' }] })
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
    const result = await recovered.recover(async () => (matches).map(identity => runEvidence(identity)))
    assert.equal(result[0].type, count === 1 ? 'reconciled' : 'needs-user')
    assert.equal(result[0].count, count)
    const seq = recovered.state.seq
    assert.deepEqual(await recovered.recover(async () => (matches).map(identity => runEvidence(identity))), [])
    assert.equal(recovered.state.seq, seq)
    assert.deepEqual(await (await open(storage)).recover(async () => (matches).map(identity => runEvidence(identity))), [])
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
  assert.equal((await recovered.execute({ id: 'start-2', request: { ...request, start: second }, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => { throw new Error('must not start') })).decision.effect, 'deny')
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
  await journal.execute({ id: 'second', request: { ...request, start: second }, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => { throw new Error('lost response') })
  const actions = await journal.recover(async () => ([{ correlationId: 'second', runId: 'run-1', teamId: 'team-1' }]).map(identity => runEvidence(identity)))
  assert.deepEqual(actions.map((action: any) => [action.id, action.type]), [['second', 'needs-user']])
  assert.equal(journal.state.budget.stop.reason, 'unknown-spend')
  assert.deepEqual(journal.state.runs, [{ correlationId: 'first', runId: 'run-1', teamId: 'team-1' }])
  await assert.rejects(journal.resolveStart('second', null), 'a contested start cannot be attested as never started')
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
  await journal.recover(async () => ([{ correlationId: 'first', runId: 'run-1', teamId: 'team-1' }]).map(identity => runEvidence(identity)))
  await observeStarted(journal, 'run-1')
  const nextRequest = { ...request, start: second }
  const blocked = await journal.execute({ id: 'blocked', request: nextRequest, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => { throw new Error('must not dispatch') })
  assert.equal(blocked.outcome, 'denied', 'a pending plan is independent of phase')
  await journal.decideCard({ ...click, expectedRevision: 2, contractDigest: revised.digest }, 300)
  assert.equal(journal.state.steps[0].state, 'started')
  assert.deepEqual(journal.state.runs, [{ correlationId: 'first', runId: 'run-1', teamId: 'team-1' }])
  assert.equal(journal.state.contract.digest, revised.digest)
  assert.equal((await journal.execute({ id: 'second', request: { ...nextRequest, start: updatedSecond,
    params: { ...request.params, sentence: revised.goal, vars: updatedSecond.variables } }, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } },
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
  assert.equal((await reopened.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => ({ value: null,
    identity: { correlationId: 'second', runId: 'run-2', teamId: 'team-1' } }))).outcome, 'succeeded')
})

test('a plan made stale by a later policy change can be declined without ending the thread', async () => {
  const { journal, original } = await runningTwoStepPlan()
  const revised = { ...original, revision: 2, digest: 'b'.repeat(64) }
  await journal.offerCard({ ...plan, revision: 2, contractDigest: revised.digest, contract: revised })
  await journal.setPolicy({ ...policy, revision: 2, rules: [{ id: 'tighten-read', method: 'library/usage', effect: 'deny', action: null, project: null }] })
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
  assert.equal((await reopened.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => ({ value: null,
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
    assert.equal((await journal.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => ({ value: null,
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
  assert.equal((await journal.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => ({ value: null,
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
  assert.equal((await reopened.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => ({ value: null,
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
  const startId = journal.state.runs.find((run: any) => run.runId === runId).correlationId
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: runId, startId, firstRoundId: '1' })
  await journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'team-1', executionIds: journal.state.budget.executionIds, quality: 'known', usdMicros: 0 })
}

test('a start atomically admits its first round and unbound spend fences a second start', async () => {
  const { journal, next } = await runningTwoStepPlan()
  assert.equal(journal.state.budget.roundsAdmitted, 1)
  assert.equal(journal.state.budget.spend, 'unknown')
  const result = await journal.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => { throw new Error('must not dispatch') })
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
  const refused = await journal.execute({ id: 'second-before-result', request: { ...request, start: approved.steps[1]! }, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } },
    async () => { throw new Error('round two must not dispatch') })
  assert.equal(refused.decision.floor, 'budget')
  await assert.rejects(journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'review', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 }))
  assert.equal(journal.state.budget!.requests.length, 0, 'human acceptance needs no paid request at the round cap')
  if (moneyStop) await journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 0, rounds: 1 } })
  await journal.offerCard({ version: 1, id: 'result-1', revision: 1, type: 'result', contractDigest: approved.digest,
    outcome: 'reviewed', summary: 'Reviewed result', assertions: [], budget: lead.leadBudgetProjection(journal.state.budget, 100) })
  await journal.decideCard({ version: 1, cardId: 'result-1', cardType: 'result', expectedRevision: 1, contractDigest: approved.digest, choice: 'accept' })
  assert.equal(journal.state.phase, 'accepted')
  assert.equal((await journal.execute({ id: 'second', request: { ...request, start: approved.steps[1]! }, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } },
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
  assert.equal((await journal.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => ({ value: null,
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


const checkpointOpen = async (journal: any) => {
  const { state } = lead.parseLeadCheckpoint(lead.leadCheckpoint(journal.state, 'a'.repeat(64)))
  return lead.createLeadJournal({ async read() { return [] }, async append() {}, checkpoint() { return state } })
}

for (const duringCleanup of [false, true]) test(`reconciled work re-arms stop generation ${duringCleanup ? 'during cleanup' : 'after acknowledgement and checkpoint'}`, async () => {
  const journal = await prepare(memory())
  await journal.execute({ id: 'lost', request, context, stepId: 'implement' }, async () => { throw new Error('lost response') })
  await journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 0, rounds: 3 } })
  const firstGeneration = journal.state.stopEffectsPending
  let writer: any = journal
  if (!duringCleanup) {
    await journal.runStopEffects(async () => {})
    writer = await checkpointOpen(journal)
  }
  const discover = () => writer.recover(async () => ([{ correlationId: 'lost', runId: 'live', teamId: 'team-1' }]).map(identity => runEvidence(identity)))
  if (duringCleanup) await writer.runStopEffects(discover)
  else await discover()
  assert.ok(writer.state.stopEffectsPending > firstGeneration)
  writer = await checkpointOpen(writer)
  assert.ok(writer.state.stopEffectsPending)
  await writer.runStopEffects(async () => {})
  assert.equal(writer.state.stopEffectsPending, null)
  await writer.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'other-live' })
  assert.ok(writer.state.stopEffectsPending, 'a new budget binding also needs cancellation acknowledgement')
})

test('late spend cannot revive a declined thread through a reviewed result or checkpoint', async () => {
  const journal = await prepare(memory())
  await journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'paid', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 0, cacheWriteUsdMicrosPerMillion: 0 })
  await journal.offerCard({ version: 1, id: 'waiting-1', revision: 1, type: 'waiting', contractDigest: contract.digest,
    kind: 'person', runId: 'run-1', personCardId: 'gate-1', summary: 'Person decision', assertions: [] })
  await journal.decideCard({ version: 1, cardId: 'waiting-1', cardType: 'waiting', expectedRevision: 1, contractDigest: contract.digest, choice: 'decline' })
  await journal.updateBudget({ version: 1, type: 'settle', now: 100, requestId: 'paid', inputTokens: 500, outputTokens: 0 })
  assert.equal(journal.state.phase, 'declined')
  const restored: any = await checkpointOpen(journal)
  await restored.offerCard({ version: 1, id: 'reviewed-1', revision: 1, type: 'result', contractDigest: contract.digest,
    outcome: 'reviewed', summary: 'Reviewed result', assertions: [], budget: lead.leadBudgetProjection(restored.state.budget, 100) })
  await restored.decideCard({ version: 1, cardId: 'reviewed-1', cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' })
  assert.equal(restored.state.phase, 'declined')
})

test('a definite start refusal releases its placeholder and permits a new attempt', async () => {
  const journal = await prepare(memory())
  const result = await journal.execute({ id: 'refused', request, context, stepId: 'implement' }, async () => ({ created: false, value: 'host refusal', identity: null }))
  assert.equal(result.outcome, 'failed')
  assert.equal(journal.state.budget.roundsAdmitted, 0)
  assert.equal(journal.state.budget.spend, 'known')
  const restored: any = await checkpointOpen(journal)
  assert.equal((await restored.execute({ id: 'retry', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'retry', runId: 'run-1', teamId: 'team-1' } }))).outcome, 'succeeded')
})

for (const found of [false, true]) test(`window start resolution durably ${found ? 'binds the proven run' : 'releases a no-run placeholder'}`, async () => {
  const storage = memory(), journal = await prepare(storage)
  await journal.execute({ id: 'lost', request, context, stepId: 'implement' }, async () => { throw new Error('lost response') })
  await journal.recover(async () => [])
  const reserve = { version: 1, type: 'reserve', now: 100, requestId: 'explain', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 0, cacheWriteUsdMicrosPerMillion: 0 }
  await assert.rejects(journal.updateBudget(reserve))
  assert.equal(journal.state.attempts.get('lost').outcome, 'uncertain')
  assert.equal(typeof journal.resolveStart, 'function')
  await assert.rejects(journal.resolveStart('lost', { goalId: 'goal-1', identity: { correlationId: 'wrong', runId: 'run-1', teamId: 'team-1' } }))
  if (found) await journal.recover(async () => ([{ correlationId: 'lost', runId: 'run-1', teamId: 'team-1' }]).map(identity => runEvidence(identity)))
  await journal.resolveStart('lost', found ? { goalId: 'team-1', identity: { correlationId: 'lost', runId: 'run-1', teamId: 'team-1' } } : null)
  const restored: any = await checkpointOpen(await open(storage))
  assert.equal(restored.state.attempts.get('lost').outcome, found ? 'succeeded' : 'failed')
  assert.equal(restored.state.steps[0].state, found ? 'started' : 'pending')
  assert.equal(restored.state.budget.roundsAdmitted, found ? 1 : 0)
  if (found) {
    assert.deepEqual(restored.state.budget.executionIds, ['run-1'])
    assert.equal(restored.state.budget.spend, 'unknown', 'bound work still needs an observation')
  } else {
    assert.equal(restored.state.budget.spend, 'known')
    await restored.updateBudget(reserve)
  }
  await assert.rejects(restored.resolveStart('lost', null))
  assert.equal((await restored.recover(async () => [])).length, 0)
})


test('above-range reported usage denies the next Flow instead of retaining known headroom', async () => {
  const journal = await open(memory())
  const approved = { ...contract, caps: { usdMicros: 1_000_000_000_000, rounds: 3 } }
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: approved.caps, freshnessMs: 50 })
  await journal.offerCard({ ...plan, contract: approved })
  await journal.decideCard(click, 200)
  await journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'paid', inputTokens: 999_999, maxOutputTokens: 0,
    inputUsdMicrosPerMillion: 1_000_000_000_000, outputUsdMicrosPerMillion: 0, cacheReadUsdMicrosPerMillion: 0, cacheWriteUsdMicrosPerMillion: 0 })
  await journal.updateBudget({ version: 1, type: 'settle', now: 100, requestId: 'paid', inputTokens: 1_000_001, outputTokens: 0 })
  let calls = 0
  const result = await journal.execute({ id: 'next', request, context, stepId: 'implement' }, async () => { calls++; return { value: null, identity: null } })
  assert.equal(result.outcome, 'denied')
  assert.equal(calls, 0)
  assert.equal(journal.state.budget.spend, 'unknown')
})

test('start resolution records reject mismatched nullable fields and unknown fields', () => {
  const record = { version: 1, seq: 1, type: 'start-resolution', id: 'lost', identity: null, goalId: null, evidenceSeq: 1 }
  assert.deepEqual(lead.parseLeadJournalRecord(record), record)
  for (const patch of [{ goalId: 'goal-1' }, { identity: { correlationId: 'lost', runId: 'run-1', teamId: 'team-1' } },
    { extra: true }, { id: '' }]) assert.throws(() => lead.parseLeadJournalRecord({ ...record, ...patch }))
})


const lostStart = async () => {
  const storage = memory(), journal = await prepare(storage)
  await journal.execute({ id: 'lost', request, context, stepId: 'implement' }, async () => { throw new Error('lost response') })
  return { storage, journal }
}
const witnessed = (runId = 'run-a', teamId = 'team-1') => ({ correlationId: 'lost', runId, teamId })

for (const value of [{}, false, 'no run', undefined, { identity: null, goalId: null }, []]) test(`malformed start resolution ${JSON.stringify(value)} cannot attest no run`, async () => {
  const { journal } = await lostStart()
  await journal.recover(async () => [])
  const before = journal.state.seq
  await assert.rejects(journal.resolveStart('lost', value))
  assert.equal(journal.state.seq, before)
  assert.equal(journal.state.budget.roundsAdmitted, 1)
  assert.equal(journal.state.budget.spend, 'unknown')
  await journal.resolveStart('lost', null)
  await journal.stop()
})

test('omitted start resolution is refused without latching the writer', async () => {
  const { journal } = await lostStart()
  await journal.recover(async () => [])
  await assert.rejects(journal.resolveStart('lost'))
  await journal.stop()
})

for (const probe of [
  { name: '3 foreign goal and Team', goalId: 'goal-OTHER', identity: witnessed('run-x', 'team-FOREIGN') },
  { name: '3e unobserved run and Team', goalId: 'team-ZZ', identity: witnessed('run-z', 'team-ZZ') },
]) test(`resolution probe ${probe.name} cannot invent host evidence`, async () => {
  const { journal } = await lostStart()
  await journal.recover(async () => [])
  const before = journal.state
  await assert.rejects(journal.resolveStart('lost', { goalId: probe.goalId, identity: probe.identity }))
  assert.deepEqual(journal.state, before)
  await journal.stop()
})

for (const release of [true, false]) test(`two-run evidence refuses probe ${release ? '3c release' : '3d partial binding'} across checkpoint and reopen`, async () => {
  const { storage, journal } = await lostStart()
  const identities = [witnessed('run-a'), witnessed('run-b')]
  await journal.recover(async () => (identities).map(identity => runEvidence(identity)))
  const restored: any = await checkpointOpen(await open(storage))
  await assert.rejects(restored.resolveStart('lost', release ? null : { goalId: 'team-1', identity: identities[0] }))
  assert.equal(restored.state.budget.roundsAdmitted, 2)
  assert.equal(restored.state.budget.spend, 'unknown')
  assert.deepEqual(restored.state.runs, identities)
  let calls = 0
  assert.equal((await restored.execute({ id: 'duplicate-start', request, context, stepId: 'implement' }, async () => { calls++; return { value: null, identity: null } })).outcome, 'denied')
  assert.equal(calls, 0)
  const cancellation = await restored.execute({ id: 'cancel-extra', request: { ...request, method: 'flow/execution/stop',
    params: { run: 'run-b', reason: 'Resolve duplicate start' }, runId: 'run-b', start: null }, context },
    async () => ({ value: null, identity: null }))
  assert.equal(cancellation.outcome, 'succeeded')
  // The trusted host now proves that the extra execution has stopped.
  assert.equal((await restored.recover(async () => [runEvidence(identities[0]!), runEvidence(identities[1]!, true)]))[0].type, 'reconciled')
  const teamsBefore = restored.state.teams
  await restored.resolveStart('lost', { goalId: 'team-1', identity: identities[0] })
  assert.deepEqual(restored.state.teams, teamsBefore)
  assert.deepEqual(restored.state.budget.executionIds, ['run-a', 'run-b'])
  assert.equal(restored.state.budget.spend, 'unknown', 'a newly bound run still needs reported usage')
})

test('a proven resolution matches the existing budget Goal and the witnessed Team', async () => {
  const { journal } = await lostStart()
  const identity = witnessed()
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'earlier-run' })
  await journal.recover(async () => ([identity]).map(identity => runEvidence(identity)))
  const before = journal.state
  await assert.rejects(journal.resolveStart('lost', { goalId: 'goal-OTHER', identity }))
  await assert.rejects(journal.resolveStart('lost', { goalId: 'team-1', identity: witnessed('run-z') }))
  assert.deepEqual(journal.state, before)
  await journal.resolveStart('lost', { goalId: 'team-1', identity })
  assert.deepEqual(journal.state.teams, before.teams)
  assert.equal(journal.state.budget.goalId, 'team-1')
})

test('a witnessed Team cannot be bound to a different already-bound Goal', async () => {
  const { journal } = await lostStart()
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-existing', executionId: 'earlier-run' })
  const identity = witnessed()
  const actions = await journal.recover(async () => [runEvidence(identity)])
  assert.deepEqual(actions.map((action: any) => [action.id, action.type]), [['lost', 'needs-user']])
  assert.equal(journal.state.budget.stop.reason, 'unknown-spend')
  assert.ok(!journal.state.runs.some((run: any) => run.runId === identity.runId), 'a run on another Goal is never bound')
  await assert.rejects(journal.resolveStart('lost', { goalId: 'team-1', identity }))
  await assert.rejects(journal.resolveStart('lost', null), 'a contested start cannot be attested as never started')
  await journal.stop()
})

test('a start resolution records exactly the reconciliation sequence it answered', async () => {
  const { storage, journal } = await lostStart()
  await journal.recover(async () => [])
  const evidenceSeq = storage.records.at(-1).seq
  await journal.resolveStart('lost', null)
  assert.equal(storage.records.at(-1).evidenceSeq, evidenceSeq)
  const restored: any = await checkpointOpen(await open(storage))
  assert.equal(restored.state.attempts.get('lost').evidenceSeq, evidenceSeq)
})


test('a stale window resolution cannot answer a newer reconciliation with the same count', async () => {
  const { storage, journal } = await lostStart()
  await journal.recover(async () => [])
  const stale = storage.records.at(-1).seq
  await journal.recover(async () => ([witnessed('run-a'), witnessed('run-b')]).map(identity => runEvidence(identity)))
  await journal.recover(async () => [runEvidence(witnessed('run-a'), true), runEvidence(witnessed('run-b'), true)])
  await journal.recover(async () => [])
  await assert.rejects(journal.resolveStart('lost', null, stale))
  assert.equal(journal.state.budget.roundsAdmitted, 2)
  const current = storage.records.at(-1).seq
  await journal.resolveStart('lost', null, current)
  assert.equal(storage.records.at(-1).evidenceSeq, current)
})


test('stopped duplicate runs keep accounting history after no-run resolution and checkpoint', async () => {
  const { journal } = await lostStart()
  const matches = [witnessed('run-a'), witnessed('run-b')]
  await journal.recover(async () => (matches).map(identity => runEvidence(identity)))
  for (const run of matches) await journal.execute({ id: `stop-${run.runId}`, request: { ...request, method: 'flow/execution/stop',
    params: { run: run.runId, reason: 'Stop duplicate work' }, runId: run.runId, start: null }, context }, async () => ({ value: null, identity: null }))
  await journal.recover(async () => matches.map(identity => runEvidence(identity, true)))
  await journal.recover(async () => [])
  await journal.resolveStart('lost', null)
  const restored: any = await checkpointOpen(journal)
  let starts = 0
  assert.equal((await restored.execute({ id: 'before-coverage', request, context, stepId: 'implement' }, async () => { starts++; return { value: null, identity: null } })).outcome, 'denied')
  assert.equal(starts, 0)
  assert.equal(restored.state.budget.roundsAdmitted, 2)
  assert.deepEqual(restored.state.budget.executionIds, ['run-a', 'run-b'])
  assert.notEqual(restored.state.budget.spend, 'known')
  await assert.rejects(restored.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'review', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 1, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 1 }))
  await restored.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'team-1', executionIds: ['run-a'], quality: 'known', usdMicros: 20 })
  assert.notEqual(restored.state.budget.spend, 'known')
  await restored.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 2, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'team-1', executionIds: ['run-a', 'run-b'], quality: 'known', usdMicros: 30 })
  assert.equal(restored.state.budget.spend, 'known')
  assert.equal(restored.state.budget.roundsAdmitted, 2)
  for (let i = 0; i < 70; i++) await restored.execute({ id: `history-read-${i}`, request: { ...request, method: 'library/usage', params: {}, start: null }, context },
    async () => ({ value: null, identity: null }))
  assert.ok(!restored.state.attempts.has('lost'), 'resolved terminal attempts can leave the recent index')
  await assert.rejects(restored.execute({ id: 'lost', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'lost', runId: 'run-reused', teamId: 'team-1' } })), /duplicate-attempt/)
  assert.equal((await restored.execute({ id: 'after-coverage', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'after-coverage', runId: 'run-c', teamId: 'team-1' } }))).outcome, 'succeeded')
  assert.equal(restored.state.budget.roundsAdmitted, 3)
})

test('a missing live run remains tracked until the host explicitly reports it terminal', async () => {
  const { journal } = await lostStart()
  const matches = [witnessed('run-a'), witnessed('run-b')]
  await journal.recover(async () => (matches).map(identity => runEvidence(identity)))
  await journal.recover(async () => ([matches[0]!]).map(identity => runEvidence(identity)))
  assert.deepEqual(journal.state.runs, matches)
  await assert.rejects(journal.resolveStart('lost', { goalId: 'team-1', identity: matches[0] }))
  await journal.recover(async () => [])
  await assert.rejects(journal.resolveStart('lost', null))
})

test('unresolved accounting evidence survives 70 status reads checkpoint and valid resolution', async () => {
  const { journal } = await lostStart()
  const identity = witnessed()
  await journal.recover(async () => ([identity]).map(identity => runEvidence(identity)))
  const evidenceSeq = journal.state.attempts.get('lost').evidenceSeq
  for (let i = 0; i < 70; i++) await journal.execute({ id: `retained-read-${i}`, request: { ...request, method: 'library/usage', params: {}, start: null }, context },
    async () => ({ value: null, identity: null }))
  const restored: any = await checkpointOpen(journal)
  assert.ok(restored.state.attempts.has('lost'))
  assert.equal(restored.state.attempts.get('lost').evidenceSeq, evidenceSeq)
  await restored.resolveStart('lost', { goalId: 'team-1', identity }, evidenceSeq)
  assert.equal(restored.state.budget.roundsAdmitted, 1)
})

test('an inferred start binding requires first-round proof as an explicit binding does', async () => {
  const { journal } = await runningTwoStepPlan()
  await assert.rejects(journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-1' }))
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-1', startId: 'first', firstRoundId: '1' })
})


test('history exhaustion records execution 101 and its stop atomically across checkpoint', async () => {
  const storage = memory(), journal = await open(storage)
  const expanded = { ...contract, caps: { ...contract.caps, rounds: 100 } }
  await journal.setPolicy(policy)
  await journal.offerCard({ ...plan, contract: expanded })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: expanded.caps, freshnessMs: 50 })
  await journal.decideCard(click, 200)
  const start = (id: string) => journal.execute({ id, request, context, stepId: 'implement' }, async () => { throw new Error('lost response') })
  const group = (correlationId: string, count: number, offset: number) => Array.from({ length: count }, (_, i) =>
    runEvidence({ correlationId, runId: `run-${offset + i + 1}`, teamId: 'team-1' }))
  await start('first-64')
  const first = group('first-64', 64, 0)
  await journal.recover(async () => first)
  await journal.recover(async () => first.map(run => ({ ...run, terminal: true })))
  await journal.resolveStart('first-64', null)
  await journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'team-1', executionIds: first.map(run => run.runId), quality: 'known', usdMicros: 0 })
  await start('next-36')
  const second = group('next-36', 36, 64)
  await journal.recover(async (attempt: any) => attempt.id === 'next-36' ? second : [])
  await journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 2, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'team-1', executionIds: [...first, ...second].map(run => run.runId), quality: 'known', usdMicros: 0 })
  assert.equal(journal.state.budget.spend, 'known')
  assert.equal(journal.state.budget.roundsAdmitted, 100)
  const { state } = lead.parseLeadCheckpoint(lead.leadCheckpoint(journal.state, 'a'.repeat(64)))
  const tail = memory()
  const writer = await lead.createLeadJournal({ ...tail, checkpoint() { return state } })
  await writer.recover(async attempt => attempt.id === 'next-36' ? [...second, ...group('next-36', 1, 100)] : [])
  assert.equal(tail.records.length, 1, 'evidence, incomplete accounting and stop share one reconciliation record')
  assert.equal(tail.records[0].type, 'reconciliation')
  const restored: any = await checkpointOpen(await lead.createLeadJournal({ ...tail, checkpoint() { return state } }))
  assert.equal(restored.state.budget.spend, 'unknown')
  assert.ok(restored.state.budget.stop)
  assert.ok(restored.state.stopEffectsPending)
  assert.ok(restored.state.runs.some((run: any) => run.runId === 'run-101'))
  await restored.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 3, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'team-1', executionIds: restored.state.budget.executionIds, quality: 'known', usdMicros: 0 })
  assert.equal(restored.state.budget.spend, 'unknown', 'coverage of the retained index cannot repair exhausted accounting')
  let cancelled = false
  assert.equal((await restored.execute({ id: 'cancel-101', request: { ...request, method: 'flow/execution/stop',
    params: { run: 'run-101', reason: 'Stop discovered work' }, runId: 'run-101', start: null }, context }, async () => {
    cancelled = true; return { value: null, identity: null }
  })).outcome, 'succeeded')
  assert.equal(cancelled, true)
  await assert.rejects(restored.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'paid', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 1, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 1 }))
})

test('conflicting evidence needs the user while another attempt still recovers', async () => {
  const { journal, next } = await runningTwoStepPlan()
  await observeStarted(journal, 'run-1')
  await journal.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => { throw new Error('lost response') })
  await journal.recover(async (attempt: any) => attempt.id === 'first'
    ? [runEvidence({ correlationId: 'first', runId: 'run-1', teamId: 'team-1' })] : [])
  const actions = await journal.recover(async (attempt: any) => attempt.id === 'first'
    ? [{ ...runEvidence({ correlationId: 'first', runId: 'run-1', teamId: 'team-1' }), firstRoundId: 'conflicting' }]
    : [runEvidence({ correlationId: 'second', runId: 'run-2', teamId: 'team-1' })])
  assert.deepEqual(actions.map((action: any) => [action.id, action.type]), [['first', 'needs-user'], ['second', 'reconciled']])
  const restored: any = await checkpointOpen(journal)
  assert.equal(restored.state.attempts.get('first').outcome, 'uncertain')
  assert.equal(restored.state.attempts.get('first').resolutionPending, true)
  assert.equal(restored.state.attempts.get('second').outcome, 'succeeded')
  assert.ok(restored.state.runs.some((run: any) => run.runId === 'run-2'))
})

test('evidence beyond its row bound latches an unknown-spend stop and keeps live work cancellable', async () => {
  const storage = memory(), journal = await open(storage)
  const expanded = { ...contract, caps: { ...contract.caps, rounds: 100 } }
  await journal.setPolicy(policy)
  await journal.offerCard({ ...plan, contract: expanded })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: expanded.caps, freshnessMs: 50 })
  await journal.decideCard(click, 200)
  await journal.execute({ id: 'wide', request, context, stepId: 'implement' }, async () => { throw new Error('lost response') })
  const runs = Array.from({ length: 64 }, (_, i) => runEvidence({ correlationId: 'wide', runId: `run-${i + 1}`, teamId: 'team-1' }))
  await journal.recover(async () => runs)
  await journal.recover(async () => runs.map((run, i) => ({ ...run, terminal: i < 63 })))
  await journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'team-1', executionIds: runs.map(run => run.runId), quality: 'known', usdMicros: 0 })
  assert.equal(journal.state.budget.spend, 'known')
  const lookup = async () => [runs[63]!, runEvidence({ correlationId: 'wide', runId: 'run-65', teamId: 'team-1' })]
  await journal.recover(lookup)
  const restored: any = await checkpointOpen(journal)
  for (const state of [journal.state, restored.state]) {
    assert.equal(state.budget.stop.reason, 'unknown-spend')
    assert.equal(state.budget.spend, 'unknown')
    assert.ok(state.stopEffectsPending)
    assert.deepEqual(state.runs.map((run: any) => run.runId).sort(), ['run-64', 'run-65'])
  }
  await assert.rejects(restored.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'paid', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 1, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 1 }))
  const seq = journal.state.seq
  await journal.recover(lookup)
  assert.equal(journal.state.seq, seq, 'the same oversized lookup appends nothing again')
})

test('a conflict records the rest of its lookup, latches once and appends nothing while it stands', async () => {
  const { journal } = await runningTwoStepPlan()
  await observeStarted(journal, 'run-1')
  const run = { correlationId: 'first', runId: 'run-1', teamId: 'team-1' }
  await journal.recover(async () => [runEvidence(run)])
  const lookup = async (attempt: any) => attempt.id === 'first'
    ? [{ ...runEvidence(run), firstRoundId: 'conflicting' }, runEvidence({ ...run, runId: 'run-new' })] : []
  const actions = await journal.recover(lookup)
  assert.deepEqual(actions.map((action: any) => [action.id, action.type]), [['first', 'needs-user']])
  const restored: any = await checkpointOpen(journal)
  for (const state of [journal.state, restored.state]) {
    assert.ok(state.runs.some((item: any) => item.runId === 'run-new'), 'the rest of the lookup is recorded for cancellation')
    assert.equal(state.budget.stop.reason, 'unknown-spend')
    assert.equal(state.budget.spend, 'unknown')
    assert.equal(state.attempts.get('first').outcome, 'uncertain')
  }
  const seq = journal.state.seq
  await journal.recover(lookup)
  assert.equal(journal.state.seq, seq, 'a standing conflict appends nothing')
})

test('the window can confirm the retained run after a conflicting lookup', async () => {
  const { journal } = await runningTwoStepPlan()
  await observeStarted(journal, 'run-1')
  const run = { correlationId: 'first', runId: 'run-1', teamId: 'team-1' }
  await journal.recover(async () => [runEvidence(run)])
  await journal.recover(async () => [{ ...runEvidence(run), firstRoundId: 'conflicting' }])
  assert.equal(journal.state.attempts.get('first').outcome, 'uncertain')
  await journal.resolveStart('first', { goalId: 'team-1', identity: run })
  assert.equal(journal.state.attempts.get('first').outcome, 'succeeded')
  assert.equal(journal.state.attempts.get('first').resolutionPending, false)
})

test('a lookup row naming another start\'s run is a conflict that never stops the rest of recovery', async () => {
  const { journal, next } = await runningTwoStepPlan()
  await observeStarted(journal, 'run-1')
  await journal.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => { throw new Error('lost response') })
  await journal.recover(async (attempt: any) => attempt.id === 'second' ? [runEvidence({ correlationId: 'second', runId: 'run-2', teamId: 'team-1' })] : [])
  assert.equal(journal.state.attempts.get('first').evidence, null, 'a lookup that omits a tracked run proves nothing and records nothing')
  assert.equal(journal.state.budget.stop, null)
  assert.ok(journal.state.runs.some((run: any) => run.runId === 'run-1'))
  const lookup = async (attempt: any) => attempt.id === 'first'
    ? [runEvidence({ correlationId: 'first', runId: 'run-1', teamId: 'team-1' }), runEvidence({ correlationId: 'first', runId: 'run-2', teamId: 'team-1' })]
    : [runEvidence({ correlationId: 'second', runId: 'run-2', teamId: 'team-1' }), runEvidence({ correlationId: 'second', runId: 'run-3', teamId: 'team-1' })]
  const actions = await journal.recover(lookup)
  assert.deepEqual(actions.map((action: any) => [action.id, action.type]), [['first', 'needs-user'], ['second', 'needs-user']])
  const restored: any = await checkpointOpen(journal)
  for (const state of [journal.state, restored.state]) {
    assert.equal(state.budget.stop.reason, 'unknown-spend')
    assert.equal(state.budget.spend, 'unknown')
    assert.deepEqual(state.runs.map((run: any) => [run.correlationId, run.runId]).sort(), [['first', 'run-1'], ['second', 'run-2'], ['second', 'run-3']])
  }
  const seq = journal.state.seq
  await journal.recover(lookup)
  assert.equal(journal.state.seq, seq, 'a standing cross-start conflict appends nothing')
})

test('a full start that finishes every run still records the new live run beside them', async () => {
  const storage = memory(), journal = await open(storage)
  const expanded = { ...contract, caps: { ...contract.caps, rounds: 100 } }
  await journal.setPolicy(policy)
  await journal.offerCard({ ...plan, contract: expanded })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: expanded.caps, freshnessMs: 50 })
  await journal.decideCard(click, 200)
  await journal.execute({ id: 'wide', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'wide', runId: 'run-1', teamId: 'team-1' } }))
  const runs = Array.from({ length: 64 }, (_, i) => runEvidence({ correlationId: 'wide', runId: `run-${i + 1}`, teamId: 'team-1' }))
  await journal.recover(async () => runs)
  assert.equal(journal.state.attempts.get('wide').outcome, 'succeeded')
  assert.equal(journal.state.runs.length, 64)
  const lookup = async () => [...runs.map(run => ({ ...run, terminal: true })), runEvidence({ correlationId: 'wide', runId: 'run-65', teamId: 'team-1' })]
  await journal.recover(lookup)
  const restored: any = await checkpointOpen(journal)
  for (const state of [journal.state, restored.state]) {
    assert.equal(state.budget.stop.reason, 'unknown-spend')
    assert.deepEqual(state.runs.map((run: any) => run.runId), ['run-65'], 'the new live run stays cancellable')
  }
  const seq = journal.state.seq
  await journal.recover(lookup)
  assert.equal(journal.state.seq, seq, 'the same lookup appends nothing again')
})

test('a window click shown before a conflict cannot resolve it', async () => {
  const { journal } = await runningTwoStepPlan()
  await observeStarted(journal, 'run-1')
  const run = { correlationId: 'first', runId: 'run-1', teamId: 'team-1' }
  await journal.recover(async () => [runEvidence(run)])
  const shown = journal.state.attempts.get('first').evidenceSeq
  await journal.recover(async () => [{ ...runEvidence(run), firstRoundId: 'conflicting' }])
  await assert.rejects(journal.resolveStart('first', { goalId: 'team-1', identity: run }, shown))
  assert.equal(journal.state.attempts.get('first').resolutionPending, true)
  await journal.resolveStart('first', { goalId: 'team-1', identity: run })
  assert.equal(journal.state.attempts.get('first').outcome, 'succeeded')
})

test('one lookup naming two Teams before any Goal is bound fails closed and records one Team', async () => {
  const { journal } = await lostStart()
  const actions = await journal.recover(async () => [runEvidence(witnessed('run-a', 'team-1')), runEvidence(witnessed('run-b', 'team-2'))])
  assert.deepEqual(actions.map((action: any) => [action.id, action.type]), [['lost', 'needs-user']])
  const restored: any = await checkpointOpen(journal)
  for (const state of [journal.state, restored.state]) {
    assert.equal(state.budget.stop.reason, 'unknown-spend')
    assert.deepEqual(state.runs.map((run: any) => run.teamId), ['team-1'])
  }
  await assert.rejects(journal.resolveStart('lost', null))
})

test('a crash between the two records of a full start still records the new live run', async () => {
  const records: any[] = []
  let reconciliations = 0, crash = false
  const storage = { records, async read() { return structuredClone(records) },
    async append(record: any) { if (crash && record.type === 'reconciliation' && ++reconciliations === 2) throw new Error('simulated crash'); records.push(structuredClone(record)) } }
  const journal = await open(storage)
  const expanded = { ...contract, caps: { ...contract.caps, rounds: 100 } }
  await journal.setPolicy(policy)
  await journal.offerCard({ ...plan, contract: expanded })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: expanded.caps, freshnessMs: 50 })
  await journal.decideCard(click, 200)
  await journal.execute({ id: 'wide', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'wide', runId: 'run-1', teamId: 'team-1' } }))
  const runs = Array.from({ length: 64 }, (_, i) => runEvidence({ correlationId: 'wide', runId: `run-${i + 1}`, teamId: 'team-1' }))
  await journal.recover(async () => runs)
  const lookup = async () => [...runs.map(run => ({ ...run, terminal: true })), runEvidence({ correlationId: 'wide', runId: 'run-65', teamId: 'team-1' })]
  crash = true
  await assert.rejects(journal.recover(lookup))
  crash = false
  const reopened = await open(storage)
  assert.equal(reopened.state.budget.stop.reason, 'unknown-spend')
  await reopened.recover(lookup)
  assert.deepEqual(reopened.state.runs.map((run: any) => run.runId), ['run-65'])
})

test('a reconciliation record cannot revive a start the window resolved as never started', async () => {
  const { journal, storage } = await lostStart()
  await journal.recover(async () => [])
  await journal.resolveStart('lost', null)
  assert.equal(journal.state.attempts.get('lost').outcome, 'failed')
  const template = storage.records.find((record: any) => record.type === 'reconciliation')
  const identity = witnessed()
  storage.records.push({ ...template, seq: journal.state.seq + 1, identity, count: 1, evidence: JSON.stringify([runEvidence(identity)]) })
  await assert.rejects(open(storage), /lead-(journal-transition|budget-refused)/)
})

const wideTwoStepPlan = async (storage: any = memory()) => {
  const journal = await open(storage)
  const wide = { ...contract, caps: { ...contract.caps, rounds: 100 }, steps: [...contract.steps, { ...contract.steps[0]!, id: 'second' }] }
  await journal.setPolicy(policy)
  await journal.offerCard({ ...plan, contract: wide })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: wide.caps, freshnessMs: 50 })
  await journal.decideCard(click, 200)
  return { journal, storage, next: { ...request, start: wide.steps[1]! } }
}
const observeAll = (journal: any) => journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'insight/goal',
  sourceIds: ['corpus-1'], goalId: 'team-1', executionIds: journal.state.budget.executionIds, quality: 'known', usdMicros: 0 })
const sixtyFour = (correlationId: string, terminal = false) => Array.from({ length: 64 }, (_, i) => runEvidence({ correlationId, runId: `${correlationId}-${i + 1}`, teamId: 'team-1' }, terminal))

test('a live run left out because the run index is full contests its start', async () => {
  const { journal, next } = await wideTwoStepPlan()
  await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => ({ value: null,
    identity: { correlationId: 'first', runId: 'first-1', teamId: 'team-1' } }))
  await journal.recover(async () => sixtyFour('first'))
  await observeAll(journal)
  const started = await journal.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => { throw new Error('lost response') })
  assert.equal(started.outcome, 'uncertain')
  const actions = await journal.recover(async (attempt: any) => attempt.id === 'first' ? sixtyFour('first')
    : [runEvidence({ correlationId: 'second', runId: 'run-b', teamId: 'team-1' })])
  assert.deepEqual(actions.map((action: any) => [action.id, action.type]), [['second', 'needs-user']])
  assert.equal(journal.state.budget.stop.reason, 'unknown-spend')
  await assert.rejects(journal.resolveStart('second', null), 'the host reported a run under this start')
})

test('a crash after contesting a start keeps it contested on reopen', async () => {
  const { journal, storage } = await lostStart()
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-existing', executionId: 'earlier-run' })
  storage.failOn('reconciliation')
  await assert.rejects(journal.recover(async () => [runEvidence(witnessed())]))
  storage.failOn(null)
  const reopened = await open(storage)
  assert.equal(reopened.state.attempts.get('lost').contested, true)
  await reopened.recover(async () => [])
  await assert.rejects(reopened.resolveStart('lost', null))
})

test('a start resolved as never started is not looked up again and cannot block a later start', async () => {
  const { journal } = await wideTwoStepPlan()
  await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => { throw new Error('lost response') })
  await journal.recover(async () => sixtyFour('first', true))
  await journal.resolveStart('first', null)
  assert.equal(journal.state.attempts.get('first').outcome, 'failed')
  await observeAll(journal)
  const started = await journal.execute({ id: 'second', request, context, stepId: 'implement' }, async () => { throw new Error('lost response') })
  assert.equal(started.outcome, 'uncertain')
  const asked: string[] = []
  await journal.recover(async (attempt: any) => { asked.push(attempt.id); return attempt.id === 'first'
    ? [...sixtyFour('first', true), runEvidence({ correlationId: 'first', runId: 'late', teamId: 'team-1' })]
    : [runEvidence({ correlationId: 'second', runId: 'run-b', teamId: 'team-1' })] })
  assert.deepEqual(asked, ['second'])
  assert.ok(journal.state.runs.some((run: any) => run.runId === 'run-b'))
})

test('a lookup record the ledger refuses still contests its start', async () => {
  const journal = await prepare(memory())
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-x' })
  await observeAll(journal)
  await journal.updateBudget({ version: 1, type: 'round', now: 100, executionId: 'run-x', roundId: '1' })
  await journal.execute({ id: 'lost', request, context, stepId: 'implement' }, async () => { throw new Error('lost response') })
  await journal.recover(async () => [])
  const actions = await journal.recover(async () => [runEvidence(witnessed('run-x'))])
  assert.deepEqual(actions.map((action: any) => [action.id, action.type]), [['lost', 'needs-user']])
  const restored: any = await checkpointOpen(journal)
  for (const state of [journal.state, restored.state]) {
    assert.equal(state.budget.stop.reason, 'unknown-spend')
    assert.equal(state.attempts.get('lost').contested, true)
  }
  await assert.rejects(journal.resolveStart('lost', null), 'the host reported a run under this start')
  const seq = journal.state.seq
  await journal.recover(async () => [runEvidence(witnessed('run-x'))])
  assert.equal(journal.state.seq, seq, 'a standing refusal appends nothing')
})

test('automatic recovery preserves a cancelled-request person wait across reopen', async () => {
  const { journal, storage } = await lostStart()
  await journal.setManagementPhase('waiting-for-user', 'lead-request-cancelled')
  await journal.recover(async () => [runEvidence({ correlationId: 'lost', runId: 'run-1', teamId: 'team-1' })])
  assert.equal(journal.state.phase, 'waiting-for-user')
  assert.equal(journal.state.managementReason, 'lead-request-cancelled')
  const recovered = await open(storage)
  assert.equal(recovered.state.phase, 'waiting-for-user')
  assert.equal(recovered.state.managementReason, 'lead-request-cancelled')
})


test('host budget writes complete inside an execute dispatch without releasing the admitted step', { timeout: 1000 }, async () => {
  const storage = memory(), journal = await prepare(storage)
  const result = await journal.execute({ id: 'in-flight', request, context, stepId: 'implement' }, async () => {
    assert.equal(journal.state.steps[0].state, 'admitted')
    const write = journal.updateBudget({ version: 1, type: 'stop', now: 100, reason: 'budget' })
    let deadline: ReturnType<typeof setTimeout>
    const status = await Promise.race([write.then(() => 'written'), new Promise(resolve => { deadline = setTimeout(() => resolve('blocked'), 100) })])
    clearTimeout(deadline!)
    assert.equal(status, 'written', 'host write must finish during dispatch')
    assert.equal(journal.state.budget.stop.reason, 'budget')
    const duplicate = await journal.execute({ id: 'duplicate', request, context, stepId: 'implement' }, async () => {
      assert.fail('an in-flight step cannot dispatch twice')
    })
    assert.equal(duplicate.outcome, 'denied')
    return { value: null, identity: { correlationId: 'in-flight', runId: 'run-1', teamId: 'team-1' } }
  })
  assert.equal(result.outcome, 'succeeded')
  assert.deepEqual((await open(storage)).state, journal.state)
})


test('host bind during dispatch retains the admitted step and refuses conflicting bindings', { timeout: 1000 }, async () => {
  const storage = memory(), journal = await prepare(storage)
  const result = await journal.execute({ id: 'host-bound', request, context, stepId: 'implement' }, async () => {
    const binding = { version: 1, type: 'bind', now: 100, startId: 'host-bound', goalId: 'team-1', executionId: 'run-1', firstRoundId: 'run-1:round:1' }
    await journal.updateBudget(binding)
    assert.equal(journal.state.steps[0].state, 'admitted')
    assert.deepEqual(journal.state.runs, [{ correlationId: 'host-bound', runId: 'run-1', teamId: 'team-1' }])
    await journal.updateBudget(binding)
    await assert.rejects(journal.updateBudget({ ...binding, startId: 'another-start' }))
    await assert.rejects(journal.updateBudget({ ...binding, executionId: 'another-run' }))
    await assert.rejects(journal.updateBudget({ ...binding, goalId: 'another-goal' }))
    await assert.rejects(journal.updateBudget({ ...binding, firstRoundId: 'another-round' }))
    return { value: null, identity: { correlationId: 'host-bound', runId: 'run-1', teamId: 'team-1' } }
  })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(journal.state.budget.rounds.length, 1)
  assert.deepEqual((await open(storage)).state, journal.state)
})

test('host bind during dispatch refuses a different run in the start result and reopens unchanged', { timeout: 1000 }, async () => {
  const storage = memory(), journal = await prepare(storage)
  const owned = { correlationId: 'host-bound', runId: 'run-1', teamId: 'team-1' }
  await assert.rejects(journal.execute({ id: 'host-bound', request, context, stepId: 'implement' }, async () => {
    await journal.updateBudget({ version: 1, type: 'bind', now: 100, startId: 'host-bound', goalId: 'team-1',
      executionId: 'run-1', firstRoundId: 'run-1:round:1' })
    return { value: null, identity: { ...owned, runId: 'run-2' } }
  }), /lead-journal-transition/)
  assert.deepEqual(journal.state.runs, [owned])
  const reopened = await open(storage)
  assert.deepEqual(reopened.state, journal.state)
  assert.deepEqual(reopened.state.runs, [owned])
})


test('combined authority changes fence the journal revision before admission or writes', async () => {
  const storage = memory(), journal = await prepare(storage), before = journal.state
  let admissions = 0
  await assert.rejects(journal.changePolicyAndBudgetCaps({ ...policy, revision: 2, mode: 'plan' },
    { ...contract.caps, rounds: 4 }, before.seq - 1, { policy: 'policy-change', caps: 'caps-change' }, 100,
    undefined, () => { admissions++ }), (error: any) => error.wireCode === 'lead-revision-stale')
  assert.equal(admissions, 0)
  assert.deepEqual(journal.state, before)
  assert.equal(storage.records.at(-1).seq, before.seq)
})

test('combined authority preflight asks storage to prepare both simulated states before appending either', async () => {
  const storage = memory(), journal = await prepare(storage)
  // Policy tightening precedes a caps card; fail the storage size check on the second event.
  const before = journal.state, count = storage.records.length, prepared: number[] = []
  Object.assign(storage, { prepare(value: unknown, previous: lead.LeadState = journal.state) {
    const record = lead.prepareLeadJournalRecord(value)
    assert.equal(storage.records.length, count, 'no event is appended until both storage checks succeed')
    assert.equal(previous.seq, record.seq - 1)
    prepared.push(record.seq)
    if (record.type === 'card' && record.card.type === 'budget-change') throw new Error('synthetic state limit')
    return record
  } })
  await assert.rejects(journal.changePolicyAndBudgetCaps({ ...policy, revision: 2, mode: 'plan' },
    { ...contract.caps, rounds: 4 }, before.seq, { policy: 'policy-change', caps: 'caps-change' }, 100), /synthetic state limit/)
  assert.deepEqual(prepared, [before.seq + 1, before.seq + 2])
  assert.equal(storage.records.length, count)
  assert.deepEqual(journal.state, before)
})

test('expired plan renewal replays the same contract without resetting admitted work or caps', async () => {
  const storage = memory(), journal = await prepare(storage)
  await journal.execute({ id: 'renewal-start', request, context, stepId: 'implement' }, async () => ({ value: null, identity: { correlationId: 'renewal-start', runId: 'renewal-run', teamId: 'renewal-team' } }))
  assert.equal(journal.state.steps[0].state, 'started')
  await journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 400, rounds: 2 } })
  assert.equal(typeof journal.renewPlan, 'function', 'journal must re-offer expired consent')
  const before = journal.state
  await journal.renewPlan(199)
  assert.equal(journal.state.seq, before.seq)
  await journal.renewPlan(200)
  const renewed = journal.state.cards.find((card: any) => card.id === plan.id)
  assert.equal(renewed.revision, 2)
  assert.deepEqual(renewed.contract, contract)
  assert.equal(journal.state.phase, 'awaiting-plan')
  const afterOffer = journal.state.seq
  await journal.renewPlan(201)
  assert.equal(journal.state.seq, afterOffer)
  assert.deepEqual((await open(storage)).state, journal.state)
  await assert.rejects(journal.decideCard(click, 300))
  await journal.decideCard({ ...click, expectedRevision: 2 }, 400)
  assert.deepEqual(journal.state.contract, contract)
  assert.deepEqual(journal.state.steps, before.steps)
  assert.deepEqual(journal.state.runs, before.runs)
  assert.deepEqual(journal.state.teams, before.teams)
  assert.deepEqual(journal.state.budget, before.budget)
  assert.equal(journal.state.consent.expiresAt, 400)
  assert.deepEqual((await open(storage)).state, journal.state)
})

test('renew-plan reducer rejects early, terminal and duplicate renewals', async () => {
  const journal = await prepare(memory()), state = journal.state
  const event = { version: 1, seq: state.seq + 1, type: 'renew-plan', now: 200 }
  assert.throws(() => lead.reduceLeadRecord(state, { ...event, now: 199 }))
  const renewed = lead.reduceLeadRecord(state, event)
  assert.equal(renewed.cards[0]?.revision, 2)
  assert.throws(() => lead.reduceLeadRecord(renewed, { ...event, seq: renewed.seq + 1 }))
  assert.throws(() => lead.reduceLeadRecord({ ...state, phase: 'accepted' }, event))
})

test('declining consent renewal does not immediately re-offer the same expired consent', async () => {
  const storage = memory(), journal = await prepare(storage)
  await journal.renewPlan(200)
  await journal.decideCard({ ...click, expectedRevision: 2, choice: 'decline' })
  const before = journal.state.seq
  await journal.renewPlan(201)
  assert.equal(journal.state.seq, before)
  assert.deepEqual(lead.parseLeadCheckpoint(lead.leadCheckpoint(journal.state, '0'.repeat(64))).state, journal.state)
  const reopened = await open(storage)
  await reopened.renewPlan(202)
  assert.equal(reopened.state.seq, before)
})

test('offerCard returns a replacement at its original position, with its original journal order', async () => {
  const journal = await open(memory())
  await journal.setPolicy(policy)
  await journal.offerCard(plan)
  const position = journal.state.seq
  await journal.offerCard({ ...plan, id: 'later' })
  const replacement = await journal.offerCard({ ...plan, revision: 2 })
  assert.equal(replacement.id, plan.id)
  assert.equal(replacement.revision, 2)
  assert.deepEqual(journal.state.cards.map((card: any) => card.id), [plan.id, 'later'])
  assert.equal(journal.state.cardPositions[plan.id], position)
})


test('unchanged policy and allowances preserve revisions and pending plan approval', async () => {
  const journal = await open(memory()); await journal.setPolicy(policy); await initializeBudget(journal); await journal.offerCard(plan)
  const before = journal.state
  await journal.changePolicy({ ...policy, revision: 2 }, before.seq, 'unused')
  assert.deepEqual(journal.state, before)
  await journal.changeBudgetCaps(contract.caps, { id: 'unused', revision: 1 }, 100, undefined, before.seq)
  assert.deepEqual(journal.state, before)
  await journal.changePolicyAndBudgetCaps({ ...policy, revision: 2 }, contract.caps, before.seq, { policy: 'unused', caps: 'unused' }, 100)
  assert.deepEqual(journal.state, before)
  await journal.decideCard(click, 200)
})

test('forty renewals rotate exhausted plan ids preserving digest and decided history', async () => {
  const storage = memory(), journal = await prepare(storage)
  for (let i = 0; i < 40; i++) {
    const expiry = journal.state.consent.expiresAt
    await journal.renewPlan(expiry)
    const card = journal.state.cards.find((card: any) => card.type === 'plan' && !journal.state.decidedCards.includes(`${card.id}:${card.revision}`))
    assert.ok(card); assert.equal(card.contractDigest, contract.digest)
    await journal.decideCard({ ...click, cardId: card.id, expectedRevision: card.revision }, expiry + 100)
    assert.deepEqual(lead.parseLeadCheckpoint(lead.leadCheckpoint(journal.state, '0'.repeat(64))).state, journal.state)
  }
  assert.ok(journal.state.cards.length > 1)
  assert.deepEqual((await open(storage)).state, journal.state)
})

test('renewal admission retries with a fresh id when replacing cannot fit', async () => {
  const journal = await prepare(memory()), old = journal.state.cards[0]
  await journal.renewPlan(200, (card: any) => { if (card.id === old.id) throw new Error('lead-card-too-large') })
  const offered = journal.state.cards.find((card: any) => !journal.state.decidedCards.includes(`${card.id}:${card.revision}`))
  assert.ok(offered); assert.notEqual(offered.id, old.id); assert.equal(offered.contractDigest, old.contractDigest)
  assert.ok(journal.state.decidedCards.includes(`${old.id}:${old.revision}`))
})

test('legacy checkpoints keep saved card order at the retained message boundary', async () => {
  const journal = await open(memory()); await journal.setPolicy(policy); await initializeBudget(journal); await journal.offerCard(plan); await journal.appendReply('Retained answer'); await journal.offerCard({ ...plan, id: 'later' })
  const checkpoint: any = lead.leadCheckpoint(journal.state, '0'.repeat(64)); delete checkpoint.state.cardPositions
  const state = lead.parseLeadCheckpoint(checkpoint).state
  const last = Math.max(...state.messages.map(message => message.revision))
  assert.deepEqual(state.cards.map(card => state.cardPositions[card.id]), [last, last])
})

test('replacing a pending renewal keeps checkpoints and reopen parseable', async () => {
  const storage = memory(), journal = await prepare(storage); await journal.renewPlan(200)
  await journal.offerCard({ ...plan, revision: 3, contractDigest: 'b'.repeat(64), contract: { ...contract, revision: 2, digest: 'b'.repeat(64) } })
  assert.equal(journal.state.consent.renewalCardRevision, undefined)
  assert.deepEqual(lead.parseLeadCheckpoint(lead.leadCheckpoint(journal.state, '0'.repeat(64))).state, journal.state)
  assert.deepEqual((await open(storage)).state, journal.state)
})

test('terminal result decision closes a pending renewal', async () => {
  const journal = await prepare(memory()); await journal.renewPlan(200)
  await journal.offerCard({ version: 1, id: 'result', revision: 1, type: 'result', outcome: 'reviewed', contractDigest: contract.digest, summary: 'Ready', assertions: [], budget: lead.leadBudgetProjection(journal.state.budget, 100) })
  await journal.decideCard({ version: 1, cardId: 'result', cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' })
  assert.equal(journal.state.phase, 'accepted')
  assert.ok(journal.state.decidedCards.includes('plan-1:2'))
  await assert.rejects(journal.decideCard({ ...click, expectedRevision: 2 }, 400))
})

test('renewal reducer independently requires monotonic expiry and one renewal per consent', async () => {
  const journal = await prepare(memory()), state = journal.state
  const renewed = lead.reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'renew-plan', now: 200 })
  assert.throws(() => lead.reduceLeadRecord(renewed, { version: 1, seq: renewed.seq + 1, type: 'card-decision', decision: { ...click, expectedRevision: 2 }, expiresAt: 200 }))
  const decided = { ...renewed, decidedCards: [...renewed.decidedCards, 'plan-1:2'] }
  assert.throws(() => lead.reduceLeadRecord(decided, { version: 1, seq: decided.seq + 1, type: 'renew-plan', now: 201 }))
})

for (const mode of ['plan', 'default']) for (const combined of [false, true]) test(`authority-neutral Add rule persists in ${mode}, combined=${combined}`, async () => {
  const storage = memory(), journal = await open(storage)
  await journal.setPolicy({ ...policy, mode }); await initializeBudget(journal)
  const proposed = { ...policy, mode, revision: 2, rules: [{ id: 'added-rule', method: 'flow/start-goal', effect: 'ask', action: null, project: null }] }
  if (combined) await journal.changePolicyAndBudgetCaps(proposed, contract.caps, journal.state.seq, { policy: 'edit', caps: 'caps' }, 100)
  else await journal.changePolicy(proposed, journal.state.seq, 'edit')
  assert.deepEqual(journal.state.policy, proposed)
  assert.deepEqual((await open(storage)).state.policy, proposed)
  await journal.changePolicy({ ...proposed, revision: 3, rules: [] }, journal.state.seq, 'remove')
  assert.deepEqual(journal.state.policy.rules, [])
})
test('reducer ignores identical policy values regardless of revision', () => {
  const state = lead.reduceLeadRecord(lead.initialLeadState(), { version: 1, seq: 1, type: 'policy', policy })
  const next = lead.reduceLeadRecord(state, { version: 1, seq: 2, type: 'policy', policy: { ...policy, revision: 2 } })
  assert.deepEqual(next.policy, policy)
})
test('legacy checkpoint cards precede every new message after reopen', async () => {
  const journal = await open(memory()); await journal.setPolicy(policy); await journal.offerCard(plan); await journal.offerCard({ ...plan, id: 'second' }); await journal.appendReply('Last retained message')
  const checkpoint: any = lead.leadCheckpoint(journal.state, '0'.repeat(64)); delete checkpoint.state.cardPositions
  const state = lead.parseLeadCheckpoint(checkpoint).state
  const next = lead.reduceLeadRecord(state, { version: 1, seq: state.seq + 1, type: 'message', idempotencyKey: null, message: { version: 1, id: `message-${state.seq + 1}`, revision: state.seq + 1, role: 'assistant', text: 'New message' } })
  assert.ok(next.cards.every(card => next.cardPositions[card.id]! < next.messages.at(-1)!.revision))
})

test('two approved steps bind distinct host Goals and recover each without resetting shared accounting', async () => {
  const { journal, storage, next } = await runningTwoStepPlan()
  await observeStarted(journal, 'run-1')
  const result = await journal.execute({ id: 'second', request: next, context, stepId: 'second', predecessor: { runId: journal.state.runs[0]?.runId ?? '', ready: true } }, async () => {
    await journal.updateBudget({ version: 1, type: 'bind', now: 100, startId: 'second', goalId: 'team-2', executionId: 'run-2', firstRoundId: 'run-2:round:1' })
    return { value: null, identity: { correlationId: 'second', runId: 'run-2', teamId: 'team-2' } }
  })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(journal.state.budget.goalId, 'team-1', 'the first Goal stays the accounting anchor')
  assert.deepEqual(journal.state.budget.executionIds, ['run-1', 'run-2'])
  assert.deepEqual(journal.state.runs.map((run: any) => run.teamId), ['team-1', 'team-2'])
  await assert.rejects(journal.updateBudget({ version: 1, type: 'bind', now: 100, startId: 'second', goalId: 'wrong-team', executionId: 'run-2', firstRoundId: 'run-2:round:1' }))
  const reopened: any = await open(storage)
  await reopened.recover(async (attempt: any) => [{ correlationId: attempt.correlationId, runId: attempt.id === 'first' ? 'run-1' : 'run-2',
    teamId: attempt.id === 'first' ? 'team-1' : 'team-2', firstRoundId: attempt.id === 'first' ? '1' : 'run-2:round:1', terminal: false }])
  assert.equal(reopened.state.budget.accountingIncomplete, false)
  assert.equal(reopened.state.budget.rounds.length, 2)
  assert.deepEqual(reopened.state.runs, journal.state.runs)
})


test('a premature next step is denied before dispatch and can start when its predecessor awaits acceptance', async () => {
  const storage = memory(), journal = await open(storage)
  const second = { ...contract.steps[0]!, id: 'second' }
  const two = parseLeadAcceptanceContract({ ...contract, steps: [...contract.steps, second] })
  await journal.setPolicy(policy)
  await journal.offerCard({ ...plan, contract: two })
  await initializeBudget(journal)
  await journal.decideCard(click, 200)
  await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => ({
    value: null, identity: { correlationId: 'first', runId: 'run-1', teamId: 'team-1' },
  }))
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, startId: 'first', goalId: 'team-1', executionId: 'run-1', firstRoundId: '1' })
  await observeAll(journal)
  let starts = 0
  const next = { request: { ...request, start: second }, context, stepId: 'second', predecessor: { runId: 'run-1', ready: false } }
  const denied = await journal.execute({ ...next, id: 'premature' }, async () => { starts++; throw new Error('host refuses premature start') })
  assert.equal(denied.outcome, 'denied')
  assert.equal(starts, 0)
  assert.equal(journal.state.attempts.get('premature').dispatched, false)
  assert.equal(journal.state.steps[1].state, 'pending')
  assert.equal(journal.state.phase, 'running')
  const started = await journal.execute({ ...next, id: 'ready', predecessor: { runId: 'run-1', ready: true } }, async () => {
    starts++; return { value: null, identity: { correlationId: 'ready', runId: 'run-2', teamId: 'team-2' } }
  })
  assert.equal(started.outcome, 'succeeded')
  assert.equal(starts, 1)
})


test('a management-stopped start keeps its refusal instead of predecessor readiness', async () => {
  const journal = await open(memory()), second = { ...contract.steps[0]!, id: 'second' }
  const two = parseLeadAcceptanceContract({ ...contract, steps: [...contract.steps, second] })
  await journal.setPolicy(policy); await journal.offerCard({ ...plan, contract: two })
  await initializeBudget(journal); await journal.decideCard(click, 200)
  await journal.execute({ id: 'first', request, context, stepId: 'implement' }, async () => ({
    value: null, identity: { correlationId: 'first', runId: 'run-1', teamId: 'team-1' },
  }))
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, startId: 'first', goalId: 'team-1', executionId: 'run-1', firstRoundId: '1' })
  await observeAll(journal); await journal.stop()
  const result = await journal.execute({ id: 'second', request: { ...request, start: second }, context, stepId: 'second',
    predecessor: { runId: 'run-1', ready: false } }, async () => { throw new Error('must not dispatch') })
  assert.equal(result.decision.reason, 'Management is stopped pending recovery or user action')
  assert.equal(result.outcome, 'denied')
})

test('publication intents bind the live result click and checkpoint migration defaults only absent follow state', async () => {
  const storage = memory(), journal = await prepare(storage)
  const card = { version: 1, id: 'result-pr', revision: 1, type: 'result', outcome: 'reviewed', contractDigest: contract.digest,
    summary: 'Reviewed work', assertions: [], budget: { ...context.budget, reservedUsdMicros: 0 } }
  await journal.offerCard(card)
  const operation = { id: 'publish-1', at: 100, stage: 'push-prepared', source: {
    repository: 'acme/widgets', cwd: '/workspace/demo-worker', branch: 'worker', head: 'a'.repeat(40), remote: 'origin',
    remoteUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main', runId: 'run-1', teamId: 'team-1', runtime: 'fixture', sessionId: 'worker-1' },
    decision: { version: 1, cardId: card.id, cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept-open-pr' } }
  await assert.rejects(journal.publication({ ...operation, decision: { ...operation.decision, expectedRevision: 2 } }))
  await assert.rejects(journal.decideCard(operation.decision))
  await journal.publication(operation)
  assert.deepEqual((await open(storage)).state.publication, operation)
  const checkpoint: any = lead.leadCheckpoint(journal.state, 'b'.repeat(64))
  assert.deepEqual(lead.parseLeadCheckpoint(JSON.parse(JSON.stringify(checkpoint))).state.publication, operation)
  delete checkpoint.state.follow; delete checkpoint.state.pr; delete checkpoint.state.publication
  assert.deepEqual(lead.parseLeadCheckpoint(checkpoint).state.follow, { checks: true, reviews: true })
  checkpoint.state.follow = null
  assert.throws(() => lead.parseLeadCheckpoint(checkpoint))
})

test('only Needs-you operations with proven absence of effects may be superseded', async () => {
  for (const started of [false, true]) {
    const storage = memory(), journal = await prepare(storage)
    const card = { version: 1, id: 'result-pr', revision: 1, type: 'result', outcome: 'reviewed', contractDigest: contract.digest,
      summary: 'Reviewed work', assertions: [], budget: { ...context.budget, reservedUsdMicros: 0 } }
    await journal.offerCard(card)
    let op = { id: 'publish-1', at: 100, stage: 'push-prepared', effectStarted: false, source: {
      repository: 'acme/widgets', cwd: '/workspace/demo-worker', branch: 'worker', head: 'a'.repeat(40), remote: 'origin',
      remoteUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main', runId: 'run-1', teamId: 'team-1', runtime: 'fixture', sessionId: 'worker-1' },
      decision: { version: 1, cardId: card.id, cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept-open-pr' } }
    await journal.publication(op)
    if (started) { op = { ...op, stage: 'push-started', effectStarted: true }; await journal.publication(op) }
    op = { ...op, stage: 'needs-you' }; await journal.publication(op)
    if (started) await assert.rejects(journal.publication({ ...op, stage: 'superseded' }))
    else { await journal.invalidateResults(); assert.equal(journal.state.publication.stage, 'superseded') }
    assert.deepEqual((await open(storage)).state, journal.state)
    assert.deepEqual(lead.parseLeadCheckpoint(lead.leadCheckpoint(journal.state, 'b'.repeat(64))).state, journal.state)
  }
})

test('push-started cannot claim the absence of an external effect in either journal operation', () => {
  const source = { repository: 'acme/widgets', cwd: '/workspace/demo-worker', branch: 'worker', head: 'a'.repeat(40), remote: 'origin',
    remoteUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main', runId: 'run-1', teamId: 'team-1', runtime: 'fixture', sessionId: 'worker-1' }
  for (const effectStarted of [false, undefined]) {
    assert.throws(() => lead.parseLeadOwnedPush({ source, number: 7, previousHead: 'b'.repeat(40), at: 100, stage: 'push-started', effectStarted }))
    assert.throws(() => lead.parseLeadPublicationOperation({ source, id: 'publish-1', at: 100, stage: 'push-started', effectStarted,
      decision: { version: 1, cardId: 'result', cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept-open-pr' } }))
  }
})
