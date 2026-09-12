import { expect, test } from 'vitest'

import { stripAnsi } from './ansi'

test('removes colour and style sequences but keeps the text they wrapped', () => {
  expect(stripAnsi('\u001b[31mfailed\u001b[0m: 2 tests')).toBe('failed: 2 tests')
  expect(stripAnsi('\u001b[1;32m✓\u001b[22;39m ok')).toBe('✓ ok')
})

test('removes OSC sequences such as hyperlinks and titles', () => {
  expect(stripAnsi('\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007')).toBe('link')
  expect(stripAnsi('\u001b]0;title\u001b\\rest')).toBe('rest')
})

test('removes the orphaned SGR blocks a lossy logger leaves behind', () => {
  expect(stripAnsi('Call log:\n [2m  - taking page screenshot [22m\n [2m  - fonts loaded [22m')).toBe('Call log:\n   - taking page screenshot \n   - fonts loaded ')
})

test('leaves brackets that are not escape parameters alone', () => {
  const snapshot = '- gridcell "Empty cell 1" [ref=e29] [cursor=pointer]\n- [x] done\narr[0]'
  expect(stripAnsi(snapshot)).toBe(snapshot)
  expect(stripAnsi('plain text')).toBe('plain text')
})

test('an OSC 8 file link keeps the text it wrapped (#233)', () => {
  /* vitest and jest write a failing file as a link. The OSC clause that used
     to live here excluded BEL from its body but not ESC, so the match ran
     from the link's opening to the last terminator on the line and carried
     the file and line away with it: this whole line read `FAIL  done`. */
  const ESC = '\u001b'
  expect(stripAnsi(`FAIL ${ESC}]8;;file:///w/src/auth.test.ts${ESC}\\ src/auth.test.ts:42 ${ESC}]8;;${ESC}\\ done`)).toBe(
    'FAIL  src/auth.test.ts:42  done',
  )
  // The same link written with the other terminator, which always worked.
  expect(stripAnsi(`FAIL ${ESC}]8;;file:///w/a.test.ts\u0007a.test.ts:42${ESC}]8;;\u0007 done`)).toBe(
    'FAIL a.test.ts:42 done',
  )
})

test('the charset escape `tput sgr0` resets with leaves no ESC in the transcript', () => {
  // ESC ( B is neither a CSI nor a two-byte escape, and used to survive whole.
  const ESC = '\u001b'
  expect(stripAnsi(`${ESC}(B${ESC}[mplain`)).toBe('plain')
})
