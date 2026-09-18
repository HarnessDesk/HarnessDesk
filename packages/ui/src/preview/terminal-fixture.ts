import type { HostResult } from '@harnessdesk/protocol'

import { PREVIEW_ROOT } from './sidebar-fixture'

/**
 * What a terminal on this page has already printed.
 *
 * The terminal pane is the shipped `TerminalPane`, and the first thing it does
 * is ask the host for the scrollback to redraw. The harness used to answer
 * `null`, so the pane threw on `attached.scrollback` and printed the error in
 * its own body — caught inside the pane, so neither the page's boundary nor
 * the console saw it, and a sweep of every tab reported the page clean while
 * two of them showed a crash.
 *
 * Typed as the protocol's result for `terminal/attach`, and encoded the way
 * the host encodes it — base64 over UTF-8 — because a scrollback in the wrong
 * encoding does not throw, it paints mojibake. There is no shell behind it:
 * nothing new arrives, and typing goes nowhere.
 */

const ESC = String.fromCharCode(27)
const sgr = (code: string, text: string) => `${ESC}[${code}m${text}${ESC}[0m`
const dim = (text: string) => sgr('2', text)
const green = (text: string) => sgr('32', text)
const prompt = `${sgr('34', '~/code/HarnessDesk')} ${dim('main')} $ `

const SCROLLBACK = [
  `${prompt}pnpm --filter @harnessdesk/ui test`,
  '',
  ` ${dim('RUN')}  v3.2.7 ${dim('/Users/shane/code/HarnessDesk/packages/ui')}`,
  '',
  ` ${dim('Test Files')}  ${green('217 passed')} ${dim('(217)')}`,
  `      ${dim('Tests')}  ${green('2623 passed')} ${dim('(2623)')}`,
  `   ${dim('Duration')}  14.8s`,
  '',
  prompt,
].join('\r\n')

/* The host's encoding: UTF-8 bytes, then base64 — the inverse of the pane's `decode`. */
const base64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

export const terminalAttach = (): HostResult<'terminal/attach'> => ({
  scrollback: base64(SCROLLBACK),
  exitCode: null,
  size: { rows: 24, cols: 100 },
  cwd: PREVIEW_ROOT,
})
