import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyLineEdits } from '../src/index.js'

/**
 * Line edits, which are the one piece of the editor plane that both ends run.
 *
 * The host performs the write with this function, and a plugin forms its
 * expectations against the same one — so the cases below are the contract
 * between them, not an implementation detail. Every one of them is a way a
 * naive version silently corrupts a file rather than failing.
 */

const FILE = 'one\ntwo\nthree\nfour\nfive\n'

test('replaces a single line, leaving the rest exactly as they were', () => {
  assert.equal(applyLineEdits(FILE, [{ fromLine: 2, text: 'TWO' }]), 'one\nTWO\nthree\nfour\nfive\n')
})

test('replaces an inclusive range', () => {
  assert.equal(applyLineEdits(FILE, [{ fromLine: 2, toLine: 4, text: 'X' }]), 'one\nX\nfive\n')
})

test('an empty text deletes the range rather than leaving a blank line', () => {
  // The distinction a naive `splice(from, n, '')` gets wrong: inserting the
  // empty string leaves an empty line where the code was.
  assert.equal(applyLineEdits(FILE, [{ fromLine: 2, toLine: 3, text: '' }]), 'one\nfour\nfive\n')
})

test('a multi-line replacement becomes lines, not one line with newlines in it', () => {
  assert.equal(applyLineEdits(FILE, [{ fromLine: 1, text: 'a\nb' }]), 'a\nb\ntwo\nthree\nfour\nfive\n')
})

test('several edits all land, because they are applied bottom-up', () => {
  // The bug in every top-down implementation: replacing line 1 with two lines
  // moves line 4, and the second edit then lands on the wrong text. It only
  // shows when a plugin sends more than one, which is why it survives so long.
  const out = applyLineEdits(FILE, [
    { fromLine: 1, text: 'A\nA2' },
    { fromLine: 4, text: 'D' },
  ])
  assert.equal(out, 'A\nA2\ntwo\nthree\nD\nfive\n')
})

test('the order the edits arrive in does not change the result', () => {
  const edits = [
    { fromLine: 4, text: 'D' },
    { fromLine: 1, text: 'A' },
  ]
  assert.equal(applyLineEdits(FILE, edits), applyLineEdits(FILE, [...edits].reverse()))
})

test('a file that ended with a newline still does', () => {
  // `split('\n')` on a trailing-newline file yields a final empty element;
  // joining it back without care either strips the newline or doubles it.
  assert.equal(applyLineEdits(FILE, [{ fromLine: 5, text: 'FIVE' }]), 'one\ntwo\nthree\nfour\nFIVE\n')
})

test('a file that did not end with a newline does not gain one', () => {
  assert.equal(applyLineEdits('a\nb', [{ fromLine: 1, text: 'A' }]), 'A\nb')
})

test('a line past the end appends instead of throwing', () => {
  // A plugin reports against the file it read; the person deletes half of it.
  assert.equal(applyLineEdits('a\nb\n', [{ fromLine: 9, text: 'c' }]), 'a\nb\nc\n')
})

test('a line before the first is read as the first', () => {
  assert.equal(applyLineEdits('a\nb\n', [{ fromLine: 0, text: 'A' }]), 'A\nb\n')
  assert.equal(applyLineEdits('a\nb\n', [{ fromLine: -4, text: 'A' }]), 'A\nb\n')
})

test('an inverted range is read as the single line it starts on', () => {
  assert.equal(applyLineEdits(FILE, [{ fromLine: 4, toLine: 2, text: 'D' }]), 'one\ntwo\nthree\nD\nfive\n')
})

test('no edits is the file, untouched and identical', () => {
  assert.equal(applyLineEdits(FILE, []), FILE)
})

test('an empty file can be written into', () => {
  assert.equal(applyLineEdits('', [{ fromLine: 1, text: 'first' }]), 'first')
})
