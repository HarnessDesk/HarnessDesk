import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseYaml, YamlError } from '../src/yaml.js'

/**
 * The flow file's reader.
 *
 * Two properties carry it. It must read what a person actually writes — a
 * standing order as a block scalar, a list of records, a guard as a one-line
 * map — and it must **refuse** everything outside that by name, with the line,
 * because a document that is quietly mis-read is a room of agents doing the
 * wrong thing unattended.
 */

test('maps, lists and nesting read the way they are written', () => {
  const value = parseYaml(`
name: Fix and review
roles:
  fixer:
    kind: agent
    count: 1
  reviewer:
    kind: agent
    count: 3
rules:
  - on: fixer
    then:
      role: reviewer
      title: Review it
  - on: reviewer
    then: { role: fixer, title: Fix it again }
`)
  assert.deepEqual(value, {
    name: 'Fix and review',
    roles: {
      fixer: { kind: 'agent', count: 1 },
      reviewer: { kind: 'agent', count: 3 },
    },
    rules: [
      { on: 'fixer', then: { role: 'reviewer', title: 'Review it' } },
      { on: 'reviewer', then: { role: 'fixer', title: 'Fix it again' } },
    ],
  })
})

test('a block scalar keeps its lines, its blanks and its own hashes', () => {
  const value = parseYaml(`
order: |
  Read the diff.

  # not a comment: this is the order's own text
  Say approve or request-changes.
after: yes
`) as Record<string, string>
  assert.equal(
    value['order'],
    ['Read the diff.', '', "# not a comment: this is the order's own text", 'Say approve or request-changes.', ''].join(
      '\n',
    ),
  )
  // And the key after it is still read at the outer level.
  assert.equal(value['after'], 'yes')
})

test('|- strips the final newline and > folds a paragraph', () => {
  const value = parseYaml(`
strip: |-
  one
  two
fold: >-
  one
  two

  three
`) as Record<string, string>
  assert.equal(value['strip'], 'one\ntwo')
  assert.equal(value['fold'], 'one two\n\nthree')
})

test('quotes, escapes, numbers, booleans and null', () => {
  const value = parseYaml(`
colon: "a: b"
hash: 'it # stands'
escaped: "line\\nbreak"
count: 3
ratio: 0.5
on: true
off: false
none: null
tilde: ~
`) as Record<string, unknown>
  assert.equal(value['colon'], 'a: b')
  assert.equal(value['hash'], 'it # stands')
  assert.equal(value['escaped'], 'line\nbreak')
  assert.equal(value['count'], 3)
  assert.equal(value['ratio'], 0.5)
  assert.equal(value['on'], true)
  assert.equal(value['off'], false)
  assert.equal(value['none'], null)
  assert.equal(value['tilde'], null)
})

test('comments and blank lines are not content', () => {
  const value = parseYaml(`
# what this flow is for
name: Thing   # trailing

# a gap

count: 2
`)
  assert.deepEqual(value, { name: 'Thing', count: 2 })
})

test('a list of plain scalars, and one written inline', () => {
  const value = parseYaml(`
outcomes:
  - approve
  - request-changes
inline: [approve, request-changes]
files: []
`)
  assert.deepEqual(value, {
    outcomes: ['approve', 'request-changes'],
    inline: ['approve', 'request-changes'],
    files: [],
  })
})

test('everything outside the subset is refused by name, with the line', () => {
  const refuses = (source: string, pattern: RegExp): void => {
    assert.throws(
      () => parseYaml(source),
      (error: unknown) => {
        assert.ok(error instanceof YamlError, `expected a YamlError, got ${String(error)}`)
        assert.match(error.message, pattern)
        return true
      },
      `expected ${pattern} for:\n${source}`,
    )
  }
  refuses('a: 1\nb: &anchor 2\n', /line 2: anchors and aliases are not read here/)
  refuses('a: 1\nb: *anchor\n', /line 2: anchors and aliases are not read here/)
  refuses('a: !!str 1\n', /line 1: tags are not read here/)
  refuses('a: 1\n---\nb: 2\n', /line 2: one document per file/)
  refuses('a:\n\tb: 1\n', /line 2: indentation must be spaces/)
  refuses('a: 1\nnotapair\n', /line 2: "notapair" is not "key: value"/)
  refuses('a: "unclosed\n', /line 1: a double-quoted string is not closed/)
  refuses('a: [1, 2\n', /line 1: a \[list\] is missing a comma or its closing bracket/)
  refuses('a: 1\na: 2\n', /line 2: "a" is set twice in the same block/)
  refuses('a: 1\n  b: 2\n', /line 2: this line is indented past/)
})

test('an empty document is nothing, not a crash', () => {
  assert.equal(parseYaml(''), null)
  assert.equal(parseYaml('# only a comment\n'), null)
})

test('a key with no value is null, and its siblings still read', () => {
  assert.deepEqual(parseYaml('a:\nb: 2\n'), { a: null, b: 2 })
})

test('a block scalar may contain a line of three hyphens — front matter is content, not a document break', () => {
  /* Found twice on 2026-09-13: once writing a flow whose standing order shows
     an agent the shape of a report file, and once by an agent hunting this
     parser. The separator check ran over every *trimmed* line before anything
     was parsed, so a `---` indented inside a `|` block — where YAML says it is
     content — refused the whole file. There is nowhere else to put it: the
     scan saw the raw line list, so quoting could not help. */
  const flow = [
    'order: |',
    '  Start the file with front matter:',
    '',
    '      ---',
    '      title: what is wrong',
    '      ---',
    '',
    '  Then the body.',
    'after: 2',
  ].join('\n')
  const read = parseYaml(flow) as { order: string; after: number }
  assert.equal(read.after, 2)
  assert.match(read.order, /^ {4}---$/m)
  assert.equal((read.order.match(/^ {4}---$/gm) ?? []).length, 2)
})

test('a block scalar may contain "..." too — an ellipsis on its own line is English', () => {
  const read = parseYaml('note: |\n  and then\n  ...\n  it stopped\n') as { note: string }
  assert.match(read.note, /^\.\.\.$/m)
})

test('a real second document at column zero is still refused', () => {
  // The control for the two above: the refusal must survive them.
  for (const source of ['a: 1\n---\nb: 2\n', 'a: 1\n...\nb: 2\n']) {
    assert.throws(
      () => parseYaml(source),
      (error: unknown) => {
        assert.ok(error instanceof YamlError)
        assert.match(error.message, /line 2: one document per file/)
        return true
      },
      `expected a refusal for:\n${source}`,
    )
  }
})
