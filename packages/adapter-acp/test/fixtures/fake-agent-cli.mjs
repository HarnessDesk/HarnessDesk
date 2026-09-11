#!/usr/bin/env node
/**
 * A fake agent CLI for the account contract: answers `status`, `login` and
 * `logout` the way `claude auth …` and `cursor-agent …` do, shaped by env:
 *
 *   FAKE_CLI_STYLE  json | text        — how `status` speaks
 *   FAKE_CLI_STATE  in | out           — whether anyone is signed in
 *   FAKE_CLI_LOGIN  ok | fail | silent | hang — how `login` behaves
 */
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

if (verb === 'login') {
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
  process.stdout.write('Signed out.\n')
  process.exit(0)
} else if (verb !== 'login') {
  process.stderr.write(`unknown verb ${String(verb)}\n`)
  process.exit(2)
}
