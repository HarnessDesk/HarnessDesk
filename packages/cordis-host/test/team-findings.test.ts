import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FindingView } from '@harnessdesk/protocol'

import { ExtensionKernel, setTeamEngine, type TeamEngine } from '../src/index.js'

/**
 * `ctx.team`'s finding verbs behind the `team` grant, exactly like every other
 * team verb: an ungranted plugin never reaches the engine, and a granted
 * one's call carries its own stamped plugin identity, the input handed on as
 * it was given — the host, not this layer, refuses what it may not name.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

test('tool bridge attributes and bounds each command', async (t) => {
  const calls: { verb: string; input: unknown; scope: { runtime?: string; sessionId?: string; plugin?: string } }[] = []
  const refused = async (): Promise<never> => { throw new Error('not used here') }
  const found: FindingView = {
    id: 'finding-1', origin: { goal: 'g', run: 'r', round: 1, card: 1, seat: 's', at: 'a'.repeat(40) }, ownerGoal: 'g', title: 'T', body: '',
    category: 'ordinary', blocking: true, related: null, anchor: null, lifecycle: { state: 'open', confirmed: false, repairs: [] },
    sequence: 1, evidence: [], posted: [], restored: false, problem: null,
  }
  const engine: TeamEngine = {
    board: refused, addIntent: refused, claim: refused, claimNext: refused, awaitWork: refused, awaitMember: refused,
    conflicts: refused, complete: refused, release: refused, handoff: refused, status: refused, send: refused,
    reviewCandidates: refused, recordReview: refused,
    raiseFinding: async (input, scope) => { calls.push({ verb: 'raise', input, scope }); return found },
    repairFinding: async (input, scope) => { calls.push({ verb: 'repair', input, scope }); return found },
    decideFinding: async (input, scope) => { calls.push({ verb: 'decide', input, scope }); return found },
    listFindings: async (input, scope) => { calls.push({ verb: 'list', input, scope }); return [found] },
  }
  setTeamEngine(engine)
  t.after(() => setTeamEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  const verbs = (ctx: any) => ({
    raise: (scope: unknown) => ctx.team.raiseFinding({ intent: 1, candidate: 'c', request: 'r', title: 'T', body: '', category: 'ordinary', blocking: true, seat: 'spoofed' }, scope),
    repair: (scope: unknown) => ctx.team.repairFinding({ intent: 1, finding: 'finding-1', request: 'r', expected: 1, note: '' }, scope),
    decide: (scope: unknown) => ctx.team.decideFinding({ intent: 1, candidate: 'c', finding: 'finding-1', request: 'r', expected: 1, state: 'open', note: '' }, scope),
    list: (scope: unknown) => ctx.team.listFindings({ intent: 1 }, scope),
  })
  for (const [id, permissions] of [['ungranted', {}], ['granted', { team: true }]] as const) {
    await kernel.load({
      manifest: { id, name: id, permissions },
      plugin: {
        name: id,
        inject: ['tools', 'team'],
        apply(ctx: any) {
          for (const verb of ['raise', 'repair', 'decide', 'list'] as const) {
            ctx.tools.register({
              name: `${id}_${verb}`, description: 'x', inputSchema: { type: 'object', properties: {} },
              execute: async (_args: unknown, scope: unknown) => {
                try {
                  return JSON.stringify(await verbs(ctx)[verb](scope))
                } catch (error) {
                  return `refused: ${error instanceof Error ? error.message : String(error)}`
                }
              },
            })
          }
        },
      },
    })
  }
  await settle()
  const invoke = async (name: string): Promise<string> => {
    const tool = kernel.list('tool').find((entry) => entry.name === name)!
    return JSON.stringify(await kernel.invokeTool(tool.id, {}, { runtime: 'fake', sessionId: 's1' } as never))
  }
  for (const verb of ['raise', 'repair', 'decide', 'list']) assert.match(await invoke(`ungranted_${verb}`), /refused: .*team/)
  assert.equal(calls.length, 0, 'the engine never heard from the ungranted plugin')
  for (const verb of ['raise', 'repair', 'decide', 'list']) await invoke(`granted_${verb}`)
  assert.deepEqual(calls.map((one) => one.verb), ['raise', 'repair', 'decide', 'list'])
  for (const call of calls) {
    assert.equal(call.scope.runtime, 'fake')
    assert.equal(call.scope.sessionId, 's1')
    assert.match(call.scope.plugin ?? '', /^granted#\d+$/)
  }
  // Handed on as given: the spoofed key reaches the host, whose validator is the one that refuses it.
  assert.equal((calls[0]!.input as { seat?: string }).seat, 'spoofed')
})
