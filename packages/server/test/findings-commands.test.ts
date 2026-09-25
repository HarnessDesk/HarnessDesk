import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RaiseFindingInput } from '@harnessdesk/protocol'

import { findingsRig, SHA1, SHA2 } from './fixtures/findings-rig.js'

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
