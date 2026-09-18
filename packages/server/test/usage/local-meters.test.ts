import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'

import { localUsageFor, ownCli } from '../../src/bootstrap.js'
import { knownAgent } from '../../src/installs/known-agents.js'
import { tempDir } from '../scratch.js'

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

test('an Amp row with its own PATH is asked with that PATH, not the host process’s', async () => {
  // The row can carry a second Amp account through its own PATH (and HOME,
  // for the installer fallback); the meter has to find and run *that* amp,
  // not whatever the host process already had (#772, review round 4).
  const dir = tempDir('hd-amp-bind-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const script = join(bin, 'amp')
  // Amp's own $, not the shell's $1 (the script's first argument, "usage").
  writeFileSync(script, ['#!/bin/sh', 'echo "**Individual credits:** \\$10 remaining"', 'echo "Signed in as row@example.com"', ''].join('\n'))
  chmodSync(script, 0o755)

  const amp = localUsageFor(row({ id: 'amp-acp', command: 'amp-acp', env: { PATH: bin } }))
  const reading = await amp?.meter?.read()
  assert.equal(reading?.account, 'row@example.com', 'the row’s own amp answered, not the host’s PATH')
  assert.equal(reading?.credits?.remaining, 10)
})

test('a Cline row with --data-dir still lets CLINE_DB_DATA_DIR name the database on its own', () => {
  // The two flags name different things — settings and account state versus
  // the database alone — and a row can set one without the other, the way
  // corpusRoot already honours CLINE_DB_DATA_DIR ahead of the data folder
  // when there is no override (#772, review round 4).
  const moved = localUsageFor(
    row({
      id: 'cline-work',
      command: 'cline',
      args: ['--acp', '--data-dir', '/work/second-cline'],
      env: { CLINE_DB_DATA_DIR: '/work/second-cline-db' },
    }),
    knowledge('cline'),
  )
  assert.deepEqual(moved?.meter?.watchPaths(), ['/work/second-cline/settings/providers.json'], 'settings still follow --data-dir')
  assert.equal(moved?.root, '/work/second-cline-db/sessions.db', 'the database follows CLINE_DB_DATA_DIR, not the override')
})

test('a Cline row moved with --data-dir is read from there, sign-in and spend together', () => {
  // --data-dir is Cline's real mechanism for a second account; unlike Gemini
  // it has no environment variable for it (known-agents.ts), so the row's
  // own args are the only place a moved account is named (#772, review round 3).
  const moved = localUsageFor(
    row({ id: 'cline-work', command: 'cline', args: ['--acp', '--data-dir', '/work/second-cline'] }),
    knowledge('cline'),
  )
  assert.deepEqual(moved?.meter?.watchPaths(), ['/work/second-cline/settings/providers.json'])
  assert.equal(moved?.root, '/work/second-cline/db/sessions.db')

  // A relative --data-dir resolves against the row's own cwd, as Cline itself resolves it.
  const relative = localUsageFor(
    row({ id: 'cline-rel', command: 'cline', args: ['--acp', '--data-dir', 'second'], cwd: '/work/base' }),
    knowledge('cline'),
  )
  assert.equal(relative?.root, '/work/base/second/db/sessions.db')

  // Unmoved, it falls back to the environment-based default as before.
  const plain = localUsageFor(row({ id: 'cline', command: 'cline', args: ['--acp'] }), knowledge('cline'))
  assert.ok(plain?.root?.endsWith('/.cline/data/db/sessions.db'), plain?.root)
})
