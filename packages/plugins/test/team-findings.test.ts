import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ExtensionKernel, setTeamEngine, type TeamEngine } from '@harnessdesk/cordis-host'
import type { FindingView, ToolResult } from '@harnessdesk/protocol'

import { teamPlugin } from '../src/index.js'

/**
 * The four finding tools through the real kernel: each maps the model's
 * arguments onto exactly the fields its command takes, carries the
 * invocation's own scope, and words the ledger's answer — the same
 * boundary every other team tool crosses, never a shortcut to the plane.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))
const text = (result: ToolResult): string =>
  result.ok ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : `!${result.error}`

const view = (over: Partial<FindingView> = {}): FindingView => ({
  id: 'finding-1', origin: { goal: 'goal-1', run: 'run-1', round: 2, card: 3, seat: 'seat-2', at: 'a'.repeat(40) }, ownerGoal: 'goal-1',
  title: 'The retry loop never ends', body: 'Details.', category: 'ordinary', blocking: true, related: null, anchor: null,
  lifecycle: { state: 'open', confirmed: false, repairs: [] }, sequence: 1, evidence: ['record-1'], posted: [], restored: false, problem: null,
  ...over,
})

test('tool bridge attributes and bounds each command', async (t) => {
  const calls: { verb: string; input: unknown; scope: unknown }[] = []
  const refused = async (): Promise<never> => { throw new Error('not used here') }
  const engine: TeamEngine = {
    notify: async () => "",
    board: refused, addIntent: refused, claim: refused, claimNext: refused, awaitWork: refused, awaitMember: refused,
    conflicts: refused, complete: refused, release: refused, handoff: refused, status: refused, send: refused,
    reviewCandidates: refused, recordReview: refused,
    raiseFinding: async (input, scope) => { calls.push({ verb: 'raise', input, scope }); return view() },
    repairFinding: async (input, scope) => {
      calls.push({ verb: 'repair', input, scope })
      return view({ lifecycle: { state: 'repaired', confirmed: false, repairs: ['b'.repeat(40)] }, sequence: 2 })
    },
    decideFinding: async (input, scope) => {
      calls.push({ verb: 'decide', input, scope })
      if ((input as { state: string }).state === 'open') throw new Error('Only the Agent that raised this finding may decide it, from a later review.')
      return view({ lifecycle: { state: 'repaired', confirmed: true, repairs: ['b'.repeat(40)] }, sequence: 3 })
    },
    listFindings: async (input, scope) => { calls.push({ verb: 'list', input, scope }); return [view(), view({ id: 'finding-2', blocking: false, title: 'A nit' })] },
  }
  setTeamEngine(engine)
  t.after(() => setTeamEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(teamPlugin)
  await settle()
  const run = async (name: string, args: unknown): Promise<string> => {
    const tool = kernel.list('tool').find((entry) => entry.name === name)
    assert.ok(tool, `no tool ${name}`)
    return text(await kernel.invokeTool(tool.id, args, { runtime: 'fake', sessionId: 's1' } as never))
  }

  // The model names a Seat and a revision: the tool never passes either on.
  const raised = await run('raise_finding', {
    intent: 3, candidate: 'cand-1', request: 'r-1', title: 'The retry loop never ends', body: 'Details.', category: 'ordinary', blocking: true,
    seat: 'seat-9', at: 'c'.repeat(40), confirmed: true,
  })
  assert.match(raised, /Recorded: finding-1 — The retry loop never ends · open · blocking · sequence 1/)
  const first = calls[0]!
  assert.deepEqual(Object.keys(first.input as object).sort(), ['blocking', 'body', 'candidate', 'category', 'intent', 'request', 'title'])
  const scope = first.scope as { runtime: string; sessionId: string; plugin: string }
  assert.equal(scope.runtime, 'fake')
  assert.equal(scope.sessionId, 's1')
  assert.match(scope.plugin, /^team#\d+$/, 'stamped with the plugin instance that asked')

  const repaired = await run('repair_finding', { intent: 5, finding: 'finding-1', request: 'r-2', expected: 1, note: 'Bounded.', at: 'd'.repeat(40) })
  assert.match(repaired, /repaired \(claimed, not yet confirmed\)/)
  assert.deepEqual(calls[1]!.input, { intent: 5, finding: 'finding-1', request: 'r-2', expected: 1, note: 'Bounded.' })

  const confirmed = await run('decide_finding', { intent: 7, candidate: 'cand-2', finding: 'finding-1', request: 'r-3', expected: 2, state: 'repaired', note: 'Fixed.', by: 'person' })
  assert.match(confirmed, /repaired \(confirmed\)/)
  assert.deepEqual(Object.keys(calls[2]!.input as object).sort(), ['candidate', 'expected', 'finding', 'intent', 'note', 'request', 'state'])
  // A refusal is the engine's, carried back as the tool's answer.
  const refusal = await run('decide_finding', { intent: 7, candidate: 'cand-2', finding: 'finding-1', request: 'r-4', expected: 2, state: 'open', note: 'No.' })
  assert.match(refusal, /Only the Agent that raised this finding/)

  const listed = await run('list_findings', { intent: 3, filter: 'blocking' })
  assert.deepEqual(calls.at(-1)!.input, { intent: 3, filter: 'blocking' })
  assert.equal(listed.split('\n').length, 2)
})
