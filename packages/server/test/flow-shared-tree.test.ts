import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentEntry, CeilingLevel, FindingRunState, FlowBinding, SeatPlan } from '@harnessdesk/protocol'

import type { FindingRunSnapshot } from '../src/flow-execution.js'
import { compileFlowPolicy, parseFlowPolicy, reviewsIn } from '../src/flow-policy.js'
import { FlowPreviews } from '../src/flow-preview.js'
import { closeRound } from '../src/findings/plane.js'

/*
 * Issue #1014. Two Seats of one round run at the same time; without
 * `isolate` they share one working tree, and when their grant lets them
 * commit, each one's commits and branch changes land on the other's work.
 * The dry run — and so the start, which redeems only a fresh one — refuses
 * that shape and says how to fix it. And a round that writes rather than
 * reviews is never taken for a review series's round, so its stall is its
 * own, never "findings could not be read".
 */

const agent = (id: string, produces: readonly string[] = ['diff'], ceiling: CeilingLevel = 'edit'): AgentEntry => ({
  id, origin: 'project', path: `.harnessdesk/agents/${id}/AGENT.md`, digest: `${id}-digest`, shadows: [], problems: [],
  definition: { id, name: id, ceiling, ceilingFrom: 'ceiling', answers: ['done'], produces: [...produces], skills: [], mcp: [], prefer: [{ runtime: 'alpha' }], brief: `${id} brief` },
})

const flow = (role: string) => `
version: 2
name: Siblings
roles:
  analyst: { kind: agent, ${role} }
  referee: { kind: person, outcomes: [done] }
seed: { role: analyst, title: Take a position }
rules:
  - { id: hand, on: analyst, when: { every: done }, then: { role: referee, title: Read both } }
`

const compiled = (role: string, agents: readonly AgentEntry[] = [agent('writer'), agent('other')]) => {
  const parsed = parseFlowPolicy(flow(role))
  assert.ok(parsed.document, JSON.stringify(parsed.problems))
  return compileFlowPolicy(parsed.document!, agents)
}

const errors = (role: string, agents?: readonly AgentEntry[]): string[] =>
  compiled(role, agents).problems.filter((one) => one.level === 'error').map((one) => `${one.at}: ${one.text}`)

test('siblings that can commit and share one working tree are refused, with the role and the fix named', () => {
  for (const role of [
    'uses: writer, count: 2, grant: edit',
    'uses: writer, count: 3, grant: publish',
    'uses: [writer, other], grant: edit',
    'uses: writer, seats: [alpha=one, alpha=two], grant: publish',
  ]) {
    const found = errors(role)
    assert.equal(found.length, 1, `${role}: ${JSON.stringify(found)}`)
    assert.match(found[0]!, /^roles\.analyst: /)
    assert.match(found[0]!, /"analyst"/, 'names the role')
    assert.match(found[0]!, /one working tree/)
    assert.match(found[0]!, /add isolate: true, or lower its grant to read\.$/, 'names the fix')
    assert.equal(found[0]!.split('. ').length, 1, 'one sentence')
  }
})

test('a read-only sibling pair, an isolated pair and a single committing Seat all pass', () => {
  assert.deepEqual(errors('uses: writer, count: 2, grant: read'), [])
  assert.deepEqual(errors('uses: writer, count: 2'), [], 'the default grant is read')
  assert.deepEqual(errors('uses: writer, count: 2, isolate: true, grant: edit'), [])
  assert.deepEqual(errors('uses: [writer, other], isolate: true, grant: publish'), [])
  assert.deepEqual(errors('uses: writer, grant: publish'), [], 'one Seat has the tree to itself')
  // The grant is capped by the Agent's own ceiling: an Agent that may only read cannot commit, however it is granted.
  assert.deepEqual(errors('uses: writer, count: 2, grant: edit', [agent('writer', ['review'], 'read')]), [])
})

test('the dry run of a shared-tree committing pair mints no start token, and names the problem', async () => {
  const previews = new FlowPreviews({
    confine: async () => {},
    agents: async () => [agent('writer')],
    previewAgent: async (_root, id) => ({
      id, from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'edit', hold: 'asked' },
      candidates: [{ seat: { runtime: 'alpha' }, label: 'Alpha', runtimeName: 'Alpha', state: 'taken', reason: null, fix: null }],
    } satisfies SeatPlan),
    now: () => 1,
  })
  const refused = await previews.preview('/repo', flow('uses: writer, count: 2, grant: edit'), {})
  assert.equal(refused.token, null, 'nothing a start could redeem')
  assert.ok(refused.problems.some((one) => one.level === 'error' && one.at === 'roles.analyst' && /isolate: true/.test(one.text)))
  const isolated = await previews.preview('/repo', flow('uses: writer, count: 2, isolate: true, grant: edit'), {})
  assert.ok(isolated.token, 'the isolated pair starts')
})

const binding = (produces: readonly string[], grant: CeilingLevel, ceiling: CeilingLevel = 'edit'): FlowBinding => ({
  role: 'analyst', index: 0, agent: agent('analyst', produces, ceiling).definition!, origin: 'project', digest: 'd', seats: [], grant,
})

test('an Agent that both writes and reviews reviews only in a round whose grant cannot commit', () => {
  // UC1's debate: the analysts commit their positions, so theirs is a writing round, not a review series.
  assert.equal(reviewsIn(binding(['diff', 'review'], 'edit')), false)
  assert.equal(reviewsIn(binding(['diff', 'review'], 'publish')), false)
  // UC1's acceptance: the same Agent, granted read, judges.
  assert.equal(reviewsIn(binding(['diff', 'review'], 'read')), true)
  assert.equal(reviewsIn(binding(['diff', 'review'], 'edit', 'read')), true, 'its own ceiling caps the grant')
  // A reviewer that only reviews reviews whatever it is granted; a writer never does.
  assert.equal(reviewsIn(binding(['review'], 'edit')), true)
  assert.equal(reviewsIn(binding(['diff'], 'read')), false)
})

const state = (rounds: number): FindingRunState => ({
  version: 1, budget: { rounds, withoutProgress: 5 }, closedRounds: [], idleRounds: 0, progress: [], series: [],
  stopped: null, extraRound: null, overrides: [], lastDecision: null,
})

const close = (reviews: boolean, budget: number) => {
  const round = { n: 1, role: 'analyst', cards: [1, 2], seats: [], evidence: [], state: 'closed' as const, cause: 'seed', reviews }
  const snapshot: FindingRunSnapshot = {
    id: 'run-1', goal: 'goal-1', state: 'running', reason: null, findings: state(budget), rounds: [round],
    slots: {}, pendingFindings: 0, pinned: {}, leads: {},
  }
  // One evidence line of the project could not be read — nothing about this round's own work.
  return closeRound({ snapshot, round, ledger: { records: [], views: [], unreadable: 1 }, facts: [], subjects: [] })
}

test('a plain round is never stopped by the review series, and a stall there names its own cause', () => {
  assert.equal(close(false, 3).stopped, null, 'an unreadable evidence line is no reason to stop a round that counts no findings')
  const stalled = close(false, 1).stopped
  assert.ok(stalled, 'the run budget still stops a plain round')
  assert.equal(stalled.reason, 'Round 1 ended with 0 open findings.', 'the budget, not the findings ledger')
  assert.doesNotMatch(stalled.reason, /could not be read/)
})

test('a review round still stops on an unreadable ledger, and says which records', () => {
  const stopped = close(true, 3).stopped
  assert.ok(stopped)
  assert.equal(stopped.reason, 'Some evidence records could not be read, so the open findings cannot be counted. A person has to look.')
})
