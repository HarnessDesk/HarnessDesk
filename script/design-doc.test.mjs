import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { groupDeclarations, leadComment, tableDensityRows } from './design-doc.mjs'

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

test('a comment between two declarations does not end their group (#754)', () => {
  const group = [
    '  --hd-text: 14px;',
    '  /* One line per step, because a size and its line are one decision. */',
    '  --hd-line: 21px;',
    '  --hd-weight-medium: 500;',
    '',
    '  /* --- shape ------------------------------------------------------- */',
    '  --hd-radius-md: 8px;',
  ].join('\n')

  // The group ends at the next section header, not at the note inside it. Read
  // the other way, every token after an explanatory comment silently left the
  // published table — and `--check` still passed, because it regenerated the
  // same truncation it was checking.
  assert.deepEqual(groupDeclarations(group), [
    ['--hd-text', '14px'],
    ['--hd-line', '21px'],
    ['--hd-weight-medium', '500'],
  ])
})

test('a band divider ends a group as a section header does (#754)', () => {
  const group = [
    '  --hd-text: 14px;',
    '  /* =================================================================',
    '     COMPONENT — the next layer down. */',
    '  --hd-btn-h: 30px;',
  ].join('\n')

  assert.deepEqual(groupDeclarations(group), [['--hd-text', '14px']])
})

test('the table density reference reports comfortable and compact values separately', () => {
  const rows = tableDensityRows()
  assert.equal(rows.length, 15)
  assert.equal(rows.find(([name]) => name === '--hd-table-row-h'), undefined)
  assert.equal(rows.find(([name]) => name === '--hd-table-log-head-h'), undefined)
  assert.deepEqual(rows.find(([name]) => name === '--hd-table-head-h'), ['--hd-table-head-h', '40px', '32px'])
  assert.deepEqual(rows.find(([name]) => name === '--hd-table-face'), ['--hd-table-face', '32px', '24px'])
})


test('the generated design reference documents the public ChannelSignal pattern', () => {
  const reference = fs.readFileSync(new URL('../docs/design-system.md', import.meta.url), 'utf8')
  assert.ok(reference.includes('### `ChannelSignal`\n'), 'ChannelSignal has a generated heading')
  assert.ok(reference.includes('A board event — claimed, completed, released'), 'ChannelSignal retains its public description')
})
