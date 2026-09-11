import assert from 'node:assert/strict'
import test from 'node:test'

import { toMcpContent } from '../src/content.js'

test('an image part is its bytes, typed by what the bytes say they are (review of #187, round 2)', () => {
  const { content } = toMcpContent({ ok: true, content: [{ type: 'image', url: 'data:image/png;base64,AAAA', mimeType: 'application/pdf' }] })
  assert.deepEqual(content, [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }])
})

test('a linked image is named as a link, because image content carries bytes (review of #187, round 2)', () => {
  // As image content, the URL itself went out as base64, which no model decodes (#51).
  const { content } = toMcpContent({ ok: true, content: [{ type: 'image', url: 'https://example.test/chart.png', mimeType: 'image/png' }] })
  assert.deepEqual(content, [{ type: 'text', text: 'An image at https://example.test/chart.png' }])
})

test('a failure is an error, and a result with nothing in it is one empty text', () => {
  assert.deepEqual(toMcpContent({ ok: false, error: 'No.' }), { content: [{ type: 'text', text: 'No.' }], isError: true })
  assert.deepEqual(toMcpContent({ ok: true, content: [] }), { content: [{ type: 'text', text: '' }] })
})
