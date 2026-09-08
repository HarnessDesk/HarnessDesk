import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CodexError, NdjsonDecoder, encodeLine } from '../src/index.js'

test('decodes several messages from one chunk', () => {
  const decoder = new NdjsonDecoder()
  const out = decoder.push('{"a":1}\n{"a":2}\n')
  assert.deepEqual(out, [{ a: 1 }, { a: 2 }])
  assert.equal(decoder.pending, 0)
})

test('holds a partial line until its newline arrives', () => {
  const decoder = new NdjsonDecoder()
  assert.deepEqual(decoder.push('{"a":'), [])
  assert.ok(decoder.pending > 0)
  assert.deepEqual(decoder.push('1}\n'), [{ a: 1 }])
  assert.equal(decoder.pending, 0)
})

test('a message split across many chunks survives', () => {
  const decoder = new NdjsonDecoder()
  const line = encodeLine({ big: 'y'.repeat(5000) })
  const collected: unknown[] = []
  for (let i = 0; i < line.length; i += 97) {
    collected.push(...decoder.push(line.slice(i, i + 97)))
  }
  assert.equal(collected.length, 1)
  assert.equal((collected[0] as { big: string }).big.length, 5000)
})

test('a malformed line is reported and skipped without losing the stream', () => {
  const malformed: string[] = []
  const decoder = new NdjsonDecoder({ onMalformedLine: (line) => malformed.push(line) })
  const out = decoder.push('not json\n{"a":1}\n')
  assert.deepEqual(out, [{ a: 1 }])
  assert.deepEqual(malformed, ['not json'])
})

test('blank lines are ignored', () => {
  const decoder = new NdjsonDecoder()
  assert.deepEqual(decoder.push('\n\n{"a":1}\n\n'), [{ a: 1 }])
})

test('an unbounded line is refused rather than buffered forever', () => {
  const decoder = new NdjsonDecoder({ maxLineBytes: 64 })
  assert.throws(() => decoder.push('z'.repeat(65)), CodexError)
  // The decoder resets, so the next well-formed line still parses.
  assert.deepEqual(decoder.push('{"a":1}\n'), [{ a: 1 }])
})

test('encodeLine round-trips through the decoder', () => {
  const decoder = new NdjsonDecoder()
  const value = { method: 'thread/started', params: { nested: { text: 'has\nnewline' } } }
  assert.deepEqual(decoder.push(encodeLine(value)), [value])
})
