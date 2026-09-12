/**
 * Terminal escape sequences, removed — once, for everyone who reads back
 * what a program printed.
 *
 * A program that believes it is talking to a terminal colours its output,
 * hides the cursor, names the window, and writes file paths as clickable
 * links. None of that survives into a transcript, a chip, or a test report,
 * so the sequences go and the text they wrapped stays.
 *
 * There were three of these, one per package, and each had learned a
 * different lesson from a different bug while the other two went on not
 * knowing it (#233). What the three knew between them:
 *
 * - **CSI with any parameters.** Plain SGR is what everyone writes first,
 *   and it leaves the cursor's own `ESC [ ?25l` behind — which sat in front
 *   of a runner's `FAIL` and held the line off its own start (#174).
 * - **OSC taken lazily, to BEL or to ESC-backslash.** Both terminators are
 *   in use, and the body must exclude ESC as well as BEL. A body excluding
 *   only BEL runs from a link's opening to the *last* terminator on the line
 *   and carries the link's own text away with it: vitest and jest both write
 *   a failing file as an OSC 8 link, and the greedy reading turned
 *   `FAIL <link>src/auth.test.ts:42</link> done` into `FAIL  done` — the
 *   transcript dropped the one thing on the line worth reading (#233).
 * - **The charset escapes.** `tput sgr0` resets with `ESC ( B` and ncurses
 *   draws a box with `ESC ( 0`. Neither is a CSI and neither is a two-byte
 *   escape, so a stripper without this clause leaves a raw ESC and a stray
 *   `(B` in the text (review of #221, round 2).
 * - **The two-byte escapes**, which are also what takes the opening of an
 *   OSC that was never terminated, rather than leaving an ESC in the text.
 *
 * Deliberately *not* here: the orphaned-SGR rule, `[2m` with its ESC already
 * lost on the way. That is right for the transcript, where a lossy logger is
 * a fact of life, and wrong anywhere a bracket may simply be a bracket — so
 * it stays in the one caller that wants it, applied after this.
 *
 * Two other places read escape bytes and are not callers: both take SGR
 * alone, off one known line, on purpose. The Claude Code bridge's is
 * anchored on the ESC precisely because `opus[1m]` is a model name rather
 * than bold text, and a broader rule there would eat it.
 */

// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[ -/]+[0-~]|\u001b[@-Z\\-_]/g

/**
 * The text a person would read: the escape sequences gone, and everything
 * they wrapped kept exactly as it was.
 */
export const stripEscapes = (text: string): string =>
  text.includes('\u001b') ? text.replace(ESCAPES, '') : text
