import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'

import { localUsageFor } from '../../src/bootstrap.js'
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
  // The control: with no knowledge, nothing in the row names a CLI the
  // switch knows, and this is exactly what the desk did before.
  assert.equal(localUsageFor(copilot), null)
  assert.equal(localUsageFor(copilot, knowledge('github-copilot-cli'))?.meter?.id, 'copilot-account')

  // The same hole, for the same reason, on the agent next to it.
  const gemini = row({ id: 'gemini', command: 'gemini', args: ['--acp'] })
  assert.equal(localUsageFor(gemini), null)
  assert.equal(localUsageFor(gemini, knowledge('gemini'))?.meter?.id, 'gemini-account')
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

test('an agent with no meter of its own gets none, however it is named', () => {
  assert.equal(localUsageFor(row({ id: 'opencode', command: 'opencode' }), knowledge('opencode')), null)
  // A hand-written row for something the desk has never heard of.
  assert.equal(localUsageFor(row({ id: 'mine', command: '/usr/local/bin/mine' })), null)
})
