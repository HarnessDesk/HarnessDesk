import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentEntry, CeilingLevel, FlowSeat, SeatPlan } from '@harnessdesk/protocol'

import { CHANGED_PREVIEW, FlowPreviews, type FlowPreviewPort } from '../src/flow-preview.js'

/*
 * A dry run spends nothing and opens nothing; its token authorizes exactly
 * the run it described, and nothing that has moved since.
 */

const AGENT = (id: string, digest = `${id}-digest`): AgentEntry => ({
  id, origin: 'project', path: `.harnessdesk/agents/${id}/AGENT.md`, digest, shadows: [], problems: [],
  definition: { id, name: id, ceiling: 'edit', ceilingFrom: 'ceiling', answers: ['done'], produces: [], skills: [], prefer: [{ runtime: 'alpha' }], brief: `${id} brief` },
})

const FLOW = `
version: 2
name: One writer, one check
roles:
  author: { kind: agent, uses: writer }
  gate: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail }
seed: { role: author, title: Write it }
rules:
  - { id: check, on: author, when: { every: [done] }, then: { role: gate, title: Verify } }
`

interface Rig {
  readonly port: FlowPreviewPort
  readonly counts: { confine: number; agents: number; previewAgent: number }
  agentsRoster: readonly AgentEntry[]
  winner: FlowSeat
}

const rig = (): Rig => {
  const counts = { confine: 0, agents: 0, previewAgent: 0 }
  const state: Rig = {
    counts,
    agentsRoster: [AGENT('writer')],
    winner: { runtime: 'alpha' },
    port: {
      confine: async () => { counts.confine += 1 },
      agents: async () => { counts.agents += 1; return state.agentsRoster },
      previewAgent: async (_root, agent, _seats, _grant) => {
        counts.previewAgent += 1
        const plan: SeatPlan = {
          id: agent, from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'edit' as CeilingLevel, hold: 'asked' },
          candidates: [{ seat: state.winner, label: 'Alpha', runtimeName: 'Alpha', state: 'taken', reason: null, fix: null }],
        }
        return plan
      },
      now: () => 1,
    },
  }
  return state
}

test('preview has no execution side effects, however many times it is asked', async () => {
  const state = rig()
  const previews = new FlowPreviews(state.port)
  for (let i = 0; i < 3; i += 1) {
    const result = await previews.preview('/repo', FLOW, {})
    assert.ok(result.token, 'a valid flow mints a token')
    assert.equal(result.problems.filter((one) => one.level === 'error').length, 0)
  }
  // Only reads: no method on this port could open a session, a lane or a Goal —
  // the fake exposes none — and the read counts are exactly one confine/agents
  // read and one seat plan per call, nothing accumulating extra work per read.
  assert.equal(state.counts.confine, 3)
  assert.equal(state.counts.agents, 3)
  assert.equal(state.counts.previewAgent, 3)
})

test('a start token binds its exact command, Agent and machine seating: any change refuses, and removing the check proves it', async () => {
  const state = rig()
  const previews = new FlowPreviews(state.port)
  const first = await previews.preview('/repo', FLOW, {})
  assert.ok(first.token)

  // A different root, source or vars than what was previewed: refused before any Goal.
  assert.equal(await previews.redeem(first.token!, '/other-repo', FLOW, {}), null, 'a different root refuses')
  const second = await previews.preview('/repo', FLOW, {})
  assert.equal(await previews.redeem(second.token!, '/repo', `${FLOW}\n`, {}), null, 'a different source refuses')
  const third = await previews.preview('/repo', FLOW, {})
  assert.equal(await previews.redeem(third.token!, '/repo', FLOW, { x: '1' }), null, 'different vars refuse')

  // The winning seat moved (a different runtime now wins) since the preview: still refused.
  const fourth = await previews.preview('/repo', FLOW, {})
  state.winner = { runtime: 'beta' }
  assert.equal(await previews.redeem(fourth.token!, '/repo', FLOW, {}), null, 'a moved seat winner refuses')

  // The Agent itself vanished from the roster since the preview: still refused.
  state.winner = { runtime: 'alpha' }
  const fifth = await previews.preview('/repo', FLOW, {})
  state.agentsRoster = []
  const droppedAgent = await previews.redeem(fifth.token!, '/repo', FLOW, {})
  assert.equal(droppedAgent, null, 'a dropped Agent refuses')

  // Unchanged: the exact same inputs redeem cleanly.
  state.agentsRoster = [AGENT('writer')]
  const sixth = await previews.preview('/repo', FLOW, {})
  const ok = await previews.redeem(sixth.token!, '/repo', FLOW, {})
  assert.ok(ok, 'an unchanged token redeems')
})

test('a token is consumed on its first redeem, whatever the answer', async () => {
  const state = rig()
  const previews = new FlowPreviews(state.port)
  const preview = await previews.preview('/repo', FLOW, {})
  assert.ok(await previews.redeem(preview.token!, '/repo', FLOW, {}))
  assert.equal(await previews.redeem(preview.token!, '/repo', FLOW, {}), null, 'a second redeem of the same token is refused')
})

test('a flow with an error mints no token, and names the problem', async () => {
  const state = rig()
  const previews = new FlowPreviews(state.port)
  const broken = await previews.preview('/repo', 'version: 2\nname: x\nroles: {}\nseed: { role: missing, title: Go }\nrules: []\n', {})
  assert.equal(broken.token, null)
  assert.ok(broken.problems.some((one) => one.level === 'error'))
})

test('a check retry preview validates the exact saved source and vars, never a new choice', async () => {
  const state = rig()
  let saved: { source: string; vars: Readonly<Record<string, string>> } | null = { source: FLOW, vars: {} }
  const withRetry: FlowPreviewPort = { ...state.port, storedRun: async () => saved }
  const previews = new FlowPreviews(withRetry)
  const ok = await previews.preview('/repo', FLOW, {}, { run: 'flow-1', card: 3 })
  assert.ok(ok.token, 'matching source and vars still preview cleanly')
  assert.deepEqual(previews.retryTarget(ok.token!), { run: 'flow-1', card: 3 })

  const tampered = await previews.preview('/repo', `${FLOW}\n# different`, {}, { run: 'flow-1', card: 3 })
  assert.equal(tampered.token, null, 'text that does not match the saved run is refused')
  assert.equal(tampered.problems[0]?.text, CHANGED_PREVIEW)

  saved = null
  const gone = await previews.preview('/repo', FLOW, {}, { run: 'flow-1', card: 3 })
  assert.equal(gone.token, null, 'a run that can no longer be read is refused the same way')
})
