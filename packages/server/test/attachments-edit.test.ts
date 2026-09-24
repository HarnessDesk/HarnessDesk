import assert from 'node:assert/strict'
import { test } from 'node:test'

import { attachmentFieldEdit } from '../src/attachments/edit.js'

/**
 * `attachmentFieldEdit` is the pure line-preserving patcher `agent/attachment/
 * edit/preview` and `.../write` both call — the same shape of proof
 * `agent-def.ts`'s own `ceilingEdit` already has for the one line it edits,
 * extended to two fields that must compose in a single pass.
 */

const source = [
  '---',
  'name: Reviewer',
  'ceiling: read',
  'prefer: [fake]',
  '---',
  'Read the diff and say what is wrong with it.',
  '',
].join('\n')

test('adds both fields fresh when neither is declared, touching nothing else', () => {
  const result = attachmentFieldEdit(source, { skills: ['review-checklist'], mcp: ['reviewer-tools'] })
  assert.ok(!('refused' in result))
  if ('refused' in result) return
  assert.equal(
    result.next,
    ['---', 'name: Reviewer', 'ceiling: read', 'prefer: [fake]', 'skills: [review-checklist]', 'mcp: [reviewer-tools]', '---', 'Read the diff and say what is wrong with it.', ''].join('\n'),
  )
  assert.match(result.diff, /\+skills: \[review-checklist\]/)
  assert.match(result.diff, /\+mcp: \[reviewer-tools\]/)
})

test('replaces an existing flow-style list in place, preserving line order around it', () => {
  const withSkills = [
    '---',
    'name: Reviewer',
    'skills: [old-one]',
    'ceiling: read',
    '---',
    'Brief.',
    '',
  ].join('\n')
  const result = attachmentFieldEdit(withSkills, { skills: ['new-one', 'another'], mcp: [] })
  assert.ok(!('refused' in result))
  if ('refused' in result) return
  assert.equal(
    result.next,
    ['---', 'name: Reviewer', 'skills: [new-one, another]', 'ceiling: read', 'mcp: []', '---', 'Brief.', ''].join('\n'),
  )
})

test('replaces a block-style list entirely, consuming every "- item" line under it', () => {
  const withBlockSkills = [
    '---',
    'name: Reviewer',
    'skills:',
    '  - old-one',
    '  - old-two',
    'ceiling: read',
    '---',
    'Brief.',
    '',
  ].join('\n')
  const result = attachmentFieldEdit(withBlockSkills, { skills: ['new-one'], mcp: [] })
  assert.ok(!('refused' in result))
  if ('refused' in result) return
  assert.equal(
    result.next,
    ['---', 'name: Reviewer', 'skills: [new-one]', 'ceiling: read', 'mcp: []', '---', 'Brief.', ''].join('\n'),
  )
})

test('an empty list is written as [] , never omitted and never "None"', () => {
  const result = attachmentFieldEdit(source, { skills: [], mcp: [] })
  assert.ok(!('refused' in result))
  if ('refused' in result) return
  assert.match(result.next, /\nskills: \[\]\n/)
  assert.match(result.next, /\nmcp: \[\]\n/)
})

test('a file with no closing fence is refused, never guessed at', () => {
  const broken = '---\nname: Reviewer\n'
  const result = attachmentFieldEdit(broken, { skills: ['x'], mcp: [] })
  assert.deepEqual(result, { refused: 'its front matter opens with "---" and is never closed' })
})

test('a file with no opening fence at all is refused', () => {
  const result = attachmentFieldEdit('name: Reviewer\n', { skills: ['x'], mcp: [] })
  assert.deepEqual(result, { refused: 'its front matter opens with "---" and is never closed' })
})

test('a duplicate skills: line is refused rather than picking one silently', () => {
  const duplicated = ['---', 'skills: [a]', 'skills: [b]', '---', 'Brief.', ''].join('\n')
  const result = attachmentFieldEdit(duplicated, { skills: ['c'], mcp: [] })
  assert.deepEqual(result, { refused: 'it lists skills: more than once — keep one line by hand' })
})

test('unrelated lines, comments and CRLF endings survive exactly as they were', () => {
  const crlf = ['---', 'name: Reviewer', 'ceiling: read', '---', 'Line one.', 'Line two.', ''].join('\r\n')
  const result = attachmentFieldEdit(crlf, { skills: ['x'], mcp: [] })
  assert.ok(!('refused' in result))
  if ('refused' in result) return
  assert.ok(result.next.includes('\r\n'), 'CRLF line endings are preserved, not normalized to LF')
  assert.ok(result.next.includes('Line one.\r\nLine two.'), 'body text is untouched')
})

test('choosing the exact same fields as already declared is a no-op diff', () => {
  const withSkills = ['---', 'skills: [a]', 'mcp: [b]', '---', 'Brief.', ''].join('\n')
  const result = attachmentFieldEdit(withSkills, { skills: ['a'], mcp: ['b'] })
  assert.ok(!('refused' in result))
  if ('refused' in result) return
  assert.equal(result.next, withSkills)
  assert.equal(result.diff, '(no change)\n')
})
