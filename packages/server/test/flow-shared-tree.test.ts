import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentEntry, CeilingLevel, FindingRunState, FlowBinding, SeatPlan } from '@harnessdesk/protocol'

import type { FindingRunSnapshot } from '../src/flow-execution.js'
import { compileFlowPolicy, parseFlowPolicy, reviewsIn } from '../src/flow-policy.js'
import { FlowPreviews } from '../src/flow-preview.js'
import { closeRound } from '../src/findings/plane.js'
import { goalRig, type GoalRig } from './fixtures/flow-goal-rig.js'

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

test('a wide role is refused only when two of its Seats may commit, and says how many', () => {
  const reader = agent('reader', ['review'], 'read')
  // A writer beside a reviewer that may only read: one Seat commits, so nothing lands on anyone else's work.
  assert.deepEqual(errors('uses: [writer, reader], grant: edit', [agent('writer'), reader]), [])
  const found = errors('uses: [writer, other, reader], grant: edit', [agent('writer'), agent('other'), reader])
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.match(found[0]!, /^roles\.analyst: 2 of the 3 Seats of "analyst" run at once in one working tree/)
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

test('the dry run says, per Seat, whether it is there to review — decided by the server, not the screen', async () => {
  const both = agent('analyst', ['diff', 'review'])
  const previews = new FlowPreviews({
    confine: async () => {},
    agents: async () => [both],
    previewAgent: async (_root, id) => ({
      id, from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'edit', hold: 'asked' },
      candidates: [{ seat: { runtime: 'alpha' }, label: 'Alpha', runtimeName: 'Alpha', state: 'taken', reason: null, fix: null }],
    } satisfies SeatPlan),
    now: () => 1,
  })
  const writing = await previews.preview('/repo', flow('uses: analyst, count: 2, isolate: true, grant: edit'), {})
  assert.deepEqual(writing.seats.map((one) => one.reviews), [false, false], 'seated to commit, it writes')
  const judging = await previews.preview('/repo', flow('uses: analyst, count: 2, grant: read'), {})
  assert.deepEqual(judging.seats.map((one) => one.reviews), [true, true], 'seated to read, it reviews')
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
  assert.equal(stalled.reason, 'This run reached its limit of 1 round.', 'the budget, in plain words — never a count of findings it did not read')
  assert.doesNotMatch(stalled.reason, /could not be read|findings/)
  assert.equal(close(false, 1).stopped?.round, 1)
})

test('a review round still stops on an unreadable ledger, and says which records', () => {
  const stopped = close(true, 3).stopped
  assert.ok(stopped)
  assert.equal(stopped.reason, 'Some evidence records could not be read, so the open findings cannot be counted. A person has to look.')
})

/*
 * The same decisions on the real engine: an Agent that produces diffs and
 * reviews, seated under `edit` for two debate rounds, then a check. Each
 * assertion below fails if the round is taken for a review round again.
 */
const DEBATE = (blind: string) => `
version: 2
name: Debate then check
roles:
  analyst: { kind: agent, uses: analyst, count: 2, isolate: true, grant: edit${blind} }
  gate: { kind: check, run: "pnpm verify", exits: { "0": pass }, otherwise: fail, timeout: 30 }
seed: { role: analyst, title: Take a position }
rules:
  - { id: debate, on: analyst, when: { any: [disagree] }, then: { role: analyst, title: Debate } }
  - { id: check, on: analyst, when: { every: [agreed] }, then: { role: gate, title: Verify } }
budget: { rounds: 10, without-progress: 5 }
`

const ANALYST: AgentEntry = {
  ...agent('analyst', ['diff', 'review']),
  definition: { ...agent('analyst', ['diff', 'review']).definition!, answers: ['agreed', 'disagree'] },
}

const debate = async (t: { after(fn: () => Promise<void>): void }, blind: string) => {
  const rig = await goalRig(t)
  for (const n of [1, 2, 3, 4]) rig.heads.set(`/repo/.lanes/${n}`, { at: `sha-lane-${n}`, dirty: false })
  const packets: number[] = []
  rig.flows.attachReviewPackets(async (_run, round) => {
    packets.push(round)
    return { text: 'a repair packet', pinned: [{ cwd: '/repo', at: 'sha-pinned' }], leads: [] }
  })
  const run = await rig.start(DEBATE(blind), [ANALYST])
  await rig.flows.flush()
  return { rig, run, packets }
}

const holderOf = (rig: GoalRig, goal: string, card: number) => {
  const claim = rig.board(goal).intents.find((one) => one.id === card)?.claim
  const seat = [...rig.seats.values()].find((one) => one.session.sessionId === claim?.sessionId)
  assert.ok(seat, `somebody holds card ${card}`)
  return rig.sessionOf(String(seat.id))
}

test('a debate round of a writing-and-reviewing Agent owes no review, is pinned no packet, and is the next check\'s subject', async (t) => {
  const { rig, run, packets } = await debate(t, '')
  assert.equal(rig.executions.requiresReview(run.goal, 1), false, 'a writing card owes no structured review')
  assert.equal(rig.flows.findingBinding(run.goal, 1, holderOf(rig, run.goal, 1))?.reviews, false, 'no finding is raised from a writing card')
  for (const card of [1, 2]) {
    const answer = await rig.team.complete(card, { outcome: 'disagree' }, holderOf(rig, run.goal, card))
    assert.doesNotMatch(String(answer), /structured review/)
  }
  await rig.flows.flush()
  const round2 = rig.board(run.goal).intents.filter((one) => one.role === 'analyst' && one.id > 2).map((one) => one.id)
  assert.equal(round2.length, 2, 'the debate round opened')
  assert.deepEqual(packets, [], 'a debate round is no later review of a series')
  assert.deepEqual(rig.flows.findingRun(run.id)?.pinned, {}, 'no review packet is pinned')
  assert.deepEqual(rig.flows.findingRun(run.id)?.rounds.map((one) => one.reviews), [false, false], 'no round of the debate is a review series\'s')
  for (const card of round2) await rig.team.complete(card, { outcome: 'agreed' }, holderOf(rig, run.goal, card))
  await rig.flows.flush()
  assert.deepEqual(rig.checkCwds, ['/repo/.lanes/3', '/repo/.lanes/4'], 'the check runs on each analyst\'s own commit: they are its subjects')
})

test('a plain round with several cards is blind only when its role says blind: true', async (t) => {
  const secret = async (blind: string): Promise<{ blind: number; board: string }> => {
    const { rig, run } = await debate(t, blind)
    await rig.team.complete(1, { outcome: 'disagree', note: 'SECRET-NOTE' }, holderOf(rig, run.goal, 1))
    await rig.flows.flush()
    return { blind: rig.flows.blindRounds(run.goal).length, board: await rig.team.board(holderOf(rig, run.goal, 2)) }
  }
  const blind = await secret(', blind: true')
  assert.equal(blind.blind, 1, 'blind: true embargoes a plain round')
  assert.doesNotMatch(blind.board, /SECRET-NOTE/, 'the sibling still writing cannot read the finished one\'s note')
  const sighted = await secret('')
  assert.equal(sighted.blind, 0, 'a plain round is not blind by default')
  assert.match(sighted.board, /SECRET-NOTE/)
})
