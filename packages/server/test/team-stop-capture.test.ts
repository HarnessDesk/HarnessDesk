import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { RuntimeId, TeamState } from '@harnessdesk/protocol'

import { headOf } from '../src/evidence/revision.js'
import { Team, type TeamPeer, type TeamPort } from '../src/team.js'
import { makeRepo, type Repo } from './fixtures/evidence-desk.js'

/*
 * Issue #1035, review round 2: wherever a card's claim clears — released,
 * abandoned, blocked, taken over, a Goal Seat's own release, a Goal wrapped
 * away — the host records where its checkout stood, through the one choke
 * point every one of those goes through (`Team#captureStop`, reached only
 * from `#patchIntent` and `goalPlaneWrite`). Recorded on the card itself
 * (`Intent.until`), in the same board file `StateStore` already persists it
 * in, so it survives a restart. A failed or timed-out read records nothing.
 */

const peer = (sessionId: string, cwd: string): TeamPeer => ({
  runtime: 'fake' as RuntimeId,
  sessionId,
  title: 'Work',
  cwd,
  agent: 'Fake',
  busy: false,
  canSteer: false,
  queuedByUser: 0,
  here: true,
})

interface Rig {
  readonly team: Team
  readonly room: string
  readonly dir: string
  readonly repo: Repo
}

/**
 * A `Team` whose `startOf`/`cwdOf` read a real repository, so a captured stop
 * is a real commit. `mutate` is absent by default — a plain room, saved to
 * its own file the ordinary way, which is what the restart test needs; a
 * test of `goalPlaneWrite` supplies its own, since that path refuses to run
 * at all without one.
 */
const rig = async (
  t: TestContext,
  options: { readonly startOf?: TeamPort['startOf']; readonly mutate?: TeamPort['mutate'] } = {},
): Promise<Rig> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-stop-'))
  const repo = await makeRepo()
  const port: TeamPort = {
    peers: () => [peer('s1', repo.dir)],
    rootOf: async (cwd) => (cwd === repo.dir ? repo.dir : null),
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
    log: () => {},
    cwdOf: () => repo.dir,
    startOf: options.startOf ?? (async (cwd) => {
      const head = await headOf(cwd)
      return { head, upstream: null }
    }),
    ...(options.mutate ? { mutate: options.mutate } : {}),
  }
  const team = new Team(dir, port)
  const room = (await team.createRoom(repo.dir, 'repo')).id
  await team.joinRoom(room, 'fake' as RuntimeId, 's1')
  t.after(async () => {
    await team.flush()
    await rm(dir, { recursive: true, force: true })
  })
  return { team, room, dir, repo }
}

const scope = { runtime: 'fake', sessionId: 's1' }

const untilOf = (team: Team, room: string, id = 1): string | null | undefined =>
  team.stateFor(room).intents.find((intent) => intent.id === id)?.until

test('releasing a claim records where its checkout stood', async (t) => {
  const { team, room, repo } = await rig(t)
  await team.addIntent({ title: 'Do it' }, scope)
  assert.match(await team.claim(1, scope), /^Claimed #1/)
  const head = await headOf(repo.dir)
  await team.release(1, {}, scope)
  await team.awaitStops(room)
  assert.equal(untilOf(team, room), head)
})

test('abandoning a claimed card records where its checkout stood', async (t) => {
  const { team, room, repo } = await rig(t)
  await team.addIntent({ title: 'Do it' }, scope)
  assert.match(await team.claim(1, scope), /^Claimed #1/)
  const head = await headOf(repo.dir)
  await team.intentAction(room, 1, 'abandon')
  await team.awaitStops(room)
  assert.equal(untilOf(team, room), head)
})

test('a referee block on a claimed card records where its checkout stood', async (t) => {
  const { team, room, repo } = await rig(t)
  await team.addIntent({ title: 'Do it' }, scope)
  assert.match(await team.claim(1, scope), /^Claimed #1/)
  const head = await headOf(repo.dir)
  await team.intentAction(room, 1, 'block', 'stop for now')
  await team.awaitStops(room)
  assert.equal(untilOf(team, room), head)
})

test('a Goal Seat’s own release, through goalPlaneWrite, records where its checkout stood', async (t) => {
  const { team, room, repo } = await rig(t, {
    mutate: async (snapshot, refused) => {
      try {
        snapshot()
      } catch (error) {
        refused?.(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })
  await team.addIntent({ title: 'Do it' }, scope)
  assert.match(await team.claim(1, scope), /^Claimed #1/)
  const head = await headOf(repo.dir)
  // What `Host#releaseGoalCard` does: patch the claim to null through the Goal-plane path, never through `#patchIntent` directly.
  const ok = await team.goalPlaneWrite(
    room,
    (intents) => intents.map((intent) => (intent.id === 1 ? { ...intent, state: 'open' as const, claim: null } : intent)),
    async () => {},
  )
  assert.equal(ok, true)
  assert.equal(untilOf(team, room), head)
})

test('a stop recorded before a restart still bounds the diff after it', async (t) => {
  const { team, room, repo, dir } = await rig(t)
  await team.addIntent({ title: 'Do it' }, scope)
  assert.match(await team.claim(1, scope), /^Claimed #1/)
  const head = await headOf(repo.dir)
  await team.release(1, {}, scope)
  await team.awaitStops(room)
  await team.flush()
  assert.equal(untilOf(team, room), head)

  // A fresh `Team` over the same directory, the way a restart makes one.
  const port2: TeamPort = {
    peers: () => [],
    rootOf: async () => repo.dir,
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
    log: () => {},
  }
  const reloaded = new Team(dir, port2)
  await reloaded.load()
  t.after(async () => reloaded.flush())
  assert.equal(untilOf(reloaded, room), head, 'the stop survives a restart, in the same file the card itself is stored in')
})

test('a failed read at the moment a card stops records nothing, never a guess', async (t) => {
  const { team, room } = await rig(t, { startOf: async () => { throw new Error('git is stuck') } })
  await team.addIntent({ title: 'Do it' }, scope)
  assert.match(await team.claim(1, scope), /^Claimed #1/)
  await team.release(1, {}, scope)
  await team.awaitStops(room)
  assert.equal(untilOf(team, room), null, 'cleared to null by the claim, and never set to anything else')
})

test('a read that finds no HEAD at all records nothing either', async (t) => {
  const { team, room } = await rig(t, { startOf: async () => ({ head: null, upstream: null }) })
  await team.addIntent({ title: 'Do it' }, scope)
  assert.match(await team.claim(1, scope), /^Claimed #1/)
  await team.release(1, {}, scope)
  await team.awaitStops(room)
  assert.equal(untilOf(team, room), null)
})

test('a card reclaimed before its stop capture lands is not overwritten by the stale read', async (t) => {
  let calls = 0
  let release!: (value: { head: string | null; upstream: string | null } | null) => void
  const gate = new Promise<{ head: string | null; upstream: string | null } | null>((resolve) => { release = resolve })
  const { team, room, repo } = await rig(t, {
    startOf: async (cwd) => {
      calls += 1
      // The first read is the initial claim's own `since`; the second is the
      // stop capture this test holds open; a third, the reclaim's own
      // `since`, must not be made to wait behind it.
      if (calls === 2) return gate
      return { head: await headOf(cwd), upstream: null }
    },
  })
  await team.addIntent({ title: 'Do it' }, scope)
  assert.match(await team.claim(1, scope), /^Claimed #1/)
  // `release` returns once the board is saved; the stop capture it starts
  // (`startOf` call 2, gated above) is fire-and-forget and is still pending
  // when this `await` resolves — exactly the window this test reclaims in.
  await team.release(1, {}, scope)
  assert.match(await team.claim(1, scope), /^Claimed #1/)
  const staleHead = await headOf(repo.dir)
  release({ head: staleHead, upstream: null })
  await team.awaitStops(room)
  assert.equal(untilOf(team, room), null, 'a live claim measures to HEAD, not to a read that started before it')
})
