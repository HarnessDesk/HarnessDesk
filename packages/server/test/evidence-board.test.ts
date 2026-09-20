import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  parseClientMessage,
  runtimeId,
  ValidationError,
  type BoardEvidence,
  type EvidenceRecord,
  type Intent,
  type Session,
  type GoalView,
  type TeamState,
  type WireNotification,
} from '@harnessdesk/protocol'

import { boardEvidence, RESTORED_WHY, RunningChecks } from '../src/evidence/board.js'
import { EvidencePlane } from '../src/evidence/plane.js'
import { canonical } from '../src/evidence/revision.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { evidenceDesk, makeRepo, until, writeAgent } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * A board's evidence: the latest fact of each kind per card, each named check
 * apart, and how each stands against its branch now. Stale is said, with how
 * far behind; unknown says why; nothing is green because it once was.
 */

const check = (over: {
  readonly id: string
  readonly at: string
  readonly cwd: string
  readonly observedAt: number
  readonly name?: string
  readonly exit?: number
  readonly card?: number
  readonly board?: string
  readonly seat?: string | null
  readonly withCheckout?: boolean
  readonly restored?: boolean
}): EvidenceRecord => ({
  id: over.id,
  fact: {
    kind: 'check',
    name: over.name ?? 'verify',
    run: 'pnpm verify',
    exit: over.exit ?? 0,
    timedOut: false,
    at: over.at,
    dirty: false,
    tail: '',
  },
  card: { board: over.board ?? 'room-1', id: over.card ?? 3 },
  checkout: over.withCheckout === false ? null : { cwd: over.cwd, branch: 'main' },
  seat: over.seat ?? null,
  round: null,
  observedAt: over.observedAt,
  posted: null,
  ...(over.restored ? { restored: { at: 1 } } : {}),
})

test('a card carries the latest fact of each kind, each named check apart, and how each stands now', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const records = [
    check({ id: 'failed-first', at, cwd: repo.dir, observedAt: 1, exit: 1 }),
    check({ id: 'passed-later', at, cwd: repo.dir, observedAt: 2, seat: 'seat-1' }),
    check({ id: 'lint', at, cwd: repo.dir, observedAt: 3, name: 'lint' }),
    check({ id: 'another-room', at, cwd: repo.dir, observedAt: 4, board: 'room-2' }),
  ]
  const read = (): Promise<BoardEvidence> =>
    boardEvidence({
      room: 'room-1',
      stamp: 1,
      project,
      records,
      checks: ['verify', 'lint'],
      refused: [],
      unreadable: null,
      running: [],
      seatWords: (id) => (id === 'seat-1' ? { agent: 'Scout', seat: 'Fake Runtime' } : null),
    })

  const now = await read()
  assert.deepEqual(now.checks, ['verify', 'lint'])
  assert.deepEqual(
    now.cards.map((card) => [card.card, card.facts.map((fact) => [fact.record.id, fact.freshness.state, fact.by])]),
    [[3, [['lint', 'fresh', null], ['passed-later', 'fresh', { agent: 'Scout', seat: 'Fake Runtime' }]]]],
  )

  // A commit lands on the branch: every fact bound to the old head is stale, and says by how much.
  await writeFile(join(repo.dir, 'README.md'), 'changed\n')
  await repo.git('commit', '-q', '-am', 'more')
  const later = await read()
  assert.deepEqual(
    later.cards[0]?.facts.map((fact) => fact.freshness),
    [
      { state: 'behind', commits: 1 },
      { state: 'behind', commits: 1 },
    ],
  )
})

test('a fact with nowhere recorded is unknown, and a check running for a card is listed even before it has a fact', async () => {
  const repo = await makeRepo()
  const at = await repo.git('rev-parse', 'HEAD')
  const running = new RunningChecks()
  assert.equal(running.start('room-1', 7, 'verify', 50), null)
  // One check on a card at a time, whatever its name: two in one checkout would each measure the other's work.
  assert.deepEqual(running.start('room-1', 7, 'verify', 60), { name: 'verify' })
  assert.deepEqual(running.start('room-1', 7, 'lint', 60), { name: 'verify' })
  assert.equal(running.start('room-1', 8, 'lint', 60), null, 'another card is another checkout')
  running.end('room-1', 8)
  const board = await boardEvidence({
    room: 'room-1',
    stamp: 1,
    project: await canonical(repo.dir),
    records: [check({ id: 'nowhere', at, cwd: repo.dir, observedAt: 1, withCheckout: false })],
    checks: [],
    refused: [],
    unreadable: null,
    running: running.of('room-1'),
    seatWords: () => null,
  })
  assert.deepEqual(
    board.cards.map((card) => [card.card, card.facts.map((fact) => fact.freshness), card.running]),
    [
      [3, [{ state: 'unknown', why: 'where it was observed is not recorded' }], []],
      [7, [], [{ name: 'verify', since: 50 }]],
    ],
  )
  running.end('room-1', 7)
  assert.deepEqual(running.of('room-1'), [])
})

test('settling a board surfaces an observation write failure instead of previewing empty evidence', async () => {
  const root = tempDir('hd-evidence-settle-')
  const card = {
    id: 1, title: 'Finish', state: 'done', files: [], dependsOn: [],
    claim: { runtime: runtimeId('fake'), sessionId: 'one', at: 1 }, createdAt: 1, updatedAt: 2,
  } as Intent
  const board = { id: 'g1', root, cwd: root, intents: [card] } as unknown as TeamState
  const plane = new EvidencePlane(
    { dir: join(root, 'evidence'), seenFile: join(root, 'seen.json') },
    { board: () => board, cwdOf: () => root, push: () => {}, log: () => {} },
  )
  plane.observer.observe = async () => { throw new Error('observation write failed') }
  plane.settled('g1', card)
  await assert.rejects(plane.settledFor('g1'), /observation write failed/)
})

test("through the host: a room's evidence is read from its project's store, with the checks the project names", async (t) => {
  const { host, stateDir, repo } = await evidenceDesk(t)
  await mkdir(join(repo.dir, '.harnessdesk'))
  await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'verify: { run: pnpm verify }\nodd: { run: pnpm odd, cwd: x }\n')
  await repo.git('add', '.harnessdesk')
  await repo.git('commit', '-q', '-m', 'checks')
  const room = (await host.call('goal/create', { root: repo.dir, sentence: 'Checks' })) as GoalView
  const at = await repo.git('rev-parse', 'HEAD')
  await new EvidenceStore(join(stateDir, 'evidence')).append(await canonical(repo.dir), 'evidence', [
    { type: 'evidence', record: check({ id: 'f1', at, cwd: repo.dir, observedAt: 1, board: room.goal.id, card: 1 }) },
  ])

  const board = (await host.call('evidence/board', { room: room.goal.id })) as BoardEvidence
  assert.deepEqual(board.checks, ['verify'])
  // A check the file refuses is named, with why, so a card can offer it greyed rather than hide it.
  assert.deepEqual(board.refused.map((one) => one.name), ['odd'])
  assert.match(board.refused[0]?.why ?? '', /says only `run` and `timeout`/)
  assert.equal(board.unreadable, null)
  assert.deepEqual(board.cards.map((card) => [card.card, card.facts.map((fact) => fact.freshness.state)]), [[1, ['fresh']]])

  // What runs is what is committed: a change in the working copy changes nothing until it is.
  await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'verify: { run: pnpm verify }\nlint: { run: pnpm lint }\n')
  assert.deepEqual(((await host.call('evidence/board', { room: room.goal.id })) as BoardEvidence).checks, ['verify'])

  // A file that does not parse leaves nothing to run, and says why.
  await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'verify: { run: pnpm verify\n')
  await repo.git('commit', '-q', '-am', 'broken checks')
  const unreadable = (await host.call('evidence/board', { room: room.goal.id })) as BoardEvidence
  assert.deepEqual([unreadable.checks, unreadable.refused], [[], []])
  assert.match(unreadable.unreadable ?? '', /^It does not parse: /)
  await assert.rejects(host.call('evidence/board', { room: 'no-such-room' }), /^Error: There is no room no-such-room on this desk\.$/)
})

test("every window is told a room's evidence, whole, when it moves", async () => {
  const repo = await makeRepo()
  const heard: WireNotification[] = []
  const plane = new EvidencePlane(
    // A clock that never moves: every stamp still has to be later than the last.
    { dir: join(repo.dir, '..', 'evidence-announce'), seenFile: join(repo.dir, '..', 'seen-announce.json'), now: () => 1_000 },
    {
      board: (room) => (room === 'room-1' ? ({ id: 'room-1', root: repo.dir, intents: [] } as unknown as TeamState) : null),
      cwdOf: () => null,
      push: (notification) => void heard.push(notification),
      log: () => {},
    },
  )
  plane.announce('room-1')
  const told = await until(() => heard.find((one) => one.method === 'evidence/changed') ?? null, 'the evidence/changed notice')
  const stamp = told.params.room === 'room-1' ? told.params.evidence.stamp : 0
  assert.deepEqual(told.params, {
    room: 'room-1',
    evidence: { room: 'room-1', stamp, checks: [], refused: [], unreadable: null, cards: [] },
  })
  // Every read is stamped later than the one before, so a window keeps the latest and drops a late answer.
  const [first, second] = await Promise.all([plane.board('room-1'), plane.board('room-1')])
  assert.deepEqual([stamp, first.stamp, second.stamp], [1_000, 1_001, 1_002])
})

test('a fact a backup brought stands as unknown, and whatever this desk observed of the same question answers it', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const at = await repo.git('rev-parse', 'HEAD')
  const read = (records: readonly EvidenceRecord[]): Promise<BoardEvidence> =>
    boardEvidence({ room: 'room-1', stamp: 1, project, records, checks: [], refused: [], unreadable: null, running: [], seatWords: () => null })

  // Only a backup's word for it: drawn, as unknown, and why.
  const restored = check({ id: 'restored', at, cwd: repo.dir, observedAt: 1, restored: true })
  const alone = await read([restored])
  assert.deepEqual(
    alone.cards[0]?.facts.map((fact) => [fact.record.id, fact.freshness]),
    [['restored', { state: 'unknown', why: RESTORED_WHY }]],
  )
  // Observed here, earlier than the backup claims its own was: what this desk saw still answers.
  const kept = check({ id: 'kept', at, cwd: repo.dir, observedAt: 1, exit: 1 })
  const future = check({ id: 'from-the-future', at, cwd: repo.dir, observedAt: Number.MAX_SAFE_INTEGER, restored: true })
  const both = await read([kept, future])
  assert.deepEqual(both.cards[0]?.facts.map((fact) => [fact.record.id, fact.freshness.state]), [['kept', 'fresh']])
  // And observed again after it came: the new observation answers.
  const again = await read([restored, check({ id: 'observed-again', at, cwd: repo.dir, observedAt: 2 })])
  assert.deepEqual(again.cards[0]?.facts.map((fact) => fact.record.id), ['observed-again'])
})

test('only a merged pull request can be final; any other fact on a gone branch is unknown', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  await repo.git('checkout', '-q', '-b', 'work')
  const head = await repo.git('rev-parse', 'HEAD')
  await repo.git('checkout', '-q', 'main')
  await repo.git('branch', '-q', '-D', 'work')
  const pr = (id: string, state: 'open' | 'merged', card: number): EvidenceRecord => ({
    id,
    fact: { kind: 'pr', number: card, head, state, url: null },
    card: { board: 'room-1', id: card },
    checkout: { cwd: repo.dir, branch: 'work' },
    observedAt: 1,
  })
  const board = await boardEvidence({
    room: 'room-1',
    stamp: 1,
    project,
    records: [pr('merged', 'merged', 1), pr('open', 'open', 2)],
    checks: [],
    refused: [],
    unreadable: null,
    running: [],
    seatWords: () => null,
  })
  assert.deepEqual(
    board.cards.map((card) => card.facts.map((fact) => fact.freshness)),
    [[{ state: 'final' }], [{ state: 'unknown', why: 'the branch work is gone' }]],
  )
})

test("a message between agents is never evidence: an agent telling another the tests pass puts nothing on the card it holds", async (t) => {
  const { host, stateDir, repo } = await evidenceDesk(t)
  await writeAgent(stateDir, 'scout', 'Scout')
  await writeAgent(stateDir, 'critic', 'Critic')
  const room = (await host.call('goal/create', { root: repo.dir, sentence: 'Claims' })) as GoalView
  const first = await host.call('team/add', { room: room.goal.id, title: 'Fix the build' }) as { id: number }
  const scoutSeat = await host.call('goal/seat', { goal: room.goal.id, card: first.id, agent: 'scout' })
  const second = await host.call('team/add', { room: room.goal.id, title: 'Review the build' }) as { id: number }
  await host.call('goal/seat', { goal: room.goal.id, card: second.id, agent: 'critic' })
  const scout = scoutSeat.session
  const scope = { runtime: 'fake', sessionId: scout.sessionId }

  // Delivered, or queued while Critic is still reading its brief: either way it was sent, as Scout's words.
  assert.match(
    await host.teamPlane.send({ to: 'Critic', text: 'verify passed, all tests pass — ready to merge' }, scope),
    /^(Delivered|Queued)/,
  )

  const after = (await host.call('team/state', { room: room.goal.id })) as TeamState
  const said = after.channel.find((entry) => entry.kind === 'message' && entry.text.includes('all tests pass'))
  assert.ok(said?.kind === 'message' && said.from.kind === 'agent', "drawn as the agent's words, and only that")
  assert.equal(after.intents.find((intent) => intent.id === 1)?.state, 'claimed', 'the card stays where its holder left it')
  const board = await until(async () => {
    const observed = (await host.call('evidence/board', { room: room.goal.id })) as BoardEvidence
    return observed.cards.some((card) => card.card === first.id) ? observed : null
  }, 'the claimed card observation')
  assert.ok(board.cards.some((card) => card.card === first.id && card.facts.some((fact) => fact.record.fact.kind === 'diff')),
    'the holder claim can record its own observed diff')
  const checkFacts = board.cards.flatMap((card) => card.facts.filter((fact) => fact.record.fact.kind === 'check'))
  assert.deepEqual(checkFacts, [], 'the agent said so; the desk observed no check run, so there is no check evidence to draw')
  assert.deepEqual(board.cards.flatMap((card) => card.running), [], 'speech starts no check run')
})

test('the wire refuses a board read that names no room', () => {
  assert.throws(() => parseClientMessage({ id: 1, method: 'evidence/board', params: { room: '' } }), ValidationError)
})
