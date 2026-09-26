#!/usr/bin/env node
/**
 * A fake agent CLI for the account contract: answers `status`, `login` and
 * `logout` the way `claude auth …` and `cursor-agent …` do, shaped by env:
 *
 *   FAKE_CLI_STYLE  json | text        — how `status` speaks
 *   FAKE_CLI_STATE  in | out           — whether anyone is signed in
 *   FAKE_CLI_LOGIN  ok | fail | silent | hang | paste | paste-late | paste-callback
 *                                    — how `login` behaves. The paste modes
 *                                      print the link and the prompt the way
 *                                      `claude auth login` does, then read a
 *                                      line: `paste` exits 0 only on the
 *                                      expected code, refuses a line that is
 *                                      not `code#state` and reads on, and
 *                                      repeats each half of a wrong code in
 *                                      its error, so a test can tell the desk
 *                                      strikes them out; `paste-late`
 *                                      prompts a moment after its link;
 *                                      `paste-callback` finishes by itself,
 *                                      as the browser's own callback does
 *   FAKE_CLI_CODE   <code>            — the code `paste` accepts
 *   FAKE_CLI_TOUCH  <path>            — a file `logout` writes, so a test can
 *                                       tell that this CLI ran and not ACP
 */
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [verb] = process.argv.slice(2)
const style = process.env.FAKE_CLI_STYLE ?? 'json'
const state = process.env.FAKE_CLI_STATE ?? 'in'

if (verb === 'status') {
  /* Signed out, each the way its CLI answers, measured with an empty HOME
     (review of #134, round 15). `claude auth status` prints the record and
     exits 1; `cursor-agent status` prints `Not logged in` and exits 0. This
     had the two the other way round. */
  if (style === 'json') {
    process.stdout.write(
      JSON.stringify(
        state === 'in'
          ? { loggedIn: true, authMethod: 'claude.ai', email: 'tester@example.com', planType: 'max' }
          : { loggedIn: false, authMethod: 'none' },
      ) + '\n',
    )
    process.exit(state === 'in' ? 0 : 1)
  }
  if (state === 'in') {
    process.stdout.write('✓ Logged in as tester@example.com\n')
    process.exit(0)
  }
  process.stdout.write('Not logged in\n')
  process.exit(0)
}

if (verb === 'login' && (process.env.FAKE_CLI_LOGIN ?? '').startsWith('paste')) {
  const mode = process.env.FAKE_CLI_LOGIN
  const expected = process.env.FAKE_CLI_CODE ?? 'right-code#state'
  // The three writes `claude auth login` makes, in its words (2.1.258).
  process.stdout.write('Opening browser to sign in…\n')
  process.stdout.write('If the browser didn\'t open, visit: https://auth.example.com/flow/abc123\n')
  const ask = () => process.stdout.write('Paste code here if prompted > ')
  if (mode === 'paste-late') setTimeout(ask, 300)
  else ask()
  // Nobody finishing it ends it all the same, so a failing test does not wait on this child.
  setTimeout(() => process.exit(3), 15_000)
  if (mode === 'paste-callback') {
    setTimeout(() => {
      process.stdout.write('Login successful.\n')
      process.exit(0)
    }, 250)
  }
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    // As the real command does: a line that is not `code#state` is refused,
    // and it goes on reading without printing the prompt again.
    const [code, state] = line.trim().split('#')
    if (!code || !state) {
      process.stderr.write('Invalid code. Please make sure the full code was copied.\n')
      return
    }
    if (line.trim() === expected) {
      process.stdout.write('Login successful.\n')
      process.exit(0)
    }
    // Each half on its own, as a token exchange's error might name them.
    process.stderr.write(`Login failed: the code ${code} was refused (state ${state}).\n`)
    process.exit(1)
  })
} else if (verb === 'login') {
  const mode = process.env.FAKE_CLI_LOGIN ?? 'ok'
  if (mode === 'silent') {
    process.stderr.write('this CLI needs a terminal\n')
    process.exit(1)
  }
  process.stdout.write('Open the link to sign in:\n  https://auth.example.com/flow/abc123\n')
  if (mode === 'hang') {
    // `hang`: a sign-in nobody finishes, which only a kill ends. It ends
    // itself after 15 s all the same, so a test that fails before its cancel
    // fails, rather than waiting on this child's pipes (review of #134, round 13).
    setInterval(() => {}, 60_000)
    setTimeout(() => process.exit(3), 15_000)
  } else {
    setTimeout(() => {
      if (mode === 'fail') {
        process.stderr.write('the browser flow was refused\n')
        process.exit(1)
      }
      process.stdout.write('Signed in as tester@example.com\n')
      process.exit(0)
    }, 250)
  }
} else if (verb === 'logout') {
  if (process.env.FAKE_CLI_TOUCH) writeFileSync(process.env.FAKE_CLI_TOUCH, 'out')
  process.stdout.write('Signed out.\n')
  process.exit(0)
} else if (verb !== 'login') {
  process.stderr.write(`unknown verb ${String(verb)}\n`)
  process.exit(2)
}
