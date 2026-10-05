import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RaiseFindingInput } from '@harnessdesk/protocol'

import { sourceDigest } from '../src/flow-execution.js'
import { AGENTS, FIX_AND_REVIEW, findingsRig, SHA1, SHA2 } from './fixtures/findings-rig.js'

/*
 * A Seat's finding commands are bound to the conversation calling, the card
 * it holds and the candidate it was offered — never to a Seat, a revision or
 * an authority the request names. Every write goes through the findings
 * plane's one queue per project, after the run's own journal, and answers
 * only once it is on the disk.
 */

const raiseInput = (intent: number, candidate: string, over: Partial<RaiseFindingInput> = {}): RaiseFindingInput => ({
  intent, candidate, request: 'raise-1', title: 'The retry loop never ends', body: 'Every status retries forever.',
  category: 'ordinary', blocking: true, ...over,
})

test('caller cannot choose its Seat or revision', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const candidate = await f.candidate(review!.id, 'seat-2')
  // Through the Team verb the capability reaches: every key the request may not carry is refused before anything is written.
  for (const extra of [{ seat: 'seat-3' }, { at: SHA2 }, { origin: { seat: 'seat-3' } }, { checkout: '/elsewhere' }, { confirmed: true }, { permission: 'merge' }, { agent: 'security-reviewer' }]) {
    await assert.rejects(
      f.rig.team.raiseFinding({ ...raiseInput(review!.id, candidate.id), ...extra } as never, f.scope('seat-2')),
      /not something a finding takes|cannot name/,
    )
  }
  assert.deepEqual(await f.records(), [], 'nothing was appended')
  // The honest call is attributed to the caller's own Seat, at the candidate's observed revision.
  const view = await f.rig.team.raiseFinding(raiseInput(review!.id, candidate.id), f.scope('seat-2'))
  assert.equal(view.origin.seat, 'seat-2')
  assert.equal(view.origin.at, SHA1)
  assert.equal(view.origin.goal, f.goal)
  assert.equal(view.origin.run, f.run)
  assert.match(view.id, /^finding-/)
  const [record] = await f.records()
  assert.equal(record!.seat, 'seat-2')
  assert.equal(record!.fact.kind === 'finding' ? record!.fact.at : null, SHA1)
})

test('unclaimed and sibling cards cannot write', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [first, second] = f.cards('reviewer')
  const own = await f.candidate(first!.id, 'seat-2')
  const board = JSON.stringify(f.rig.board(f.goal).intents)
  // The sibling names the other reviewer's card, and that card's candidate: not its card, not its candidate.
  await assert.rejects(f.plane.raise(raiseInput(first!.id, own.id), f.scope('seat-3')), /do not hold/)
  // Its own card, with the sibling's candidate id.
  await assert.rejects(f.plane.raise(raiseInput(second!.id, own.id), f.scope('seat-3')), /no longer being offered/)
  // A conversation holding no Seat at all.
  await assert.rejects(f.plane.raise(raiseInput(first!.id, own.id), { runtime: 'alpha', sessionId: 'stranger' }), /no Seat/)
  // The fixer's card is not a review card, and it is finished.
  const [fix] = f.cards('fixer')
  await assert.rejects(f.plane.raise(raiseInput(fix!.id, own.id), f.scope('seat-1')), /do not hold|review card/)
  assert.deepEqual(await f.records(), [])
  assert.equal(JSON.stringify(f.rig.board(f.goal).intents), board, 'the board is unchanged')
})

test('repair cannot confirm itself', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const raised = await f.plane.raise(raiseInput(review!.id, (await f.candidate(review!.id, 'seat-2')).id), f.scope('seat-2'))
  await f.finishReviews('request-changes')
  const [, repairCard] = f.cards('fixer')
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  const repaired = await f.plane.repair({ intent: repairCard!.id, finding: raised.id, request: 'repair-1', expected: 1, note: 'Bounded it.' }, f.scope('seat-4'))
  assert.equal(repaired.lifecycle.state, 'repaired')
  assert.equal(repaired.lifecycle.confirmed, false)
  // The writer asks for a verdict on its own repair: it holds no review card and was offered no candidate.
  await assert.rejects(
    f.plane.decide({ intent: repairCard!.id, candidate: 'anything', finding: raised.id, request: 'decide-1', expected: 2, state: 'repaired', note: 'Done.' }, f.scope('seat-4')),
    /review card|no longer being offered/,
  )
  assert.equal((await f.view(raised.id)).lifecycle.confirmed, false)
  // A dirty or unreadable checkout is no repair to record.
  f.rig.heads.set('/repo', { at: SHA2, dirty: true })
  await assert.rejects(
    f.plane.repair({ intent: repairCard!.id, finding: raised.id, request: 'repair-2', expected: 2, note: 'More.' }, f.scope('seat-4')),
    /Commit the repair before recording it/,
  )
})

test('historical Agent attribution survives fresh review Seat', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const raised = await f.plane.raise(raiseInput(review!.id, (await f.candidate(review!.id, 'seat-2')).id), f.scope('seat-2'))
  await f.finishReviews('request-changes')
  const [, repairCard] = f.cards('fixer')
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  await f.plane.repair({ intent: repairCard!.id, finding: raised.id, request: 'repair-1', expected: 1, note: 'Bounded it.' }, f.scope('seat-4'))
  await f.finishFixer()
  const [, , again, againOther] = f.cards('reviewer')
  // seat-5 is the code reviewer again, seated fresh; seat-6 is another Agent.
  assert.equal(f.rig.seats.get('seat-5')?.agent?.id, 'code-reviewer')
  assert.equal(f.rig.seats.get('seat-6')?.agent?.id, 'security-reviewer')
  const other = await f.candidate(againOther!.id, 'seat-6')
  await assert.rejects(
    f.plane.decide({ intent: againOther!.id, candidate: other.id, finding: raised.id, request: 'decide-x', expected: 2, state: 'repaired', note: 'Looks fixed.' }, f.scope('seat-6')),
    /Only the Agent that raised this finding/,
  )
  const own = await f.candidate(again!.id, 'seat-5')
  const confirmed = await f.plane.decide({ intent: again!.id, candidate: own.id, finding: raised.id, request: 'decide-1', expected: 2, state: 'repaired', note: 'Confirmed at the new head.' }, f.scope('seat-5'))
  assert.equal(confirmed.lifecycle.confirmed, true)
  assert.equal(confirmed.origin.seat, 'seat-2', 'the raiser stays the raiser')
  const records = await f.records()
  assert.deepEqual(records.map((record) => record.seat), ['seat-2', 'seat-4', 'seat-5'], 'each event carries its own actor')
  assert.deepEqual(records.map((record) => (record.fact.kind === 'finding' ? record.fact.at : null)), [SHA1, SHA2, SHA2])
})

/**
 * #1090: `list_findings` (`readForSeat`) marks which findings the calling
 * Seat's Agent raised, and which of those it may decide right now — the only
 * way a brief's "decide the findings you raised" is followable rather than
 * guessed at. `decidableNow` must agree with `decide`'s own refusals exactly,
 * or a Seat is told a finding is decidable and then refused for it.
 */
test('a listing marks a Seat’s own findings, and its raising card or a later fresh Seat as able to withdraw them now', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const raised = await f.plane.raise(raiseInput(review!.id, (await f.candidate(review!.id, 'seat-2')).id), f.scope('seat-2'))
  // The raiser's own card can withdraw a mistake, but cannot confirm a repair.
  const own = await f.plane.readForSeat({ intent: review!.id }, f.scope('seat-2'))
  const ownRow = own.find((one) => one.id === raised.id)!
  assert.equal(ownRow.raisedByYou, true)
  assert.equal(ownRow.decidableNow, true)

  await f.finishReviews('request-changes')
  const [, repairCard] = f.cards('fixer')
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  await f.plane.repair({ intent: repairCard!.id, finding: raised.id, request: 'repair-1', expected: 1, note: 'Bounded it.' }, f.scope('seat-4'))
  await f.finishFixer()
  const [, , again, againOther] = f.cards('reviewer')
  // seat-5 is the code reviewer again (the raiser's own Agent, fresh Seat); seat-6 is another Agent entirely.
  assert.equal(f.rig.seats.get('seat-5')?.agent?.id, 'code-reviewer')
  assert.equal(f.rig.seats.get('seat-6')?.agent?.id, 'security-reviewer')

  const mine = await f.plane.readForSeat({ intent: again!.id }, f.scope('seat-5'))
  const mineRow = mine.find((one) => one.id === raised.id)!
  assert.equal(mineRow.raisedByYou, true, 'the same Agent, even from a fresh Seat, reads this as its own')
  assert.equal(mineRow.decidableNow, true, 'a later review card of a fresh Seat of the raiser may decide it now')

  const theirs = await f.plane.readForSeat({ intent: againOther!.id }, f.scope('seat-6'))
  const theirsRow = theirs.find((one) => one.id === raised.id)!
  assert.equal(theirsRow.raisedByYou, false, 'a different Agent never reads another’s finding as its own')
  assert.equal(theirsRow.decidableNow, false)

  // decidableNow never promises what decide then refuses, and never refuses what decide then allows.
  await assert.rejects(
    f.plane.decide({ intent: againOther!.id, candidate: (await f.candidate(againOther!.id, 'seat-6')).id, finding: raised.id, request: 'decide-x', expected: 2, state: 'repaired', note: 'Looks fixed.' }, f.scope('seat-6')),
    /Only the Agent that raised this finding/,
  )
  const confirmed = await f.plane.decide({ intent: again!.id, candidate: (await f.candidate(again!.id, 'seat-5')).id, finding: raised.id, request: 'decide-1', expected: 2, state: 'repaired', note: 'Confirmed at the new head.' }, f.scope('seat-5'))
  assert.equal(confirmed.lifecycle.confirmed, true)
})

/**
 * #1090: a finding an earlier run on the same Goal raised is left to a
 * person — no Seat may decide it, however fresh. `readForSeat` must say so
 * up front (`personDecides`, `decidableNow: false`) rather than let a fresh
 * Seat of the raising Agent believe it can decide, only to be refused.
 */
test('a finding from a run this Goal already finished is a person’s to decide, not a fresh run’s Seat', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const raised = await f.plane.raise(raiseInput(review!.id, (await f.candidate(review!.id, 'seat-2')).id), f.scope('seat-2'))
  // Run 1 ends — stopped by a person — with the finding still open: no repair, no verdict.
  await f.rig.flows.stopRun(f.run, 'Ending the run for the test.')
  await f.rig.flows.flush()

  // Run 2 starts on the very same Goal: a front-door start that reuses it.
  f.rig.reserve = async () => {}
  const started = await f.rig.flows.startGoal({
    root: '/repo', sentence: 'Finish the change, again', source: FIX_AND_REVIEW, sourcePath: null,
    compiled: f.rig.compile(FIX_AND_REVIEW, AGENTS()), requireHeld: true, goal: { id: f.goal, revision: 0 },
    authorization: { sourceDigest: sourceDigest(FIX_AND_REVIEW), commandDigest: sourceDigest(''), approvedAt: 1, start: 'front-door' },
  })
  assert.equal(started.goal, f.goal, 'the second run lands on the first run’s own Goal')
  assert.notEqual(started.id, f.run, 'a second run, not a continuation of the first')
  await f.rig.flows.flush()

  // Run 2's seed fixer, then its own reviewer round: a fresh Seat of the same Agent (code-reviewer).
  await f.finishFixer()
  const reviewerCards = f.cards('reviewer')
  const review2 = reviewerCards[2]!
  assert.equal(f.rig.seats.get('seat-5')?.agent?.id, 'code-reviewer', 'run 2’s reviewer round opens a fresh Seat of the raising Agent')

  const mine = await f.plane.readForSeat({ intent: review2.id }, f.scope('seat-5'))
  const mineRow = mine.find((one) => one.id === raised.id)!
  assert.equal(mineRow.raisedByYou, true, 'the same Agent, even from another run, reads this as its own')
  assert.equal(mineRow.decidableNow, false, 'a finding an earlier run raised is never decidable now')
  assert.equal(mineRow.personDecides, true, 'left to a person, not any Seat')

  // decide() itself refuses it, for exactly the reason the row already said.
  const candidate2 = await f.candidate(review2.id, 'seat-5')
  await assert.rejects(
    f.plane.decide({ intent: review2.id, candidate: candidate2.id, finding: raised.id, request: 'decide-1', expected: 1, state: 'repaired', note: 'Trying anyway.' }, f.scope('seat-5')),
    /belongs to another run on this Goal/,
  )
})

test('concurrent repairs compare sequences', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const raised = await f.plane.raise(raiseInput(review!.id, (await f.candidate(review!.id, 'seat-2')).id), f.scope('seat-2'))
  await f.finishReviews('request-changes')
  const [, repairCard] = f.cards('fixer')
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  const both = await Promise.allSettled([
    f.plane.repair({ intent: repairCard!.id, finding: raised.id, request: 'repair-a', expected: 1, note: 'First.' }, f.scope('seat-4')),
    f.plane.repair({ intent: repairCard!.id, finding: raised.id, request: 'repair-b', expected: 1, note: 'Second.' }, f.scope('seat-4')),
  ])
  assert.deepEqual(both.map((one) => one.status).sort(), ['fulfilled', 'rejected'])
  const refused = both.find((one) => one.status === 'rejected') as PromiseRejectedResult
  assert.match(String(refused.reason), /changed since you read it/)
  const records = await f.records()
  assert.equal(records.length, 2, 'one raise, one repair: no event lost, none doubled')
  assert.equal((await f.view(raised.id)).sequence, 2)
})

test('reading is bounded to the caller’s own Goal and filtered', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review, sibling] = f.cards('reviewer')
  const candidate = await f.candidate(review!.id, 'seat-2')
  await f.plane.raise(raiseInput(review!.id, candidate.id), f.scope('seat-2'))
  await f.plane.raise(raiseInput(review!.id, candidate.id, { request: 'raise-2', title: 'A nit', blocking: false }), f.scope('seat-2'))
  const all = await f.plane.readForSeat({ intent: review!.id }, f.scope('seat-2'))
  assert.equal(all.length, 2)
  const blocking = await f.plane.readForSeat({ intent: review!.id, filter: 'blocking' }, f.scope('seat-2'))
  assert.deepEqual(blocking.map((one) => one.title), ['The retry loop never ends'])
  await assert.rejects(f.plane.readForSeat({ intent: sibling!.id }, f.scope('seat-2')), /do not hold/)
})

test('a plain conversation and a Goal with no finding commands read and write no findings', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  await f.plane.recover()
  const folders: string[] = await readdir(join(f.rig.dir)).catch(() => [] as string[])
  assert.equal(folders.includes('evidence'), false, 'the evidence store was never created by the findings plane')
})

test('the raising review card can withdraw its own mistaken finding with a durable reason', async (t) => {
  const f = await findingsRig(t)
  await f.finishFixer()
  const [review] = f.cards('reviewer')
  const candidate = await f.candidate(review!.id, 'seat-2')
  const raised = await f.plane.raise(raiseInput(review!.id, candidate.id), f.scope('seat-2'))
  const input = { intent: review!.id, candidate: candidate.id, finding: raised.id, request: 'withdraw-1', expected: 1, state: 'withdrawn' as const, note: 'The retry already has a bound; this finding was mistaken.' }
  await assert.rejects(f.plane.decide({ ...input, note: '  ' }, f.scope('seat-2')), /why it is withdrawn/)
  await assert.rejects(f.plane.decide({ ...input, state: 'repaired' }, f.scope('seat-2')), /later review card/)
  await assert.rejects(f.plane.decide({ ...input, state: 'open' }, f.scope('seat-2')), /later review card/)
  const withdrawn = await f.plane.decide(input, f.scope('seat-2'))
  assert.equal(withdrawn.lifecycle.state, 'withdrawn')
  assert.equal(withdrawn.lifecycle.confirmed, true)
  assert.equal((await f.plane.decide(input, f.scope('seat-2'))).sequence, 2, 'a retry records no second withdrawal')
  const records = await f.records()
  assert.equal(records.length, 2)
  assert.deepEqual(records[1]!.finding!.event, { kind: 'verdict', state: 'withdrawn', note: input.note, by: 'seat' })
  assert.equal(records[1]!.card?.id, review!.id)
  await f.finishReviews('approve')
  await assert.rejects(f.plane.decide({ ...input, request: 'after-close' }, f.scope('seat-2')), /do not hold|open|closed/)
})
