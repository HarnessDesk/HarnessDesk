import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as lead from '../src/index.js'
import { fakeMessages, message, tool, type FakeStep } from './fixtures/fake-messages.js'

const key = 'synthetic-key-for-context-tests'
const prices = { inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 2_000_000,
  cacheReadUsdMicrosPerMillion: 100_000, cacheWriteUsdMicrosPerMillion: 1_250_000 }
const policy = { version: 1 as const, revision: 1, mode: 'manage' as const, rules: [] }
const project = { id: 'demo', path: '/workspace/demo' }
const text = (value: string) => ({ type: 'text' as const, text: value })
const user = (...blocks: lead.MessagesTurn['content']) => ({ role: 'user' as const, content: blocks })
const assistant = (...blocks: lead.MessagesTurn['content']) => ({ role: 'assistant' as const, content: blocks })
const setup = async (steps: FakeStep[]) => {
  const journal = await lead.createLeadJournal({ async read() { return [] }, async append() {} })
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: { usdMicros: 1_000_000, rounds: 3 }, freshnessMs: 50 })
  const fake = fakeMessages(steps), dispatched: string[] = []
  let id = 0
  const client = lead.createLeadMessages({ apiKey: key, model: 'synthetic-model', prices: { 'synthetic-model': prices }, transport: fake,
    journal, now: () => 100, nextId: () => `request-${++id}`, countInput: async () => 1000, wait: async () => {},
    resolveTool: async () => ({ project, runId: null, start: null,
      context: { desk: policy, projectPolicy: null, project, approved: null, budget: null, now: 100, policyInterpretation: 'idle' } }),
    dispatch: async call => { dispatched.push(call.method); return { value: { ok: true }, identity: null } } })
  return { client, fake, dispatched }
}
const marksOf = (body: any): string[] => [
  ...(Array.isArray(body.system) ? body.system.flatMap((block: any, index: number) => block.cache_control ? [`system:${index}`] : []) : []),
  ...body.messages.flatMap((turn: any, t: number) => turn.content.flatMap((block: any, b: number) => block.cache_control ? [`${t}:${b}`] : [])),
]
/** The request in the provider's prefix order (tools, instructions, then each message block), cut after its last
 * cache mark and with the marks taken out: what the provider can read from its cache. */
const cachedPrefix = (raw: string): string[] => {
  const body = JSON.parse(raw)
  const units: { text: string; marked: boolean }[] = [{ text: JSON.stringify(body.tools), marked: false },
    ...(Array.isArray(body.system) ? body.system : []).map((block: any) => ({ text: JSON.stringify({ ...block, cache_control: undefined }), marked: !!block.cache_control })),
    ...body.messages.flatMap((turn: any) => turn.content.map((block: any) => ({ text: `${turn.role}:${JSON.stringify({ ...block, cache_control: undefined })}`, marked: !!block.cache_control })))]
  return units.slice(0, units.findLastIndex(unit => unit.marked) + 1).map(unit => unit.text)
}

test('the request carries cache marks at the end of the instructions, the checkpoint turn and the last stable block, and desk context after them', async () => {
  const s = await setup([message(), message()])
  const checkpoint = lead.leadCheckpointTurn('cp-1', `## What the person wants\n"keep the docs short" [m-1]`, false)
  const stored = [checkpoint, user(text('Fix the sign-in page'), text('Desk reference for the preceding person message: m-2')),
    assistant(text('On it.'))]
  const desk = user(text('Desk activity changed. Run readings: [...]'))
  const sent = await s.client.request({ messages: [...stored, desk], stable: lead.leadContextMarkOf(stored), system: 'Standing instructions', maxTokens: 100 }, new AbortController().signal)
  assert.equal(sent.status, 'completed')
  const body = JSON.parse(s.fake.requests[0].body)
  assert.deepEqual(body.system, [{ type: 'text', text: 'Standing instructions', cache_control: { type: 'ephemeral' } }])
  assert.deepEqual(marksOf(body), ['system:0', '0:0', '2:0'])
  assert.ok(marksOf(body).length <= lead.LEAD_CONTEXT.breakpoints)
  // The desk context of this moment comes after the last mark, so it is never part of a cached prefix.
  assert.ok(!cachedPrefix(s.fake.requests[0].body).join().includes('Desk activity changed'))
  // The host reads the same dialect back and sends it unchanged.
  assert.equal(JSON.stringify(lead.parseLeadMessagesBody(s.fake.requests[0].body)), s.fake.requests[0].body)

  // The next wake: the conversation grew by the stub the desk context left and the reply. Its cached prefix extends
  // the previous one byte for byte, so the provider reads everything it wrote last time.
  const grown = [...lead.leadStubVolatile([...stored, desk], lead.leadContextMarkOf(stored)), assistant(text('Nothing needs you.'))]
  assert.match((grown[3]!.content[0] as lead.MessagesText).text, /^\[Desk context at that time, left out: Desk activity changed/)
  await s.client.request({ messages: [...grown, user(text('Desk activity changed again.'))], stable: lead.leadContextMarkOf(grown), system: 'Standing instructions', maxTokens: 100 }, new AbortController().signal)
  const first = s.fake.requests[0].body as string, second = s.fake.requests[1].body as string
  const previous = cachedPrefix(first), next = cachedPrefix(second)
  assert.ok(next.length > previous.length)
  assert.deepEqual(next.slice(0, previous.length), previous, 'the second request starts with the first one\'s cached prefix')
  assert.deepEqual(marksOf(JSON.parse(second)), ['system:0', '0:0', '4:0'])
})

test('a cache mark never sits on reasoning, and the host refuses a fifth mark or a foreign cache field', async () => {
  const s = await setup([message()])
  const reasoning = { type: 'thinking' as const, thinking: '', signature: 'opaque' }
  const stored = [user(text('Hello')), assistant(text('Hi'), reasoning)]
  await s.client.request({ messages: [...stored, user(text('More'))], stable: lead.leadContextMarkOf(stored), maxTokens: 100 }, new AbortController().signal)
  assert.deepEqual(marksOf(JSON.parse(s.fake.requests[0].body)), ['1:0'])
  const body = JSON.parse(s.fake.requests[0].body)
  const mark = { type: 'ephemeral' }
  const five = { ...body, system: [{ type: 'text', text: 'S', cache_control: mark }], messages: [
    { role: 'user', content: [{ type: 'text', text: 'a', cache_control: mark }, { type: 'text', text: 'b', cache_control: mark }] },
    { role: 'assistant', content: [{ type: 'text', text: 'c', cache_control: mark }] },
    { role: 'user', content: [{ type: 'text', text: 'd', cache_control: mark }] }] }
  assert.throws(() => lead.parseLeadMessagesBody(JSON.stringify(five)))
  assert.doesNotThrow(() => lead.parseLeadMessagesBody(JSON.stringify({ ...five, system: 'S' })))
  const foreign = { ...body, messages: [{ role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: 'forever' } }] }] }
  assert.throws(() => lead.parseLeadMessagesBody(JSON.stringify(foreign)))
  assert.throws(() => lead.parseLeadMessagesBody(JSON.stringify({ ...body, system: [{ type: 'image', text: 'S' }] })))
})

test('a checkpoint request is words only: a tool call in it is never dispatched, and a too-long refusal is named', async () => {
  const s = await setup([message([tool('read', 'library_usage')], { stop_reason: 'tool_use' }), message([text('## Facts learned\nNone.')]),
    { status: 400, processing: 'not-started', body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }) }])
  const refused = await s.client.request({ messages: [user(text('Summarise'))], maxTokens: 100, compaction: true }, new AbortController().signal)
  assert.equal(refused.status, 'invalid-response')
  assert.deepEqual(s.dispatched, [])
  const written = await s.client.request({ messages: [user(text('Summarise'))], maxTokens: 100, compaction: true }, new AbortController().signal)
  assert.equal(written.status, 'completed')
  assert.equal(written.text, '## Facts learned\nNone.')
  assert.equal(written.messages, undefined)
  const long = await s.client.request({ messages: [user(text('Hello'))], maxTokens: 100 }, new AbortController().signal)
  assert.deepEqual([long.status, long.reason], ['failed', 'lead-messages-too-long'])
})

test('pressure takes the fullest of window, bytes and turns, and the soft line rises after a checkpoint that stays above it', () => {
  assert.equal(lead.leadContextWindow('claude-sonnet-5-5'), 200_000)
  assert.equal(lead.leadContextWindow('an-unknown-model'), 200_000)
  assert.equal(lead.leadContextPressure({ window: 200_000, tokens: 140_000, bytes: 10, turns: 4 }), 0.7)
  assert.equal(lead.leadContextPressure({ window: 200_000, tokens: 10, bytes: lead.LEAD_CONTEXT.requestBytes, turns: 4 }), 1)
  assert.equal(lead.leadContextPressure({ window: 200_000, tokens: 10, bytes: 10, turns: 100 }), 0.5)
  assert.equal(lead.leadNextSoftShare(0.3), 0.7)
  assert.equal(lead.leadNextSoftShare(0.72), 0.82)
  assert.equal(lead.leadNextSoftShare(0.8), 0.85)
})

test('a step records the turns after its stable mark with desk context stubbed and reasoning left out', () => {
  const stored = [user(text('Fix it'), text('Desk reference for the preceding person message: m-1'))]
  const reasoning = { type: 'thinking' as const, thinking: 'private', signature: 'sig' }
  const after = [user(text('Fix it'), text('Desk reference for the preceding person message: m-1'), text('Desk activity changed.\nRun readings: []')),
    assistant(reasoning, tool('t1', 'library_usage') as lead.MessagesToolUse),
    user({ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}', is_error: false }, text('This is an automatic wake.')),
    assistant(reasoning)]
  const mark = lead.leadContextMarkOf(stored)
  const stubbed = lead.leadStubVolatile(after, mark)
  const record = lead.leadContextRecord(stubbed, mark)
  assert.deepEqual(record.extend, [text('[Desk context at that time, left out: Desk activity changed.]')])
  assert.deepEqual(record.turns, [assistant(tool('t1', 'library_usage') as lead.MessagesToolUse),
    user({ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}', is_error: false }, text('[Desk context at that time, left out: This is an automatic wake.]')),
    assistant(text('(no words)'))])
  assert.ok(!JSON.stringify(record).includes('private'))
  // The child's own history keeps the reasoning of the tool loop it may still continue.
  assert.deepEqual(stubbed[1], after[1])
  // A record is a valid fragment after the stored conversation.
  assert.doesNotThrow(() => lead.parseLeadContextTurns(record.turns))
  assert.throws(() => lead.parseLeadContextTurns([user({ type: 'tool_result', tool_use_id: 'x', content: '', is_error: false } as never)]))
})

test('pruning keeps the last three tool pairs whole and trims older long results to head and tail', () => {
  const big = 'a'.repeat(3000) + 'MIDDLE' + 'z'.repeat(3000)
  const turns: lead.MessagesTurn[] = [user(text('Start'))]
  for (let index = 0; index < 5; index++) turns.push(assistant(tool(`t${index}`, 'library_usage') as lead.MessagesToolUse), user({ type: 'tool_result', tool_use_id: `t${index}`, content: big, is_error: false }))
  const pruned = lead.leadPruneContext(turns)
  const results = pruned.filter(turn => turn.role === 'user' && turn.content[0]!.type === 'tool_result').map(turn => (turn.content[0] as lead.MessagesToolResult).content)
  assert.equal(results.slice(2).every(content => content === big), true)
  for (const content of results.slice(0, 2)) {
    assert.ok(!content.includes('MIDDLE'))
    assert.ok(content.startsWith('a'.repeat(1536)) && content.endsWith('z'.repeat(1024)))
    assert.match(content, /bytes trimmed by the desk/)
  }
  assert.equal(lead.leadPruneContext(pruned), pruned, 'pruning again changes nothing')
})

test('the split keeps whole tool pairs and person turns in the tail, and an open tool loop is closed in words', () => {
  const turns: lead.MessagesTurn[] = []
  for (let index = 0; index < 12; index++) {
    turns.push(user(text(`Person ${index}`)), assistant(tool(`t${index}`, 'library_usage') as lead.MessagesToolUse),
      user({ type: 'tool_result', tool_use_id: `t${index}`, content: 'x'.repeat(2000), is_error: false }), assistant(text(`Reply ${index}`)))
  }
  const split = lead.leadContextSplit(turns, 10_000)!
  assert.ok(lead.leadContextBoundary(turns, split))
  assert.equal(turns[split]!.content[0]!.type, 'text')
  assert.ok(turns.length - split >= lead.LEAD_CONTEXT.tailTurns)
  assert.equal(lead.leadContextSplit([user(text('only'))], 10_000), null)
  const open = lead.leadCloseOpenLoop([user(text('Go')), assistant(tool('t', 'library_usage', { a: 1 }) as lead.MessagesToolUse),
    user({ type: 'tool_result', tool_use_id: 't', content: 'done', is_error: false }, text('Person again'))])
  assert.deepEqual(open.slice(1), [assistant(text('[Called library_usage with {"a":1}]')), user(text('[Result of library_usage: done]'), text('Person again'))])
})

test('a checkpoint is refused when it is not shorter, misses a section or a required work id, and the fallback keeps the person\'s words', () => {
  const sections = lead.LEAD_CHECKPOINT_SECTIONS.map(section => `## ${section}\nNone.`).join('\n\n')
  assert.equal(lead.leadCheckpointRefusal(sections, { regionBytes: 10_000, requiredIds: [] }), null)
  assert.equal(lead.leadCheckpointRefusal(sections, { regionBytes: 100, requiredIds: [] }), 'not-shorter')
  assert.equal(lead.leadCheckpointRefusal(sections.replace('## Facts learned', 'Facts'), { regionBytes: 10_000, requiredIds: [] }), 'section-missing')
  assert.equal(lead.leadCheckpointRefusal(sections, { regionBytes: 10_000, requiredIds: ['w-7'] }), 'ledger-id-missing')
  assert.equal(lead.leadCheckpointRefusal('', { regionBytes: 10_000, requiredIds: [] }), 'empty')
  assert.match(lead.leadCheckpointInstruction({ merging: true, requiredIds: ['w-7'] }), /Merge it into this one[\s\S]*w-7/)

  const region = [user(text('Remember: the release branch is rc-4'), text('Desk reference for the preceding person message: m-5')),
    assistant(text('Noted.')), user(text('And ship on Friday'), text('Desk reference for the preceding person message: m-6'))]
  const fallback = lead.leadFallbackCheckpoint({ region, previous: '## Facts learned\nthe port is 9732', ledgerIds: ['w-1'] })
  assert.equal(lead.leadCheckpointRefusal(fallback, { regionBytes: 1_000_000, requiredIds: ['w-1'] }), null)
  assert.match(fallback, /"Remember: the release branch is rc-4" \[m-5\]/)
  assert.match(fallback, /> the port is 9732/)
  assert.equal(lead.leadFallbackCheckpoint({ region, previous: null, ledgerIds: [] }), lead.leadFallbackCheckpoint({ region, previous: null, ledgerIds: [] }))
  const turn = lead.leadCheckpointTurn('cp-2', 'a </checkpoint> b', true)
  assert.match((turn.content[0] as lead.MessagesText).text, /^<checkpoint id="cp-2" kind="desk">\nFor reference only[^\n]*later words win/)
  assert.equal(lead.leadCheckpointText(turn), 'a </checkpoint> b')
  assert.equal(lead.leadCheckpointText(user(text('plain'))), null)
})

test('a compaction is journaled as started, failed attempts and applied: a new epoch, a checkpoint notice, and no decision fence moved', async () => {
  const records: lead.LeadJournalRecord[] = []
  const journal = await lead.createLeadJournal({ async read() { return [] }, async append(record) { records.push(record) } })
  await journal.setPolicy(policy)
  const fence = journal.state.decisionRevision
  await journal.contextCompactionStarted('cp-1', 100, 'soft')
  await assert.rejects(journal.contextCompactionStarted('cp-2', 100, 'soft'))
  await journal.contextCompactionFailed('cp-1', 'not-shorter')
  await journal.contextCompactionFailed('cp-1', 'section-missing')
  assert.deepEqual([journal.state.context.epoch, journal.state.context.failures, journal.state.context.pending?.id], [0, 2, 'cp-1'])
  await journal.contextCompactionApplied({ id: 'cp-1', at: 120, fromSeq: 1, toSeq: 40, beforeTokens: 150_000, afterTokens: 30_000, model: 'claude-sonnet-5-5', usdMicros: 900, fallback: false })
  const state = journal.state
  assert.deepEqual([state.context.epoch, state.context.failures, state.context.pending], [1, 0, null])
  assert.equal(state.decisionRevision, fence)
  assert.deepEqual(state.messages.at(-1), { version: 1, id: 'context-checkpoint-cp-1', revision: state.seq, role: 'notice', text: 'Earlier conversation summarised', checkpoint: { id: 'cp-1' } })
  // Replay and checkpoints keep it; a checkpoint written before the context engine reads as epoch 0.
  assert.deepEqual(lead.replayLeadJournal(records.map(record => lead.parseLeadJournalRecord(JSON.parse(JSON.stringify(record))))).context, state.context)
  assert.deepEqual(lead.parseLeadCheckpoint(lead.leadCheckpoint(state, '0'.repeat(64))).state.context, state.context)
  const older: any = lead.leadCheckpoint(state, '0'.repeat(64)); delete older.state.context
  assert.deepEqual(lead.parseLeadCheckpoint(older).state.context, lead.initialLeadContext())
  // A restart between started and applied ends the run as interrupted: the old conversation stays, nothing is counted.
  await journal.contextCompactionStarted('cp-2', 130, 'hard')
  await journal.contextCompactionFailed('cp-2', 'interrupted')
  assert.deepEqual([journal.state.context.epoch, journal.state.context.failures, journal.state.context.pending], [1, 0, null])
  await journal.contextCompactionStarted('cp-3', 140, 'manual')
  await journal.contextCompactionApplied({ id: 'cp-3', at: 150, fromSeq: 41, toSeq: 60, beforeTokens: 40_000, afterTokens: 20_000, model: 'claude-sonnet-5-5', usdMicros: 0, fallback: true })
  assert.deepEqual(journal.state.messages.at(-1)?.checkpoint, { id: 'cp-3', fallback: true })
  assert.throws(() => lead.parseLeadJournalRecord({ version: 1, seq: 99, type: 'context-compaction-failed', id: 'cp-9', reason: 'Not A Code' }))
})

import { fixture as loopFixture } from './fixtures/loop.js'
const contextPort = (fresh: () => { epoch: number; messages: lead.MessagesTurn[] } | null = () => null) => {
  const records: any[] = [], reads: number[] = []
  return { records, reads, port: { async record(record: any) { records.push(structuredClone(record)) }, async read(epoch: number) { reads.push(epoch); return fresh() } } }
}

test('a step records its new turns for the desk, stubs the desk context it was sent, and puts token counts on the wake', async () => {
  const s = await loopFixture([message([{ type: 'thinking', thinking: 'private', signature: 'sig' }, text('Ready')])])
  const context = contextPort()
  const loop = lead.createLeadLoop({ ...s.options, context: context.port })
  try {
    await loop.request({ messages: [user(text('Plan the repair'), text('Desk observation: two runs waiting.\nmore'))], maxTokens: 100, stable: { turns: 1, blocks: 1 }, epoch: 0 })
    const body = JSON.parse(s.fake.requests[0].body)
    assert.equal(body.epoch, undefined, 'the epoch is the desk\'s own, never sent')
    assert.deepEqual(marksOf(body), ['system:0', '0:0'], 'the stable mark sits on the last stored block, before desk context')
    assert.equal(context.records.length, 1)
    const [record] = context.records
    assert.equal(record.epoch, 0)
    assert.equal(record.base, 1)
    assert.deepEqual(record.extend, [text('[Desk context at that time, left out: Desk observation: two runs waiting.]')])
    assert.deepEqual(record.turns, [assistant(text('Ready'))], 'reasoning is never stored')
    assert.deepEqual(record.usage, { input: 10, cacheRead: 30, cacheWrite: 40 })
    assert.deepEqual(s.journal.state.wakes[0]!.tokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })
  } finally { await loop.close() }
})

test('the standing instructions change only at a new epoch, and the epoch hook adds to them there', async () => {
  const s = await loopFixture([message(), message(), message()])
  let calls = 0
  const loop = lead.createLeadLoop({ ...s.options, onEpoch: () => ({ standingAddendum: `Remembered note ${++calls}.` }) })
  try {
    for (const epoch of [0, 0, 1]) await loop.request({ messages: [user(text('Plan the repair'))], maxTokens: 100, epoch })
    const systems = s.fake.requests.map((request: any) => JSON.parse(request.body).system[0].text as string)
    assert.equal(calls, 2)
    assert.equal(systems[0], systems[1], 'the same epoch sends byte-identical instructions')
    assert.match(systems[0]!, /Remembered note 1\.$/)
    assert.match(systems[2]!, /Remembered note 2\.$/)
  } finally { await loop.close() }
})

test('a checkpoint request replays the same instructions and says nothing: no wake, no reply, no tool', async () => {
  const s = await loopFixture([message(), message([text('## What the person wants\nNone.')]), message([tool('t', 'flow_start_goal', {})], { stop_reason: 'tool_use' })])
  const loop = lead.createLeadLoop(s.options)
  try {
    await loop.request({ messages: [user(text('Plan the repair'))], maxTokens: 100, epoch: 0 })
    const wakes = s.journal.state.wakes.length, said = s.journal.state.messages.length
    const result = await loop.compact({ messages: [user(text('Plan the repair')), assistant(text('Ready')), user(text('Write the checkpoint.'))], maxTokens: 4096, epoch: 0 })
    assert.equal(result.status, 'completed')
    assert.equal(result.text, '## What the person wants\nNone.')
    const [first, second] = s.fake.requests.map((request: any) => JSON.parse(request.body))
    assert.equal(second.system[0].text, first.system[0].text, 'the same cached instructions')
    assert.deepEqual(second.tools, first.tools, 'the same cached tools')
    const refused = await loop.compact({ messages: [user(text('Write the checkpoint.'))], maxTokens: 4096 })
    assert.equal(refused.status, 'invalid-response')
    assert.equal(s.journal.state.wakes.length, wakes)
    assert.equal(s.journal.state.messages.length, said)
    assert.equal(s.calls.some((call: any) => call.method === 'flow/start-goal'), false)
  } finally { await loop.close() }
})

import { contract as loopContract, evidence as loopEvidence } from './fixtures/loop.js'
test('a desk wake after a compaction reads the stored conversation again and sends it with its stable mark', async () => {
  const start = { root: loopContract.project.path, source: (lead as any).leadReviewedResultSource, token: 'preview-1', sentence: loopContract.goal, vars: {}, attended: true,
    seats: { implement: [loopContract.steps[0]!.assignments[0]!.seat], review: [loopContract.steps[0]!.assignments[1]!.seat] } }
  const s = await loopFixture([message([tool('start', 'flow_start_goal', start)], { stop_reason: 'tool_use' }), message(), message()])
  const checkpoint = lead.leadCheckpointTurn('c1', '## What the person wants\nNone.', false)
  let fresh: { epoch: number; messages: lead.MessagesTurn[] } | null = null
  const context = contextPort(() => fresh)
  const loop = lead.createLeadLoop({ ...s.options, context: context.port })
  try {
    await s.approve()
    s.setEvidence({ ...loopEvidence(), spend: { version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'worker-samples', sourceIds: ['sample-1'], goalId: 'team-1', executionIds: ['run-1'], quality: 'known', usdMicros: 1 }, reviews: [],
      personActions: [{ kind: 'check', id: 'check', runId: 'run-1', name: 'verify', command: 'node --test' }] })
    await loop.request({ messages: [user(text('Plan the repair'))], maxTokens: 100, epoch: 0 })
    const changed = () => s.emit({ type: 'run.changed', run: 'run-1', team: 'team-1', state: 'running', flow: 'lead-reviewed-result', round: 1, reason: null })
    changed(); await s.drain(); await s.tick(); await loop.idle()
    assert.equal(context.reads.length, 0, 'a tool loop in flight keeps its own copy')
    fresh = { epoch: 4, messages: [checkpoint, assistant(text('Started.'))] }
    s.setEvidence({ ...loopEvidence(), spend: { version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'worker-samples', sourceIds: ['sample-1'], goalId: 'team-1', executionIds: ['run-1'], quality: 'known', usdMicros: 1 }, reviews: [],
      personActions: [{ kind: 'check', id: 'check-2', runId: 'run-1', name: 'lint', command: 'node --test' }] })
    changed(); await s.drain(); await s.tick(); await loop.idle()
    assert.equal(s.fake.requests.length, 3, 'the changed desk woke the model once')
    assert.ok(context.reads.length >= 1, 'the wake asked for the stored conversation')
    const body = JSON.parse(s.fake.requests.at(-1)!.body)
    assert.equal(body.messages[0].content[0].text, checkpoint.content[0]!.type === 'text' ? checkpoint.content[0]!.text : '')
    assert.ok(marksOf(body).includes('1:0'), 'the stable mark is the last stored block')
    assert.equal(context.records.at(-1).epoch, 4, 'what the wake adds is recorded against the epoch it read')
  } finally { await loop.close() }
})

test('a call without its answer, or an answer without its call, is put in words; paired turns come back untouched', () => {
  const paired = [user(text('go')), assistant(tool('a', 'chat_list', {}) as any), user({ type: 'tool_result', tool_use_id: 'a', content: 'two chats', is_error: false }), assistant(text('Two.'))]
  assert.equal(lead.leadPairedTurns(paired), paired)
  const cut = [user(text('go')), assistant(text('Looking.'), tool('a', 'chat_list', {}) as any), user(text('Desk reference for the preceding person message: m-2'))]
  assert.deepEqual(lead.leadPairedTurns(cut)[1], assistant(text('Looking.'), text('[Called chat_list with {}]')))
  const orphan = [user({ type: 'tool_result', tool_use_id: 'z', content: 'late', is_error: false }, text('more'))]
  assert.deepEqual(lead.leadPairedTurns(orphan)[0], user(text('[Result of a tool: late]'), text('more')))
})
