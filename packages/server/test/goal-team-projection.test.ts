import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Intent, RuntimeId, TeamState } from '@harnessdesk/protocol'

import { Team, type TeamPeer, type TeamPort } from '../src/team.js'
import { mergeProjectedIntents } from '../src/team-projection.js'

/*
 * A Goal's board has two writers: the Team engine, which keeps the board in
 * memory and persists it whole, and the Goal plane, which writes a claim or a
 * release straight to the Goal's document and then installs that document
 * back into the Team. Each can be behind the other for the length of one
 * write. Neither may lose what the other wrote: a completion the Team has not
 * saved yet survives an install of an older document, and a snapshot the Team
 * saves never carries an older copy of a card over what the Goal plane wrote.
 */

const peer = (sessionId: string): TeamPeer => ({
  runtime: 'codex' as RuntimeId,
  sessionId,
  title: null,
  cwd: '/repo',
  agent: 'codex',
  busy: false,
  canSteer: false,
  queuedByUser: 0,
  here: true,
})

const rig = async (t: { after(fn: () => Promise<void>): void }) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-goal-projection-'))
  const peers: TeamPeer[] = [peer('worker'), peer('other')]
  /** The Goal document's board, as the host's store holds it. */
  let stored: readonly Intent[] = []
  let gate: Promise<void> | null = null
  let opener: (() => void) | null = null
  let failNext: Error | null = null
  const writes: string[] = []
  const port: TeamPort = {
    peers: () => peers,
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
    canMutateBoard: () => ({ ok: true }),
    // The host's own write, as `#saveTeamProjection` makes it: after whatever holds the Goal's queue.
    mutate: async (state, changed) => {
      if (gate) await gate
      if (failNext) { const error = failNext; failNext = null; throw error }
      stored = mergeProjectedIntents(stored, state.intents, changed)
      writes.push(state.intents.map((one) => `${one.id}:${one.state}`).join(','))
    },
  }
  const team = new Team(dir, port)
  t.after(async () => {
    opener?.()
    team.stopWaiting('test finished')
    await team.flush()
    await rm(dir, { recursive: true, force: true })
  })
  return {
    team,
    writes,
    stored: () => stored,
    failNextWrite: (error: Error) => { failNext = error },
    /** The Goal plane's own write to the document, then its install back into the Team. */
    goalPlaneWrites: (room: string, patch: (intents: readonly Intent[]) => readonly Intent[]) => {
      stored = patch(stored)
      const state: TeamState = { ...team.stateFor(room), intents: [...stored] }
      team.installProjection(state)
    },
    hold: () => {
      let open!: () => void
      gate = new Promise<void>((resolve) => { open = resolve })
      opener = () => { gate = null; open() }
      return opener
    },
  }
}

const scope = (sessionId: string) => ({ runtime: 'codex', sessionId })

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`waited for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a completion not yet saved survives the Goal plane installing an older document, and is what gets saved', async (t) => {
  const { team, stored, goalPlaneWrites, hold } = await rig(t)
  const room = (await team.createRoom('/repo', 'Goal')).id
  await team.joinRoom(room, 'codex' as RuntimeId, 'worker')
  await team.joinRoom(room, 'codex' as RuntimeId, 'other')
  team.addIntentForFlow(room, { title: 'Do the work', role: 'build', dispatch: 'run:1:0' })
  team.setRole(room, 'codex', 'worker', 'build')
  assert.match(await team.claim(1, scope('worker')), /#1/)
  await team.flush()
  assert.equal(stored().find((one) => one.id === 1)?.state, 'claimed')

  // The Goal's queue is busy: the completion is made in memory, and its write waits.
  const release = hold()
  const said = team.complete(1, { note: 'done' }, scope('worker'))
  await until(() => team.stateFor(room).intents.find((one) => one.id === 1)?.state === 'done', 'the completion in memory')

  // Meanwhile the Goal plane releases that Seat's claim from what the document still says, and installs it back.
  goalPlaneWrites(room, (intents) => intents.map((one) => one.id === 1 && one.state === 'claimed'
    ? { ...one, state: 'open' as const, claim: null } : one))
  assert.equal(team.stateFor(room).intents.find((one) => one.id === 1)?.state, 'done', 'the unsaved completion is still what the board shows')

  // And something else on the board moves before the completion's write lands.
  team.setRole(room, 'codex', 'other', 'review')
  release()
  assert.match(await said, /^Completed #1/)
  await team.flush()

  const card = stored().find((one) => one.id === 1)
  assert.equal(card?.state, 'done', 'the completion is what the Goal document keeps')
  assert.equal(card?.claim, null)
  assert.equal(team.stateFor(room).intents.find((one) => one.id === 1)?.state, 'done')
})

test('a snapshot never writes an older copy of a card the Team did not change over what the Goal plane wrote', async (t) => {
  const { team, stored, goalPlaneWrites, hold } = await rig(t)
  const room = (await team.createRoom('/repo', 'Goal')).id
  await team.joinRoom(room, 'codex' as RuntimeId, 'worker')
  team.addIntentForFlow(room, { title: 'First', role: 'build', dispatch: 'run:1:0' })
  team.addIntentForFlow(room, { title: 'Second', role: 'build', dispatch: 'run:1:1' })
  await team.flush()

  // A write of the Team's is waiting on the Goal's queue while the Goal plane claims card #2 directly.
  const release = hold()
  team.setRole(room, 'codex', 'worker', 'build')
  goalPlaneWrites(room, (intents) => intents.map((one) => one.id === 2
    ? { ...one, state: 'claimed' as const, claim: { runtime: 'codex' as RuntimeId, sessionId: 'worker', at: 1 } } : one))
  release()
  await team.flush()
  assert.equal(stored().find((one) => one.id === 2)?.state, 'claimed', 'the claim the Goal plane wrote is kept')
})

test('merging a snapshot keeps the document’s copy of every card the Team did not change', () => {
  const card = (id: number, state: Intent['state']): Intent => ({
    id, title: `#${id}`, detail: null, state, files: [], dependsOn: [], plan: null, role: null, outcome: null,
    claim: null, blockedReason: null, blockedBy: null, handoff: null, note: null, createdAt: 0, updatedAt: 0,
  })
  const stored = [card(1, 'claimed'), card(2, 'open'), card(3, 'done')]
  const snapshot = [card(1, 'done'), card(2, 'blocked'), card(4, 'open')]
  const merged = mergeProjectedIntents(stored, snapshot, new Set([1, 3, 4]))
  // #1 the Team changed; #2 it did not, so the document's copy stands; #3 the Team trimmed; #4 is new.
  assert.deepEqual(merged.map((one) => [one.id, one.state]), [[1, 'done'], [2, 'open'], [4, 'open']])
  // Without a list of changes, the snapshot is the whole board, as before.
  assert.deepEqual(mergeProjectedIntents(stored, snapshot, undefined).map((one) => one.id), [1, 2, 4])
})

test('a completion whose write fails is refused, and the card is left claimed for its holder', async (t) => {
  const { team, stored, failNextWrite } = await rig(t)
  const room = (await team.createRoom('/repo', 'Goal')).id
  await team.joinRoom(room, 'codex' as RuntimeId, 'worker')
  team.addIntentForFlow(room, { title: 'Do the work', role: 'build', dispatch: 'run:1:0' })
  team.setRole(room, 'codex', 'worker', 'build')
  await team.claim(1, scope('worker'))
  await team.flush()
  failNextWrite(new Error('the disk is full'))
  const said = await team.complete(1, {}, scope('worker'))
  assert.match(said, /^Refused: #1 could not be saved, so it is not finished — the disk is full\./)
  const card = team.stateFor(room).intents.find((one) => one.id === 1)
  assert.equal(card?.state, 'claimed')
  assert.equal(card?.claim?.sessionId, 'worker')
  assert.equal(stored().find((one) => one.id === 1)?.state, 'claimed')
  // Finished again once the board can be saved.
  assert.match(await team.complete(1, {}, scope('worker')), /^Completed #1/)
  await team.flush()
  assert.equal(stored().find((one) => one.id === 1)?.state, 'done')
})
