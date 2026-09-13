import assert from 'node:assert/strict'
import { test } from 'node:test'

import { imagesInToolContent } from '../src/runtime.js'

test('imagesInToolContent extracts valid image blocks', () => {
  const extracted = imagesInToolContent([
    {
      type: 'content',
      content: {
        type: 'image',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        mimeType: 'image/png',
      },
    },
  ])
  assert.equal(extracted.length, 1)
  assert.equal(extracted[0]?.type, 'image')
  assert.equal(extracted[0]?.mimeType, 'image/png')
  assert.ok(extracted[0]?.url.startsWith('data:image/png;base64,'))
})

test('imagesInToolContent ignores non-image content blocks', () => {
  const extracted = imagesInToolContent([
    { type: 'content', content: { type: 'text', text: 'some text' } },
    { type: 'text', text: 'raw text' },
  ])
  assert.deepEqual(extracted, [])
})

test('imagesInToolContent safely ignores null and malformed blocks (#411)', () => {
  assert.deepEqual(imagesInToolContent(null), [])
  assert.deepEqual(imagesInToolContent(undefined), [])
  assert.deepEqual(imagesInToolContent('not an array'), [])
  assert.deepEqual(imagesInToolContent([null]), [])
  assert.deepEqual(imagesInToolContent([undefined]), [])
  assert.deepEqual(imagesInToolContent([42, 'string', true]), [])
  assert.deepEqual(imagesInToolContent([{ type: 'content', content: null }]), [])
  assert.deepEqual(imagesInToolContent([{ type: 'content', content: undefined }]), [])
  assert.deepEqual(imagesInToolContent([{ type: 'content', content: 'not an object' }]), [])

  // Mixed valid image block with malformed blocks
  const extracted = imagesInToolContent([
    null,
    { type: 'content', content: null },
    {
      type: 'content',
      content: {
        type: 'image',
        data: 'aGVsbG8=',
        mimeType: 'image/jpeg',
      },
    },
    undefined,
    42,
  ])
  assert.equal(extracted.length, 1)
  assert.equal(extracted[0]?.url, 'data:image/jpeg;base64,aGVsbG8=')
  assert.equal(extracted[0]?.mimeType, 'image/jpeg')
})
