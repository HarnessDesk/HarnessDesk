import assert from 'node:assert/strict'
import { test } from 'node:test'

import { permissionReason } from '../src/runtime.js'

test('permissionReason extracts text from content blocks', () => {
  assert.equal(
    permissionReason({
      toolCallId: 'tc-1',
      content: [{ type: 'content', content: { type: 'text', text: 'needs access outside workspace' } }],
    }),
    'needs access outside workspace',
  )
  assert.equal(
    permissionReason({
      toolCallId: 'tc-1',
      content: [{ type: 'text', text: 'direct text reason' }],
    }),
    'direct text reason',
  )
})

test('permissionReason handles null or non-object content blocks gracefully', () => {
  // An agent might send null, undefined, or primitive items in toolCall.content
  assert.equal(
    permissionReason({
      toolCallId: 'tc-1',
      content: [null as unknown as { type: string }],
    }),
    null,
  )
  assert.equal(
    permissionReason({
      toolCallId: 'tc-1',
      content: [undefined as unknown as { type: string }],
    }),
    null,
  )
  assert.equal(
    permissionReason({
      toolCallId: 'tc-1',
      content: [
        null as unknown as { type: string },
        { type: 'content', content: { type: 'text', text: 'still extracts valid text' } },
        42 as unknown as { type: string },
      ],
    }),
    'still extracts valid text',
  )
})
