import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ExtensionKernel, type TeamEngine } from '@harnessdesk/cordis-host'
import type { ContributionId, EvidenceRecord, ReviewCandidate, RuntimeId, SessionId } from '@harnessdesk/protocol'

import { SupervisedExtensionHost } from '../src/index.js'

/**
 * `team/reviewCandidates` and `team/recordReview` through the real plugin
 * child, exercised the same way every other team verb already is: an honest
 * call rides the invocation the parent actually dispatched and reaches the
 * real engine; a forged scope is refused by the parent's own arming gate,
 * before any engine hears of it; and a forged *candidate* — one the caller
 * names without this process ever having minted it — is the engine's own
 * refusal, carried back across the child boundary as data, not a crash.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

const baseEngine = (): Omit<TeamEngine, 'reviewCandidates' | 'recordReview'> => ({
  board: async () => 'x',
  addIntent: async () => 'x',
  claim: async () => 'x',
  claimNext: async () => 'x',
  awaitWork: async () => 'x',
  awaitMember: async () => 'x',
  conflicts: async () => 'x',
  complete: async () => 'x',
  release: async () => 'x',
  handoff: async () => 'x',
  status: async () => 'x',
  send: async () => 'x',
})

test('review_candidates and record_review ride their own invocation or are refused: the child cannot impersonate', async () => {
  const candidateCalls: unknown[] = []
  const recordCalls: unknown[] = []
  const engine: TeamEngine = {
    ...baseEngine(),
    reviewCandidates: async (intent, scope) => {
      candidateCalls.push({ intent, scope })
      const candidate: ReviewCandidate = { id: 'cand-1', card: 1, at: 'a'.repeat(40), branch: 'work', evidence: [] }
      return [candidate]
    },
    recordReview: async (input, scope) => {
      recordCalls.push({ input, scope })
      if (input.candidate !== 'cand-1') throw new Error('That candidate is no longer being offered. Ask for review candidates again.')
      const record: EvidenceRecord = {
        id: 'rec-1', fact: { kind: 'review', verdict: input.verdict, by: 'seat-1', at: 'a'.repeat(40) },
        card: { board: 'goal-1', id: input.intent }, observedAt: 1, posted: null,
      }
      return record
    },
  }
  const dir = await mkdtemp(join(tmpdir(), 'hd-exthost-'))
  const store = join(dir, 'plugins')
  await cp(join(FIXTURES, 'plugin-teamish'), join(store, 'teamish'), { recursive: true })
  const host = new SupervisedExtensionHost(new ExtensionKernel(), {
    invokeTimeoutMs: 1500,
    env: { HARNESSDESK_PLUGINS: store },
    teamEngine: engine,
  })
  try {
    await host.loadInstalledPlugins()
    const toolId = (name: string): ContributionId => {
      const tool = host.list('tool').find((entry) => entry.name === name)
      assert.ok(tool, `tool ${name} should be contributed`)
      return tool.id
    }
    const live = { runtime: 'codex' as RuntimeId, sessionId: 's1' as SessionId }

    // Authentic scope reaches the real engine and returns its candidate.
    const honest = await host.invokeTool(toolId('review_candidates_honest'), { intent: 3 }, live)
    assert.equal(honest.ok, true)
    assert.match(JSON.stringify(honest), /cand-1/)
    assert.equal(candidateCalls.length, 1, 'the honest call reached the engine')
    const asked = candidateCalls[0] as { intent: number; scope: { runtime: string; sessionId: string } }
    assert.equal(asked.intent, 3)
    assert.equal(asked.scope.runtime, 'codex')
    assert.equal(asked.scope.sessionId, 's1')

    // Recording the real candidate the engine just minted succeeds.
    const recorded = await host.invokeTool(toolId('record_review_honest'), { intent: 3, candidate: 'cand-1', verdict: 'approve' }, live)
    assert.equal(recorded.ok, true)
    assert.match(JSON.stringify(recorded), /verdict.*approve/)
    assert.equal(recordCalls.length, 1)

    // A forged candidate id this process never minted is the engine's own refusal —
    // carried back as the tool's answer, not a transport failure.
    const forgedCandidate = await host.invokeTool(
      toolId('record_review_honest'), { intent: 3, candidate: 'made-up-id', verdict: 'approve' }, live,
    )
    assert.match(JSON.stringify(forgedCandidate), /refused: .*no longer being offered/)
    assert.equal(recordCalls.length, 2, 'the engine was asked, and it is the one that refused')

    // A forged *scope* — one this invocation never carried — never reaches the engine at all:
    // the parent's own arming gate refuses it first, exactly like every other team verb.
    const forgedScope = await host.invokeTool(
      toolId('record_review_forged_scope'), { intent: 3, candidate: 'cand-1', verdict: 'approve' }, live,
    )
    assert.match(JSON.stringify(forgedScope), /cannot be attributed/)
    assert.equal(recordCalls.length, 2, 'the forged scope never reached the engine')
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
