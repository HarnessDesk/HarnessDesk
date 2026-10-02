import assert from 'node:assert/strict'
import fs from 'node:fs'
import { appendFile, mkdir, rename, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { Ledger } from '../src/ledger/index.js'
import { INSIGHT_BYTE_LIMIT_MESSAGE } from '../src/ledger/insight.js'
import { Pricing } from '../src/ledger/pricing.js'
import { tempDir } from './scratch.js'

const query = { root: '/work/project', from: Date.parse('2026-09-19'), to: Date.parse('2026-09-21') }
const meta = `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-1', cwd: query.root } })}\n`
const event = (second: number) => `${JSON.stringify({ timestamp: `2026-09-20T00:00:${String(second).padStart(2, '0')}.000Z`, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } } })}\n`

const fixture = async (limit?: number) => {
  const dir = tempDir('hd-insight-cache-'); const corpus = join(dir, 'corpus')
  await mkdir(corpus)
  const path = join(corpus, 'rollout.jsonl'); await writeFile(path, meta + event(0))
  const ledger = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }),
    ...(limit === undefined ? {} : { insightByteLimit: limit }) })
  return { ledger, path, corpus }
}

const reads = (t: TestContext, corpus: string) => {
  const streams: fs.ReadStream[] = []; const starts: number[] = []
  const original = fs.createReadStream
  t.mock.method(fs, 'createReadStream', ((path: Parameters<typeof fs.createReadStream>[0], options?: { start?: number }) => {
    const stream = original(path, options)
    if (String(path).startsWith(corpus)) { streams.push(stream); starts.push(options?.start ?? 0) }
    return stream
  }) as typeof fs.createReadStream)
  return { streams, starts, bytes: () => streams.reduce((sum, stream) => sum + stream.bytesRead, 0) }
}

test('a second Usage open and timed refresh read no unchanged source bytes', async (t) => {
  const { ledger, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  const first = await ledger.readInsight(query, { refresh: true }); const bytes = count.bytes()
  const second = await ledger.readInsight(query, { refresh: true })
  assert.equal(count.bytes(), bytes)
  assert.equal(count.streams.length, 1)
  assert.deepEqual(second.samples.map((sample) => sample.key), first.samples.map((sample) => sample.key))
})

test('a growing transcript parses only appended bytes and retains its session context', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  await ledger.readInsight(query); const size = (await stat(path)).size; const bytes = count.bytes()
  const appended = event(1); await appendFile(path, appended)
  const detail = await ledger.readInsight(query)
  assert.deepEqual(count.starts, [0, size])
  assert.equal(count.bytes() - bytes, Buffer.byteLength(appended))
  assert.equal(detail.samples.length, 2)
  assert.ok(detail.samples.every((sample) => sample.sessionId === 'session-1' && sample.project === query.root))
})

test('a replaced file with the same size and mtime is read again after a cached open', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  await ledger.readInsight(query); await ledger.readInsight(query)
  const before = await stat(path); const replacement = join(corpus, 'replacement')
  await writeFile(replacement, meta + event(2)); await utimes(replacement, before.atime, before.mtime); await rename(replacement, path)
  const detail = await ledger.readInsight(query)
  assert.deepEqual(count.starts, [0, 0])
  assert.equal(detail.samples.length, 1)
  assert.equal(detail.samples[0]?.from, Date.parse('2026-09-20T00:00:02Z'))
})

test('files older than the requested range are skipped before opening a stream', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  await utimes(path, new Date('2026-09-01'), new Date('2026-09-01'))
  const count = reads(t, corpus)
  const detail = await ledger.readInsight(query)
  assert.equal(count.bytes(), 0); assert.equal(count.streams.length, 0)
  assert.equal(detail.samples.length, 0)
})

test('the scan budget truncates, reports Partial, and resumes without parsing the prefix again', async (t) => {
  const limit = Buffer.byteLength(meta + event(0))
  const { ledger, path, corpus } = await fixture(limit); t.after(() => ledger.close())
  await appendFile(path, event(1))
  const count = reads(t, corpus)
  const first = await ledger.readInsight(query)
  assert.ok(count.bytes() <= limit, 'the stream spends at most the request budget')
  assert.equal(first.samples.length, 1)
  assert.ok(first.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
  const second = await ledger.readInsight(query)
  assert.deepEqual(count.starts, [0, limit])
  assert.equal(second.samples.length, 2)
  assert.ok(!second.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
})

test('a same-size rewrite or shrink replaces cached samples instead of adding to them', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  await ledger.readInsight(query)
  const original = await stat(path)
  await writeFile(path, meta + event(3))
  await utimes(path, original.atime, new Date(original.mtimeMs + 2000))
  const rewritten = await ledger.readInsight(query)
  assert.equal(rewritten.samples.length, 1)
  assert.equal(rewritten.samples[0]?.from, Date.parse('2026-09-20T00:00:03Z'))
  await writeFile(path, meta)
  assert.equal((await ledger.readInsight(query)).samples.length, 0)
  assert.deepEqual(count.starts, [0, 0, 0])
})

test('a partial trailing record survives an append and is emitted only once', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  const extra = event(1); const split = extra.length - 12
  await appendFile(path, extra.slice(0, split))
  assert.equal((await ledger.readInsight(query)).samples.length, 1)
  await appendFile(path, extra.slice(split))
  assert.equal((await ledger.readInsight(query)).samples.length, 2)
  assert.equal((await ledger.readInsight(query)).samples.length, 2)
  assert.deepEqual(count.starts, [0, Buffer.byteLength(meta + event(0))])
})

test('cache rows are filtered for each range and concurrent opens share one source read', async (t) => {
  const { ledger, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  const [first, second] = await Promise.all([ledger.readInsight(query), ledger.readInsight(query)])
  assert.equal(first.samples.length, 1); assert.equal(second.samples.length, 1)
  assert.equal(count.streams.length, 1)
  const later = await ledger.readInsight({ ...query, from: Date.parse('2026-09-20T01:00:00Z') })
  assert.equal(later.samples.length, 0)
  const other = await ledger.readInsight({ ...query, root: '/work/other' })
  assert.equal(other.samples.length, 0)
  assert.equal(count.streams.length, 1)
})

test('a budget-limited read reaches the Insight response even without known dollar rates', async (t) => {
  const { InsightPlane } = await import('../src/insight/plane.js')
  const { ledger, path } = await fixture(Buffer.byteLength(meta + event(0))); t.after(() => ledger.close())
  await appendFile(path, event(1))
  const plane = new InsightPlane({ ledger: () => ledger, goals: { store: { list: () => [] } } as never, seats: () => [], seating: {} as never })
  const partial = await plane.usage(query)
  assert.equal(partial.scan, 'partial')
  assert.equal(partial.totals.turns.coverage, 'partial')
  assert.equal((await plane.usage(query)).scan, 'complete')
})

test('growth between discovery and stream opening still reports a limited response', async (t) => {
  const limit = Buffer.byteLength(meta + event(0))
  const { ledger, path } = await fixture(limit); t.after(() => ledger.close())
  const original = fs.createReadStream
  let grew = false
  t.mock.method(fs, 'createReadStream', ((source: Parameters<typeof fs.createReadStream>[0], options?: { start?: number }) => {
    if (source === path && !grew) { fs.appendFileSync(path, event(1)); grew = true }
    return original(source, options)
  }) as typeof fs.createReadStream)
  const first = await ledger.readInsight(query)
  assert.ok(first.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
  assert.equal((await ledger.readInsight(query)).samples.length, 2)
})

test('large source sample counts survive cold and cached reads within the shared byte budget', async (t) => {
  const dir = tempDir('hd-insight-large-cache-')
  const alpha = join(dir, 'alpha'); const beta = join(dir, 'beta')
  await mkdir(alpha); await mkdir(beta)
  // More observations than V8 accepts as arguments, comfortably below 64 MiB.
  const observations = 150_000
  const content = meta + Array.from({ length: observations }, (_, index) => `${JSON.stringify({
    timestamp: new Date(Date.parse('2026-09-20') + index).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } },
  })}\n`).join('')
  const limit = Buffer.byteLength(content)
  await writeFile(join(alpha, 'rollout.jsonl'), content)
  await writeFile(join(beta, 'rollout.jsonl'), meta + event(1))
  const ledger = new Ledger({ stateDir: dir, insightByteLimit: limit,
    corpora: [{ runtime: 'alpha', kind: 'codex', root: alpha }, { runtime: 'beta', kind: 'codex', root: beta }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => ledger.close())
  const count = reads(t, dir)
  const first = await ledger.readInsight(query)
  assert.equal(count.bytes(), limit, 'the large source spends the budget; the next source is not read')
  assert.equal(first.samples.length, observations)
  assert.ok(first.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
  assert.ok(!first.gaps.includes('A recorded usage source could not be read.'))
  const second = await ledger.readInsight(query, { refresh: true })
  assert.equal(second.samples.filter((sample) => sample.runtime === 'alpha').length, observations)
  assert.equal(second.samples.filter((sample) => sample.runtime === 'beta').length, 1)
  assert.equal(count.bytes(), limit + Buffer.byteLength(meta + event(1)), 'the cached large source reads no bytes')
  assert.ok(!second.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
  assert.ok(!second.gaps.includes('A recorded usage source could not be read.'))
})

for (const kind of ['claude', 'qwen'] as const) {
  for (const continuation of ['append', 'budget'] as const) {
    test(`${kind} deduplicates older message IDs across ${continuation} scans with first-observation values`, async (t) => {
      const dir = tempDir('hd-insight-dedup-cache-')
      const corpus = join(dir, 'corpus'); const chats = join(corpus, 'project', 'chats')
      await mkdir(chats, { recursive: true })
      const path = join(chats, 'messages.jsonl')
      const record = (id: number, input = 10) => `${JSON.stringify({
        type: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', cwd: query.root,
        ...(kind === 'claude'
          ? { message: { id: `message-${id}`, model: 'test-model', usage: { input_tokens: input, output_tokens: 1 } } }
          : { uuid: `message-${id}`, model: 'test-model', usageMetadata: { promptTokenCount: input, cachedContentTokenCount: 0, candidatesTokenCount: 1, thoughtsTokenCount: 0, toolUsePromptTokenCount: 0 } }),
      })}\n`
      const prefix = Array.from({ length: 65 }, (_, index) => record(index)).join('')
      const suffix = record(0, 999) + record(65)
      await writeFile(path, prefix + (continuation === 'budget' ? suffix : ''))
      const options = { stateDir: dir, corpora: [{ runtime: 'alpha', kind, root: corpus }],
        pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) }
      const ledger = new Ledger({ ...options, ...(continuation === 'budget' ? { insightByteLimit: Buffer.byteLength(prefix) } : {}) })
      t.after(() => ledger.close())
      const count = reads(t, corpus)
      const first = await ledger.readInsight(query)
      assert.equal(first.samples.length, 65)
      if (continuation === 'append') await appendFile(path, suffix)
      const continued = await ledger.readInsight(query, { refresh: true })
      assert.deepEqual(count.starts, [0, Buffer.byteLength(prefix)])
      assert.equal(count.bytes(), Buffer.byteLength(prefix + suffix))
      assert.equal(continued.samples.length, 66, 'only the new message adds an observation')
      assert.equal(continued.samples.find((sample) => sample.requestId === 'message-0')?.input.value, 10)
      assert.equal(continued.samples.reduce((sum, sample) => sum + (sample.input.value ?? 0), 0), 660)
      const fresh = new Ledger(options); t.after(() => fresh.close())
      const full = await fresh.readInsight(query)
      const values = (detail: typeof full) => detail.samples.map((sample) => [sample.key, sample.input, sample.output, sample.usd])
      assert.deepEqual(values(continued), values(full), 'continuation agrees with a full-file scan')
      const cached = await ledger.readInsight(query)
      assert.deepEqual(values(cached), values(continued))
      await writeFile(path, record(0, 7))
      const rewritten = await ledger.readInsight(query)
      assert.equal(rewritten.samples.length, 1)
      assert.equal(rewritten.samples[0]?.input.value, 7, 'rewrites discard source-wide seen observations')
    })
  }
}
