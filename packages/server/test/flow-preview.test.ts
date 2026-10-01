import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentEntry, CeilingLevel, FlowSeat, SeatPlan } from '@harnessdesk/protocol'

import { CHANGED_PREVIEW, FlowPreviews, LEGACY_START, type FlowPreviewPort } from '../src/flow-preview.js'
import { rig as consentRig } from './fixtures/intake-consent.js'

/*
 * A dry run spends nothing and opens nothing; its token authorizes exactly
 * the run it described, and nothing that has moved since.
 */

const AGENT = (id: string, digest = `${id}-digest`): AgentEntry => ({
  id, origin: 'project', path: `.harnessdesk/agents/${id}/AGENT.md`, digest, shadows: [], problems: [],
  definition: { id, name: id, ceiling: 'edit', ceilingFrom: 'ceiling', answers: ['done'], produces: [], skills: [], mcp: [], prefer: [{ runtime: 'alpha' }], brief: `${id} brief` },
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

test('a flow preview refuses a selected seat whose runtime will withhold the board tools in its checkout', async () => {
  const state = rig()
  const checked: boolean[] = []
  const port: FlowPreviewPort = {
    ...state.port,
    pluginToolsProblem: async (runtime, root, isolate) => {
      assert.equal(runtime, 'alpha')
      assert.equal(root, '/repo')
      checked.push(isolate)
      return "Gemini doesn't trust this folder, so it can't use the board. Open Gemini here, run /permissions trust, and start again."
    },
  }
  const preview = await new FlowPreviews(port).preview('/repo', FLOW, {})
  assert.equal(preview.token, null)
  assert.ok(preview.problems.some((problem) => problem.level === 'error' && problem.text.includes('Gemini doesn\'t trust this folder')))
  const isolatedSource = FLOW.replace('kind: agent, uses: writer', 'kind: agent, uses: writer, isolate: true')
  await new FlowPreviews(port).preview('/repo', isolatedSource, {})
  assert.deepEqual(checked, [false, true], 'the preview also predicts the managed checkout for an isolated seat')
})

test('an independent role explains same-provider and ceiling refusals on each candidate', async () => {
  const state = rig()
  state.agentsRoster = [
    AGENT('writer'),
    { ...AGENT('reviewer'), definition: { ...AGENT('reviewer').definition!, prefer: [{ runtime: 'codex' }, { runtime: 'claude-code' }] } },
  ]
  const source = `
version: 2
name: Independent preview
roles:
  writer: { kind: agent, uses: writer, grant: edit }
  reviewer: { kind: agent, uses: reviewer, grant: read, independentOf: [writer] }
seed: { role: writer, title: Write }
rules:
  - { id: review, on: writer, when: { every: [done] }, then: { role: reviewer, title: Review } }
`
  const plan = (agent: string, seats: readonly FlowSeat[], grant: CeilingLevel): SeatPlan => ({
    id: agent, from: 'prefer', winner: 0, blocked: null, ceiling: { level: grant, hold: 'asked' },
    candidates: seats.map((seat, index) => ({
      seat, label: seat.runtime, runtimeName: seat.runtime,
      state: index === 0 ? 'taken' : 'untried',
      reason: null, fix: null,
    })),
  })
  const port = {
    ...state.port,
    previewAgent: async (_root, agent, _seats, grant) => {
      if (agent === 'reviewer') {
        const base = plan(agent, [{ runtime: 'codex' }, { runtime: 'claude-code' }], grant)
        return {
          ...base,
          candidates: [
            { ...base.candidates[0]!, state: 'taken' },
            {
              ...base.candidates[1]!, state: 'passed',
              reason: { kind: 'unheld', level: 'read', detail: null }, fix: { kind: 'ceilings' },
            },
          ],
        }
      }
      return plan(agent, [{ runtime: 'alpha' }], grant)
    },
    providerOf: async (runtime: string) => runtime === 'codex' || runtime === 'alpha' ? 'openai' : 'anthropic',
  } as FlowPreviewPort
  const preview = await new FlowPreviews(port).freeze('/repo', source)
  const reviewer = preview.seats.find((seat) => seat.role === 'reviewer')!.plan
  assert.equal(reviewer.winner, null)
  assert.equal(reviewer.candidates[0]?.reason?.kind, 'sameProvider')
  assert.equal(reviewer.candidates[1]?.reason?.kind, 'unheld')
  assert.ok(preview.problems.some((problem) => problem.at === 'roles.reviewer' && problem.level === 'error'))
})

test('a trigger again round keeps a mixed predecessor role conditional in the dry run', async () => {
  const state = rig()
  state.agentsRoster = [AGENT('writer'), AGENT('target')]
  const source = `
version: 2
name: Trigger preview
roles:
  writer: { kind: agent, uses: writer, isolate: true, grant: edit }
  target: { kind: agent, uses: target, grant: read }
seed: { role: writer, title: Write }
rules:
  - { id: writer-target, on: writer, when: { every: [done] }, then: { role: target, title: Target } }
`
  const normal = await new FlowPreviews(state.port).freeze('/repo', source)
  assert.equal(normal.seats.find((one) => one.role === 'target')?.atPredecessor, 'always')
  const triggered = await new FlowPreviews(state.port).freeze('/repo', source, { againRole: 'target' })
  assert.equal(triggered.seats.find((one) => one.role === 'target')?.atPredecessor, 'may')
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

test('an old-format flow mints no start token, and says to update it', async () => {
  const state = rig()
  const previews = new FlowPreviews(state.port)
  const preview = await previews.preview('/repo', 'name: Old\nroles:\n  w: { kind: agent, seat: alpha, order: Work, outcomes: [done] }\nseed: { role: w, title: W }\n', {})
  assert.equal(preview.compiled.document.format, 'legacy')
  assert.equal(preview.token, null, 'flow/start-goal starts only the Agent format, so nothing here may authorize it')
  assert.deepEqual(preview.problems.filter((one) => one.level === 'error').map((one) => one.text), [LEGACY_START])
})

// ------------------------------------------------------------ intake (phase 8)
/*
 * Named addition for trigger arming: a person's one-shot start token and a
 * trigger's arm token are two different authorities, minted and redeemed by
 * two different owners. Neither redeems the other, and the frozen preview an
 * arm is built on mints no start token at all.
 */
test('trigger preview cannot reuse a person start token', async () => {
  const intake = consentRig()
  const flow = intake.world.flows['review-pr']!
  // An ordinary preview's start token offered to arming: refused, nothing armed.
  const person = await intake.previews.preview(intake.world.project, flow, {})
  assert.ok(person.token)
  await assert.rejects(intake.consent.arm(intake.world.project, 'review', person.token!), /Preview it again/)
  assert.equal(await intake.consent.binding(intake.world.project, 'review'), null)
  // An arm token offered to a public flow start: not a start token.
  const arm = await intake.consent.preview(intake.world.project, 'review')
  assert.ok(arm.token)
  assert.equal(await intake.previews.redeem(arm.token!, intake.world.project, flow, {}), null)
  // The frozen preview behind an arm is the same statement with no token, and leaves none behind.
  const frozen = await intake.previews.freeze(intake.world.project, flow)
  assert.equal(frozen.token, null)
  assert.deepEqual(frozen.commands, person.commands)
  assert.deepEqual(frozen.seats, person.seats)
  // The person's token is still the person's: it redeems once for its own start.
  assert.ok(await intake.previews.redeem(person.token!, intake.world.project, flow, {}))
})

// Added in phase 10 (Task 3): a front-door token carries its held-seat policy, target and Goal; a Start cannot shed them.
test('strict token cannot downgrade', async () => {
  const { flowMethods } = await import('../src/methods/flows.js')
  const state = rig()
  const seen: { requireHeld?: boolean; unattended?: boolean }[] = []
  const port: FlowPreviewPort = {
    ...state.port,
    previewAgent: async (root, agent, seats, grant, options) => {
      seen.push({ ...(options?.requireHeld ? { requireHeld: true } : {}), ...(options?.unattended ? { unattended: true } : {}) })
      return state.port.previewAgent(root, agent, seats, grant, options)
    },
    resolveTarget: async () => 'facts-1',
  }
  const previews = new FlowPreviews(port)
  const started: { requireHeld?: true; goal?: unknown; authorization: { start?: string } }[] = []
  const startedAt = (index: number) => started[index]!
  const ctx = {
    flowPreviews: previews,
    flows: { startGoal: async (request: never) => { started.push(request); return { id: 'run' } } },
  } as never
  const binding = { requireHeld: true as const, target: { context: { kind: 'project' as const, root: '/repo' }, facts: 'facts-1', resolved: null }, goal: { id: 'goal-1', revision: 4 } }
  const strict = async () => (await previews.preview('/repo', FLOW, {}, undefined, binding)).token!
  // The dry run itself was strict: every seat plan was asked for held Seats.
  const first = await strict()
  assert.deepEqual(seen.at(-1), { requireHeld: true })
  // Omitting the Goal at Start refuses; so does naming another one, or another revision.
  await assert.rejects(flowMethods['flow/start-goal'](ctx, { root: '/repo', source: FLOW, token: first, sentence: 'Go' }), new RegExp(CHANGED_PREVIEW.replace(/[.]/g, '\\.')))
  await assert.rejects(flowMethods['flow/start-goal'](ctx, { root: '/repo', source: FLOW, token: await strict(), sentence: 'Go', goal: { id: 'goal-1', revision: 5 } }), /Review the dry run again/)
  // Altering the source refuses, whatever else is sent.
  await assert.rejects(flowMethods['flow/start-goal'](ctx, { root: '/repo', source: `${FLOW}\n# edited`, token: await strict(), sentence: 'Go', goal: binding.goal }), /Review the dry run again/)
  // Spent tokens stay spent: the first one cannot be retried the right way now.
  await assert.rejects(flowMethods['flow/start-goal'](ctx, { root: '/repo', source: FLOW, token: first, sentence: 'Go', goal: binding.goal }), /Review the dry run again/)
  assert.equal(started.length, 0)
  // Exactly as previewed, the start is strict — decided by the token, which the request never names.
  await flowMethods['flow/start-goal'](ctx, { root: '/repo', source: FLOW, token: await strict(), sentence: 'Go', goal: binding.goal })
  assert.equal(started.length, 1)
  assert.equal(startedAt(0).requireHeld, true)
  assert.deepEqual(startedAt(0).goal, binding.goal)
  assert.equal(startedAt(0).authorization.start, 'front-door')
  // A target that moved since the preview refuses at Start, too.
  const moved = await strict()
  port.resolveTarget = async () => 'facts-2'
  await assert.rejects(flowMethods['flow/start-goal'](ctx, { root: '/repo', source: FLOW, token: moved, sentence: 'Go', goal: binding.goal }), /Review the dry run again/)
  // An ordinary token stays ordinary: no held-seat policy, no Goal, and one cannot be asked for at Start.
  const plain = (await previews.preview('/repo', FLOW, {})).token!
  await assert.rejects(flowMethods['flow/start-goal'](ctx, { root: '/repo', source: FLOW, token: plain, sentence: 'Go', goal: binding.goal }), /Review the dry run again/)
  await flowMethods['flow/start-goal'](ctx, { root: '/repo', source: FLOW, token: (await previews.preview('/repo', FLOW, {})).token!, sentence: 'Go' })
  assert.equal(started.length, 2)
  assert.equal(startedAt(1).requireHeld, undefined)
  assert.equal(startedAt(1).authorization.start, undefined)
})

/*
 * #1094: an evidence guard's `check:` is matched against the observed fact's
 * own `run` — the literal command a check role ran — never a role's id. A
 * rule written the way it reads naturally, naming the role, could never
 * match; the dry run now reads a role's own id as its command, and refuses a
 * name that explains nothing this flow (or, failing that, the project's own
 * declared checks) runs.
 */
const guardedBy = (value: string) => `
version: 2
name: One writer, one gate, then a person
roles:
  author: { kind: agent, uses: writer }
  gate: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail }
  person: { kind: person, outcomes: [shipped] }
seed: { role: author, title: Write it }
rules:
  - { id: check, on: author, when: { every: [done] }, then: { role: gate, title: Verify } }
  - { id: ship, on: gate, when: { evidence: [{ check: ${value} }] }, then: { role: person, title: Ship it } }
`

test('an evidence guard naming a check role’s own id resolves to its command, and never asks the project for its own checks', async () => {
  const state = rig()
  state.port.projectChecks = async () => { throw new Error('a role’s own id never needs the project’s checks') }
  const previews = new FlowPreviews(state.port)
  const preview = await previews.preview('/repo', guardedBy('gate'), {})
  assert.deepEqual(preview.problems, [])
  assert.ok(preview.token, 'a role’s own id is a known, resolvable name')
})

test('an evidence guard naming its check role’s exact command still matches directly', async () => {
  const state = rig()
  const previews = new FlowPreviews(state.port)
  const preview = await previews.preview('/repo', guardedBy('"pnpm verify"'), {})
  assert.deepEqual(preview.problems, [])
  assert.ok(preview.token)
})

test('an evidence guard naming nothing this flow runs is refused at the dry run, in one plain sentence', async () => {
  const state = rig()
  const previews = new FlowPreviews(state.port)
  const preview = await previews.preview('/repo', guardedBy('nonexistent'), {})
  assert.equal(preview.token, null)
  assert.ok(
    preview.problems.some((one) => one.level === 'error' && /waits for a check called "nonexistent".*name a check role or its command/.test(one.text)),
    JSON.stringify(preview.problems),
  )
})

test('an evidence guard the flow’s own roles leave unexplained may still name a project’s own declared check', async () => {
  const state = rig()
  state.port.projectChecks = async () => ['pnpm lint']
  const previews = new FlowPreviews(state.port)
  const preview = await previews.preview('/repo', guardedBy('"pnpm lint"'), {})
  assert.deepEqual(preview.problems, [])
  assert.ok(preview.token, 'a project’s own check, never named by this flow, is still a legitimate guard')
})
