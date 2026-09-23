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
