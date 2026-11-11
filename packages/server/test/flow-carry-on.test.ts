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

/* Review fix 1: the run's budget and stop are read when a carried send actually goes. */
test('a carried send reads the run’s budget when it goes, and its stop at the boundary', async (t) => {
  const rig = await goalRig(t)
  providers(rig)
  const run = await rig.startTriggered(WRITE_THEN_REVIEW('beta'), AGENTS)
  await rig.flows.flush()
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  const old = rig.sessionOf('seat-1')
  const opened = await rig.flows.replaceSeat(old.runtime, old.sessionId, { runtime: 'alpha-two', mode: 'handoff' })
  assert.ok(!('refused' in opened))
  const next = rig.sessionOf(String(opened.id))
  const admission = rig.flows.carriedAdmission(next.runtime, next.sessionId)!
  await admission.admit()
  admission.assert()

  // Spend lands after the replacement opened and before its packet drains: the packet is refused, the run stalls.
  rig.triggerGate = () => 'Run budget reached'
  await assert.rejects(admission.admit(), /Run budget reached/)
  await rig.flows.flush()
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stalled')
  assert.throws(() => admission.assert(), /no longer handing out work/)
})

test('spend that lands while a replacement is being checked refuses it before anything moves', async (t) => {
  const rig = await goalRig(t)
  providers(rig)
  const run = await rig.startTriggered(WRITE_THEN_REVIEW('beta'), AGENTS)
  await rig.flows.flush()
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  const seat = rig.sessionOf('seat-1')
  let reads = 0
  // The first read passes; the one after the independence checks finds the budget gone.
  rig.triggerGate = () => (++reads > 1 ? 'Run budget reached' : null)
  assert.deepEqual(await rig.flows.replaceSeat(seat.runtime, seat.sessionId, { runtime: 'alpha-two', mode: 'handoff' }), { refused: 'Run budget reached' })
  assert.equal(reads, 2)
  assert.deepEqual(rig.events.filter((one) => one.startsWith('replace:')), [])
  assert.equal(rig.executions.stored(run.id)!.replacing, undefined, 'nothing left journaled')
})

/* Review fix 3: a crash between the claim moving and the run's journal finishing it. */
test('a replacement a restart cut short is finished from the card’s claim, and one that never moved is let go', async (t) => {
  for (const moved of [true, false]) {
    const rig = await goalRig(t)
    providers(rig)
    const started = await rig.start(WRITE_THEN_REVIEW('beta'), AGENTS)
    await rig.flows.flush()
    const old = rig.sessionOf('seat-1')
    if (moved) {
      // The desk dies at the save that would record the replacement: the port has already moved the claim.
      rig.files.dieWhen = (stored) => stored.replaced !== undefined
    } else {
      // The desk dies right after the journal is saved, before the port moved anything.
      const save = rig.files.save.bind(rig.files)
      rig.files.save = async (stored) => { await save(stored); if (stored.replacing) { rig.files.dead = true; throw new Error('(the desk is gone)') } }
    }
    await assert.rejects(rig.flows.replaceSeat(old.runtime, old.sessionId, { runtime: 'alpha-two', mode: 'handoff' }))
    await rig.flows.flush().catch(() => {})
    const id = rig.flows.executionsFor(started.goal)[0]!.id
    const stranded = (await rig.restart()).executions.stored(id)!
    assert.ok(stranded.replacing, 'the restart finds the replacement journaled')
    await rig.flows.resume()
    await rig.flows.flush()
    const run = rig.executions.stored(id)!
    assert.equal(run.replacing, undefined, 'the journal is settled')
    if (moved) {
      assert.deepEqual(run.rounds[0]!.seats, ['seat-1', 'seat-2'])
      assert.deepEqual(run.replaced, { 'seat-2': 'seat-1' })
      assert.equal(rig.flows.bindingOf(started.goal, 1)?.session?.runtime, 'alpha-two', 'the run follows the claim to the new Seat')
      assert.ok(rig.logs.some((one) => one.includes('cut short was finished')))
    } else {
      assert.deepEqual(run.rounds[0]!.seats, ['seat-1'], 'nothing moved, so the run stays on the Seat it had')
      assert.equal(run.replaced, undefined)
    }
  }
})

/* Review fix 4: work handed to the Seat a replacement took over counts as handed to the replacement. */
const BASE_FLOW = `
version: 2
name: Fresh relay
base: { remote: origin }
roles:
  dev: { kind: agent, uses: writer, grant: edit }
  tester: { kind: agent, uses: reader, grant: read }
seed: { role: dev, title: Work }
rules:
  - { id: test, on: dev, then: { role: tester, title: Test } }
`
test('a replacement keeps the work its predecessor was handed, so its advanced HEAD is not refused after a restart', async (t) => {
  const BASE = 'a'.repeat(40)
  const rig = await goalRig(t, { fetchBase: async (_root, base) => ({ ...base, at: BASE }) })
  providers(rig)
  rig.heads.set('/repo/.lanes/1', { at: BASE, dirty: false })
  const started = await rig.start(BASE_FLOW, [agent('writer', ['done']), agent('reader', ['approve'])])
  await rig.flows.flush()
  assert.ok(rig.events.includes('order:seat-1'))
  // The writer committed before its limit: its checkout is past the base now.
  rig.heads.set('/repo/.lanes/1', { at: 'b'.repeat(40), dirty: false })
  const old = rig.sessionOf('seat-1')
  const opened = await rig.flows.replaceSeat(old.runtime, old.sessionId, { runtime: 'alpha-two', mode: 'handoff' })
  assert.ok(!('refused' in opened))
  const run = rig.executions.stored(rig.flows.executionsFor(started.goal)[0]!.id)!
  assert.deepEqual(run.replaced, { 'seat-2': 'seat-1' }, 'the lineage is recorded')
  assert.ok(run.operations.some((one) => one.kind === 'turn' && one.seat === 'seat-1' && one.state === 'finished'), 'the turn history is not rewritten')

  await rig.restart()
  await rig.flows.resume()
  await rig.flows.flush()
  const after = rig.executions.stored(run.id)!
  assert.equal(after.state, 'running', after.reason ?? '')
  assert.ok(!rig.events.includes('release:seat-2'), 'the replacement is not released for a HEAD its predecessor moved')
  assert.ok(rig.events.includes('order:seat-2'), 'and is handed its card again')
})

/* Review fix 5: a seat carry-on holds is never handed back by a restart's own recovery. */
test('a restart leaves a Seat carry-on still holds alone, and re-arms it once carry-on lets go', async (t) => {
  const rig = await goalRig(t)
  providers(rig)
  await rig.start(WRITE_THEN_REVIEW('beta'), AGENTS)
  await rig.flows.flush()
  const seat = rig.sessionOf('seat-1')
  const orders = () => rig.events.filter((one) => one === 'order:seat-1').length
  const before = orders()
  rig.kill('seat-1')
  rig.carryOnHolds = (runtime, sessionId) => runtime === seat.runtime && sessionId === seat.sessionId
  await rig.restart()
  await rig.flows.resume()
  await rig.flows.flush()
  assert.equal(orders(), before, 'asked or waiting for its reset: no re-arm behind carry-on’s back')

  rig.carryOnHolds = null
  await rig.restart()
  await rig.flows.resume()
  await rig.flows.flush()
  assert.ok(orders() > before, 'let go, the Seat’s own recovery runs')
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

/* Round 2, P1: a Seat whose run stopped handing out work while its send was being made gets a closed gate, never none. */
test('a carried Seat whose run stalled meanwhile is refused at its gate, not let through ungated', async (t) => {
  const rig = await goalRig(t)
  providers(rig)
  const run = await rig.startTriggered(WRITE_THEN_REVIEW('beta'), AGENTS)
  await rig.flows.flush()
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  const old = rig.sessionOf('seat-1')
  const opened = await rig.flows.replaceSeat(old.runtime, old.sessionId, { runtime: 'alpha-two', mode: 'handoff' })
  assert.ok(!('refused' in opened))
  const next = rig.sessionOf(String(opened.id))
  // The brief is going out; spend lands, the budget refusal stalls the run while the packet is still being built.
  rig.triggerGate = () => 'Run budget reached'
  await assert.rejects(rig.flows.carriedAdmission(next.runtime, next.sessionId)!.admit(), /Run budget reached/)
  await rig.flows.flush()
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'stalled')
  // The packet is ready now: the gate it asks for is a closed one.
  const late = rig.flows.carriedAdmission(next.runtime, next.sessionId)
  assert.ok(late, 'a Seat of a run that stalled still has a gate')
  await assert.rejects(late.admit(), /no longer handing out work/)
  assert.throws(() => late.assert(), /no longer handing out work/)
  assert.ok(rig.flows.carriedAdmission(old.runtime, old.sessionId), 'and so does the Seat it replaced')
  assert.equal(rig.flows.carriedAdmission('nobody', 'nothing'), null, 'a conversation no run seated has none')
})

/* Round 2, P2: a failure after the lane and the card moved keeps the move, rather than throwing its journal away. */
test('a replacement whose old Seat could not be closed after the card moved is finished, not forgotten', async (t) => {
  const rig = await goalRig(t)
  providers(rig)
  const started = await rig.start(WRITE_THEN_REVIEW('beta'), AGENTS)
  await rig.flows.flush()
  const old = rig.sessionOf('seat-1')
  rig.closeFails = 'The seat moved, but the old one could not be closed: (disk full)'
  const opened = await rig.flows.replaceSeat(old.runtime, old.sessionId, { runtime: 'alpha-two', mode: 'handoff' })
  assert.ok(rig.events.includes('replace-unclosed:seat-1->seat-2'))
  assert.ok(!('refused' in opened), 'the card is already on the replacement: the move is finished from there')
  assert.equal(String(opened.id), 'seat-2')
  const run = rig.executions.stored(rig.flows.executionsFor(started.goal)[0]!.id)!
  assert.equal(run.replacing, undefined, 'the journal is settled by finishing the move')
  assert.deepEqual(run.replaced, { 'seat-2': 'seat-1' })
  assert.deepEqual(run.rounds[0]!.seats, ['seat-1', 'seat-2'])
  assert.equal(rig.flows.bindingOf(started.goal, 1)?.session?.runtime, 'alpha-two', 'the run follows the card')

  // The same failure with nothing moved is still a plain refusal, and leaves nothing journaled.
  const again = await goalRig(t)
  providers(again)
  const second = await again.start(WRITE_THEN_REVIEW('beta'), AGENTS)
  await again.flows.flush()
  const seat = again.sessionOf('seat-1')
  again.refuseReplace = 'This desk is closing.'
  assert.deepEqual(await again.flows.replaceSeat(seat.runtime, seat.sessionId, { runtime: 'alpha-two', mode: 'handoff' }), { refused: 'This desk is closing.' })
  assert.equal(again.executions.stored(again.flows.executionsFor(second.goal)[0]!.id)!.replacing, undefined)
})

test('a replacement cut short after its card moved to a Seat that is gone stalls the run, saying so, after a restart', async (t) => {
  const rig = await goalRig(t)
  providers(rig)
  const started = await rig.start(WRITE_THEN_REVIEW('beta'), AGENTS)
  await rig.flows.flush()
  const old = rig.sessionOf('seat-1')
  // The desk dies at the save that would record the replacement; and the replacement does not survive the restart.
  rig.files.dieWhen = (stored) => stored.replaced !== undefined
  await assert.rejects(rig.flows.replaceSeat(old.runtime, old.sessionId, { runtime: 'alpha-two', mode: 'handoff' }))
  await rig.flows.flush().catch(() => {})
  const id = rig.flows.executionsFor(started.goal)[0]!.id
  await rig.restart()
  rig.seats.set('seat-2', { ...rig.seats.get('seat-2')!, closed: { at: Date.now(), why: 'released' } })
  await rig.flows.resume()
  await rig.flows.flush()
  const run = rig.executions.stored(id)!
  assert.equal(run.replacing, undefined)
  assert.equal(run.state, 'stalled')
  assert.match(run.reason ?? '', /cut short after its work moved to a Seat that is gone/)
})

