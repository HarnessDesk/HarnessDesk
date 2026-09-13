import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { sessionKey, type RuntimeId, type TeamState } from '@harnessdesk/protocol'

import { Flows, type FlowPort } from '../src/flows.js'
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
  /** What a check's command is told to answer. */
  exits: Map<string, number>
  readonly ran: { command: string; cwd: string }[]
  /** Ends a seat's turn, the way a lapsed window or a refused call does. */
  kill(seat: { runtime: string; sessionId: string }): void
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

const rig = async (t: { after(fn: () => Promise<void>): void }): Promise<Rig> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-flows-'))
  const peers: TeamPeer[] = []
  const seated: Rig['seated'] = []
  const orders: Rig['orders'] = []
  const isolated: string[] = []
  const ran: Rig['ran'] = []
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
      n += 1
      const sessionId = `s${n}`
      peers.push(peerOf(seat.runtime, sessionId, where.cwd, seat.model ?? seat.runtime))
      const spec = `${seat.runtime}${seat.model ? `=${seat.model}` : ''}${seat.effort ? `/${seat.effort}` : ''}`
      seated.push({ runtime: seat.runtime, sessionId, cwd: where.cwd, spec, title: where.title })
      return { runtime: seat.runtime, sessionId, label: spec }
    },
    order: async (runtime, sessionId, text) => {
      orders.push({ key: String(sessionKey(runtime as never, sessionId as never)), text })
    },
    join: async (id, runtime, sessionId) => {
      await team.joinRoom(id, runtime as RuntimeId, sessionId)
    },
    isolate: async (root, name) => {
      const path = `${root}/.worktrees/${name}`
      isolated.push(path)
      return path
    },
    run: async (command, where) => {
      ran.push({ command, cwd: where.cwd })
      return { status: exits.get(command) ?? 0 }
    },
    changed: () => {},
    log: () => {},
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
  return { team, flows, room, dir, peers, seated, orders, isolated, exits, ran, kill }
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
    join: async () => {},
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
  assert.ok(
    record.some((entry) => entry.kind === 'stopped' && /not being re-armed again/.test(entry.text ?? '')),
    'the run records that it stopped re-arming, so a stalled flow is visible',
  )
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
