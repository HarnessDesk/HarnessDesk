import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'

import { localUsageFor } from '../src/bootstrap.js'

/**
 * The no-double-count rule for turns, at the one place that decides it:
 * `localUsageFor` never hands back both a turn-capable corpus and
 * `deskTurns` for the same agent. `ledger/desk-turns.ts` and `host.ts`'s
 * `bindUsage` both explain the rule; this is what proves the wiring keeps it
 * for every named CLI, not only the ones a person happened to test by hand.
 */

const agent = (command: string): AcpAgentConfig => ({ id: 'a', name: 'a', command })

const TURN_CAPABLE = new Set(['codex', 'claude', 'gemini', 'qwen'])

test('no named agent ever gets both a turn-capable corpus and the desk-transcript fallback', () => {
  for (const command of ['claude', 'cursor-agent', 'gemini', 'copilot', 'agy_acp_server', 'cline', 'opencode', 'qwen', 'qwen-code', 'amp', 'amp-acp', 'unknown-agent-nobody-registered']) {
    const local = localUsageFor(agent(command))
    if (!local) continue
    const corpusCountsTurns = local.corpus !== undefined && TURN_CAPABLE.has(local.corpus)
    assert.ok(
      !(corpusCountsTurns && local.deskTurns === true),
      `${command}: got a turn-capable corpus (${local.corpus}) and deskTurns together`,
    )
  }
})

test('cursor and an unrecognised agent — both without a turn-capable corpus of their own — fall back to the desk transcript', () => {
  assert.equal(localUsageFor(agent('cursor-agent'))?.deskTurns, true)
  assert.equal(localUsageFor(agent('some-future-cli'))?.deskTurns, true)
})

test('an agent with its own turn-capable corpus never needs the fallback', () => {
  assert.equal(localUsageFor(agent('claude'))?.corpus, 'claude')
  assert.equal(localUsageFor(agent('claude'))?.deskTurns, undefined)
})
