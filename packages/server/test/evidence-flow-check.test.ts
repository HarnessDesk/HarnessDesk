import assert from 'node:assert/strict'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { BoardEvidence, FlowRun, GoalView, TeamState, WireNotification } from '@harnessdesk/protocol'

import { EvidencePlane } from '../src/evidence/plane.js'
import { canonical } from '../src/evidence/revision.js'
import { evidenceDesk, makeRepo, until } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * A flow's check step leaves check evidence on its card, as a named check does:
 * every run the desk makes leaves a fact without being asked. The legacy
 * `flowCheck` path (below) stays best-effort, for old phase-4 callers; the v2
 * path (`runFlowCheck`) is the durable gate: a card is never marked done on a
 * fact that did not actually reach disk.
 */

test("a flow's check is recorded on its card, in its round, bound to the commit it started at", async () => {
  const repo = await makeRepo()
  const state = tempDir('hd-flow-check-state-')
  const heard: WireNotification[] = []
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile: join(state, 'seen.json'), now: () => 42 },
    {
      board: (room) => (room === 'room-1' ? ({ id: 'room-1', root: repo.dir, intents: [] } as unknown as TeamState) : null),
      cwdOf: () => null,
      push: (notification) => void heard.push(notification),
      log: () => {},
    },
  )
  const ran: string[] = []
  const answer = await plane.flowCheck(
    'pnpm test',
    { cwd: repo.dir, timeoutSec: 60, card: { room: 'room-1', intent: 5, name: 'gate', round: 2 } },
    async (command) => {
      ran.push(command)
      return { status: 1 }
    },
  )
  assert.deepEqual(answer, { status: 1 }, 'the flow is answered exactly as its runner answered')
  assert.deepEqual(ran, ['pnpm test'])
  const facts = (await plane.store.read(await canonical(repo.dir), 'evidence')).lines
  assert.equal(facts.length, 1)
  assert.ok(facts[0]?.type === 'evidence')
  const record = facts[0].record
  assert.deepEqual(record.fact, {
    kind: 'check',
    name: 'gate',
    run: 'pnpm test',
    exit: 1,
    timedOut: false,
    at: await repo.git('rev-parse', 'HEAD'),
    dirty: false,
    tail: '',
  })
  assert.deepEqual([record.card, record.round, record.seat, record.observedAt], [{ board: 'room-1', id: 5 }, 2, null, 42])
  await until(() => heard.find((one) => one.method === 'evidence/changed') ?? null, 'the evidence/changed notice')

  // A check step for no card — the flow engine's own runner, asked directly — leaves nothing.
  await plane.flowCheck('pnpm test', { cwd: repo.dir, timeoutSec: 60 }, async () => ({ status: 0 }))
  assert.equal((await plane.store.read(await canonical(repo.dir), 'evidence')).lines.length, 1)
})

test('runFlowCheck (v2): the exact command result is kept whether or not its evidence could be saved, and a storage failure never leaves a silent success', async () => {
  const repo = await makeRepo()
  const state = tempDir('hd-flow-check-v2-state-')
  const heard: WireNotification[] = []
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile: join(state, 'seen.json'), now: () => 99 },
    {
      board: (room) => (room === 'goal-1' ? ({ id: 'goal-1', root: repo.dir, intents: [] } as unknown as TeamState) : null),
      cwdOf: () => null,
      push: (notification) => void heard.push(notification),
      log: () => {},
    },
  )
  const head = await repo.git('rev-parse', 'HEAD')

  // The healthy path: the exact command result, plus a durable fact, before this resolves.
  const ok = await plane.runFlowCheck(
    'true',
    { cwd: repo.dir, timeoutSec: 5 },
    { goal: 'goal-1', card: 5, name: 'gate', round: 2 },
  )
  assert.equal(ok.problem, null)
  assert.ok(ok.evidence, 'a fact id is returned once it is durable')
  assert.equal(ok.result.exit, 0)
  const facts = (await plane.store.read(await canonical(repo.dir), 'evidence')).lines
  assert.equal(facts.length, 1)
  assert.ok(facts[0]?.type === 'evidence' && facts[0].record.fact.kind === 'check' && facts[0].record.fact.at === head)

  // Storage refuses the append (the project's own evidence file is made
  // read-only): the command's own exact result is still reported — never
  // discarded — but `problem` is set and `evidence` is null, so a caller must
  // not mark the card done on this.
  const project = await canonical(repo.dir)
  const factsFile = join(plane.store.folderOf(project), 'evidence.ndjson')
  await chmod(factsFile, 0o400)
  try {
    const failed = await plane.runFlowCheck(
      'true',
      { cwd: repo.dir, timeoutSec: 5 },
      { goal: 'goal-1', card: 5, name: 'gate', round: 2 },
    )
    assert.equal(failed.result.exit, 0, 'the command still ran and its exact result is reported')
    assert.equal(failed.evidence, null, 'no fact id: nothing durable was produced')
    assert.match(failed.problem ?? '', /evidence could not be saved/)
    assert.equal((await plane.store.read(project, 'evidence')).lines.length, 1, 'no half-written or extra line was left behind')
  } finally {
    await chmod(factsFile, 0o600)
  }
})

const GATE = `
name: Gate
roles:
  gate:
    kind: check
    check:
      run: "true"
      exits:
        "0": pass
      otherwise: fail
    outcomes: [pass, fail]
seed:
  role: gate
  title: Run the gate
`

test("through the host: a flow's check step leaves a check fact on its card", async (t) => {
  const { host, repo } = await evidenceDesk(t)
  const room = (await host.call('goal/create', { root: repo.dir, sentence: 'Gate' })) as GoalView
  const run = (await host.call('flow/start', { room: room.goal.id, source: GATE })) as FlowRun
  const board = await until(async () => {
    const read = (await host.call('evidence/board', { room: room.goal.id })) as BoardEvidence
    return read.cards.length > 0 ? read : null
  }, "the gate's check fact")
  const fact = board.cards[0]?.facts[0]?.record
  assert.equal(fact?.fact.kind, 'check')
  assert.equal(fact?.fact.kind === 'check' ? [fact.fact.name, fact.fact.run, fact.fact.exit].join(' ') : '', 'gate true 0')
  assert.equal(fact?.round, 1)
  await host.call('flow/stop', { run: run.id })
})
