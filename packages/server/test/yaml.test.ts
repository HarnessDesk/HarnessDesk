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

test('block scalars preserve indented "---" and "..." lines without multi-document refusal (#432)', () => {
  const value = parseYaml(`
roles:
  fixer:
    kind: agent
    order: |
      Start with YAML front matter:
      ---
      hunter: dragonfly
      ---
      Wait for it:
      ...
after: yes
`) as Record<string, unknown>

  assert.deepEqual(value, {
    roles: {
      fixer: {
        kind: 'agent',
        order: [
          'Start with YAML front matter:',
          '---',
          'hunter: dragonfly',
          '---',
          'Wait for it:',
          '...',
          '',
        ].join('\n'),
      },
    },
    after: 'yes',
  })
})

test('column 0 document separators "---" and "..." are still refused (#432)', () => {
  assert.throws(
    () => parseYaml('a: 1\n---\nb: 2\n'),
    (err: unknown) => {
      assert.ok(err instanceof YamlError)
      assert.match(err.message, /line 2: one document per file/)
      return true
    },
  )
  assert.throws(
    () => parseYaml('a: 1\n...\nb: 2\n'),
    (err: unknown) => {
      assert.ok(err instanceof YamlError)
      assert.match(err.message, /line 2: one document per file/)
      return true
    },
  )
})

test('block scalar terminates when encountering line indented between parent and base (#433)', () => {
  const yaml = `
parent:
  order: |
      first line at 6 spaces
    sibling: hello
`
  assert.throws(
    () => parseYaml(yaml),
    (err: unknown) => {
      assert.ok(err instanceof YamlError)
      assert.match(err.message, /this line is indented past the block it is in/)
      return true
    },
  )
})

test('block scalar terminates when encountering under-indented line (#433)', () => {
  const yaml = `
order: |
    first line
  second line
`
  assert.throws(
    () => parseYaml(yaml),
    (err: unknown) => {
      assert.ok(err instanceof YamlError)
      assert.match(err.message, /this line is indented past the block it is in/)
      return true
    },
  )
})




test('a key named __proto__ is refused by name, wherever a key is written, and nothing reaches a prototype', () => {
  /* To JavaScript, `map['__proto__'] = value` writes no key: it swaps the
     map's prototype, so whatever is under it answers for every field the
     document leaves unset. A reader that honoured it would read fields no
     line of the file names. */
  const refuses = (source: string, line: number): void => {
    assert.throws(
      () => parseYaml(source),
      (error: unknown) => {
        assert.ok(error instanceof YamlError, `expected a YamlError for:\n${source}`)
        assert.equal(error.line, line, source)
        assert.match(error.message, /"__proto__"/)
        return true
      },
    )
  }
  refuses('a: 1\n__proto__: {b: 2}\n', 2)
  refuses('a: 1\n"__proto__":\n  b: 2\n', 2)
  refuses('list:\n  - __proto__: {b: 2}\n', 2)
  refuses('list:\n  - a: 1\n    __proto__: {b: 2}\n', 3)
  refuses('a: {__proto__: {b: 2}}\n', 1)
  refuses("a: [{'__proto__': {b: 2}}]\n", 1)
  // A key that only looks like it is an ordinary key.
  const kept = parseYaml('__proto: 1\nproto__: 2\n') as Record<string, unknown>
  assert.deepEqual(kept, { __proto: 1, proto__: 2 })
  assert.equal(Object.getPrototypeOf(kept), Object.prototype)
})

test('duplicate keys in inline maps refuse in either order', () => {
  /* A block map already refused a key set twice; an inline map kept the
     last one, so `{ flow: safe, flow: unsafe }` read as `unsafe` while a
     reviewer's eye stopped at `safe`. Either order is refused, by name and line. */
  const refuses = (source: string, key: string, line: number): void => {
    assert.throws(
      () => parseYaml(source),
      (error: unknown) => {
        assert.ok(error instanceof YamlError, `expected a YamlError for:\n${source}`)
        assert.equal(error.line, line, source)
        assert.match(error.message, new RegExp(`"${key}" is set twice`))
        return true
      },
    )
  }
  refuses('opens: {flow: safe, flow: unsafe}\n', 'flow', 1)
  refuses('opens: {flow: unsafe, flow: safe}\n', 'flow', 1)
  refuses('a: 1\nlist:\n  - {b: [1, {c: 1, "c": 2}]}\n', 'c', 3)
  // Distinct keys in an inline map still read.
  assert.deepEqual(parseYaml('opens: {flow: safe, agent: other}\n'), { opens: { flow: 'safe', agent: 'other' } })
})
