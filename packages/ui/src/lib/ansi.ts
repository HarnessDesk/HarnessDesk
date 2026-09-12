import { stripEscapes } from '@harnessdesk/protocol'

/**
 * Terminal escape sequences, removed.
 *
 * Command output arrives as the program wrote it, and programs that think they
 * are talking to a terminal colour their output: `[2m – taking page screenshot
 * [22m`. The transcript is not a terminal and never will interpret those, so
 * the honest rendering is the text without them. Only the escapes are dropped —
 * the ESC, the bracket and the parameters — never what they were wrapping.
 *
 * The sequences themselves are `stripEscapes`, shared with the terminal chip
 * and the test plugin (#233). Reading an OSC 8 link is why they are shared:
 * the clause that used to live here took a link greedily and dropped the file
 * and line it wrapped, which is the one thing a person opens a failed tool
 * call to read. What stays here is the rule below, which is the transcript's
 * alone.
 */

// Some tools lose the ESC byte on the way (a logger that strips control
// characters but keeps the rest) and leave the bare `[2m` behind. Those are
// only removed when they look exactly like an SGR parameter block — digits and
// semicolons ending in `m` — so `[22m` goes and `[ref=e2]` stays.
const ORPHAN_SGR = /\[[0-9;]*m/g

export const stripAnsi = (text: string): string => stripEscapes(text).replace(ORPHAN_SGR, '')
