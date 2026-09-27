import assert from 'node:assert/strict'
import { test } from 'node:test'

import { agent, goalRig } from './fixtures/flow-goal-rig.js'

/*
 * Issue #1049. A flow card whose role can commit (`edit` and above) finished
 * with `complete_claim` while its written file was still uncommitted and
 * untracked: the round closed as a success, its evidence recorded a zero
 * diff, and the work was left outside every branch and outside the ledger,
 * with nothing telling the person. A round producing nothing but prose is
 * legitimate (`docs/flows.md`'s UC5 proposal round) — the defect is work left
 * uncommitted, not a zero diff by itself. So `complete_claim` (and a review
 * that finishes a card the same way) refuses a card whose Seat may commit and
 * whose checkout still holds changes never committed; a person finishing a
 * card by hand is not refused, since they may have decided the leftovers do
 * not matter.
 */

const WRITER_EDIT = `
version: 2
name: One writer
roles:
  author: { kind: agent, uses: writer, grant: edit }
seed: { role: author, title: Write something }
rules: []
`

const WRITER_READ = `
version: 2
name: One reader
roles:
  author: { kind: agent, uses: writer, grant: read }
seed: { role: author, title: Look something up }
rules: []
`

test('an edit-grant card with an untracked file is refused, naming the count', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyFiles: 2 })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /Your checkout has uncommitted changes \(2 files\)\./)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'claimed', 'not finished')
})

test('the same card, after committing, finishes', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyFiles: 1 })
  const refused = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(refused), /uncommitted changes/)
  // The agent commits what it left lying around; its checkout is clean now.
  rig.heads.set('/repo', { at: 'sha-2', dirty: false, dirtyFiles: 0 })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test('a clean card with no diff — a prose answer — finishes', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-1', dirty: false, dirtyFiles: 0 })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test('a read-only card is never refused for a dirty checkout — it could not have committed anything', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_READ, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyFiles: 5 })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.doesNotMatch(String(answer), /uncommitted/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test("a person's hand-finish is not refused for a dirty checkout", async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyFiles: 3 })
  await rig.team.intentAction(run.goal, 1, 'done', undefined, 'done')
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test('a failed dirty read does not block the finish', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.headOfFails.add('/repo')
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
  assert.ok(rig.logs.some((line) => /checkout could not be read/.test(line)), 'the failed read is logged')
})
