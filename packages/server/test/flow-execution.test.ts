import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BRIEF_CHANGED, INDEPENDENT } from '../src/flow-execution.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'

const THREE_STAGES = `
version: 2
name: Write, review, decide
roles:
  author: { kind: agent, uses: [writer-a, writer-b] }
  reviewer: { kind: agent, uses: reviewer }
  person: { kind: person, outcomes: [merged] }
seed: { role: author, title: Write it }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review it } }
  - { id: decide, on: reviewer, when: { every: [approve] }, then: { role: person, title: Decide } }
`
const AGENTS = [agent('writer-a', ['done']), agent('writer-b', ['done']), agent('reviewer', ['approve'])]

const opens = (events: readonly string[]) => events.filter((one) => one.startsWith('open:'))
const orders = (events: readonly string[]) => events.filter((one) => one.startsWith('order:'))

test('only current round seats and every seat is durable before order', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()

  // The first round alone is seated, and both of its Seats exist before either is sent its card.
  assert.deepEqual(rig.events.filter((one) => !one.startsWith('goal:')), ['open:seat-1', 'open:seat-2', 'order:seat-1', 'order:seat-2'])
  assert.equal(run.rounds.length, 1)
  assert.equal(rig.board(run.goal).intents.length, 2)

  // A fresh Seat for the next round, only once the round before it is finished.
  for (const [card, seat] of [[1, 'seat-1'], [2, 'seat-2']] as const) {
    await rig.team.complete(card, { outcome: 'done' }, rig.sessionOf(seat))
  }
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2', 'open:seat-3'])
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2', 'order:seat-3'])
  const reviewer = rig.seats.get('seat-3')!
  assert.equal(reviewer.agent?.id, 'reviewer')
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 3)?.claim?.sessionId, reviewer.session.sessionId)
})

test('a Seat whose record cannot be written stops the round before any order is sent', async (t) => {
  const rig = await goalRig(t)
  rig.beforeOpen = (n) => { if (n === 2) throw new Error('the Seat record could not be written') }
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()

  assert.deepEqual(orders(rig.events), [], 'no Seat was sent its card')
  assert.deepEqual(rig.events.filter((one) => one.startsWith('release:')), ['release:seat-1'], 'only this round’s own opening is released')
  const now = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(now.state, 'stalled')
  assert.match(now.reason ?? '', /could not be opened: the Seat record could not be written/)
})

test('specialists cannot claim each other’s bindings', async (t) => {
  const rig = await goalRig(t)
  const SPECIALISTS = `
version: 2
name: Two specialists
roles:
  specialists: { kind: agent, uses: [frontend, backend] }
seed: { role: specialists, title: Build your part }
rules: []
`
  const run = await rig.start(SPECIALISTS, [agent('frontend', ['done']), agent('backend', ['done'])])
  await rig.flows.flush()
  const front = rig.sessionOf('seat-1')
  const back = rig.sessionOf('seat-2')
  // Both hold the same role on the board; only the binding tells their cards apart.
  assert.equal(rig.team.roleOf(run.goal, front.runtime, front.sessionId), 'specialists')
  assert.equal(rig.team.roleOf(run.goal, back.runtime, back.sessionId), 'specialists')

  await rig.team.complete(1, { outcome: 'done' }, front)
  assert.match(await rig.team.release(2, {}, back), /released|let go|back/i)
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 2)?.state, 'open')

  assert.match(await rig.team.claimNext(front), /Nothing to take/)
  assert.match(await rig.team.claim(2, front), /belongs to another Seat/)
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 2)?.state, 'open')
  assert.doesNotMatch(await rig.team.claim(2, back), /Refused/)
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 2)?.claim?.sessionId, back.sessionId)
})

test('isolation carries checkout ports and browser profile', async (t) => {
  const rig = await goalRig(t)
  const ISOLATED = `
version: 2
name: Two isolated writers
roles:
  author: { kind: agent, uses: writer, count: 2, isolate: true }
seed: { role: author, title: Write your version }
rules: []
`
  const run = await rig.start(ISOLATED, [agent('writer', ['done'])])
  await rig.flows.flush()
  const lanes = ['seat-1', 'seat-2'].map((seat) => rig.lanes.get(seat)!)
  assert.notEqual(lanes[0]!.cwd, lanes[1]!.cwd)
  assert.notDeepEqual(lanes[0]!.ports, lanes[1]!.ports)
  assert.notEqual(lanes[0]!.browserProfile, lanes[1]!.browserProfile)
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2'])

  // A re-arm keeps the same lane, and goes out only while it is unchanged.
  rig.kill('seat-1')
  await rig.flows.reArm(rig.sessionOf('seat-1').runtime, rig.sessionOf('seat-1').sessionId)
  await rig.flows.flush()
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2', 'order:seat-1'])
  assert.deepEqual(rig.lanes.get('seat-1'), lanes[0])

  rig.lanes.set('seat-2', { ...lanes[1]!, browserProfile: null })
  await rig.flows.reArm(rig.sessionOf('seat-2').runtime, rig.sessionOf('seat-2').sessionId)
  await rig.flows.flush()
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2', 'order:seat-1'], 'a changed environment is not re-armed')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stalled')
})

test('an isolated step whose lane is incomplete is refused and its Seat released, never downgraded', async (t) => {
  const rig = await goalRig(t)
  rig.laneFor = (n, seat) => ({
    id: `lane-${n}`, goal: seat.board!, seat: String(seat.id), cwd: seat.checkout.cwd, branch: `harnessdesk/lane-${n}`,
    ports: { start: 30000, end: 30019 }, browserProfile: null, state: 'active', createdAt: 1,
  })
  const run = await rig.start(`
version: 2
name: One isolated writer
roles:
  author: { kind: agent, uses: writer, isolate: true }
seed: { role: author, title: Write }
rules: []
`, [agent('writer', ['done'])])
  await rig.flows.flush()
  assert.deepEqual(orders(rig.events), [])
  assert.deepEqual(rig.events.filter((one) => one.startsWith('release:')), ['release:seat-1'])
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stalled')
})

test('concurrent completion and evidence notices open one round', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()
  // The first write of the next round's plan fails; the notices after it retry.
  rig.files.failOnce = (stored) => stored.rounds.length === 2
  await Promise.all([
    rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1')),
    rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2')),
    rig.flows.wakeEvidence(run.goal),
  ])
  await rig.flows.flush()
  assert.equal(rig.files.failOnce, null, 'one journal write did fail')
  await rig.flows.wakeEvidence(run.goal)
  await rig.flows.flush()

  const rounds = rig.flows.executionsFor(run.goal)[0]!.rounds
  assert.deepEqual(rounds.map((round) => round.cause), ['seed', 'after:1:review'])
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2', 'open:seat-3'], 'one reviewer Seat')
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2', 'order:seat-3'], 'one order each')
  assert.equal(rig.board(run.goal).intents.filter((card) => card.role === 'reviewer').length, 1)
})

test('same and unknown providers cannot review an independent predecessor', async (t) => {
  const policy = (seat: string) => `
version: 2
name: Write then review
roles:
  author: { kind: agent, uses: writer, seats: [alpha] }
  reviewer: { kind: agent, uses: reviewer, seats: [${seat}], independentOf: [author] }
seed: { role: author, title: Write }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review } }
`
  const attempt = async (seat: string, opensAs?: string) => {
    const rig = await goalRig(t)
    rig.providers.set('alpha', 'first').set('alpha-two', 'first').set('beta', 'second')
    const run = await rig.start(policy(seat), [agent('writer', ['done']), agent('reviewer', ['approve'])])
    await rig.flows.flush()
    if (opensAs) rig.opensAs = (asked) => (asked === seat ? opensAs : asked)
    await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
    await rig.flows.flush()
    return { rig, run: rig.flows.executionsFor(run.goal)[0]! }
  }

  const same = await attempt('alpha-two')
  assert.equal(same.run.state, 'stalled')
  assert.equal(same.run.reason, INDEPENDENT)
  assert.deepEqual(opens(same.rig.events), ['open:seat-1'], 'another runtime of the same provider is not opened')

  const unknown = await attempt('gamma')
  assert.equal(unknown.run.reason, INDEPENDENT)
  assert.deepEqual(opens(unknown.rig.events), ['open:seat-1'], 'an unknown provider is never taken for an independent one')

  const other = await attempt('beta')
  assert.equal(other.run.state, 'running')
  assert.deepEqual(opens(other.rig.events), ['open:seat-1', 'open:seat-2'])
  assert.deepEqual(orders(other.rig.events), ['order:seat-1', 'order:seat-2'])

  const readback = await attempt('beta', 'alpha-two')
  assert.equal(readback.run.reason, INDEPENDENT)
  assert.deepEqual(orders(readback.rig.events), ['order:seat-1'], 'a Seat that came back on the writer’s provider is sent nothing')
  assert.deepEqual(readback.rig.events.filter((one) => one.startsWith('release:')), ['release:seat-2'])
})

test('a brief changed since the run was compiled is refused before and after opening', async (t) => {
  const rig = await goalRig(t)
  rig.digests.set('writer', 'edited-digest')
  const run = await rig.start(`
version: 2
name: One writer
roles:
  author: { kind: agent, uses: writer }
seed: { role: author, title: Write }
rules: []
`, [agent('writer', ['done'])])
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), [])
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.reason, BRIEF_CHANGED)
})

test('a round cannot open on a Goal that can no longer run work', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()
  rig.dispatch = { ok: false, reason: 'This Goal came from a backup. Start a new Goal to continue its work.' }
  for (const [card, seat] of [[1, 'seat-1'], [2, 'seat-2']] as const) {
    await rig.team.complete(card, { outcome: 'done' }, rig.sessionOf(seat))
  }
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'])
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.rounds.length, 1)
})

test('a board-only run keeps its board board-only until it is stopped', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()
  assert.equal(rig.board(run.goal).messaging, false)
  assert.throws(() => rig.team.setMessaging(run.goal, true), /runs board-only/)
  await rig.flows.stopRun(run.id)
  assert.deepEqual(rig.events.filter((one) => one.startsWith('release:')).sort(), ['release:seat-1', 'release:seat-2'])
  rig.team.setMessaging(run.goal, true)
  assert.equal(rig.board(run.goal).messaging, true)
})

/*
 * A round that cannot open never leaves a run reading "running" with nothing
 * happening: the run stalls, and its reason is the refusal that stopped it —
 * whether the first round (right after start) or a later one (after a card
 * finished) was the one that could not open.
 */
test('a round that cannot open stalls the run with the reason, never a silent "running"', async (t) => {
  const REFUSED = 'This Goal came from a backup. Start a new Goal to continue its work.'

  const first = await goalRig(t)
  first.dispatch = { ok: false, reason: REFUSED }
  const started = await first.start(THREE_STAGES, AGENTS)
  await first.flows.flush()
  assert.deepEqual(opens(first.events), [])
  assert.deepEqual([started.state, started.reason], ['stalled', REFUSED], 'the start answers with the stall, not a running run')

  const later = await goalRig(t)
  const run = await later.start(THREE_STAGES, AGENTS)
  await later.flows.flush()
  later.dispatch = { ok: false, reason: REFUSED }
  for (const [card, seat] of [[1, 'seat-1'], [2, 'seat-2']] as const) {
    await later.team.complete(card, { outcome: 'done' }, later.sessionOf(seat))
  }
  await later.flows.flush()
  const execution = later.flows.executionsFor(run.goal)[0]!
  assert.deepEqual([execution.state, execution.reason], ['stalled', REFUSED])
})
