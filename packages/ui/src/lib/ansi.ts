/**
 * Terminal escape sequences, removed.
 *
 * Command output arrives as the program wrote it, and programs that think they
 * are talking to a terminal colour their output: `[2m – taking page screenshot
 * [22m`. The transcript is not a terminal and never will interpret those, so
 * the honest rendering is the text without them. Only the text is dropped —
 * the ESC, the bracket and the parameters — never what they were wrapping.
 */

// CSI (ESC [ … final byte), OSC (ESC ] … BEL or ESC \), and the two-byte
// escapes (ESC followed by one of the @–_ range) that some tools emit.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

// Some tools lose the ESC byte on the way (a logger that strips control
// characters but keeps the rest) and leave the bare `[2m` behind. Those are
// only removed when they look exactly like an SGR parameter block — digits and
// semicolons ending in `m` — so `[22m` goes and `[ref=e2]` stays.
const ORPHAN_SGR = /\[[0-9;]*m/g

export const stripAnsi = (text: string): string =>
  text.includes('\u001b') || text.includes('[')
    ? text.replace(ANSI, '').replace(ORPHAN_SGR, '')
    : text
