import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findingsRig } from './fixtures/findings-rig.js'

/*
 * A review round with several reviewers is blind until it closes: what one
 * reviewer wrote — its finding, its note, its context package, its review —
 * reaches no sibling through any desk read, and nothing crosses the channel
 * into or out of the round. The person sees everything throughout.
 */

const raise = (intent: number, candidate: string, title: string) => ({
  intent, candidate, request: `raise-${title}`, title, body: 'SECRET-BODY', category: 'ordinary' as const, blocking: true,
})

test('first finisher cannot leak through desk reads', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [first, second] = f.cards('reviewer')
  const candidate = await f.candidate(first!.id, 'seat-2')
  const raised = await f.plane.raise(raise(first!.id, candidate.id, 'SECRET-TITLE'), f.scope('seat-2'))
  await f.rig.review.record({ intent: first!.id, candidate: candidate.id, verdict: 'request-changes' }, f.scope('seat-2'))
  await f.rig.team.complete(first!.id, { outcome: 'request-changes', note: 'SECRET-NOTE', handoff: 'SECRET-CONTEXT' }, f.scope('seat-2'))
  await f.rig.flows.flush()
  // The sibling is still reviewing: nothing the first finisher wrote reaches it.
  const board = await f.rig.team.board(f.scope('seat-3'))
  for (const secret of ['SECRET-NOTE', 'SECRET-CONTEXT', `get_context(${first!.id})`, raised.id, 'SECRET-TITLE']) {
    assert.equal(board.includes(secret), false, `the board shows ${secret}`)
  }
  assert.match(await f.rig.team.handoff(first!.id, f.scope('seat-3')), /Refused: .*still open/)
  const listed = await f.plane.readForSeat({ intent: second!.id }, f.scope('seat-3'))
  assert.deepEqual(listed, [], 'the sibling’s finding is not listed')
  const candidates = await f.rig.review.candidates(second!.id, f.scope('seat-3'))
  const offered = JSON.stringify(candidates)
  for (const id of [...raised.evidence, ...(f.rig.facts.get(f.goal) ?? []).filter((one) => one.fact.kind === 'review').map((one) => one.id)]) {
    assert.equal(offered.includes(id), false, 'no sibling review or finding record is offered as evidence')
  }
  // The raiser still reads its own, and the person reads everything.
  assert.deepEqual((await f.plane.readForSeat({ intent: first!.id }, f.scope('seat-2'))).map((one) => one.id), [raised.id])
  assert.equal(f.rig.team.stateFor(f.goal).intents.find((one) => one.id === first!.id)?.note, 'SECRET-NOTE')
  // Once the round closes, everything is released together.
  await f.finishReviews('request-changes')
  const [, fixCard] = f.cards('fixer')
  assert.ok(fixCard)
  const after = await f.rig.team.board(f.scope('seat-4'))
  assert.match(after, /SECRET-NOTE/)
  assert.deepEqual((await f.plane.readForSeat({ intent: fixCard!.id }, f.scope('seat-4'))).map((one) => one.id), [raised.id])
})

test('review embargo holds agent channel too', async (t) => {
  const f = await findingsRig(t, { messaging: 'members' })
  await f.finishFixer()
  const title = (seat: string, name: string): void => {
    const session = f.scope(seat)
    const peer = f.rig.peers.find((one) => one.runtime === session.runtime && one.sessionId === session.sessionId)!
    Object.assign(peer, { title: name })
  }
  title('seat-1', 'fixer-one')
  title('seat-2', 'reviewer-two')
  title('seat-3', 'reviewer-three')
  // Out of the round: a reviewer to its sibling, and to anyone else.
  assert.match(await f.rig.team.send({ to: 'reviewer-three', text: 'I found SECRET-NOTE' }, f.scope('seat-2')), /Refused: your review round is still open and blind/)
  assert.match(await f.rig.team.send({ to: 'fixer-one', text: 'tell reviewer-three SECRET-NOTE' }, f.scope('seat-2')), /Refused: your review round is still open and blind/)
  // Into the round: anyone else forwarding to a reviewer.
  assert.match(await f.rig.team.send({ to: 'reviewer-three', text: 'reviewer-two says SECRET-NOTE' }, f.scope('seat-1')), /Refused: reviewer-three is reviewing in a blind round/)
  const delivered = f.rig.team.stateFor(f.goal).channel.filter((entry) => entry.kind === 'message' && entry.state !== 'refused')
  assert.deepEqual(delivered, [], 'nothing reached anyone')
  // The person still sees every attempt.
  assert.ok(f.rig.team.stateFor(f.goal).channel.some((entry) => entry.kind === 'message' && entry.state === 'refused' && entry.text.includes('SECRET-NOTE')))
})

/** Round 2 raises one finding, round 3 claims its repair, round 4 is the blind re-review: its two cards and Seats. */
const toBlindReReview = async (t: { after(fn: () => Promise<void>): void }) => {
  const { SHA2 } = await import('./fixtures/findings-rig.js')
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const raised = await f.plane.raise(raise(review!.id, (await f.candidate(review!.id, 'seat-2')).id, 'Retry loop'), f.scope('seat-2'))
  await f.finishReviews('request-changes')
  const [, repairCard] = f.cards('fixer')
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  await f.plane.repair({ intent: repairCard!.id, finding: raised.id, request: 'repair-1', expected: 1, note: 'bounded it' }, f.scope('seat-4'))
  await f.finishFixer()
  const [, , mine, sibling] = f.cards('reviewer')
  const seatOf = (card: number): string =>
    String([...f.rig.seats.values()].find((seat) => seat.session.sessionId === f.cards('reviewer').find((one) => one.id === card)?.claim?.sessionId)!.id)
  assert.ok(f.rig.flows.blindRounds(f.goal).length > 0, 'round 4 is blind')
  return { f, raised, repairCard: repairCard!, mine: mine!, sibling: sibling!, mySeat: seatOf(mine!.id), siblingSeat: seatOf(sibling!.id), SHA2 }
}

test('a sibling cannot read another reviewer’s verdict inside an open blind round', async (t) => {
  const { f, raised, mine, sibling, mySeat, siblingSeat } = await toBlindReReview(t)
  const before = await f.plane.readForSeat({ intent: sibling.id }, f.scope(siblingSeat))
  // The raising Agent, re-seated in round 4, withdraws its finding while its sibling is still reviewing.
  const own = await f.candidate(mine.id, mySeat)
  await f.plane.decide({ intent: mine.id, candidate: own.id, finding: raised.id, request: 'd1', expected: 2, state: 'withdrawn', note: 'SECRET-VERDICT' }, f.scope(mySeat))
  assert.ok(f.rig.flows.blindRounds(f.goal).length > 0, 'round 4 is still blind')
  for (const filter of [undefined, 'open', 'blocking'] as const) {
    const listed = await f.plane.readForSeat({ intent: sibling.id, ...(filter ? { filter } : {}) }, f.scope(siblingSeat))
    const row = listed.find((one) => one.id === raised.id)
    const was = before.find((one) => one.id === raised.id)
    if (filter === 'blocking' && !row) continue
    assert.ok(row, `the finding is still listed (${filter ?? 'all'})`)
    assert.deepEqual(row!.lifecycle, was!.lifecycle, 'as it stood before the sibling’s verdict')
    assert.equal(row!.sequence, was!.sequence)
    assert.equal(JSON.stringify(listed).includes('SECRET-VERDICT'), false)
  }
  // The deciding reviewer reads its own verdict; once the round closes, everyone does.
  assert.equal((await f.plane.readForSeat({ intent: mine.id }, f.scope(mySeat))).find((one) => one.id === raised.id)!.lifecycle.state, 'withdrawn')
  await f.finishReviews('approve')
  const [, , fixAgain] = f.cards('fixer')
  if (fixAgain) {
    const holder = String([...f.rig.seats.values()].find((seat) => seat.session.sessionId === fixAgain.claim?.sessionId)!.id)
    assert.equal((await f.plane.readForSeat({ intent: fixAgain.id }, f.scope(holder))).find((one) => one.id === raised.id)!.lifecycle.state, 'withdrawn')
  }
  assert.equal((await f.plane.list({ goal: f.goal })).rows.find((one) => one.id === raised.id)!.lifecycle.state, 'withdrawn', 'the person reads it throughout')
})

test('a finding a sibling raised inside the open blind round, and every later event of it, stays out of a reader’s fold', async (t) => {
  const { f, mine, sibling, mySeat, siblingSeat } = await toBlindReReview(t)
  const theirs = await f.plane.raise(raise(sibling.id, (await f.candidate(sibling.id, siblingSeat)).id, 'SECRET-NEW'), f.scope(siblingSeat))
  const listed = await f.plane.readForSeat({ intent: mine.id }, f.scope(mySeat))
  assert.equal(listed.some((one) => one.id === theirs.id), false)
  assert.equal(JSON.stringify(listed).includes('SECRET-NEW'), false)
})

test('the repair packet read during an open blind round carries no event a holder recorded in it', async (t) => {
  const { f, raised, mine, mySeat, repairCard, SHA2 } = await toBlindReReview(t)
  await f.plane.decide({ intent: mine.id, candidate: (await f.candidate(mine.id, mySeat)).id, finding: raised.id, request: 'd1', expected: 2, state: 'withdrawn', note: 'SECRET-VERDICT' }, f.scope(mySeat))
  const packet = await f.plane.packetFor(f.run, 99, 'reviewer', [{ card: repairCard.id, round: 3, checkout: { cwd: '/repo', branch: null }, at: SHA2 }])
  assert.ok(packet)
  assert.equal(packet!.text.includes('SECRET-VERDICT'), false)
  assert.match(packet!.text, new RegExp(`${raised.id} · repair claimed, not yet confirmed`), 'the finding reads as it stood before the blind verdict')
})

test('a blind-round holder cannot open a channel through add_intent, other work, a blocked card’s reason or an inherited context package', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [first] = f.cards('reviewer')
  // add_intent: refused, and nothing is added.
  const before = f.rig.team.stateFor(f.goal).intents.length
  const added = await f.rig.team.addIntent({ title: 'SECRET-TITLE from reviewer two', detail: 'SECRET-DETAIL' }, f.scope('seat-2'))
  assert.match(added, /^Refused: your review round is still open and blind/)
  assert.equal(f.rig.team.stateFor(f.goal).intents.length, before, 'no card was added')
  for (const read of [await f.rig.team.board(f.scope('seat-3')), await f.rig.team.status(f.scope('seat-3'))]) {
    assert.equal(read.includes('SECRET'), false, 'list_intents and get_team_status carry nothing')
  }
  // Other work: a card outside the round would carry its note to every member, so a blind holder takes none.
  assert.match(await f.rig.team.addIntent({ title: 'Follow up', dependsOn: [first!.id] }, f.scope('seat-1')), /^Added intent/)
  const follow = f.rig.team.stateFor(f.goal).intents.at(-1)!
  const c1 = await f.candidate(first!.id, 'seat-2')
  await f.rig.review.record({ intent: first!.id, candidate: c1.id, verdict: 'request-changes' }, f.scope('seat-2'))
  await f.rig.team.complete(first!.id, { outcome: 'request-changes', handoff: 'SECRET-CONTEXT' }, f.scope('seat-2'))
  await f.rig.flows.flush()
  assert.match(await f.rig.team.claim(follow.id, f.scope('seat-3')), /^Refused: your review round is still open and blind/)
  assert.match(await f.rig.team.claimNext(f.scope('seat-2')), /^Refused: your review round is still open and blind/)
  // Anyone outside the round who takes it is handed nothing the round holds yet.
  const claimed = await f.rig.team.claim(follow.id, f.scope('seat-1'))
  assert.match(claimed, /^Claimed #/)
  assert.equal(claimed.includes('SECRET-CONTEXT'), false, 'claiming it hands down nothing from the blind round')
  // A reviewer blocking its own round card by hand: the card is bound to its Seat, so a claim by anyone else is refused before its reason is read.
  const [, second] = f.cards('reviewer')
  await f.rig.team.release(second!.id, { blocked: true, reason: 'SECRET-BLOCK' }, f.scope('seat-3'))
  const refused = await f.rig.team.claim(second!.id, f.scope('seat-1'))
  assert.match(refused, /belongs to another Seat of this flow/)
  assert.equal(refused.includes('SECRET-BLOCK'), false)
})

test('a refused verdict answers a sibling the same before and after the raiser’s blind verdict', async (t) => {
  const { f, raised, mine, sibling, mySeat, siblingSeat } = await toBlindReReview(t)
  const probe = async (label: string): Promise<string> => {
    const offered = await f.candidate(sibling.id, siblingSeat)
    return f.plane.decide({ intent: sibling.id, candidate: offered.id, finding: raised.id, request: `probe-${label}`, expected: 2, state: 'open', note: 'n' }, f.scope(siblingSeat))
      .then(() => 'recorded', (error: Error) => error.message)
  }
  const before = await probe('before')
  await f.plane.decide({ intent: mine.id, candidate: (await f.candidate(mine.id, mySeat)).id, finding: raised.id, request: 'd1', expected: 2, state: 'withdrawn', note: 'SECRET' }, f.scope(mySeat))
  assert.ok(f.rig.flows.blindRounds(f.goal).length > 0, 'round 4 is still blind')
  const after = await probe('after')
  assert.match(before, /Only the Agent that raised this finding/)
  assert.equal(after, before, 'the refusal says nothing about what the raiser recorded in the round')
})

test('a finding a sibling raised in the open blind round cannot be found by naming it as related', async (t) => {
  const { f, mine, sibling, mySeat, siblingSeat } = await toBlindReReview(t)
  const theirs = await f.plane.raise(raise(sibling.id, (await f.candidate(sibling.id, siblingSeat)).id, 'Hidden one'), f.scope(siblingSeat))
  const offered = await f.candidate(mine.id, mySeat)
  const relate = (related: string, token: string) => f.plane.raise({ ...raise(mine.id, offered.id, `Link ${token}`), request: `link-${token}`, related }, f.scope(mySeat))
    .then(() => 'recorded', (error: Error) => error.message)
  const unknown = await relate(`finding-${'f'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, 'unknown')
  const hidden = await relate(theirs.id, 'hidden')
  assert.match(unknown, /The related finding is not one on this Goal/)
  assert.equal(hidden, unknown, 'a sibling’s unreleased finding reads exactly as one that does not exist')
})
