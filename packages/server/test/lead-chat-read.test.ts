import assert from 'node:assert/strict'
import test from 'node:test'
import type { PhoneWorkThread } from '@harnessdesk/protocol'
import { boundLeadChatRead } from '../src/lead/chat-read.js'

const thread = (turns: PhoneWorkThread['turns']): PhoneWorkThread => ({ id: 'fixture:chat', title: 'Capture', agent: { name: 'Agent' }, status: 'done', turns })

test('Lead chat reads retain recent context within the tool limit and disclose omitted history', () => {
  const result = boundLeadChatRead(thread(Array.from({ length: 20 }, (_, i) => ({ type: 'agent', id: `m${i}`, markdown: `Reply ${i}: ` + 'Useful context. '.repeat(200) }))))
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12_000)
  assert.equal(result.omittedSourceTurns, 0)
  assert.ok(result.omittedPhoneEntries > 0)
  assert.equal(result.omittedPhoneEntries + result.turns.length, 20)
  assert.equal(result.turns.at(-1)?.id, 'm19')
  assert.equal(result.truncated, true)
})

test('a single large Unicode reply is bounded without breaking characters or hiding the partial read', () => {
  const result = boundLeadChatRead(thread([{ type: 'agent', id: 'm1', markdown: '😀'.repeat(16_000) }]))
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12_000)
  assert.equal(result.turns.length, 1)
  assert.equal(result.truncated, true)
  assert.doesNotThrow(() => encodeURIComponent(JSON.stringify(result)))
})

test('a short read remains complete and preserves the original turn data', () => {
  const original = thread([{ type: 'you', id: 'm1', text: 'Capture it', attachments: [] }, { type: 'agent', id: 'm2', markdown: 'Saved capture.png' }])
  const result = boundLeadChatRead(original)
  assert.deepEqual(result.turns, original.turns)
  assert.equal(result.omittedPhoneEntries, 0)
  assert.equal(result.truncated, false)
})
