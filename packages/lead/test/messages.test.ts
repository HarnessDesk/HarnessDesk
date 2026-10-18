import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLeadAcceptanceContract } from '@harnessdesk/protocol'
import * as lead from '../src/index.js'
import { fakeMessages, message, tool, type FakeStep } from './fixtures/fake-messages.js'

const key = 'synthetic-key-for-messages-tests'
const prices = { inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 2_000_000,
  cacheReadUsdMicrosPerMillion: 3_000_000, cacheWriteUsdMicrosPerMillion: 4_000_000 }
const policy = { version: 1 as const, revision: 1, mode: 'manage' as const, rules: [] }
const project = { id: 'demo', path: '/workspace/demo' }
const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the project' }] }], maxTokens: 100 }
const setup = async (steps: FakeStep[], patch: Record<string, unknown> = {}, cap = 100_000) => {
  const records: lead.LeadJournalRecord[] = []
  const journal = await lead.createLeadJournal({ async read() { return [] }, async append(record) { records.push(record) } })
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1',
    caps: { usdMicros: cap, rounds: 3 }, freshnessMs: 50 })
  const fake = fakeMessages(steps), dispatched: string[] = [], waits: number[] = []
  let id = 0
  const options = { apiKey: key, model: 'synthetic-model', prices: { 'synthetic-model': prices }, transport: fake,
    journal, now: () => 100, nextId: () => `request-${++id}`, countInput: async () => 1000,
    wait: async (ms: number) => { waits.push(ms) },
    resolveTool: async () => ({ project, runId: null, start: null,
      context: { desk: policy, projectPolicy: null, project, approved: null, budget: null, now: 100, policyInterpretation: 'idle' } }),
    dispatch: async (call: lead.LeadPermissionCall) => { dispatched.push(call.method); return { value: { ok: true }, identity: null } }, ...patch }
  const factory = (lead as Record<string, unknown>).createLeadMessages
  assert.equal(typeof factory, 'function', 'createLeadMessages must preserve tool correlation and refuse uncertain retries')
  const client = (factory as (options: unknown) => any)(options)
  return { client, fake, journal, records, dispatched, waits, options }
}

test('scripted rate limit and multiple tool uses preserve ordered errors and journal dispatch', async () => {
  const blocks = [tool('first', 'flow_preview', { root: project.path, source: 'fixture recipe' }),
    tool('second', 'library_usage'), tool('unknown', 'unknown_tool'), tool('malformed', 'flow_preview', { root: 3 })]
  const s = await setup([{ status: 429, processing: 'not-started', retryAfter: '2', body: '' },
    message(blocks, { stop_reason: 'tool_use' }), message()])
  const result = await s.client.request(input, new AbortController().signal)
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.toolResults.map((item: any) => [item.tool_use_id, item.is_error]),
    [['first', false], ['second', false], ['unknown', true], ['malformed', true]])
  assert.deepEqual(s.dispatched, ['flow/preview', 'library/usage'])
  assert.deepEqual(s.waits, [2000])
  assert.equal(s.records.filter(r => r.type === 'budget' && r.event.type === 'reserve').length, 1)
  assert.equal(s.records.filter(r => r.type === 'attempt').length, 2)
  const budget = s.journal.state.budget!
  assert.equal(budget.leadUsdMicros, 300)
  assert.equal(budget.reservedUsdMicros, 0)
  const reservation = s.records.find(r => r.type === 'budget' && r.event.type === 'reserve') as any
  assert.equal(reservation.event.inputTokens, 1000)
  assert.equal(reservation.event.maxOutputTokens, 100)
  await s.client.request({ ...input, messages: result.messages }, new AbortController().signal)
  const sent = s.fake.requests[2]
  assert.deepEqual(JSON.parse(sent.body).messages.at(-1).content, result.toolResults)
  assert.equal(sent.origin, 'https://api.anthropic.com')
  assert.equal(sent.path, '/v1/messages')
  assert.equal(sent.method, 'POST')
  assert.equal(sent.headers['x-api-key'], key)
  assert.equal(JSON.parse(sent.body).model, 'synthetic-model')
  assert.equal(JSON.parse(sent.body).stream, false)
  assert.ok(JSON.parse(sent.body).tools.every((t: any) => !('type' in t) && t.input_schema.type === 'object'))
})

test('refused or non-durable reservations and invalid token counts send nothing', async () => {
  for (const patch of [{}, { countInput: async () => -1 }, { countInput: async () => Number.NaN }]) {
    const s = await setup([], patch, 10)
    assert.equal((await s.client.request(input, new AbortController().signal)).status, 'refused')
    assert.equal(s.fake.requests.length, 0)
  }
  const s = await setup([])
  ;(s.journal as any).updateBudget = async () => { throw new Error(key) }
  const result = await s.client.request(input, new AbortController().signal)
  assert.equal(result.status, 'refused')
  assert.ok(!JSON.stringify(result).includes(key))
  assert.equal(s.fake.requests.length, 0)
})

test('lost response, timeout, server failure and unproved rate limit remain uncertain without retries', async () => {
  for (const step of [async () => { throw new Error(key) }, async () => { throw new Error('timeout after send') },
    { status: 500, body: key }, { status: 529, body: '' }, { status: 429, body: '' }]) {
    const s = await setup([step])
    const result = await s.client.request(input, new AbortController().signal)
    assert.equal(result.status, 'uncertain')
    assert.equal(s.fake.requests.length, 1)
    assert.equal(s.journal.state.budget!.requests[0]!.uncertain, true)
    assert.equal(s.journal.state.budget!.reservedUsdMicros, 4200)
    assert.ok(!JSON.stringify(result).includes(key))
    assert.ok(!JSON.stringify(s.records).includes(key))
  }
})

test('abort before send sends nothing; abort after send never retries and retains reservation', async () => {
  const before = new AbortController(), s = await setup([])
  before.abort(key)
  assert.equal((await s.client.request(input, before.signal)).status, 'cancelled')
  assert.equal(s.fake.requests.length, 0)
  const after = new AbortController()
  const paid = await setup([async () => { after.abort(key); return new Promise(() => {}) }])
  assert.equal((await paid.client.request(input, after.signal)).status, 'uncertain')
  assert.equal(paid.fake.requests.length, 1)
  assert.equal(paid.journal.state.budget!.requests[0]!.uncertain, true)
})

test('proven pre-processing rate limits have bounded retries, delay and zero-charge cancellation', async () => {
  const limited = { status: 529, processing: 'not-started' as const, retryAfter: '0', body: key }
  const s = await setup([limited, limited, limited, message()])
  assert.equal((await s.client.request(input, new AbortController().signal)).status, 'rate-limited')
  assert.equal(s.fake.requests.length, 3)
  assert.equal(s.journal.state.budget!.leadUsdMicros, 0)
  assert.equal(s.journal.state.budget!.reservedUsdMicros, 0)
  const capped = await setup([{ ...limited, retryAfter: '999999' }])
  assert.equal((await capped.client.request(input, new AbortController().signal)).status, 'rate-limited')
  assert.deepEqual(capped.waits, [])
  const abort = new AbortController()
  const cancelled = await setup([limited], { wait: async () => { abort.abort(); throw new Error(key) } })
  assert.equal((await cancelled.client.request(input, abort.signal)).status, 'cancelled')
  assert.equal(cancelled.journal.state.budget!.reservedUsdMicros, 0)
})

test('all blocks validate before effects; duplicate and missing ids cannot lose correlation', async () => {
  for (const malformed of [{ type: 'text', text: 7 }, tool('same', 'library_usage'), { type: 'tool_use', name: 'library_usage' },
    { type: 'server_tool_use', id: 'hosted', name: 'hosted' }]) {
    const s = await setup([message([tool('same', 'library_usage'), malformed], { stop_reason: 'tool_use' })])
    assert.equal((await s.client.request(input, new AbortController().signal)).status, 'invalid-response')
    assert.deepEqual(s.dispatched, [])
    assert.equal(s.journal.state.budget!.leadUsdMicros, 300)
  }
})

test('missing usage and oversized response are uncertain and bounded', async () => {
  for (const response of [message([], { usage: {} }), { status: 200, body: 'x'.repeat(1_048_577) }]) {
    const s = await setup([response])
    assert.equal((await s.client.request(input, new AbortController().signal)).status, 'uncertain')
    assert.equal(s.fake.requests[0].maxResponseBytes, 1_048_576)
    assert.equal(s.journal.state.budget!.requests[0]!.uncertain, true)
  }
})

test('max_tokens reports truncation, settles usage and refuses incomplete tools', async () => {
  const s = await setup([message([tool('partial', 'library_usage')], { stop_reason: 'max_tokens' })])
  const result = await s.client.request(input, new AbortController().signal)
  assert.equal(result.status, 'max-tokens')
  assert.equal(result.toolResults[0].is_error, true)
  assert.deepEqual(s.dispatched, [])
  assert.equal(s.journal.state.budget!.leadUsdMicros, 300)
})

test('journal permissions still refuse known tools; bounded tool results cannot disclose credentials', async () => {
  const s = await setup([message([tool('preview', 'flow_preview', { root: project.path, source: 'recipe' })], { stop_reason: 'tool_use' })])
  await s.journal.setPolicy({ ...policy, revision: 2, rules: [{ id: 'deny', method: 'flow/preview', action: null, project: null, effect: 'deny' }] })
  const denied = await s.client.request(input, new AbortController().signal)
  assert.equal(denied.toolResults[0].is_error, true)
  assert.deepEqual(denied.permissionDeniedTools, ['preview'])
  assert.deepEqual(s.dispatched, [])
  for (const value of [key, 'x'.repeat(20_000), { nested: key }]) {
    const bounded = await setup([message([tool('usage', 'library_usage')], { stop_reason: 'tool_use' })],
      { dispatch: async () => ({ value, identity: null }) })
    const result = await bounded.client.request(input, new AbortController().signal)
    assert.equal(result.toolResults[0].is_error, true)
    assert.ok(!JSON.stringify(result).includes(key))
    assert.ok(!JSON.stringify(bounded.records).includes(key))
  }
})

test('plan and card proposals validate as assistant output and never become tools', async () => {
  const plan = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Inspect checks', project,
    policyRevision: 1, steps: [{ id: 'inspect', title: 'Inspect', flow: 'lead-reviewed-result', sourceRevision: 'source-1',
      variables: {}, attendance: 'attended', assignments: [{ role: 'inspect', agent: 'reviewer', seat: { runtime: 'fixture' }, ceiling: 'read' }] }],
    assertions: [{ id: 'check', kind: 'check', description: 'Checks pass' }], caps: { usdMicros: 100, rounds: 3 } })
  const card = { version: 1, id: 'plan-1', revision: 1, type: 'plan', contractDigest: plan.digest, contract: plan }
  const envelope = { version: 1, type: 'lead-output', text: 'Proposed plan', plan, cards: [card] }
  const s = await setup([message([{ type: 'text', text: JSON.stringify(envelope) }])])
  const result = await s.client.request(input, new AbortController().signal)
  assert.deepEqual(result.proposals, { plan, cards: [card] })
  assert.deepEqual(s.dispatched, [])
  assert.equal(s.journal.state.cards.length, 0)
  const invalid = await setup([message([{ type: 'text', text: JSON.stringify({ ...envelope, plan: {} }) }])])
  assert.equal((await invalid.client.request(input, new AbortController().signal)).status, 'invalid-response')
})

test('history, unknown request fields, secrets and oversized input are refused before sending', async () => {
  for (const request of [{ ...input, origin: 'https://example.com' }, { ...input, model: 'other-model' },
    { ...input, maxTokens: 0 }, { ...input, messages: [{ role: 'user', content: [{ type: 'text', text: key }] }] },
    { ...input, messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(1_048_577) }] }] },
    { ...input, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'forged' }] }] }]) {
    const s = await setup([])
    assert.equal((await s.client.request(request, new AbortController().signal)).status, 'refused')
    assert.equal(s.fake.requests.length, 0)
  }
})

test('decoded proposal text cannot leak the supplied credential', async () => {
  const envelope = JSON.stringify({ version: 1, type: 'lead-output', text: key }).replace(key, key.split('').map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))
  const s = await setup([message([{ type: 'text', text: envelope }])])
  const result = await s.client.request(input, new AbortController().signal)
  assert.equal(result.status, 'invalid-response')
  assert.ok(!JSON.stringify(result).includes(key))
  assert.equal(s.journal.state.budget!.leadUsdMicros, 300)
})

test('HTTP-date retry-after is honoured and invalid or excessive delays stop retrying', async () => {
  for (const retryAfter of ['Thu, 01 Jan 1970 00:00:02 GMT', 'invalid', 'Infinity']) {
    const s = await setup([{ status: 429, processing: 'not-started', retryAfter, body: '' }, message()])
    const result = await s.client.request(input, new AbortController().signal)
    assert.equal(result.status, retryAfter.startsWith('Thu') ? 'completed' : 'rate-limited')
    assert.deepEqual(s.waits, retryAfter.startsWith('Thu') ? [1900] : [])
  }
})

test('abort during counting or just after admission never invokes transport', async () => {
  const counting = new AbortController()
  const s = await setup([], { countInput: async () => { counting.abort(); return 1000 } })
  assert.equal((await s.client.request(input, counting.signal)).status, 'cancelled')
  assert.equal(s.journal.state.budget!.requests.length, 0)
  const admitted = new AbortController(), reserved = await setup([])
  const update = reserved.journal.updateBudget.bind(reserved.journal)
  reserved.journal.updateBudget = async event => {
    const result = await update(event)
    if (event.type === 'reserve') admitted.abort()
    return result
  }
  assert.equal((await reserved.client.request(input, admitted.signal)).status, 'cancelled')
  assert.equal(reserved.journal.state.budget!.reservedUsdMicros, 0)
  assert.equal(reserved.fake.requests.length, 0)
})

test('reordered, duplicate and dangling history tool results are refused before reservation', async () => {
  const uses = { role: 'assistant', content: [tool('one', 'library_usage'), tool('two', 'library_usage')] }
  for (const ids of [['two', 'one'], ['one', 'one'], ['one'], ['one', 'two', 'three']]) {
    const s = await setup([])
    const result = await s.client.request({ ...input, messages: [...input.messages, uses,
      { role: 'user', content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: '{}', is_error: false })) }] }, new AbortController().signal)
    assert.equal(result.status, 'refused')
    assert.equal(s.fake.requests.length, 0)
    assert.equal(s.journal.state.budget!.requests.length, 0)
  }
})

test('model and price configuration stay captured across owner mutation', async () => {
  const mutablePrices = { 'synthetic-model': { ...prices } }
  const s = await setup([message()], { prices: mutablePrices })
  s.options.model = 'unpriced-model'
  mutablePrices['synthetic-model'].inputUsdMicrosPerMillion = 0
  const result = await s.client.request(input, new AbortController().signal)
  assert.equal(result.status, 'completed')
  assert.equal(JSON.parse(s.fake.requests[0].body).model, 'synthetic-model')
  assert.equal(s.journal.state.budget!.leadUsdMicros, 300)
})

test('aggregate tool results retain every correlation when the continuation approaches its byte cap', async () => {
  const uses = Array.from({ length: 40 }, (_, index) => tool(`use-${index}`, 'library_usage'))
  const s = await setup([message(uses, { stop_reason: 'tool_use' })],
    { dispatch: async () => ({ value: 'x'.repeat(15_000), identity: null }) })
  const result = await s.client.request({ ...input, messages: [{ role: 'user',
    content: Array.from({ length: 64 }, () => ({ type: 'text', text: 'x'.repeat(10_000) })) }] }, new AbortController().signal)
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.toolResults.map((item: any) => item.tool_use_id), uses.map(item => item.id))
  assert.deepEqual(result.permissionDeniedTools, [])
  assert.ok(result.toolResults.some((item: any) => item.is_error))
  assert.ok(result.toolResults.some((item: any) => !item.is_error))
  assert.ok(new TextEncoder().encode(JSON.stringify(result.messages)).byteLength <= 1_048_576)
})

test('abort during a stalled tool dispatch records a failed read and answers every tool once', async () => {
  const controller = new AbortController()
  let calls = 0, passedSignal: AbortSignal | null = null
  const s = await setup([message([tool('one', 'library_usage'), tool('two', 'library_usage')], { stop_reason: 'tool_use' })],
    { dispatch: async (_call: unknown, _id: string, signal: AbortSignal) => {
      calls++; passedSignal = signal; controller.abort(); return new Promise(() => {})
    } })
  const result = await Promise.race([s.client.request(input, controller.signal),
    new Promise<any>(resolve => setImmediate(() => resolve({ status: 'hung' })))])
  assert.equal(result.status, 'cancelled')
  assert.equal(passedSignal, controller.signal)
  assert.equal(calls, 1)
  assert.deepEqual(result.toolResults.map((item: any) => [item.tool_use_id, item.is_error]), [['one', true], ['two', true]])
  assert.equal([...s.journal.state.attempts.values()][0]!.outcome, 'failed')
})

test('tool results cannot execute hidden JSON serializers or disclose their returned credential', async () => {
  let invoked = false
  const value = Object.defineProperty({}, 'toJSON', { get() { invoked = true; return () => key } })
  const s = await setup([message([tool('use', 'library_usage')], { stop_reason: 'tool_use' })],
    { dispatch: async () => ({ value, identity: null }) })
  const result = await s.client.request(input, new AbortController().signal)
  assert.equal(invoked, false)
  assert.equal(result.toolResults[0].is_error, true)
  assert.ok(!JSON.stringify(result).includes(key))
})

test('an unbilled client error zero-settles, names its cause and leaves the budget open', async () => {
  for (const [status, reason] of [[401, 'lead-messages-auth'], [403, 'lead-messages-auth'], [400, 'lead-messages-request'], [413, 'lead-messages-request']] as const) {
    const s = await setup([{ status, processing: 'not-started', body: key }, message()])
    const result = await s.client.request(input, new AbortController().signal)
    assert.deepEqual(result, { status: 'failed', reason })
    assert.equal(s.journal.state.budget!.spend, 'known')
    assert.equal(s.journal.state.budget!.reservedUsdMicros, 0)
    assert.equal((await s.client.request(input, new AbortController().signal)).status, 'completed')
  }
  // Without the transport's evidence a client error may still have been billed.
  const s = await setup([{ status: 401, body: '' }])
  assert.equal((await s.client.request(input, new AbortController().signal)).status, 'uncertain')
})

test('a malformed transport reply is uncertain, never a raw exception', async () => {
  for (const reply of [undefined, null, 'ok', { status: '200', body: '' }, { status: 429, processing: 'not-started', retryAfter: 2, body: '' }]) {
    const s = await setup([async () => reply as any])
    const result = await s.client.request(input, new AbortController().signal)
    assert.deepEqual(result, { status: 'uncertain', reason: 'lead-messages-billing-unknown' })
  }
})

test('plain text that opens with a brace is text, not a broken envelope', async () => {
  const s = await setup([message([{ type: 'text', text: '{ this is prose, not JSON }' }]), message([{ type: 'text', text: '{"note":"plain object"}' }])])
  const prose = await s.client.request(input, new AbortController().signal)
  assert.equal(prose.status, 'completed')
  assert.equal(prose.text, '{ this is prose, not JSON }')
  const other = await s.client.request(input, new AbortController().signal)
  assert.equal(other.text, '{"note":"plain object"}')
  assert.deepEqual(other.proposals, { plan: null, cards: [] })
})

test('a model refusal or paused turn settles usage and says which it was', async () => {
  for (const [stop, reason] of [['refusal', 'lead-messages-model-refusal'], ['pause_turn', 'lead-messages-paused']] as const) {
    const s = await setup([message([{ type: 'text', text: 'No' }], { stop_reason: stop })])
    const result = await s.client.request(input, new AbortController().signal)
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, reason)
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 })
    assert.equal(s.journal.state.budget!.reservedUsdMicros, 0)
  }
})

test('model defaults are ids the client can send', () => {
  for (const id of [lead.LEAD_MESSAGES_DEFAULTS.model, lead.LEAD_MESSAGES_DEFAULTS.observerModel, lead.LEAD_MESSAGES_DEFAULTS.hardPlanModel])
    assert.match(id, /^claude-[a-z]+-\d+-\d+$/)
})

test('JSON-shaped plain text cannot carry an escaped credential', async () => {
  const escaped = key.split('').map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  for (const text of [`{"note":"${escaped}"}`, `["${escaped}"]`, `"${escaped}"`]) {
    const s = await setup([message([{ type: 'text', text }])])
    const result = await s.client.request(input, new AbortController().signal)
    assert.equal(result.status, 'invalid-response')
    assert.ok(!JSON.stringify(result).includes(key))
  }
})

test('a reply in the provider\'s current shape is read, and its extra fields are not passed on', async () => {
  const s = await setup([message([{ type: 'text', text: 'Checking', citations: null },
    { ...tool('use-1', 'library_usage'), caller: { type: 'direct' } }], { stop_reason: 'tool_use', container: null, stop_details: null,
    diagnostics: {} }), message()])
  const result = await s.client.request(input, new AbortController().signal)
  assert.equal(result.status, 'completed')
  assert.deepEqual(s.dispatched, ['library/usage'])
  assert.deepEqual(result.messages.at(-2).content, [{ type: 'text', text: 'Checking' }, tool('use-1', 'library_usage')])
  // A tool the provider ran on someone else's behalf was never offered here.
  const other = await setup([message([{ ...tool('use-2', 'library_usage'), caller: { type: 'code_execution_20250825', tool_id: 'x' } }], { stop_reason: 'tool_use' })])
  assert.equal((await other.client.request(input, new AbortController().signal)).status, 'invalid-response')
  assert.deepEqual(other.dispatched, [])
  // History the caller supplies stays strict.
  const strict = await setup([])
  const extra = [...input.messages, { role: 'assistant', content: [{ type: 'text', text: 'x', citations: null }] }, input.messages[0]]
  assert.equal((await strict.client.request({ ...input, messages: extra }, new AbortController().signal)).status, 'refused')
})
