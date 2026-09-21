import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { scanClaudeTranscript, scanCodexRollout } from '../src/ledger/scan.js'
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
