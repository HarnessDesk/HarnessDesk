import assert from 'node:assert/strict'
import test from 'node:test'
import { leadComment } from './design-doc.mjs'

test('leadComment preserves words starting with i or ic when comments omit space after asterisk (#490)', () => {
  const comment = [
    '/**',
    ' *icon: renders a lucide icon',
    ' *id: unique component id',
    ' *input: user provided text',
    ' *item: individual item',
    ' */',
  ].join('\n')

  const out = leadComment(comment)
  assert.equal(
    out,
    ['icon: renders a lucide icon', 'id: unique component id', 'input: user provided text', 'item: individual item'].join('\n'),
  )
})

test('leadComment preserves indentation and markdown bold formatting', () => {
  const comment = [
    '/**',
    ' * The description.',
    ' *',
    ' *   Indented line with two leading spaces',
    ' * **bold phrase** followed by normal text',
    '***bold without space** after gutter asterisk',
    ' */',
  ].join('\n')

  const out = leadComment(comment)
  assert.equal(
    out,
    [
      'The description.',
      '',
      '  Indented line with two leading spaces',
      '**bold phrase** followed by normal text',
      '**bold without space** after gutter asterisk',
    ].join('\n'),
  )
})
