import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import nodeFsPromises from 'node:fs/promises'
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { Ledger } from '../src/ledger/index.js'
import { INSIGHT_BYTE_LIMIT_MESSAGE, InsightBudgetExceededError } from '../src/ledger/insight.js'
import { Pricing } from '../src/ledger/pricing.js'
import { scanClaudeTranscript, scanClineDatabase, scanCodexRollout, scanGeminiChat, scanOpencodeDatabase, scanQwenTranscript } from '../src/ledger/scan.js'
import { seatFor } from '../src/insight/attribution.js'
import { InsightPlane } from '../src/insight/plane.js'
import { tempDir } from './scratch.js'

const target = (kind: 'codex' | 'claude', path: string) => ({ runtime: kind, kind, path, size: 0, mtime: 0 })

/** A minimal Codex `session_meta` line, setting the project and session id every later event line joins. */
const codexSessionMeta = (id: string): string => `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/project' } })}\n`
/** A minimal Codex `token_count` event line: the unit both discovery size and the read budget are measured in for these tests. */
const codexEvent = (at: string): string => `${JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } } })}\n`

test('scanner detail preserves source identity and unknown numeric fields without changing aggregate rows', async () => {
  const dir = tempDir('hd-insight-source-')
  const codex = join(dir, 'rollout.jsonl')
  await writeFile(codex, `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-1', cwd: '/work/project' } })}\n${JSON.stringify({ timestamp: '2026-09-20T00:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } } } })}\n`)
  const samples: import('../src/ledger/insight.js').UsageSample[] = []
  const plain = await scanCodexRollout(target('codex', codex), 0, [])
  const detailed = await scanCodexRollout(target('codex', codex), 0, [], { emit: (sample) => samples.push(sample), byteLimit: 1024 })
  assert.deepEqual(detailed.rows, plain.rows)
  assert.equal(samples.length, 1)
  assert.equal(samples[0]?.input.value, 6)
  assert.equal(samples[0]?.cacheRead.value, 4)
  assert.equal(samples[0]?.cacheWrite.value, null)
  assert.ok(!samples[0]?.source.id.includes(dir), 'wire source id does not disclose its path')
  assert.equal(samples[0]?.source.label, 'Recorded usage', 'source presentation does not name the scanner backend')
  assert.equal(samples[0]?.sessionId, 'session-1', 'the source session remains joinable after scanning')
  assert.equal(seatFor(samples[0]!, [{ id: 'seat-1', runtime: 'codex', sessionId: 'session-1', project: '/work/project', openedAt: 0, closedAt: null, restored: false }]), 'seat-1')
  const document = { goal: { id: 'goal-1', root: '/work/project', sentence: 'Account for it', state: 'wrapped' }, receipt: { id: 'receipt-1', seats: ['seat-1'] } }
  const receipt = await new InsightPlane({
    ledger: () => ({ readInsight: async () => ({ samples, sources: [samples[0]!.source], gaps: [], complete: true }) }) as never,
    goals: { store: { list: () => [document], read: () => document } } as never,
    seats: () => [{ id: 'seat-1', agent: null, briefDigest: null, seat: { runtime: 'codex' }, seatLabel: 'Codex', checkout: { project: '/work/project' }, board: 'goal-1', session: { runtime: 'codex', sessionId: 'session-1' }, openedAt: 0, closed: null }] as never,
    seating: {} as never,
    now: () => Date.parse('2026-09-21T00:00:00.000Z'),
  }).goal('goal-1')
  assert.equal(receipt.totals.tokens.value, 12, 'a receipt includes the scanned Seat contribution')

  const claude = join(dir, 'claude.jsonl')
  await writeFile(claude, `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', cwd: '/work/project', message: { id: 'one', model: 'claude-test', usage: { input_tokens: 2 } } })}\n`)
  const claudeSamples: import('../src/ledger/insight.js').UsageSample[] = []
  await scanClaudeTranscript(target('claude', claude), 0, [], { emit: (sample) => claudeSamples.push(sample), byteLimit: 1024 })
  assert.equal(claudeSamples[0]?.output.value, null)
})

test('a scanner read gap remains visible when no usage samples were recovered', async () => {
  const source = { id: 'unreadable', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: 'Permission denied' }
  const report = await new InsightPlane({
    ledger: () => ({ readInsight: async () => ({ samples: [], sources: [source], gaps: ['Recorded usage could not be read: Permission denied.'], complete: false }) }) as never,
    goals: { store: { list: () => [] } } as never,
    seats: () => [],
    seating: {} as never,
    now: () => 20,
  }).usage({ root: '/work/project', from: 0, to: 10 })
  assert.deepEqual(report.gaps, ['Recorded usage could not be read: Permission denied.'])
  assert.deepEqual(report.sources, [source])
  assert.equal(report.totals.usd.coverage, 'none')
})

test('scanner omissions remain unknown detail fields instead of zero across every scanner shape', async () => {
  const dir = tempDir('hd-insight-unknown-')
  const emitted = async (scan: (emit: (sample: import('../src/ledger/insight.js').UsageSample) => void) => Promise<unknown>, absentCacheWrite = false) => {
    const samples: import('../src/ledger/insight.js').UsageSample[] = []
    await scan((sample) => samples.push(sample))
    assert.equal(samples.length, 1)
    assert.equal(samples[0]?.output.value, null, 'missing output is unavailable, not a known zero')
    assert.equal(samples[0]?.cacheRead.value, null, 'missing cache read is unavailable, not a known zero')
    if (absentCacheWrite) assert.equal(samples[0]?.cacheWrite.value, null, 'missing cache writes stay a source gap, never a priced zero')
  }
  const qwen = join(dir, 'qwen.jsonl')
  await writeFile(qwen, `${JSON.stringify({ uuid: 'q', type: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', cwd: '/work/project', model: 'qwen', usageMetadata: { promptTokenCount: 10 } })}\n`)
  await emitted((emit) => scanQwenTranscript({ runtime: 'qwen', kind: 'qwen', path: qwen, size: 0, mtime: 0 }, 0, [], { emit, byteLimit: 1024 }), true)

  const geminiDir = join(dir, 'gemini', 'project', 'chats'); await mkdir(geminiDir, { recursive: true })
  const gemini = join(geminiDir, 'chat.jsonl')
  await writeFile(gemini, `${JSON.stringify({ type: 'gemini', id: 'g', timestamp: '2026-09-20T00:00:00.000Z', model: 'gemini', tokens: { input: 10 } })}\n`)
  await emitted((emit) => scanGeminiChat({ runtime: 'gemini', kind: 'gemini', path: gemini, size: 0, mtime: 0 }, { emit, byteLimit: 1024 }), true)

  // A real SQLite file is at least a page (8 KiB measured here) however small
  // its one row is, so the budget given a database scanner needs headroom a
  // JSONL scanner's byte-for-byte fixture does not: this is about omitted
  // fields, not the budget itself, which gets its own dedicated coverage below.
  const opencode = join(dir, 'opencode.db'); const openDb = new DatabaseSync(opencode)
  openDb.exec('CREATE TABLE session (directory TEXT, model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_updated INTEGER)')
  openDb.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('/work/project', 'open', 1, 10, null, null, null, 0, 20); openDb.close()
  await emitted((emit) => scanOpencodeDatabase({ runtime: 'opencode', kind: 'opencode', path: opencode, size: 0, mtime: 0 }, { emit, byteLimit: 64 * 1024 }))

  const cline = join(dir, 'cline.db'); const clineDb = new DatabaseSync(cline)
  clineDb.exec('CREATE TABLE sessions (model TEXT, cwd TEXT, workspace_root TEXT, started_at TEXT, updated_at TEXT, metadata_json TEXT)')
  clineDb.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('cline', '/work/project', '/work/project', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', JSON.stringify({ usage: { inputTokens: 10, totalCost: 1 } })); clineDb.close()
  await emitted((emit) => scanClineDatabase({ runtime: 'cline', kind: 'cline', path: cline, size: 0, mtime: 0 }, { emit, byteLimit: 64 * 1024 }))
})

test('a missing Gemini-format cache write cannot become a complete list-price cost', async () => {
  const dir = tempDir('hd-insight-unpriced-cache-write-')
  const root = join(dir, 'qwen')
  const chats = join(root, 'project', 'chats')
  await mkdir(chats, { recursive: true })
  await writeFile(join(chats, 'call.jsonl'), `${JSON.stringify({ uuid: 'q', type: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', cwd: '/work/project', model: 'qwen', usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 0, candidatesTokenCount: 1, thoughtsTokenCount: 0, toolUsePromptTokenCount: 0 } })}\n`)
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'qwen', kind: 'qwen', root }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'rates.local.json'), fetchCatalogue: async () => ({ alibaba: { models: { qwen: { id: 'qwen', cost: { input: 1, output: 1, cache_read: 1, cache_write: 1 } } } } }) }),
  })
  try {
    const detail = await ledger.readInsight({ root: '/work/project', from: Date.parse('2026-09-19T00:00:00.000Z'), to: Date.parse('2026-09-21T00:00:00.000Z') })
    assert.equal(detail.samples[0]?.cacheWrite.value, null)
    assert.equal(detail.samples[0]?.usd.value, null, 'the list price remains unknown while a required source field is absent')
    assert.equal(detail.complete, false)
  } finally { ledger.close() }
})

test('an unreadable corpus root is a source-read gap, not an empty project', async () => {
  const dir = tempDir('hd-insight-unreadable-')
  const notADirectory = join(dir, 'not-a-directory')
  await writeFile(notADirectory, 'not a corpus')
  const ledger = new Ledger({ stateDir: dir, databasePath: join(dir, 'usage.sqlite'), corpora: [{ runtime: 'codex', kind: 'codex', root: notADirectory }] })
  try {
    const detail = await ledger.readInsight({ root: '/work/project', from: 0, to: 10 })
    assert.equal(detail.samples.length, 0)
    assert.ok(detail.gaps.some((gap) => gap.includes('could not be discovered')), 'the failed root walk remains visible')
  } finally { ledger.close() }
})

test('a discovery exception becomes a fixed report gap and opaque failed source', async () => {
  const dir = tempDir('hd-insight-discovery-exception-')
  const marker = '/agent-owned/private/corpus-path-that-must-not-escape'
  let rootReads = 0
  const corpus = {
    runtime: 'throwing',
    kind: 'codex' as const,
    get root(): string {
      if (rootReads++ === 0) throw new Error(marker)
      return dir
    },
  }
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [corpus],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'rates.local.json'), fetchCatalogue: async () => ({}) }),
    now: () => 10,
  })
  const plane = new InsightPlane({
    ledger: () => ledger,
    goals: { store: { list: () => [] } } as never,
    seats: () => [],
    seating: {} as never,
    now: () => 10,
  })
  try {
    const report = await plane.usage({ root: '/work/project', from: 0, to: 10 })
    assert.deepEqual(report.gaps, ['Recorded usage source could not be discovered.'])
    assert.deepEqual(report.sources.map((source) => ({ runtime: source.runtime, problem: source.problem })), [
      { runtime: 'throwing', problem: 'Recorded usage source could not be discovered.' },
    ])
    assert.ok(!JSON.stringify(report).includes(marker), 'the public report never serializes the discovery error')
  } finally { ledger.close() }
})

test('Ledger carries an opaque runtime-qualified unreadable corpus source into unscoped and selected Insight reads', async () => {
  const dir = tempDir('hd-insight-plane-unreadable-')
  const alpha = join(dir, 'alpha')
  await mkdir(alpha)
  await writeFile(join(alpha, 'rollout.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'alpha-session', cwd: '/work/project' } })}\n${JSON.stringify({ timestamp: '1970-01-01T00:00:00.001Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } } })}\n`)
  const beta = join(dir, 'not-a-directory')
  await writeFile(beta, 'not a corpus directory')
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'alpha', kind: 'codex', root: alpha }, { runtime: 'beta', kind: 'codex', root: beta }],
    now: () => 10,
  })
  const plane = new InsightPlane({
    ledger: () => ledger,
    goals: { store: { list: () => [] } } as never,
    seats: () => [],
    seating: {} as never,
    now: () => 10,
  })
  try {
    const all = await plane.usage({ root: '/work/project', from: 0, to: 10 })
    const failed = all.sources.find((source) => source.runtime === 'beta')
    assert.deepEqual(failed && {
      runtime: failed.runtime, kind: failed.kind, label: failed.label, observedAt: failed.observedAt,
      checkedAt: failed.checkedAt, stale: failed.stale, problem: failed.problem,
    }, {
      runtime: 'beta', kind: 'corpus', label: 'Recorded usage', observedAt: null,
      checkedAt: 10, stale: false, problem: 'Recorded usage source could not be discovered.',
    })
    assert.ok(failed && !failed.id.includes(beta), 'the failed source identifier does not disclose its corpus path')
    assert.equal(all.totals.usd.value, null, 'the failed source does not invent a known zero')

    const alphaOnly = await plane.usage({ root: '/work/project', from: 0, to: 10, runtime: 'alpha' })
    assert.ok(alphaOnly.sources.every((source) => source.runtime !== 'beta'), 'a selected runtime excludes another runtime’s failed corpus')
    const betaOnly = await plane.usage({ root: '/work/project', from: 0, to: 10, runtime: 'beta' })
    assert.deepEqual(betaOnly.sources.map((source) => source.id), [failed?.id], 'the selected failed runtime retains its opaque source record')
  } finally { ledger.close() }
})

test('a selected runtime does not inherit scanner gaps from another runtime corpus', async () => {
  const dir = tempDir('hd-insight-runtime-gap-')
  const alpha = join(dir, 'alpha')
  await mkdir(alpha)
  await writeFile(join(alpha, 'rollout.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'alpha-session', cwd: '/work/project' } })}\n${JSON.stringify({ timestamp: '1970-01-01T00:00:00.001Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } } })}\n`)
  const beta = join(dir, 'not-a-directory')
  await writeFile(beta, 'not a corpus directory')
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'alpha', kind: 'codex', root: alpha }, { runtime: 'beta', kind: 'codex', root: beta }],
  })
  try {
    const alphaDetail = await ledger.readInsight({ root: '/work/project', from: 0, to: 10, runtime: 'alpha' })
    assert.ok(!alphaDetail.gaps.some((gap) => gap.includes('could not be discovered')), 'another runtime’s scan failure is not a selected-runtime gap')
    assert.equal(alphaDetail.samples.length, 1)
    const betaDetail = await ledger.readInsight({ root: '/work/project', from: 0, to: 10, runtime: 'beta' })
    assert.ok(betaDetail.gaps.some((gap) => gap.includes('could not be discovered')), 'the selected runtime retains its own scanner gap')
  } finally { ledger.close() }
})

test('database corpus discovery and malformed reads retain opaque runtime-qualified source gaps', async () => {
  const dir = tempDir('hd-insight-database-source-gap-')
  const missing = join(dir, 'missing-opencode.db')
  const nonFile = join(dir, 'cline-directory')
  await mkdir(nonFile)
  const malformed = join(dir, 'malformed-opencode.db')
  await writeFile(malformed, 'this is not a sqlite database')
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [
      { runtime: 'missing', kind: 'opencode', root: missing },
      { runtime: 'non-file', kind: 'cline', root: nonFile },
      { runtime: 'malformed', kind: 'opencode', root: malformed },
    ],
    now: () => 10,
  })
  const plane = new InsightPlane({
    ledger: () => ledger,
    goals: { store: { list: () => [] } } as never,
    seats: () => [],
    seating: {} as never,
    now: () => 10,
  })
  try {
    const all = await plane.usage({ root: '/work/project', from: 0, to: 10 })
    assert.deepEqual(all.sources.map((source) => ({ runtime: source.runtime, problem: source.problem })).sort((left, right) => left.runtime!.localeCompare(right.runtime!)), [
      { runtime: 'malformed', problem: 'Recorded usage source could not be read.' },
      { runtime: 'missing', problem: 'Recorded usage source could not be discovered.' },
      { runtime: 'non-file', problem: 'Recorded usage source could not be discovered.' },
    ])
    assert.equal(all.totals.usd.value, null, 'failed database sources do not become zero spend')
    for (const source of all.sources) assert.ok(!source.id.includes(dir), 'failed source identity never discloses its corpus path')

    const malformedOnly = await plane.usage({ root: '/work/project', from: 0, to: 10, runtime: 'malformed' })
    assert.deepEqual(malformedOnly.sources.map((source) => source.runtime), ['malformed'], 'a selected runtime retains only its own failed source')
    assert.ok(malformedOnly.gaps.length > 0)
    const missingOnly = await plane.usage({ root: '/work/project', from: 0, to: 10, runtime: 'missing' })
    assert.deepEqual(missingOnly.sources.map((source) => source.runtime), ['missing'], 'a selected runtime never receives another failed source')
  } finally { ledger.close() }
})

test('target corpus-read errors redact paths while retaining an opaque failed source', async () => {
  const dir = tempDir('hd-insight-target-read-error-')
  const database = join(dir, 'opencode.db')
  const header = Buffer.alloc(20)
  header.write('SQLite format 3\0', 0, 'latin1')
  header[18] = 2
  header[19] = 2
  await writeFile(database, header)
  await mkdir(`${database}-wal`)
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'target-error', kind: 'opencode', root: database }],
    now: () => 10,
  })
  try {
    const detail = await ledger.readInsight({ root: '/work/project', from: 0, to: 10 })
    assert.deepEqual(detail.sources.map((source) => ({ runtime: source.runtime, problem: source.problem })), [
      { runtime: 'target-error', problem: 'Recorded usage source could not be read.' },
    ])
    assert.ok(detail.gaps.length > 0, 'the source-read gap remains visible')
    for (const gap of detail.gaps) assert.ok(!gap.includes(dir), 'a target read error never exposes its corpus path')
    assert.ok(!detail.sources[0]?.id.includes(dir), 'the failed source identity remains opaque')
  } finally { ledger.close() }
})

test('a source that grows after discovery is never read past the remaining Insight budget', async () => {
  const dir = tempDir('hd-insight-growth-')
  const path = join(dir, 'rollout.jsonl')
  // What `listTargets` would have measured at discovery: small.
  await writeFile(path, codexSessionMeta('growth-session') + codexEvent('2026-09-20T00:00:00.000Z'))
  const discoveredSize = (await stat(path)).size
  // The source keeps growing after that — an agent still writing, or a
  // transcript rewritten under the scanner — so by the time this call
  // actually reads it, it is far larger than the stale `target.size` below
  // (deliberately left at `discoveredSize`) says it is.
  const appended = Array.from({ length: 200 }, (_unused, index) => codexEvent(`2026-09-20T00:01:${String(index % 60).padStart(2, '0')}.000Z`)).join('')
  await appendFile(path, appended)
  assert.ok((await stat(path)).size > discoveredSize + 1_000, 'the fixture really did grow well past its discovered size')

  const growthTarget = { runtime: 'codex', kind: 'codex' as const, path, size: discoveredSize, mtime: 0 }
  const samples: import('../src/ledger/insight.js').UsageSample[] = []
  // Room for the already-discovered content plus a few of the newly appended
  // lines — nowhere near the 200 that were added after discovery.
  const remaining = discoveredSize + 400
  await assert.rejects(
    scanCodexRollout(growthTarget, 0, [], { emit: (sample) => samples.push(sample), byteLimit: remaining }),
    (error) => error instanceof InsightBudgetExceededError,
  )
  assert.ok(samples.length > 0, 'the source was read up to the point the remaining budget ran out')
  assert.ok(samples.length < 201, 'growth past the remaining budget was never read, let alone emitted')
})

test('the Insight byte budget is tracked across sources, not reset for each one', async () => {
  const dir = tempDir('hd-insight-cross-source-budget-')
  const alphaDir = join(dir, 'alpha'); await mkdir(alphaDir, { recursive: true })
  const alphaPath = join(alphaDir, 'rollout.jsonl')
  const alphaContent = codexSessionMeta('alpha-session') + codexEvent('2026-09-20T00:00:00.000Z')
  await writeFile(alphaPath, alphaContent)
  const alphaSize = Buffer.byteLength(alphaContent, 'utf8')

  const betaDir = join(dir, 'beta'); await mkdir(betaDir, { recursive: true })
  const betaPath = join(betaDir, 'rollout.jsonl')
  await writeFile(betaPath, codexSessionMeta('beta-session') + codexEvent('2026-09-20T00:00:01.000Z'))

  // The whole shared budget is exactly what the first source spends: nothing
  // is left for the second, wherever its own size at discovery says it fits.
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora: [{ runtime: 'alpha', kind: 'codex', root: alphaDir }, { runtime: 'beta', kind: 'codex', root: betaDir }],
    insightByteLimit: alphaSize,
  })
  try {
    const detail = await ledger.readInsight({ root: '/work/project', from: Date.parse('2026-09-19T00:00:00.000Z'), to: Date.parse('2026-09-21T00:00:00.000Z') })
    assert.deepEqual(detail.samples.map((sample) => sample.sessionId), ['alpha-session'], 'the first source alone spends the whole shared budget; the second is never read')
    assert.equal(detail.gaps.filter((gap) => gap === INSIGHT_BYTE_LIMIT_MESSAGE).length, 1, 'the shared-budget gap is reported once, not once per source left unread')
    assert.equal(detail.complete, false)
  } finally { ledger.close() }
})

test('the whole-file Gemini scanner refuses a source already over the remaining budget, rather than read part of it', async () => {
  const dir = tempDir('hd-insight-gemini-budget-')
  const geminiDir = join(dir, 'project', 'chats'); await mkdir(geminiDir, { recursive: true })
  const path = join(geminiDir, 'chat.jsonl')
  await writeFile(path, `${JSON.stringify({ type: 'gemini', id: 'g', timestamp: '2026-09-20T00:00:00.000Z', model: 'gemini', tokens: { input: 10, output: 5 } })}\n`)
  const realSize = (await stat(path)).size
  // `target.size` is deliberately wrong (0): the check must come from the
  // file itself, at the moment it is opened, never from this stale figure.
  const geminiTarget = { runtime: 'gemini', kind: 'gemini' as const, path, size: 0, mtime: 0 }
  const samples: import('../src/ledger/insight.js').UsageSample[] = []
  await assert.rejects(
    scanGeminiChat(geminiTarget, { emit: (sample) => samples.push(sample), byteLimit: realSize - 1 }),
    (error) => error instanceof InsightBudgetExceededError,
  )
  assert.equal(samples.length, 0, 'a whole file already over budget is refused wholesale, never partly parsed')

  // Comfortably within budget, the same file reads normally.
  await scanGeminiChat(geminiTarget, { emit: (sample) => samples.push(sample), byteLimit: realSize })
  assert.equal(samples.length, 1)
})

test('the OpenCode database scanner refuses a source already over the remaining budget, measured from an opened handle', async () => {
  const dir = tempDir('hd-insight-opencode-budget-')
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE session (directory TEXT, model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_updated INTEGER)')
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('/work/project', 'open', 1, 10, null, null, null, 0, 20)
  db.close()
  const realSize = (await stat(path)).size
  // `target.size` is deliberately wrong (0): the refusal must be measured
  // from `fstat` on a handle this opens itself, never this stale figure and
  // never a second `stat(path)` that could name a different file by then.
  const dbTarget = { runtime: 'opencode', kind: 'opencode' as const, path, size: 0, mtime: 0 }
  const samples: import('../src/ledger/insight.js').UsageSample[] = []
  await assert.rejects(
    scanOpencodeDatabase(dbTarget, { emit: (sample) => samples.push(sample), byteLimit: realSize - 1 }),
    (error) => error instanceof InsightBudgetExceededError,
  )
  assert.equal(samples.length, 0, 'a database already over budget is refused before it is opened for its real read')
})

test('a line with no terminator at all is never buffered past the remaining Insight budget', async (t) => {
  const dir = tempDir('hd-insight-no-newline-')
  const path = join(dir, 'rollout.jsonl')
  // One line, deliberately with no terminator anywhere in it — the shape
  // that let `pending` grow without bound, since the budget was checked
  // only when a newline arrived.
  await writeFile(path, 'x'.repeat(2_000_000))
  const budget = 1024
  let capturedEnd: number | undefined
  let capturedStream: import('node:fs').ReadStream | undefined
  const originalCreateReadStream = nodeFs.createReadStream
  t.mock.method(nodeFs, 'createReadStream', ((streamPath: unknown, options?: { start?: number; end?: number }) => {
    const stream = (originalCreateReadStream as (...args: unknown[]) => import('node:fs').ReadStream)(streamPath, options)
    if (streamPath === path) { capturedStream = stream; capturedEnd = options?.end }
    return stream
  }) as typeof nodeFs.createReadStream)

  const target = { runtime: 'codex', kind: 'codex' as const, path, size: 0, mtime: 0 }
  const samples: import('../src/ledger/insight.js').UsageSample[] = []
  await assert.rejects(
    scanCodexRollout(target, 0, [], { emit: (sample) => samples.push(sample), byteLimit: budget }),
    (error) => error instanceof InsightBudgetExceededError,
  )
  assert.ok(capturedStream, 'the mock observed the real stream open for this file')
  assert.equal(capturedEnd, budget, 'the stream itself is bounded to the remaining budget, so a terminator-free line is never buffered past it')
  // The bound above is what the source code asks the stream to do; this is
  // what the real stream, on the real file, actually did.
  assert.ok(capturedStream!.bytesRead <= budget + 1, `expected at most ${budget + 1} bytes actually read from the real file, got ${capturedStream!.bytesRead}`)
})

test('a Gemini chat that grows right after its size is checked is refused, not read past the checked size', async (t) => {
  const dir = tempDir('hd-insight-gemini-growth-')
  const geminiDir = join(dir, 'project', 'chats'); await mkdir(geminiDir, { recursive: true })
  const path = join(geminiDir, 'chat.jsonl')
  const initial = `${JSON.stringify({ type: 'gemini', id: 'g', timestamp: '2026-09-20T00:00:00.000Z', model: 'gemini', tokens: { input: 10, output: 5 } })}\n`
  await writeFile(path, initial)
  const initialSize = Buffer.byteLength(initial, 'utf8')

  // Injects the growth at the exact moment the round 1 fix could not see —
  // right after the size is checked (`handle.stat()`), before the content
  // that followed trusted it.
  const originalOpen = nodeFsPromises.open
  t.mock.method(nodeFsPromises, 'open', (async (...args: Parameters<typeof nodeFsPromises.open>) => {
    const handle = await originalOpen(...args)
    if (args[0] !== path) return handle
    const originalStat = handle.stat.bind(handle)
    t.mock.method(handle, 'stat', async () => {
      const result = await originalStat()
      await appendFile(path, 'y'.repeat(1000))
      return result
    })
    return handle
  }) as typeof nodeFsPromises.open)

  const geminiTarget = { runtime: 'gemini', kind: 'gemini' as const, path, size: 0, mtime: 0 }
  const samples: import('../src/ledger/insight.js').UsageSample[] = []
  await assert.rejects(
    scanGeminiChat(geminiTarget, { emit: (sample) => samples.push(sample), byteLimit: initialSize + 500 }),
    (error) => error instanceof InsightBudgetExceededError,
  )
  assert.equal(samples.length, 0, 'a source that grew right after the check is refused wholesale, never partly parsed')
})

test('a Gemini chat that grows a little, comfortably staying under a large budget, fails as an ordinary source, never as a budget stop', async (t) => {
  const dir = tempDir('hd-insight-gemini-minor-growth-')
  const geminiDir = join(dir, 'project', 'chats'); await mkdir(geminiDir, { recursive: true })
  const path = join(geminiDir, 'chat.jsonl')
  const initial = `${JSON.stringify({ type: 'gemini', id: 'g', timestamp: '2026-09-20T00:00:00.000Z', model: 'gemini', tokens: { input: 10, output: 5 } })}\n`
  await writeFile(path, initial)

  // Grows by 3 bytes, nowhere near the 64 MiB budget — the checked size no
  // longer matching what is actually there must still be refused (the
  // content can no longer be trusted as one coherent snapshot), but as an
  // ordinary failed source, not the shared-budget stop that would otherwise
  // end the whole read for every source still to come.
  const originalOpen = nodeFsPromises.open
  t.mock.method(nodeFsPromises, 'open', (async (...args: Parameters<typeof nodeFsPromises.open>) => {
    const handle = await originalOpen(...args)
    if (args[0] !== path) return handle
    const originalStat = handle.stat.bind(handle)
    t.mock.method(handle, 'stat', async () => {
      const result = await originalStat()
      await appendFile(path, 'xyz')
      return result
    })
    return handle
  }) as typeof nodeFsPromises.open)

  const geminiTarget = { runtime: 'gemini', kind: 'gemini' as const, path, size: 0, mtime: 0 }
  const samples: import('../src/ledger/insight.js').UsageSample[] = []
  await assert.rejects(
    scanGeminiChat(geminiTarget, { emit: (sample) => samples.push(sample), byteLimit: 64 * 1024 * 1024 }),
    (error) => !(error instanceof InsightBudgetExceededError),
  )
  assert.equal(samples.length, 0)
})

test('a Gemini source that only grew a little under budget does not stop a healthy source after it from being read', async (t) => {
  const dir = tempDir('hd-insight-gemini-minor-growth-ledger-')
  const failingDir = join(dir, 'gemini', 'failing-project', 'chats'); await mkdir(failingDir, { recursive: true })
  const failingPath = join(failingDir, 'chat.jsonl')
  await writeFile(failingPath, `${JSON.stringify({ type: 'gemini', id: 'fail', timestamp: '2026-09-20T00:00:00.000Z', model: 'gemini', tokens: { input: 1 } })}\n`)

  const codexDir = join(dir, 'codex'); await mkdir(codexDir, { recursive: true })
  await writeFile(join(codexDir, 'rollout.jsonl'), codexSessionMeta('healthy-session') + codexEvent('2026-09-20T00:00:01.000Z'))

  const originalOpen = nodeFsPromises.open
  t.mock.method(nodeFsPromises, 'open', (async (...args: Parameters<typeof nodeFsPromises.open>) => {
    const handle = await originalOpen(...args)
    if (args[0] !== failingPath) return handle
    const originalStat = handle.stat.bind(handle)
    t.mock.method(handle, 'stat', async () => {
      const result = await originalStat()
      await appendFile(failingPath, 'xyz')
      return result
    })
    return handle
  }) as typeof nodeFsPromises.open)

  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    // The failing source is listed first, so a bug that stops the whole read
    // on it would leave the healthy one after it unread.
    corpora: [
      { runtime: 'gemini-failing', kind: 'gemini', root: join(dir, 'gemini') },
      { runtime: 'codex-healthy', kind: 'codex', root: codexDir },
    ],
  })
  try {
    const detail = await ledger.readInsight({ root: '/work/project', from: Date.parse('2026-09-19T00:00:00.000Z'), to: Date.parse('2026-09-21T00:00:00.000Z') })
    assert.ok(!detail.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE), 'a minor, under-budget change must never be reported as the shared-budget gap')
    assert.ok(detail.samples.some((sample) => sample.sessionId === 'healthy-session'), 'a source after the failing one must still be read')
  } finally { ledger.close() }
})

test('bytes read from a source rejected as not JSON still count against the shared Insight budget', async () => {
  const dir = tempDir('hd-insight-nonjson-budget-')
  // Five sources, each a single line of invalid JSON around 900 KiB — well
  // past a 1 MiB shared budget summed, but `take()` rejects every one of
  // them outright (never valid JSON), so none of their bytes were ever
  // committed to the cursor `offset` reports.
  const corpora = []
  for (let index = 0; index < 5; index += 1) {
    const runtimeDir = join(dir, `runtime-${index}`)
    await mkdir(runtimeDir, { recursive: true })
    const path = join(runtimeDir, 'rollout.jsonl')
    await writeFile(path, `not valid json ${'x'.repeat(900_000)}\n`)
    corpora.push({ runtime: `runtime-${index}`, kind: 'codex' as const, root: runtimeDir })
  }
  const ledger = new Ledger({
    stateDir: dir,
    databasePath: join(dir, 'usage.sqlite'),
    corpora,
    insightByteLimit: 1024 * 1024,
  })
  try {
    const detail = await ledger.readInsight({ root: '/work/project', from: Date.parse('2026-09-19T00:00:00.000Z'), to: Date.parse('2026-09-21T00:00:00.000Z') })
    assert.ok(
      detail.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE),
      'reading far more than the budget, even from lines every one of which was rejected, must still report the gap',
    )
    assert.equal(detail.complete, false)
  } finally { ledger.close() }
})
