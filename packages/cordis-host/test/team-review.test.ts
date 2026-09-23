import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceRecord, ReviewCandidate, ReviewInput } from '@harnessdesk/protocol'

import { ExtensionKernel, setTeamEngine, type TeamEngine } from '../src/index.js'

/**
 * `ctx.team.reviewCandidates` and `.recordReview` behind the `team` grant,
 * exactly like every other team verb: an ungranted plugin never reaches the
 * engine, and a granted one's call carries the plugin's own stamped identity
 * — the same scope every other team verb is authenticated by.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const engine = (): TeamEngine & { readonly candidateCalls: unknown[]; readonly recordCalls: unknown[] } => {
  const candidateCalls: unknown[] = []
  const recordCalls: unknown[] = []
  const refused: TeamEngine['board'] = async () => {
    throw new Error('not used in this test')
  }
  return {
    candidateCalls,
    recordCalls,
    board: refused,
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
    reviewCandidates: async (intent, scope) => {
      candidateCalls.push({ intent, scope })
      const candidate: ReviewCandidate = { id: 'cand-1', card: 1, at: 'a'.repeat(40), branch: 'work', evidence: [] }
      return [candidate]
    },
    recordReview: async (input, scope) => {
      recordCalls.push({ input, scope })
      if (input.candidate === 'forged') throw new Error('That candidate is no longer being offered.')
      const record: EvidenceRecord = {
        id: 'rec-1', fact: { kind: 'review', verdict: input.verdict, by: 'seat-1', at: 'a'.repeat(40) },
        card: { board: 'goal-1', id: input.intent }, observedAt: 1, posted: null,
      }
      return record
    },
  }
}

test('review_candidates and record_review need the team grant, and carry the caller’s stamped scope', async (t) => {
  const plane = engine()
  setTeamEngine(plane)
  t.after(() => setTeamEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'ungranted', name: 'Ungranted' },
    plugin: {
      name: 'ungranted',
      inject: ['tools', 'team'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'ungranted_candidates',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_args: unknown, scope: unknown) => {
            try {
              return JSON.stringify(await ctx.team.reviewCandidates(3, scope))
            } catch (error) {
              return `refused: ${error instanceof Error ? error.message : String(error)}`
            }
          },
        })
      },
    },
  })
  await kernel.load({
    manifest: { id: 'granted', name: 'Granted', permissions: { team: true } },
    plugin: {
      name: 'granted',
      inject: ['tools', 'team'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'granted_candidates',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_args: unknown, scope: unknown) => JSON.stringify(await ctx.team.reviewCandidates(3, scope)),
        })
        ctx.tools.register({
          name: 'granted_record',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (args: { candidate: string; verdict: string }, scope: unknown) => {
            const input: ReviewInput = { intent: 3, candidate: args.candidate, verdict: args.verdict }
            try {
              return JSON.stringify(await ctx.team.recordReview(input, scope))
            } catch (error) {
              return `refused: ${error instanceof Error ? error.message : String(error)}`
            }
          },
        })
      },
    },
  })
  await settle()

  const tool = (name: string) => {
    const found = kernel.list('tool').find((entry) => entry.name === name)
    assert.ok(found, `no tool ${name}`)
    return found.id
  }
  const scope = { runtime: 'codex', sessionId: 's1' } as any

  // Ungranted: the engine never hears from it, whatever the tool tries.
  const refused = await kernel.invokeTool(tool('ungranted_candidates'), {}, scope)
  assert.match(JSON.stringify(refused), /refused: .*team/)
  assert.equal(plane.candidateCalls.length, 0, 'the engine never heard from the ungranted plugin')

  // Granted: the call reaches the engine, scoped and stamped with this plugin instance.
  const candidates = await kernel.invokeTool(tool('granted_candidates'), {}, scope)
  assert.match(JSON.stringify(candidates), /cand-1/)
  const asked = plane.candidateCalls[0] as { intent: number; scope: { runtime: string; sessionId: string; plugin: string } }
  assert.equal(asked.intent, 3)
  assert.equal(asked.scope.runtime, 'codex')
  assert.equal(asked.scope.sessionId, 's1')
  assert.match(asked.scope.plugin, /^granted#\d+$/, 'the engine is told which plugin instance asked, stamped by the service')

  // Recording an authentic candidate succeeds and returns the structured record.
  const recorded = await kernel.invokeTool(tool('granted_record'), { candidate: 'cand-1', verdict: 'approve' }, scope)
  assert.match(JSON.stringify(recorded), /verdict.*approve/)

  // A forged candidate id is refused by the engine, not silently accepted — the
  // refusal crosses the tool boundary as data the calling model can read.
  const forged = await kernel.invokeTool(tool('granted_record'), { candidate: 'forged', verdict: 'approve' }, scope)
  assert.match(JSON.stringify(forged), /refused: .*no longer being offered/)
})

test('an unscoped call still reaches the engine, which is the one place that may refuse it', async (t) => {
  // The gate here is the grant, not the scope: an empty scope is the host's
  // decision to make (today: nothing useful happens without runtime/sessionId),
  // never invented by the plugin layer.
  const plane = engine()
  setTeamEngine(plane)
  t.after(() => setTeamEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load({
    manifest: { id: 'granted', name: 'Granted', permissions: { team: true } },
    plugin: {
      name: 'granted',
      inject: ['tools', 'team'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'unscoped_candidates',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => JSON.stringify(await ctx.team.reviewCandidates(3, undefined)),
        })
      },
    },
  })
  await settle()
  const tool = kernel.list('tool').find((entry) => entry.name === 'unscoped_candidates')!
  await kernel.invokeTool(tool.id, {}, {} as any)
  const asked = plane.candidateCalls[0] as { scope: { runtime?: string; sessionId?: string } }
  assert.equal(asked.scope.runtime, undefined)
  assert.equal(asked.scope.sessionId, undefined)
})
