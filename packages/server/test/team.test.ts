import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  AGENT_MESSAGE_NOTICE,
  sessionKey,
  splitContext,
  type RuntimeId,
  type TeamMessage,
  type TeamNotice,
  type TeamState,
} from '@harnessdesk/protocol'

import { Team, type TeamPeer, type TeamPort, roomCap } from '../src/team.js'

/**
 * The team plane, against a fake host port.
 *
 * Two properties carry the whole feature and the tests hold both. The board
 * must be *transactional*: a claim refused is refused with the reason, and
 * two claimants can never both win. The channel must be *safe*: a message is
 * attributed and quarantined, its delivery state is always recorded, the
 * user's own queue outranks it, and every loop guard actually refuses.
 */

interface Rig {
  readonly team: Team
  readonly port: {
    peers: TeamPeer[]
    sent: { runtime: string; sessionId: string; text: string }[]
    steered: { runtime: string; sessionId: string; text: string }[]
    changed: TeamState[]
    removed: string[]
    /** Conversations the engine said had joined or left a room, in order. */
    moved: string[]
    audited: { kind: string; decision?: string }[]
    /** When set, sends park on it — for racing two deliveries against each other. */
    gate: Promise<void> | null
    /** Sends that throw before landing, counted down — a flaky backend. */
    failSends: number
  }
  readonly dir: string
}

const peer = (over: Partial<TeamPeer> & { sessionId: string }): TeamPeer => ({
  runtime: 'codex' as RuntimeId,
  title: over.sessionId,
  cwd: '/repo',
  agent: 'Codex',
  busy: false,
  canSteer: false,
  queuedByUser: 0,
  // Anything the *host* hands the engine is open, by construction. The rooms
  // mint the away kind themselves, out of what the board remembers.
  here: true,
  ...over,
})

const rig = async (t: { after(fn: () => Promise<void>): void }): Promise<Rig & { room: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-'))
  const port: Rig['port'] = {
    peers: [],
    sent: [],
    steered: [],
    changed: [],
    removed: [],
    moved: [],
    audited: [],
    gate: null,
    failSends: 0,
  }
  const teamPort: TeamPort = {
    peers: () => port.peers,
    // The fake resolves like the host: the workspace containing the folder.
    rootOf: async (cwd) => (cwd === '/repo' || cwd.startsWith('/repo/') ? '/repo' : null),
    send: async (runtime, sessionId, text) => {
      if (port.gate) await port.gate
      if (port.failSends > 0) {
        port.failSends -= 1
        throw new Error('backend hiccup')
      }
      port.sent.push({ runtime, sessionId, text })
    },
    steer: async (runtime, sessionId, text) => {
      port.steered.push({ runtime, sessionId, text })
    },
    changed: (state) => port.changed.push(state),
    removed: (room) => port.removed.push(room),
    membershipChanged: (runtime, sessionId) => port.moved.push(`${runtime}/${sessionId}`),
    audit: (entry) =>
      port.audited.push({ kind: entry.kind, ...(entry.decision ? { decision: entry.decision } : {}) }),
  }
  const team = new Team(dir, teamPort)
  /* A project holds as many rooms as the work wants, and a board belongs to
     one — so every test that needs a board starts by making a room, the way a
     person does. `room` is its id; the folder alone no longer addresses
     anything. */
  const room = (await team.createRoom('/repo', 'repo')).id
  // Flush before removing: the write chain is serialised, and a teardown
  // racing it would recreate files under the directory being removed.
  t.after(async () => {
    await team.flush()
    await rm(dir, { recursive: true, force: true })
  })
  return { team, port, dir, room }
}

const codex = { runtime: 'codex', sessionId: 'c1' }
const claude = { runtime: 'claude', sessionId: 'k1' }

/**
 * Everyone currently live, put in the room.
 *
 * Being open in the folder used to be enough to share a board. A project holds
 * several rooms now and each has its own, so membership is explicit — and a
 * test that sets `port.peers` has said who is *running*, not who is in the
 * room. This says the second part.
 */
const joinAll = async (team: Team, room: string, port: Rig['port']): Promise<void> => {
  for (const one of port.peers) await team.joinRoom(room, one.runtime, one.sessionId)
}

const twoAgents = async (port: Rig['port'], team?: Team, room?: string): Promise<void> => {
  port.peers = [
    peer({ sessionId: 'c1', title: 'API migration' }),
    peer({ sessionId: 'k1', runtime: 'claude' as RuntimeId, title: 'Auth refactor', agent: 'Claude Code' }),
  ]
  // Live is not the same as in the room any more. Both, for the tests that
  // were written when being open in the folder was enough.
  if (team && room) await joinAll(team, room, port)
}

test('a claim is a transaction: the second claimant is refused, and told by whom', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Migrate auth callers', files: ['src/api/**'] }, codex)

  assert.match(await team.claim(1, codex), /^Claimed #1/)
  const refused = await team.claim(1, claude)
  // Named the way the room names the holder — the same word the card, the
  // rail and every signal use. This used to read `Codex — “API migration”`,
  // and `Codex — “(untitled)”` for the first minutes of any conversation,
  // while the card beside it said something else entirely. And the age reads
  // as an age: it said "just now ago" for anything under a minute.
  assert.match(refused, /^Refused: #1 is already claimed by Codex \(just now\)\.$/)
})

test('files are ownership: overlapping work is refused while the claim lives', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'API work', files: ['src/api/**'] }, codex)
  await team.addIntent({ title: 'Fixture change', files: ['src/api/fixtures/one.json'] }, claude)
  await team.claim(1, codex)

  const refused = await team.claim(2, claude)
  assert.match(refused, /^Refused: the files of #2 overlap a live claim/)
  assert.match(refused, /held by #1/)

  // check_conflicts answers the same question before any claim is attempted.
  const conflicts = await team.conflicts(['src/api/routes.ts'], claude)
  assert.match(conflicts, /^Conflicts:/)
  assert.match(await team.conflicts(['docs/**'], claude), /^No live claim overlaps/)

  // Completion frees the files.
  await team.complete(1, {}, codex)
  assert.match(await team.claim(2, claude), /^Claimed #2/)
})

test('dependencies gate claiming, and completing the dependency unblocks', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Endpoint' }, codex)
  await team.addIntent({ title: 'iOS side', dependsOn: [1] }, codex)

  assert.match(await team.claim(2, claude), /^Refused: #2 depends on #1/)

  await team.claim(1, codex)
  const done = await team.complete(1, { handoff: 'POST /devices returns {expiresAt}' }, codex)
  assert.match(done, /That unblocked #2\./)

  // The context package reaches whoever works the dependent intent.
  assert.match(await team.handoff(1, claude), /POST \/devices returns \{expiresAt\}/)
  assert.match(await team.claim(2, claude), /^Claimed #2/)
})

test('only the holder completes, and the user always outranks a claim', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Work' }, codex)
  await team.claim(1, codex)

  assert.match(await team.complete(1, {}, claude), /^Refused: you do not hold #1/)

  // The person takes the claim away from the panel; the agent's next
  // complete is refused because it no longer holds anything.
  team.intentAction(room, 1, 'release')
  assert.match(await team.complete(1, {}, codex), /^Refused: you do not hold #1/)
  assert.equal(team.stateFor(room).intents[0]?.state, 'open')
})

/**
 * Stopping work was an agent-only verb, and that was a gap rather than a rule.
 *
 * `release(blocked)` takes a reason and belongs to whoever holds the claim, so
 * a person who knew a job should not be worked had only `abandon` — which says
 * something else, and says it permanently. The referee can stop work now, and
 * it stops the same way an agent's does: `blockedBy: 'hand'`, so finishing a
 * dependency never silently restarts it.
 */
test('the user can stop work, and the claim goes with it', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Work' }, codex)
  await team.claim(1, codex)

  team.intentAction(room, 1, 'block', '  waiting on the rename  ')
  const stopped = team.stateFor(room).intents[0]
  assert.equal(stopped?.state, 'blocked')
  assert.equal(stopped?.blockedBy, 'hand')
  // Trimmed, because a reason is read on a card and leading space is not one.
  assert.equal(stopped?.blockedReason, 'waiting on the rename')
  // An agent cannot be left holding a job it has been told not to do.
  assert.equal(stopped?.claim ?? null, null)
  assert.match(await team.complete(1, {}, codex), /^Refused: you do not hold #1/)

  // The channel carries it, so somebody reading the room learns why.
  const signal = team.stateFor(room).channel.at(-1)
  assert.equal(signal?.kind, 'signal')
  assert.equal(signal?.kind === 'signal' ? signal.signal : null, 'blocked')

  // And a deliberate stop is only undone deliberately.
  team.intentAction(room, 1, 'reopen')
  assert.equal(team.stateFor(room).intents[0]?.state, 'open')
  assert.equal(team.stateFor(room).intents[0]?.blockedReason ?? null, null)
})

test('a stop with nothing said still says who stopped it', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Work' }, codex)

  team.intentAction(room, 1, 'block', '   ')
  assert.equal(team.stateFor(room).intents[0]?.blockedReason ?? null, null)
  const signal = team.stateFor(room).channel.at(-1)
  assert.equal(signal?.kind === 'signal' ? signal.detail : null, 'stopped by you')
})

test('a board survives a restart, because it was persisted on every change', async (t) => {
  const { team, port, dir, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Durable work', files: ['src/**'] }, codex)
  await team.claim(1, codex)
  await team.flush()

  const teamPort: TeamPort = {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const reborn = new Team(dir, teamPort)
  await reborn.load()
  const state = reborn.stateFor(room)
  assert.equal(state.intents.length, 1)
  assert.equal(state.intents[0]?.state, 'claimed')
  assert.equal(state.intents[0]?.claim?.sessionId, 'c1')
  assert.ok(state.channel.length >= 2, 'the signals came back too')
})

/**
 * The whole of what a person quitting the desk should cost a room: nothing.
 *
 * The bug this pins was reported as "history of previous room chats is not
 * stored properly", and the history was fine — the *roster* was empty. Rooms
 * drew only the conversations the desk had open, a freshly launched desk has
 * none, so every room came back reading "0 here · Nobody here yet" over a
 * channel full of what its members had said, refused the first post with
 * "Nothing is live on this board", and could not be re-staffed because
 * joining wanted a conversation the host was already holding.
 *
 * Membership is persisted and the roster draws it; being open is a separate
 * fact the row carries. A post reopens whoever it is addressed to, exactly as
 * the user's own composer already reopened a conversation whose agent had
 * restarted underneath it.
 */
test('a room comes back with its members, its names and its chat after the desk is quit', async (t) => {
  const { team, port, dir, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'c1', title: 'API migration', model: 'gpt-5.4-mini' }),
    peer({
      sessionId: 'k1',
      runtime: 'claude' as RuntimeId,
      title: 'Auth refactor',
      agent: 'Claude Code',
      model: 'claude-opus-5',
    }),
  ]
  await joinAll(team, room, port)
  await team.post(room, 'Kick-off: split the checkout rewrite.')
  const before = await team.peersFor(room)
  assert.deepEqual(before.map((one) => one.nickname), ['GPT', 'Opus'])
  await team.flush()

  // The desk is quit and launched again: the boards are read off disk and
  // nothing at all is open.
  const sent: { runtime: string; sessionId: string; text: string }[] = []
  const reborn = new Team(dir, {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async (runtime, sessionId, text) => {
      sent.push({ runtime, sessionId, text })
    },
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  })
  await reborn.load()

  const after = await reborn.peersFor(room)
  assert.deepEqual(
    after.map((one) => `${one.nickname} ${one.agent} ${one.here ? 'here' : 'away'}`),
    ['GPT Codex away', 'Opus Claude Code away'],
    'both members are drawn, by the names and agents the board remembered',
  )
  assert.deepEqual(after.map((one) => one.model), ['gpt-5.4-mini', 'claude-opus-5'])
  assert.ok(
    reborn.stateFor(room).channel.some((entry) => entry.kind === 'message'),
    'and the chat is where it was',
  )

  // And the first post of the new day reaches them both.
  await reborn.post(room, 'Morning — where are we?')
  assert.deepEqual(
    sent.map((one) => one.sessionId).sort(),
    ['c1', 'k1'],
    'a post to a member that is not open reopens it and lands',
  )
  const last = reborn
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    .slice(-2)
  assert.deepEqual(last.map((one) => one.state), ['delivered', 'delivered'])
  // See the note in the test below: flushed here, not in a hook that would
  // race the rig's own directory removal.
  await reborn.flush()
})

/**
 * A board written before the roster existed has members and no photographs.
 *
 * Such a room draws each member as soon as it is seen once, which is what
 * opening the conversation does — so this pins the *shape* of the fallback
 * rather than a promise the old file cannot keep: nothing is invented, and
 * nothing throws.
 */
test('a member the board has no photograph of is left out rather than drawn blank', async (t) => {
  const { team, port, dir, room } = await rig(t)
  port.peers = [peer({ sessionId: 'c1', title: 'API migration', model: 'gpt-5.4-mini' })]
  await joinAll(team, room, port)
  await team.flush()

  // The file as an older desk wrote it: members, no roster.
  const file = join(dir, `${encodeURIComponent(room)}.json`)
  const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  delete stored['roster']
  await writeFile(file, JSON.stringify(stored))

  const reborn = new Team(dir, {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  })
  await reborn.load()
  assert.deepEqual(await reborn.peersFor(room), [])
  assert.deepEqual(
    reborn.stateFor(room).members.length,
    1,
    'the membership is untouched — it is the drawing that has to wait',
  )
  /* Flushed here rather than in an `after` hook: the rig's own cleanup
     removes the directory, and a second `Team` still holding a queued write
     races it — the rm succeeds and the write puts the file back, which is an
     ENOTEMPTY on the way out and a mystery to whoever hits it next. */
  await reborn.flush()
})

test('a message to an idle peer is delivered now, attributed and quarantined', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  const result = await team.send(
    { to: 'Auth refactor', text: 'verifyToken moved to src/auth/verify.ts' },
    codex,
  )
  // The room name it can be addressed by, and the conversation's own name.
  assert.match(result, /^Delivered to Claude Code \(“Auth refactor”\)/)
  assert.equal(port.sent.length, 1)

  // What actually entered the receiver's context: the envelope, with the
  // sender named in the label and the quarantine sentence inside the body.
  const envelope = port.sent[0]?.text ?? ''
  const { injections } = splitContext(envelope)
  assert.equal(injections.length, 1)
  assert.equal(injections[0]?.label, 'Message from Codex — “API migration”')
  assert.ok(injections[0]?.text.includes(AGENT_MESSAGE_NOTICE))

  // And the channel row records the exact same envelope for the ⓘ.
  const entry = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage => candidate.kind === 'message',
  )
  assert.equal(entry?.state, 'delivered')
  assert.equal(entry?.envelope, envelope)
})

test('a busy peer queues; the turn ending delivers; the user’s own queue outranks', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: true, queuedByUser: 1 } : entry,
  )

  const result = await team.send({ to: 'Auth refactor', text: 'heads up' }, codex)
  assert.match(result, /^Queued:/)
  assert.equal(port.sent.length, 0)

  // Turn ends, but the user still has a message waiting: theirs goes first,
  // so the agent's stays queued.
  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: false } : entry,
  )
  await team.onTurnEnded('claude' as RuntimeId, 'k1')
  assert.equal(port.sent.length, 0)

  // The user's queue drained; now it lands.
  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, queuedByUser: 0 } : entry,
  )
  await team.onTurnEnded('claude' as RuntimeId, 'k1')
  assert.equal(port.sent.length, 1)
  const entry = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage => candidate.kind === 'message',
  )
  assert.equal(entry?.state, 'delivered')
})

test('wake steers a running turn where the runtime can, and queues where it cannot', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'c1', title: 'API migration' }),
    peer({ sessionId: 'c2', title: 'Steerable', busy: true, canSteer: true }),
    peer({
      sessionId: 'k1',
      runtime: 'claude' as RuntimeId,
      title: 'Not steerable',
      agent: 'Claude Code',
      busy: true,
      canSteer: false,
    }),
  ]
  await joinAll(team, room, port)

  assert.match(
    await team.send({ to: 'Steerable', text: 'now', wake: true }, codex),
    /running turn/,
  )
  assert.equal(port.steered.length, 1)

  assert.match(
    await team.send({ to: 'Not steerable', text: 'now', wake: true }, codex),
    /^Queued: .*cannot take input mid-turn/,
  )
  assert.equal(port.steered.length, 1)
})

test('the loop guards refuse: repeats, the rate limit, and a full queue', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  assert.match(await team.send({ to: 'Auth refactor', text: 'same words' }, codex), /^Delivered/)
  assert.match(
    await team.send({ to: 'Auth refactor', text: 'same words' }, codex),
    /^Refused: you already sent exactly this message/,
  )

  for (let n = 0; n < 3; n += 1) {
    assert.match(await team.send({ to: 'Auth refactor', text: `note ${n}` }, codex), /^Delivered/)
  }
  assert.match(
    await team.send({ to: 'Auth refactor', text: 'one more' }, codex),
    /^Refused: rate limit/,
  )
})

test('inbound control: refuse refuses, hold parks it for the person to release', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  team.setInbound('claude', 'k1', 'refuse')
  assert.match(
    await team.send({ to: 'Auth refactor', text: 'anything' }, codex),
    /^Refused: that conversation refuses/,
  )

  team.setInbound('claude', 'k1', 'hold')
  assert.match(await team.send({ to: 'Auth refactor', text: 'held words' }, codex), /^Held:/)
  assert.equal(port.sent.length, 0)

  const held = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage =>
      candidate.kind === 'message' && candidate.state === 'held',
  )
  assert.ok(held, 'the held row is visible to the person')
  await team.deliverHeld(room, held.id)
  assert.equal(port.sent.length, 1)
})

test('names resolve exactly or not at all: ambiguity and strangers are refused', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'c1', title: 'API migration' }),
    peer({ sessionId: 'a2', title: 'Auth part one' }),
    peer({ sessionId: 'a3', title: 'Auth part two' }),
  ]
  await joinAll(team, room, port)

  assert.match(
    await team.send({ to: 'auth', text: 'hello' }, codex),
    /^Refused: “auth” matches 2 conversations/,
  )
  const stranger = await team.send({ to: 'nobody here', text: 'hello' }, codex)
  assert.match(stranger, /^Refused: no conversation in this room is named/)
  assert.match(stranger, /In this room:/)
})

test('an untitled conversation is addressable, and a second of the same is too', async (t) => {
  // ACP conversations are born untitled — the title is the agent's to give —
  // so the name a person has for one is the agent: "the Claude Code
  // conversation". That used to resolve while there was exactly one, and dead-
  // end the moment there were two: "matches 2 conversations, name one exactly"
  // when neither had a name to give. The nickname closes that: the agent's name
  // is now *held* by the first, and the second is numbered, so both are
  // reachable and the roster shows which is which.
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'c1', title: 'API migration' }),
    peer({ sessionId: 'k1', runtime: 'claude' as RuntimeId, title: null, agent: 'Claude Code' }),
  ]
  await joinAll(team, room, port)

  assert.match(await team.send({ to: 'Claude Code', text: 'hello' }, codex), /^Delivered/)

  port.peers = [
    ...port.peers,
    peer({ sessionId: 'k2', runtime: 'claude' as RuntimeId, title: null, agent: 'Claude Code' }),
  ]
  await joinAll(team, room, port)
  const roster = await team.peersFor(room)
  assert.deepEqual(
    roster.filter((entry) => entry.agent === 'Claude Code').map((entry) => entry.nickname),
    ['Claude Code', 'Claude Code 2'],
  )

  // Both are now reachable by a name that means exactly one of them.
  port.sent.length = 0
  assert.match(await team.send({ to: 'claude code 2', text: 'again' }, codex), /^Delivered/)
  assert.equal(port.sent[0]?.sessionId, 'k2')
})

test('board-only mode stops messages and says who can turn them back on', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  team.setMessaging(room, false)

  assert.match(
    await team.send({ to: 'Auth refactor', text: 'psst' }, codex),
    /^Refused: this board is in board-only mode/,
  )
  // Claims still work: board-only means quieter, not weaker.
  await team.addIntent({ title: 'Still works' }, codex)
  assert.match(await team.claim(1, codex), /^Claimed #1/)
})

test('the two ways a call can be unattributable get two different refusals', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  // Never attributed: the call arrived with no caller at all. Permanent for
  // that runtime, and not something the agent can do anything about.
  await assert.rejects(() => team.board({}), /carries no caller token/)
  await assert.rejects(() => team.board({}), /will not change by retrying/)

  // Attributed, but not on the board: transient, and the agent fixes it by
  // taking a turn.
  await assert.rejects(
    () => team.claim(1, { runtime: 'codex', sessionId: 'ghost' }),
    /not attached to its agent/,
  )
  await assert.rejects(
    () => team.claim(1, { runtime: 'codex', sessionId: 'ghost' }),
    /joins when it takes a turn/,
  )

  // They must not converge back into one sentence. Both used to say "try again
  // from a normal turn", which is true of one of them and is the exact advice
  // that had already failed twice for the other — an hour of a live run went
  // into working that out from the outside.
  const unattributed = await team.board({}).catch((error: Error) => error.message)
  const notLive = await team
    .claim(1, { runtime: 'codex', sessionId: 'ghost' })
    .catch((error: Error) => error.message)
  assert.notEqual(unattributed, notLive)
})

test('the user posts as themselves: no envelope, no quarantine', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  await team.post(room, 'don’t touch the tests, I’m rewriting them')
  // Broadcast to everyone live on the board, verbatim.
  assert.equal(port.sent.length, 2)
  assert.equal(port.sent[0]?.text, 'don’t touch the tests, I’m rewriting them')
  assert.ok(!port.sent[0]?.text.includes('<context'))
})

test('a closed conversation refuses what waited on it, never drops it', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: true } : entry,
  )
  await team.send({ to: 'Auth refactor', text: 'waiting' }, codex)

  port.peers = port.peers.filter((entry) => entry.sessionId !== 'k1')
  team.onSessionClosed('claude' as RuntimeId, 'k1')

  const entry = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage => candidate.kind === 'message',
  )
  assert.equal(entry?.state, 'refused')
  assert.match(entry?.reason ?? '', /closed before the message was read/)
})

// ------------------------------------------------------ the review's lessons

test('two nudges for one turn end deliver one message, not two', async (t) => {
  // `turn/completed` and the trailing idle status both nudge for one turn.
  // Before the single-flight drain, each shifted its own pending message and
  // started its own turn on the receiver.
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: true } : entry,
  )
  await team.send({ to: 'Auth refactor', text: 'first' }, codex)
  await team.send({ to: 'Auth refactor', text: 'second' }, codex)

  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: false } : entry,
  )
  let release: () => void = () => {}
  port.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = team.onTurnEnded('claude' as RuntimeId, 'k1')
  const second = team.onTurnEnded('claude' as RuntimeId, 'k1')
  release()
  await Promise.all([first, second])

  assert.equal(port.sent.length, 1, 'one turn end, one delivery')
  port.gate = null
  // The turn that delivery started ends; the second message goes now.
  await team.onTurnEnded('claude' as RuntimeId, 'k1')
  assert.equal(port.sent.length, 2)
})

test('a held message cannot be released twice, from any number of windows', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  team.setInbound('claude', 'k1', 'hold')
  await team.send({ to: 'Auth refactor', text: 'held words' }, codex)
  const held = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage =>
      candidate.kind === 'message' && candidate.state === 'held',
  )
  assert.ok(held)

  let release: () => void = () => {}
  port.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const releasing = team.deliverHeld(room, held.id)
  // The second window clicks while the first release is in flight.
  await assert.rejects(() => team.deliverHeld(room, held.id), /already being released/)
  release()
  port.gate = null
  await releasing
  assert.equal(port.sent.length, 1)
  // And once it has landed, the row is no longer held at all.
  await assert.rejects(() => team.deliverHeld(room, held.id), /not waiting to be released/)
})

test('trimming the channel never evicts a queued or held message', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  team.setInbound('claude', 'k1', 'hold')
  await team.send({ to: 'Auth refactor', text: 'keep me' }, codex)

  // Hundreds of later signals: far more than the channel keeps.
  for (let n = 0; n < 260; n += 1) {
    team.addIntentAsUser(room, { title: `noise ${n}` })
  }
  const held = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage =>
      candidate.kind === 'message' && candidate.state === 'held',
  )
  assert.ok(held, 'the held row survived the trim')
  await team.deliverHeld(room, held.id)
  assert.equal(port.sent.length, 1)
})

test('a failed send is refused with the error and does not poison the guards', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  port.failSends = 1

  const failed = await team.send({ to: 'Auth refactor', text: 'flaky words' }, codex)
  assert.match(failed, /^Refused: sending failed — backend hiccup/)
  const entry = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage => candidate.kind === 'message',
  )
  assert.equal(entry?.state, 'refused')

  // The identical text, retried after the transient failure, is allowed:
  // repeat suppression records what was accepted, not what was attempted.
  assert.match(await team.send({ to: 'Auth refactor', text: 'flaky words' }, codex), /^Delivered/)
})

test('a user broadcast survives one recipient failing, and says which one', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  port.failSends = 1

  await team.post(room, 'to everyone')
  assert.equal(port.sent.length, 1, 'the second recipient still got it')
  const rows = team
    .stateFor(room)
    .channel.filter((candidate): candidate is TeamMessage => candidate.kind === 'message')
  assert.equal(rows.length, 2)
  assert.equal(rows.filter((row) => row.state === 'delivered').length, 1)
  const refused = rows.find((row) => row.state === 'refused')
  assert.match(refused?.reason ?? '', /Sending failed: backend hiccup/)
})

test('a persistence failure is a sentence on the state, not a silent catch', async (t) => {
  const { dir } = await rig(t)
  // A directory that cannot exist: its parent is a plain file.
  const { writeFile: write } = await import('node:fs/promises')
  const blocker = join(dir, 'blocker')
  await write(blocker, 'a file where a directory must go')
  const port: TeamPort = {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const doomed = new Team(join(blocker, 'team'), port)
  const doomedRoom = (await doomed.createRoom('/repo', 'repo')).id
  doomed.addIntentAsUser(doomedRoom, { title: 'acknowledged, then lost?' })
  await doomed.flush()
  assert.match(doomed.stateFor(doomedRoom).problem ?? '', /could not be saved/)
})

test('routing stays inside the board: another project is unreachable and unlisted', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'c1', title: 'API migration' }),
    peer({ sessionId: 'x1', title: 'Elsewhere', cwd: '/other-project' }),
  ]
  await team.joinRoom(room, 'codex' as RuntimeId, 'c1')

  /* Both boundaries, in the order they bite. Rooms subdivide a project and
     never span one, so the membership itself is refused — there is no hand
     door around it — and only then does addressing have nothing to find. */
  await assert.rejects(
    () => team.joinRoom(room, 'codex' as RuntimeId, 'x1'),
    /outside \/repo/,
  )

  const refused = await team.send({ to: 'Elsewhere', text: 'hello over there' }, codex)
  assert.match(refused, /^Refused: no conversation in this room/)
  assert.ok(!refused.includes('Elsewhere” ('), 'the other project is not in the roster')
  assert.match(refused, /A message reaches this room's members and nobody else/)
})

/**
 * A queued message belongs to the room it was sent in, not to its receiver.
 *
 * `#pending` is keyed by the receiver alone and each row remembers only which
 * board to write the outcome to — so a message queued for a busy member,
 * whose receiver then moved to another room, was still delivered when that
 * receiver's turn ended. It crossed a boundary the room exists to draw,
 * carrying an envelope from a board the receiver was no longer on.
 */
/**
 * A room made from a worktree belongs to the project, not to the checkout.
 *
 * A linked worktree is a real folder with a path of its own, and the host
 * already resolves a conversation in one to the workspace its checkout hangs
 * off — that is where its claims and its messages go. A room keyed by the
 * worktree path was therefore invisible in the tree, which groups a worktree
 * under its project, *and* unjoinable, because every conversation in it
 * resolved to a root the room did not have.
 */
test('a room is keyed by the project, even when it is made from a worktree', async (t) => {
  const { team, port } = await rig(t)
  const room = await team.createRoom('/repo/.worktrees/feature', 'From a worktree')
  assert.equal(room.root, '/repo')

  // And the conversation that made it can actually join it.
  port.peers = [peer({ sessionId: 'w1', title: 'In the worktree', cwd: '/repo/.worktrees/feature' })]
  await team.joinRoom(room.id, 'codex' as RuntimeId, 'w1')
  assert.deepEqual(team.stateFor(room.id).members, [`codex\u0000w1`])
})

/**
 * Putting a room away, and what does *not* go with it.
 *
 * A room is a place to work together, not a container that owns what is in
 * it: the conversations stop being members and carry on exactly as they were.
 * Deleting one must never reach into an agent's own history, which is the
 * thing that would be unrecoverable.
 */
test('a deleted room says what went, and leaves the conversations alone', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Migrate auth callers' }, codex)
  await team.send({ to: 'Auth refactor', text: 'a word before we go' }, codex)

  const gone = await team.deleteRoom(room)
  assert.deepEqual(gone, { name: 'repo', intents: 1, members: 2, messages: 1 })

  // Gone from the plane, and every window is told so — `changed` can only ever
  // say what a room *is*, so a delete needs a word of its own.
  assert.deepEqual(port.removed, [room])
  assert.deepEqual(team.states().map((state) => state.id), [])
  assert.deepEqual(team.roomsFor('/repo'), [])

  // The conversations are untouched: still running, and now in no room, which
  // is the state a conversation working on its own has always had.
  assert.equal(port.peers.length, 2)
  await assert.rejects(
    () => team.board(codex),
    /not in a room/,
    'it has no board, and is told so in the words a conversation on its own gets',
  )
})

test('a delete that cannot reach the disk is refused, not acknowledged', async (t) => {
  /* `deleteRoom` dropped the board from memory and returned success while the
     unlink was still queued, and the writer swallowed its own failure — with
     the board already gone there was no state left to hang the problem on. So
     a delete could be acknowledged, the room vanish from the interface, and
     the room come back from its own file at the next launch. */
  const { team, dir, room } = await rig(t)
  await team.flush()
  await chmod(dir, 0o500)

  try {
    await assert.rejects(() => team.deleteRoom(room), /could not be deleted/)
  } finally {
    await chmod(dir, 0o700)
  }

  // Still there, in memory as well as on disk: the two must not disagree
  // about whether a room exists.
  assert.deepEqual(team.states().map((state) => state.id), [room])

  const back = new Team(dir, {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  })
  await back.load()
  assert.deepEqual(
    back.states().map((state) => state.id),
    [room],
    'and the next launch agrees with what the person was told',
  )
  await back.flush()
})

test('deleting one room leaves another room’s queued message alone', async (t) => {
  /* `#settle` is receiver-wide: it takes every pending row for a session, from
     whichever room and including the user's own. Deleting room B therefore
     refused a message the user had queued in room A, and the receiver never
     got it when its turn ended — a message lost to a delete that had nothing
     to do with it. */
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  const other = (await team.createRoom('/repo', 'Somewhere else')).id

  // The user queues a post in room A, for a receiver that is mid-turn.
  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: true } : entry,
  )
  await team.post(room, 'from the room you are keeping', {
    runtime: 'claude' as RuntimeId,
    sessionId: 'k1',
  })

  // The receiver joins B, which is then deleted. A user post outlives a
  // membership move by design, and must outlive this too.
  await team.joinRoom(other, 'claude' as RuntimeId, 'k1')
  await team.deleteRoom(other)

  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: false } : entry,
  )
  await team.onTurnEnded('claude' as RuntimeId, 'k1')

  assert.equal(port.sent.length, 1, 'the message queued in the other room still landed')
  assert.match(port.sent[0]?.text ?? '', /from the room you are keeping/)
})

test('a deleted room does not come back at the next launch', async (t) => {
  const { team, dir, room } = await rig(t)
  const kept = (await team.createRoom('/repo', 'Still here')).id
  await team.deleteRoom(room)
  await team.flush()

  const back = new Team(dir, {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  })
  await back.load()
  assert.deepEqual(
    back.states().map((state) => state.id),
    [kept],
    'the deleted one is off the disk, and the other is not',
  )
  await back.flush()
})

/**
 * A room that has done nothing yet is still a room.
 *
 * The connect-time replay skipped a board with no intents and no channel,
 * which was right while a board appeared by itself for any folder somebody
 * opened. Now that a person makes one and names it, that filter meant a room
 * created and not yet used was on disk, in `roomsFor`, and gone from the tree
 * at the next launch — with the file still correct, which is the worst
 * version of this bug.
 */
test('an empty room is replayed to a client that has just connected', async (t) => {
  const { team, dir, room } = await rig(t)
  const made = (await team.createRoom('/repo', 'Nothing here yet')).id

  const replayed = team.states().map((state) => state.id)
  assert.ok(replayed.includes(made), `the empty room is replayed: ${JSON.stringify(replayed)}`)
  assert.ok(replayed.includes(room), 'and so is the one the rig made')

  // And it survives the trip to disk and back, which is where it was lost.
  await team.flush()
  const back = new Team(dir, {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  })
  await back.load()
  assert.deepEqual(
    back.states().map((state) => state.name).sort(),
    ['Nothing here yet', 'repo'],
  )
  await back.flush()
})

test('a message queued in one room is not delivered after its receiver leaves', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  const second = (await team.createRoom('/repo', 'Somewhere else')).id

  // The receiver is mid-turn, so the message waits.
  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: true } : entry,
  )
  assert.match(await team.send({ to: 'Auth refactor', text: 'for this room' }, codex), /^Queued:/)
  assert.equal(port.sent.length, 0)

  // It moves rooms while the message is still waiting on it.
  await team.joinRoom(second, 'claude' as RuntimeId, 'k1')
  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: false } : entry,
  )
  await team.onTurnEnded('claude' as RuntimeId, 'k1')

  assert.equal(port.sent.length, 0, 'the envelope did not follow it out of the room')
  const row = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage => candidate.kind === 'message',
  )
  assert.equal(row?.state, 'refused')
  assert.match(row?.reason ?? '', /left the room/)
})

test('a sender denied an approval this turn has its messages held, until the turn ends', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  team.noteDenial('codex' as RuntimeId, 'c1')
  const held = await team.send({ to: 'Auth refactor', text: 'do the thing I could not' }, codex)
  assert.match(held, /^Held: you were denied an approval this turn/)
  assert.equal(port.sent.length, 0)
  const row = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage => candidate.kind === 'message',
  )
  assert.equal(row?.state, 'held')
  assert.match(row?.reason ?? '', /denied an approval this turn/)

  // The turn ends; the denial no longer gates the next message.
  await team.onTurnEnded('codex' as RuntimeId, 'c1')
  assert.match(
    await team.send({ to: 'Auth refactor', text: 'a later, honest note' }, codex),
    /^Delivered/,
  )
})

test('turning board-only on holds what agents already queued; the user’s post sails through', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: true } : entry,
  )
  await team.send({ to: 'Auth refactor', text: 'queued by an agent' }, codex)
  await team.post(room, 'queued by the user', { runtime: 'claude' as RuntimeId, sessionId: 'k1' })

  team.setMessaging(room, false)

  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: false } : entry,
  )
  await team.onTurnEnded('claude' as RuntimeId, 'k1')
  assert.equal(port.sent.length, 1, 'only the user’s post was delivered')
  assert.equal(port.sent[0]?.text, 'queued by the user')
  const rows = team
    .stateFor(room)
    .channel.filter((candidate): candidate is TeamMessage => candidate.kind === 'message')
  const agents = rows.find((row) => row.from.kind === 'agent')
  assert.equal(agents?.state, 'held')
  assert.match(agents?.reason ?? '', /Board-only was turned on/)
})

test('inbound refuse applies to what was already queued for that conversation', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: true } : entry,
  )
  await team.send({ to: 'Auth refactor', text: 'in the air' }, codex)

  team.setInbound('claude', 'k1', 'refuse')

  port.peers = port.peers.map((entry) =>
    entry.sessionId === 'k1' ? { ...entry, busy: false } : entry,
  )
  await team.onTurnEnded('claude' as RuntimeId, 'k1')
  assert.equal(port.sent.length, 0)
  const row = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage => candidate.kind === 'message',
  )
  assert.equal(row?.state, 'refused')
  assert.match(row?.reason ?? '', /now refuses inter-agent messages/)
})

test('a hand-blocked intent stays blocked when its dependencies finish', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Endpoint' }, codex)
  await team.addIntent({ title: 'Review', dependsOn: [1] }, codex)
  await team.claim(1, codex)
  await team.complete(1, {}, codex)

  // The reviewer takes #2, finds something deeper wrong, and blocks it on
  // purpose. Redoing #1 must not silently put #2 back in play.
  await team.claim(2, claude)
  await team.release(2, { blocked: true, reason: 'the contract itself is wrong' }, claude)
  team.intentAction(room, 1, 'reopen')
  await team.claim(1, codex)
  const redone = await team.complete(1, {}, codex)
  assert.ok(!redone.includes('unblocked'), 'the hand block held')
  assert.equal(team.stateFor(room).intents.find((entry) => entry.id === 2)?.state, 'blocked')

  // And nobody claims it past the block; only a deliberate reopen frees it.
  assert.match(await team.claim(2, codex), /deliberately blocked/)
  team.intentAction(room, 2, 'reopen')
  assert.match(await team.claim(2, codex), /^Claimed #2/)
})

test('a big room keeps a few channel rows per member, beyond the two hundred a small room keeps', async (t) => {
  const { team, port, room } = await rig(t)
  // Sixty members, each handed one line: the assignments alone are sixty
  // rows, and the answers, claims and completions that follow are three
  // times that. A fixed two hundred forgot the first assignments before the
  // first answers came back.
  port.peers = Array.from({ length: 60 }, (_, n) =>
    peer({ sessionId: `s${n}`, title: `/page-${n}` }),
  )
  await joinAll(team, room, port)
  for (const one of port.peers) {
    await team.post(room, `Audit /page-${one.sessionId.slice(1)}`, { runtime: one.runtime, sessionId: one.sessionId })
  }
  for (let n = 0; n < 300; n += 1) team.addIntentAsUser(room, { title: `noise ${n}` })
  const channel = team.stateFor(room).channel
  const posts = channel.filter((entry) => entry.kind === 'message' && entry.from.kind === 'user')
  assert.ok(channel.length >= 60 * 6, `keeps at least six rows per member, has ${channel.length}`)
  assert.equal(posts.length, 60, 'every assignment is still in the channel')
})

test('a hand-out gives every member its own words in one action, and the room one row of it', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 's1', title: '/about' }),
    peer({ sessionId: 's2', title: '/admin', busy: true }),
    peer({ sessionId: 's3', title: '/blog' }),
  ]
  await joinAll(team, room, port)
  const before = port.changed.length
  const tally = await team.handout(room, 'Take card #{{card}} — {{title}}. Owner: {{member}}. Also {{missing}}.', [
    { runtime: 'codex' as RuntimeId, sessionId: 's1', vars: { card: '1', title: 'Audit /about', member: 'Codex' } },
    { runtime: 'codex' as RuntimeId, sessionId: 's2', vars: { card: '2', title: 'Audit /admin', member: 'Codex 2' } },
    { runtime: 'codex' as RuntimeId, sessionId: 's3', vars: { card: '3', title: 'Audit /blog', member: 'Codex 3' } },
    { runtime: 'codex' as RuntimeId, sessionId: 'nobody', vars: { card: '4', title: 'Audit /nowhere', member: '?' } },
  ])
  // Delivered to the idle, queued for the busy, refused for the absent — the
  // same three answers a post gets, counted.
  assert.deepEqual({ delivered: tally.delivered, queued: tally.queued, refused: tally.refused }, { delivered: 2, queued: 1, refused: 1 })
  assert.deepEqual(port.sent.map((one) => one.text), [
    'Take card #1 — Audit /about. Owner: Codex. Also {{missing}}.',
    'Take card #3 — Audit /blog. Owner: Codex 3. Also {{missing}}.',
  ])
  const rows = team.stateFor(room).channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
  assert.equal(rows.length, 4, 'one row per member, in the order the hand-out named them')
  assert.deepEqual(rows.map((row) => row.state), ['delivered', 'queued', 'delivered', 'refused'])
  assert.deepEqual(rows.map((row) => row.to?.sessionId), ['s1', 's2', 's3', 'nobody'])
  const batches = new Set(rows.map((row) => row.batch?.id))
  assert.equal(batches.size, 1, 'every row carries the one batch')
  assert.equal(rows[0]?.batch?.size, 4)
  assert.equal(rows[0]?.batch?.template, 'Take card #{{card}} — {{title}}. Owner: {{member}}. Also {{missing}}.')
  assert.equal(rows[1]?.text, 'Take card #2 — Audit /admin. Owner: Codex 2. Also {{missing}}.')
  // One commit for the lot, not one per member.
  assert.equal(port.changed.length - before, 1)
  // The queued one lands when its turn ends, like any queued post.
  port.peers = port.peers.map((one) => (one.sessionId === 's2' ? { ...one, busy: false } : one))
  await team.onTurnEnded('codex' as RuntimeId, 's2', { answer: 'done with the last one' })
  assert.ok(port.sent.some((one) => one.sessionId === 's2' && one.text.startsWith('Take card #2')), 'the busy member got its copy after its turn')
})

test('a hand-out with nothing to say, or nobody to say it to, changes nothing', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  const before = team.stateFor(room).channel.length
  const empty = await team.handout(room, '   ', [{ runtime: 'codex' as RuntimeId, sessionId: 'c1' }])
  const nobody = await team.handout(room, 'Take {{card}}', [])
  assert.deepEqual([empty.delivered, empty.queued, empty.refused, nobody.delivered], [0, 0, 0, 0])
  assert.equal(team.stateFor(room).channel.length, before)
  assert.equal(port.sent.length, 0)
})

test('claim_next takes the next open, unblocked, unconflicted card, and says so when nothing is left', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'first, held by Claude', files: ['src/a.js'] }, codex)
  await team.addIntent({ title: 'waits on the first', dependsOn: [1] }, codex)
  await team.addIntent({ title: 'overlaps the held files', files: ['src/a.js'] }, codex)
  await team.addIntent({ title: 'free', files: ['src/b.js'] }, codex)
  await team.addIntent({ title: 'also free' }, codex)
  assert.match(await team.claim(1, claude), /^Claimed #1/)

  // Codex asks for whatever is next: not #1 (held), not #2 (waiting), not #3
  // (its files are Claude's while #1 lives) — #4.
  assert.match(await team.claimNext(codex, ['src/b.js']), /^Claimed #4 — free/)
  // Claude, who holds the files #3 overlaps, is not blocked by its own claim:
  // #3 is the lowest card open to it.
  assert.match(await team.claimNext(claude), /^Claimed #3 — overlaps the held files/)
  assert.match(await team.claimNext(codex), /^Claimed #5 — also free/)
  // And when nothing is left, it says why rather than refusing by number.
  const empty = await team.claimNext(codex)
  assert.match(empty, /^Nothing to take right now/)
  assert.match(empty, /2 are yours already; 2 are held by others; 1 waits on other work/)
  const held = team.stateFor(room).intents.filter((one) => one.state === 'claimed').map((one) => one.id)
  assert.deepEqual(held, [1, 3, 4, 5])
})

test('a room keeps a floor, a few rows per member, and never more than the ceiling', () => {
  assert.equal(roomCap(3, 200, 6, 5000), 200, 'a small room keeps the floor')
  assert.equal(roomCap(60, 200, 6, 5000), 360, 'a big room keeps six per member')
  assert.equal(roomCap(138, 200, 6, 5000), 828)
  assert.equal(roomCap(1000, 200, 6, 5000), 5000, 'and no more than the ceiling')
  assert.equal(roomCap(138, 200, 4, 2000), 552, 'intents: four per member')
  assert.equal(roomCap(900, 200, 4, 2000), 2000)
})

test('a big room keeps a few settled cards per member, and never a live one', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = Array.from({ length: 60 }, (_, n) => peer({ sessionId: `s${n}`, title: `/page-${n}` }))
  await joinAll(team, room, port)
  // Three hundred cards, the first 260 finished as they come and the last
  // 40 left open. The board trims as it grows: sixty members keep 240
  // cards, so the oldest settled ones fall off and every open one stays.
  for (let n = 0; n < 300; n += 1) {
    const added = team.addIntentAsUser(room, { title: `card ${n}` })
    if (n < 260) team.intentAction(room, added.id, 'done')
  }
  const intents = team.stateFor(room).intents
  assert.equal(intents.length, 240, 'four per member, not two hundred')
  assert.equal(intents.filter((one) => one.state === 'open').length, 40, 'every live card survived')
  assert.ok(intents.every((one) => one.id > 60), 'the oldest settled ones went first')
})

test('the board trims only settled intents, and never breaks who depends on what', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  for (let n = 0; n < 205; n += 1) {
    team.addIntentAsUser(room, { title: `work ${n}` })
  }
  for (let id = 1; id <= 10; id += 1) {
    team.intentAction(room, id, 'done')
  }
  // The next additions push past the limit; only the ten settled rows go.
  team.addIntentAsUser(room, { title: 'depends on trimmed work', dependsOn: [5] })
  for (let n = 0; n < 10; n += 1) {
    team.addIntentAsUser(room, { title: `more ${n}` })
  }
  const state = team.stateFor(room)
  assert.ok(!state.intents.some((entry) => entry.id <= 10), 'the settled rows were trimmed')
  assert.ok(
    state.intents.every((entry) => entry.state === 'open'),
    'nothing live was dropped',
  )
  // A dependency on a trimmed (settled) intent reads as satisfied.
  const dependent = state.intents.find((entry) => entry.dependsOn.includes(5))
  assert.ok(dependent)
  assert.equal(dependent.state, 'open')
  assert.match(await team.claim(dependent.id, codex), /^Claimed #/)
})

test('a user post over the size limit is refused on the surface, not sent', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.post(room, 'x'.repeat(17_000))
  assert.equal(port.sent.length, 0)
  const row = team.stateFor(room).channel.find(
    (candidate): candidate is TeamMessage => candidate.kind === 'message',
  )
  assert.equal(row?.state, 'refused')
  assert.match(row?.reason ?? '', /limit is 16000/)
})

/**
 * The room shows the answer, and does not send it.
 *
 * Watching two live agents work exposed the gap this closes: the receiver
 * replied — in its own conversation, where nobody watching the board could
 * see it — so a person reading the channel saw a question, no answer, and
 * concluded the agent was broken. The answer belongs in the room.
 *
 * What it must *not* do is go back on the wire. Sending it would wake the
 * asker, whose answer would wake the receiver, and two agents talking to each
 * other forever on the user's tokens is the failure this feature is designed
 * against before any other. So the row is `shown`, and `port.sent` stays
 * exactly as long as it was.
 */
test('a woken conversation’s answer lands in the room, and is never sent back', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  await team.send({ to: 'Auth refactor', text: 'verifyToken moved' }, codex)
  assert.equal(port.sent.length, 1)

  await team.onTurnEnded('claude' as RuntimeId, 'k1', { answer: 'Understood — I will call the new one.' })

  const messages = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
  const answer = messages.at(-1)
  assert.equal(answer?.state, 'shown')
  assert.equal(answer?.text, 'Understood — I will call the new one.')
  assert.equal(answer?.from.kind === 'agent' && answer.from.runtime, 'claude')
  assert.equal(answer?.to?.title, 'API migration')
  // The whole point: nothing new went out.
  assert.equal(port.sent.length, 1)
})

test('the debt is cleared once: a later turn is not posted as though it were a reply', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.send({ to: 'Auth refactor', text: 'verifyToken moved' }, codex)

  await team.onTurnEnded('claude' as RuntimeId, 'k1', { answer: 'the answer' })
  await team.onTurnEnded('claude' as RuntimeId, 'k1', { answer: 'something the user asked for later' })

  const shown = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message' && entry.state === 'shown')
  assert.equal(shown.length, 1)
  assert.equal(shown[0]?.text, 'the answer')
})

/**
 * A member that stopped is the one thing a room must never omit.
 *
 * The failure this pins was silent: an agent whose five-hour window ran out
 * halfway through a review left no row at all — the debt it owed the room was
 * written off, the roster went quiet, and "still reading" and "stopped forty
 * minutes ago" looked identical to everyone watching.
 */
test('a turn that dies owing the room an answer leaves a notice saying why', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  await team.send({ to: 'Auth refactor', text: 'verifyToken moved' }, codex)
  await team.onTurnEnded('claude' as RuntimeId, 'k1', {
    failure: { cause: 'limit', message: "You've hit your usage limit. It resets at 3:20 PM." },
  })

  const notices = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamNotice => entry.kind === 'notice')
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.cause, 'limit')
  assert.match(notices[0]?.text ?? '', /usage limit/)
  assert.equal(notices[0]?.about.kind === 'agent' && notices[0].about.runtime, 'claude')
  // Nothing was sent on its behalf, and no answer was invented for it.
  assert.equal(port.sent.length, 1)
  assert.equal(
    team.stateFor(room).channel.filter((entry) => entry.kind === 'message' && entry.state === 'shown').length,
    0,
  )
})

test('a notice is written even when answers in the room are off — it is not an answer', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  team.configure({ answersInRoom: false })

  await team.send({ to: 'Auth refactor', text: 'verifyToken moved' }, codex)
  await team.onTurnEnded('claude' as RuntimeId, 'k1', {
    failure: { cause: 'auth', message: 'Signed out.' },
  })

  assert.equal(team.stateFor(room).channel.filter((entry) => entry.kind === 'notice').length, 1)
})

test('a turn that answered and then reported trouble is shown as its answer, not as a death', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  await team.send({ to: 'Auth refactor', text: 'verifyToken moved' }, codex)
  await team.onTurnEnded('claude' as RuntimeId, 'k1', {
    answer: 'Done — I called the new one.',
    failure: { cause: 'stopped', message: 'The turn was stopped.' },
  })

  const channel = team.stateFor(room).channel
  assert.equal(channel.filter((entry) => entry.kind === 'notice').length, 0)
  assert.equal(
    channel.filter((entry) => entry.kind === 'message' && entry.state === 'shown').length,
    1,
  )
})

test('a member that owes the room nothing dies without filling its channel', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  // Nobody asked it anything; its own work failing is its own business.
  await team.onTurnEnded('claude' as RuntimeId, 'k1', {
    failure: { cause: 'limit', message: "You've hit your usage limit." },
  })

  assert.equal(team.stateFor(room).channel.filter((entry) => entry.kind === 'notice').length, 0)
})

test('answers in the room can be turned off, and then nothing is posted', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  team.configure({ answersInRoom: false })

  await team.send({ to: 'Auth refactor', text: 'verifyToken moved' }, codex)
  await team.onTurnEnded('claude' as RuntimeId, 'k1', { answer: 'Understood.' })

  const shown = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message' && entry.state === 'shown')
  assert.equal(shown.length, 0)
})

/**
 * Board-only tells the sender and, until now, told the user nothing at all —
 * the one place this surface implied something about the traffic instead of
 * showing it.
 */
test('board-only records the attempt it stopped, so the silence is visible', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  team.setMessaging(room, false)

  const refusal = await team.send({ to: 'Auth refactor', text: 'are you done?' }, codex)
  assert.match(refusal, /board-only/)

  const messages = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.state, 'refused')
  assert.equal(messages[0]?.text, 'are you done?')
  assert.match(messages[0]?.reason ?? '', /board-only is on/)
  assert.equal(port.sent.length, 0)
})

test('recording muted attempts can be turned off, and board-only goes quiet again', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  team.configure({ recordMutedAttempts: false })
  team.setMessaging(room, false)

  await team.send({ to: 'Auth refactor', text: 'are you done?' }, codex)
  assert.equal(
    team.stateFor(room).channel.filter((entry) => entry.kind === 'message').length,
    0,
  )
})

/**
 * The settings are a settings page, which means they are user input: a value
 * that would leave the engine with no rate limit at all must fall back to the
 * shipped one rather than be honoured.
 */
test('configuration refuses values that would remove a guard', async (t) => {
  const { team, room } = await rig(t)
  team.configure({ rateLimit: 0, messageChars: 1, inboundDefault: 'nonsense' as never })
  assert.equal(team.settings().rateLimit, 4)
  assert.equal(team.settings().messageChars, 16_000)
  assert.equal(team.settings().inboundDefault, 'accept')

  team.configure({ rateLimit: 10, messageChars: 500, inboundDefault: 'hold' })
  assert.equal(team.settings().rateLimit, 10)
  assert.equal(team.settings().messageChars, 500)
  assert.equal(team.settings().inboundDefault, 'hold')
})

test('the inbound default holds a message before any conversation has been set', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  team.configure({ inboundDefault: 'hold' })

  const answer = await team.send({ to: 'Auth refactor', text: 'verifyToken moved' }, codex)
  assert.match(answer, /^Held/)
  assert.equal(port.sent.length, 0)
})

/**
 * The host says a turn ended twice — once as `turn/completed`, once as the
 * trailing idle status — and only the first knows what was said.
 *
 * This is the bug the first version shipped with, and it survived a full unit
 * suite because the tests called the end-of-turn signal once. Live, the idle
 * nudge arrived carrying nothing, the debt was cleared against it, and the
 * real answer a moment later had nobody left to answer. Both orders are
 * exercised here.
 */
test('the idle nudge does not consume the answer the completed turn is carrying', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.send({ to: 'Auth refactor', text: 'verifyToken moved' }, codex)

  // Idle first, carrying nothing — must leave the debt standing.
  await team.onTurnEnded('claude' as RuntimeId, 'k1')
  await team.onTurnEnded('claude' as RuntimeId, 'k1', { answer: 'the real answer' })

  const shown = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message' && entry.state === 'shown')
  assert.equal(shown.length, 1)
  assert.equal(shown[0]?.text, 'the real answer')
})

test('a completed turn that said nothing still settles the debt', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.send({ to: 'Auth refactor', text: 'verifyToken moved' }, codex)

  await team.onTurnEnded('claude' as RuntimeId, 'k1', {})
  // Whatever the user asks for next is theirs, not an answer to the message.
  await team.onTurnEnded('claude' as RuntimeId, 'k1', { answer: 'unrelated later work' })

  const shown = team
    .stateFor(room)
    .channel.filter((entry) => entry.kind === 'message' && entry.state === 'shown')
  assert.equal(shown.length, 0)
})

/**
 * Ownership is compared as text, so two spellings of one path were two
 * regions and the guard simply stepped aside.
 */
test('paths are canonical, so one area of the tree cannot be claimed twice', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Rewrite the readme', files: ['./docs/../README.md'] }, codex)
  await team.addIntent({ title: 'Also the readme', files: ['README.md'] }, claude)

  assert.match(await team.claim(1, codex), /^Claimed #1/)
  const second = await team.claim(2, claude)
  assert.match(second, /^Refused/)
  assert.match(second, /overlap a live claim/)
})

test('a path outside the workspace is refused, not normalised into something harmless', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  const escaped = await team.addIntent({ title: 'Reach out', files: ['../other-repo/src'] }, codex)
  assert.match(escaped, /^Refused/)
  assert.match(escaped, /outside this workspace/)

  const absolute = await team.addIntent({ title: 'Reach further', files: ['/etc/hosts'] }, codex)
  assert.match(absolute, /^Refused/)
  assert.equal(team.stateFor(room).intents.length, 0)
})

test('a conflict check answers about the canonical path, not the spelling', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Migrate', files: ['src/api/**'] }, codex)
  await team.claim(1, codex)

  const hit = await team.conflicts(['./src/api/../api/routes.ts'], claude)
  assert.match(hit, /^Conflicts/)
})

/**
 * `accept` has to be storable. Deleting the entry made it mean "inherit",
 * which is indistinguishable from never having chosen — until the default is
 * not accept, when choosing accept did nothing at all.
 */
test('an explicit accept overrides a hold default', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  team.configure({ inboundDefault: 'hold' })

  assert.match(await team.send({ to: 'Auth refactor', text: 'first' }, codex), /^Held/)
  team.setInbound('claude', 'k1', 'accept')
  assert.match(await team.send({ to: 'Auth refactor', text: 'second' }, codex), /^Delivered/)
})

/**
 * Every attempt reaches the audit, including the ones that never became a
 * message. The refusals were exactly the rows most worth having.
 */
test('every refusal is audited, including the ones that return early', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  team.setMessaging(room, false)
  await team.send({ to: 'Auth refactor', text: 'muted' }, codex)
  team.setMessaging(room, true)
  await team.send({ to: 'nobody at all', text: 'lost' }, codex)
  await team.send({ to: 'Auth refactor', text: '' }, codex)
  await team.send({ to: 'Auth refactor', text: 'x'.repeat(20_000) }, codex)

  const decisions = port.audited
    .filter((entry) => entry.kind === 'team/message')
    .map((entry) => entry.decision)
  assert.deepEqual(decisions, [
    'refused-board-only',
    'refused-unknown-recipient',
    'refused-empty',
    'refused-too-long',
  ])
})

test('the repeat and rate-limit guards are audited too', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.send({ to: 'Auth refactor', text: 'same' }, codex)
  await team.send({ to: 'Auth refactor', text: 'same' }, codex)

  const decisions = port.audited
    .filter((entry) => entry.kind === 'team/message')
    .map((entry) => entry.decision)
  assert.deepEqual(decisions, ['delivered', 'refused-repeat'])
})

/**
 * A runtime that goes down without a `session/closed` each — health failure,
 * account removal — still settles its mail. A row left saying `queued`
 * against a conversation that no longer exists is the silent non-delivery
 * this surface exists to prevent.
 */
test('a detached runtime refuses what it can never deliver, with the reason', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  port.peers = port.peers.map((one) =>
    one.sessionId === 'k1' ? { ...one, busy: true } : one,
  )

  assert.match(await team.send({ to: 'Auth refactor', text: 'waiting' }, codex), /^Queued/)
  const queued = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
  assert.equal(queued[0]?.state, 'queued')

  team.onRuntimeDetached('claude' as RuntimeId)

  const after = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
  assert.equal(after[0]?.state, 'refused')
  assert.match(after[0]?.reason ?? '', /stopped before the message was read/)
})

/**
 * The round-robin review, end to end.
 *
 * The one flow that touches every part of the plane at once: a board comes into
 * being, a review goes up, and three agents on three different runtimes each
 * take it in turn, sign the channel with their own name, and hand it on. It is
 * the shape a person actually asks for — "everyone look at this and say you
 * did" — and it is where the pieces have to agree with each other rather than
 * merely work.
 *
 * What it holds that the unit tests above cannot:
 *
 *   Exclusivity survives a queue. Three agents wanting the same intent is not
 *   three independent claims; it is a sequence where each one's release is the
 *   next one's permission, and a board that let two in would only show it here.
 *
 *   A signature is the host's, not the sender's. Every comment is attributed
 *   from the caller's scope, so an agent cannot sign as somebody else — which
 *   is the whole reason the channel is worth reading afterwards.
 *
 *   The record survives the work. When the last reviewer finishes, the board
 *   says done once and the channel still holds all three passes in order.
 */
test('a review goes round every member, and each signs the channel in their own name', async (t) => {
  const { team, port, room } = await rig(t)

  const reviewers = [
    { scope: { runtime: 'codex', sessionId: 'c1' }, name: 'Codex', title: 'Codex review' },
    { scope: { runtime: 'claude', sessionId: 'k1' }, name: 'Claude Code', title: 'Claude review' },
    { scope: { runtime: 'cursor', sessionId: 'x1' }, name: 'Cursor', title: 'Cursor review' },
  ] as const
  port.peers = [
    peer({ sessionId: 'c1', title: 'Codex review' }),
    peer({ sessionId: 'k1', runtime: 'claude' as RuntimeId, title: 'Claude review', agent: 'Claude Code' }),
    peer({ sessionId: 'x1', runtime: 'cursor' as RuntimeId, title: 'Cursor review', agent: 'Cursor' }),
  ]
  await joinAll(team, room, port)

  // The person puts the work up. Nothing is assigned: taking it is each
  // agent's own act, which is the transaction the whole board exists for.
  team.addIntentAsUser(room, { title: 'Review the rounding change', files: [] })

  for (const [index, reviewer] of reviewers.entries()) {
    const taken = await team.claim(1, reviewer.scope)
    assert.match(taken, /^Claimed #1/, `${reviewer.name} could not take the review`)

    // While it is held, nobody else can take it — checked against the *next*
    // reviewer in the queue rather than a spare identity, because the queue is
    // the thing under test.
    const next = reviewers[(index + 1) % reviewers.length]!
    const refused = await team.claim(1, next.scope)
    assert.match(refused, /^Refused: #1 is already claimed/)

    // An agent addresses *a conversation*, never "everyone" — broadcasting is
    // the person's verb, and an agent that could reach the whole board at once
    // is an agent that can wake it at once. So the baton is passed by name.
    const said = await team.send(
      { to: next.title, text: `Reviewed by ${reviewer.name}: rounding reads half-up to whole cents.` },
      reviewer.scope,
    )
    assert.doesNotMatch(said, /^Refused/, `${reviewer.name} could not pass the review on`)

    // Everyone but the last hands it back, signing the board on the way out.
    if (index < reviewers.length - 1) {
      await team.release(1, { reason: `${reviewer.name} has read it` }, reviewer.scope)
    }
  }

  await team.complete(1, { note: 'All three reviewers signed off.' }, reviewers.at(-1)!.scope)

  const state = team.stateFor(room)
  const review = state.intents.find((intent) => intent.id === 1)
  assert.equal(review?.state, 'done')
  assert.equal(review?.note, 'All three reviewers signed off.')

  // Every reviewer's comment is in the channel, and each is attributed to the
  // conversation that actually made the call — the sender wrote the words, the
  // host wrote the name, and only the second one can be trusted.
  const comments = state.channel.filter(
    (entry): entry is TeamMessage => entry.kind === 'message' && entry.text.startsWith('Reviewed by'),
  )
  assert.equal(comments.length, reviewers.length)
  for (const reviewer of reviewers) {
    const mine = comments.find((entry) => entry.text.includes(`Reviewed by ${reviewer.name}`))
    assert.ok(mine, `${reviewer.name} left no comment`)
    assert.equal(mine.from.kind, 'agent')
    assert.equal(mine.from.kind === 'agent' ? mine.from.sessionId : null, reviewer.scope.sessionId)
  }

  // And they are in the order the review went round, which is what makes the
  // channel a record rather than a pile.
  assert.deepEqual(
    comments.map((entry) => (entry.from.kind === 'agent' ? entry.from.sessionId : null)),
    reviewers.map((reviewer) => reviewer.scope.sessionId),
  )

  // Three claims, three completions-or-releases, three messages: the audit has
  // an entry per agent act and none for the person's, who needs no alibi.
  assert.ok(port.audited.filter((entry) => entry.kind === 'team/intent').length >= reviewers.length)
  assert.equal(port.audited.filter((entry) => entry.kind === 'team/message').length, reviewers.length)
})

/**
 * A room of identical conversations is still addressable.
 *
 * The case that broke it in a live run: three Cursor conversations on three
 * models, all untitled. Nothing on a peer distinguished them — same agent, same
 * account, no title — so they were not merely indistinguishable in the roster,
 * they were *unaddressable*: every one matched the agent's own name and `send`
 * refused with "matches 3 conversations, name one exactly" when there was no
 * exact name to give.
 *
 * The nickname is the name that always exists. It is derived from the model
 * rather than randomised, because it is the string an agent has to type back.
 */
test('members are named after what they run, and the name is what reaches them', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'c1', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash-high' }),
    peer({ sessionId: 'c2', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'claude-4.6-opus-max-thinking' }),
    peer({ sessionId: 'c3', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gpt-5.3-codex-xhigh' }),
  ]
  await joinAll(team, room, port)

  const roster = await team.peersFor(room)
  assert.deepEqual(
    roster.map((entry) => entry.nickname),
    ['Gemini', 'Opus', 'Codex'],
    'the name says what it runs, which is the only thing that differs',
  )

  // The name reaches exactly one of them. Under the old rules "cursor" matched
  // all three and nothing matched one.
  const sent = await team.send({ to: 'Opus', text: 'ping' }, { runtime: 'cursor', sessionId: 'c1' })
  assert.doesNotMatch(sent, /^Refused/, sent)
  assert.equal(port.sent.length, 1)
  assert.equal(port.sent[0]?.sessionId, 'c2')

  // A name survives a restart, or it is not a name.
  await team.flush()
  const again = await team.peersFor(room)
  assert.deepEqual(again.map((entry) => entry.nickname), ['Gemini', 'Opus', 'Codex'])
})

test('two members on one model get numbers, and the first one keeps its name', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'a', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'claude-4.6-opus-high' }),
  ]
  await joinAll(team, room, port)
  assert.deepEqual((await team.peersFor(room)).map((entry) => entry.nickname), ['Opus'])

  port.peers = [
    ...port.peers,
    peer({ sessionId: 'b', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'claude-4.6-opus-max-thinking' }),
  ]
  await joinAll(team, room, port)
  // The second is numbered; the first does not move under it. A name that
  // changes when somebody else arrives is not a name.
  assert.deepEqual(
    (await team.peersFor(room)).map((entry) => entry.nickname),
    ['Opus', 'Opus 2'],
  )
})

test('a rename is refused rather than silently deduped', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'a', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'claude-4.6-opus-high' }),
    peer({ sessionId: 'b', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash-high' }),
  ]
  await joinAll(team, room, port)
  await team.peersFor(room)

  assert.match(team.rename(room, 'cursor', 'b', 'Reviewer'), /^Renamed/)
  assert.match(team.rename(room, 'cursor', 'a', 'reviewer'), /already taken/)
  assert.match(team.rename(room, 'cursor', 'a', '  '), /needs a name/)

  // And the new name is what reaches it.
  const sent = await team.send({ to: 'Reviewer', text: 'hi' }, { runtime: 'cursor', sessionId: 'a' })
  assert.doesNotMatch(sent, /^Refused/, sent)
  assert.equal(port.sent[0]?.sessionId, 'b')
})

/**
 * The answer says who gave it.
 *
 * A woken conversation's reply is put in the room as `shown`, and it used to be
 * attributed from the peer's *title* — which is empty for an ACP conversation.
 * A room of three Cursor members therefore showed three answers all reading
 * "Cursor", which is precisely the reading the nickname exists to prevent, in
 * the one place a reader most needs to tell them apart.
 */
test('an answer shown in the room carries the member\u2019s room name', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'a', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'claude-4.6-opus-high' }),
    peer({ sessionId: 'b', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash-high' }),
  ]
  await joinAll(team, room, port)
  const names = await team.peersFor(room)
  const opus = names.find((entry) => entry.nickname === 'Opus')
  assert.ok(opus, 'the member is named after what it runs')

  // A asks B, B answers: the answer lands as `shown`, attributed to B.
  await team.send({ to: 'Gemini', text: 'what are you on?' }, { runtime: 'cursor', sessionId: 'a' })
  team.onTurnEnded('cursor' as RuntimeId, 'b', { answer: 'gemini-3.7-flash-high' })
  await team.flush()

  const shown = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message' && entry.state === 'shown')
  assert.equal(shown.length, 1)
  const from = shown[0]?.from
  assert.equal(from?.kind, 'agent')
  assert.equal(from?.kind === 'agent' ? from.nickname : null, 'Gemini')
})

/**
 * The review, with everyone named.
 *
 * The round-robin above proves the mechanics; this proves the *record*. Three
 * conversations that arrive untitled and identical — one agent, one account,
 * three models — take one review in turn and each signs it. What has to hold is
 * that a reader can tell afterwards who did what, which is the whole reason the
 * channel is kept: before nicknames these were three rows all saying "Cursor",
 * and the transcript could not answer the question it exists to answer.
 */
test('a review signed by every member reads back as three different members', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'r1', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash-high' }),
    peer({ sessionId: 'r2', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'claude-4.6-opus-max-thinking' }),
    peer({ sessionId: 'r3', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gpt-5.3-codex-xhigh' }),
  ]
  await joinAll(team, room, port)
  const roster = await team.peersFor(room)
  assert.deepEqual(roster.map((entry) => entry.nickname), ['Gemini', 'Opus', 'Codex'])

  team.addIntentAsUser(room, { title: 'Review the rounding change', files: [] })

  for (const [index, member] of roster.entries()) {
    const scope = { runtime: member.runtime, sessionId: member.sessionId }
    assert.match(await team.claim(1, scope), /^Claimed #1/, `${member.nickname} could not take it`)

    // Signed in their own name, addressed to the next by theirs.
    const next = roster[(index + 1) % roster.length]!
    const said = await team.send(
      { to: next.nickname, text: `Reviewed by ${member.nickname}.` },
      scope,
    )
    assert.doesNotMatch(said, /^Refused/, `${member.nickname} could not reach ${next.nickname}: ${said}`)

    if (index < roster.length - 1) {
      await team.release(1, { reason: `${member.nickname} has read it` }, scope)
    } else {
      await team.complete(1, { note: 'All three signed off.' }, scope)
    }
  }

  const state = team.stateFor(room)
  assert.equal(state.intents.find((intent) => intent.id === 1)?.state, 'done')

  // The record names three different members, in order — the property that was
  // missing when every row said "Cursor".
  const signed = state.channel.filter(
    (entry): entry is TeamMessage => entry.kind === 'message' && entry.text.startsWith('Reviewed by'),
  )
  assert.deepEqual(
    signed.map((entry) => (entry.from.kind === 'agent' ? entry.from.nickname : null)),
    ['Gemini', 'Opus', 'Codex'],
  )
  // And each addressed a *particular* member rather than "one of the Cursors".
  assert.deepEqual(
    signed.map((entry) => entry.to?.nickname),
    ['Opus', 'Codex', 'Gemini'],
  )
})

/**
 * A handover is delivered, not fetched.
 *
 * The context package was always available and never delivered: `get_context`
 * existed, and an agent had to know to call it. Correctness that depends on
 * remembering a tool name is correctness that will be got wrong — and the
 * failure is silent, because work built against a contract nobody read looks
 * exactly like work built against one that was.
 *
 * So it arrives with the claim: the moment the job is taken is the moment the
 * contract is needed, and the only moment the agent is certainly listening.
 */
test('taking a job hands over what the work it depends on left behind', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  await team.addIntent({ title: 'Define the tax contract', files: ['src/tax.ts'] }, codex)
  await team.addIntent({ title: 'Round in checkout', files: ['src/checkout.ts'], dependsOn: [1] }, codex)

  await team.claim(1, codex)
  await team.complete(
    1,
    { note: 'done', handoff: 'tax(amount, rate) rounds half-up to whole cents.' },
    codex,
  )

  // The dependant takes its job and is told the contract without asking.
  const taken = await team.claim(2, claude)
  assert.match(taken, /^Claimed #2/)
  assert.match(taken, /rounds half-up to whole cents/, `the handover rode the claim: ${taken}`)
  assert.match(taken, /#1 — Define the tax contract/)

  // `get_context` still works for an agent that asks again; it is no longer
  // the only way to find out.
  assert.match(await team.handoff(1, claude), /rounds half-up to whole cents/)
})

test('a job with nothing behind it says nothing about handovers', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Reproduce the flake', files: [] }, codex)
  const taken = await team.claim(1, codex)
  assert.doesNotMatch(taken, /left for you/, 'no empty section for work that depends on nothing')
})

/**
 * A claim is a lease, not a lock.
 *
 * The thing holding a claim is a process on somebody's laptop: it crashes,
 * loses the network, runs out of quota, or is closed with work half done. A
 * permanent lock in that world turns one crash into an intent nobody can ever
 * take again — the board's promise quietly becomes "work has at most one owner,
 * forever", which is worse than no board.
 */
test('a claim whose holder is gone and whose lease ran out can be taken over', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Migrate the callers', files: ['src/api/**'] }, codex)
  assert.match(await team.claim(1, codex), /^Claimed #1/)

  // Still held while the holder is there: a live member is not stranded, however
  // long it has been thinking.
  assert.match(await team.claim(1, claude), /already claimed/)

  // The holder goes. The lease has not run out yet, so it is still theirs —
  // absence alone must not take work off an agent that is coming back.
  port.peers = port.peers.filter((peer) => peer.sessionId !== 'c1')
  assert.match(await team.claim(1, claude), /already claimed/)

  // Now the lease runs out too. Both halves true: it is taken over.
  const held = team.stateFor(room).intents.find((intent) => intent.id === 1)
  assert.ok(held?.claim?.leaseUntil, 'a claim carries a lease')
  team.stateFor(room).intents.forEach(() => undefined)
  const past = Date.now() - 1000
  ;(held as { claim: { leaseUntil: number } }).claim.leaseUntil = past

  const taken = await team.claim(1, claude)
  assert.match(taken, /^Claimed #1/, `a stranded claim is taken over: ${taken}`)

  // And the takeover is on the record rather than looking like an ordinary
  // claim — somebody else's work changed hands.
  const signals = team
    .stateFor(room)
    .channel.filter((entry) => entry.kind === 'signal')
    .map((entry) => (entry as { detail?: string | null }).detail ?? '')
  assert.ok(
    signals.some((note) => note.includes('whose claim ran out')),
    `the takeover is recorded: ${JSON.stringify(signals)}`,
  )
})

test('a claim is renewed by its holder being heard from', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Long job', files: [] }, codex)
  await team.claim(1, codex)

  const first = team.stateFor(room).intents[0]?.claim?.leaseUntil ?? 0
  // Reading the board is being heard from; so is finishing a turn.
  await new Promise((resolve) => setTimeout(resolve, 5))
  await team.board(codex)
  const second = team.stateFor(room).intents[0]?.claim?.leaseUntil ?? 0
  assert.ok(second > first, 'a board read renews the lease')

  await new Promise((resolve) => setTimeout(resolve, 5))
  await team.onTurnEnded('codex' as RuntimeId, 'c1', { answer: 'done thinking' })
  const third = team.stateFor(room).intents[0]?.claim?.leaseUntil ?? 0
  assert.ok(third > second, 'the end of a turn renews it too')
})

test('a claim written before leases existed is not stranded by their arrival', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Older work', files: [] }, codex)
  await team.claim(1, codex)

  // An old board has no lease on its claims. Read as "expired" that would
  // strand every one of them the moment this shipped.
  const held = team.stateFor(room).intents[0]
  delete (held as { claim?: { leaseUntil?: number } }).claim?.leaseUntil
  port.peers = port.peers.filter((peer) => peer.sessionId !== 'c1')

  assert.match(await team.claim(1, claude), /already claimed/)
})

/**
 * Names count the members of the room, and a member that is not open is one.
 *
 * The old rule counted only members whose conversation was *running*, which
 * was the only way to stop a room numbering its agents upward forever —
 * "Gemini 2", "Gemini 3", "Gemini 4", each the only Gemini present — while the
 * board carried members whose conversations were long gone and nothing ever
 * took them off it. Two things changed. A member that is merely not open is
 * drawn on the rail like anybody else, so its name is on screen and must not
 * be handed to somebody else; and a member the agent has no record of is
 * dropped from the board, which is what ends the climb at the source.
 *
 * The channel keeps its own copy of the name at write time, so nothing already
 * written changes meaning when the map moves on.
 */
test('a member that is merely not open keeps its name; the next one gets a number', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'a', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash' }),
  ]
  await joinAll(team, room, port)
  assert.deepEqual((await team.peersFor(room)).map((one) => one.nickname), ['Gemini'])

  // The desk restarts: nothing is open, and a second conversation on the same
  // model is added to the room.
  const b = peer({ sessionId: 'b', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash' })
  port.peers = [b]
  await joinAll(team, room, port)
  assert.deepEqual(
    (await team.peersFor(room)).map((one) => one.nickname),
    ['Gemini', 'Gemini 2'],
    'the first one is still a member, still called Gemini, and still on the rail',
  )
  assert.deepEqual(
    (await team.peersFor(room)).map((one) => one.here),
    [false, true],
    'and the roster says which of the two the desk actually has open',
  )
})

/**
 * The one thing that takes a member out of a room without a person doing it.
 *
 * A visible roster has to be able to stop being wrong: a member whose
 * conversation its own agent no longer has can never be reached again, and a
 * row nobody can address is worse than no row. The agent's own answer settles
 * it — anything softer (a hiccup, an agent that is simply not running) leaves
 * the member exactly where it was, because those pass.
 */
test('a member whose conversation its agent no longer has is dropped, and frees its name', async (t) => {
  const { team, port, room } = await rig(t)
  const gemini = peer({ sessionId: 'a', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash' })
  port.peers = [gemini]
  await joinAll(team, room, port)
  assert.deepEqual((await team.peersFor(room)).map((one) => one.nickname), ['Gemini'])

  /* The desk restarts, the conversation is gone from Cursor's own store, and
     the host — which owns the handles and the agents' error codes, and so is
     the only thing that can tell "gone" from "slow" — says so. */
  port.peers = []
  team.forget(
    'cursor' as RuntimeId,
    'a',
    "is no longer in Cursor's history, so it has been taken out of this room.",
  )

  assert.deepEqual((await team.peersFor(room)).length, 0, 'the member is off the board')
  const channel = team.stateFor(room).channel
  const notice = channel.filter((entry): entry is TeamNotice => entry.kind === 'notice').at(-1)
  assert.equal(notice?.cause, 'gone', 'and the room is told why it lost a member')
  assert.equal(notice?.about.kind === 'agent' ? notice.about.nickname : null, 'Gemini')
  assert.match(notice?.text ?? '', /taken out of this room/)

  // The name is free for the next Gemini.
  const next = peer({ sessionId: 'b', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash' })
  port.peers = [next]
  await joinAll(team, room, port)
  assert.deepEqual((await team.peersFor(room)).map((one) => one.nickname), ['Gemini'])
})

/**
 * A hiccup is not a departure.
 *
 * The counterpart of the test above, and the reason the drop is keyed on the
 * agent's own "gone" rather than on the fact of a failure: a member whose
 * agent is down, overloaded, or simply slow comes back, and taking it out of
 * the room would lose the membership a person set up.
 */
test('a send that merely failed leaves the member in the room', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [peer({ sessionId: 'a', title: null, model: 'gpt-5.4-mini' })]
  await joinAll(team, room, port)

  port.peers = []
  port.failSends = 1
  await team.post(room, 'Morning — where are we?')

  assert.equal((await team.peersFor(room)).length, 1, 'still a member')
  const last = team.stateFor(room).channel.filter((entry): entry is TeamMessage => entry.kind === 'message').at(-1)
  assert.equal(last?.state, 'refused')
  assert.match(last?.reason ?? '', /backend hiccup/)
})

/** Forgetting reaches the rooms the member was in, and stops there. */
test('forgetting a conversation leaves the rooms it was never in alone', async (t) => {
  const { team, port, room } = await rig(t)
  const other = (await team.createRoom('/repo', 'Elsewhere')).id
  port.peers = [
    peer({ sessionId: 'a', title: null, model: 'gpt-5.4-mini' }),
    peer({ sessionId: 'b', title: null, runtime: 'claude' as RuntimeId, agent: 'Claude Code', model: 'claude-opus-5' }),
  ]
  // A conversation is in one room at a time, so these are two rooms of one.
  await team.joinRoom(room, 'codex' as RuntimeId, 'a')
  await team.joinRoom(other, 'claude' as RuntimeId, 'b')

  team.forget('codex' as RuntimeId, 'a', 'has been taken out of this room.')
  assert.deepEqual(await team.peersFor(room), [], 'the room it was in loses it')
  assert.deepEqual(
    (await team.peersFor(other)).map((one) => one.sessionId),
    ['b'],
    'the other room is untouched',
  )
  assert.equal(
    team.stateFor(other).channel.filter((entry) => entry.kind === 'notice').length,
    0,
    'and hears nothing about it',
  )
})

/**
 * A name is reserved by a member of *this* room, not by anyone still running.
 *
 * `#nameOn` deduped against every live peer anywhere, and `nicknames` is never
 * pruned — so a GPT that moved to another room still held "GPT" on the one it
 * left, and the next GPT added there was greeted as "GPT 2" while being the
 * only GPT in the place. The comment above it already said names are unique
 * among the members who are *here*; "here" stopped meaning the folder when
 * rooms got members of their own.
 */
test('a member that leaves a room stops reserving its name there', async (t) => {
  const { team, port, room } = await rig(t)
  const elsewhere = (await team.createRoom('/repo', 'Elsewhere')).id
  const gpt = peer({ sessionId: 'g1', title: null, agent: 'Codex', model: 'gpt-5.4-mini' })
  port.peers = [gpt]
  await team.joinRoom(room, 'codex' as RuntimeId, 'g1')
  assert.deepEqual((await team.peersFor(room)).map((one) => one.nickname), ['GPT'])

  // It moves rooms, and a replacement arrives in the one it left.
  await team.joinRoom(elsewhere, 'codex' as RuntimeId, 'g1')
  const replacement = peer({ sessionId: 'g2', title: null, agent: 'Codex', model: 'gpt-5.4-mini' })
  port.peers = [gpt, replacement]
  await team.joinRoom(room, 'codex' as RuntimeId, 'g2')

  assert.deepEqual(
    (await team.peersFor(room)).map((one) => one.nickname),
    ['GPT'],
    'the only one of its kind in the room takes the plain name',
  )
})

test('a member that comes back keeps its name, unless somebody living took it', async (t) => {
  const { team, port, room } = await rig(t)
  const first = peer({ sessionId: 'a', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash' })
  port.peers = [first]
  await joinAll(team, room, port)
  await team.peersFor(room)

  // Away and back with nobody else around: the same name.
  port.peers = []
  await team.peersFor(room)
  port.peers = [first]
  assert.deepEqual((await team.peersFor(room)).map((one) => one.nickname), ['Gemini'])

  // Away, its name taken by a live member, and back: renamed rather than
  // allowed to collide. Two members answering to one name is the state this
  // exists to end, and addressing depends on it.
  port.peers = [
    peer({ sessionId: 'b', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash' }),
  ]
  await joinAll(team, room, port)
  await team.peersFor(room)
  port.peers = [...port.peers, first]
  const names = (await team.peersFor(room)).map((one) => one.nickname)
  assert.equal(new Set(names).size, names.length, `names stay unique: ${JSON.stringify(names)}`)
})

/**
 * A goal is a boundary a Room does not have.
 *
 * A Room is permanent; the work in it is not. Without something between them
 * the board is a pile — every job anybody ever added, with nothing that can be
 * finished and no heading to read them under. "Wrap up" needs an object to
 * wrap, and this is it.
 */
test('a goal groups the work it became, and can be put away when it is done', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  const plan = team.planWork(room, 'Round half-up to whole cents')
  assert.equal(plan.state, 'running')

  team.addIntentAsUser(room, { title: 'Define the contract', files: ['src/tax.ts'], plan: plan.id })
  team.addIntentAsUser(room, { title: 'Round in checkout', files: ['src/checkout.ts'], plan: plan.id })
  // Work added directly belongs to no goal, which is the ordinary case and
  // must stay cheap.
  team.addIntentAsUser(room, { title: 'Unrelated tidy-up', files: [] })

  const grouped = team.stateFor(room).intents.filter((intent) => intent.plan === plan.id)
  assert.equal(grouped.length, 2)
  assert.equal(team.stateFor(room).intents.find((i) => i.title === 'Unrelated tidy-up')?.plan, null)

  // Refused while anything on it is live, and the refusal names what. A wrap
  // that quietly abandoned claimed work would be the most expensive button here.
  const early = team.wrapPlan(room, plan.id)
  assert.match(early, /^Refused: 2 jobs are still live/)
  assert.match(early, /#1, #2/)

  await team.claim(1, codex)
  await team.complete(1, { note: 'done' }, codex)
  assert.match(team.wrapPlan(room, plan.id), /^Refused: 1 job is still live/)

  team.intentAction(room, 2, 'abandon')
  const wrapped = team.wrapPlan(room, plan.id)
  assert.match(wrapped, /Wrapped up/)
  // The jobs stay: they are the record of what happened.
  assert.equal(team.stateFor(room).intents.filter((i) => i.plan === plan.id).length, 2)
  assert.equal(team.stateFor(room).plans?.find((p) => p.id === plan.id)?.state, 'wrapped')

  // And wrapping twice says so rather than pretending to work again.
  assert.match(team.wrapPlan(room, plan.id), /already wrapped up/)
  assert.match(team.wrapPlan(room, 99), /no goal #99/)
})

test('a goal survives a restart, and a job cannot name one that does not exist', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  const plan = team.planWork(room, 'Ship the migration')
  team.addIntentAsUser(room, { title: 'Real', files: [], plan: plan.id })
  // A job pointing at a goal nobody made would group under a heading the board
  // cannot draw, and vanish.
  team.addIntentAsUser(room, { title: 'Imagined', files: [], plan: 404 })
  assert.equal(team.stateFor(room).intents.find((i) => i.title === 'Imagined')?.plan, null)

  await team.flush()
  assert.deepEqual(
    team.stateFor(room).plans?.map((p) => p.goal),
    ['Ship the migration'],
  )
})

/**
 * The whole thing, once, in order.
 *
 * Every part of the plane is covered above in isolation. This is the sentence
 * they add up to — a person names a goal, work is split under it, agents take
 * it in turn, what one learned reaches the next, and the goal is put away — and
 * it is here because the parts have twice agreed with themselves and disagreed
 * with each other. A takeover that passed the state check and was refused by
 * the file check was invisible to every unit test on this page.
 */
test('workflow: a goal becomes work, the work becomes a handover, the goal is wrapped', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'a', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash' }),
    peer({ sessionId: 'b', title: null, runtime: 'claude' as RuntimeId, agent: 'Claude', model: 'haiku' }),
  ]
  await joinAll(team, room, port)
  const [gemini, haiku] = await team.peersFor(room)
  assert.deepEqual([gemini?.nickname, haiku?.nickname], ['Gemini', 'Haiku'])
  const asGemini = { runtime: 'cursor', sessionId: 'a' }
  const asHaiku = { runtime: 'claude', sessionId: 'b' }

  // 1. A goal. Nothing has been spent and no work exists yet.
  const plan = team.planWork(room, 'Round half-up to whole cents')
  assert.equal(team.stateFor(room).intents.length, 0)

  // 2. Split under it, with the dependency that makes the order real.
  team.addIntentAsUser(room, { title: 'Define the contract', files: ['src/tax.ts'], plan: plan.id })
  team.addIntentAsUser(room, {
    title: 'Round in checkout',
    files: ['src/checkout.ts'],
    dependsOn: [1],
    plan: plan.id,
  })
  const board = () => team.stateFor(room).intents
  assert.equal(board().find((one) => one.id === 2)?.blockedBy, 'graph', 'waiting, not blocked')

  // 3. The dependent job cannot be taken yet, and says why rather than how.
  assert.match(await team.claim(2, asHaiku), /waits on #1|not done/)

  // 4. Gemini takes the first and finishes it with the contract.
  assert.match(await team.claim(1, asGemini), /^Claimed #1/)
  await team.complete(
    1,
    { note: 'Contract landed', handoff: 'tax(amount, rate) rounds half-up to whole cents.' },
    asGemini,
  )

  // 5. The second frees itself — nobody had to notice.
  assert.equal(board().find((one) => one.id === 2)?.state, 'open')

  // 6. Haiku takes it and is handed the contract without asking for it.
  const taken = await team.claim(2, asHaiku)
  assert.match(taken, /rounds half-up to whole cents/, `the handover rode the claim: ${taken}`)

  // 7. It says so in the room, in its own name, to a member it can name.
  assert.doesNotMatch(
    await team.send({ to: 'Gemini', text: 'Contract applied in checkout.' }, asHaiku),
    /^Refused/,
  )
  const said = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
    .at(-1)
  assert.equal(said?.from.kind === 'agent' ? said.from.nickname : null, 'Haiku')
  assert.equal(said?.to?.nickname, 'Gemini')

  // 8. The goal cannot be wrapped while that job is live, and says what.
  assert.match(team.wrapPlan(room, plan.id), /1 job is still live/)

  // 9. Finished, and put away. The work stays as the record.
  await team.complete(2, { note: 'Done' }, asHaiku)
  assert.match(team.wrapPlan(room, plan.id), /Wrapped up/)
  assert.equal(board().length, 2, 'the record survives the goal being wrapped')
  assert.equal(team.stateFor(room).plans?.[0]?.state, 'wrapped')

  // 10. And the audit has an entry per agent act, with none for the person's —
  // who needs no alibi on their own board.
  const acts = port.audited.filter((entry) => entry.kind === 'team/intent')
  assert.ok(acts.length >= 4, `claims and completions are audited: ${acts.length}`)
})

/**
 * The other ending: work that outlives the agent doing it.
 *
 * The happy path above is the one everybody designs. This is the one that
 * decides whether a board is usable on a laptop — an agent that crashes, sleeps
 * or runs out of quota mid-claim, and what a person can do about it.
 */
test('workflow: a claim outlives its agent, and the work is recoverable', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'a', title: null, runtime: 'cursor' as RuntimeId, agent: 'Cursor', model: 'gemini-3.7-flash' }),
    peer({ sessionId: 'b', title: null, runtime: 'claude' as RuntimeId, agent: 'Claude', model: 'haiku' }),
  ]
  await joinAll(team, room, port)
  await team.peersFor(room)
  const asGemini = { runtime: 'cursor', sessionId: 'a' }
  const asHaiku = { runtime: 'claude', sessionId: 'b' }

  team.addIntentAsUser(room, { title: 'Migrate the callers', files: ['src/api/**'] })
  await team.claim(1, asGemini)

  // The agent goes. Its lease has not run out, so the work is still its own —
  // taking it here would rob an agent that is coming back.
  port.peers = port.peers.filter((one) => one.sessionId !== 'a')
  assert.match(await team.claim(1, asHaiku), /already claimed/)

  // The lease runs out. Now the work is free, the files it owned are free with
  // it, and the takeover is on the record rather than looking ordinary.
  const held = team.stateFor(room).intents[0]
  ;(held as { claim: { leaseUntil: number } }).claim.leaseUntil = Date.now() - 1
  assert.match(await team.conflicts(['src/api/**'], asHaiku), /Clear to work there/)
  assert.match(await team.claim(1, asHaiku), /^Claimed #1/)
  assert.ok(
    team
      .stateFor(room)
      .channel.some((entry) => (entry as { detail?: string }).detail?.includes('whose claim ran out')),
  )

  // And the person can still finish it, whoever is holding it now.
  team.intentAction(room, 1, 'done')
  assert.equal(team.stateFor(room).intents[0]?.state, 'done')
})


test('a renewed lease survives a restart', async (t) => {
  // `#patchIntent` edits the board in memory; the write and the push are
  // `#commit`'s. A renewal that stopped at the patch was a renewal that
  // vanished on reload — and a restart after the *original* deadline, with the
  // holder briefly unattached, would then hand recently renewed work to a
  // second agent, both owning the same paths.
  const { team, port, dir, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Long job', files: ['src/**'] }, codex)
  await team.claim(1, codex)
  await team.flush()

  const claimed = team.stateFor(room).intents[0]?.claim?.leaseUntil
  assert.ok(typeof claimed === 'number', 'the claim took a lease')

  // Time passes, and the holder is still working — `list_intents` renews.
  await new Promise((resolve) => setTimeout(resolve, 5))
  await team.board(codex)
  await team.flush()
  const renewed = team.stateFor(room).intents[0]?.claim?.leaseUntil
  assert.ok(renewed !== undefined && renewed > (claimed as number), 'the lease moved')

  const reborn = new Team(dir, {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  })
  await reborn.load()
  assert.equal(
    reborn.stateFor(room).intents[0]?.claim?.leaseUntil,
    renewed,
    'the renewal was written, not just held in memory',
  )
})

test('get_team_status offers the names agent_message accepts', async (t) => {
  // Two untitled Cursor conversations rendered as two identical
  // "(untitled) — Cursor" rows, so an agent reading its own roster could not
  // name a unique recipient — in exactly the room the nicknames exist for.
  const { team, port, room } = await rig(t)
  port.peers = [
    peer({ sessionId: 'c1', runtime: 'cursor' as RuntimeId, agent: 'Cursor', title: null, model: 'gemini-3.7-flash' }),
    peer({ sessionId: 'c2', runtime: 'cursor' as RuntimeId, agent: 'Cursor', title: null, model: 'claude-opus-5' }),
  ]
  await joinAll(team, room, port)
  // Cold board: this is the first team verb on the project, which is exactly
  // when the fallback used to fire.
  const said = await team.status({ runtime: 'cursor' as RuntimeId, sessionId: 'c1' })
  const rows = said.split('\n').filter((line) => line.startsWith('- '))

  assert.equal(rows.length, 2)
  // Named, not merely distinct: an earlier version of this test passed on two
  // "Cursor" rows because "(you)" on one of them made the strings differ.
  assert.ok(said.includes('Gemini'), 'the Gemini member is offered by name')
  assert.ok(said.includes('Opus'), 'the Opus member is offered by name')
  assert.ok(!said.includes('(untitled)'), 'no member is offered as "(untitled)"')

  // And those names are the board's own, so `agent_message` accepts them.
  const named = Object.values(team.stateFor(room).nicknames ?? {})
  assert.deepEqual([...named].sort(), ['Gemini', 'Opus'])
  for (const name of named) assert.ok(said.includes(name), `status names ${name}`)
  assert.match(await team.send({ to: 'Gemini', text: 'hello' }, { runtime: 'cursor' as RuntimeId, sessionId: 'c2' }), /Gemini/)
})

test('a claim declares the files it will touch, and owning none says so', async (t) => {
  // The paths are usually not known when the work is written down: the board's
  // own input has no field for them, and an agent only learns which files it
  // needs after reading. Every claim in a real three-agent run therefore owned
  // nothing, and the board could promise one-claim-per-job and not one-agent-
  // per-file — the half of the guarantee people actually want.
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Fix the refill' }, codex)
  await team.addIntent({ title: 'Round the money' }, codex)

  const bare = await team.claim(2, claude)
  assert.match(bare, /owns no files yet/, 'a claim with nothing declared says the gap out loud')

  const held = await team.claim(1, codex, ['src/limiter.js'])
  assert.match(held, /You own src\/limiter\.js/)
  assert.deepEqual(team.stateFor(room).intents[0]?.files, ['src/limiter.js'])

  // And it is enforced from that moment, exactly as a file written down in
  // advance would have been.
  await team.release(1, {}, codex)
  await team.addIntent({ title: 'Touch the limiter too', files: ['src/limiter.js'] }, codex)
  await team.claim(1, codex, ['src/limiter.js'])
  const refused = await team.claim(3, claude)
  assert.match(refused, /overlap a live claim/)
})

test('a claim adds its files to the ones the intent already owned', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'API work', files: ['src/api/**'] }, codex)

  await team.claim(1, codex, ['test/api.test.js'])
  assert.deepEqual(team.stateFor(room).intents[0]?.files, ['src/api/**', 'test/api.test.js'])
})

test('using the board is observed, not taken on the runtime’s word', async (t) => {
  // A member advertised the plugin tools, listed them back accurately when
  // asked, and could not invoke one. The rail's "cannot take jobs" chip reads
  // the advertisement, so it never fired on the one member it was built for.
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  const before = await team.peersFor(room)
  assert.deepEqual(before.map((one) => one.usedBoard), [false, false], 'nothing proved yet')

  await team.addIntent({ title: 'Something to take' }, codex)

  const after = await team.peersFor(room)
  const codexPeer = after.find((one) => one.sessionId === 'c1')
  const claudePeer = after.find((one) => one.sessionId === 'k1')
  assert.equal(codexPeer?.usedBoard, true, 'the one that called a verb is seen')
  assert.equal(claudePeer?.usedBoard, false, 'the one that has not, is not')
})

test('a holder can add paths it only discovered after taking the work', async (t) => {
  // The claim's own answer tells an agent that owns nothing to "claim again
  // with files". That retry hit the already-held branch and returned before
  // reading them, so the advice was impossible to follow.
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Fix the refill' }, codex)

  assert.match(await team.claim(1, codex), /owns no files yet/)
  const widened = await team.claim(1, codex, ['src/limiter.js'])
  assert.match(widened, /now own src\/limiter\.js/)
  assert.deepEqual(team.stateFor(room).intents[0]?.files, ['src/limiter.js'])

  // And it is enforced from that moment.
  await team.addIntent({ title: 'Also the limiter', files: ['src/limiter.js'] }, codex)
  assert.match(await team.claim(2, claude), /overlap a live claim/)
})

test('a widened claim cannot take a path somebody else holds', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Totals', files: ['src/totals.js'] }, codex)
  await team.addIntent({ title: 'Limiter' }, codex)
  await team.claim(1, claude, [])
  await team.claim(2, codex)

  const refused = await team.claim(2, codex, ['src/totals.js'])
  assert.match(refused, /you hold #2/)
  assert.match(refused, /still yours/)
  assert.deepEqual(team.stateFor(room).intents[1]?.files, [], 'nothing was taken')
})

test('claim-time paths are canonical, so one file has one spelling', async (t) => {
  // `src/../README.md` and `README.md` are the same file. Trimmed but not
  // normalised, both claims succeeded and neither conflicted — which is the
  // whole guarantee, defeated by spelling.
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Docs' }, codex)
  await team.addIntent({ title: 'Docs again' }, codex)

  await team.claim(1, codex, ['src/../README.md'])
  assert.deepEqual(team.stateFor(room).intents[0]?.files, ['README.md'])
  assert.match(await team.claim(2, claude, ['README.md']), /overlap a live claim/)
})

test('a claim will not own a path outside the project', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Anything' }, codex)

  const refused = await team.claim(1, codex, ['/tmp/absolute.txt', '../../shared/config.json'])
  assert.match(refused, /outside this workspace/)
  assert.equal(team.stateFor(room).intents[0]?.state, 'open', 'and nothing was claimed')
})

test('the user is refused an unownable path rather than quietly losing it', async (t) => {
  // `#addIntent` drops what the board cannot own, which is right for what it
  // stores and wrong as an answer: the long form closed on a card owning one
  // of three typed paths and said nothing about the other two.
  const { team, room } = await rig(t)
  assert.throws(
    () =>
      team.addIntentAsUser(room, {
        title: 'Validate the query',
        files: ['src/ok.ts', '/tmp/absolute.txt', '../../shared/config.json'],
      }),
    /outside this workspace/,
  )
  assert.equal(team.stateFor(room).intents.length, 0, 'and nothing was added')
})

test('what a member proved about one process is not carried to the next', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  await team.addIntent({ title: 'Something' }, codex)
  assert.equal(
    (await team.peersFor(room)).find((one) => one.sessionId === 'c1')?.usedBoard,
    true,
  )

  // The agent process goes. The same conversation reattaching to a fresh one
  // has proved nothing yet — witnessing exists precisely so the answer belongs
  // to a process rather than to a name.
  team.onRuntimeDetached('codex' as RuntimeId)
  assert.equal(
    (await team.peersFor(room)).find((one) => one.sessionId === 'c1')?.usedBoard,
    false,
  )
})

/**
 * The root a board was written under is put back through the resolver, and
 * the correction is written to disk.
 *
 * `root` is the string `roomsFor` filters on and `joinRoom` compares against
 * what the host resolves for a joining conversation's folder. So changing how
 * the host resolves a folder changes what that string has to be, and a board
 * written under the old rule — a submodule resolved to whatever workspace was
 * open, a repository whose open parent folder stood in for it — would
 * otherwise be left keyed by a path nothing resolves to any more: a room in a
 * folder of its own, drawn beside its own conversations and refusing them.
 */
test('a stored root is re-resolved on load, and the room is joinable at the new one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-reroot-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const stale: TeamPort = {
    peers: () => [],
    // The rule of the day the board was written: the folder above the project.
    rootOf: async () => '/work',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const before = new Team(dir, stale)
  const room = (await before.createRoom('/work/repo', 'API')).id
  assert.equal(before.stateFor(room).root, '/work')
  await before.flush()

  // The rule of today: the repository itself, whatever is open above it.
  const live: TeamPeer[] = [peer({ sessionId: 'c1', cwd: '/work/repo' })]
  const port: TeamPort = { ...stale, peers: () => live, rootOf: async () => '/work/repo' }
  const after = new Team(dir, port)
  await after.load()
  assert.equal(after.stateFor(room).root, '/work/repo', 'the board moved to the project')
  assert.deepEqual(
    after.roomsFor('/work/repo').map((state) => state.id),
    [room],
    'and is found under it',
  )
  assert.deepEqual(after.roomsFor('/work'), [], 'and not under the folder above it')
  // And the conversations working there can still get in, which is the whole
  // point of migrating rather than leaving the board on the old key: the
  // check is `rootOf(cwd) === board.root`, so a board left behind refuses
  // every conversation in its own project.
  await after.joinRoom(room, 'codex' as RuntimeId, 'c1')
  assert.deepEqual(after.stateFor(room).members, ['codex\u0000c1'])
  await after.flush()

  // Written back, not recomputed on every launch: a third reader with a
  // resolver that has nothing to say still finds the corrected root.
  const later = new Team(dir, { ...stale, rootOf: async () => null })
  await later.load()
  assert.equal(later.stateFor(room).root, '/work/repo', 'the correction reached the file')
  await later.flush()
})

/**
 * A room whose folder is gone keeps the only note of where it was.
 *
 * Every scratch room a demo ever made is in this state — `/tmp/hd-room-demo`
 * and friends are on disk with no folder behind them — and a migration that
 * took the resolver's `null` as an answer would blank their root, which is
 * the one field saying which project they belonged to.
 */
test('a board whose folder the resolver cannot place keeps its recorded root', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-reroot-gone-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const port: TeamPort = {
    peers: () => [],
    rootOf: async () => '/tmp/hd-room-demo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const before = new Team(dir, port)
  const room = (await before.createRoom('/tmp/hd-room-demo', 'Demo')).id
  await before.flush()

  // The folder has since been deleted, so the resolver has nothing to say.
  const after = new Team(dir, { ...port, rootOf: async () => null })
  await after.load()
  assert.equal(after.stateFor(room).root, '/tmp/hd-room-demo')
  await after.flush()
})

/**
 * A resolver that throws leaves every board where it was found.
 *
 * `rootOf` shells out to git. A migration that let one folder's failure escape
 * would abandon the loop, and every board after it in the directory listing
 * would simply not be read — rooms vanishing from the tree because a stale
 * path made git exit non-zero.
 */
test('a resolver that throws does not cost the boards their roots', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-reroot-throw-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const port: TeamPort = {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const before = new Team(dir, port)
  const first = (await before.createRoom('/repo', 'One')).id
  const second = (await before.createRoom('/repo', 'Two')).id
  await before.flush()

  const after = new Team(dir, {
    ...port,
    rootOf: async () => {
      throw new Error('git is not on the PATH')
    },
  })
  await after.load()
  assert.deepEqual(
    after.states().map((state) => state.root).sort(),
    ['/repo', '/repo'],
    'both boards kept their roots',
  )
  assert.deepEqual(after.states().map((state) => state.id).sort(), [first, second].sort())
  await after.flush()
})

/**
 * The pre-multiple-rooms file, whose name is the *folder* rather than the
 * room, still loads — and its root is migrated too.
 *
 * Those files carry no `root` and no `id` at all: both are read out of the
 * filename. They are also the oldest boards on any machine, so they are the
 * likeliest to be keyed under a rule nothing uses any more; a migration that
 * only looked at `raw.root` would skip exactly the ones that need it.
 */
test('a board from the one-per-folder era loads, and its root is migrated', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-legacy-file-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const { writeFile: write } = await import('node:fs/promises')
  await write(
    join(dir, `${encodeURIComponent('/work/repo')}.json`),
    JSON.stringify({
      nextIntent: 1,
      messaging: true,
      intents: [],
      channel: [],
      nicknames: { 'codex\u0000c1': 'Ada' },
    }),
  )

  const team = new Team(dir, {
    peers: () => [],
    rootOf: async (cwd) => (cwd === '/work/repo' ? '/work/repo/inner' : null),
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  })
  await team.load()
  const [state] = team.states()
  assert.equal(state?.id, '/work/repo', 'the filename is still the room’s id')
  assert.equal(state?.name, 'repo', 'and still names the room after the folder')
  assert.deepEqual(state?.members, ['codex\u0000c1'], 'and everyone the board had met is a member')
  assert.equal(state?.root, '/work/repo/inner', 'and the root went through the resolver')
  await team.flush()
})

/**
 * A board is never moved *up* — the guard the doc promises, in code.
 *
 * `#reroot` unconditionally took `rootOf(recorded)`, and the resolver answers
 * with the repository containing *any* folder it is handed. So a board keyed
 * by a parent folder — the one case the recorded root cannot settle, because
 * nothing on disk says which repository underneath it the room was for — was
 * re-keyed to whatever repository happened to enclose that parent: a `git
 * init` over `~/code`, a dotfiles repo above the checkouts. Measured with
 * real repositories before writing this: a folder `outer/work` holding a
 * repository `outer/work/repo` resolves to `outer`.
 *
 * The board would then be in a project it has no relationship to, and the
 * recorded root — the only note of where it was — overwritten and written to
 * disk. The correct answer for such a board is always *below* what was
 * recorded and the resolver can only ever answer at or above it, so an answer
 * that encloses the recorded root is by construction not the room's project.
 */
test('a board is not re-keyed to a folder that merely contains the one recorded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-reroot-up-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const port: TeamPort = {
    peers: () => [],
    rootOf: async () => '/outer/work',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const before = new Team(dir, port)
  // The room's real project is `/outer/work/repo`; the board was keyed by the
  // parent the person had open, which is all the file records.
  const room = (await before.createRoom('/outer/work/repo', 'API')).id
  assert.equal(before.stateFor(room).root, '/outer/work')
  await before.flush()

  // `/outer/work` is itself inside a repository, so the resolver answers with
  // that — an enclosing folder, and not this room's project.
  const after = new Team(dir, { ...port, rootOf: async () => '/outer' })
  await after.load()
  assert.equal(after.stateFor(room).root, '/outer/work', 'the board stayed where it was found')
  await after.flush()

  // And the file was not rewritten either: the recorded root survives the
  // launch, so a later fix still has something to work from.
  const later = new Team(dir, { ...port, rootOf: async () => null })
  await later.load()
  assert.equal(later.stateFor(room).root, '/outer/work', 'and the note of where it was is still on disk')
  await later.flush()
})

/**
 * A sibling folder is not an enclosing one.
 *
 * The containment test is on path segments, not on the string: `/repo` must
 * not be read as containing `/repo-fork`, or a perfectly good migration
 * between two projects whose names share a prefix would be refused.
 */
test('the “never move up” guard is on folders, not on string prefixes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-reroot-sibling-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const port: TeamPort = {
    peers: () => [],
    rootOf: async () => '/repo-fork',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const before = new Team(dir, port)
  const room = (await before.createRoom('/repo-fork', 'Fork')).id
  await before.flush()

  const after = new Team(dir, { ...port, rootOf: async () => '/repo' })
  await after.load()
  assert.equal(after.stateFor(room).root, '/repo', '/repo does not contain /repo-fork')
  await after.flush()
})

/**
 * Launch is not held by the migration.
 *
 * The resolver shells out to git, and this pass is on the path
 * `Host.start()` awaits. Serially, a desk with rooms in five projects paid
 * five probes before its window could open; one repository on a disconnected
 * volume would have held the app for git's own 30-second timeout. So the pass
 * is concurrent and on a clock, and a root that has not answered in time
 * keeps what was recorded and is migrated at the next launch instead — which
 * is safe because a root already corrected resolves to itself.
 */
test('a resolver that never answers does not hold the desk shut', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-reroot-slow-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const port: TeamPort = {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const before = new Team(dir, port)
  const room = (await before.createRoom('/repo', 'One')).id
  await before.flush()

  const after = new Team(
    dir,
    {
      ...port,
      // A folder on a volume that is not answering.
      rootOf: () => new Promise<string>(() => {}),
    },
    // The real budget is seconds; the mechanism is the same at fifty
    // milliseconds, and the suite should not sit through the deadline to
    // watch it work.
    { migrationBudgetMs: 50 },
  )
  const started = Date.now()
  await after.load()
  const waited = Date.now() - started
  /* Deliberately loose, and it is the looseness that makes it safe: returning
     at all is already the proof, since a resolver that never settles leaves
     the deadline as the only way out and a regression that dropped it would
     hang here rather than fail. The number is only there to separate the two
     regressions a hang would not catch — waiting out git's own 30s, or
     reading the constant instead of the injected budget and waiting 4s — and
     tightening it towards the 50ms budget would trade that for a race against
     the scheduler on a loaded machine. */
  assert.ok(waited < 2000, `load returned without waiting out the resolver (waited ${waited}ms)`)
  assert.equal(after.stateFor(room).root, '/repo', 'and the board kept the root it was written with')
  await after.flush()
})

/**
 * One slow folder does not hold up the others, and the one it did hold up is
 * migrated at the next launch.
 *
 * The deadline test above proves "nothing answered". This is the case that
 * actually happens: a desk with rooms in several projects, one of them on a
 * volume that has gone away. Every board is resolved independently inside one
 * `Promise.all`, so the answers that arrive are applied and the one that does
 * not is simply left as recorded — and because the pass is idempotent, the
 * next launch finishes the job. That deferral is the whole reason a deadline
 * is safe rather than lossy, and it was the one part of the design nothing
 * pinned.
 */
test('a folder that does not answer defers only itself, and is migrated next launch', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-reroot-partial-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const port: TeamPort = {
    peers: () => [],
    rootOf: async (cwd) => cwd,
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const before = new Team(dir, port)
  // The stalled one first, so the test does not pass by luck of iteration
  // order: one board at a time, this is the board everything else waits
  // behind, and nothing would be migrated at all.
  const stalled = (await before.createRoom('/slow', 'Slow')).id
  const quick = (await before.createRoom('/fast', 'Fast')).id
  await before.flush()

  const partial = new Team(
    dir,
    {
      ...port,
      rootOf: async (cwd) =>
        cwd === '/slow' ? new Promise<string>(() => {}) : `${cwd}/repo`,
    },
    { migrationBudgetMs: 50 },
  )
  await partial.load()
  assert.equal(partial.stateFor(quick).root, '/fast/repo', 'the folder that answered was migrated')
  assert.equal(partial.stateFor(stalled).root, '/slow', 'and the one that did not kept what was recorded')
  await partial.flush()

  // The volume is back. Nothing about the first launch has to be undone: the
  // board that already moved resolves to itself, and the one that was left
  // finishes now.
  const later = new Team(dir, { ...port, rootOf: async (cwd) => (cwd.endsWith('/repo') ? cwd : `${cwd}/repo`) })
  await later.load()
  assert.equal(later.stateFor(quick).root, '/fast/repo', 'the first launch\u2019s work stands')
  assert.equal(later.stateFor(stalled).root, '/slow/repo', 'and the deferred one is migrated now')
  await later.flush()
})

/**
 * Git coming and going across launches never corrupts a root.
 *
 * `#reroot` keeps what was recorded when the resolver throws, and the whole
 * deadline design rests on the pass being idempotent — so the sequence that
 * matters is not one launch but several, with git answering, then not, then
 * answering again. A board must end where the working answer put it, and must
 * never be walked somewhere new by a launch that could not ask.
 */
test('a resolver that comes and goes across launches leaves the root where the working answer put it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-reroot-flapping-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const port: TeamPort = {
    peers: () => [],
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const before = new Team(dir, port)
  const room = (await before.createRoom('/repo', 'API')).id
  await before.flush()

  const broken = {
    ...port,
    rootOf: async () => {
      throw new Error('git is not on the PATH')
    },
  }
  // Launch one: git is missing. Nothing moves, and nothing is written.
  const first = new Team(dir, broken)
  await first.load()
  assert.equal(first.stateFor(room).root, '/repo')
  await first.flush()

  // Launch two: git is back and the root really does belong deeper.
  const second = new Team(dir, { ...port, rootOf: async (cwd) => (cwd === '/repo' ? '/repo/inner' : cwd) })
  await second.load()
  assert.equal(second.stateFor(room).root, '/repo/inner', 'the working answer was taken')
  await second.flush()

  // Launch three: git is missing again. The migrated root is what is on disk
  // now, and a launch that cannot ask must not undo it.
  const third = new Team(dir, broken)
  await third.load()
  assert.equal(third.stateFor(room).root, '/repo/inner', 'and a launch that could not ask left it alone')
  await third.flush()

  // Launch four: git answers, and answers the same. Idempotent, so there is
  // nothing left to do and nothing to undo.
  const fourth = new Team(dir, { ...port, rootOf: async (cwd) => cwd })
  await fourth.load()
  assert.equal(fourth.stateFor(room).root, '/repo/inner', 'and asking again changes nothing')
  await fourth.flush()
})

/**
 * Every folder is asked at once, however many rooms a desk has.
 *
 * Raised in review as "no perf test for very large board counts". A wall-clock
 * one would be a race rather than a proof, so the property is pinned
 * structurally instead: the resolver holds every answer until *all* of them
 * have been asked for. Concurrently that barrier lifts and every board
 * migrates; one board at a time it can never lift, the first call waits
 * forever, the deadline fires and nothing migrates at all. So the assertion
 * below is false unless the probes really do overlap — the thing a serial
 * loop would cost a person one git probe per project at launch.
 */
test('every stored root is resolved at once, not one project at a time', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-team-reroot-many-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const count = 32
  const port: TeamPort = {
    peers: () => [],
    rootOf: async (cwd) => cwd,
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const before = new Team(dir, port)
  const rooms: string[] = []
  for (let n = 0; n < count; n += 1) rooms.push((await before.createRoom(`/project-${n}`, `Room ${n}`)).id)
  await before.flush()

  let asked = 0
  let lift: () => void = () => undefined
  const barrier = new Promise<void>((resolve) => {
    lift = resolve
  })
  const after = new Team(
    dir,
    {
      ...port,
      rootOf: async (cwd) => {
        asked += 1
        if (asked === count) lift()
        await barrier
        return `${cwd}/repo`
      },
    },
    { migrationBudgetMs: 1000 },
  )
  await after.load()
  assert.equal(asked, count, 'every folder was asked')
  assert.deepEqual(
    rooms.map((id) => after.stateFor(id).root).filter((root) => !root.endsWith('/repo')),
    [],
    'and every board was migrated, which only happens if the asks overlapped',
  )
  await after.flush()
})

/**
 * A room refuses a conversation from another project whichever way it is
 * described to it.
 *
 * The live-peer check was the only one, so a caller handing over a stored
 * conversation's card — which is how a room is staffed after a relaunch —
 * got in unchecked. `team/room/join` does its own check with a better
 * sentence; this is what makes the *method* safe rather than the one caller
 * that happens to be careful. A room that takes a conversation from another
 * project hands it a board belonging to work it has never done.
 */
test('a stored conversation from another project is refused by the engine itself', async (t) => {
  const { team, room } = await rig(t)
  await assert.rejects(
    () =>
      team.joinRoom(room, 'codex' as RuntimeId, 'elsewhere', {
        title: 'Other work',
        agent: 'Codex',
        cwd: '/somewhere-else',
        model: null,
        at: 1,
      }),
    /outside \/repo/,
  )
  assert.deepEqual(team.stateFor(room).members, [], 'and nothing was written down')
})

/** The same check still passes what it should: a card from inside the project. */
test('a stored conversation from this project joins on its card alone', async (t) => {
  const { team, port, room } = await rig(t)
  await team.joinRoom(room, 'codex' as RuntimeId, 'stored', {
    title: 'API migration',
    agent: 'Codex',
    cwd: '/repo/packages/api',
    model: 'gpt-5.4-mini',
    at: 1,
  })
  const roster = await team.peersFor(room)
  assert.deepEqual(
    roster.map((one) => `${one.nickname} ${one.here ? 'here' : 'away'}`),
    ['GPT away'],
    'drawn at once, from the card, without ever being opened',
  )
  assert.deepEqual(port.moved, ['codex/stored'], 'and the host is told membership moved')
})

/** Leaving says so too — it is the other half of one membership's lifetime. */
test('leaving a room tells the host that membership moved', async (t) => {
  const { team, port, room } = await rig(t)
  port.peers = [peer({ sessionId: 'c1' })]
  await joinAll(team, room, port)
  port.moved.length = 0
  team.leaveRoom(room, 'codex' as RuntimeId, 'c1')
  assert.deepEqual(port.moved, ['codex/c1'])
})

/**
 * A member that is let go does not leave a promise behind it.
 *
 * `forget` took the member off the board and stopped there, so anything the
 * room had queued *for* that member stayed queued: in memory on a delivery
 * that will never run, and on screen as a row saying the message is waiting.
 * The only thing that ever corrected it was the next launch, and `load`
 * rewriting `queued` to `refused` is the last resort, not the mechanism.
 * `onSessionClosed` has always settled these; a member that can never be
 * reopened is the same event by another route.
 */
test('forgetting a member refuses what was queued for it, rather than leaving it waiting', async (t) => {
  const { team, port, room } = await rig(t)
  const busy = peer({ sessionId: 'c1', busy: true, model: 'gpt-5.4-mini' })
  port.peers = [busy]
  await joinAll(team, room, port)

  // Mid-turn, so the post is queued on the member rather than delivered.
  await team.post(room, 'When you surface, take #1.')
  const queued = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
  assert.equal(queued.at(-1)?.state, 'queued', 'the room says it is waiting')

  team.forget('codex' as RuntimeId, 'c1', 'is no longer in Codex’s history.')

  const after = team
    .stateFor(room)
    .channel.filter((entry): entry is TeamMessage => entry.kind === 'message')
  assert.equal(after.at(-1)?.state, 'refused', 'and now says it will not be')
  assert.match(after.at(-1)?.reason ?? '', /no longer in Codex/)
})

/**
 * A held message outlives the member it was for, and says so when released.
 *
 * `#settle` refuses what was *queued* — a delivery the host was going to make
 * — and deliberately does not touch what is *held*, because a held message is
 * the user's to release and taking it away would be the room deciding
 * something the person had reserved for themselves. So the row stays, and the
 * refusal happens at the moment they press: the member is no longer in the
 * room, and `deliverHeld` says exactly that. Both round-two reviewers noted
 * the lifecycle was untested rather than wrong; this is the test.
 */
test('a held message for a member that was forgotten is refused when it is released', async (t) => {
  const { team, port, room } = await rig(t)
  const codexPeer = peer({ sessionId: 'c1', model: 'gpt-5.4-mini' })
  const claudePeer = peer({
    sessionId: 'k1',
    runtime: 'claude' as RuntimeId,
    agent: 'Claude Code',
    model: 'claude-opus-5',
  })
  port.peers = [codexPeer, claudePeer]
  await joinAll(team, room, port)
  // Claude holds its inbound, so an agent message to it is parked for the user.
  team.setInbound('claude', 'k1', 'hold')
  await team.send({ to: 'Opus', text: 'Look at src/auth when you can.' }, { runtime: 'codex', sessionId: 'c1' })

  const heldRow = team
    .stateFor(room)
    .channel.find((entry): entry is TeamMessage => entry.kind === 'message' && entry.state === 'held')
  assert.ok(heldRow, 'the room is holding it for the user')

  // The receiver's conversation turns out to be gone.
  team.forget('claude' as RuntimeId, 'k1', 'is no longer in Claude Code’s history.')
  assert.equal(
    team.stateFor(room).channel.find((entry) => entry.id === heldRow.id)?.kind === 'message' &&
      (team.stateFor(room).channel.find((entry) => entry.id === heldRow.id) as TeamMessage).state,
    'held',
    'the message the user reserved is still theirs to release',
  )

  await team.deliverHeld(room, heldRow.id)
  const after = team.stateFor(room).channel.find((entry) => entry.id === heldRow.id) as TeamMessage
  assert.equal(after.state, 'refused')
  assert.match(after.reason ?? '', /no longer in this room/)
})

/**
 * The roster never outgrows the membership it exists to draw.
 *
 * Round two raised this as a growth risk: photographs are keyed by session and
 * nothing prunes them, so a board with churn might accumulate. It cannot, and
 * this is the invariant that says why — every path that ends a membership
 * takes the photograph with it (`leaveRoom`, `forget`, and the move `joinRoom`
 * makes out of the previous room), and the only path that writes one iterates
 * the members. So the set of photographs is a subset of the members, always.
 * `nicknames` is deliberately *not* pruned — a member that comes back keeps
 * its name — and that difference is the whole reason this is worth pinning.
 */
test('a board keeps a photograph only for the members it has', async (t) => {
  const { team, port, dir, room } = await rig(t)
  const other = (await team.createRoom('/repo', 'Elsewhere')).id
  const fileOf = async (id: string): Promise<{ members: string[]; roster: Record<string, unknown> }> =>
    JSON.parse(await readFile(join(dir, `${encodeURIComponent(id)}.json`), 'utf8')) as never

  port.peers = [
    peer({ sessionId: 'a', model: 'gpt-5.4-mini' }),
    peer({ sessionId: 'b', model: 'gpt-5.4-mini' }),
    peer({ sessionId: 'c', model: 'gpt-5.4-mini' }),
  ]
  await joinAll(team, room, port)
  await team.peersFor(room)
  await team.flush()
  const staffed = await fileOf(room)
  assert.deepEqual(
    Object.keys(staffed.roster).sort(),
    [...staffed.members].sort(),
    'one photograph per member, and no others',
  )

  // The three ways a membership ends: a person removes it, the agent disowns
  // it, and it joins somewhere else.
  team.leaveRoom(room, 'codex' as RuntimeId, 'a')
  team.forget('codex' as RuntimeId, 'b', 'is gone.')
  await team.joinRoom(other, 'codex' as RuntimeId, 'c')
  await team.flush()

  const emptied = await fileOf(room)
  assert.deepEqual(emptied.members, [], 'nobody is in the room')
  assert.deepEqual(Object.keys(emptied.roster), [], 'and no photograph is left behind')

  const moved = await fileOf(other)
  assert.deepEqual(moved.members.length, 1)
  assert.deepEqual(Object.keys(moved.roster).sort(), [...moved.members].sort())
})

/**
 * The roster reports each member's inbound mode, resolved.
 *
 * `setInbound` and `inboundFor` were both here from the start and the roster
 * carried neither, so `team/inbound` was a setting no surface could read back
 * — and a control that cannot show its own state is a control nobody trusts.
 * Resolved rather than raw: the map is sparse, and a member never given a mode
 * of its own follows the board's default, which is the mode that will actually
 * be applied.
 */
test('the roster says what each member does with a message, board default included', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)

  const modeOf = async (id: string): Promise<string> => {
    const roster = await team.peersFor(room)
    const found = roster.find((entry) => entry.sessionId === id)
    assert.ok(found, `${id} is in the roster`)
    return found.inbound
  }

  // Nobody has been given one, so both follow the board.
  assert.equal(await modeOf('c1'), 'accept')
  assert.equal(await modeOf('k1'), 'accept')

  team.setInbound('codex', 'c1', 'hold')
  assert.equal(await modeOf('c1'), 'hold')
  // And only that one: this is per-conversation, which is the whole
  // distinction from board-only.
  assert.equal(await modeOf('k1'), 'accept')

  team.setInbound('codex', 'c1', 'refuse')
  assert.equal(await modeOf('c1'), 'refuse')
})

/**
 * #73 — a blocked card marked done, or abandoned, stayed blocked.
 *
 * `release` and `reopen` clear `blockedReason` and `blockedBy`; `done` and
 * `abandon` did not, so a card could read done and blocked at once — and the
 * board draws `blockedReason` ahead of the card's own note, so the Done column
 * showed why the work had once been stopped instead of how it finished.
 */
test('a blocked card marked done or abandoned is no longer blocked', async (t) => {
  const { team, room } = await rig(t)
  for (const action of ['done', 'abandon'] as const) {
    const intent = team.addIntentAsUser(room, { title: `stuck, then ${action}` })
    team.intentAction(room, intent.id, 'block', 'waiting on legal')
    const blocked = team.stateFor(room).intents.find((entry) => entry.id === intent.id)
    // The control: it really was blocked, by hand, with the reason given.
    assert.equal(blocked?.blockedReason, 'waiting on legal')
    assert.equal(blocked?.blockedBy, 'hand')

    team.intentAction(room, intent.id, action)
    const after = team.stateFor(room).intents.find((entry) => entry.id === intent.id)
    assert.equal(after?.state, action === 'done' ? 'done' : 'abandoned')
    assert.equal(after?.blockedReason, null, `${action} leaves no block reason behind`)
    assert.equal(after?.blockedBy, null, `${action} leaves nothing blocking it`)
  }
})

/**
 * #35 — a write coalesced into one pass, settled by another.
 *
 * `#write` coalesces a write into the pass already queued for its file. The
 * waiters were drained at the *end* of a pass from a list the whole file
 * shared, so a caller could join it after the pass had started writing: the
 * file no longer read as queued, the next write opened a new pass, and a
 * write after that coalesced into the new pass while sitting in the old
 * list. The old pass then settled it — reporting a delete done while the file
 * was still there.
 *
 * Deterministic rather than timed. Pass A is queued on an idle chain, so it
 * runs before the `await` below returns and parks in `mkdir`; C and D are
 * issued while it is on disk; and removing the file needs a threadpool round
 * trip that cannot finish inside a microtask checkpoint. So when D is wrongly
 * settled, the file is still there by construction, not by luck.
 */
test('a delete that joins a later pass is not reported done by the earlier one', async (t) => {
  const { team, dir, room } = await rig(t)
  const file = join(dir, `${encodeURIComponent(room)}.json`)
  await team.flush()
  assert.equal(existsSync(file), true, 'the room is on disk to begin with')

  team.renameRoom(room, 'first') // A: opens a pass
  await Promise.resolve() // A starts, stops taking callers, and parks on disk
  team.renameRoom(room, 'second') // C: the file is no longer queued, so a new pass
  await team.deleteRoom(room) // D: coalesces into C, and is awaited

  // Told the room is gone, it has to be gone.
  assert.equal(existsSync(file), false, 'the file is gone when the delete says it is')
})

/**
 * The other half of #35, which all three reviewers asked for: a pass that
 * fails reports the failure to every caller it carries — the one coalesced
 * into it as well as the one that opened it.
 *
 * One pass, not two. The shape review described — an earlier pass that
 * succeeds, then a later one that fails — needs the disk to change between
 * two passes, and nothing can stand there: the later pass issues its unlink
 * in the same microtask turn the earlier one finishes in, before any test
 * code runs again, and whatever makes an unlink fail from the start makes
 * the earlier pass's write fail too. The two halves cover it instead: the
 * test above proves the later pass is the one that settles the delete, and
 * this one proves a pass hands its outcome, a failure included, to everyone
 * it settles.
 */
test('a pass that fails reports it to the delete coalesced into it', async (t) => {
  const { team, dir, room } = await rig(t)
  const file = join(dir, `${encodeURIComponent(room)}.json`)
  await team.flush()
  // A directory where the room's file was: `rm` will not remove a directory
  // it was not told to recurse into, so this pass's unlink fails.
  rmSync(file)
  mkdirSync(file)
  writeFileSync(join(file, 'keep'), '')

  team.renameRoom(room, 'renamed') // opens the pass
  await assert.rejects(team.deleteRoom(room), /could not be deleted/) // coalesces into it
  // Not deleted means still here, as the refusal says.
  assert.equal(team.stateFor(room).name, 'renamed')
})

test('a delete coalesced before its pass starts is still settled by that pass', async (t) => {
  // The control: ordinary coalescing, which worked before and must keep working.
  const { team, dir, room } = await rig(t)
  const file = join(dir, `${encodeURIComponent(room)}.json`)
  await team.flush()
  team.renameRoom(room, 'renamed')
  await team.deleteRoom(room)
  assert.equal(existsSync(file), false)
})

test('a card waiting on another, marked done or abandoned, is no longer waiting', async (t) => {
  // Review's other shape for #73: blocked by the graph rather than by hand.
  const { team, room } = await rig(t)
  for (const action of ['done', 'abandon'] as const) {
    const first = team.addIntentAsUser(room, { title: `first, before ${action}` })
    const waiting = team.addIntentAsUser(room, { title: `waits, then ${action}`, dependsOn: [first.id] })
    const before = team.stateFor(room).intents.find((entry) => entry.id === waiting.id)
    assert.equal(before?.blockedBy, 'graph', 'the control: it really was waiting on the first')

    team.intentAction(room, waiting.id, action)
    const after = team.stateFor(room).intents.find((entry) => entry.id === waiting.id)
    assert.equal(after?.state, action === 'done' ? 'done' : 'abandoned')
    assert.equal(after?.blockedReason, null, `${action} leaves no reason behind`)
    assert.equal(after?.blockedBy, null, `${action} leaves nothing it waits on`)
  }
})

test('abandoned work opens nothing that depends on it; finished work does', async (t) => {
  /* Review asked what clearing the block on done and abandon does downstream.
     Nothing, and this pins why: what opens a dependent is its dependency's
     *state*, and abandoned is not done — including when a later `done`
     elsewhere sends the board looking for work to open. */
  const { team, room } = await rig(t)
  const state = (id: number) => team.stateFor(room).intents.find((entry) => entry.id === id)
  const dropped = team.addIntentAsUser(room, { title: 'dropped' })
  const onDropped = team.addIntentAsUser(room, { title: 'needs the dropped one', dependsOn: [dropped.id] })
  team.intentAction(room, dropped.id, 'abandon')
  assert.equal(state(onDropped.id)?.state, 'blocked', 'abandoned work satisfies nothing')
  assert.equal(state(onDropped.id)?.blockedBy, 'graph')

  const finished = team.addIntentAsUser(room, { title: 'finished' })
  const onFinished = team.addIntentAsUser(room, { title: 'needs the finished one', dependsOn: [finished.id] })
  team.intentAction(room, finished.id, 'done')
  assert.equal(state(onFinished.id)?.state, 'open', 'finished work opens what waited on it')
  assert.equal(state(onDropped.id)?.state, 'blocked', 'and the pass that opened it left the other one waiting')
})

test('a member’s mode is pushed to its room, and a new default to every room', async (t) => {
  const { team, port, room } = await rig(t)
  await twoAgents(port, team, room)
  // A member is in one room at a time, so the second room takes Claude.
  const elsewhere = (await team.createRoom('/repo', 'elsewhere')).id
  await team.joinRoom(elsewhere, 'claude' as RuntimeId, 'k1')
  const codexKey = sessionKey('codex', 'c1')
  const claudeKey = sessionKey('claude', 'k1')

  const before = port.changed.length
  team.setInbound('codex', 'c1', 'hold')
  // The control: the mode was always stored. It was never said.
  assert.equal(team.inboundFor('codex', 'c1'), 'hold')
  const pushed = port.changed.slice(before)
  assert.deepEqual(
    pushed.map((one) => one.id),
    [room],
  )
  assert.equal(pushed[0]?.inbound?.[codexKey], 'hold')

  /* The default is the mode of every member without one of its own, so a new
     default is news in every room, and a member's own mode still outranks it. */
  const again = port.changed.length
  team.configure({ inboundDefault: 'refuse' })
  const all = port.changed.slice(again)
  assert.deepEqual(all.map((one) => one.id).sort(), [room, elsewhere].sort())
  assert.equal(all.find((one) => one.id === elsewhere)?.inbound?.[claudeKey], 'refuse')
  assert.equal(all.find((one) => one.id === room)?.inbound?.[codexKey], 'hold')
})
