import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Team, type TeamPeer, type TeamPort } from '../src/team.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'

/*
 * Issue #1049. A flow card whose role can commit (`edit` and above) finished
 * with `complete_claim` while its written file was still uncommitted and
 * untracked: the round closed as a success, its evidence recorded a zero
 * diff, and the work was left outside every branch and outside the ledger,
 * with nothing telling the person. A round producing nothing but prose is
 * legitimate (`docs/flows.md`'s UC5 proposal round) — the defect is work left
 * uncommitted, not a zero diff by itself.
 *
 * A Goal's checkout is shared by default, and most shipped flows are not
 * isolated, so counting the whole working tree would refuse a card for a
 * person's own untracked file or unrelated leftover work nobody on the card
 * touched. `complete_claim` (and a review that finishes a card the same way)
 * instead compares the checkout's dirty paths now against a snapshot taken
 * the moment the card was claimed (`IntentClaim.dirtyPaths`) and refuses only
 * for a path that is newly dirty since. A person finishing a card by hand is
 * never refused this way at all, since they may have decided the leftovers
 * do not matter.
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

test('a shared checkout already dirty before the claim finishes once the agent commits its own work', async (t) => {
  const rig = await goalRig(t)
  // Pre-existing dirt — a person's own untracked file — already there when the card is claimed.
  rig.heads.set('/repo', { at: 'sha-0', dirty: true, dirtyPaths: ['.env'] })
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  // The agent commits its own work; the pre-existing file is still there, untouched, and still dirty.
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyPaths: ['.env'] })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test("the same checkout with the agent leaving its own new file uncommitted is refused, counting only the agent's", async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'sha-0', dirty: true, dirtyPaths: ['.env'] })
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  // The pre-existing file is still dirty, and the agent leaves one new file of its own uncommitted too.
  rig.heads.set('/repo', { at: 'sha-0', dirty: true, dirtyPaths: ['.env', 'notes.md'] })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^You have 1 uncommitted file from this card's work\. Commit them, then finish again\.$/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'claimed', 'not finished')
})

test('a claim with no dirty-paths snapshot is never refused, however dirty its checkout is now', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  // Simulate a claim recorded before this snapshot existed: strip it from the board directly.
  const state = rig.team.stateFor(run.goal)
  rig.team.installProjection({
    ...state,
    intents: state.intents.map((one) =>
      one.id === 1 && one.claim ? { ...one, claim: { ...one.claim, dirtyPaths: undefined } } : one,
    ),
  })
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyPaths: ['leftover.txt'] })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/, 'a finish with nothing to compare against is never refused for dirt it cannot attribute')
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test('a clean card with no diff — a prose answer — finishes', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test('a read-only card is never refused for a dirty checkout — it could not have committed anything', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_READ, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyPaths: ['a.txt', 'b.txt', 'c.txt'] })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.doesNotMatch(String(answer), /uncommitted/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test("a person's hand-finish is not refused for a dirty checkout", async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyPaths: ['new-work.txt'] })
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

test("a claim's dirty-paths snapshot survives a restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-team-dirty-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const codex = { runtime: 'codex', sessionId: 'c1' }
  const peers: TeamPeer[] = [
    { runtime: 'codex', sessionId: 'c1', title: null, cwd: '/repo', agent: 'Codex', busy: false, canSteer: false, queuedByUser: 0, here: true } as TeamPeer,
  ]
  const port: TeamPort = {
    peers: () => peers,
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
    startOf: async () => ({ head: 'a'.repeat(40), upstream: null, dirtyPaths: ['dirty-a.txt', 'dirty-b.txt'] }),
  }
  const team = new Team(dir, port)
  const room = (await team.createRoom('/repo', 'repo')).id
  await team.joinRoom(room, 'codex' as TeamPeer['runtime'], 'c1')
  await team.addIntent({ title: 'Do it', files: [] }, codex)
  await team.claim(1, codex)
  await team.flush()

  const reborn = new Team(dir, port)
  await reborn.load()
  assert.deepEqual(reborn.stateFor(room).intents[0]?.claim?.dirtyPaths, ['dirty-a.txt', 'dirty-b.txt'])
})
