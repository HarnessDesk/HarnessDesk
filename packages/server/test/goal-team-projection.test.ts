import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Intent, RuntimeId, TeamState } from '@harnessdesk/protocol'

import { Team, type TeamPeer, type TeamPort } from '../src/team.js'

/*
 * A Goal's board has one writer: the Team engine's copy. Its own verbs change
 * that copy and save it; the Goal plane's claims and releases change the same
 * copy (`goalPlaneWrite`) and save it inside the Goal's queue, which they
 * already hold. A save is built when it runs, from the copy as it is then, so
 * what is written is never older than what is shown — and a Goal read back
 * from its document only replaces that copy once the document is final.
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

/** One queue, as the host's Goal queue: a Team save waits behind whatever holds it. */
class Queue {
  #tail: Promise<unknown> = Promise.resolve()
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work)
    this.#tail = next.catch(() => undefined)
    return next
  }
}

const rig = async (t: { after(fn: () => Promise<void>): void }) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-goal-projection-'))
  const peers: TeamPeer[] = [peer('worker'), peer('other')]
  /** The Goal document's board, as the host's store holds it. */
  let stored: readonly Intent[] = []
  let storedState: TeamState | null = null
  let gate: Promise<void> | null = null
  let opener: (() => void) | null = null
  let atGate: (() => void) | null = null
  let failNext: Error | null = null
  let failAlways: Error | null = null
  let saves = 0
  let attempts = 0
  let failIn: { n: number; error: Error } | null = null
  const queue = new Queue()
  const save = async (state: TeamState): Promise<void> => {
    attempts += 1
    if (gate) {
      atGate?.()
      await gate
    }
    if (failAlways) throw failAlways
    if (failNext) { const error = failNext; failNext = null; throw error }
    if (failIn && --failIn.n === 0) { const error = failIn.error; failIn = null; throw error }
    stored = structuredClone(state.intents)
    storedState = structuredClone(state)
    saves += 1
  }
  let sendGate: Promise<void> | null = null
  let sending: (() => void) | null = null
  const port: TeamPort = {
    peers: () => peers,
    rootOf: async () => '/repo',
    send: async () => {
      if (sendGate) {
        sending?.()
        await sendGate
      }
    },
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
    canMutateBoard: () => ({ ok: true }),
    // The host's own write: behind whatever holds the Goal's queue, of the board as it is when it runs.
    // A refusal is settled inside the queued task, as the host's is, before any later task of the Goal's queue runs.
    mutate: (snapshot, refused) => queue.run(async () => {
      try {
        const state = snapshot()
        if (state === null) return
        await save(state)
      } catch (error) {
        refused?.(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    }),
  }
  const team = new Team(dir, port)
  t.after(async () => {
    opener?.()
    failAlways = null
    team.stopWaiting('test finished')
    await team.flush()
    await rm(dir, { recursive: true, force: true })
  })
  return {
    team,
    stored: () => stored,
    /** Every field of the last save that landed. */
    storedState: () => storedState,
    /** A task of the Goal's queue, as the Goal plane runs one. */
    inQueue: <T>(work: () => Promise<T>) => queue.run(work),
    saves: () => saves,
    /** Saves that ran at all, landed or not. */
    attempts: () => attempts,
    /** Resolves once a save is waiting at the gate `hold` closed. */
    held: () => new Promise<void>((resolve) => { atGate = resolve }),
    failNextWrite: (error: Error) => { failNext = error },
    /** Fails the `n`th save to run from now. */
    failWrite: (n: number, error: Error) => { failIn = { n, error } },
    failEveryWrite: (error: Error) => { failAlways = error },
    /** The Goal plane's claim or release: inside the Goal's queue, through the Team's one copy. */
    goalPlane: (room: string, patch: (intents: readonly Intent[]) => readonly Intent[]) =>
      queue.run(() => team.goalPlaneWrite(room, patch, save)),
    /** A Goal read back from its document, as the host installs one; `final` once it can no longer change. */
    install: (room: string, intents: readonly Intent[], final: boolean) =>
      team.installProjection({ ...team.stateFor(room), intents: [...intents] }, undefined, { final }),
    /** Holds every send until `open`; `entered` resolves once one is waiting. */
    holdSends: () => {
      let open!: () => void
      sendGate = new Promise<void>((resolve) => { open = resolve })
      const entered = new Promise<void>((resolve) => { sending = resolve })
      return { entered, open: () => { sendGate = null; open() } }
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
const card = (intents: readonly Intent[], id: number) => intents.find((one) => one.id === id)
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

const setup = async (r: Awaited<ReturnType<typeof rig>>) => {
  const room = (await r.team.createRoom('/repo', 'Goal')).id
  await r.team.joinRoom(room, 'codex' as RuntimeId, 'worker')
  await r.team.joinRoom(room, 'codex' as RuntimeId, 'other')
  r.team.addIntentForFlow(room, { title: 'X', role: 'build', dispatch: 'run:1:0' }, { kind: 'user' })
  r.team.setRole(room, 'codex', 'worker', 'build')
  r.team.setRole(room, 'codex', 'other', 'build')
  await r.team.flush()
  return room
}

const assignTo = (sessionId: string) => (intents: readonly Intent[]): readonly Intent[] => intents.map((one) =>
  one.id === 1 && one.state === 'open'
    ? { ...one, state: 'claimed' as const, claim: { runtime: 'codex' as RuntimeId, sessionId, at: 1, leaseUntil: Date.now() + 1e6 } }
    : one)

test('R1: the same card claimed on both sides ends with exactly one holder, in memory and on disk', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  const release = r.hold()
  const said = r.team.claim(1, scope('worker'))
  await tick()
  // The Goal plane assigns the same card while the Team's write waits: it sees the Team's claim, and takes nothing.
  const assigned = r.goalPlane(room, assignTo('other'))
  release()
  assert.match(await said, /^Claimed #1/)
  await assigned
  await r.team.flush()
  assert.equal(card(r.stored(), 1)?.claim?.sessionId, 'worker')
  assert.equal(card(r.team.stateFor(room).intents, 1)?.claim?.sessionId, 'worker')
})

test('R1: a card the Goal plane claimed is the Team’s too: a Team claim of it is refused, and nothing overwrites it', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.goalPlane(room, assignTo('other'))
  assert.match(await r.team.claim(1, scope('worker')), /^Refused/)
  await r.team.flush()
  assert.equal(card(r.stored(), 1)?.claim?.sessionId, 'other')
  assert.equal(card(r.team.stateFor(room).intents, 1)?.claim?.sessionId, 'other')
})

test('R2: after a failed write, a later write never reverts what the Goal plane wrote in between', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  r.failNextWrite(new Error('EIO'))
  await r.team.release(1, {}, scope('worker'))
  await r.team.flush()
  await r.goalPlane(room, assignTo('other'))
  r.team.addIntentForFlow(room, { title: 'Y', role: 'build', dispatch: 'run:1:1' }, { kind: 'user' })
  await r.team.flush()
  assert.equal(card(r.stored(), 1)?.claim?.sessionId, 'other')
  assert.equal(card(r.team.stateFor(room).intents, 1)?.claim?.sessionId, 'other')
})

test('R3: a board its Goal refuses for good takes the document’s final dispositions', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  r.failEveryWrite(new Error('This Goal is read-only'))
  await r.team.release(1, {}, scope('worker'))
  await r.team.flush()
  const wrapped = r.stored().map((one) => ({ ...one, state: 'abandoned' as const, claim: null }))
  r.install(room, wrapped, true)
  await r.team.flush()
  assert.equal(card(r.team.stateFor(room).intents, 1)?.state, 'abandoned')
})

test('an older document read back while a Team write is queued never replaces the Team’s copy of an open Goal', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  const release = r.hold()
  const said = r.team.complete(1, {}, scope('worker'))
  await tick()
  r.install(room, r.stored(), false)
  assert.equal(card(r.team.stateFor(room).intents, 1)?.state, 'done')
  release()
  assert.match(await said, /^Completed #1/)
  await r.team.flush()
  assert.equal(card(r.stored(), 1)?.state, 'done')
})

/*
 * A completion looks at the card, then waits on its flow's review check —
 * facts and git reads, slow on a loaded machine — before it writes. A Goal
 * read back from its document in that gap (a Seat opening on the same Goal
 * refreshes it) must not leave the completion writing to a copy of the
 * board nobody reads any more: that completion was answered "Completed",
 * saved nowhere, and the card sat claimed with its agent gone.
 */
const reviewCheckHeld = (r: Awaited<ReturnType<typeof rig>>) => {
  let entered!: () => void
  const asked = new Promise<void>((resolve) => { entered = resolve })
  let open!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  r.team.attachFlows({
    completed: () => {},
    refuseOutcome: () => null,
    refuseCompletion: async () => {
      entered()
      await gate
      return null
    },
  } as never)
  return { asked, open }
}

test('a completion whose review check is still running when its Goal is read back is saved, not lost', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  const check = reviewCheckHeld(r)
  const said = r.team.complete(1, {}, scope('worker'))
  await check.asked
  r.install(room, r.stored(), false)
  check.open()
  assert.match(await said, /^Completed #1/)
  await r.team.flush()
  assert.equal(card(r.team.stateFor(room).intents, 1)?.state, 'done', 'the board everyone reads shows it done')
  assert.equal(card(r.stored(), 1)?.state, 'done', 'and what is durable is what the agent was told')
})

test('a completion whose card was taken from it while its review check ran is refused, and changes nothing', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  const check = reviewCheckHeld(r)
  const said = r.team.complete(1, {}, scope('worker'))
  await check.asked
  // The Goal plane releases the card and hands it to another Seat while the check runs.
  await r.goalPlane(room, (intents) => intents.map((one) => (one.id === 1 ? { ...one, state: 'open' as const, claim: null } : one)))
  await r.goalPlane(room, assignTo('other'))
  check.open()
  assert.match(await said, /^Refused: you do not hold #1/)
  await r.team.flush()
  assert.equal(card(r.team.stateFor(room).intents, 1)?.claim?.sessionId, 'other')
  assert.equal(card(r.stored(), 1)?.state, 'claimed')
})

/*
 * #888. The second look after the review check compared only who holds the
 * card. The same conversation letting the card go and taking it again in
 * between is a different claim; the completion was checked against the old one.
 */
test('a completion whose card was let go and claimed again by the same conversation while its check ran is refused', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  const check = reviewCheckHeld(r)
  const said = r.team.complete(1, {}, scope('worker'))
  await check.asked
  await r.goalPlane(room, (intents) => intents.map((one) => (one.id === 1 ? { ...one, state: 'open' as const, claim: null } : one)))
  await r.goalPlane(room, assignTo('worker'))
  check.open()
  assert.match(await said, /^Refused: #1 was let go and claimed again/)
  await r.team.flush()
  assert.equal(card(r.team.stateFor(room).intents, 1)?.state, 'claimed')
  assert.equal(card(r.stored(), 1)?.claim?.at, 1, 'the new claim stands, untouched')
})

/*
 * #888. A legacy flow gives its members roles on the board (`setRole`); Goal
 * Seats carry none. A Goal read back from its document projects the roles of
 * its Seats, and used to wipe every role the board had given.
 */
test('a Goal read back keeps the roles the board gave members whose Seats carry none', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  assert.equal(r.team.roleOf(room, 'codex', 'worker'), 'build')
  // As `GoalPlane.view` projects it: every member, and no Seat role.
  r.team.installProjection({ ...r.team.stateFor(room), roles: {} }, undefined, { final: false })
  assert.equal(r.team.roleOf(room, 'codex', 'worker'), 'build')
  assert.equal(r.team.roleOf(room, 'codex', 'other'), 'build')
  // A Seat's own role still wins, and a member who left keeps none.
  const members = r.team.stateFor(room).members.filter((key) => !key.endsWith('other'))
  r.team.installProjection({ ...r.team.stateFor(room), members, roles: { [members[0]!]: 'review' } }, undefined, { final: false })
  assert.equal(r.team.roleOf(room, 'codex', 'worker'), 'review')
  assert.equal(r.team.roleOf(room, 'codex', 'other'), null)
})

/*
 * #888's missing test. A post, and a handout, hold their board across the
 * send; a Goal read back in that gap must leave what they write afterwards on
 * the board everybody reads, and in what is saved.
 */
test('a post waiting on its send when its Goal is read back is recorded and saved', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  const sends = r.holdSends()
  const posting = r.team.post(room, 'Hello, room')
  await sends.entered
  r.install(room, r.stored(), false)
  sends.open()
  await posting
  await r.team.flush()
  const delivered = (state: TeamState | null) => (state?.channel ?? []).filter((entry) =>
    entry.kind === 'message' && entry.text === 'Hello, room' && entry.state === 'delivered').length
  assert.equal(delivered(r.team.stateFor(room)), 2, 'one delivered row per member, on the board everybody reads')
  assert.equal(delivered(r.storedState()), 2, 'and in what is saved')
})

test('a handout waiting on its sends when its Goal is read back is recorded and saved', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  const sends = r.holdSends()
  const handing = r.team.handout(room, 'Take {{part}}', [
    { runtime: 'codex' as RuntimeId, sessionId: 'worker', vars: { part: 'A' } },
    { runtime: 'codex' as RuntimeId, sessionId: 'other', vars: { part: 'B' } },
  ])
  await sends.entered
  r.install(room, r.stored(), false)
  sends.open()
  const tally = await handing
  await r.team.flush()
  assert.equal(tally.delivered, 2)
  const handed = (state: TeamState | null) => (state?.channel ?? []).filter((entry) =>
    entry.kind === 'message' && entry.state === 'delivered' && entry.text.startsWith('Take ')).map((entry) => entry.kind === 'message' ? entry.text : '').sort()
  assert.deepEqual(handed(r.team.stateFor(room)), ['Take A', 'Take B'])
  assert.deepEqual(handed(r.storedState()), ['Take A', 'Take B'])
})

test('R4: a completion refused because its write failed is never saved by a later write', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  const release = r.hold()
  r.failNextWrite(new Error('EIO'))
  const said = r.team.complete(1, {}, scope('worker'))
  await tick()
  r.team.addIntentForFlow(room, { title: 'Y', role: 'build', dispatch: 'run:1:1' }, { kind: 'user' })
  release()
  assert.match(await said, /^Refused: #1 could not be saved/)
  await r.team.flush()
  assert.equal(card(r.team.stateFor(room).intents, 1)?.state, 'claimed')
  assert.equal(card(r.stored(), 1)?.state, 'claimed', 'what is durable is what the agent was told')
  assert.ok(card(r.stored(), 2), 'the later change is saved')
})

test('a burst of changes is saved in one write, of the board as it is when the write runs', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  const before = r.saves()
  const release = r.hold()
  r.team.setRole(room, 'codex', 'worker', 'review')
  await tick()
  for (let n = 0; n < 5; n += 1) r.team.addIntentForFlow(room, { title: `Y${n}`, role: 'build', dispatch: `run:2:${n}` }, { kind: 'user' })
  release()
  await r.team.flush()
  assert.equal(r.stored().length, 6)
  assert.equal(r.saves() - before, 2, 'the one already running, and one for everything asked for while it ran')
})

test('a person’s done is signalled to its flow only once it is saved, and not at all when it is not', async (t) => {
  const r = await rig(t)
  const signalled: number[] = []
  r.team.attachFlows({ completed: (_room: string, intent: Intent) => { signalled.push(intent.id) }, refuseOutcome: () => null } as never)
  const room = await setup(r)
  const release = r.hold()
  r.team.intentAction(room, 1, 'done')
  await tick()
  assert.deepEqual(signalled, [], 'nothing is signalled before the write lands')
  release()
  await r.team.flush()
  assert.deepEqual(signalled, [1])
  r.team.addIntentForFlow(room, { title: 'Y', role: 'build', dispatch: 'run:1:1' }, { kind: 'user' })
  await r.team.flush()
  r.failNextWrite(new Error('EIO'))
  r.team.intentAction(room, 2, 'abandon')
  await r.team.flush()
  assert.deepEqual(signalled, [1], 'a write that failed signals nothing')
  assert.equal(card(r.team.stateFor(room).intents, 2)?.state, 'open', 'and leaves the card as it was')
})

test('a held board refuses every change with its reason, until it is let go', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  const release = r.team.holdBoard(room, 'This Goal is wrapping.')
  assert.throws(() => r.team.addIntentForFlow(room, { title: 'Late', role: 'build', dispatch: 'run:9:0' }, { kind: 'user' }), /This Goal is wrapping/)
  await assert.rejects(r.team.claim(1, scope('worker')), /This Goal is wrapping/)
  release()
  r.team.addIntentForFlow(room, { title: 'Late', role: 'build', dispatch: 'run:9:0' }, { kind: 'user' })
  await r.team.flush()
  assert.equal(r.stored().length, 2)
})

test('a Goal-plane write that changes nothing saves nothing, and carries nothing of the Team’s', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  const before = r.saves()
  const release = r.hold()
  r.team.setRole(room, 'codex', 'worker', 'review')
  await tick()
  r.team.addIntentForFlow(room, { title: 'Y', role: 'build', dispatch: 'run:1:1' }, { kind: 'user' })
  let saved = 0
  assert.equal(await r.team.goalPlaneWrite(room, (intents) => intents, async () => { saved += 1 }), true)
  assert.equal(saved, 0, 'nothing moved, so nothing is saved')
  release()
  await r.team.flush()
  assert.equal(r.saves() - before, 2, 'the Team’s own saves still ran')
})

test('a Goal-plane write made during an operation saves its change alone, and answers for nothing of the Team’s', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  const release = r.hold()
  r.team.setRole(room, 'codex', 'other', 'review')
  await tick()
  // A completion waits for its turn, and its own save — the second from now — will fail.
  r.failWrite(2, new Error('EIO'))
  const said = r.team.complete(1, {}, scope('worker'))
  await tick()
  // The operation's own write lands first, alone: it must not answer for the completion.
  await r.team.goalPlaneWrite(room, (intents) => intents.map((one) => (one.id === 1 ? { ...one, note: 'released by the wrap' } : one)), async () => {}, { carry: false })
  release()
  assert.match(await said, /^Refused: #1 could not be saved/)
})

/*
 * #881. A Goal-plane write that carries a Team save not yet begun answers it
 * as done once its own save lands, so that save has to have written all of
 * it. Its own queued run is then skipped: run anyway, it could only fail with
 * nobody listening — the carried save was already settled — leaving memory
 * and the file apart with no problem shown.
 */
test('a save a Goal-plane write carries lands whole with it, and its own run is skipped rather than failing unheard', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  const release = r.hold()
  const waiting = r.held()
  // A save in flight, held at the gate: the next change waits its turn behind it.
  r.team.setRole(room, 'codex', 'worker', 'review')
  await waiting
  const before = { saves: r.saves(), attempts: r.attempts() }
  // Not yet begun: this is the save the Goal plane's write will carry.
  r.team.setMessaging(room, false)
  const assigned = r.goalPlane(room, assignTo('other'))
  // Were the carried save to run on its own after all, it would fail.
  r.failWrite(3, new Error('EIO'))
  release()
  assert.equal(await assigned, true)
  await r.team.flush()
  assert.equal(r.attempts() - before.attempts, 1, 'the Goal plane’s alone after the one in flight: the carried save never runs again')
  assert.equal(r.saves() - before.saves, 2, 'the save in flight and the Goal plane’s')
  assert.equal(r.storedState()?.messaging, false, 'what the carried save changed landed with the Goal plane’s write')
  assert.equal(card(r.stored(), 1)?.claim?.sessionId, 'other')
  assert.equal(r.team.stateFor(room).problem, null)
})

test('a change refused because its save failed leaves no line of its own in the channel', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  const lines = () => r.team.stateFor(room).channel.flatMap((entry) => entry.kind === 'signal' ? [`${entry.signal} #${entry.intent}`] : [])
  const before = lines()
  r.failNextWrite(new Error('EIO'))
  assert.match(await r.team.complete(1, {}, scope('worker')), /^Refused/)
  await r.team.flush()
  assert.deepEqual(lines(), before, 'the agent’s completed line goes with its refused change')
  r.failNextWrite(new Error('EIO'))
  r.team.intentAction(room, 1, 'done')
  await r.team.flush()
  assert.deepEqual(lines(), before, 'and the person’s')
  // A change that is saved keeps its line.
  r.team.intentAction(room, 1, 'done')
  await r.team.flush()
  assert.deepEqual(lines(), [...before, 'completed #1'])
})

test('a failed save is put back before the next task of the Goal’s queue can read the board', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  const release = r.hold()
  r.failNextWrite(new Error('EIO'))
  const said = r.team.complete(1, {}, scope('worker'))
  await tick()
  // Queued behind the failing save: what it reads is what is durable.
  const seen = r.inQueue(async () => card(r.team.stateFor(room).intents, 1)?.state)
  release()
  assert.equal(await seen, 'claimed')
  assert.match(await said, /^Refused/)
})
