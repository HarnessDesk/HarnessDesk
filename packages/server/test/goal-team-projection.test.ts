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
  let gate: Promise<void> | null = null
  let opener: (() => void) | null = null
  let failNext: Error | null = null
  let failAlways: Error | null = null
  let saves = 0
  let failIn: { n: number; error: Error } | null = null
  const queue = new Queue()
  const save = async (state: TeamState): Promise<void> => {
    if (gate) await gate
    if (failAlways) throw failAlways
    if (failNext) { const error = failNext; failNext = null; throw error }
    if (failIn && --failIn.n === 0) { const error = failIn.error; failIn = null; throw error }
    stored = structuredClone(state.intents)
    saves += 1
  }
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
    // The host's own write: behind whatever holds the Goal's queue, of the board as it is when it runs.
    // A refusal is settled inside the queued task, as the host's is, before any later task of the Goal's queue runs.
    mutate: (snapshot, refused) => queue.run(async () => {
      try {
        await save(snapshot())
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
    /** A task of the Goal's queue, as the Goal plane runs one. */
    inQueue: <T>(work: () => Promise<T>) => queue.run(work),
    saves: () => saves,
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
  r.team.addIntentForFlow(room, { title: 'X', role: 'build', dispatch: 'run:1:0' })
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
  r.team.addIntentForFlow(room, { title: 'Y', role: 'build', dispatch: 'run:1:1' })
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

test('R4: a completion refused because its write failed is never saved by a later write', async (t) => {
  const r = await rig(t)
  const room = await setup(r)
  await r.team.claim(1, scope('worker'))
  await r.team.flush()
  const release = r.hold()
  r.failNextWrite(new Error('EIO'))
  const said = r.team.complete(1, {}, scope('worker'))
  await tick()
  r.team.addIntentForFlow(room, { title: 'Y', role: 'build', dispatch: 'run:1:1' })
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
  for (let n = 0; n < 5; n += 1) r.team.addIntentForFlow(room, { title: `Y${n}`, role: 'build', dispatch: `run:2:${n}` })
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
  r.team.addIntentForFlow(room, { title: 'Y', role: 'build', dispatch: 'run:1:1' })
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
  assert.throws(() => r.team.addIntentForFlow(room, { title: 'Late', role: 'build', dispatch: 'run:9:0' }), /This Goal is wrapping/)
  await assert.rejects(r.team.claim(1, scope('worker')), /This Goal is wrapping/)
  release()
  r.team.addIntentForFlow(room, { title: 'Late', role: 'build', dispatch: 'run:9:0' })
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
  r.team.addIntentForFlow(room, { title: 'Y', role: 'build', dispatch: 'run:1:1' })
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
