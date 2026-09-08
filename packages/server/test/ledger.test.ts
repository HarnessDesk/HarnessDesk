import assert from 'node:assert/strict'
import { writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import { Ledger } from '../src/ledger/index.js'
import { Pricing } from '../src/ledger/pricing.js'
import { scanClaudeTranscript, scanCodexRollout } from '../src/ledger/scan.js'
import { LedgerStore } from '../src/ledger/store.js'

/**
 * The ledger, on the two things it can get wrong in ways nobody notices:
 * counting the same tokens twice, and pricing what it has no price for.
 *
 * Both corpora are written as fixtures rather than mocked, because the formats
 * are what the code is actually about — Codex folds cached tokens into its
 * input count and Claude writes one message on several lines.
 */

const scratch = (): string => tempDir('hd-ledger-test-')

const NOON = Date.parse('2026-08-22T12:00:00Z')

const codexLine = (
  type: string,
  payload: Record<string, unknown>,
  timestamp = new Date(NOON).toISOString(),
): string => `${JSON.stringify({ timestamp, type, payload })}\n`

const codexTurn = (usage: {
  input: number
  cached: number
  output: number
  reasoning?: number
}): string =>
  codexLine('event_msg', {
    type: 'token_count',
    info: {
      last_token_usage: {
        input_tokens: usage.input,
        cached_input_tokens: usage.cached,
        output_tokens: usage.output,
        reasoning_output_tokens: usage.reasoning ?? 0,
      },
    },
  })

const claudeLine = (id: string, usage: Record<string, number>, model = 'claude-opus-5'): string =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOON).toISOString(),
    cwd: '/tmp/project',
    message: { id, model, usage },
  })}\n`

test('a Codex rollout counts cached tokens beside input, not inside it', async () => {
  const dir = scratch()
  const path = join(dir, 'rollout.jsonl')
  writeFileSync(
    path,
    codexLine('session_meta', { cwd: '/tmp/project' }) +
      codexLine('turn_context', { model: 'gpt-5.6-sol', cwd: '/tmp/project' }) +
      codexTurn({ input: 1000, cached: 800, output: 50, reasoning: 20 }),
  )
  const result = await scanCodexRollout(
    { runtime: 'codex', kind: 'codex', path, size: 0, mtime: 0 },
    0,
  )
  assert.equal(result.rows.length, 1)
  const row = result.rows[0]
  assert.equal(row?.input, 200, 'the cached share comes out of input')
  assert.equal(row?.cacheRead, 800)
  assert.equal(row?.output, 50)
  assert.equal(row?.reasoning, 20)
  assert.equal(row?.model, 'gpt-5.6-sol')
})

test('a Claude transcript counts one message once, however many lines carry it', async () => {
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 }
  writeFileSync(path, claudeLine('msg_1', usage) + claudeLine('msg_1', usage) + claudeLine('msg_2', usage))
  const result = await scanClaudeTranscript(
    { runtime: 'claude-code', kind: 'claude', path, size: 0, mtime: 0 },
    0,
    [],
  )
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.requests, 2, 'two distinct messages, not three lines')
  assert.equal(result.rows[0]?.output, 200)
  assert.equal(result.rows[0]?.cacheRead, 1000)
})

test('a resumed scan does not re-count the message it stopped on', async () => {
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  const usage = { input_tokens: 1, output_tokens: 10 }
  writeFileSync(path, claudeLine('msg_1', usage))
  const first = await scanClaudeTranscript({ runtime: 'c', kind: 'claude', path, size: 0, mtime: 0 }, 0, [])
  assert.equal(first.rows[0]?.requests, 1)

  // The duplicate line arrives after the first scan stopped.
  appendFileSync(path, claudeLine('msg_1', usage) + claudeLine('msg_2', usage))
  const second = await scanClaudeTranscript(
    { runtime: 'c', kind: 'claude', path, size: 0, mtime: 0 },
    first.offset,
    first.tail,
  )
  assert.equal(second.rows[0]?.requests, 1, 'only the new message counts')
})

test('a half-written last line is left for the next pass', async () => {
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  const whole = claudeLine('msg_1', { input_tokens: 1, output_tokens: 10 })
  writeFileSync(path, `${whole}{"type":"assistant","mess`)
  const result = await scanClaudeTranscript({ runtime: 'c', kind: 'claude', path, size: 0, mtime: 0 }, 0, [])
  assert.equal(result.offset, Buffer.byteLength(whole, 'utf8'), 'the partial line is not consumed')
  assert.equal(result.rows.length, 1)
})

test('a rewritten file replaces its rows instead of doubling them', async () => {
  const dir = scratch()
  const store = new LedgerStore(join(dir, 'usage.sqlite'))
  const row = {
    file: '/a.jsonl',
    day: NOON,
    runtime: 'codex',
    model: 'm',
    project: '/p',
    input: 10,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    requests: 1,
  }
  const cursor = { path: '/a.jsonl', size: 1, mtime: 1, offset: 1, tail: [] }
  store.commit(cursor, [row], NOON, false)
  store.commit(cursor, [row], NOON, false)
  assert.equal(store.since(0).reduce((sum, entry) => sum + entry.input, 0), 20, 'appends accumulate')
  store.commit(cursor, [row], NOON, true)
  assert.equal(store.since(0).reduce((sum, entry) => sum + entry.input, 0), 10, 'a replace starts over')
  store.close()
})

test('an unpriced model is counted as unpriced, never as nothing', async () => {
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  writeFileSync(
    path,
    claudeLine('msg_1', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-opus-5') +
      claudeLine('msg_2', { input_tokens: 1_000_000, output_tokens: 0 }, 'model-nobody-prices'),
  )
  const pricing = new Pricing({
    cachePath: join(dir, 'cache.json'),
    overlayPath: join(dir, 'overlay.json'),
    fetchCatalogue: async () => ({
      anthropic: { models: { 'claude-opus-5': { id: 'claude-opus-5', cost: { input: 5, output: 25 } } } },
    }),
  })
  await pricing.warm()

  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'claude-code', kind: 'claude', root: dir }],
    pricing,
    now: () => NOON,
  })
  await ledger.scan()
  const report = ledger.query({ days: 30, groupBy: 'model' })

  assert.equal(report.totalCost, 30, '1M in at $5 plus 1M out at $25')
  assert.equal(report.coverage.priced, 1)
  assert.equal(report.coverage.unpriced, 1)
  assert.equal(
    report.provenance,
    'listPrice',
    'an unpriced row is a hole in the coverage, not a second kind of source',
  )
  const unpriced = report.rows.find((entry) => entry.label === 'model-nobody-prices')
  assert.equal(unpriced?.hasUnpriced, true)
  assert.equal(unpriced?.tokens, 1_000_000, 'its tokens still count')
  ledger.close()
})

test('the price overlay wins over the catalogue', async () => {
  const dir = scratch()
  writeFileSync(join(dir, 'overlay.json'), JSON.stringify({ 'claude-opus-5': { input: 1, output: 2 } }))
  const pricing = new Pricing({
    cachePath: join(dir, 'cache.json'),
    overlayPath: join(dir, 'overlay.json'),
    fetchCatalogue: async () => ({
      anthropic: { models: { 'claude-opus-5': { id: 'claude-opus-5', cost: { input: 500, output: 900 } } } },
    }),
  })
  await pricing.warm()
  const rates = pricing.rateFor('claude-opus-5')
  assert.equal(rates?.input, 1 / 1_000_000)
  assert.equal(rates?.output, 2 / 1_000_000)
})

test('a dated model id finds its undated price', async () => {
  const dir = scratch()
  const pricing = new Pricing({
    cachePath: join(dir, 'cache.json'),
    overlayPath: join(dir, 'missing.json'),
    fetchCatalogue: async () => ({
      anthropic: {
        models: {
          'claude-haiku-4-5': { id: 'claude-haiku-4-5', cost: { input: 1, output: 5 } },
          'claude-haiku-4': { id: 'claude-haiku-4', cost: { input: 99, output: 99 } },
        },
      },
    }),
  })
  await pricing.warm()
  const rates = pricing.rateFor('claude-haiku-4-5-20251001')
  assert.equal(rates?.input, 1 / 1_000_000, 'the longest matching family wins')
})

test('a model we cannot attribute to a vendor stays unpriced', async () => {
  const dir = scratch()
  const pricing = new Pricing({
    cachePath: join(dir, 'cache.json'),
    overlayPath: join(dir, 'missing.json'),
    fetchCatalogue: async () => ({
      anthropic: { models: { 'claude-opus-5': { id: 'claude-opus-5', cost: { input: 5, output: 25 } } } },
    }),
  })
  await pricing.warm()
  assert.equal(pricing.rateFor('some-local-model'), null)
})

test('a second scan reads only what was appended', async () => {
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, claudeLine('msg_1', { input_tokens: 1_000_000, output_tokens: 0 }))
  const pricing = new Pricing({
    cachePath: join(dir, 'cache.json'),
    overlayPath: join(dir, 'missing.json'),
    fetchCatalogue: async () => ({
      anthropic: { models: { 'claude-opus-5': { id: 'claude-opus-5', cost: { input: 10, output: 10 } } } },
    }),
  })
  await pricing.warm()
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'claude-code', kind: 'claude', root: dir }],
    pricing,
    now: () => NOON,
  })
  await ledger.scan()
  assert.equal(ledger.query({ days: 30, groupBy: 'model' }).totalCost, 10)

  appendFileSync(path, claudeLine('msg_2', { input_tokens: 1_000_000, output_tokens: 0 }))
  await ledger.scan()
  assert.equal(ledger.query({ days: 30, groupBy: 'model' }).totalCost, 20, 'the first message is not read again')
  ledger.close()
})
