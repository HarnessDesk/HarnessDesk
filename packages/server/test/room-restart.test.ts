import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SessionGoneError, type Session, type TeamMessage, type TeamPeerInfo, type TeamState } from '@harnessdesk/protocol'

import { Host, Logger, StateStore, serve } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client } from './fixtures/harness.js'

/**
 * A room survives its agent restarting underneath it.
 *
 * An ACP agent is restarted for ordinary reasons — a catalogue refresh when the
 * window comes back into focus, the CLI changing on disk — and the host drops
 * every live handle when its health dips (`detachAll`). The user's own
 * composer never noticed: `Host#liveFor` reopens the conversation on the next
 * message. The room did. Its roster and its delivery both read the *live*
 * peer list, so the first alt-tab back after launch emptied every room on
 * screen — "0 here · Nobody here yet" under a sidebar drawing three members —
 * and a post was refused with "Nothing is live on this board".
 *
 * Found by a recording: three Cursor conversations on three models, one room,
 * one review request, and a rail with nobody on it.
 */
const silent = new Logger('test', { level: 'error', console: false })

/**
 * A run of the app.
 *
 * `stateDir` and `work` can be handed back in, which is how a test spells
 * "the user quit and launched it again": the same state on disk, a fresh
 * host, a fresh agent process, and `history` standing for the conversations
 * the agent kept in its own store across the quit.
 */
const boot = async (
  previous: { stateDir?: string; work?: string; history?: readonly string[] } = {},
) => {
  const stateDir = previous.stateDir ?? (await mkdtemp(join(tmpdir(), 'hd-room-restart-')))
  const work = previous.work ?? (await realpath(await mkdtemp(join(tmpdir(), 'hd-room-restart-work-'))))
  const runtime = new FakeRuntime()
  for (const id of previous.history ?? []) {
    runtime.history.push({
      id: id as unknown as Session['id'],
      runtime: runtime.info.id,
      cwd: work,
      status: { type: 'idle' },
      createdAt: 0,
      updatedAt: 0,
      title: null,
    })
  }
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(runtime)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)
  await client.call('workspace/open', { path: work })
  /* One room per project in these tests, so a second run finds the one the
     first made rather than starting another beside it. */
  const existing = (await client.call('team/rooms', { root: work })) as readonly TeamState[]
  const room =
    existing[0] ??
    ((await client.call('team/room/create', { root: work, name: 'Checkout rewrite' })) as TeamState)
  const member = async (): Promise<string> => {
    const session = (await client.call('session/create', { runtime: 'fake', options: { cwd: work } })) as Session
    await client.call('team/room/join', { room: room.id, runtime: 'fake', sessionId: session.id })
    return String(session.id)
  }
  const peers = async (): Promise<readonly TeamPeerInfo[]> =>
    (await client.call('team/peers', { room: room.id })) as readonly TeamPeerInfo[]
  /* What the adapter's own `#restartIfIdle` looks like from the host: health
     leaves `ready`, the process's sessions are gone, health returns. */
  const restart = (): void => {
    runtime.setHealth({ state: 'starting' })
    runtime.sessions.clear()
    runtime.setHealth({ state: 'ready' })
  }
  const close = async ({ keepFiles = false } = {}): Promise<void> => {
    client.close()
    await server.close()
    await host.dispose()
    if (keepFiles) return
    await rm(stateDir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  }
  return { client, runtime, host, room, member, peers, restart, close, stateDir, work }
}

test('a room keeps its members across an agent restart, and a post still reaches them', async () => {
  const { client, runtime, room, member, peers, restart, close } = await boot()
  try {
    const a = await member()
    const b = await member()
    assert.equal((await peers()).length, 2, 'two members before the restart')

    restart()

    const after = await peers()
    assert.deepEqual(
      after.map((peer) => peer.sessionId).sort(),
      [a, b].sort(),
      'a member detached by the restart is still on the rail',
    )
    assert.ok(after.every((peer) => !peer.busy), 'nothing is in flight after a restart')

    await client.call('team/post', { room: room.id, text: 'Review src/limiter.js and say what you find.' })
    const state = (await client.call('team/state', { room: room.id })) as TeamState
    const posts = state.channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    assert.equal(posts.length, 2, 'one delivery per member, not one refusal for the room')
    assert.deepEqual(
      posts.map((entry) => entry.state),
      ['delivered', 'delivered'],
      posts.map((entry) => entry.reason ?? '').join(' | '),
    )
    assert.equal(runtime.resumes, 2, 'each member was reopened once, by the delivery that needed it')
  } finally {
    await close()
  }
})

/**
 * The other half of listing a detached member: when reopening is never going
 * to work, the member is let go rather than listed forever beside a stream of
 * refusals. "Never" is what the agent said, not the fact of a failure: its
 * own answer that the conversation is gone settles it at once; anything else
 * an agent that is up may say — a timeout, an overload — may pass, so it
 * takes two refusals in a row. An agent that is merely down keeps its
 * members, because it may come back.
 */
test('a member the agent disowns is let go at once, in the agent\'s words', async () => {
  const { client, runtime, room, member, peers, restart, close } = await boot()
  try {
    await member()
    await member()
    restart()
    assert.equal((await peers()).length, 2)

    // The agent is up and says so: the conversation is not there any more.
    runtime.resumeFailure = new SessionGoneError('Session not found')
    await client.call('team/post', { room: room.id, text: 'Anyone there?' })
    runtime.resumeFailure = null
    const state = (await client.call('team/state', { room: room.id })) as TeamState
    const posts = state.channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    assert.equal(posts.length, 2)
    assert.ok(posts.every((entry) => entry.state === 'refused'), 'both refused')
    assert.match(posts[0]?.reason ?? '', /could not reopen .*Session not found/)
    assert.deepEqual(await peers(), [], 'a member no delivery can reach is off the rail')
  } finally {
    await close()
  }
})

test('an agent answering that the id names nothing (JSON-RPC -32602) counts as gone', async () => {
  const { client, runtime, room, member, peers, restart, close } = await boot()
  try {
    await member()
    restart()
    // The shape a bridge's `invalidParams` answer has once the transport has
    // kept its code — what the Claude and Cursor bridges send for an id they
    // have no record of.
    runtime.resumeFailure = Object.assign(new Error('Session not found: x'), { code: -32602 })
    await client.call('team/post', { room: room.id, text: 'Anyone?' })
    runtime.resumeFailure = null
    assert.deepEqual(await peers(), [], 'disowned by the agent itself')
  } finally {
    await close()
  }
})

test('a reopen that merely failed keeps the member until it fails twice in a row', async () => {
  const { client, runtime, room, member, peers, restart, close } = await boot()
  try {
    const kept = await member()
    restart()

    // The agent is up but did not say "gone": a pipe closed, a timeout, an
    // overload. Once may pass.
    runtime.resumeFailure = new Error('the pipe closed before an answer came')
    await client.call('team/post', { room: room.id, text: 'First try.' })
    assert.deepEqual((await peers()).map((peer) => peer.sessionId), [kept], 'one refusal: still listed')

    // It reopens in between: the count starts again.
    runtime.resumeFailure = null
    await client.call('team/post', { room: room.id, text: 'Second try.' })
    let state = (await client.call('team/state', { room: room.id })) as TeamState
    let posts = state.channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    assert.equal(posts.at(-1)?.state, 'delivered', posts.at(-1)?.reason ?? '')

    restart()
    runtime.resumeFailure = new Error('the pipe closed before an answer came')
    await client.call('team/post', { room: room.id, text: 'Third try.' })
    assert.deepEqual((await peers()).map((peer) => peer.sessionId), [kept], 'one refusal after a fresh restart: still listed')
    await client.call('team/post', { room: room.id, text: 'Fourth try.' })
    runtime.resumeFailure = null
    state = (await client.call('team/state', { room: room.id })) as TeamState
    posts = state.channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    assert.match(posts.at(-1)?.reason ?? '', /could not reopen .*pipe closed/)
    assert.deepEqual(await peers(), [], 'two in a row: let go')
  } finally {
    await close()
  }
})

test('a member whose agent is merely down is kept, and answers when it is back', async () => {
  const { client, runtime, room, member, peers, close } = await boot()
  try {
    const waiting = await member()
    runtime.setHealth({ state: 'unavailable', reason: 'crashed', message: 'it fell over' })
    assert.deepEqual((await peers()).map((peer) => peer.sessionId), [waiting], 'detached by the crash, still listed')
    await client.call('team/post', { room: room.id, text: 'Still there?' })
    let state = (await client.call('team/state', { room: room.id })) as TeamState
    let posts = state.channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    assert.match(posts.at(-1)?.reason ?? '', /is not running/)
    assert.deepEqual((await peers()).map((peer) => peer.sessionId), [waiting], 'kept: the agent is down, not the conversation')

    // And it does come back.
    runtime.sessions.clear()
    runtime.setHealth({ state: 'ready' })
    await client.call('team/post', { room: room.id, text: 'Welcome back.' })
    state = (await client.call('team/state', { room: room.id })) as TeamState
    posts = state.channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    assert.equal(posts.at(-1)?.state, 'delivered', posts.at(-1)?.reason ?? '')
  } finally {
    await close()
  }
})

/**
 * Closing a pane is window management, not leaving a room.
 *
 * This used to take the member off the rail for good: `session/close` cleared
 * `detached` so nothing would reopen it, on the reasoning that a conversation
 * the user stopped is not a member. That reasoning cannot survive the roster
 * drawing membership — closing a pane and quitting the desk leave *exactly*
 * the same state behind, no handle and a member still on the board, and only
 * one of them can mean "gone from the room" without the other meaning it too.
 * Making them agree the other way would empty every room at every launch,
 * which is the bug this file exists for.
 *
 * So a closed conversation is a member that is not open: drawn, marked away,
 * and reopened by the next thing addressed to it. Taking somebody out of a
 * room is its own gesture — `team/room/leave`, and the roster's own Remove.
 */
test('closing a conversation leaves it in the room, marked as not open', async () => {
  const { client, room, member, peers, restart, close } = await boot()
  try {
    const kept = await member()
    const closed = await member()
    await client.call('session/close', { runtime: 'fake', sessionId: closed })

    const after = await peers()
    assert.deepEqual(after.map((peer) => peer.sessionId).sort(), [kept, closed].sort(), 'still both members')
    assert.equal(after.find((peer) => peer.sessionId === closed)?.here, false, 'and the closed one says so')
    assert.equal(after.find((peer) => peer.sessionId === kept)?.here, true)

    restart()
    assert.deepEqual((await peers()).map((peer) => peer.sessionId).sort(), [kept, closed].sort())

    // And it is reached, by being reopened, exactly as a detached member is.
    await client.call('team/post', { room: room.id, text: 'Morning.' })
    const state = (await client.call('team/state', { room: room.id })) as TeamState
    const posts = state.channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    assert.deepEqual(posts.slice(-2).map((entry) => entry.state), ['delivered', 'delivered'])
  } finally {
    await close()
  }
})

/**
 * The whole point, end to end: a desk that is quit and launched again.
 *
 * The agents keep their own conversation stores, so after a relaunch every
 * member of every room is a conversation that exists and is not open — the
 * state the host used to have no way to describe. Reported as "history of
 * previous room chats is not stored properly": the history was there and the
 * roster was empty, so the room read as abandoned.
 */
test('a relaunched desk finds its rooms staffed, and the first post reaches them', async () => {
  const first = await boot()
  let ids: string[] = []
  let stateDir: string
  let work: string
  try {
    ids = [await first.member(), await first.member()]
    await first.client.call('team/post', { room: first.room.id, text: 'Kick-off.' })
    stateDir = first.stateDir
    work = first.work
  } finally {
    await first.close({ keepFiles: true })
  }

  // A second run of the app over the same state, in front of an agent whose
  // own store still has both conversations.
  const second = await boot({ stateDir, work, history: ids })
  try {
    const back = await second.peers()
    assert.deepEqual(back.map((peer) => peer.sessionId).sort(), [...ids].sort(), 'both members came back')
    assert.ok(back.every((peer) => !peer.here), 'neither is open — nothing has been opened yet')
    assert.ok(
      back.every((peer) => peer.nickname !== '' && peer.agent === 'Fake Runtime'),
      'and each is drawn by what the board remembered about it',
    )
    const state = (await second.client.call('team/state', { room: second.room.id })) as TeamState
    assert.ok(
      state.channel.some((entry) => entry.kind === 'message'),
      'the chat is where it was',
    )

    await second.client.call('team/post', { room: second.room.id, text: 'Morning — where are we?' })
    const after = (await second.client.call('team/state', { room: second.room.id })) as TeamState
    const posts = after.channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    assert.deepEqual(
      posts.slice(-2).map((entry) => entry.state),
      ['delivered', 'delivered'],
      posts.slice(-2).map((entry) => entry.reason ?? '').join(' | '),
    )
    assert.equal(second.runtime.resumes, 2, 'each was reopened by the delivery that needed it')
    assert.ok((await second.peers()).every((peer) => peer.here), 'and is here afterwards')
  } finally {
    await second.close()
  }
})

/**
 * And the door back in: adding one of the project's stored conversations.
 *
 * The join used to require a conversation the host was already holding, which
 * after a relaunch is none of them — so the "add an agent" dialog offered
 * every conversation in the project and the room refused each one with "There
 * is no fake conversation …", about a conversation plainly on screen.
 */
test('a stored conversation can be added to a room without opening it first', async () => {
  const first = await boot()
  let id: string
  let stateDir: string
  let work: string
  try {
    id = await first.member()
    await first.client.call('team/room/leave', { room: first.room.id, runtime: 'fake', sessionId: id })
    stateDir = first.stateDir
    work = first.work
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await boot({ stateDir, work, history: [id] })
  try {
    assert.deepEqual(await second.peers(), [], 'it starts outside the room')
    await second.client.call('team/room/join', { room: second.room.id, runtime: 'fake', sessionId: id })
    const back = await second.peers()
    assert.deepEqual(back.map((peer) => peer.sessionId), [id])
    assert.equal(back[0]?.here, false, 'a member, and not open — which is what it is')
  } finally {
    await second.close()
  }
})

/**
 * "Two refusals in a row" counts one membership, not two.
 *
 * The host counts failed reopens per member and lets one go after two in a
 * row that an agent which is up produced. Nothing reset that count when the
 * member left the room and came back, and for a member with no record here
 * the count lives in a map keyed by session — so a transient failure, a
 * leave, a rejoin and one more transient failure evicted a member whose two
 * failures belonged to two different stays. Membership moving is the end of
 * the count's meaning, so the engine says when it moves.
 */
test('a refusal from a previous stay does not count towards the next one', async () => {
  const { client, runtime, room, member, peers, restart, close } = await boot()
  try {
    const back = await member()
    restart()

    // One transient failure — an agent that is up, but did not say "gone".
    runtime.resumeFailure = new Error('the pipe closed before an answer came')
    await client.call('team/post', { room: room.id, text: 'First try.' })
    assert.deepEqual((await peers()).map((peer) => peer.sessionId), [back], 'one refusal: still listed')

    // It leaves the room and is put back — a new stay.
    await client.call('team/room/leave', { room: room.id, runtime: 'fake', sessionId: back })
    await client.call('team/room/join', { room: room.id, runtime: 'fake', sessionId: back })

    // And fails once more. Under the old rule this was the second in a row.
    await client.call('team/post', { room: room.id, text: 'Second try.' })
    runtime.resumeFailure = null
    assert.deepEqual(
      (await peers()).map((peer) => peer.sessionId),
      [back],
      'still a member: the two failures were two different stays',
    )
  } finally {
    await close()
  }
})

/**
 * A conversation the agent has lost is not admitted on the strength of our
 * own copy of its transcript.
 *
 * `ctx.sessions.read` falls back to the host's stored transcript when the
 * runtime cannot serve the conversation (`Host#read` → `transcripts.recover`),
 * which is the right answer for *showing* somebody a conversation they can no
 * longer reopen and the wrong one for admitting a member. A member admitted on
 * a transcript is one the first delivery cannot reach — accepted, then dropped
 * — which is the exact outcome this check exists to prevent.
 */
test('a conversation only the host remembers cannot be added to a room', async () => {
  const first = await boot()
  let id: string
  let stateDir: string
  let work: string
  try {
    id = await first.member()
    // A turn, so the host has a transcript of its own to recover from.
    await first.client.call('team/post', { room: first.room.id, text: 'Say something.' })
    await first.client.call('team/room/leave', { room: first.room.id, runtime: 'fake', sessionId: id })
    stateDir = first.stateDir
    work = first.work
  } finally {
    await first.close({ keepFiles: true })
  }

  // The agent's own store no longer has it — `history` is left empty — so a
  // read reaches the host's recovery path rather than the runtime's answer.
  const second = await boot({ stateDir, work })
  try {
    await assert.rejects(
      () => second.client.call('team/room/join', { room: second.room.id, runtime: 'fake', sessionId: id }),
      /There is no fake conversation/,
    )
    assert.deepEqual(await second.peers(), [], 'and nothing was written down')
  } finally {
    await second.close()
  }
})

/**
 * The eviction rule on the desk it was written for.
 *
 * The other eviction tests here restart the *agent*, which leaves the host's
 * own `SessionRecord` in place — so they exercise `record.reopenRefusals` and
 * never the map beside it. A relaunched desk has no record for anybody, which
 * is precisely the state the map exists for and the state every room is in on
 * the first launch of the day. Both halves of the rule are checked on it: an
 * agent that is up and says the conversation is gone settles at once, and one
 * that merely fails takes two in a row.
 */
test('a member of a relaunched desk is let go on the same rule, with no record to count on', async () => {
  const first = await boot()
  let ids: string[] = []
  let stateDir: string
  let work: string
  try {
    ids = [await first.member(), await first.member()]
    stateDir = first.stateDir
    work = first.work
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await boot({ stateDir, work, history: ids })
  try {
    assert.equal((await second.peers()).length, 2, 'both came back as members')

    // Up, and disowning the conversation: settled on the first refusal.
    second.runtime.resumeFailure = new SessionGoneError('Session not found')
    await second.client.call('team/post', { room: second.room.id, text: 'Anyone there?' })
    second.runtime.resumeFailure = null
    assert.deepEqual(await second.peers(), [], 'both let go, with no record between them')

    const state = (await second.client.call('team/state', { room: second.room.id })) as TeamState
    const notices = state.channel.filter((entry) => entry.kind === 'notice')
    assert.equal(notices.length, 2, 'and the room is told about each of them')
    assert.ok(notices.every((entry) => entry.kind === 'notice' && entry.cause === 'gone'))
  } finally {
    await second.close()
  }
})

/** The softer half of the same rule, on the same desk: one failure is not two. */
test('a relaunched desk keeps a member whose reopen merely failed once', async () => {
  const first = await boot()
  let id: string
  let stateDir: string
  let work: string
  try {
    id = await first.member()
    stateDir = first.stateDir
    work = first.work
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await boot({ stateDir, work, history: [id] })
  try {
    second.runtime.resumeFailure = new Error('the pipe closed before an answer came')
    await second.client.call('team/post', { room: second.room.id, text: 'First try.' })
    assert.deepEqual((await second.peers()).map((peer) => peer.sessionId), [id], 'one refusal: kept')

    await second.client.call('team/post', { room: second.room.id, text: 'Second try.' })
    second.runtime.resumeFailure = null
    assert.deepEqual(await second.peers(), [], 'two in a row: let go')
  } finally {
    await second.close()
  }
})

/**
 * A record is not proof; a live handle is.
 *
 * The first answer to this changed the *fallback* — the runtime's own read
 * instead of `ctx.sessions.read` — and left the shortcut in front of it. The
 * registry is consulted first, and `session/read` caches whatever it was
 * given, including a session the host recovered from its own transcript when
 * the agent could not serve one. So opening a conversation the agent has lost
 * left a record behind, and the join took the record as an answer.
 *
 * The path a person actually walks: open it from the sidebar (the read
 * recovers, the resume fails, the pane shows what the host kept), then try to
 * add it to a room. The room must still refuse.
 */
test('a conversation the host recovered, and the agent has lost, is still refused by a join', async () => {
  const first = await boot()
  let id: string
  let stateDir: string
  let work: string
  try {
    id = await first.member()
    // A turn, so the host has a transcript of its own to recover from later.
    await first.client.call('team/post', { room: first.room.id, text: 'Say something.' })
    await first.client.call('team/room/leave', { room: first.room.id, runtime: 'fake', sessionId: id })
    stateDir = first.stateDir
    work = first.work
  } finally {
    await first.close({ keepFiles: true })
  }

  // The agent's store no longer has it: `history` is left empty.
  const second = await boot({ stateDir, work })
  try {
    // Opening it is what seeds the registry with the recovered transcript.
    await second.client.call('session/read', { runtime: 'fake', sessionId: id })
    assert.ok(
      second.host.registry.get('fake' as never, id as never),
      'the host now holds a record for a conversation its agent has lost',
    )

    await assert.rejects(
      () => second.client.call('team/room/join', { room: second.room.id, runtime: 'fake', sessionId: id }),
      /There is no fake conversation/,
      'and the room still refuses it',
    )
    assert.deepEqual(await second.peers(), [])
  } finally {
    await second.close()
  }
})

/**
 * Two posts to one away member reopen it once, not twice.
 *
 * Round two raised the interleaving as untested rather than wrong, and it is
 * worth pinning because the reason it is safe is not local to the room: two
 * deliveries land on `Host#liveFor`, which single-flights a reopen per
 * conversation (`#reattaching`), so the second shares the first's attempt
 * instead of starting a second agent conversation for the same id.
 */
test('two deliveries to the same member that is not open share one reopen', async () => {
  const first = await boot()
  let ids: string[] = []
  let stateDir: string
  let work: string
  try {
    ids = [await first.member()]
    stateDir = first.stateDir
    work = first.work
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await boot({ stateDir, work, history: ids })
  try {
    assert.equal(second.runtime.resumes, 0, 'nothing has been reopened yet')
    // Both in flight before either can settle.
    await Promise.all([
      second.client.call('team/post', { room: second.room.id, text: 'One.' }),
      second.client.call('team/post', { room: second.room.id, text: 'Two.' }),
    ])
    assert.equal(second.runtime.resumes, 1, 'one reopen served both')

    const state = (await second.client.call('team/state', { room: second.room.id })) as TeamState
    const posts = state.channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    assert.equal(posts.length, 2, 'and both messages have a row')
    assert.ok(
      posts.every((entry) => entry.state === 'delivered' || entry.state === 'queued'),
      posts.map((entry) => `${entry.state}: ${entry.reason ?? ''}`).join(' | '),
    )
  } finally {
    await second.close()
  }
})
