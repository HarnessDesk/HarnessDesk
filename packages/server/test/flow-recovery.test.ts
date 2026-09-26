import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { FlowExecution, SeatRecord } from '@harnessdesk/protocol'

import { ExecutionFiles, FlowExecutions, type FlowExecutionPort } from '../src/flow-execution.js'
import { recoveryOf } from '../src/flow-recovery.js'
import { Flows, type FlowPort } from '../src/flows.js'
import { Team, type TeamPeer } from '../src/team.js'
import { findingsRig } from './fixtures/findings-rig.js'
import { agent, Crash, goalRig } from './fixtures/flow-goal-rig.js'
import { seat } from './fixtures/goals.js'

const HISTORY = 'history'
const MISSING = 'This run’s Goal is missing. Restore its Goal before continuing.'
const UNWRITABLE = 'This Goal cannot run work. Resolve its migration or start a new Goal.'
const UNMATCHED = 'This run’s Seats could not be matched. Its work is kept; start a new run.'
const UNCERTAIN = 'This check was interrupted. Inspect its effects, then choose Run again.'

test('old run recovery never replays an uncertain check', async (t) => {
  const healthy = { terminal: false, goalExists: true, goalWritable: true, seatsMapped: true, uncertainCheck: false }
  assert.equal(recoveryOf({ ...healthy, terminal: true, goalExists: false, uncertainCheck: true }), HISTORY)
  assert.equal(recoveryOf(healthy), 'resume')
  assert.equal(recoveryOf({ ...healthy, goalExists: false }), MISSING)
  assert.equal(recoveryOf({ ...healthy, goalWritable: false }), UNWRITABLE)
  assert.equal(recoveryOf({ ...healthy, seatsMapped: false }), UNMATCHED)
  assert.equal(recoveryOf({ ...healthy, uncertainCheck: true }), UNCERTAIN)

  // The same matrix, read back from old run files by a restarting desk.
  const dir = await mkdtemp(join(tmpdir(), 'hd-flow-recovery-'))
  const peers: TeamPeer[] = []
  const team = new Team(join(dir, 'team'), {
    peers: () => peers, rootOf: async () => '/repo', send: async () => {}, steer: async () => {},
    changed: () => {}, removed: () => {}, membershipChanged: () => {}, audit: () => {},
  })
  let teardown: Flows | null = null
  // One hook, in order: `node:test` runs `after` hooks in registration order,
  // so a removal registered first would race the board's and the runs' own
  // pending writes and have them recreate files under a folder being removed.
  t.after(async () => {
    await teardown?.flush().catch(() => {})
    await team.flush()
    await rm(dir, { recursive: true, force: true })
  })
  const rooms = {
    settled: (await team.createRoom('/repo', 'Settled')).id,
    healthy: (await team.createRoom('/repo', 'Healthy')).id,
    ambiguous: (await team.createRoom('/repo', 'Ambiguous')).id,
    check: (await team.createRoom('/repo', 'Check')).id,
  }
  const missing = 'goal-that-is-gone'
  const kept = (room: string, sessionId: string, id: string): SeatRecord =>
    seat(id, { board: room, session: { runtime: 'alpha', sessionId } })
  const book: SeatRecord[] = [
    kept(rooms.healthy, 'h1', 'seat-h1'),
    kept(rooms.ambiguous, 'a1', 'seat-a1'), kept(rooms.ambiguous, 'a1', 'seat-a1-again'),
    kept(rooms.check, 'c1', 'seat-c1'),
    kept(missing, 'm1', 'seat-m1'),
  ]
  const ran: string[] = []
  const port: FlowPort = {
    openLegacySeat: async () => { throw new Error('nothing is seated on restart') },
    releaseGoalSeat: async () => {},
    order: async () => {},
    reseat: async () => 'alpha',
    retire: async () => {},
    confine: async () => {},
    run: async (command) => { ran.push(command); return { status: 0 } },
    changed: () => {},
    log: () => {},
    recovery: {
      goal: (room) => ({ exists: room !== missing, writable: room !== missing }),
      seats: (room) => book.filter((record) => record.board === room),
    },
  }
  const worker = { kind: 'agent', id: 'worker', count: 1, seats: [{ runtime: 'alpha' }], permission: 'edit', outcomes: ['done'], order: 'Work.' }
  const gate = { kind: 'check', id: 'gate', count: 1, seats: [], outcomes: [], check: { run: 'make verify', timeout: 30, exits: { '0': 'pass' }, otherwise: 'fail' } }
  const cardFor = (room: string, role: string) => team.addIntentForFlow(room, { title: 'Open work', role }, { kind: 'user' }).id
  const old = (id: string, room: string, state: string, sessionId: string, role: 'worker' | 'gate') => ({
    version: 1, id, room, state, startedAt: 1, vars: {}, record: [],
    flow: { name: id, roles: [worker, gate], rules: [], inputs: [], seed: { role, title: 'Open work' } },
    seats: [{ key: `alpha\u0000${sessionId}`, role: 'worker', runtime: 'alpha', sessionId, seat: 'alpha', cwd: '/repo', permission: 'edit' }],
    rounds: [{ n: 1, role, intents: room === missing ? [] : [cardFor(room, role)], openedAt: 1 }],
  })
  const folder = join(dir, 'flows')
  await mkdir(folder, { recursive: true })
  const files = {
    settled: old('settled', rooms.settled, 'settled', 's1', 'worker'),
    healthy: old('healthy', rooms.healthy, 'running', 'h1', 'worker'),
    missing: old('missing', missing, 'running', 'm1', 'worker'),
    ambiguous: old('ambiguous', rooms.ambiguous, 'running', 'a1', 'worker'),
    check: old('check', rooms.check, 'running', 'c1', 'gate'),
  }
  for (const [name, run] of Object.entries(files)) await writeFile(join(folder, `${name}.json`), JSON.stringify(run), 'utf8')

  // Nothing new runs here; the Goal engine only keeps the recovery decisions beside the old files.
  const executions = new FlowExecutions(new ExecutionFiles(join(dir, 'flows-v2')), team, {} as FlowExecutionPort)
  const flows = new Flows(folder, team, port, undefined, executions)
  teardown = flows
  team.attachFlows(flows)
  await flows.load()
  await flows.resume()
  await flows.flush()

  const only = (room: string) => flows.runsFor(room)[0]!
  assert.equal(only(rooms.settled).state, 'settled', 'history stays history')
  assert.equal(only(rooms.healthy).state, 'running')
  assert.equal(only(rooms.healthy).ended ?? null, null)
  assert.deepEqual([only(missing).state, only(missing).ended], ['stalled', MISSING])
  assert.deepEqual([only(rooms.ambiguous).state, only(rooms.ambiguous).ended], ['stalled', UNMATCHED])
  assert.deepEqual([only(rooms.check).state, only(rooms.check).ended], ['stalled', UNCERTAIN])
  assert.deepEqual(ran, [], 'the interrupted check was not run again')
  for (const name of ['missing', 'ambiguous', 'check'] as const) {
    assert.deepEqual(JSON.parse(await readFile(join(folder, `${name}.json`), 'utf8')), files[name], `${name}: the old file is untouched`)
  }
  for (const [name, reason] of [['missing', MISSING], ['ambiguous', UNMATCHED], ['check', UNCERTAIN]] as const) {
    const sidecar = JSON.parse(await readFile(join(dir, 'flows-v2', `${name}.json`), 'utf8'))
    assert.deepEqual([sidecar.reason, sidecar.legacyRun.id], [reason, name], `${name}: the decision is kept beside the old file`)
  }
  assert.deepEqual(executions.runs(), [], 'a decision is not a run')
  // A held run still keeps its room from a second run.
  await assert.rejects(flows.start({ room: rooms.check, source: 'name: Another\nroles:\n  w: { kind: agent, seat: alpha, order: W }\nseed: { role: w, title: W }\n' }), /already running a flow/)
})

const TWO_STAGES = `
version: 2
name: Write then review
roles:
  author: { kind: agent, uses: writer }
  reviewer: { kind: agent, uses: reviewer }
seed: { role: author, title: Write }
rules:
  - { id: review, on: author, when: { every: [done] }, then: { role: reviewer, title: Review } }
`
const AGENTS = [agent('writer', ['done']), agent('reviewer', ['approve'])]
const counts = (events: readonly string[]) => ({
  opens: events.filter((one) => one.startsWith('open:')).length,
  orders: events.filter((one) => one.startsWith('order:')).length,
})

test('crash at each dispatch boundary preserves work without guessing', async (t) => {
  type Rig = Awaited<ReturnType<typeof goalRig>>
  /* A restart's one act of its own: the Seats' turns went with the desk, so
     each card still open on a running run is handed back to its Seat once,
     under a key of its own (#915). Those are counted apart, and only when
     they were sent; every other count below is what it always was. */
  const relaunched = (rig: Rig): number =>
    rig.executions.runs().flatMap((run) => run.operations).filter((one) => one.key.includes(':relaunch:') && one.state === 'finished').length
  const sent = (rig: Rig) => {
    const all = counts(rig.events)
    return { opens: all.opens, orders: all.orders - relaunched(rig) }
  }
  const sentTurns = (rig: Rig) =>
    rig.executions.runs().flatMap((run) => run.operations).filter((one) => one.kind === 'turn' && one.state === 'finished')
  /** One launch: every order it sends is a journaled turn, and no card is handed out twice. */
  const launch = async (rig: Rig) => {
    const orders = counts(rig.events).orders
    const before = new Set(sentTurns(rig).map((one) => one.key))
    await rig.restart()
    await rig.flows.resume()
    await rig.flows.flush()
    const fresh = sentTurns(rig).filter((one) => !before.has(one.key))
    assert.equal(counts(rig.events).orders - orders, fresh.length, 'every order a launch sends is one journaled turn')
    const perCard = new Map<number | null, number>()
    for (const one of fresh) perCard.set(one.card, (perCard.get(one.card) ?? 0) + 1)
    for (const [card, times] of perCard) assert.equal(times, 1, `card #${card} is handed out once in a launch, not ${times} times`)
    return fresh
  }
  const twice = async (rig: Rig) => {
    const shapes: string[] = []
    let back: readonly { readonly key: string }[] = []
    let open = 0
    for (let restart = 0; restart < 2; restart += 1) {
      const [was] = rig.executions.runs()
      open = was?.state === 'running' ? rig.board(was.goal).intents.filter((card) => card.state !== 'done' && card.state !== 'abandoned').length : 0
      const fresh = await launch(rig)
      back = fresh.filter((one) => one.key.includes(':relaunch:'))
      const [run] = rig.executions.runs()
      shapes.push(JSON.stringify({ ...sent(rig), cards: run ? rig.board(run.goal).intents.length : 0, state: run?.state, rounds: run?.rounds.length }))
    }
    assert.equal(shapes[0], shapes[1], 'a second restart opens, sends, adds and decides nothing new')
    assert.equal(back.length, open, 'and hands each card still open back to its Seat, once')
    return rig.executions.runs()[0]!
  }

  // Before the round's plan is written: nothing outside happened, so it opens once, after the restart.
  {
    const rig = await goalRig(t)
    rig.files.dieWhen = (run) => run.rounds.length === 1 && run.rounds[0]!.cards.length === 0
    await rig.start(TWO_STAGES, AGENTS)
    assert.deepEqual(sent(rig), { opens: 0, orders: 0 })
    const run = await twice(rig)
    assert.equal(run.state, 'running')
    assert.deepEqual(sent(rig), { opens: 1, orders: 1 })
    assert.equal(rig.board(run.goal).intents.length, 1)
  }
  // After the card is on the board but before its id is written: the replay finds it by its key.
  {
    const rig = await goalRig(t)
    rig.files.dieWhen = (run) => run.rounds[0]?.cards.length === 1
    const started = await rig.start(TWO_STAGES, AGENTS)
    assert.equal(rig.board(started.goal).intents.length, 1)
    const run = await twice(rig)
    assert.equal(rig.board(run.goal).intents.length, 1, 'no second card')
    assert.deepEqual(sent(rig), { opens: 1, orders: 1 })
  }
  // After the Seat opened and claimed its card, before that was written: its claim names it.
  {
    const rig = await goalRig(t)
    rig.files.dieWhen = (run) => run.operations.some((one) => one.key === 'seat:1:0' && one.state === 'finished')
    await rig.start(TWO_STAGES, AGENTS)
    const run = await twice(rig)
    assert.equal(run.state, 'running')
    assert.deepEqual(sent(rig), { opens: 1, orders: 1 }, 'the Seat is adopted, not opened again')
    assert.equal(run.operations.find((one) => one.key === 'seat:1:0')?.seat, 'seat-1')
  }
  // A conversation opened but its claim never landed: nothing says which Seat it is, so a person decides.
  {
    const rig = await goalRig(t)
    rig.beforeClaim = () => { rig.files.dead = true; throw new Crash('before the claim') }
    await rig.start(TWO_STAGES, AGENTS)
    rig.beforeClaim = null
    const run = await twice(rig)
    assert.equal(run.state, 'stalled')
    assert.match(run.reason ?? '', /interrupted while the desk was stopped/)
    assert.deepEqual(sent(rig), { opens: 1, orders: 0 })
  }
  // After the order was sent, before that was written: never sent a second time.
  {
    const rig = await goalRig(t)
    rig.files.dieWhen = (run) => run.operations.some((one) => one.key === 'turn:1:0' && one.state === 'finished')
    await rig.start(TWO_STAGES, AGENTS)
    const run = await twice(rig)
    assert.equal(run.state, 'stalled')
    assert.match(run.reason ?? '', /may not have reached its Seat/)
    assert.deepEqual(sent(rig), { opens: 1, orders: 1 })
  }
  // A crash inside the relaunch's own hand-back, after the order went: it is never sent again (#915).
  {
    const rig = await goalRig(t)
    await rig.start(TWO_STAGES, AGENTS)
    await rig.flows.flush()
    const next = await rig.restart()
    next.files.dieWhen = (run) => run.operations.some((one) => one.key.includes(':relaunch:') && one.state === 'finished')
    const orders = counts(rig.events).orders
    await rig.flows.resume().catch(() => {})
    await rig.flows.flush().catch(() => {})
    assert.equal(counts(rig.events).orders - orders, 1, 'the hand-back was sent')
    await launch(rig)
    assert.equal(counts(rig.events).orders - orders, 1, 'and only once across the crash')
    const [run] = rig.executions.runs()
    assert.equal(run!.state, 'stalled')
    assert.match(run!.reason ?? '', /may not have reached its Seat/)
  }
  // After the result, before the round's close was written: the board decides again, once.
  {
    const rig = await goalRig(t)
    const started = await rig.start(TWO_STAGES, AGENTS)
    await rig.flows.flush()
    rig.files.dieWhen = (run) => run.rounds[0]?.state === 'closed'
    await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
    await rig.flows.flush()
    assert.equal(rig.board(started.goal).intents.length, 1)
    const run = await twice(rig)
    assert.deepEqual(run.rounds.map((round) => [round.cause, round.state]), [['seed', 'closed'], ['after:1:review', 'running']])
    assert.deepEqual(sent(rig), { opens: 2, orders: 2 })
    assert.equal(rig.board(run.goal).intents.length, 2)
  }
})

test('a relaunch whose Seat was closed stalls with why, never reads as running over nobody (#915)', async (t) => {
  const rig = await goalRig(t)
  const started = await rig.start(TWO_STAGES, AGENTS)
  await rig.flows.flush()
  const record = rig.seats.get('seat-1')!
  rig.seats.set('seat-1', { ...record, closed: { at: Date.now(), why: 'released' } })
  const orders = counts(rig.events).orders
  await rig.restart()
  await rig.flows.resume()
  await rig.flows.flush()
  const [run] = rig.flows.executionsFor(started.goal)
  assert.equal(run!.state, 'stalled')
  assert.match(run!.reason ?? '', /The Seat for card #1 is closed, so its card was not handed back after the desk restarted\. This run cannot continue; start a new one to pick up the work\./)
  assert.equal(counts(rig.events).orders, orders, 'nothing was sent')
})

test('a relaunch hand-back the Seat turned busy for is not kept as one that might still be sent (#915)', async (t) => {
  const rig = await goalRig(t)
  const started = await rig.start(TWO_STAGES, AGENTS)
  await rig.flows.flush()
  await rig.restart()
  // A person writes to the Seat while it is being reopened: a turn of theirs is running when the card would go.
  rig.onReseat = (seat) => { rig.busySeats.add(String(seat.id)) }
  const orders = counts(rig.events).orders
  await rig.flows.resume()
  await rig.flows.flush()
  const [run] = rig.flows.executionsFor(started.goal)
  assert.equal(run!.state, 'running')
  assert.equal(counts(rig.events).orders, orders, 'not sent into the person’s turn')
  assert.deepEqual(run!.operations.filter((one) => one.key.includes(':relaunch:')), [], 'and not left behind as prepared')
})

test('a relaunch resumes a person’s run without waiting on the triggers’ budget read, and a trigger’s run only when asked (#915)', async (t) => {
  const rig = await goalRig(t)
  const person = await rig.start(TWO_STAGES, AGENTS)
  const triggered = await rig.startTriggered(TWO_STAGES, AGENTS)
  await rig.flows.resumeTriggered(triggered.id)
  await rig.flows.flush()
  await rig.restart()
  const back = (goal: string) => rig.flows.executionsFor(goal)[0]!.operations.filter((one) => one.key.includes(':relaunch:') && one.state === 'finished').length
  await rig.flows.resume('person')
  await rig.flows.flush()
  assert.deepEqual([back(person.goal), back(triggered.goal)], [1, 0], 'the person’s run first, the trigger’s untouched')
  await rig.flows.resume('triggered')
  await rig.flows.flush()
  assert.deepEqual([back(person.goal), back(triggered.goal)], [1, 1], 'then the trigger’s, and the person’s not twice')
})

test('a relaunch re-checks spend right before the card is handed back, not only before reopening its Seat (#939)', async (t) => {
  const rig = await goalRig(t)
  const triggered = await rig.startTriggered(TWO_STAGES, AGENTS)
  await rig.flows.resumeTriggered(triggered.id)
  await rig.flows.flush()
  await rig.restart()
  // Spend was fine when the relaunch's resume read the gate at the top of
  // the re-arm; it runs out only while the Seat is being reopened (`reseat`),
  // which can take a while — spinning up a runtime that was not already up.
  rig.triggerGate = null
  rig.onReseat = () => { rig.triggerGate = () => 'Today’s trigger spend cap was reached while its Seat was being reopened.' }
  const orders = counts(rig.events).orders
  await rig.flows.resume('triggered')
  await rig.flows.flush()
  const [run] = rig.flows.executionsFor(triggered.goal)
  assert.equal(run!.state, 'stalled', 'the stale gate read at the top of #reArm must not be the only check')
  assert.equal(run!.reason, 'Today’s trigger spend cap was reached while its Seat was being reopened.')
  assert.equal(counts(rig.events).orders, orders, 'never handed back on spend that went stale while its Seat reopened')
})

test('a Seat closed while its run is held by a pause or the cap stalls with why on release, never reads as running over nobody (#939)', async (t) => {
  const rig = await goalRig(t)
  const triggered = await rig.startTriggered(TWO_STAGES, AGENTS)
  await rig.flows.resumeTriggered(triggered.id)
  await rig.flows.flush()
  const card = rig.board(triggered.goal).intents[0]!
  const seat = [...rig.seats.values()].find((one) => one.board === triggered.goal)!
  // A pause or a lowered cap holds the run while the Seat is at work…
  await rig.flows.holdTriggered(triggered.id, 'paused for a person')
  // …its turn ends while held: not handed a new card while held, only queued for when it lifts.
  await rig.flows.reArm(seat.session.runtime, seat.session.sessionId)
  // …and its Seat closes before the hold lifts.
  rig.seats.set(String(seat.id), { ...seat, closed: { at: Date.now(), why: 'released' } })
  const orders = counts(rig.events).orders
  // The hold lifts: nothing is left to hand the queued card to.
  await rig.flows.resumeTriggered(triggered.id)
  await rig.flows.flush()
  const [run] = rig.flows.executionsFor(triggered.goal)
  assert.equal(run!.state, 'stalled', 'a closed Seat must not leave the run reading Running')
  assert.equal(run!.reason, `The Seat for card #${card.id} is closed, so its card was not handed back. This run cannot continue; start a new one to pick up the work.`)
  assert.equal(counts(rig.events).orders, orders, 'nothing was sent to a closed Seat')
})

test('a saved run that no longer matches its own text blocks its Goal, and one naming no Goal blocks every start', async (t) => {
  const rig = await goalRig(t)
  const started = await rig.start(TWO_STAGES, AGENTS)
  await rig.flows.flush()
  const file = join(rig.dir, 'flows-v2', `${encodeURIComponent(started.id)}.json`)
  const saved = JSON.parse(await readFile(file, 'utf8'))
  // Same shape, different text: the policy it would resume is not the one that was authorized.
  await writeFile(file, JSON.stringify({ ...saved, source: `${saved.source}# edited later\n` }), 'utf8')
  await rig.restart()
  assert.equal(rig.executions.runs().length, 0, 'the tampered run is not resumed')
  assert.equal(rig.executions.refusal(started.goal), 'A saved flow run could not be read. Restore its state file before starting another run.')
  await assert.rejects(rig.flows.start({ room: started.goal, source: 'name: x' }), /A saved flow run could not be read/)
  assert.equal(rig.executions.refusal(), null, 'other Goals may still start runs')

  await writeFile(join(rig.dir, 'flows-v2', 'unreadable.json'), '{', 'utf8')
  await rig.restart()
  await assert.rejects(rig.start(TWO_STAGES, AGENTS), /A saved flow run could not be read. Restore its state file before starting another run./)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).source.endsWith('# edited later\n'), true, 'the broken file is kept as it was')
})

/*
 * An order left for the end of its Seat's brief turn is decided, not sent:
 * a restart while it waits neither calls it uncertain nor stalls the run,
 * and it goes out exactly once, when the Seat's turn is over.
 */
test('a restart while an order is prepared keeps it, and sends it once when the Seat is free', async (t) => {
  const rig = await goalRig(t)
  const SOLO = `
version: 2
name: Solo
roles:
  author: { kind: agent, uses: writer }
seed: { role: author, title: Write it }
rules: []
`
  // Every Seat is inside its brief's turn as it opens.
  rig.beforeClaim = (n) => { rig.busySeats.add(`seat-${n}`) }
  const run = await rig.start(SOLO, [agent('writer', ['done'])])
  await rig.flows.flush()
  const turn = (runs: readonly FlowExecution[]) => runs[0]!.operations.find((one) => one.key === 'turn:1:0')?.state
  assert.equal(turn(rig.flows.executionsFor(run.goal)), 'prepared')
  assert.deepEqual(rig.events.filter((one) => one.startsWith('order:')), [])

  await rig.restart()
  await rig.flows.resume()
  await rig.flows.flush()
  const after = rig.flows.executionsFor(run.goal)
  assert.equal(after[0]!.state, 'running', 'a prepared order is not a step that may have happened')
  assert.equal(turn(after), 'prepared')

  // Its turn ends, as a turn does, twice over (the turn, then the idle status): one order, which starts a turn of its own.
  rig.busySeats.clear()
  rig.onOrder = (seat) => { rig.busySeats.add(String(seat.id)) }
  const { runtime, sessionId } = rig.sessionOf('seat-1')
  await rig.flows.reArm(runtime, sessionId)
  await rig.flows.reArm(runtime, sessionId)
  await rig.flows.flush()
  assert.deepEqual(rig.events.filter((one) => one.startsWith('order:')), ['order:seat-1'])
  assert.equal(turn(rig.flows.executionsFor(run.goal)), 'finished')
  assert.deepEqual(rig.flows.executionsFor(run.goal)[0]!.operations.filter((one) => one.kind === 'turn').map((one) => one.key), ['turn:1:0'],
    'a Seat inside the turn its order started is not handed its card again')
})

// ------------------------------------------------------------- findings (phase 7)
/*
 * Named addition for the findings ledger: a round's close is journaled before
 * it is processed, and processed outside the run's queue. A desk that stops
 * between the two processes it once on the way back up — one more closed
 * round counted, one next round opened — and a replay changes nothing.
 */
test('closed round replay neither double-counts nor redispatches', async (t) => {
  const f = await findingsRig(t, { dropCloses: true })
  await f.finishFixer()
  // The round closed and its close was journaled; the subscriber never ran.
  let stored = f.rig.executions.stored(f.run)!
  assert.equal(stored.rounds[0]!.state, 'closed')
  assert.equal(stored.operations.find((one) => one.key === 'close:1')?.state, 'started')
  assert.deepEqual(stored.findings?.closedRounds, [])
  assert.equal(f.cards('reviewer').length, 0, 'no round opens before its close is recorded')
  await f.restart()
  stored = f.rig.executions.stored(f.run)!
  assert.deepEqual(stored.findings?.closedRounds, [1], 'counted once')
  assert.equal(stored.operations.find((one) => one.key === 'close:1')?.state, 'finished')
  assert.equal(f.cards('reviewer').length, 2, 'the next round opened once')
  // Replayed: by the subscriber again, and by the engine resuming again.
  await f.plane.roundClosed(f.run, 1)
  await f.rig.flows.resume()
  await f.rig.flows.flush()
  stored = f.rig.executions.stored(f.run)!
  assert.deepEqual(stored.findings?.closedRounds, [1])
  assert.equal(f.cards('reviewer').length, 2, 'and never opened twice')
  assert.equal(stored.rounds.length, 2)
})
