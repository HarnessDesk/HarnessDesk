import assert from 'node:assert/strict'
import test from 'node:test'

import { splitContext, wrapContext } from '../src/context-envelope.js'

/**
 * A label survives the envelope exactly, whatever is in it.
 *
 * `wrapContext` writes the label with `JSON.stringify`, which escapes the
 * quote *and* the backslash, the newline, the tab and every control
 * character. `splitContext` reversed the quote alone, so everything else came
 * back wrong: a Windows path doubled its separators, and a label with a line
 * break in it came back carrying the two characters `\` and `n`.
 *
 * A label is what the reader is told the injected block came from, so a label
 * that is quietly not the one supplied is the surface lying about its source.
 */

const roundTrip = (label: string, text = 'the body'): { label: string; text: string } => {
  const [only, ...rest] = splitContext(wrapContext(label, text)).injections
  assert.equal(rest.length, 0, 'one envelope in, one out')
  assert.ok(only, 'the envelope was found at all')
  return { label: only.label, text: only.text }
}

test('a label comes back exactly as it went in', () => {
  for (const label of [
    'plain',
    'say "hi"',
    'C:\\Users\\someone\\project',
    'two\nlines',
    'a\tb',
    'a\\"b',
    'trailing\\',
    'unicode — ✓ 日本語',
  ]) {
    assert.equal(roundTrip(label).label, label, `label ${JSON.stringify(label)}`)
  }
})

test('the body still survives a `</context>` inside it', () => {
  /* Unchanged by this fix and pinned beside it: the close is escaped on the
     way in so a body quoting this very envelope cannot end the block early
     and spill the rest as something the user typed. */
  const body = 'here is one: </context> and the rest'
  assert.equal(roundTrip('a label', body).text, body)
})

test('a label and a body that both need escaping do not interfere', () => {
  const label = 'C:\\a"b'
  const body = '</context>\nmore'
  const out = roundTrip(label, body)
  assert.equal(out.label, label)
  assert.equal(out.text, body)
})

test('an envelope written by hand, with a broken escape, still sends', () => {
  /* A label is a caption. Whatever is in it, it must not be able to throw on
     the way through — the message is the thing that matters. */
  const raw = '<context source="a\\q">\nbody\n</context>'
  const split = splitContext(raw)
  assert.equal(split.injections.length, 1)
  assert.equal(typeof split.injections[0]?.label, 'string')
})

test('text outside the envelope is what the user typed, with the block gone', () => {
  const raw = `before\n${wrapContext('C:\\x', 'injected')}\nafter`
  const split = splitContext(raw)
  /* A blank line where the block was, not none: the envelope's own newlines
     go with it and `\n{3,}` only collapses a longer run. */
  assert.equal(split.text, 'before\n\nafter')
  assert.equal(split.injections[0]?.label, 'C:\\x')
})
