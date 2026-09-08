#!/usr/bin/env node
/**
 * A fake agent CLI for the account contract: answers `status`, `login` and
 * `logout` the way `claude auth …` and `cursor-agent …` do, shaped by env:
 *
 *   FAKE_CLI_STYLE  json | text        — how `status` speaks
 *   FAKE_CLI_STATE  in | out           — whether anyone is signed in
 *   FAKE_CLI_LOGIN  ok | fail | silent — how `login` behaves
 */
const [verb] = process.argv.slice(2)
const style = process.env.FAKE_CLI_STYLE ?? 'json'
const state = process.env.FAKE_CLI_STATE ?? 'in'

if (verb === 'status') {
  if (style === 'json') {
    process.stdout.write(
      JSON.stringify(
        state === 'in'
          ? { loggedIn: true, authMethod: 'claude.ai', email: 'tester@example.com', planType: 'max' }
          : { loggedIn: false },
      ) + '\n',
    )
    process.exit(0)
  }
  if (state === 'in') {
    process.stdout.write('✓ Logged in as tester@example.com\n')
    process.exit(0)
  }
  process.stderr.write('Not logged in\n')
  process.exit(1)
}

if (verb === 'login') {
  const mode = process.env.FAKE_CLI_LOGIN ?? 'ok'
  if (mode === 'silent') {
    process.stderr.write('this CLI needs a terminal\n')
    process.exit(1)
  }
  process.stdout.write('Open the link to sign in:\n  https://auth.example.com/flow/abc123\n')
  setTimeout(() => {
    if (mode === 'fail') {
      process.stderr.write('the browser flow was refused\n')
      process.exit(1)
    }
    process.stdout.write('Signed in as tester@example.com\n')
    process.exit(0)
  }, 250)
} else if (verb === 'logout') {
  process.stdout.write('Signed out.\n')
  process.exit(0)
} else if (verb !== 'login') {
  process.stderr.write(`unknown verb ${String(verb)}\n`)
  process.exit(2)
}
