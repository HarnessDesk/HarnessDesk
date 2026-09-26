import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TeamEntry, TeamSignal } from '@harnessdesk/protocol'

import { BRIEF_CHANGED, INDEPENDENT } from '../src/flow-execution.js'
import { overlaps } from '../src/team.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'

const addedSignal = (channel: readonly TeamEntry[]): TeamSignal | undefined =>
  channel.find((entry): entry is TeamSignal => entry.kind === 'signal' && entry.signal === 'added')

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

test('a round whose first Seat will not open says its sibling was not started, and what a person can do next', async (t) => {
  const rig = await goalRig(t)
  const refusal = 'No seat could be opened for this Agent:\n  claude-code=haiku — claude-code could not open a conversation: the lane was refused'
  rig.beforeOpen = (n) => { if (n === 1) throw new Error(refusal) }
  const run = await rig.start(THREE_STAGES, AGENTS)
  await rig.flows.flush()

  // The design holds: a round's cards start together, so the sibling is not tried alone.
  assert.deepEqual(opens(rig.events), [], 'card #2 is never seated on its own')
  assert.deepEqual(orders(rig.events), [])
  const now = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(now.state, 'stalled')
  assert.equal(
    now.reason,
    `The Seat for card #1 could not be opened: ${refusal}\n` +
      'A round’s cards start together, so card #2 was not started either.\n' +
      'Next: wrap this Goal, which stops this run, then fix what stopped card #1 and start the flow again in a new Goal.',
  )

  // The facts the advice rests on. Wrapping is what stops a stalled run — the
  // wrap barrier, `stopGoal` — and the run it stops is this one.
  await rig.flows.stopGoal(run.goal, 'the Goal was wrapped')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stopped')
  // And starting the flow again opens a Goal of its own, not this one.
  rig.beforeOpen = null
  const again = await rig.start(THREE_STAGES, AGENTS)
  assert.notEqual(again.goal, run.goal)
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

/*
 * A predecessor whose provider is unknown makes the round unprovable
 * (the #1019 stall). What the stall says once it happens depends on whether
 * there is anything to fix, and the agent's own presentation name is used
 * only when the desk actually has one (Opus review of #1028).
 */
const unreadableWriterFlow = (seat: string): string => `
version: 2
name: Write then review
roles:
  author: { kind: agent, uses: writer, seats: [${seat}] }
  reviewer: { kind: agent, uses: reviewer, seats: [beta], independentOf: [author] }
seed: { role: author, title: Write }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review } }
`

test('an unreadable predecessor with a reader names the card and the agent, and points at its configuration', async (t) => {
  const rig = await goalRig(t)
  // 'alpha' has a reader — `readableProviders` says so — but it is never given a provider, so it reads unknown.
  rig.presentations.set('alpha', 'DeepSeek Harness')
  rig.readableProviders.add('alpha')
  rig.providers.set('beta', 'second')
  const run = await rig.start(unreadableWriterFlow('alpha'), [agent('writer', ['done']), agent('reviewer', ['approve'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const stalled = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(stalled.state, 'stalled')
  assert.equal(
    stalled.reason,
    'This step needs an independent provider, but the agent on card #1, DeepSeek Harness, could not have its provider read, so no seat can be proven independent of it. ' +
      'Fix that agent’s own configuration if something there points it at another host, or run this role without independentOf.',
  )
  assert.deepEqual(opens(rig.events), ['open:seat-1'], 'the reviewer is never opened once independence cannot be proven')
})

test('an unreadable predecessor with no presentation name at all falls back to naming just the card', async (t) => {
  const rig = await goalRig(t)
  // No `rig.presentations` entry for 'alpha' at all — the desk has nothing to call it.
  rig.readableProviders.add('alpha')
  rig.providers.set('beta', 'second')
  const run = await rig.start(unreadableWriterFlow('alpha'), [agent('writer', ['done']), agent('reviewer', ['approve'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const stalled = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(
    stalled.reason,
    'This step needs an independent provider, but the agent on card #1 could not have its provider read, so no seat can be proven independent of it. ' +
      'Fix that agent’s own configuration if something there points it at another host, or run this role without independentOf.',
  )
})

test('an unreadable predecessor with no provider reader at all points at independentOf or reseating, never at configuration', async (t) => {
  const rig = await goalRig(t)
  // 'alpha' is never added to `readableProviders` — no reader exists for it, the Cursor case.
  rig.presentations.set('alpha', 'Cursor')
  rig.providers.set('beta', 'second')
  const run = await rig.start(unreadableWriterFlow('alpha'), [agent('writer', ['done']), agent('reviewer', ['approve'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const stalled = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(
    stalled.reason,
    'This step needs an independent provider, but the agent on card #1, Cursor, could not have its provider read, so no seat can be proven independent of it. ' +
      'That agent has no provider reader at all, so the only way forward is to run this role without independentOf, or to seat that earlier card on an agent whose provider can be read.',
  )
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

test('trigger dispatch is held through durable application', async (t) => {
  const rig = await goalRig(t)
  const REVIEW = `
version: 2
name: Review a change
roles:
  reviewer: { kind: agent, uses: reviewer }
  gate: { kind: check, run: "pnpm test", timeout: 60, exits: { "0": pass }, otherwise: fail }
seed: { role: reviewer, title: Review it }
rules:
  - { id: verify, on: reviewer, when: { every: [approve] }, then: { role: gate, title: Verify } }
`
  const agents = [agent('reviewer', ['approve'])]
  // A trigger's start: the Goal and the round's cards exist, and nothing is seated, handed over or run.
  const run = await rig.startTriggered(REVIEW, agents, { again: 'reviewer' })
  await rig.flows.flush()
  assert.equal(run.intake?.dispatchHeld, true)
  assert.equal(rig.board(run.goal).intents.length, 1, 'the seed round’s card exists')
  assert.deepEqual(rig.events.filter((one) => !one.startsWith('goal:')), [], 'no Seat, order or check before the firing is applied')
  // Neither a completion notice, an evidence notice nor a re-arm can move a held run.
  await rig.flows.wakeEvidence(run.goal)
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => !one.startsWith('goal:')), [])

  // Released: exactly what a person's start would have done.
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => !one.startsWith('goal:')), ['open:seat-1', 'order:seat-1'])
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.intake?.dispatchHeld, false)

  // A later firing: its round is held before it opens, whatever the first round is doing.
  const key = 'b'.repeat(64)
  const round = await rig.flows.againTriggered(run.id, key, [])
  await rig.flows.flush()
  assert.equal(round.state, 'opening')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.intake?.dispatchHeld, true)
  assert.deepEqual(opens(rig.events), ['open:seat-1'], 'the later round seats nobody while held')
  // The first round finishing does not advance a held run either.
  await rig.team.complete(1, { outcome: 'approve' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => one.startsWith('check:')), [], 'no check runs while held')
  // Asked again, the same firing's round is the same round.
  assert.equal((await rig.flows.againTriggered(run.id, key, [])).n, round.n)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'])

  // A gate that refuses stops the run with its reason instead of dispatching.
  const gated = await rig.startTriggered(REVIEW, agents)
  rig.triggerGate = () => 'Out of budget: this Goal reached its spend limit.'
  await rig.flows.resumeTriggered(gated.id)
  await rig.flows.flush()
  const stalled = rig.flows.executionsFor(gated.goal)[0]!
  assert.equal(stalled.state, 'stalled')
  assert.equal(stalled.reason, 'Out of budget: this Goal reached its spend limit.')
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'], 'the refused run seated nobody')
  rig.triggerGate = null

  // What it runs changed after the firing: the run is stopped with why, and never dispatches.
  const changed = await rig.startTriggered(REVIEW, agents, { changed: true })
  assert.equal(changed.state, 'stopped')
  assert.match(changed.reason ?? '', /changed after it fired/)
  await rig.flows.resumeTriggered(changed.id)
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'])

  // A restart reads the held flag back and keeps holding.
  const held = await rig.startTriggered(REVIEW, agents)
  await rig.restart()
  await rig.flows.resume()
  await rig.flows.flush()
  assert.equal(rig.flows.executionsFor(held.goal)[0]!.intake?.dispatchHeld, true)
  assert.deepEqual(opens(rig.events), ['open:seat-1', 'open:seat-2'])
})

/**
 * A card a trigger's own run opens names the trigger, never the person: the
 * trigger fired unattended, and nobody read a dry run or pressed anything.
 * `addIntentForFlow` used to attribute every card it opened to `{ kind: 'user' }`
 * unconditionally — right for a flow a person started (they read the dry run
 * and pressed Start), wrong for one a trigger opened on its own. The room's
 * channel showed "You added #1 — …" for a card admission opened while nobody
 * was at the keyboard (#898).
 */
test('a card a trigger’s run opens names the trigger, and a card a person’s run opens still names the person', async (t) => {
  const rig = await goalRig(t)
  const SEED_ONLY = `
version: 2
name: Review a change
roles:
  reviewer: { kind: agent, uses: reviewer }
seed: { role: reviewer, title: Review it }
rules: []
`
  const agents = [agent('reviewer', ['approve'])]

  const triggered = await rig.startTriggered(SEED_ONLY, agents)
  const triggeredAdd = addedSignal(rig.board(triggered.goal).channel)
  assert.deepEqual(triggeredAdd?.by, { kind: 'trigger', trigger: 'review' })

  const started = await rig.start(SEED_ONLY, agents)
  const startedAdd = addedSignal(rig.board(started.goal).channel)
  assert.deepEqual(startedAdd?.by, { kind: 'user' })
})

const TWO_REVIEWERS = `
version: 2
name: Review a change twice
roles:
  reviewer: { kind: agent, uses: [reviewer-a, reviewer-b] }
seed: { role: reviewer, title: Review it }
rules: []
`
const TWO_AGENTS = [agent('reviewer-a', ['approve']), agent('reviewer-b', ['approve'])]

test('a pause or the cap holds a trigger run without stopping it, and its release hands held Seats their cards again', async (t) => {
  const rig = await goalRig(t)
  const REVIEW = `
version: 2
name: Review a change
roles:
  reviewer: { kind: agent, uses: reviewer }
seed: { role: reviewer, title: Review it }
rules: []
`
  const run = await rig.startTriggered(REVIEW, [agent('reviewer', ['approve'])])
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => /^(open|order):/.test(one)), ['open:seat-1', 'order:seat-1'])

  // Paused: the Seat's turn is interrupted and ends. The run holds, it does not stall or stop.
  const PAUSED = 'Every trigger is paused. Resume triggers to continue.'
  rig.triggerGate = () => ({ reason: PAUSED, transient: true })
  const session = rig.sessionOf('seat-1')
  await rig.flows.reArm(session.runtime, session.sessionId)
  await rig.flows.flush()
  const held = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(held.state, 'running', 'a pause is not a stop')
  assert.equal(held.reason, null, 'nor a stall a person has to clear')
  assert.equal(held.intake?.dispatchHeld, true)
  assert.equal(held.intake?.heldFor, PAUSED)
  assert.equal(orders(rig.events).length, 1, 'nothing is handed over while held')

  // Resumed: the Seat whose turn ended while held is handed its card again, once.
  rig.triggerGate = null
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  const released = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(released.intake?.dispatchHeld, false)
  assert.equal(released.intake?.heldFor ?? null, null)
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-1'], 'the held card goes back to its Seat')
  // A release with nothing held re-sends nothing.
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.equal(orders(rig.events).length, 2)
})

test('a stop that lands while a round is still seating hands no card over and leaves no turn running', async (t) => {
  const rig = await goalRig(t)
  const STOP = 'Timed out: this Goal reached its time budget.'

  // The stop lands after the first Seat opened, before the second is asked for.
  const early = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  rig.beforeClaim = (n) => { if (n === 1) rig.triggerGate = () => STOP }
  const releasing = rig.flows.resumeTriggered(early.id)
  const stopping = rig.flows.stopRun(early.id, STOP)
  await Promise.all([releasing, stopping])
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-1'], 'no Seat opens after the stop')
  assert.deepEqual(orders(rig.events), [], 'no card is handed over after the stop')
  assert.ok(rig.events.indexOf('interrupt:seat-1') >= 0 && rig.events.indexOf('interrupt:seat-1') < rig.events.indexOf('release:seat-1'), 'its brief turn is interrupted as it is released')
  assert.equal(rig.flows.executionsFor(early.goal)[0]!.state, 'stopped')

  // The stop lands while the second Seat is being opened: it opens, and is handed nothing.
  rig.events.length = 0
  rig.triggerGate = null
  rig.beforeClaim = null
  const late = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  let asked = 0
  let unblock!: () => void
  const blocked = new Promise<void>((resolve) => { unblock = resolve })
  let reachedSecond!: () => void
  const second = new Promise<void>((resolve) => { reachedSecond = resolve })
  rig.seatAsked = () => {
    asked += 1
    // The Goal queue is held before the second opening is queued: it waits for the test.
    if (asked === 2) {
      void rig.goalSerial.run(() => blocked)
      reachedSecond()
    }
  }
  const release2 = rig.flows.resumeTriggered(late.id)
  await second
  rig.triggerGate = () => STOP
  const stop2 = rig.flows.stopRun(late.id, STOP)
  unblock()
  await Promise.all([release2, stop2])
  await rig.flows.flush()
  assert.deepEqual(opens(rig.events), ['open:seat-2', 'open:seat-3'])
  assert.deepEqual(orders(rig.events), [], 'neither Seat is handed its card')
  for (const seat of ['seat-2', 'seat-3']) {
    const interrupted = rig.events.indexOf(`interrupt:${seat}`)
    assert.ok(interrupted >= 0 && interrupted < rig.events.indexOf(`release:${seat}`), `${seat} interrupted as it is released`)
  }
  assert.equal(rig.flows.executionsFor(late.goal)[0]!.state, 'stopped')
})

test('a pause or a stop kills a trigger run’s running check, left for a person and never run again on its own', { timeout: 20_000 }, async (t) => {
  const rig = await goalRig(t)
  const CHECK = `
version: 2
name: Check a change
roles:
  gate: { kind: check, run: "pnpm test", timeout: 600, exits: { "0": pass }, otherwise: fail }
seed: { role: gate, title: Verify }
rules: []
`
  const run = await rig.startTriggered(CHECK, [])
  let started!: () => void
  const running = new Promise<void>((resolve) => { started = resolve })
  rig.checksRunUntilStopped = started
  const releasing = rig.flows.resumeTriggered(run.id)
  await running
  // The run's queue is held by the check: the interruption reaches it without waiting there.
  rig.flows.interruptChecks(run.goal)
  await releasing
  await rig.flows.flush()
  assert.ok(rig.events.includes('check-stopped:pnpm test'), 'the running check was killed')
  const stopped = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(stopped.state, 'stalled')
  assert.match(stopped.reason ?? '', /stopped part-way/)
  assert.equal(stopped.operations.find((one) => one.key === 'check:1:0')?.state, 'uncertain', 'a person decides whether it runs again')
  assert.equal(rig.board(run.goal).intents[0]?.state === 'done', false, 'no outcome is claimed for it')
  // Nothing runs it again on its own.
  rig.checksRunUntilStopped = null
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.equal(rig.events.filter((one) => one === 'check:pnpm test').length, 1)
})

test('a hold set when one Seat’s turn ends interrupts every other Seat still in a turn', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2'])
  // Both at work; then the pause lands, and the first Seat's turn happens to end before any sweep.
  rig.busySeats.add('seat-2')
  rig.triggerGate = () => ({ reason: 'Every trigger is paused. Resume triggers to continue.', transient: true })
  const first = rig.sessionOf('seat-1')
  await rig.flows.reArm(first.runtime, first.sessionId)
  await rig.flows.flush()
  assert.ok(rig.flows.executionsFor(run.goal)[0]!.intake?.heldFor, 'held by the turn that ended')
  assert.ok(rig.events.includes('interrupt:seat-2'), 'the Seat still inside its turn is interrupted, not left working through the pause')
  assert.equal(rig.busySeats.has('seat-2'), false)
  assert.ok(!rig.events.includes('release:seat-2'), 'held, not let go')
})

test('a trigger run that stops waits for the turns it interrupted to end before releasing their Seats, so no release is refused', async (t) => {
  const rig = await goalRig(t)
  rig.turnsEndLater = true
  const run = await rig.startTriggered(TWO_REVIEWERS, TWO_AGENTS)
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  rig.busySeats.add('seat-1')
  rig.busySeats.add('seat-2')
  await rig.flows.stopRun(run.id, 'Timed out: this Goal reached its time budget.')
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => one.startsWith('refused:')), [], 'no release refused for a turn still ending')
  for (const seat of ['seat-1', 'seat-2']) {
    assert.ok(rig.events.indexOf(`interrupt:${seat}`) < rig.events.indexOf(`release:${seat}`), `${seat}: interrupted, then released`)
  }
})

// ------------------------------------------------ an agreed split, enforced (#1015)

const PAIR = `
version: 2
name: Pair build
roles:
  contract: { kind: agent, uses: writer }
  dev: { kind: agent, uses: writer, count: 2, isolate: true }
seed: { role: contract, title: Agree the split }
rules:
  - { id: build, on: contract, when: { every: [done] }, then: { role: dev, title: "Build part {{n}}", split: contract } }
`

test('each card of a split round owns the part of the split its slot was agreed, and both are seated', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  // The agreeing card is told to record the split, and how many parts it needs.
  assert.match(rig.board(run.goal).intents.find((card) => card.id === 1)?.detail ?? '', /complete_claim's split .* "dev" round, one list of path patterns for each of its 2 cards/)

  const said = await rig.team.complete(1, { outcome: 'done', split: [['src/api/**', 'docs/api.md'], ['./src/ui/**']] }, rig.sessionOf('seat-1'))
  assert.match(said, /^Completed #1/)
  await rig.flows.flush()

  const board = rig.board(run.goal)
  assert.deepEqual(board.intents.find((card) => card.id === 2)?.files, ['src/api/**', 'docs/api.md'])
  assert.deepEqual(board.intents.find((card) => card.id === 3)?.files, ['src/ui/**'])
  assert.equal(board.intents.find((card) => card.id === 2)?.claim?.sessionId, rig.sessionOf('seat-2').sessionId)
  assert.equal(board.intents.find((card) => card.id === 3)?.claim?.sessionId, rig.sessionOf('seat-3').sessionId)
  assert.deepEqual(orders(rig.events), ['order:seat-1', 'order:seat-2', 'order:seat-3'])
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'running')
})

test('a split round whose agreeing card recorded no split stops, opening no card and seating nobody', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const now = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(now.state, 'stalled')
  assert.match(now.reason ?? '', /The 2 "dev" cards were not opened: the "contract" round \(card #1\) finished without recording a split of the files, so each card cannot be held to its own files\./)
  assert.match(now.reason ?? '', /the "contract" card has to record its split of the files when it finishes/)
  assert.doesNotMatch(now.reason ?? '', /complete_claim/, 'a person reads this, not a tool name')
  assert.equal(rig.board(run.goal).intents.length, 1, 'no card was opened with a shared list')
  assert.deepEqual(opens(rig.events), ['open:seat-1'])
})

test('a card whose files overlap a live claim is refused by name, and its sibling is not left seated', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  // Somebody else already holds the second part's paths.
  const state = rig.team.stateFor(run.goal)
  rig.team.installProjection({
    ...state,
    intents: [...state.intents, {
      id: 9, title: 'Someone else’s work', state: 'claimed', files: ['src/ui/button.ts'], dependsOn: [], createdAt: 1, updatedAt: 1,
      claim: { runtime: 'alpha' as never, sessionId: 'outsider', at: Date.now() },
    }],
  })
  await rig.team.complete(1, { outcome: 'done', split: [['src/api/**'], ['src/ui/**']] }, rig.sessionOf('seat-1'))
  await rig.flows.flush()

  const now = rig.flows.executionsFor(run.goal)[0]!
  assert.equal(now.state, 'stalled')
  assert.match(now.reason ?? '', /card #\d+ could not be opened: Refused: the files of card #\d+ overlap a live claim — src\/ui\/button\.ts is held by #9/)
  assert.deepEqual(orders(rig.events), ['order:seat-1'], 'no dev Seat was handed its card')
  assert.ok(rig.events.includes('release:seat-2'), 'the sibling already opened is let go')
})

test('two sibling cards whose paths overlap are never both claimed', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  const state = rig.team.stateFor(run.goal)
  const sibling = (id: number, files: string[], holder: string | null) => ({
    id, title: `Part ${id}`, state: holder ? 'claimed' as const : 'open' as const, files, dependsOn: [], createdAt: 1, updatedAt: 1, role: 'dev',
    ...(holder ? { claim: { runtime: 'alpha' as never, sessionId: holder, at: Date.now() } } : {}),
  })
  const intents = [...state.intents, sibling(5, ['src/**'], 'first'), sibling(6, ['src/app.ts'], null)]
  assert.equal(
    rig.team.refuseOverlap(run.goal, intents, 6, 'alpha', 'second'),
    'the files of card #6 overlap a live claim — src/** is held by #5 (a conversation that is not running). Two cards whose paths overlap are never worked at once.',
  )
  assert.equal(rig.team.refuseOverlap(run.goal, intents, 6, 'alpha', 'first'), null, 'its own claim is not a conflict')
})

test('a split whose parts overlap is refused as it is recorded, and the card stays unfinished', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  const said = await rig.team.complete(1, { outcome: 'done', split: [['src/**'], ['src/ui/app.ts']] }, rig.sessionOf('seat-1'))
  assert.match(said, /^Refused: #1 is not finished, because list 1 \(src\/\*\*\) and list 2 \(src\/ui\/app\.ts\) overlap/)
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 1)?.state, 'claimed')
})

test('paths that differ only in case are one folder to the board, as on a case-insensitive volume', async (t) => {
  assert.equal(overlaps('src/UI/**', 'src/ui/button.ts'), true)
  assert.equal(overlaps('Docs/API.md', 'docs/api.md'), true)
  assert.equal(overlaps('src/ui/**', 'src/api/**'), false)
  const rig = await goalRig(t)
  const run = await rig.start(PAIR, [agent('writer', ['done'])])
  await rig.flows.flush()
  const said = await rig.team.complete(1, { outcome: 'done', split: [['src/UI/**'], ['src/ui/**']] }, rig.sessionOf('seat-1'))
  assert.match(said, /^Refused: #1 is not finished, because list 1 \(src\/UI\/\*\*\) and list 2 \(src\/ui\/\*\*\) overlap/)
  assert.equal(rig.board(run.goal).intents.find((card) => card.id === 1)?.state, 'claimed')
})
