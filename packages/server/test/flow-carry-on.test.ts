import assert from 'node:assert/strict'
import { test } from 'node:test'

import { agent, goalRig } from './fixtures/flow-goal-rig.js'

/*
 * Carry-on for a Flow seat (design §9), on the engine directly: which
 * replacement a run refuses, in both directions of `independentOf`; what the
 * run's journal says once a replacement takes the card; and a run at its
 * budget getting no switch at all.
 */

const WRITE_THEN_REVIEW = (reviewers: string) => `
version: 2
name: Write then review
roles:
  author: { kind: agent, uses: writer, seats: [alpha] }
  reviewer: { kind: agent, uses: reviewer, seats: [${reviewers}], independentOf: [author] }
seed: { role: author, title: Write }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review } }
`
const AGENTS = [agent('writer', ['done']), agent('reviewer', ['approve'])]

const providers = (rig: Awaited<ReturnType<typeof goalRig>>) =>
  rig.providers.set('alpha', 'first').set('alpha-two', 'first').set('beta', 'second').set('beta-two', 'second')

test('a reviewer is never carried onto the provider of the work it must be independent of', async (t) => {
  const rig = await goalRig(t)
  providers(rig)
  await rig.start(WRITE_THEN_REVIEW('beta'), AGENTS)
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  const reviewer = rig.sessionOf('seat-2')
  assert.equal(reviewer.runtime, 'beta')

  assert.equal(await rig.flows.refuseSeatTarget(reviewer.runtime, reviewer.sessionId, 'alpha-two'),
    'it shares a provider with the work this seat must be independent of')
  assert.equal(await rig.flows.refuseSeatTarget(reviewer.runtime, reviewer.sessionId, 'gamma'),
    'its provider cannot be read, so its independence cannot be shown')
  assert.equal(await rig.flows.refuseSeatTarget(reviewer.runtime, reviewer.sessionId, 'beta-two'), null)

  const refused = await rig.flows.replaceSeat(reviewer.runtime, reviewer.sessionId, { runtime: 'alpha-two', mode: 'handoff' })
  assert.deepEqual(refused, { refused: 'it shares a provider with the work this seat must be independent of' })
  assert.deepEqual(rig.events.filter((one) => one.startsWith('replace:')), [], 'a refused target is never opened')
})

test('a writer is never carried onto a provider its reviewer reads as, seated or still to come', async (t) => {
  // Still to come: the reviewer's only candidate is beta, so the writer may not take beta's provider.
  const early = await goalRig(t)
  providers(early)
  await early.start(WRITE_THEN_REVIEW('beta'), AGENTS)
  await early.flows.flush()
  const writer = early.sessionOf('seat-1')
  assert.equal(await early.flows.refuseSeatTarget(writer.runtime, writer.sessionId, 'beta-two'),
    'it would leave a later step with no independent provider')
  assert.equal(await early.flows.refuseSeatTarget(writer.runtime, writer.sessionId, 'alpha-two'), null)

  // Seated: the reviewer is on beta, so the writer's Seat may not move to beta-two.
  const late = await goalRig(t)
  providers(late)
  await late.start(WRITE_THEN_REVIEW('beta'), AGENTS)
  await late.flows.flush()
  await late.team.complete(1, { outcome: 'done' }, late.sessionOf('seat-1'))
  await late.flows.flush()
  const finished = late.sessionOf('seat-1')
  assert.equal(await late.flows.refuseSeatTarget(finished.runtime, finished.sessionId, 'beta-two'),
    'it shares a provider with a seat that must be independent of this one')
  assert.equal(await late.flows.refuseSeatTarget(finished.runtime, finished.sessionId, 'alpha-two'), null)
})

test('a replacement Seat takes the card; the run lists both Seats in order and the old one closed at its limit', async (t) => {
  const rig = await goalRig(t)
  providers(rig)
  const started = await rig.start(WRITE_THEN_REVIEW('beta'), AGENTS)
  await rig.flows.flush()
  const old = rig.sessionOf('seat-1')

  const carry = await rig.flows.seatCarry(old.runtime, old.sessionId)
  assert.deepEqual(carry, { blind: false, overBudget: false })

  const opened = await rig.flows.replaceSeat(old.runtime, old.sessionId, { runtime: 'alpha-two', mode: 'handoff' })
  assert.ok(!('refused' in opened))
  assert.equal(String(opened.id), 'seat-2')
  assert.deepEqual(rig.events.filter((one) => one.startsWith('replace:')), ['replace:seat-1->seat-2:handoff'])
  assert.equal(rig.seats.get('seat-1')?.closed?.why, 'limit')

  const run = rig.flows.executionsFor(started.goal)[0]!
  assert.deepEqual(run.rounds[0]!.seats, ['seat-1', 'seat-2'], 'evidence lists the Seat that hit the limit, then its replacement')
  assert.equal(run.state, 'running')
  assert.equal(rig.flows.bindingOf(started.goal, 1)?.session?.runtime, 'alpha-two', 'the card is bound to the replacement')
  assert.equal(await rig.flows.seatCarry(old.runtime, old.sessionId), null, 'the old Seat is no longer carried')

  // The replacement finishing the card advances the run as the original would have.
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-2'))
  await rig.flows.flush()
  assert.equal(rig.sessionOf('seat-3').runtime, 'beta', 'the reviewer is still seated independently of both writers')
})

test('a blind reviewer is carried blind, so its packet leaves out the review context', async (t) => {
  const rig = await goalRig(t)
  providers(rig)
  await rig.start(WRITE_THEN_REVIEW('beta').replace('independentOf: [author] }', 'independentOf: [author], blind: true }'), AGENTS)
  await rig.flows.flush()
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  const reviewer = rig.sessionOf('seat-2')
  assert.deepEqual(await rig.flows.seatCarry(reviewer.runtime, reviewer.sessionId), { blind: true, overBudget: false })
})

test('a run at its budget gets no switch', async (t) => {
  const rig = await goalRig(t)
  providers(rig)
  const run = await rig.startTriggered(WRITE_THEN_REVIEW('beta'), AGENTS)
  await rig.flows.flush()
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  const seat = rig.sessionOf('seat-1')
  assert.deepEqual(await rig.flows.seatCarry(seat.runtime, seat.sessionId), { blind: false, overBudget: false })

  rig.triggerGate = () => 'Run budget reached'
  assert.deepEqual(await rig.flows.seatCarry(seat.runtime, seat.sessionId), { blind: false, overBudget: true })
  assert.deepEqual(await rig.flows.replaceSeat(seat.runtime, seat.sessionId, { runtime: 'alpha-two', mode: 'handoff' }), { refused: 'Run budget reached' })
  assert.deepEqual(rig.events.filter((one) => one.startsWith('replace:')), [])
})

/* Review fix 6: every binding of a later role must still fit, and each choice in a chain counts. */
const TWO_BINDINGS = `
version: 2
name: Write then two reviews
roles:
  author: { kind: agent, uses: writer, seats: [alpha] }
  reviewer: { kind: agent, uses: reviewer, grant: read, seats: [beta, gamma], independentOf: [author] }
seed: { role: author, title: Write }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review } }
`
const CHAIN = `
version: 2
name: Write, review, then audit
roles:
  author: { kind: agent, uses: writer, seats: [alpha] }
  reviewer: { kind: agent, uses: reviewer, independentOf: [author] }
  auditor: { kind: agent, uses: auditor, independentOf: [reviewer] }
seed: { role: author, title: Write }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review } }
  - { id: audit, on: reviewer, when: { every: [approve] }, then: { role: auditor, title: Audit } }
`
const preferring = (entry: ReturnType<typeof agent>, ...runtimes: string[]): ReturnType<typeof agent> =>
  ({ ...entry, definition: { ...entry.definition!, prefer: runtimes.map((runtime) => ({ runtime })) } })

test('a writer may not move where any one binding of a later role loses its provider', async (t) => {
  // The reviewer seats two: one on beta, one on gamma. The gamma one still fitting is not enough.
  const rig = await goalRig(t)
  providers(rig).set('gamma', 'third').set('gamma-two', 'third')
  await rig.start(TWO_BINDINGS, AGENTS)
  await rig.flows.flush()
  const writer = rig.sessionOf('seat-1')
  assert.equal(await rig.flows.refuseSeatTarget(writer.runtime, writer.sessionId, 'beta-two'),
    'it would leave a later step with no independent provider')
  assert.equal(await rig.flows.refuseSeatTarget(writer.runtime, writer.sessionId, 'gamma-two'),
    'it would leave a later step with no independent provider')
  assert.equal(await rig.flows.refuseSeatTarget(writer.runtime, writer.sessionId, 'alpha-two'), null)
})

test('a writer may not move where the provider a later role is forced onto leaves the role after it nothing', async (t) => {
  // The reviewer may take beta or gamma; the auditor, independent of the reviewer, only gamma.
  const rig = await goalRig(t)
  providers(rig).set('gamma', 'third').set('gamma-two', 'third')
  await rig.start(CHAIN, [agent('writer', ['done']), preferring(agent('reviewer', ['approve']), 'beta', 'gamma'), preferring(agent('auditor', ['approve']), 'gamma')])
  await rig.flows.flush()
  const writer = rig.sessionOf('seat-1')
  // On beta's provider, the reviewer can only take gamma, and then the auditor has nothing independent of it.
  assert.equal(await rig.flows.refuseSeatTarget(writer.runtime, writer.sessionId, 'beta-two'),
    'it would leave a later step with no independent provider')
  assert.equal(await rig.flows.refuseSeatTarget(writer.runtime, writer.sessionId, 'alpha-two'), null, 'the reviewer keeps beta, the auditor gamma')
})
