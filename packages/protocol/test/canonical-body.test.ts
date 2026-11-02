import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as protocol from '../src/index.js'

const api = protocol as unknown as { canonicalTranscriptBody?: (value: unknown) => { canonical: string; bytes: number } }

test('canonical transcript body preserves ordered content while normalizing object key order', () => {
  assert.equal(typeof api.canonicalTranscriptBody, 'function', 'exact canonical body identity is available')
  const canonical = api.canonicalTranscriptBody!
  const a = [{ id: 'turn', items: [{ type: 'assistantMessage', text: 'héllo' }], status: 'completed' }]
  const b = [{ status: 'completed', items: [{ text: 'héllo', type: 'assistantMessage' }], id: 'turn' }]
  const result = canonical(a)
  assert.deepEqual(result, canonical(b))
  assert.equal(result.bytes, new TextEncoder().encode(result.canonical).byteLength)
  assert.notEqual(result.canonical, canonical([{ ...a[0], items: [{ ...a[0]!.items[0], text: 'hello' }] }]).canonical)
  const other = { ...a[0]!, id: 'other' }
  assert.notEqual(canonical([a[0], other]).canonical, canonical([other, a[0]]).canonical)
})
