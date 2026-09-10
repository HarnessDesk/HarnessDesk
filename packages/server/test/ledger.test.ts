import assert from 'node:assert/strict'
import { appendFileSync, createReadStream, statSync, writeFileSync } from 'node:fs'
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

/**
 * A transcript written with `\r\n`, scanned twice.
 *
 * The offset a pass returns is where the next pass starts, so it has to be a
 * byte count of what was actually read. It was `byteLength(line) + 1` — a
 * guess that one `\n` had ended each line, made from a string `readline` had
 * already stripped the terminator from. On a CRLF file the guess is short by
 * a byte per line, and the error accumulates: the next pass starts inside a
 * terminator, reads a fragment, fails to parse it, and breaks. That file then
 * yields nothing ever again, because every later pass restarts from the same
 * bad offset — a ledger that silently stops counting one agent's work.
 */
const crlf = (line: string): string => line.replace(/\n$/, '\r\n')

test('a CRLF transcript is counted, and keeps being counted as it grows', async () => {
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  const usage = { input_tokens: 1, output_tokens: 10 }
  const target = { runtime: 'c', kind: 'claude', path, size: 0, mtime: 0 } as const

  writeFileSync(path, crlf(claudeLine('msg_1', usage)) + crlf(claudeLine('msg_2', usage)))
  const first = await scanClaudeTranscript(target, 0, [])
  assert.equal(first.rows[0]?.requests, 2)
  /* The whole file, to the byte. A short answer here is the defect: it is
     what makes the *next* pass start mid-terminator. */
  assert.equal(first.offset, statSync(path).size, 'the offset is where the file actually ends')

  appendFileSync(path, crlf(claudeLine('msg_3', usage)))
  const second = await scanClaudeTranscript(target, first.offset, first.tail)
  assert.equal(second.rows[0]?.requests, 1, 'the appended line is read')
  assert.equal(second.offset, statSync(path).size)
})

test('an LF transcript is unchanged by the byte counting', async () => {
  // The control: the ordinary case is the whole of what this code is for.
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  const usage = { input_tokens: 1, output_tokens: 10 }
  const target = { runtime: 'c', kind: 'claude', path, size: 0, mtime: 0 } as const

  writeFileSync(path, claudeLine('msg_1', usage) + claudeLine('msg_2', usage))
  const first = await scanClaudeTranscript(target, 0, [])
  assert.equal(first.rows[0]?.requests, 2)
  assert.equal(first.offset, statSync(path).size)

  appendFileSync(path, claudeLine('msg_3', usage))
  const second = await scanClaudeTranscript(target, first.offset, first.tail)
  assert.equal(second.rows[0]?.requests, 1)
})

test('a CRLF file whose last line is half-written leaves it for the next pass', async () => {
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  const whole = crlf(claudeLine('msg_1', { input_tokens: 1, output_tokens: 10 }))
  writeFileSync(path, `${whole}{"type":"assistant","mess`)
  const result = await scanClaudeTranscript({ runtime: 'c', kind: 'claude', path, size: 0, mtime: 0 }, 0, [])
  assert.equal(result.offset, Buffer.byteLength(whole, 'utf8'), 'the partial line is not consumed')
})

test('a whole record that ends the file without a newline is still counted', () => {
  /* A regression the first version of the byte counting introduced, and the
     worst shape of it: the caller commits the file's size beside the offset,
     so an unchanged file is skipped from then on and the record is never
     counted — not on the next pass, and not on a full rescan either, because
     the newline it is waiting for is never coming. The old implementation
     took it, and the way it told a whole record from a half-written one was
     to try to parse it. */
  return (async () => {
    const dir = scratch()
    const path = join(dir, 'session.jsonl')
    const usage = { input_tokens: 1, output_tokens: 10 }
    const target = { runtime: 'c', kind: 'claude', path, size: 0, mtime: 0 } as const

    const unterminated = claudeLine('msg_1', usage).replace(/\n$/, '')
    writeFileSync(path, unterminated)
    const result = await scanClaudeTranscript(target, 0, [])
    assert.equal(result.rows[0]?.requests, 1, 'the last record counts')
    assert.equal(result.offset, statSync(path).size, 'and the whole file is consumed')
  })()
})

test('a CRLF file whose last record has no newline is counted too', async () => {
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  const usage = { input_tokens: 1, output_tokens: 10 }
  const target = { runtime: 'c', kind: 'claude', path, size: 0, mtime: 0 } as const

  writeFileSync(path, crlf(claudeLine('msg_1', usage)) + claudeLine('msg_2', usage).replace(/\n$/, '\r'))
  const result = await scanClaudeTranscript(target, 0, [])
  assert.equal(result.rows[0]?.requests, 2)
  assert.equal(result.offset, statSync(path).size)
})

test('a chunk boundary that lands between the CR and the LF is still one line break', async () => {
  /* The CRLF tests above write files small enough to arrive in one chunk, so
     they never exercise the reassembly. This one forces it: a first line long
     enough that the 64KiB default read boundary falls on the `\n` of its
     terminator, with the `\r` in the chunk before. Raised in review as the
     case the PR claimed and did not pin.

     A line ending exactly at the boundary is arranged rather than hoped for —
     the padding is computed from the boundary, so this cannot quietly stop
     testing what it says if the fixture changes shape. */
  const dir = scratch()
  const path = join(dir, 'session.jsonl')
  const usage = { input_tokens: 1, output_tokens: 10 }
  const target = { runtime: 'c', kind: 'claude', path, size: 0, mtime: 0 } as const

  const BOUNDARY = 64 * 1024
  const base = JSON.parse(claudeLine('msg_1', usage)) as Record<string, unknown>
  /* Pad the cwd so the record *plus its `\r`* is exactly the boundary: the
     `\r` is then the last byte of the first chunk and the `\n` the first
     byte of the second.

     The first version of this arithmetic was a byte short — `${first}\r`
     came to `BOUNDARY - 1`, which puts the `\n` at the last index of the
     first chunk and splits nothing — and the assertion below locked that in.
     Both reviewers found it. Twice now in this change a test of mine has
     asserted its own error, which is why the split is no longer assumed
     below but read off the stream. */
  const bare = JSON.stringify({ ...base, cwd: '/tmp/project' })
  const padding = BOUNDARY - Buffer.byteLength(bare, 'utf8') - 1
  assert.ok(padding > 0, 'the fixture is smaller than the read boundary')
  const first = JSON.stringify({ ...base, cwd: `/tmp/project${'x'.repeat(padding)}` })
  assert.equal(Buffer.byteLength(`${first}\r`, 'utf8'), BOUNDARY)

  writeFileSync(path, `${first}\r\n${crlf(claudeLine('msg_2', usage))}`)

  /* And the premise, proved rather than assumed. A test named for a split
     terminator that quietly stops splitting is worse than no test: it reports
     that the case is covered. This reads the file the way `readLines` does
     and asserts where the chunks actually fall — if Node's default read size
     ever changes, this fails and says so instead of going green on nothing. */
  const chunks: Buffer[] = []
  for await (const chunk of createReadStream(path)) chunks.push(chunk as Buffer)
  assert.ok(chunks.length >= 2, 'the fixture is read in more than one chunk')
  assert.equal(chunks[0]?.at(-1), 0x0d, 'the first chunk ends on the CR')
  assert.equal(chunks[1]?.at(0), 0x0a, 'and the LF opens the second')

  const result = await scanClaudeTranscript(target, 0, [])
  assert.equal(result.rows[0]?.requests, 2, 'both records survive the split terminator')
  assert.equal(result.offset, statSync(path).size)
})

test('an id the catalogue lacks is priced by a dated extension of it, never by a variant', async () => {
  // #32: any catalogue id that extended the asked one matched, and the longest won.
  const dir = scratch()
  const pricing = new Pricing({
    cachePath: join(dir, 'cache.json'),
    overlayPath: join(dir, 'missing.json'),
    fetchCatalogue: async () => ({
      anthropic: {
        models: {
          'claude-opus-5-20260101': { id: 'claude-opus-5-20260101', cost: { input: 5, output: 25 } },
          'claude-opus-5-fast-preview': { id: 'claude-opus-5-fast-preview', cost: { input: 60, output: 300 } },
          'claude-sonnet-5-mini': { id: 'claude-sonnet-5-mini', cost: { input: 0.1, output: 0.5 } },
        },
      },
    }),
  })
  await pricing.warm()
  // The undated name of a dated id is that model.
  assert.equal(pricing.rateFor('claude-opus-5')?.input, 5 / 1_000_000)
  // A variant is another model: no price, rather than its price.
  assert.equal(pricing.rateFor('claude-sonnet-5'), null)
})

test('a resumed Codex scan keeps the model and project it had read', async () => {
  // #33: both are said near the top of a rollout, and a resumed scan starts after them.
  const dir = scratch()
  const path = join(dir, 'rollout.jsonl')
  const line = (record: object): string => `${JSON.stringify(record)}\n`
  const spent = (at: string): string =>
    line({
      type: 'event_msg',
      timestamp: at,
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 } } },
    })
  writeFileSync(
    path,
    line({ type: 'session_meta', timestamp: '2026-09-10T11:00:00Z', payload: { cwd: dir, model: 'gpt-5.5' } }) + spent('2026-09-10T11:01:00Z'),
  )
  const target = { path, runtime: 'codex', kind: 'codex', size: 0, mtime: 0 } as unknown as Parameters<typeof scanCodexRollout>[0]
  const first = await scanCodexRollout(target, 0, [])
  appendFileSync(path, spent('2026-09-10T11:02:00Z'))
  const second = await scanCodexRollout(target, first.offset, first.tail)

  const read = (row: unknown) => row as { model: string; project: string }
  assert.equal(read(first.rows[0]).model, 'gpt-5.5', 'the control: the first scan saw the model')
  assert.notEqual(read(first.rows[0]).project, '')
  assert.equal(second.rows.length, 1, 'only the appended event')
  assert.equal(read(second.rows[0]).model, 'gpt-5.5')
  assert.equal(read(second.rows[0]).project, read(first.rows[0]).project)
})
