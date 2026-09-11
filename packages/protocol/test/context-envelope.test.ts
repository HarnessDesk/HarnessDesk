import assert from 'node:assert/strict'
import test from 'node:test'

import { agentMessageSource, openingOf, opensEnvelope, splitContext, wrapContext } from '../src/context-envelope.js'

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

test('a message is called by its own words, or by its first block when that is all it is (#186)', () => {
  assert.equal(openingOf(`${wrapContext('Git', 'On branch main.')}\n\nFix the bug\nand more`), 'Fix the bug')
  // The composer sends a hand-off's packet first, and a context chip after it.
  assert.equal(
    openingOf(`${wrapContext('Handed off from Claude Code', '## Goal\nfinish')}\n${wrapContext('Git', 'On branch main.')}`),
    'Handed off from Claude Code',
  )
  // A label as wrapContext writes it, a quote escaped and a line break ending the name.
  assert.equal(openingOf(wrapContext('Handed off from "Claude"\nsecond line', 'goal')), 'Handed off from "Claude"')
  assert.equal(openingOf('plain words'), 'plain words')
  assert.equal(openingOf(''), '')
})

test('a hand-off or a message from an agent names the conversation wherever it sits (review of #231)', () => {
  // An adapter puts its own block in front of the composer's: Codex's Git block, ahead of the packet.
  const git = wrapContext('Git', 'On branch main.')
  const packet = wrapContext('Handed off from Claude Code — “Migrate webhooks”', '## Goal\nfinish the migration')
  assert.equal(openingOf(`${git}\n${packet}`), 'Handed off from Claude Code — “Migrate webhooks”')
  const message = agentMessageSource('Codex', 'Review the migration')
  assert.equal(openingOf(`${git}\n${wrapContext(message, 'Look at the queue first.')}`), message)
  // What the person typed still outranks every block.
  assert.equal(openingOf(`${git}\n${packet}\nPick it up from the queue`), 'Pick it up from the queue')
})

test('an adapter passes over the blocks it wrote itself (review of #231)', () => {
  const opening = `${wrapContext('Git', 'On branch main.')}\n${wrapContext('Uncommitted changes', 'M src/a.ts')}`
  assert.equal(openingOf(opening, { skip: (label) => label === 'Git' }), 'Uncommitted changes')
  // The control: not told, the first block is the first block.
  assert.equal(openingOf(opening), 'Git')
})

test('a block cut off before it closed names nothing (review of #231)', () => {
  assert.equal(openingOf('<context source="Handed off from Claude Code — “Migrate'), '')
  assert.equal(openingOf(`${wrapContext('Git', 'On branch main.')}\n<context source="Handed off from Cla`), '')
  assert.equal(opensEnvelope('<context source="x'), true)
  assert.equal(opensEnvelope('<context>'), true)
  // A word that only starts with it is a word.
  assert.equal(opensEnvelope('<context-free grammars'), false)
})
