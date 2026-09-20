import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { sessionKey, type FlowPermission, type FlowSeat, type RuntimeId, type SeatId, type SeatRecord, type TeamState } from '@harnessdesk/protocol'

import { FLOW_DIR, Flows as DurableFlows, runCheck, type FlowPort as DurableFlowPort } from '../src/flows.js'
import { Team, type TeamPeer, type TeamPort } from '../src/team.js'

/**
 * The round engine, against a real board and a fake desk.
 *
 * The loop is the product, so this is where it is held: a card addressed to a
 * role is taken by that role and nobody else, a round opens only when the last
 * of its siblings finishes, the context packages travel without anybody
 * copying them, and a round nothing claims ends the run. What this rig does
 * *not* do is spend anything — the seats are stubs — so everything measured
 * here is measured again in the real application with real agents.
 */

interface Rig {
  readonly team: Team
  readonly flows: Flows
  readonly room: string
  readonly dir: string
  readonly peers: TeamPeer[]
  /** Seats the fake desk was asked to open, in order. */
  readonly seated: { runtime: string; sessionId: string; cwd: string; spec: string; title: string }[]
  /** Standing orders handed out, by member. One each, ever, is the whole claim. */
  readonly orders: { key: string; text: string }[]
  /** Worktrees an isolating role asked for. */
  readonly isolated: string[]
  /** Folders the engine asked the desk to hold to what is open, in order. */
  readonly confined: string[]
  /** A folder the desk does not have open, which it refuses. */
  closed?: string
  /** What a check's command is told to answer. */
  exits: Map<string, number>
  readonly ran: { command: string; cwd: string }[]
  /** Ends a seat's turn, the way a lapsed window or a refused call does. */
  kill(seat: { runtime: string; sessionId: string }): void
  /** Orders that throw before landing, counted down — an agent that is not up. */
  failOrders: number
  /** What a reseated conversation reports running, when it is not what was asked. */
  comesBackAs?: string
  /** Every time a seat's picks were re-applied. */
  readonly reseated: { sessionId: string; spec: string }[]
  /** What the engine said out loud. */
  readonly logged: string[]
  /** Conversations the engine closed after a seating that failed part-way. */
  readonly retired: string[]
  /** Seats that throw instead of opening, by title fragment. */
  refuseSeat?: string
  /** What the runtime says about every seat's last turn, when it went badly. */
  turnFailed?: string
  /** An error for port.run to throw, simulating a crash during a check command. */
  throwOnRun?: Error
}

const peerOf = (runtime: string, sessionId: string, cwd: string, model: string): TeamPeer => ({
  runtime: runtime as RuntimeId,
  sessionId,
  title: null,
  cwd,
  agent: runtime === 'cursor' ? 'Cursor' : 'Codex',
  /* A seated agent is *inside* its turn — that is the whole design — so the
     fake desk says so. A test that wants a seat whose turn has died flips
     this, which is the only thing that distinguishes the two. */
  busy: true,
  canSteer: false,
  queuedByUser: 0,
  model,
  here: true,
})

/** Old fake-desk spelling retained only inside this test; production has one durable Seat port. */
type FlowPort = Omit<DurableFlowPort, 'openLegacySeat' | 'releaseGoalSeat'> & {
  seat(seat: FlowSeat, where: { readonly cwd: string; readonly title: string }): Promise<{
    readonly runtime: string; readonly sessionId: string; readonly label: string
  }>
  join(room: string, runtime: string, sessionId: string): Promise<void>
  isolate?(root: string, name: string): Promise<string>
  recorded?(room: string, seat: unknown): void
}

const durablePort = (team: Team, legacy: FlowPort): DurableFlowPort => {
  const opened = new Map<SeatId, { runtime: string; sessionId: string }>()
  const { seat, join: joinRoom, isolate, recorded: _recorded, ...port } = legacy
  return {
    ...port,
    openLegacySeat: async (input: {
      goal: string; spec: FlowSeat; permission: FlowPermission; role: string
      isolate: boolean; title: string; lane?: string
    }): Promise<SeatRecord> => {
      const board = team.stateFor(input.goal)
      const folder = board.cwd ?? board.root
      const cwd = input.isolate ? await isolate?.(folder, input.lane ?? input.role) : folder
      if (!cwd) throw new Error('This test port cannot isolate a Seat.')
      const live = await seat(input.spec, { cwd, title: input.title })
      await joinRoom(input.goal, live.runtime, live.sessionId)
      team.setRole(input.goal, live.runtime, live.sessionId, input.role)
      const id = `test-${live.runtime}-${live.sessionId}` as SeatId
      opened.set(id, live)
      return {
        id, agent: null, briefDigest: null, seat: input.spec, seatLabel: live.label,
        passedOver: [], standing: { kind: 'permission', permission: input.permission }, ceiling: null,
        checkout: { cwd, project: board.root, branch: null, head: null },
        session: { runtime: live.runtime, sessionId: live.sessionId }, board: input.goal,
        role: input.role, openedAt: Date.now(), closed: null,
      }
    },
    releaseGoalSeat: async (goal, id) => {
      const live = opened.get(id)
      if (!live) return
      team.setRole(goal, live.runtime, live.sessionId, null)
      team.leaveRoom(goal, live.runtime as RuntimeId, live.sessionId)
    },
  }
}

class Flows extends DurableFlows {
  constructor(dir: string, team: Team, port: FlowPort) {
    super(dir, team, durablePort(team, port))
  }
}

const rig = async (t: { after(fn: () => Promise<void>): void }): Promise<Rig> => {
  /* Built up as we go, because the fake desk's own verbs read its state — an
     order that fails has to be able to see the counter that says so. */
  const rig = { failOrders: 0 } as Rig
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-flows-'))
  const peers: TeamPeer[] = []
  const seated: Rig['seated'] = []
  const orders: Rig['orders'] = []
  const isolated: string[] = []
  const confined: string[] = []
  const ran: Rig['ran'] = []
  const reseated: Rig['reseated'] = []
  const logged: Rig['logged'] = []
  const retired: string[] = []
  const exits = new Map<string, number>()
  const changed: TeamState[] = []
  const teamPort: TeamPort = {
    peers: () => peers,
    rootOf: async (cwd) => (cwd === '/repo' || cwd.startsWith('/repo') ? '/repo' : null),
    send: async () => {},
    steer: async () => {},
    changed: (state) => void changed.push(state),
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const team = new Team(join(dir, 'team'), teamPort)
  const room = (await team.createRoom('/repo', 'Fix room')).id
  let n = 0
  const port: FlowPort = {
    seat: async (seat, where) => {
      if (rig.refuseSeat && where.title.includes(rig.refuseSeat)) {
        throw new Error(`${seat.runtime} would not open a conversation`)
      }
      n += 1
      const sessionId = `s${n}`
      peers.push(peerOf(seat.runtime, sessionId, where.cwd, seat.model ?? seat.runtime))
      const spec = `${seat.runtime}${seat.model ? `=${seat.model}` : ''}${seat.effort ? `/${seat.effort}` : ''}`
      seated.push({ runtime: seat.runtime, sessionId, cwd: where.cwd, spec, title: where.title })
      return { runtime: seat.runtime, sessionId, label: spec }
    },
    retire: async (runtime, sessionId) => void retired.push(`${runtime} ${sessionId}`),
    turnFailure: () => rig.turnFailed ?? null,
    reseat: async (runtime, sessionId, seat) => {
      const spec = `${seat.runtime}${seat.model ? `=${seat.model}` : ''}${seat.effort ? `/${seat.effort}` : ''}`
      reseated.push({ sessionId, spec })
      // What it *actually* came back on, which a test may make disagree.
      return rig.comesBackAs ?? spec
    },
    order: async (runtime, sessionId, text) => {
      if (rig.failOrders > 0) {
        rig.failOrders -= 1
        throw new Error('Cursor is not running.')
      }
      orders.push({ key: String(sessionKey(runtime as never, sessionId as never)), text })
    },
    join: async (id, runtime, sessionId) => {
      await team.joinRoom(id, runtime as RuntimeId, sessionId)
    },
    confine: async (folder) => {
      confined.push(folder)
      if (folder === rig.closed) throw new Error(`${folder} is not open here.`)
    },
    isolate: async (root, name) => {
      const path = `${root}/.worktrees/${name}`
      isolated.push(path)
      return path
    },
    run: async (command, where) => {
      if (rig.throwOnRun) throw rig.throwOnRun
      ran.push({ command, cwd: where.cwd })
      return { status: exits.get(command) ?? 0 }
    },
    changed: () => {},
    log: (message, details) => void logged.push(`${message} ${JSON.stringify(details ?? {})}`),
  }
  const flows = new Flows(join(dir, 'flows'), team, port)
  team.attachFlows(flows)
  t.after(async () => {
    await flows.flush()
    await team.flush()
    await rm(dir, { recursive: true, force: true })
  })
  const kill = (seat: { runtime: string; sessionId: string }): void => {
    const peer = peers.find((one) => one.runtime === seat.runtime && one.sessionId === seat.sessionId)
    if (peer) Object.assign(peer, { busy: false })
  }
  Object.assign(rig, { team, flows, room, dir, peers, seated, orders, isolated, confined, exits, ran, kill, reseated, logged, retired })
  return rig as Rig
}

const REVIEW = `
name: Fix and review
inputs:
  work: What to fix
roles:
  fixer:
    kind: agent
    seat: cursor=gpt-5.3-codex/xhigh
    permission: publish
    outcomes: [published, cannot]
    order: You fix things and open pull requests.
  reviewer:
    kind: agent
    seat: cursor=gemini-3.8-flash/high
    count: 3
    permission: read
    outcomes: [approve, request-changes]
    order: You review on your own.
  referee:
    kind: person
    outcomes: [merged, dropped]
seed:
  role: fixer
  title: "{{work}}"
rules:
  - { id: review-it, on: fixer, when: { every: published }, then: { role: reviewer, title: "Review round {{round}} — {{n}} of {{count}}" } }
  - { id: fix-again, on: reviewer, when: { any: request-changes }, then: { role: fixer, title: "Answer round {{round}}'s reviews" } }
  - { id: hand-over, on: reviewer, when: { every: approve }, then: { role: referee, title: "Merge it" } }
`

/** Who is seated where, by role. */
const seatsOf = (rig: Rig, role: string): { runtime: string; sessionId: string }[] =>
  rig.seated
    .map((one, index) => ({ ...one, index }))
    .filter((one) => one.title.startsWith(role))
    .map((one) => ({ runtime: one.runtime, sessionId: one.sessionId }))

const board = (rig: Rig) => rig.team.stateFor(rig.room)

test('the loop runs itself: fix, review, back to fix, and out to the person', async (t) => {
  const one = await rig(t)
  const run = await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix the refill bug' } })

  // Four seats, one order each, and the person's step seats nobody.
  assert.equal(one.seated.length, 4)
  assert.equal(one.orders.length, 4)
  const fixer = seatsOf(one, 'fixer')[0]!
  const reviewers = seatsOf(one, 'reviewer')

  // (1) The fixer claims the seed card; the reviewers cannot.
  assert.equal(board(one).intents.length, 1)
  assert.equal(board(one).intents[0]?.title, 'Fix the refill bug')
  for (const reviewer of reviewers) {
    assert.match(await one.team.claimNext(reviewer), /^Nothing to take right now/)
  }
  assert.match(await one.team.claimNext(fixer), /^Claimed #1 — Fix the refill bug/)

  // (2) The fixer reports, and a round of three opens by itself.
  await one.team.complete(1, { outcome: 'published', handoff: 'PR #7 on branch fix/refill' }, fixer)
  await one.flows.flush()
  const opened = board(one).intents.filter((intent) => intent.role === 'reviewer')
  assert.equal(opened.length, 3)
  assert.deepEqual(
    opened.map((intent) => intent.title),
    ['Review round 2 — 1 of 3', 'Review round 2 — 2 of 3', 'Review round 2 — 3 of 3'],
  )

  // (3) Each reviewer takes exactly one; the fixer gets none.
  const taken: number[] = []
  for (const reviewer of reviewers) {
    const answer = await one.team.claimNext(reviewer)
    assert.match(answer, /^Claimed #/)
    taken.push(Number(/^Claimed #(\d+)/.exec(answer)?.[1]))
    /* And no second card. A round is N cards and N seats, and nothing in the
       board's own rules stopped the first reviewer to ask from taking all
       three — so the rule is "one addressed card at a time", and the refusal
       names the one it is already holding. */
    assert.match(
      await one.team.claimNext(reviewer),
      /^Nothing to take right now|^Refused: you are already holding/,
    )
    assert.match(
      await one.team.claim(taken[taken.length - 1]! === 2 ? 3 : 2, reviewer),
      /^Refused: you are already holding #\d+/,
    )
  }
  assert.deepEqual([...taken].sort(), [2, 3, 4])
  assert.match(await one.team.claimNext(fixer), /^Nothing to take right now/)

  // (4) Each review card arrived carrying the fixer's context package, without
  // anybody asking for it and without this engine copying a word of it.
  const arrival = await one.team.claim(2, reviewers[0]!)
  assert.match(arrival, /You already hold #2/)
  const fresh = await rig(t)
  await fresh.flows.start({ room: fresh.room, source: REVIEW, vars: { work: 'Fix it' } })
  const freshFixer = seatsOf(fresh, 'fixer')[0]!
  await fresh.team.claimNext(freshFixer)
  await fresh.team.complete(1, { outcome: 'published', handoff: 'PR #7 on branch fix/refill' }, freshFixer)
  await fresh.flows.flush()
  const handed = await fresh.team.claimNext(seatsOf(fresh, 'reviewer')[0]!)
  assert.match(handed, /What the work this depends on left for you/)
  assert.match(handed, /PR #7 on branch fix\/refill/)

  // (5) A mixed round opens a fresh fix round carrying all three reviews.
  await one.team.complete(2, { outcome: 'approve', handoff: 'looks right to me' }, reviewers[0]!)
  await one.team.complete(3, { outcome: 'request-changes', handoff: 'the retry is unbounded' }, reviewers[1]!)
  assert.equal(board(one).intents.filter((intent) => intent.state === 'open').length, 0, 'the round is not over yet')
  await one.team.complete(4, { outcome: 'approve', handoff: 'agreed with the second' }, reviewers[2]!)
  await one.flows.flush()
  const again = board(one).intents.find((intent) => intent.id === 5)
  assert.equal(again?.role, 'fixer')
  assert.equal(again?.title, "Answer round 3's reviews")
  const back = await one.team.claimNext(fixer)
  assert.match(back, /the retry is unbounded/)
  assert.match(back, /looks right to me/)
  assert.match(back, /agreed with the second/)

  // (6) A unanimous round opens the person's card, and the loop waits.
  await one.team.complete(5, { outcome: 'published', handoff: 'pushed again' }, fixer)
  await one.flows.flush()
  const second = board(one).intents.filter((intent) => intent.role === 'reviewer' && intent.state === 'open')
  assert.equal(second.length, 3)
  for (const [index, reviewer] of reviewers.entries()) {
    await one.team.claim(second[index]!.id, reviewer)
    await one.team.complete(second[index]!.id, { outcome: 'approve' }, reviewer)
  }
  await one.flows.flush()
  const referee = board(one).intents.find((intent) => intent.role === 'referee')
  assert.equal(referee?.title, 'Merge it')
  assert.equal(referee?.state, 'open')
  // No agent can take it: nobody holds that role.
  for (const seat of [fixer, ...reviewers]) {
    assert.match(await one.team.claimNext(seat), /^Nothing to take right now/)
  }
  assert.equal(one.flows.runsFor(one.room)[0]?.state, 'running')

  // (7) One order each, still. A second message would have failed the premise.
  assert.equal(one.orders.length, 4)
  assert.equal(new Set(one.orders.map((order) => order.key)).size, 4)
  void run
})

test('the person answering their own card ends the run, and the seats stand down', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  const reviewers = seatsOf(one, 'reviewer')
  await one.team.claimNext(fixer)
  await one.team.complete(1, { outcome: 'published' }, fixer)
  for (const [index, reviewer] of reviewers.entries()) {
    await one.team.claim(index + 2, reviewer)
    await one.team.complete(index + 2, { outcome: 'approve' }, reviewer)
  }
  await one.flows.flush()
  const referee = board(one).intents.find((intent) => intent.role === 'referee')!

  // A seat waiting when the run ends is told so rather than waiting out its
  // block: nothing about a run ending touches the board, so the engine has to
  // ask the room again.
  const waiting = one.team.awaitWork(fixer, { blockMs: 30_000, cycle: 0 })
  one.team.intentAction(one.room, referee.id, 'done', undefined, 'merged')
  await one.flows.flush()
  assert.match(await waiting, /^stand down —/)
  const run = one.flows.runsFor(one.room)[0]!
  assert.equal(run.state, 'settled')
  assert.match(run.ended ?? '', /referee answered merged/)
})

test('an outcome a role never declared is refused, and nothing is written', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)

  assert.match(
    await one.team.complete(1, { outcome: 'looks-good' }, fixer),
    /^Refused: "looks-good" is not something a fixer answers here\. It answers published, cannot\./,
  )
  // A card belonging to a flow will not finish with no outcome at all, either:
  // a rule cannot branch on silence.
  assert.match(await one.team.complete(1, { note: 'done' }, fixer), /so it needs an outcome/)
  assert.equal(board(one).intents[0]?.state, 'claimed')
  assert.equal(board(one).intents[0]?.outcome, null)
  // The control: the declared word finishes it.
  assert.match(await one.team.complete(1, { outcome: 'published' }, fixer), /^Completed #1/)
})

test('a check is a command, not an opinion: its exit status answers its own card', async (t) => {
  const one = await rig(t)
  const GATED = `
name: Gate it
roles:
  fixer: { kind: agent, seat: cursor, outcomes: [published, cannot], permission: publish }
  tests:
    kind: check
    run: pnpm verify
    exits: { 0: pass }
    otherwise: fail
seed: { role: fixer, title: Fix it }
rules:
  - { id: gate, on: fixer, when: { every: published }, then: { role: tests, title: Run the gate } }
  - { id: back, on: tests, when: { any: fail }, then: { role: fixer, title: Make the gate pass } }
`
  await one.flows.start({ room: one.room, source: GATED })
  // A check seats nobody: one agent role, one seat.
  assert.equal(one.seated.length, 1)
  const fixer = seatsOf(one, 'fixer')[0]!

  // Red first: the gate fails and the work comes back.
  one.exits.set('pnpm verify', 1)
  await one.team.claimNext(fixer)
  await one.team.complete(1, { outcome: 'published' }, fixer)
  await one.flows.flush()
  assert.deepEqual(one.ran, [{ command: 'pnpm verify', cwd: '/repo' }])
  assert.equal(board(one).intents.find((intent) => intent.id === 2)?.outcome, 'fail')
  assert.equal(board(one).intents.find((intent) => intent.id === 3)?.title, 'Make the gate pass')

  // Then green, and nothing claims a passing gate, so the run is over.
  one.exits.set('pnpm verify', 0)
  await one.team.claimNext(fixer)
  await one.team.complete(3, { outcome: 'published' }, fixer)
  await one.flows.flush()
  assert.equal(board(one).intents.find((intent) => intent.id === 4)?.outcome, 'pass')
  assert.equal(one.flows.runsFor(one.room)[0]?.state, 'settled')
})

test('an isolating role gets a worktree per card, and a reviewer does not', async (t) => {
  const one = await rig(t)
  const RACE = `
name: Race
roles:
  competitor:
    kind: agent
    seat: [cursor=gpt-5.3-codex/xhigh, cursor=claude-4.6-opus/max]
    count: 2
    isolate: true
    outcomes: [done, cannot]
  judge:
    kind: agent
    seat: cursor=gemini-3.8-flash/high
    outcomes: [first, second, neither]
seed: { role: competitor, title: "Attempt {{n}} of {{count}}" }
rules:
  - { id: judge-them, on: competitor, when: { every: done }, then: { role: judge, title: Judge them } }
`
  await one.flows.start({ room: one.room, source: RACE })
  assert.equal(one.isolated.length, 2)
  assert.notEqual(one.seated[0]?.cwd, one.seated[1]?.cwd)
  // The judge reads what they produced, so it works where the room does.
  assert.equal(one.seated[2]?.cwd, '/repo')
  // One round of two, each card its own seat's model.
  assert.deepEqual(one.seated.map((seat) => seat.spec), [
    'cursor=gpt-5.3-codex/xhigh',
    'cursor=claude-4.6-opus/max',
    'cursor=gemini-3.8-flash/high',
  ])
  assert.deepEqual(
    board(one).intents.map((intent) => intent.title),
    ['Attempt 1 of 2', 'Attempt 2 of 2'],
  )
})

test('a flow starts only in a folder the desk has open, asked before anybody is seated', async (t) => {
  const one = await rig(t)
  // A room made in a folder inside its project, so the folder its seats open
  // in is not the root the room is keyed by.
  const room = (await one.team.createRoom('/repo/app', 'App room')).id
  /* The reader comes first. Seated, it is a conversation the desk holds in
     the room's folder, and that folder then counts as open to the desk — so a
     question asked any later than this would be answered by the seat. */
  const PAIR = `
name: Pair
roles:
  reader: { kind: agent, seat: cursor, outcomes: [done] }
  writer: { kind: agent, seat: cursor, isolate: true, outcomes: [done] }
seed: { role: writer, title: Write it }
`
  one.closed = '/repo/app'
  await assert.rejects(one.flows.start({ room, source: PAIR }), { message: '/repo/app is not open here.' })
  assert.deepEqual(one.confined, ['/repo/app'])
  assert.equal(one.seated.length, 0, 'nobody was seated')
  assert.equal(one.isolated.length, 0, 'and no worktree was cut')
  assert.deepEqual(one.orders, [])
  assert.deepEqual(one.flows.runsFor(room), [])
  assert.deepEqual(one.team.stateFor(room).intents, [])

  // The control: open, the same flow seats both, in the folder it asked about.
  delete one.closed
  await one.flows.start({ room, source: PAIR })
  assert.deepEqual(one.confined, ['/repo/app', '/repo/app'])
  assert.equal(one.seated[0]?.cwd, '/repo/app')
  assert.match(one.seated[1]?.cwd ?? '', /^\/repo\/app\/\.worktrees\/writer-1-/)
  assert.deepEqual(one.isolated, [one.seated[1]?.cwd])
})

test('a run picks up where it left off when the desk restarts mid-round', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)

  /* The card finishes on the board while the flow engine is not listening —
     which is exactly a quit between the board's write and the run's. */
  one.team.attachFlows({ refuseOutcome: () => null, completed: () => {}, standDown: () => null })
  await one.team.complete(1, { outcome: 'published' }, fixer)
  await one.flows.flush()
  assert.equal(board(one).intents.length, 1, 'nothing opened while the engine was away')

  // A fresh engine over the same directories reconciles on load.
  const second = new Flows(join(one.dir, 'flows'), one.team, {
    seat: async () => ({ runtime: 'cursor', sessionId: 'x', label: 'cursor' }),
    order: async () => {},
    reseat: async () => 'cursor',
    retire: async () => {},
    join: async () => {},
    confine: async () => {},
    isolate: async () => '/repo',
    run: async () => ({ status: 0 }),
    changed: () => {},
    log: () => {},
  })
  one.team.attachFlows(second)
  await second.load()
  await second.flush()
  assert.equal(board(one).intents.filter((intent) => intent.role === 'reviewer').length, 3)
  // And it did not seat anybody again: the seats are in the run it read.
  assert.equal(one.seated.length, 4)
})

test('a second flow in one room is refused, with the reason', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  await assert.rejects(
    () => one.flows.start({ room: one.room, source: REVIEW }),
    /is already running a flow/,
  )
})

test('a flow that will not validate seats nobody', async (t) => {
  const one = await rig(t)
  await assert.rejects(
    () => one.flows.start({ room: one.room, source: REVIEW.replace('role: referee', 'role: nobody') }),
    /there is no role called "nobody"/,
  )
  assert.equal(one.seated.length, 0)
  assert.equal(one.orders.length, 0)
  assert.equal(board(one).intents.length, 0)
})

test('flow/start for a non-existent room throws and seats nobody (#420)', async (t) => {
  const one = await rig(t)
  await assert.rejects(
    () => one.flows.start({ room: 'missing-room', source: REVIEW, vars: { work: 'Fix it' } }),
    /There is no room missing-room\./,
  )
  assert.equal(one.seated.length, 0)
  assert.equal(one.orders.length, 0)
})

test('the record says who did what, on which seat, with which outcome', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  await one.team.complete(1, { outcome: 'published' }, fixer)
  await one.flows.flush()
  const record = one.flows.runsFor(one.room)[0]!.record
  assert.equal(record[0]?.kind, 'started')
  assert.deepEqual(
    record.filter((entry) => entry.kind === 'seated').map((entry) => `${entry.role}:${entry.seat}`),
    [
      'fixer:cursor=gpt-5.3-codex/xhigh',
      'reviewer:cursor=gemini-3.8-flash/high',
      'reviewer:cursor=gemini-3.8-flash/high',
      'reviewer:cursor=gemini-3.8-flash/high',
    ],
  )
  assert.ok(record.some((entry) => entry.kind === 'outcome' && entry.outcome === 'published'))
  assert.deepEqual(
    record.filter((entry) => entry.kind === 'round').map((entry) => entry.role),
    ['fixer', 'reviewer'],
  )
})

test('a seat whose turn dies is handed its order again, with the permission it was seated for', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  assert.equal(one.orders.length, 4)
  // Its turn dies; the seed card is open and addressed to it, so there is work.
  one.kill(fixer)

  /* The bug this guards, which was hit in the hand-rolled version: a
     publishing seat came back from a re-arm carrying a reader's git rule and
     then refused the very card it was seated for. The order is re-rendered
     from the role, never replayed from a stored string. */
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.equal(one.orders.length, 5)
  const again = one.orders[4]!
  assert.match(again.text, /You publish\./)
  assert.match(again.text, /exactly one of published, cannot/)
  assert.equal(again.text, one.orders[0]!.text, 'the re-armed order is the order it was seated with')

  // And the record says it happened, so a re-arm is never silent.
  const record = one.flows.runsFor(one.room)[0]!.record
  assert.ok(record.some((entry) => entry.kind === 'seated' && /re-armed/.test(entry.text ?? '')))
})

test('a seat with nothing to do is left down rather than woken to an empty board', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const reviewer = seatsOf(one, 'reviewer')[0]!
  /* Measured in a live run and it cost real turns: three reviewers all closed
     their turns after finishing a round, every one was woken to a board with
     nothing addressed to it, and each burned its whole allowance inside the
     minute. Only the seed card is open here and it is the fixer's. */
  one.kill(reviewer)
  await one.flows.reArm(reviewer.runtime, reviewer.sessionId)
  assert.equal(one.orders.length, 4, 'no order was handed out')
  const record = one.flows.runsFor(one.room)[0]!.record
  assert.ok(!record.some((entry) => /re-armed/.test(entry.text ?? '')), 'and no budget was spent')

  // The control: the fixer, whose card *is* open, is re-armed.
  const fixer = seatsOf(one, 'fixer')[0]!
  one.kill(fixer)
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.equal(one.orders.length, 5)
})

test('a round opening wakes the seats of its role whose turns have ended', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  // The reviewers' turns have ended, so the round that needs them is what
  // wakes them — rather than the moment each turn died, when they had nothing.
  for (const reviewer of seatsOf(one, 'reviewer')) one.kill(reviewer)
  await one.team.claimNext(fixer)
  await one.team.complete(1, { outcome: 'published' }, fixer)
  await one.flows.flush()
  assert.equal(one.orders.length, 4 + 3, 'one order each for the three reviewers the round needs')
  for (const order of one.orders.slice(4)) assert.match(order.text, /exactly one of approve, request-changes/)
})

test('re-arming is budgeted, so a seat that cannot start does not drain an account', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  one.kill(fixer)
  for (let n = 0; n < 6; n += 1) await one.flows.reArm(fixer.runtime, fixer.sessionId)
  // Three inside the hour, and then it stops and says why rather than going on.
  assert.equal(one.orders.length, 4 + 3)
  const record = one.flows.runsFor(one.room)[0]!.record
  const stoppedEntries = record.filter(
    (entry) => entry.kind === 'stopped' && /not being re-armed again/.test(entry.text ?? ''),
  )
  assert.equal(stoppedEntries.length, 1, 'the stopped record is written once, not appended on every tick')
})

test('re-arm budget reserves slot before awaits to prevent concurrent overspending', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  one.kill(fixer)
  // Spend 2 of the 3 budget slots
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.equal(one.orders.length, 4 + 2)

  // Now trigger two concurrent reArms when only 1 slot remains
  await Promise.all([
    one.flows.reArm(fixer.runtime, fixer.sessionId),
    one.flows.reArm(fixer.runtime, fixer.sessionId),
  ])
  // Exactly 1 should have succeeded, bringing orders to 4 + 3
  assert.equal(one.orders.length, 4 + 3)

  // Verify the records: no duplicate "(2 this hour)" or "(3 this hour)"
  const run = one.flows.runsFor(one.room)[0]!
  const rearmTexts = run.record
    .filter((e) => e.kind === 'seated' && /re-armed/.test(e.text ?? ''))
    .map((e) => e.text)
  assert.deepEqual(rearmTexts, [
    're-armed: its turn ended while the flow was still running (1 this hour)',
    're-armed: its turn ended while the flow was still running (2 this hour)',
    're-armed: its turn ended while the flow was still running (3 this hour)',
  ])
})

test('a failed re-arm releases its reserved slot so future re-arms can succeed', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  one.kill(fixer)
  // Spend 2 slots
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.equal(one.orders.length, 4 + 2)

  // Third attempt fails to send order
  one.failOrders = 1
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.equal(one.orders.length, 4 + 2, 'failed order was not added')

  // Slot was released, so next attempt uses slot 3 successfully
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.equal(one.orders.length, 4 + 3, 'slot 3 was still available')
})

test('dedup stopped answering records works across multiple seats of the same role', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const reviewers = seatsOf(one, 'reviewer')
  assert.equal(reviewers.length, 3)

  // Complete round 1 so reviewers have work to do
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  await one.team.complete(1, { outcome: 'published' }, fixer)
  await one.flows.flush()

  // Kill each reviewer and exhaust each reviewer's budget
  for (const r of reviewers) {
    one.kill(r)
    for (let n = 0; n < 6; n += 1) await one.flows.reArm(r.runtime, r.sessionId)
  }

  const run = one.flows.runsFor(one.room)[0]!
  const stoppedRecords = run.record.filter(
    (e) => e.kind === 'stopped' && /stopped answering/.test(e.text ?? ''),
  )
  // Each reviewer seat must have exactly 1 record, so 3 in total
  assert.equal(stoppedRecords.length, 3)
})

test('a flow with custom rearm budget allows more re-arms before stopping', async (t) => {
  const one = await rig(t)
  const source = REVIEW.replace('name: Fix and review', 'name: Fix and review\nrearm: 5')
  await one.flows.start({ room: one.room, source, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  one.kill(fixer)
  for (let n = 0; n < 8; n += 1) await one.flows.reArm(fixer.runtime, fixer.sessionId)
  // Five inside the hour, bringing orders to 4 (initial) + 5
  assert.equal(one.orders.length, 4 + 5)
  const run = one.flows.runsFor(one.room)[0]!
  const rearmTexts = run.record
    .filter((e) => e.kind === 'seated' && /re-armed/.test(e.text ?? ''))
  assert.equal(rearmTexts.length, 5)
})

test('a run stalls when all seats of a role with open work stop answering', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  one.kill(fixer)
  for (let n = 0; n < 6; n += 1) await one.flows.reArm(fixer.runtime, fixer.sessionId)

  const run = one.flows.runsFor(one.room)[0]!
  assert.equal(run.state, 'stalled')
  assert.match(run.ended ?? '', /no seat answering for fixer/)
  assert.ok(run.record.some((e) => e.kind === 'stalled'))
  // Stand-down names why
  const standDown = one.flows.standDown(one.room, fixer.runtime, fixer.sessionId)
  assert.match(standDown ?? '', /no seat answering for fixer/)
})

test('a run stays running while at least one seat of the active role is answering', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  await one.team.complete(1, { outcome: 'published' }, fixer)
  await one.flows.flush()

  // Reviewers round is open (3 reviewers)
  const reviewers = seatsOf(one, 'reviewer')
  assert.equal(reviewers.length, 3)

  // Kill reviewer 0 and exhaust its budget
  one.kill(reviewers[0]!)
  for (let n = 0; n < 6; n += 1) await one.flows.reArm(reviewers[0]!.runtime, reviewers[0]!.sessionId)

  let run = one.flows.runsFor(one.room)[0]!
  assert.equal(run.state, 'running', 'run is still running because 2 other reviewers are answering')

  // Kill reviewer 1 and exhaust its budget
  one.kill(reviewers[1]!)
  for (let n = 0; n < 6; n += 1) await one.flows.reArm(reviewers[1]!.runtime, reviewers[1]!.sessionId)

  run = one.flows.runsFor(one.room)[0]!
  assert.equal(run.state, 'running', 'run is still running because 1 reviewer is answering')

  // Kill reviewer 2 and exhaust its budget
  one.kill(reviewers[2]!)
  for (let n = 0; n < 6; n += 1) await one.flows.reArm(reviewers[2]!.runtime, reviewers[2]!.sessionId)

  run = one.flows.runsFor(one.room)[0]!
  assert.equal(run.state, 'stalled', 'run is stalled now that all 3 reviewers have stopped answering')
  assert.match(run.ended ?? '', /no seat answering for reviewer/)
})

test('a seat of a settled run is not re-armed — standing down is not dying', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  await one.team.complete(1, { outcome: 'cannot' }, fixer)
  await one.flows.flush()
  assert.equal(one.flows.runsFor(one.room)[0]?.state, 'settled')

  one.kill(fixer)
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.equal(one.orders.length, 4, 'a seat told to stand down is not handed its order again')
})

test('a rule template can name the round that finished, not only the one it opens', async (t) => {
  const one = await rig(t)
  /* Found in a live race: "Judge {{count}} attempts" on a one-seat judge
     rendered "Judge 1 attempts", because `count` is the round being *opened*.
     The author meant the round that had just answered. */
  const RACE = `
name: Race
roles:
  competitor:
    kind: agent
    seat: [cursor=gpt-5.3-codex/xhigh, cursor=gemini-3.8-flash/high]
    count: 2
    isolate: true
    outcomes: [done, cannot]
  judge:
    kind: agent
    seat: cursor=gemini-3.8-flash/high
    outcomes: [first, second, neither]
seed: { role: competitor, title: "Attempt {{n}} of {{count}}" }
rules:
  - id: judge-them
    on: competitor
    when: { every: done }
    then: { role: judge, title: "Judge {{answered}} attempts from {{from}}" }
`
  await one.flows.start({ room: one.room, source: RACE })
  const seats = seatsOf(one, 'competitor')
  for (const [index, seat] of seats.entries()) {
    await one.team.claim(index + 1, seat)
    await one.team.complete(index + 1, { outcome: 'done', handoff: `attempt ${index + 1}` }, seat)
  }
  await one.flows.flush()
  const judge = board(one).intents.find((intent) => intent.role === 'judge')
  assert.equal(judge?.title, 'Judge 2 attempts from competitor')
  // And the round it opens still reports its own size, which is the other question.
  assert.equal(board(one).intents[0]?.title, 'Attempt 1 of 2')
})

test('the round-that-finished slots mean nothing on the seed, and are refused there', async (t) => {
  const one = await rig(t)
  await assert.rejects(
    () =>
      one.flows.start({
        room: one.room,
        source: REVIEW.replace('title: "{{work}}"', 'title: "{{work}} after {{answered}}"'),
      }),
    /nothing finishes before the seed/,
  )
  assert.equal(one.seated.length, 0)
})

test("the person's own step can leave a context package, the way an agent's does", async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  const reviewers = seatsOf(one, 'reviewer')
  await one.team.claimNext(fixer)
  await one.team.complete(1, { outcome: 'published', handoff: 'branch fix/x' }, fixer)
  await one.flows.flush()

  /* Found in a live run: a reviewer card the person settled reached the next
     round as an outcome and nothing else, while its two siblings contributed
     their findings. `who: person` is a step, not an absence, so the step has
     to be able to say something the work downstream actually receives. */
  await one.team.claim(2, reviewers[0]!)
  await one.team.complete(2, { outcome: 'approve', handoff: 'reviewer one: fine' }, reviewers[0]!)
  await one.team.claim(3, reviewers[1]!)
  // The person outranks the claim, which is the board's own referee rule.
  one.team.intentAction(one.room, 3, 'done', undefined, 'request-changes', 'the bound is still unchecked')
  await one.team.claim(4, reviewers[2]!)
  await one.team.complete(4, { outcome: 'approve', handoff: 'reviewer three: fine' }, reviewers[2]!)
  await one.flows.flush()

  const again = board(one).intents.find((intent) => intent.id === 5)
  assert.equal(again?.role, 'fixer')
  one.kill(fixer)
  const handed = await one.team.claim(5, fixer)
  assert.match(handed, /reviewer one: fine/)
  assert.match(handed, /the bound is still unchecked/, "the person's own words reached the next round")
  assert.match(handed, /reviewer three: fine/)
})

test('marking an agent card done by hand does not erase the package it left', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  await one.team.complete(1, { outcome: 'published', handoff: 'branch fix/x' }, fixer)
  await one.flows.flush()
  // The person tidies the card afterwards and says nothing of their own.
  one.team.intentAction(one.room, 1, 'done', undefined, 'published')
  assert.equal(board(one).intents[0]?.handoff, 'branch fix/x')
})

test('a seat is told the name the room addresses it by, from its very first order', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const named = one.team.stateFor(one.room).nicknames ?? {}
  assert.ok(Object.keys(named).length >= 4, 'every member was named before anything was written about it')
  /* A room names its members lazily, so an order rendered straight after
     seating used to call a seat by its label — "Cursor · Gemini 3.8 Flash ·
     High" — while the room addressed it as "Gemini 3". The order is what tells
     a seat its name, and that name is what `agent_message` reaches it by, so
     the two disagreeing makes a seat unaddressable by the name it was given. */
  for (const order of one.orders) {
    const said = /^You are (.+?) — "/.exec(order.text)?.[1]
    assert.equal(said, named[order.key], `the order names the seat ${named[order.key]}`)
  }
})

test('a seat whose turn dies while holding a card is woken — the work is in its hands', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  assert.equal(board(one).intents[0]?.state, 'claimed')

  /* The card it holds is `claimed`, not `open`, so a rule that only looks for
     open work leaves exactly this seat asleep with the round stalled behind a
     claim nobody is working. Measured in a live run: a reviewer ended its turn
     mid-review and the flow sat there until the lease ran out. */
  one.kill(fixer)
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.equal(one.orders.length, 5, 'it is handed its order again')
  assert.match(one.orders[4]!.text, /You publish\./)
})

test('a restart wakes a seat that stopped while the desk was down', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  one.kill(fixer)
  await one.flows.flush()
  const before = one.orders.length

  /* A turn that ended while the desk was down produces no turn-end event, so
     a run used to come back reconciled and *asleep*: rounds correct, cards
     where they should be, and every seat that had stopped still stopped. */
  const second = new Flows(join(one.dir, 'flows'), one.team, {
    seat: async () => ({ runtime: 'cursor', sessionId: 'x', label: 'cursor' }),
    order: async (runtime, sessionId, text) => {
      one.orders.push({ key: String(sessionKey(runtime as never, sessionId as never)), text })
    },
    reseat: async () => 'cursor',
    retire: async () => {},
    join: async () => {},
    confine: async () => {},
    isolate: async () => '/repo',
    run: async () => ({ status: 0 }),
    changed: () => {},
    log: () => {},
  })
  one.team.attachFlows(second)
  await second.load()
  await second.flush()
  assert.equal(one.orders.length, before, 'reading the runs sends nothing — the agents may not be up yet')

  // The host calls this once the runtimes are running.
  await second.resume()
  await second.flush()
  assert.equal(one.orders.length, before + 1, 'the seat holding a card was woken')
  assert.match(one.orders[before]!.text, /You publish\./)

  // And a healthy run wakes nobody: every other seat is still inside its turn.
  assert.equal(one.orders.length, before + 1)
})

test('a re-arm that never reached the agent costs nothing from the budget', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  one.kill(fixer)

  /* The budget stops a seat that *starts and stops* from draining an account.
     A send that never reached the agent bought nothing — the runtime was not
     up yet, which is exactly what a restart looks like — so charging for it
     would use the allowance up on nothing. */
  one.failOrders = 5
  for (let n = 0; n < 5; n += 1) await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.equal(one.orders.length, 4, 'nothing landed')
  one.failOrders = 0
  for (let n = 0; n < 3; n += 1) await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.equal(one.orders.length, 7, 'the full allowance is still there')
})

test('a re-armed seat is put back on the model it was seated with', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  one.kill(fixer)
  // The fake desk applies picks inside its own `seat`, as the host does, so
  // nothing has been *re*-seated yet.
  assert.equal(one.reseated.length, 0)

  /* Measured after a desk restart: the re-armed seat billed as `default` —
     Cursor's Auto — because the bridge that reopened the conversation held no
     session state. A flow whose reviewers quietly become Auto cannot say who
     did the work. */
  await one.flows.reArm(fixer.runtime, fixer.sessionId)
  assert.deepEqual(one.reseated, [{ sessionId: fixer.sessionId, spec: 'cursor=gpt-5.3-codex/xhigh' }])
})

test('a seat that comes back on something else is said so, not passed over', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  one.kill(fixer)
  // The desk asks for Codex and the agent answers with Auto, which is what a
  // restarted bridge does.
  one.comesBackAs = 'cursor=auto'
  await one.flows.reArm(fixer.runtime, fixer.sessionId)

  // Still armed — a wrong model is better than a flow stalled forever — but
  // the disagreement is on the record rather than silent.
  assert.equal(one.orders.length, 5)
  assert.ok(
    one.logged.some((line) => /came back on something else/.test(line)),
    one.logged.join('\n'),
  )
})

// ------------------------------------------------- what the review round found

test('a flow whose seed is a check runs that check, rather than waiting on it forever', async (t) => {
  const one = await rig(t)
  /* Reported in review: `start()` opened the seed card and only the
     *transition* path ran checks, so a flow whose first step is a preflight
     gate deadlocked — card open, run running, command never issued. */
  const GATE = `
name: Gate first
roles:
  tests:
    kind: check
    run: pnpm verify
    exits: { 0: pass }
    otherwise: fail
  fixer: { kind: agent, seat: cursor, outcomes: [published, cannot], permission: publish }
seed: { role: tests, title: Run the gate first }
rules:
  - { id: on-red, on: tests, when: { any: fail }, then: { role: fixer, title: Make the gate pass } }
`
  one.exits.set('pnpm verify', 1)
  await one.flows.start({ room: one.room, source: GATE })
  await one.flows.flush()

  assert.deepEqual(one.ran, [{ command: 'pnpm verify', cwd: '/repo' }], 'the seed check actually ran')
  assert.equal(board(one).intents[0]?.outcome, 'fail')
  assert.equal(board(one).intents[1]?.title, 'Make the gate pass', 'and the run moved on')
})

test('a seating that fails part-way closes the seats it opened', async (t) => {
  const one = await rig(t)
  /* Reported in review: a later `seat()` rejecting left the earlier
     conversations open, joined and roled, owned by no run — turns spent on
     members nothing would ever stand down. */
  one.refuseSeat = 'reviewer 2'
  await assert.rejects(
    () => one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } }),
    /would not open a conversation/,
  )
  assert.equal(one.flows.runsFor(one.room).length, 0, 'no run was left behind')
  assert.equal(one.retired.length, 2, 'the fixer and the first reviewer were closed')
  assert.deepEqual(one.team.stateFor(one.room).roles, {}, 'and nobody was left holding a role')
  assert.equal(one.team.stateFor(one.room).members.length, 0, 'nor left in the room')
  assert.equal(board(one).intents.length, 0)
})

test('a run stops when its seats never touch the board, and says which', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  /* #333: an agent that takes the tool bridge and ignores it is handed its
     order, spends a turn and sits there, while the card stays open and the run
     stays running. Nothing in the roster separates it beforehand, so the run
     has to notice afterwards. */
  await one.flows.attendance()
  const run = one.flows.runsFor(one.room)[0]!
  assert.equal(run.state, 'stopped')
  assert.match(run.ended ?? '', /not touched the board since being seated/)
  assert.match(run.ended ?? '', /fixer \(/)
  /* With no turn failure to report, it says what it saw and offers both
     readings rather than asserting the one it was built for. */
  assert.match(run.ended ?? '', /either that agent takes HarnessDesk's tools without using them, or its turn never started/)
  assert.ok(one.logged.some((line) => /never took the tools/.test(line)))
})

test('a run whose seats are working is left alone by the same check', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  // One board verb from each seat is all "it took the tools" means.
  for (const seat of [seatsOf(one, 'fixer')[0]!, ...seatsOf(one, 'reviewer')]) {
    await one.team.board(seat)
  }
  await one.flows.attendance()
  assert.equal(one.flows.runsFor(one.room)[0]?.state, 'running', 'a working run is not stopped')
})

test('every answer names the cycle to pass next, the wake included', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)
  await one.team.complete(1, { outcome: 'published' }, fixer)
  await one.flows.flush()

  /* Reported in review: the *wake* path said "with the next cycle number"
     while every other answer named it, which sends a seat back to a counter it
     would have to keep itself — the exact fragility `cycle` removes.

     It has to be the wake path and not the immediate one, so the fixer waits
     while nothing is addressed to it — the round open is the reviewers' — and
     is woken by the fix round a mixed verdict opens. */
  const reviewers = seatsOf(one, 'reviewer')
  const waiting = one.team.awaitWork(fixer, { blockMs: 30_000, cycle: 6 })
  for (const [index, reviewer] of reviewers.entries()) {
    await one.team.claim(index + 2, reviewer)
    await one.team.complete(
      index + 2,
      { outcome: index === 1 ? 'request-changes' : 'approve' },
      reviewer,
    )
  }
  await one.flows.flush()
  assert.match(await waiting, /^work: #5 .*Call await_work again with cycle: 7\.$/)
})

test('a check that runs over time is actually stopped, background and all', async (t) => {
  void t
  /* Reported in review: the timeout killed the shell and not its process
     tree, so `sleep N & wait` reported the timeout's outcome while the
     background process carried on running on the machine — "the check
     stopped" was a claim the engine could not keep. */
  const marker = join(tmpdir(), `harnessdesk-check-${process.pid}-${Date.now()}`)
  const started = Date.now()
  const { status } = await runCheck(`sleep 4 && touch ${marker} & wait`, {
    cwd: tmpdir(),
    timeoutSec: 1,
  })
  assert.equal(status, null, 'it reports the timeout')
  assert.ok(Date.now() - started < 3000, 'and returns at the timeout, not at the command')

  // Past when the background command would have finished, had it survived.
  await new Promise((resolve) => setTimeout(resolve, 4500))
  assert.equal(existsSync(marker), false, 'the background process was stopped too')
})

test('an order that never lands unwinds the whole start, so the next one can run', async (t) => {
  const one = await rig(t)
  /* Reported in review round 2: the transaction covered the seating loop and
     stopped there. `order` goes through the host's live handle and can throw —
     a runtime that dropped in the second between being seated and being spoken
     to — and the run was already published as `running`, so the room kept its
     members and roles and the next attempt was refused with "already running a
     flow". Nothing a person could clear without going to the files. */
  one.failOrders = 1
  await assert.rejects(
    () => one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } }),
    /Cursor is not running/,
  )
  assert.equal(one.flows.runsFor(one.room).length, 0, 'no run was published')
  assert.equal(one.retired.length, 4, 'every seat it opened was closed')
  assert.deepEqual(one.team.stateFor(one.room).roles, {})
  assert.equal(one.team.stateFor(one.room).members.length, 0)
  assert.equal(board(one).intents.length, 0, 'and no card was opened')

  // The room is clear, so the next attempt is a first attempt.
  one.failOrders = 0
  const run = await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  assert.equal(run.state, 'running')
  assert.equal(board(one).intents.length, 1)
})

test('a first round that cannot open stops the run rather than leaving it live', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  /* The other half: past the point the run exists, a failure is stopped rather
     than unwound — the seats have their orders and are already waiting, and a
     run that vanished from under them would leave four turns paid for and
     nobody to stand them down. */
  const run = one.flows.runsFor(one.room)[0]!
  one.flows.stop(run.id, 'the first round could not be opened: the board refused it')
  const after = one.flows.runsFor(one.room)[0]!
  assert.equal(after.state, 'stopped')
  assert.match(after.ended ?? '', /the first round could not be opened/)
  // And the room is free for another attempt.
  const again = await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  assert.equal(again.state, 'running')
})

test('a seat whose turn never ran is reported as that, not as an agent ignoring its tools', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  /* The first time the watchdog fired on a healthy build, it fired on a Cursor
     account that had been moved to a slow pool — no turn reached the backend
     at all — and it blamed the agent for ignoring its tools. The observation
     was right and the diagnosis was invented; a confident wrong cause reads as
     a defect in the feature. */
  one.turnFailed = 'Slow Pool Error: GPT-5 Codex family models are not currently enabled in the slow pool.'
  await one.flows.attendance()
  const run = one.flows.runsFor(one.room)[0]!
  assert.equal(run.state, 'stopped')
  assert.match(run.ended ?? '', /not touched the board since being seated/)
  assert.match(run.ended ?? '', /Their turns did not run: Slow Pool Error/)
  assert.doesNotMatch(run.ended ?? '', /takes HarnessDesk's tools without using them/)
})

test('a seated agent receives an order with run id and inputs resolved', async (t) => {
  const one = await rig(t)
  const source = `
name: Probe flow
inputs:
  codename:
    label: Agent codename
    default: mantis
roles:
  worker:
    kind: agent
    seat: cursor=gpt-5.3-codex/xhigh
    permission: read
    outcomes: [done]
    order: |
      You are {{codename}} in run {{run}}.
seed:
  role: worker
  title: "Do work"
`
  const run = await one.flows.start({
    room: one.room,
    source,
    vars: { codename: 'bumblebee' },
  })
  assert.equal(run.state, 'running')
  assert.equal(one.orders.length, 1)
  assert.match(one.orders[0]!.text, /You are bumblebee in run flow-/)
  assert.doesNotMatch(one.orders[0]!.text, /\{\{codename\}\}/)
  assert.doesNotMatch(one.orders[0]!.text, /\{\{run\}\}/)
})

test('a flow started in a room created on a linked worktree opens non-isolating seats in that worktree (#366)', async (t) => {
  const one = await rig(t)
  const worktreeRoom = (await one.team.createRoom('/repo/.worktrees/feature', 'Worktree room')).id
  const source = `
name: Worktree flow
roles:
  worker:
    kind: agent
    seat: cursor
    permission: read
    outcomes: [done]
seed:
  role: worker
  title: "Do work"
`
  await one.flows.start({ room: worktreeRoom, source })
  const seatedWorker = one.seated.find((s) => s.title.includes('worker'))
  assert.ok(seatedWorker)
  assert.equal(seatedWorker.cwd, '/repo/.worktrees/feature')
})

test('a flow check in a room created on a linked worktree runs in that worktree (#366)', async (t) => {
  const one = await rig(t)
  const worktreeRoom = (await one.team.createRoom('/repo/.worktrees/feature', 'Worktree room')).id
  const source = `
name: Worktree check flow
roles:
  gate:
    kind: check
    check:
      run: pnpm test
      cwd: packages/sub
      exits:
        "0": pass
      otherwise: fail
    outcomes: [pass, fail]
seed:
  role: gate
  title: "Run checks"
`
  await one.flows.start({ room: worktreeRoom, source })
  const runCall = one.ran.find((r) => r.command === 'pnpm test')
  assert.ok(runCall)
  assert.equal(runCall.cwd, '/repo/.worktrees/feature/packages/sub')
})

test('a flow check preserves Windows absolute cwd instead of joining with root (#462)', async (t) => {
  const one = await rig(t)
  const source = `
name: Windows absolute cwd check flow
roles:
  gate:
    kind: check
    check:
      run: pnpm test
      cwd: "D:\\\\tests\\\\e2e"
      exits:
        "0": pass
      otherwise: fail
    outcomes: [pass, fail]
seed:
  role: gate
  title: "Run checks"
`
  await one.flows.start({ room: one.room, source })
  const runCall = one.ran.find((r) => r.command === 'pnpm test')
  assert.ok(runCall)
  assert.equal(runCall.cwd, 'D:\\tests\\e2e')

  // Posix absolute path is also preserved
  const sourcePosix = `
name: Posix absolute cwd check flow
roles:
  gate:
    kind: check
    check:
      run: pnpm test
      cwd: "/opt/tests"
      exits:
        "0": pass
      otherwise: fail
    outcomes: [pass, fail]
seed:
  role: gate
  title: "Run checks"
`
  const room2 = (await one.team.createRoom('/repo', 'Room 2')).id
  await one.flows.start({ room: room2, source: sourcePosix })
  const runCallPosix = one.ran.find((r) => r.cwd === '/opt/tests')
  assert.ok(runCallPosix)
})

test("a flow's seat title names the role, room, and flow name (#369)", async (t) => {
  const one = await rig(t)
  const room = (await one.team.createRoom('/repo', 'Hunt · mantis')).id
  const source = `
name: Bug hunt
roles:
  hunter:
    count: 2
    kind: agent
    seat: cursor
    permission: read
    outcomes: [done]
seed:
  role: hunter
  title: "Sweep"
`
  await one.flows.start({ room, source })
  const titles = one.seated.map((s) => s.title)
  assert.deepEqual(titles, [
    'hunter 1 · Hunt · mantis · Bug hunt',
    'hunter 2 · Hunt · mantis · Bug hunt',
  ])
})

test('standDown and reArm do not crash when a persisted run has non-array seats (#503)', async (t) => {
  const one = await rig(t)
  const flowDir = join(one.dir, 'flows')
  await mkdir(flowDir, { recursive: true })
  await writeFile(
    join(flowDir, 'bad-seats.json'),
    JSON.stringify({
      version: 1,
      id: 'bad-seats-run',
      room: one.room,
      flow: { name: 'f', roles: [], rules: [], inputs: [] },
      state: 'running',
      vars: {},
      seats: {},
      rounds: [],
      record: [],
      startedAt: 1,
    }),
  )

  const logs: Array<{ message: string; details?: unknown }> = []
  const second = new Flows(flowDir, one.team, {
    seat: async () => ({ runtime: 'cursor', sessionId: 'x', label: 'cursor' }),
    order: async () => {},
    reseat: async () => 'cursor',
    retire: async () => {},
    join: async () => {},
    confine: async () => {},
    isolate: async () => '/repo',
    run: async () => ({ status: 0 }),
    changed: () => {},
    log: (message, details) => logs.push({ message, details }),
  })
  await second.load()
  assert.equal(second.standDown(one.room, 'runtime-a', 'session-1'), null)
  await second.reArm('runtime-a', 'session-1')
  assert.ok(logs.some((l) => l.message === 'a stored flow run could not be read'))

  // Direct in-memory test for runtime guards in standDown and reArm:
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const activeRun = one.flows.runsFor(one.room)[0] as unknown as { seats: unknown }
  assert.ok(activeRun)
  activeRun.seats = {}
  assert.equal(one.flows.standDown(one.room, 'runtime-a', 'session-1'), null)
  await one.flows.reArm('runtime-a', 'session-1')
})

test('a seated agent and a re-armed agent receive an order distinguishing {{name}} and {{seat}} (#528)', async (t) => {
  const one = await rig(t)
  const source = `
name: Seat slot test flow
roles:
  worker:
    kind: agent
    seat: cursor=gpt-5.3-codex/xhigh
    permission: read
    outcomes: [done]
    order: "Name: {{name}}, Member: {{member}}, Seat: {{seat}}"
seed:
  role: worker
  title: "Do work"
`
  await one.flows.start({ room: one.room, source })
  const named = one.team.stateFor(one.room).nicknames ?? {}
  const worker = seatsOf(one, 'worker')[0]!
  const workerKey = String(sessionKey(worker.runtime as never, worker.sessionId as never))
  const expectedNickname = named[workerKey] ?? 'worker'
  assert.equal(one.orders.length, 1)
  assert.match(one.orders[0]!.text, new RegExp(`Name: ${expectedNickname}, Member: ${expectedNickname}, Seat: cursor=gpt-5\\.3-codex/xhigh`))
  assert.notEqual(expectedNickname, 'cursor=gpt-5.3-codex/xhigh')

  // Re-arm: seat must still be distinguished from nickname
  one.kill(worker)
  await one.flows.reArm(worker.runtime, worker.sessionId)
  assert.equal(one.orders.length, 2)
  assert.match(one.orders[1]!.text, new RegExp(`Name: ${expectedNickname}, Member: ${expectedNickname}, Seat: cursor=gpt-5\\.3-codex/xhigh`))
})

test('Flows.load refuses a running run that omits rounds instead of crashing (#502)', async (t) => {
  const one = await rig(t)
  const flowDir = join(one.dir, 'flows')
  await mkdir(flowDir, { recursive: true })
  await writeFile(
    join(flowDir, 'bad-run.json'),
    JSON.stringify({
      version: 1,
      id: 'run-missing-rounds',
      room: one.room,
      flow: { name: 'f', roles: [], rules: [], inputs: [] },
      state: 'running',
      vars: {},
      seats: [],
      record: [],
      startedAt: 1,
    }),
  )

  const second = new Flows(flowDir, one.team, {
    seat: async () => ({ runtime: 'cursor', sessionId: 'x', label: 'cursor' }),
    order: async () => {},
    reseat: async () => 'cursor',
    retire: async () => {},
    join: async () => {},
    confine: async () => {},
    isolate: async () => '/repo',
    run: async () => ({ status: 0 }),
    changed: () => {},
    log: () => {},
  })

  await second.load()
  assert.equal(second.runsFor(one.room).length, 0)
})

test('Flows.load refuses a running run that has malformed flow object (#422)', async (t) => {
  const one = await rig(t)
  const flowDir = join(one.dir, 'flows')
  await mkdir(flowDir, { recursive: true })
  await writeFile(
    join(flowDir, 'bad-flow.json'),
    JSON.stringify({
      version: 1,
      id: 'run-bad-flow',
      room: one.room,
      flow: null,
      state: 'running',
      vars: {},
      seats: [],
      rounds: [],
      record: [],
      startedAt: 1,
    }),
  )

  const logs: Array<{ message: string; details?: unknown }> = []
  const second = new Flows(flowDir, one.team, {
    seat: async () => ({ runtime: 'cursor', sessionId: 'x', label: 'cursor' }),
    order: async () => {},
    reseat: async () => 'cursor',
    retire: async () => {},
    join: async () => {},
    confine: async () => {},
    isolate: async () => '/repo',
    run: async () => ({ status: 0 }),
    changed: () => {},
    log: (message, details) => logs.push({ message, details }),
  })

  await second.load()
  assert.equal(second.runsFor(one.room).length, 0)
  assert.ok(logs.some((l) => l.message === 'a stored flow run could not be read'))
})

test('a stalled flow run omits endedAt, can be stopped, and recovers when a seat answers (#557)', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const fixer = seatsOf(one, 'fixer')[0]!
  one.kill(fixer)
  for (let n = 0; n < 6; n += 1) await one.flows.reArm(fixer.runtime, fixer.sessionId)

  const stalled = one.flows.runsFor(one.room)[0]!
  assert.equal(stalled.state, 'stalled')
  // 1. endedAt must not be set on stalled
  assert.equal(stalled.endedAt, undefined, 'endedAt must not be set on stalled state')

  // 2. stop() must work on stalled run
  const stopped = one.flows.stop(stalled.id, 'person stopped stalled run')
  assert.equal(stopped.state, 'stopped')
  assert.equal(typeof stopped.endedAt, 'number')
  assert.equal(stopped.ended, 'person stopped stalled run')

  // 3. recovery on seat completing a card or re-arming
  const room2 = (await one.team.createRoom('/repo', 'Room 2')).id
  await one.flows.start({ room: room2, source: REVIEW, vars: { work: 'Fix 2' } })
  const run2Init = one.flows.runsFor(room2)[0]!
  const fixer2Seat = run2Init.seats.find((s) => s.role === 'fixer')!
  const fixer2 = { runtime: fixer2Seat.runtime, sessionId: fixer2Seat.sessionId }
  // Claim card first before killing
  await one.team.claimNext(fixer2)
  one.kill(fixer2)
  for (let n = 0; n < 6; n += 1) await one.flows.reArm(fixer2.runtime, fixer2.sessionId)
  const run2 = one.flows.runsFor(room2)[0]!
  assert.equal(run2.state, 'stalled')

  // Completing the card returns run to running and wakes seats of the role
  const heldCard = one.team.stateFor(room2).intents.find((i) => i.claim?.sessionId === fixer2.sessionId)!
  await one.team.complete(heldCard.id, { outcome: 'published' }, fixer2)
  await one.flows.flush()
  const recovered = one.flows.runsFor(room2)[0]!
  assert.equal(recovered.state, 'running')
  assert.equal(recovered.ended, null)
  assert.ok(recovered.record.some((e) => e.kind === 'started' && /recovered from stalled/.test(e.text ?? '')))

  // 4. Stalled run prevents starting another flow in the same room (#liveIn)
  const room3 = (await one.team.createRoom('/repo', 'Room 3')).id
  await one.flows.start({ room: room3, source: REVIEW, vars: { work: 'Fix 3' } })
  const fixer3Seat = one.flows.runsFor(room3)[0]!.seats.find((s) => s.role === 'fixer')!
  const fixer3 = { runtime: fixer3Seat.runtime, sessionId: fixer3Seat.sessionId }
  one.kill(fixer3)
  for (let n = 0; n < 6; n += 1) await one.flows.reArm(fixer3.runtime, fixer3.sessionId)
  assert.equal(one.flows.runsFor(room3)[0]!.state, 'stalled')

  await assert.rejects(
    () => one.flows.start({ room: room3, source: REVIEW, vars: { work: 'Cannot start while stalled' } }),
    /already running a flow/,
  )
})

test('Flows.stop does not crash when a run has non-array record data (#505)', async (t) => {
  const one = await rig(t)
  const flowDir = join(one.dir, 'flows')
  await mkdir(flowDir, { recursive: true })
  await writeFile(
    join(flowDir, 'bad-record.json'),
    JSON.stringify({
      version: 1,
      id: 'bad-record-run',
      room: one.room,
      flow: { name: 'f', roles: [], rules: [], inputs: [] },
      state: 'running',
      vars: {},
      seats: [],
      rounds: [],
      record: null,
      startedAt: 1,
    }),
  )

  const logs: Array<{ message: string; details?: unknown }> = []
  const second = new Flows(flowDir, one.team, {
    seat: async () => ({ runtime: 'cursor', sessionId: 'x', label: 'cursor' }),
    order: async () => {},
    reseat: async () => 'cursor',
    retire: async () => {},
    join: async () => {},
    confine: async () => {},
    isolate: async () => '/repo',
    run: async () => ({ status: 0 }),
    changed: () => {},
    log: (message, details) => logs.push({ message, details }),
  })
  await second.load()
  assert.ok(logs.some((l) => l.message === 'a stored flow run could not be read'))
  assert.throws(() => second.stop('bad-record-run'), /There is no flow run bad-record-run/)

  // Direct in-memory test for runtime guard in stop():
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const activeRun = one.flows.runsFor(one.room)[0] as unknown as { id: string; record: unknown; state: string }
  assert.ok(activeRun)
  activeRun.record = null
  const stopped = one.flows.stop(activeRun.id, 'manual stop')
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.record.length, 1)
  assert.equal(stopped.record[0]?.kind, 'stopped')
  assert.equal(stopped.record[0]?.text, 'manual stop')
})

test('standDown inspects the latest run in a room and does not prematurely stand down seats in subsequent runs (#438)', async (t) => {
  const one = await rig(t)
  // 1. Start Flow 1 and stop it:
  const run1 = await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Flow 1' } })
  assert.equal(run1.state, 'running')
  const seat1 = one.seated[0]!
  one.flows.stop(run1.id, 'flow 1 finished')
  assert.equal(one.flows.runsFor(one.room)[0]?.state, 'stopped')

  // 2. Start Flow 2 in the same room reusing the seat:
  const run2 = await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Flow 2' } })
  assert.equal(run2.state, 'running')
  // Reuse seat1 in run2:
  const storedRun2 = one.flows.runsFor(one.room)[1]!
  ;(storedRun2.seats as unknown as { role: string; seat: string; runtime: string; sessionId: string; cwd: string; key: string }[]).push({
    role: 'fixer',
    seat: 'cursor',
    runtime: seat1.runtime,
    sessionId: seat1.sessionId,
    cwd: seat1.cwd,
    key: `${seat1.runtime}\u0000${seat1.sessionId}`,
  })

  // 3. standDown for seat1 must return null while run2 is running:
  const standDownReason = one.flows.standDown(one.room, seat1.runtime, seat1.sessionId)
  assert.equal(standDownReason, null)

  // 4. awaitWork for seat1 must not receive stand down from the older finished flow:
  const waitResult = await one.team.awaitWork({ runtime: seat1.runtime, sessionId: seat1.sessionId })
  assert.doesNotMatch(waitResult, /^stand down — flow 1 finished/)
})

test('abandoning a flow card notifies flows engine to advance or settle the run (#434)', async (t) => {
  const one = await rig(t)
  const run = await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  assert.equal(run.state, 'running')
  const card1 = board(one).intents.find((i) => i.id === 1)
  assert.ok(card1)
  assert.equal(card1.state, 'open')

  // Abandon the card via intentAction
  await one.team.intentAction(one.room, 1, 'abandon')
  await one.flows.flush()

  const runs = one.flows.runsFor(one.room)
  assert.equal(runs[0]?.state, 'settled')
})

test('Flows.load stops running flows whose room no longer exists (#441)', async (t) => {
  const one = await rig(t)
  const flowDir = join(one.dir, 'flows')
  await mkdir(flowDir, { recursive: true })
  await writeFile(
    join(flowDir, 'orphaned-run.json'),
    JSON.stringify({
      version: 1,
      id: 'orphaned-run',
      room: 'non-existent-room-id',
      flow: { name: 'f', roles: [], rules: [], inputs: [] },
      state: 'running',
      vars: {},
      seats: [],
      rounds: [],
      record: [],
      startedAt: 1,
    }),
  )

  const second = new Flows(flowDir, one.team, {
    seat: async () => ({ runtime: 'cursor', sessionId: 'x', label: 'cursor' }),
    order: async () => {},
    reseat: async () => 'cursor',
    retire: async () => {},
    join: async () => {},
    confine: async () => {},
    isolate: async () => '/repo',
    run: async () => ({ status: 0 }),
    changed: () => {},
    log: () => {},
  })
  await second.load()
  await second.flush()
  const run = second.runsFor('non-existent-room-id')[0]
  assert.ok(run)
  assert.equal(run.state, 'stopped')
  assert.equal(run.ended, 'the room this flow ran in is gone')
})

test('deleting a room stops active flow runs and allows seats to stand down (#419)', async (t) => {
  const one = await rig(t)
  const run = await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  assert.equal(run.state, 'running')
  const seat = one.seated[0]!
  assert.ok(seat)

  // Before deleting room:
  assert.equal(one.flows.runsFor(one.room)[0]?.state, 'running')
  assert.equal(one.flows.standDown(one.room, seat.runtime, seat.sessionId), null)

  // Delete the room:
  await one.team.deleteRoom(one.room)

  // After deleting room:
  // 1. Flow run must be stopped:
  const runsAfter = one.flows.runsFor(one.room)
  assert.equal(runsAfter.length, 1)
  assert.equal(runsAfter[0]?.state, 'stopped')
  assert.match(runsAfter[0]?.ended ?? '', /the room this flow ran in was deleted/)

  // 2. standDown must return the reason:
  const reason = one.flows.standDown(one.room, seat.runtime, seat.sessionId)
  assert.match(reason ?? '', /the room this flow ran in was deleted/)

  // 3. awaitWork for the seated agent must return stand down, not throw NOT_IN_ROOM:
  const waitResult = await one.team.awaitWork({ runtime: seat.runtime, sessionId: seat.sessionId })
  assert.match(waitResult, /^stand down — the room this flow ran in was deleted/)

  // 4. An active waiter blocked inside awaitWork stands down immediately when room is deleted:
  const room2 = (await one.team.createRoom('/repo', 'Fix room 2')).id
  await one.flows.start({ room: room2, source: REVIEW, vars: { work: 'Fix it again' } })
  const seat2 = one.seated[one.seated.length - 1]!
  const waitingPromise = one.team.awaitWork({ runtime: seat2.runtime, sessionId: seat2.sessionId }, { blockMs: 10000 })
  await one.team.deleteRoom(room2)
  const waiterResult = await waitingPromise
  assert.match(waiterResult, /^stand down — the room this flow ran in was deleted/)
})

test('stopping a flow and leaving a room does not cause awaitWork to return stale stand down (#419 regression)', async (t) => {
  const one = await rig(t)
  const run = await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  const seat = one.seated[0]!
  assert.ok(seat)

  // 1. Stop the run manually
  await one.flows.stop(run.id, 'manual stop')

  // 2. Member leaves room
  await one.team.leaveRoom(one.room, seat.runtime as never, seat.sessionId)

  // 3. awaitWork must throw NOT_IN_ROOM, not return stale stand down from historical run
  await assert.rejects(
    () => one.team.awaitWork({ runtime: seat.runtime, sessionId: seat.sessionId }),
    /not in a room/i,
  )
})

test('restart recovers and runs check round opened by a rule (#437)', async (t) => {
  const one = await rig(t)
  const GATED = `
name: Gate it
roles:
  fixer: { kind: agent, seat: cursor, outcomes: [published, cannot], permission: publish }
  tests:
    kind: check
    run: pnpm verify
    exits: { 0: pass }
    otherwise: fail
seed: { role: fixer, title: Fix it }
rules:
  - { id: gate, on: fixer, when: { every: published }, then: { role: tests, title: Run the gate } }
  - { id: back, on: tests, when: { any: pass }, then: { role: fixer, title: All done } }
`
  await one.flows.start({ room: one.room, source: GATED })
  const fixer = seatsOf(one, 'fixer')[0]!
  await one.team.claimNext(fixer)

  // Simulate a crash/failure during the check command when the rule fires:
  one.throwOnRun = new Error('simulated process crash during check')
  await one.team.complete(1, { outcome: 'published' }, fixer)
  await one.flows.flush()

  // The check round card was opened on the board and the run saved to disk:
  assert.equal(board(one).intents.find((i) => i.id === 2)?.state, 'open')

  // Simulate desk restart:
  const secondRan: { command: string; cwd: string }[] = []
  const second = new Flows(join(one.dir, 'flows'), one.team, {
    seat: async () => ({ runtime: 'cursor', sessionId: 'x', label: 'cursor' }),
    order: async () => {},
    reseat: async () => 'cursor',
    retire: async () => {},
    join: async () => {},
    confine: async () => {},
    isolate: async () => '/repo',
    run: async (command, where) => {
      secondRan.push({ command, cwd: where.cwd })
      return { status: 0 }
    },
    changed: () => {},
    log: () => {},
  })
  one.team.attachFlows(second)
  await second.load()
  await second.flush()

  // On load, reconciliation does not run checks (agents may not be up):
  assert.equal(secondRan.length, 0, 'load does not issue check commands')
  assert.equal(board(one).intents.find((i) => i.id === 2)?.state, 'open')

  // On resume, the desk wakes seats and resumes open check commands:
  await second.resume()
  await second.flush()

  assert.equal(secondRan.length, 1, 'check command should have been run after restart')
  assert.equal(secondRan[0]?.command, 'pnpm verify')
  assert.equal(board(one).intents.find((i) => i.id === 2)?.state, 'done')
  assert.equal(board(one).intents.find((i) => i.id === 2)?.outcome, 'pass')
  assert.equal(board(one).intents.find((i) => i.id === 3)?.title, 'All done')
})

test('restart recovers and runs interrupted seed check round (#437)', async (t) => {
  const one = await rig(t)
  const flowDir = join(one.dir, 'flows')
  await mkdir(flowDir, { recursive: true })
  const card = one.team.addIntentForFlow(one.room, { title: 'Run the gate first', role: 'tests' })
  await writeFile(
    join(flowDir, 'seed-run.json'),
    JSON.stringify({
      id: 'seed-run',
      room: one.room,
      flow: {
        name: 'Seed Gate',
        roles: [
          { kind: 'check', id: 'tests', check: { run: 'pnpm verify', cwd: null, timeout: 30, exits: { '0': 'pass' }, otherwise: 'fail' }, outcomes: [] },
          { kind: 'agent', id: 'fixer', count: 1, seat: 'cursor', outcomes: ['published', 'cannot'], permission: 'publish' },
        ],
        rules: [
          { id: 'on-pass', on: 'tests', when: { any: 'pass' }, then: { role: 'fixer', title: 'All done' } },
        ],
        inputs: [],
        seed: { role: 'tests', title: 'Run the gate first' },
      },
      state: 'running',
      vars: {},
      seats: [{ key: 'cursor\u0000x', role: 'fixer', runtime: 'cursor', sessionId: 'x', seat: 'cursor', spec: 'cursor', permission: 'publish', cwd: '/repo' }],
      rounds: [{ role: 'tests', intents: [card.id], round: 0 }],
      record: [],
      startedAt: 1,
    }),
  )

  const secondRan: { command: string; cwd: string }[] = []
  const second = new Flows(flowDir, one.team, {
    seat: async () => ({ runtime: 'cursor', sessionId: 'x', label: 'cursor' }),
    order: async () => {},
    reseat: async () => 'cursor',
    retire: async () => {},
    join: async () => {},
    confine: async () => {},
    isolate: async () => '/repo',
    run: async (command, where) => {
      secondRan.push({ command, cwd: where.cwd })
      return { status: 0 }
    },
    changed: () => {},
    log: () => {},
  })
  one.team.attachFlows(second)
  await second.load()
  await second.flush()

  assert.equal(secondRan.length, 0, 'load does not issue check commands')

  await second.resume()
  await second.flush()

  assert.equal(secondRan.length, 1, 'check command should have been run after restart')
  assert.equal(secondRan[0]?.command, 'pnpm verify')
  assert.equal(board(one).intents.find((i) => i.id === card.id)?.state, 'done')
  assert.equal(board(one).intents.find((i) => i.id === card.id)?.outcome, 'pass')
})

test('round opened after abandoned card is not permanently blocked (#440)', async (t) => {
  const one = await rig(t)
  const FLOW = `
name: Advance after abandon
roles:
  worker: { kind: agent, count: 2, seat: cursor, outcomes: [published, cannot], permission: publish }
  reviewer: { kind: agent, count: 1, seat: cursor, outcomes: [approved, reject], permission: read }
seed: { role: worker, title: Work }
rules:
  - { id: to-review, on: worker, when: { any: published }, then: { role: reviewer, title: Review } }
`
  await one.flows.start({ room: one.room, source: FLOW })
  const workers = seatsOf(one, 'worker')
  assert.equal(workers.length, 2)
  const worker1 = workers[0]!
  const reviewer = seatsOf(one, 'reviewer')[0]!

  // Worker 1 claims and publishes card 1
  await one.team.claimNext(worker1)
  await one.team.complete(1, { outcome: 'published' }, worker1)

  // Card 2 is abandoned by user/referee
  await one.team.intentAction(one.room, 2, 'abandon')
  await one.flows.flush()

  // Card 3 should be open for the reviewer, not blocked by abandoned card 2:
  const card3 = board(one).intents.find((i) => i.id === 3)
  assert.ok(card3, 'review card was created')
  assert.equal(card3.state, 'open', 'card 3 should be open, but was blocked')
  assert.deepEqual(card3.dependsOn, [1], 'card 3 should only depend on completed cards')

  // Reviewer can claim card 3
  const claimed = await one.team.claimNext(reviewer)
  assert.match(claimed, /^Claimed #3/)
})

/*
 * A folder that cannot be opened is not a folder with nothing in it.
 *
 * Both readers here — the project's flows and the desk's own runs — answered
 * every failure to open their folder with nothing, so a mode, a bad mount or a
 * name the filesystem will not take arrived as "no flows" or "no runs": the
 * same answer as the truth, with no path and no reason in it to act on. The
 * tests below use real filesystem conditions rather than stubs — a mode-000
 * folder for EACCES, and a 300-character name for ENAMETOOLONG, which no mode
 * and no user can skip, so each guarantee still holds where the mode test
 * skips as root.
 */

/** A desk that only notes what it was asked, so a refusal can be shown to have cost nothing. */
const asking = (asked: string[]): FlowPort => ({
  seat: async () => {
    asked.push('seat')
    return { runtime: 'cursor', sessionId: 'x', label: 'cursor' }
  },
  order: async () => void asked.push('order'),
  reseat: async () => 'cursor',
  retire: async () => {},
  join: async () => void asked.push('join'),
  confine: async () => {},
  isolate: async () => '/repo',
  run: async () => ({ status: 0 }),
  changed: () => {},
  log: () => {},
})

const errno = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: unknown }).code, expected)
  return true
}

test('a flows folder that cannot be read is raised, not listed as a project with none', async (t) => {
  const one = await rig(t)
  const root = join(one.dir, 'project')
  const folder = join(root, FLOW_DIR)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'review.yml'), REVIEW, 'utf8')
  // Readable, it lists: so the refusal below is the mode's doing and nothing else's.
  assert.deepEqual(
    (await one.flows.list(root)).map((file) => file.name),
    ['Fix and review'],
  )

  await chmod(folder, 0o000)
  try {
    const readable = await readdir(folder).then(
      () => true,
      () => false,
    )
    // Modes do not apply to root, so there is no refusal here to observe.
    if (readable) return t.skip('this user can read a directory with mode 000')

    await assert.rejects(one.flows.list(root), errno('EACCES'))
  } finally {
    await chmod(folder, 0o700)
  }
})

test('a project root the filesystem refuses outright is raised as well', async (t) => {
  const one = await rig(t)
  await assert.rejects(one.flows.list(join(one.dir, 'n'.repeat(300))), errno('ENAMETOOLONG'))
})

test('a project with no flows folder, or with a .harnessdesk that is a file, offers none', async (t) => {
  const one = await rig(t)
  const bare = join(one.dir, 'bare')
  await mkdir(bare, { recursive: true })
  assert.deepEqual(await one.flows.list(bare), [])

  /* The other half of the rule, and why ENOTDIR is not raised here: a project
     that keeps a `.harnessdesk` *file* has no flows in it, and refusing every
     listing it asks for would be a worse answer than an empty one. This passes
     against the old catch-all too, on purpose — it is what stops a later
     tidy-up from promoting ENOTDIR to an error without reddening. */
  const marked = join(one.dir, 'marked')
  await mkdir(marked, { recursive: true })
  await writeFile(join(marked, '.harnessdesk'), 'somebody touched this instead of making it\n', 'utf8')
  assert.deepEqual(await one.flows.list(marked), [])
})

test('stored runs that cannot be read are raised, and no flow starts on top of them', async (t) => {
  const one = await rig(t)
  await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  await one.flows.flush()
  const folder = join(one.dir, 'flows')

  const asked: string[] = []
  const second = new Flows(folder, one.team, asking(asked))
  await chmod(folder, 0o000)
  try {
    const readable = await readdir(folder).then(
      () => true,
      () => false,
    )
    if (readable) return t.skip('this user can read a directory with mode 000')

    await assert.rejects(second.load(), errno('EACCES'))
    /* The run above is live in this room, on disk, where this desk cannot see
       it. "No runs" would let a second flow open cards into the same board —
       the one thing a room running one flow at a time exists to prevent — so
       the refusal says what could not be read, and where. */
    const names = (error: unknown): boolean =>
      error instanceof Error && error.message.includes(folder) && /EACCES/.test(error.message)
    await assert.rejects(
      second.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it again' } }),
      names,
    )
    assert.throws(() => second.runsFor(one.room), names)
    assert.deepEqual(asked, [], 'nobody was seated, joined or spoken to')
  } finally {
    await second.flush()
    await chmod(folder, 0o700)
  }
})

test('a runs folder the filesystem refuses outright is raised as well, mode or no mode', async (t) => {
  const one = await rig(t)
  const asked: string[] = []
  const second = new Flows(join(one.dir, 'n'.repeat(300)), one.team, asking(asked))
  try {
    await assert.rejects(second.load(), errno('ENAMETOOLONG'))
    await assert.rejects(
      second.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } }),
      /ENAMETOOLONG/,
    )
    assert.throws(() => second.runsFor(one.room), /ENAMETOOLONG/)
    assert.deepEqual(asked, [])
  } finally {
    await second.flush()
  }
})

test('a file where the runs folder goes is raised: the desk could keep no run there', async (t) => {
  const one = await rig(t)
  const folder = join(one.dir, 'runs')
  await writeFile(folder, 'somebody touched this instead of making it\n', 'utf8')
  /* Unlike a project's `.harnessdesk`, which is somebody else's to make a file
     of, this folder is written by the desk and nothing else. A file in its
     place is not a desk with no runs — it is a desk where every save would
     fail and every run would be gone on the next launch — so ENOTDIR is
     raised here, and only ENOENT is "none yet". */
  const asked: string[] = []
  const second = new Flows(folder, one.team, asking(asked))
  try {
    await assert.rejects(second.load(), errno('ENOTDIR'))
    await assert.rejects(
      second.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } }),
      /ENOTDIR/,
    )
    assert.deepEqual(asked, [])
  } finally {
    await second.flush()
  }
})

test('a desk that has never kept a run loads none, and starts one', async (t) => {
  // The control for the three above: a folder nobody has made is the one "nothing".
  const one = await rig(t)
  await one.flows.load()
  assert.deepEqual(one.flows.runsFor(one.room), [])
  const run = await one.flows.start({ room: one.room, source: REVIEW, vars: { work: 'Fix it' } })
  assert.equal(run.state, 'running')
})
