import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as lead from '@harnessdesk/lead'
import { LEAD_LIMITS } from '@harnessdesk/protocol'
import { LeadContextStore } from '../src/lead/context-store.js'
import { cachingProvider } from './fixtures/caching-provider.js'

// The context engine end to end, in one process: the host's stored conversation, the Lead's own loop and Messages
// client, and a provider that keeps a prompt cache. Fakes only: no model, network or credential is reached.

const MODEL = 'claude-sonnet-5-5'
const PRICE = { inputUsdMicrosPerMillion: 2_000_000, outputUsdMicrosPerMillion: 10_000_000, cacheReadUsdMicrosPerMillion: 200_000, cacheWriteUsdMicrosPerMillion: 2_500_000 }
const INSTRUCTION = 'Desk instruction: the conversation above is about to be replaced by a checkpoint'
const REFERENCE = 'Desk reference for the preceding person message: '
const text = (value: string) => ({ type: 'text' as const, text: value })

const directory = async (t: { after(run: () => Promise<void>): void }) => {
  const path = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'lead-context-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
/** A journal whose records outlive it, so a restart is a second journal over the same records. */
const journalOver = async (records: lead.LeadJournalRecord[] = []) => {
  const journal = await lead.createLeadJournal({ async read() { return structuredClone(records) }, async append(record) { records.push(structuredClone(record)) } })
  if (!journal.state.policy) await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  if (!journal.state.budget) await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'goal-1', caps: { usdMicros: LEAD_LIMITS.maxUsdMicros, rounds: 16 }, freshnessMs: 60_000 })
  return { journal, records }
}

/** What the fake model writes when asked for a checkpoint: the six headings, the person's words quoted short with
 * their references, the facts it was told to remember and those of the earlier checkpoint. */
const checkpointAnswer = (body: any): string => {
  const turns: any[] = body.messages
  const blocks = turns.flatMap(turn => turn.content.filter((block: any) => block.type === 'text').map((block: any) => block.text as string))
  const earlier = blocks.find(value => value.startsWith('<checkpoint id="')) ?? ''
  const facts = [...earlier.matchAll(/^- fact: .*$/gm)].map(match => match[0])
  const quotes: string[] = []
  turns.forEach(turn => turn.content.forEach((block: any, index: number) => {
    if (block.type !== 'text' || !block.text.startsWith(REFERENCE)) return
    const words: string = turn.content[index - 1]?.text ?? ''
    quotes.push(`- "${words.slice(0, 40)}" [${block.text.slice(REFERENCE.length)}]`)
    const remember = /Remember: (.*?)\./.exec(words)
    if (remember) facts.push(`- fact: ${remember[1]}`)
  }))
  return ['## What the person wants', quotes.slice(-12).join('\n') || 'None.', '## Decisions made and why', 'None.', '## Work and where each piece stands', 'None.',
    '## Waiting on the person', 'None.', '## Facts learned', [...new Set(facts)].join('\n') || 'None.', '## Open questions / next step', 'None.'].join('\n')
}
/** The fake model's ordinary answer: the code word if anything it was sent still holds it. */
const replyAnswer = (body: any): string => {
  const all = JSON.stringify(body.messages)
  const last = body.messages.slice(-2).flatMap((turn: any) => turn.content.map((block: any) => block.text ?? '')).join(' ')
  if (/What was the code word\?/.test(last)) return /the code word is ([a-z]+-\d+)/.exec(all)?.[1] ? `The code word is ${/the code word is ([a-z]+-\d+)/.exec(all)![1]}.` : 'I do not know.'
  return 'Noted.'
}

/** One Lead, the way the host runs it: a loop with the desk's context port, and the host's request built from the store. */
const harness = async (t: any, settings: { readonly window: number; readonly failCheckpoints?: boolean; readonly ledgerIds?: readonly string[]; readonly records?: lead.LeadJournalRecord[]; readonly home?: string }) => {
  const home = settings.home ?? await directory(t)
  const { journal, records } = await journalOver(settings.records)
  let id = 0
  const run = ++harnesses
  const store = await LeadContextStore.open({ directory: home, journal, model: MODEL, now: () => 1000 + id, nextId: () => `checkpoint-${run}-${++id}`, window: settings.window,
    ...(settings.ledgerIds ? { ledgerIds: () => settings.ledgerIds! } : {}) })
  const provider = cachingProvider(body => {
    const last = body.messages.at(-1).content.map((block: any) => block.text ?? '').join('\n')
    if (last.includes(INSTRUCTION)) return { content: [text(settings.failCheckpoints ? 'Here is a short summary without headings.' : checkpointAnswer(body))] }
    return { content: [text(replyAnswer(body))] }
  })
  // A desk with nothing happening on it: its event stream waits until the loop closes it.
  let ended: ((value: IteratorResult<never>) => void) | null = null
  const desk = { async call(method: string) { return method === 'client/subscribe' ? { baseline: 1 } : { ok: true } },
    events() { return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(resolve => { ended = resolve }),
      async return() { ended?.({ done: true, value: undefined }); return { done: true as const, value: undefined } } }) } },
    async synced() {}, snapshot() { return { teams: [], runs: [], boards: [], seats: [], approvals: [], reviews: [], waiting: [] } } }
  const project = { id: 'demo', path: '/workspace/demo' }
  const key = ['synthetic', 'context', 'fixture'].join('-')
  const loop = lead.createLeadLoop({ journal, desk: desk as any, project, clock: { now: () => 100, schedule: () => () => {} }, nextId: () => `loop-${run}-${++id}`,
    messages: { apiKey: key, model: MODEL, prices: { [MODEL]: PRICE }, transport: provider as any, countInput: async body => Buffer.byteLength(body) + 1024, wait: async () => {} },
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('no evidence in this test') },
    resolveTool: async () => ({ project, runId: null, start: null, context: { desk: journal.state.policy!, projectPolicy: null, project, approved: null, budget: null, now: 100, policyInterpretation: 'idle' } }) as any,
    context: { record: record => store.record(record), read: epoch => store.read(epoch) } })
  t.after(() => loop.close())
  const send = (input: lead.LeadMessagesRequest) => loop.compact(input)
  let said = 0
  /** One person turn, as the host's request: the stored conversation, the new words, one line of desk context. */
  const say = async (words: string) => {
    if (store.due() === 'hard') await store.compact('hard', send)
    await journal.appendMessage(`person-${run}-${++said}`, words, 'person')
    const built = await store.request()
    const result = await loop.request({ maxTokens: 512, messages: [...built.messages, { role: 'user', content: [text(`Desk observation: ${said} messages so far.`)] }],
      conversation: true, epoch: built.epoch, ...(built.base ? { base: built.base } : {}), ...(built.stable ? { stable: built.stable } : {}) })
    assert.equal(result?.status, 'completed')
    // The loop delivers the reply to the thread itself.
    const reply = journal.state.messages.at(-1)
    if (store.due()) await store.compact('soft', send)
    return reply?.role === 'assistant' ? reply.text : ''
  }
  return { home, journal, records, store, provider, loop, say, send }
}
let harnesses = 0
const filler = (n: number) => ` Notes for item ${n}: ${'the build log said nothing new; '.repeat(40)}`

test('a 400-turn conversation keeps a fact from turn 5, reads most of each steady request from the cache, and stays bounded', async t => {
  const lead1 = await harness(t, { window: 40_000 })
  for (let n = 1; n <= 199; n++) {
    const words = n === 3 ? `Remember: the code word is heron-42.${filler(n)}` : `Message ${n}.${filler(n)}`
    assert.equal(await lead1.say(words), 'Noted.')
  }
  // Turn 5 is the person's third message; 199 exchanges and the question make 400 turns.
  assert.equal(await lead1.say('What was the code word?'), 'The code word is heron-42.')
  const applied = lead1.records.filter(record => record.type === 'context-compaction-applied')
  assert.ok(applied.length >= 3, `the conversation was compacted several times (${applied.length})`)
  assert.ok(applied.every(record => record.type === 'context-compaction-applied' && !record.fallback && record.afterTokens < record.beforeTokens))
  // Each checkpoint leaves one marker in the thread (the thread keeps its latest messages, so the latest markers).
  const markers = lead1.journal.state.messages.flatMap(message => message.checkpoint ? [message.checkpoint.id] : [])
  assert.ok(markers.length >= 1)
  assert.deepEqual(markers, applied.slice(-markers.length).map(record => record.type === 'context-compaction-applied' && record.id))
  // Steady wakes: an ordinary request after an ordinary request in the same epoch.
  const ordinary = lead1.provider.requests.map((request, index) => ({ request, index, checkpoint: JSON.stringify(request.body.messages.at(-1)).includes(INSTRUCTION) }))
  const opening = (index: number) => JSON.stringify(lead1.provider.requests[index]!.body.messages[0].content[0])
  const steady = ordinary.filter(({ checkpoint, index }) => !checkpoint && index > 0 && !ordinary[index - 1]!.checkpoint && opening(index) === opening(index - 1))
  const read = steady.reduce((sum, { request }) => sum + request.usage.cacheRead, 0)
  const total = steady.reduce((sum, { request }) => sum + request.usage.cacheRead + request.usage.cacheWrite + request.usage.input, 0)
  assert.ok(steady.length > 150)
  assert.ok(read / total > 0.7, `cache reads on steady wakes: ${(read / total).toFixed(3)}`)
  t.diagnostic(`${steady.length} steady requests read ${(100 * read / total).toFixed(1)}% of their prompt from the cache; ${applied.length} checkpoints`)
  // A checkpoint request replays the prefix it summarises: it reads from the cache too.
  const checkpoints = ordinary.filter(one => one.checkpoint)
  assert.ok(checkpoints.every(one => one.request.usage.cacheRead > 0), 'every checkpoint request read its prefix from the cache')
  // The wake ledger carries the counts, and the facts the settings page shows agree.
  assert.ok(lead1.journal.state.wakes.every(wake => wake.tokens && wake.tokens.cacheRead >= 0))
  const facts = lead1.store.facts()
  assert.ok(facts.cacheHitRate! > 0.7 && facts.usedTokens! < 40_000 * 0.85 && facts.checkpoints.length === Math.min(8, applied.length))
  // Desk context never reaches the stored conversation; only its stub does.
  const stored = JSON.stringify(lead1.store.turns)
  assert.ok(!lead1.store.turns.some(turn => turn.content.some(block => block.type === 'text' && block.text.startsWith('Desk observation:'))), 'desk observations are stubbed')
  assert.ok(stored.includes('[Desk context at that time, left out: Desk observation:'))
  assert.ok((await stat(join(lead1.home, 'context.jsonl'))).size <= lead.LEAD_CONTEXT.diskBytes)
})

test('a checkpoint the model cannot write falls back to the desk\'s own, keeps the work ids, and the breaker then tries the model once', async t => {
  const lead1 = await harness(t, { window: 20_000, failCheckpoints: true, ledgerIds: ['work-7'] })
  let n = 0
  while (!lead1.records.some(record => record.type === 'context-compaction-applied')) await lead1.say(`Message ${++n}.${filler(n)}`)
  const failed = lead1.records.filter(record => record.type === 'context-compaction-failed')
  assert.deepEqual(failed.map(record => record.type === 'context-compaction-failed' && record.reason), ['section-missing', 'section-missing', 'section-missing'])
  const applied = lead1.records.find(record => record.type === 'context-compaction-applied')!
  assert.equal(applied.type === 'context-compaction-applied' && applied.fallback, true)
  const opening = lead1.store.turns[0]!.content[0]
  assert.ok(opening?.type === 'text' && opening.text.includes('kind="desk"') && opening.text.includes('- work-7'), 'the ledger ids survive the fallback')
  assert.equal(lead1.journal.state.messages.at(-1)?.checkpoint?.fallback, true)
  // The breaker stays open after a desk-written checkpoint: the next compaction asks the model once, not three times.
  const before = lead1.provider.requests.length
  await lead1.store.compact('manual', lead1.send)
  assert.equal(lead1.provider.requests.length - before, 1)
  assert.equal(lead1.records.filter(record => record.type === 'context-compaction-applied').length, 2)
})

test('the stored conversation survives a restart, imports each person message once, and re-sends one never answered', async t => {
  const first = await harness(t, { window: 200_000 })
  await first.say('Remember: the code word is heron-42.')
  await first.say('Second message.')
  const stored = JSON.stringify(first.store.turns)
  // A message the Lead never answered (its request failed) is not stored, and goes out again with the next request.
  await first.journal.appendMessage('unanswered', 'Are you there?', 'person')
  await first.loop.close()
  const second = await harness(t, { window: 200_000, records: first.records, home: first.home })
  assert.equal(JSON.stringify(second.store.turns), stored, 'the same turns after the restart')
  const next = await second.store.request()
  assert.equal(next.messages.filter(turn => JSON.stringify(turn).includes('Are you there?')).length, 1)
  assert.deepEqual(next.base, { turns: second.store.turns.length, blocks: second.store.turns.at(-1)!.content.length })
  assert.equal(next.stable!.turns, second.store.turns.length + 1)
  assert.equal(await second.say('What was the code word?'), 'The code word is heron-42.')
  const people = JSON.stringify(second.store.turns).match(/Are you there\?/g) ?? []
  assert.equal(people.length, 1, 'stored once it was answered')
  // A torn last line (a crash mid-write) loses only that step.
  await writeFile(join(second.home, 'context.jsonl'), `${await readFile(join(second.home, 'context.jsonl'), 'utf8')}{"type":"record","ba`)
  const reopened = await LeadContextStore.open({ directory: second.home, journal: second.journal, model: MODEL, now: () => 1, nextId: () => 'x' })
  assert.equal(JSON.stringify(reopened.turns), JSON.stringify(second.store.turns))
})

test('a restart during a compaction keeps the old conversation, and one after the journal applied it moves the new one in', async t => {
  const first = await harness(t, { window: 20_000 })
  let n = 0
  while (first.store.due() !== 'soft' && first.store.due() !== 'hard') {
    await first.journal.appendMessage(`p-${++n}`, `Message ${n}.${filler(n)}`, 'person')
    const built = await first.store.request()
    const result = await first.loop.request({ maxTokens: 512, messages: built.messages, conversation: true, epoch: built.epoch, ...(built.base ? { base: built.base } : {}), ...(built.stable ? { stable: built.stable } : {}) })
    assert.equal(result?.status, 'completed')
  }
  const before = JSON.stringify(first.store.turns)
  // The desk stops while the model is writing the checkpoint.
  void first.store.compact('soft', () => new Promise(() => {}))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(first.journal.state.context.pending)
  const second = await harness(t, { window: 20_000, records: first.records, home: first.home })
  assert.equal(second.journal.state.context.pending, null, 'the interrupted run is closed, not counted as a failure')
  assert.equal(second.journal.state.context.failures, 0)
  assert.equal(JSON.stringify(second.store.turns), before, 'the old conversation stands')
  assert.equal(second.store.epoch, 0)
  // This time the desk stops right after the journal recorded the new epoch, before the file was moved into place.
  const commit = second.journal.contextCompactionApplied.bind(second.journal)
  second.journal.contextCompactionApplied = async applied => { await commit(applied); throw new Error('stopped') }
  await assert.rejects(second.store.compact('soft', second.send))
  const third = await harness(t, { window: 20_000, records: second.records, home: second.home })
  assert.equal(third.store.epoch, 1)
  assert.equal(third.journal.state.context.epoch, 1)
  const opening = third.store.turns[0]!.content[0]
  assert.ok(opening?.type === 'text' && opening.text.startsWith('<checkpoint id="'), 'the checkpoint was moved in')
  await assert.rejects(stat(join(third.home, 'context.next.jsonl')))
})

/** The host's controls over a stored conversation the test drives: what it asks for and when. */
const controlsRig = async (replies: { status: string; reason?: string; text?: string }[]) => {
  const { LeadControls } = await import('../src/lead/controls.js')
  const { dispatch } = await import('../src/methods/index.js')
  const { journal } = await journalOver()
  const facts = { version: 1 as const, windowTokens: 200_000, usedTokens: 120_000, cacheHitRate: 0.9, compacting: false, checkpoints: [] }
  const sends: any[] = [], compactions: string[] = [], checks: (() => void)[] = []
  let due: 'soft' | 'hard' | null = null
  const context = { compacting: false, facts: () => facts, due: () => due,
    async request() { return { messages: [{ role: 'user' as const, content: [text('Stored words'), text(`${REFERENCE}message-1`)] }], epoch: 3, base: { turns: 1, blocks: 2 }, stable: { turns: 1, blocks: 2 } } },
    async compact(trigger: string, send: (input: lead.LeadMessagesRequest) => Promise<lead.LeadMessagesResult>) {
      compactions.push(trigger); due = null
      await send({ messages: [{ role: 'user', content: [text(INSTRUCTION)] }], maxTokens: lead.LEAD_CONTEXT.checkpointTokens, compaction: true, epoch: 3 })
      return 'applied' as const
    } }
  const service = { async status() { return { configured: true, protection: 'synthetic cipher' } }, async setKey() {}, async deleteKey() {}, async assertPublic() {},
    async send(value: any) { sends.push(value); return value.compaction ? { status: 'completed', text: 'checkpoint' } : replies.shift() ?? { status: 'completed', text: 'Ready' } } }
  const controls = new LeadControls({ journal, service: service as any, project: { id: 'demo', path: '/workspace/demo' }, model: 'fixture-model', now: () => 100, nextId: () => 'card',
    push() {}, decidePerson: async () => {}, decideResult: async () => {}, context: context as any, scheduleContextCheck: run => { checks.push(run) } })
  const ctx = { leadContextRead: () => controls.readContext(), leadContextCompact: () => controls.compactContext() } as any
  return { journal, controls, sends, compactions, checks, setDue(value: typeof due) { due = value }, call: (method: string) => dispatch(ctx, method as never, {} as never) as Promise<any> }
}

test('the host compacts past the hard line before the request, on the provider\'s too-long answer, and past the soft line once idle', async () => {
  const s = await controlsRig([{ status: 'failed', reason: 'lead-messages-too-long' }, { status: 'completed', text: 'Ready' }])
  s.setDue('hard')
  await s.controls.send({ idempotencyKey: 'send-1', text: 'Inspect the check' })
  await s.controls.idle()
  assert.deepEqual(s.compactions, ['hard', 'overflow'])
  const asks = s.sends.filter(one => !one.compaction)
  assert.equal(asks.length, 2, 'the request was sent again after the overflow compaction')
  assert.deepEqual([asks[0].epoch, asks[0].base, asks[0].stable], [3, { turns: 1, blocks: 2 }, { turns: 1, blocks: 2 }])
  assert.equal(asks[0].messages[0].content[0].text, 'Stored words', 'the request starts from the stored conversation')
  assert.equal(s.sends.filter(one => one.compaction).length, 2, 'each checkpoint request goes through the same service')
  // After the reply the soft line is checked once the Lead is idle.
  s.setDue('soft')
  for (const check of s.checks.splice(0)) check()
  await s.controls.idle()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(s.compactions, ['hard', 'overflow', 'soft'])
})

test('Summarise now compacts on request and both context methods answer with the facts', async () => {
  const s = await controlsRig([])
  const read = await s.call('lead/context/read')
  assert.equal(read.cacheHitRate, 0.9)
  const after = await s.call('lead/context/compact')
  assert.deepEqual(s.compactions, ['manual'])
  assert.equal(after.windowTokens, 200_000)
})
