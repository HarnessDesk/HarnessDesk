import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { Ledger } from '../src/ledger/index.js'
import { Pricing } from '../src/ledger/pricing.js'
import { scanClaudeTranscript, scanClineDatabase, scanCodexRollout, scanGeminiChat, scanOpencodeDatabase, scanQwenTranscript } from '../src/ledger/scan.js'
import { seatFor } from '../src/insight/attribution.js'
import { InsightPlane } from '../src/insight/plane.js'
import { tempDir } from './scratch.js'

const target = (kind: 'codex' | 'claude', path: string) => ({ runtime: kind, kind, path, size: 0, mtime: 0 })

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

  const opencode = join(dir, 'opencode.db'); const openDb = new DatabaseSync(opencode)
  openDb.exec('CREATE TABLE session (directory TEXT, model TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_updated INTEGER)')
  openDb.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('/work/project', 'open', 1, 10, null, null, null, 0, 20); openDb.close()
  await emitted((emit) => scanOpencodeDatabase({ runtime: 'opencode', kind: 'opencode', path: opencode, size: 0, mtime: 0 }, { emit, byteLimit: 1024 }))

  const cline = join(dir, 'cline.db'); const clineDb = new DatabaseSync(cline)
  clineDb.exec('CREATE TABLE sessions (model TEXT, cwd TEXT, workspace_root TEXT, started_at TEXT, updated_at TEXT, metadata_json TEXT)')
  clineDb.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('cline', '/work/project', '/work/project', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', JSON.stringify({ usage: { inputTokens: 10, totalCost: 1 } })); clineDb.close()
  await emitted((emit) => scanClineDatabase({ runtime: 'cline', kind: 'cline', path: cline, size: 0, mtime: 0 }, { emit, byteLimit: 1024 }))
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
