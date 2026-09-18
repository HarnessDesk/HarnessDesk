import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'

import { localUsageFor, ownCli } from '../../src/bootstrap.js'
import { knownAgent } from '../../src/installs/known-agents.js'

/**
 * Which agent rows earn a local usage meter.
 *
 * The rule is that the meter follows the *CLI* a row drives, never the row's
 * id — the id is the user's to choose, and two people can name the same
 * agent differently. What that misses, if only the row's own fields are
 * read, is the commonest row of all: an agent whose CLI speaks ACP itself
 * has no `executable` and no `account`, so its `command` is the only thing
 * naming the CLI, and reading which agent that is, is the knowledge table's
 * job. Gemini and GitHub Copilot each had a meter written for them that
 * nothing reached, and reported as unmetered.
 */

const row = (fields: Partial<AcpAgentConfig> & { id: string }): AcpAgentConfig =>
  ({ name: fields.id, command: fields.id, ...fields }) as AcpAgentConfig

const knowledge = (id: string) => {
  const known = knownAgent(id)
  assert.ok(known, `${id} is not in the knowledge table`)
  return known
}

test('a direct-CLI row is metered through the knowledge table, not through fields it has none of', () => {
  const copilot = row({
    id: 'github-copilot-cli',
    command: '/opt/homebrew/bin/copilot',
    args: ['--acp'],
  })
  assert.equal(localUsageFor(copilot, knowledge('github-copilot-cli'))?.meter?.id, 'copilot-account')

  // The same hole, for the same reason, on the agent next to it.
  const gemini = row({ id: 'gemini', command: 'gemini', args: ['--acp'] })
  assert.equal(localUsageFor(gemini, knowledge('gemini'))?.meter?.id, 'gemini-account')
  assert.equal(localUsageFor(gemini, knowledge('gemini'))?.corpus, 'gemini')

  // The knowledge wins over the program's own name: a wrapper that the table
  // knows to be Gemini is metered as Gemini, whatever it is called.
  const wrapped = row({ id: 'gemini', command: '/usr/local/bin/my-gemini-wrapper' })
  assert.equal(localUsageFor(wrapped, knowledge('gemini'))?.meter?.id, 'gemini-account')
})

test('a row the table has no entry for is named by the program it runs', () => {
  // Amp's registry download runs its adapter by path.
  const amp = row({ id: 'amp-acp', command: '/home/dev/.harnessdesk/acp-agents/amp-acp/0.9.0/amp-acp' })
  assert.equal(localUsageFor(amp)?.meter?.id, 'amp-account')
  // Qwen Code's runs through npx: the package is the program.
  const qwen = row({ id: 'qwen-code', command: 'npx', args: ['-y', '@qwen-code/qwen-code@0.24.0', '--acp'] })
  assert.equal(ownCli(qwen), 'qwen-code')
  assert.equal(localUsageFor(qwen)?.corpus, 'qwen')
  // An unscoped package, with the version pinned the way the registry pins it.
  assert.equal(ownCli(row({ id: 'cline', command: 'npx', args: ['-y', 'cline@3.0.61', '--acp'] })), 'cline')
  assert.equal(ownCli(row({ id: 'x', command: 'pnpm', args: ['dlx', '@scope/tool', '--acp'] })), 'tool')
  // A runner with nothing to run names nothing.
  assert.equal(ownCli(row({ id: 'x', command: 'npx', args: ['--yes'] })), null)
})

test("a bridge row still answers from its own fields, and the knowledge cannot disagree", () => {
  const claude = row({
    id: 'anthropic',
    command: process.execPath,
    executable: { command: 'claude', env: 'CLAUDE_CODE_EXECUTABLE' },
  })
  const bound = localUsageFor(claude, knowledge('claude-code'))
  assert.equal(bound?.corpus, 'claude')
  // Named by the row alone, the way it always was.
  assert.equal(localUsageFor(claude)?.corpus, 'claude')

  const cursor = row({
    id: 'cursor',
    command: process.execPath,
    account: { status: { command: 'cursor-agent', args: ['status'] } },
  })
  assert.equal(localUsageFor(cursor, knowledge('cursor'))?.meter?.id, localUsageFor(cursor)?.meter?.id)
  assert.ok(localUsageFor(cursor)?.meter)
})

test('Antigravity is metered by the agy CLI beside its ACP server', () => {
  // The registry download names the server by its file, `agy_acp_server.par`;
  // the knowledge table names it by the command, and that is what binds.
  const antigravity = row({
    id: 'antigravity-acp',
    command: '/home/dev/.harnessdesk/acp-agents/antigravity-acp/1.1.1/agy_acp_server.par',
  })
  assert.equal(localUsageFor(antigravity), null)
  assert.equal(localUsageFor(antigravity, knowledge('antigravity-acp'))?.meter?.id, 'antigravity-account')
  // No transcripts of its own for the ledger: its turns are counted from its store.
  assert.equal(localUsageFor(antigravity, knowledge('antigravity-acp'))?.corpus, undefined)
})

test('an agent whose spend is on disk gets its records, and one with neither gets nothing', () => {
  // OpenCode offers an API key no balance, but prices every session itself.
  const opencode = localUsageFor(row({ id: 'opencode', command: 'opencode' }), knowledge('opencode'))
  assert.equal(opencode?.meter, undefined)
  assert.equal(opencode?.corpus, 'opencode')
  // Cline has both: a balance on its account and its sessions' cost on disk.
  const cline = localUsageFor(row({ id: 'cline', command: 'npx', args: ['-y', 'cline@3.0.61', '--acp'] }), knowledge('cline'))
  assert.equal(cline?.meter?.id, 'cline-account')
  assert.equal(cline?.corpus, 'cline')
  // A hand-written row for something the desk has never heard of.
  assert.equal(localUsageFor(row({ id: 'mine', command: '/usr/local/bin/mine' })), null)
})

test('a moved Gemini home moves the sign-in and the spend together, so one card is one account', () => {
  // `GEMINI_CLI_HOME` stands in for the home folder. Read the sign-in from the
  // desk's home and the chat logs from the moved one, and the card shows one
  // account's quota beside another's spend (#772, review round 1).
  const moved = localUsageFor(
    row({ id: 'gemini-work', command: 'gemini', args: ['--acp'], env: { GEMINI_CLI_HOME: '/work/second-account' } }),
    knowledge('gemini'),
  )
  assert.deepEqual(moved?.meter?.watchPaths(), ['/work/second-account/.gemini/oauth_creds.json'])
  assert.equal(moved?.root, '/work/second-account/.gemini/tmp')

  // Unmoved, both fall back to the same home as each other.
  const home = process.env['HOME'] ?? ''
  const plain = localUsageFor(row({ id: 'gemini', command: 'gemini', args: ['--acp'] }), knowledge('gemini'))
  if (!process.env['GEMINI_CLI_HOME']) {
    assert.deepEqual(plain?.meter?.watchPaths(), [`${home}/.gemini/oauth_creds.json`])
    assert.equal(plain?.root, `${home}/.gemini/tmp`)
  }
})
