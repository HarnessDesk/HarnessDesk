import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ExtensionKernel, type TeamEngine } from '@harnessdesk/cordis-host'
import type { ContributionId, FindingView, RuntimeId, SessionId } from '@harnessdesk/protocol'

import { SupervisedExtensionHost } from '../src/index.js'

/**
 * The finding verbs through the real plugin child: an honest call rides the
 * invocation the parent dispatched and reaches the engine with its input
 * whole — so a key it may not carry reaches the host's validator rather than
 * being smuggled into the scope — and a forged scope is refused by the
 * parent's arming gate before any engine hears of it.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

test('tool bridge attributes and bounds each command', async () => {
  const calls: { verb: string; input: unknown; scope: { runtime?: string; sessionId?: string } }[] = []
  const refused = async (): Promise<never> => { throw new Error('not used here') }
  const found: FindingView = {
    id: 'finding-1', origin: { goal: 'g', run: 'r', round: 1, card: 1, seat: 's', at: 'a'.repeat(40) }, ownerGoal: 'g', title: 'T', body: '',
    category: 'ordinary', blocking: true, related: null, anchor: null, lifecycle: { state: 'open', confirmed: false, repairs: [] },
    sequence: 1, evidence: [], posted: [], restored: false, problem: null,
  }
  const engine: TeamEngine = {
    notify: async () => "",
    board: async () => 'x', addIntent: async () => 'x', claim: async () => 'x', claimNext: async () => 'x', awaitWork: async () => 'x',
    awaitMember: async () => 'x', conflicts: async () => 'x', complete: async () => 'x', release: async () => 'x', handoff: async () => 'x',
    status: async () => 'x', send: async () => 'x', reviewCandidates: async () => [], recordReview: refused,
    raiseFinding: async (input, scope) => {
      calls.push({ verb: 'raise', input, scope })
      if (Object.hasOwn(input as object, 'seat')) throw new Error('"seat" is not something a finding takes.')
      return found
    },
    repairFinding: refused, decideFinding: refused,
    listFindings: async (input, scope) => { calls.push({ verb: 'list', input, scope }); return [found] },
  }
  const dir = await mkdtemp(join(tmpdir(), 'hd-exthost-'))
  const store = join(dir, 'plugins')
  await cp(join(FIXTURES, 'plugin-teamish'), join(store, 'teamish'), { recursive: true })
  const host = new SupervisedExtensionHost(new ExtensionKernel(), { invokeTimeoutMs: 1500, env: { HARNESSDESK_PLUGINS: store }, teamEngine: engine })
  try {
    await host.loadInstalledPlugins()
    const toolId = (name: string): ContributionId => {
      const tool = host.list('tool').find((entry) => entry.name === name)
      assert.ok(tool, `tool ${name} should be contributed`)
      return tool.id
    }
    const live = { runtime: 'fake' as RuntimeId, sessionId: 's1' as SessionId }
    const input = { intent: 3, candidate: 'cand-1', request: 'r-1', title: 'T', body: '', category: 'ordinary', blocking: true }

    const honest = await host.invokeTool(toolId('raise_finding_honest'), input, live)
    assert.equal(honest.ok, true)
    assert.match(JSON.stringify(honest), /finding-1/)
    assert.deepEqual(calls[0]!.input, input, 'the input crossed whole, as the child sent it')
    assert.equal(calls[0]!.scope.runtime, 'fake')
    assert.equal(calls[0]!.scope.sessionId, 's1')
    assert.equal(Object.hasOwn(calls[0]!.scope, 'seat'), false, 'nothing in the input was spread into the scope')

    // A Seat named in the input reaches the engine's validator, which refuses it.
    const spoofed = await host.invokeTool(toolId('raise_finding_honest'), { ...input, seat: 'seat-9' }, live)
    assert.match(JSON.stringify(spoofed), /refused: .*not something a finding takes/)

    const listed = await host.invokeTool(toolId('list_findings_honest'), { intent: 3 }, live)
    assert.equal(listed.ok, true)
    assert.deepEqual(calls.at(-1)!.input, { intent: 3 })

    // A forged scope never reaches the engine.
    const before = calls.length
    const forged = await host.invokeTool(toolId('raise_finding_forged_scope'), input, live)
    assert.match(JSON.stringify(forged), /cannot be attributed/)
    assert.equal(calls.length, before, 'the forged scope never reached the engine')
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
