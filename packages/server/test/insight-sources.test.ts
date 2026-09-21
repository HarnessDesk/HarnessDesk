import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { scanClaudeTranscript, scanCodexRollout } from '../src/ledger/scan.js'
import { tempDir } from './scratch.js'

const target = (kind: 'codex' | 'claude', path: string) => ({ runtime: kind, kind, path, size: 0, mtime: 0 })

test('scanner detail preserves source identity and unknown numeric fields without changing aggregate rows', async () => {
  const dir = tempDir('hd-insight-source-')
  const codex = join(dir, 'rollout.jsonl')
  await writeFile(codex, `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/project' } })}\n${JSON.stringify({ timestamp: '2026-09-20T00:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } } } })}\n`)
  const samples: import('../src/ledger/insight.js').UsageSample[] = []
  const plain = await scanCodexRollout(target('codex', codex), 0, [])
  const detailed = await scanCodexRollout(target('codex', codex), 0, [], { emit: (sample) => samples.push(sample), byteLimit: 1024 })
  assert.deepEqual(detailed.rows, plain.rows)
  assert.equal(samples.length, 1)
  assert.equal(samples[0]?.input.value, 6)
  assert.equal(samples[0]?.cacheRead.value, 4)
  assert.equal(samples[0]?.cacheWrite.value, null)
  assert.ok(!samples[0]?.source.id.includes(dir), 'wire source id does not disclose its path')

  const claude = join(dir, 'claude.jsonl')
  await writeFile(claude, `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', cwd: '/work/project', message: { id: 'one', model: 'claude-test', usage: { input_tokens: 2 } } })}\n`)
  const claudeSamples: import('../src/ledger/insight.js').UsageSample[] = []
  await scanClaudeTranscript(target('claude', claude), 0, [], { emit: (sample) => claudeSamples.push(sample), byteLimit: 1024 })
  assert.equal(claudeSamples[0]?.output.value, null)
})
