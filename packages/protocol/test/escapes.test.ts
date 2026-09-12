import assert from 'node:assert/strict'
import { test } from 'node:test'

import { stripEscapes } from '../src/escapes.js'

/**
 * The one escape stripper the transcript, the terminal chip and the test
 * plugin all read through. Every case here is a shape one of the three had
 * learned on its own while the other two had not (#233).
 */

const ESC = '\u001b'
const BEL = '\u0007'

test('an OSC 8 link loses its markup and keeps its text, however it is terminated', () => {
  /* The shape that named the issue. vitest and jest write a failing file as a
     link; a stripper whose OSC body excludes BEL but not ESC runs from the
     first opening to the last terminator on the line and takes what lies
     between them — the file and line — with it. */
  assert.equal(
    stripEscapes(`FAIL ${ESC}]8;;file:///w/src/auth.test.ts${ESC}\\ src/auth.test.ts:42 ${ESC}]8;;${ESC}\\ done`),
    'FAIL  src/auth.test.ts:42  done',
  )
  assert.equal(
    stripEscapes(`FAIL ${ESC}]8;;file:///w/src/auth.test.ts${BEL}src/auth.test.ts:42${ESC}]8;;${BEL} done`),
    'FAIL src/auth.test.ts:42 done',
  )
  // Opened with one terminator and closed with the other, and twice on a line.
  assert.equal(stripEscapes(`a ${ESC}]8;;http://x${BEL}text${ESC}]8;;${ESC}\\ b`), 'a text b')
  assert.equal(
    stripEscapes(`${ESC}]8;;file:///a${BEL}one${ESC}]8;;${BEL} and ${ESC}]8;;file:///b${BEL}two${ESC}]8;;${BEL}`),
    'one and two',
  )
  // A window title is an OSC too, and none of it should reach the reader.
  assert.equal(stripEscapes(`${ESC}]0;title${ESC}\\rest`), 'rest')
})

test('CSI takes its parameters with it, the cursor’s among them', () => {
  assert.equal(stripEscapes(`${ESC}[31mfailed${ESC}[0m: 2 tests`), 'failed: 2 tests')
  assert.equal(stripEscapes(`${ESC}[?25lFAIL src/a.test.ts`), 'FAIL src/a.test.ts')
})

test('the charset escapes go, so no raw ESC and no stray `(B` reaches the text', () => {
  // `tput sgr0` resets with ESC ( B; ncurses draws a box with ESC ( 0.
  assert.equal(stripEscapes(`${ESC}(B${ESC}[mplain`), 'plain')
  assert.equal(stripEscapes(`${ESC}(0qqq${ESC}(B`), 'qqq')
  // A two-byte escape, and the opening of an OSC that was never terminated.
  assert.equal(stripEscapes(`a${ESC}Mb`), 'ab')
  assert.equal(stripEscapes(`keep ${ESC}]8;;http://x`), 'keep 8;;http://x')
})

test('text that is no escape sequence comes back exactly as it went in', () => {
  const snapshot = '- gridcell "Empty cell 1" [ref=e29] [cursor=pointer]\n- [x] done\narr[0]'
  assert.equal(stripEscapes(snapshot), snapshot)
  assert.equal(stripEscapes('plain text'), 'plain text')
  /* The orphaned-SGR rule is the transcript's own and is deliberately not
     here: a logger that dropped the ESC leaves `[2m` behind, and anywhere but
     a transcript that is a bracket doing its job. */
  const orphaned = 'Call log:\n [2m  - taking page screenshot [22m'
  assert.equal(stripEscapes(orphaned), orphaned)
})
