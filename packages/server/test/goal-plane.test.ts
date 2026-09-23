import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { test } from 'node:test'

import type { BoardEvidence, FlowExecution, SeatRecord } from '@harnessdesk/protocol'

import { GoalPlane, type GoalPlanePort } from '../src/goals/plane.js'
import { migrateDesk } from '../src/goals/migration.js'
import { GoalStore } from '../src/goals/store.js'
import { goal, intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const exec = promisify(execFile)

const rig = async (root = '/work/repo', citationCheck?: (root: string, path: string, at: string) => Promise<void>) => {
  const home = tempDir('hd-goal-plane-')
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  await store.save({
    version: 1, goal: goal('g1', { root, cwd: root }),
    board: { nextIntent: 2, messaging: true, intents: [intent(1, { state: 'done' })], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  let facts: BoardEvidence = { room: 'g1', stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }
  let readError = false
  const seats: SeatRecord[] = []
  const transitions: string[] = []
  const forbidden = async (): Promise<never> => { throw new Error('This test must not seat or close a conversation') }
  const port: GoalPlanePort = {
    seats: { all: () => seats, byId: (id) => seats.find((one) => one.id === id) ?? null },
    confine: async (input) => ({ root: input.root, cwd: input.cwd ?? input.root }),
    known: async () => ({ project: root, busy: false }),
    claimable: () => true,
    opening: forbidden,
    board: (id) => {
      const document = store.read(id)
      return { ...document.board, id, name: document.goal.sentence, root: document.goal.root,
        updatedAt: document.goal.updatedAt, members: [] }
    },
    evidence: async () => { if (readError) throw new Error('evidence unavailable'); return facts },
    evidenceIds: async () => facts.cards.flatMap((card) => card.facts.map((fact) => ({ id: fact.record.id, seat: fact.record.seat ?? null }))),
    flow: () => undefined,
    busy: () => false,
    waits: () => false,
    stranded: () => false,
    held: () => false,
    settledFor: async () => {},
    answer: async () => ({ answer: null, gaps: [] }),
    revision: async () => ({ head: null, dirty: null }),
    changed: () => {},
    activity: (_id, previous, next) => { transitions.push(`${previous}:${next}`) },
    ready: () => ({ ok: true }),
    seatAgent: forbidden,
    openLegacySeat: forbidden,
    importOpening: forbidden,
    closeId: forbidden,
    claim: forbidden,
    releaseClaim: forbidden,
    refuseMail: forbidden,
    retainLane: forbidden,
    finish: forbidden,
    finishWrap: forbidden,
    wake: () => {},
  }
  return {
    store, seats, port, transitions,
    plane: new GoalPlane(store, port, undefined, Date.now, citationCheck),
    facts: (next: BoardEvidence) => { facts = next },
    failRead: () => { readError = true },
  }
}

test('a done card without observed evidence needs a person; a current passing check makes it ready', async () => {
  const proof = await rig()
  assert.equal((await proof.plane.view('g1')).activity, 'needs-you')
  await proof.plane.refresh('g1')
  assert.deepEqual(proof.transitions, [])
  proof.facts({
    room: 'g1', stamp: 2, checks: ['verify'], refused: [], unreadable: null,
    cards: [{ card: 1, running: [], facts: [{
      record: { id: 'fact', card: { board: 'g1', id: 1 }, observedAt: 2,
        fact: { kind: 'check', name: 'verify', run: 'node --test', exit: 0, timedOut: false,
          at: 'a'.repeat(40), dirty: false, tail: '' } },
      freshness: { state: 'fresh' }, by: null,
    }] }],
  })
  await proof.plane.refresh('g1')
  assert.equal((await proof.plane.view('g1')).activity, 'ready-to-wrap')
  assert.deepEqual(proof.transitions, ['needs-you:ready-to-wrap'])
})

test('an evidence read failure is visible and never makes settled work ready', async () => {
  const proof = await rig()
  proof.failRead()
  const view = await proof.plane.view('g1')
  assert.equal(view.problem, 'evidence unavailable')
  assert.notEqual(view.activity, 'ready-to-wrap')
})

test('creation persists an empty Goal without seating; dependency waits still allow a sentence edit', async () => {
  const proof = await rig()
  const created = await proof.plane.create({ root: '/work/repo', sentence: '  A separate effort  ', dependsOn: ['g1'] })
  assert.equal(created.goal.sentence, 'A separate effort')
  assert.deepEqual(created.members, [])
  assert.deepEqual(created.board.intents, [])
  assert.equal(proof.plane.canDispatch(created.goal.id).ok, false)
  const changed = await proof.plane.update(created.goal.id, 0, { sentence: 'A clearer sentence' })
  assert.equal(changed.goal.revision, 1)
  assert.equal(changed.goal.sentence, 'A clearer sentence')
  await assert.rejects(proof.plane.update(created.goal.id, 0, { sentence: 'stale edit' }), /Goal changed/)
})

test('restored Goal history has no members and cannot dispatch or accept edits', async () => {
  const proof = await rig()
  const document = proof.store.read('g1')
  await proof.store.save({ ...document, restored: { at: 2 }, goal: { ...document.goal, revision: 1 } }, 0)
  proof.seats.push(seat())
  const view = await proof.plane.view('g1')
  assert.deepEqual(view.members, [])
  assert.equal(view.activity, null)
  assert.match(view.problem!, /came from a backup/)
  assert.equal(proof.plane.canDispatch('g1').ok, false)
  await assert.rejects(proof.plane.update('g1', 1, { sentence: 'continue' }), /read-only/)
})

test('failed wrap replay keeps startup readable and exposes a retryable read-only problem', async () => {
  const proof = await rig()
  const document = proof.store.read('g1')
  const receipt = {
    version: 1 as const, id: 'receipt-1', goal: 'g1', sentence: document.goal.sentence, wrappedAt: 3,
    summary: 'Finished.', cards: [{ id: 1, resolution: 'finished' as const, reason: null }],
    seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
  }
  await proof.store.save({
    ...document,
    goal: { ...document.goal, state: 'wrapping', revision: 1 },
    operation: { kind: 'wrap', id: 'wrap-1', goal: 'g1', stamp: 'a'.repeat(64), receipt },
  }, 0)
  await proof.plane.recover()
  const view = await proof.plane.view('g1')
  assert.equal(view.goal.state, 'wrapping')
  assert.match(view.problem!, /Wrapping could not finish: This test must not seat or close a conversation/)
  assert.equal(proof.plane.canDispatch('g1').ok, false)
})

test('citation and dependency commit atomically, deduplicate, and reject cycles or save failure', async () => {
  const root = tempDir('hd-goal-plane-citation-')
  await exec('git', ['init', '-q'], { cwd: root })
  await writeFile(`${root}/receipt.md`, 'reviewed\n')
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'receipt'], { cwd: root })
  const at = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const proof = await rig(root)
  const wrapped = (id: string, dependsOn: readonly string[] = []) => {
    const receipt = {
      version: 1 as const, id: `receipt-${id}`, goal: id, sentence: `Wrapped ${id}`, wrappedAt: 2,
      summary: 'Reviewed.', cards: [], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
    }
    return {
      version: 1 as const,
      goal: goal(id, { root, cwd: root, sentence: `Wrapped ${id}`, state: 'wrapped', receipt: receipt.id, dependsOn }),
      board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
      citations: [], receipt, operation: null,
    }
  }
  await proof.store.save(wrapped('source'), null)
  const citation = { goal: 'source', receipt: 'receipt-source', project: root, path: 'receipt.md', at }
  await proof.plane.cite('g1', citation)
  assert.deepEqual(proof.store.read('g1').goal.dependsOn, ['source'])
  assert.deepEqual(proof.store.read('g1').citations, [citation])
  const after = proof.store.read('g1').goal.revision
  await proof.plane.cite('g1', citation)
  assert.equal(proof.store.read('g1').goal.revision, after)
  await assert.rejects(proof.plane.cite('g1', { ...citation, receipt: 'wrong' }), /existing wrapped receipt/)
  assert.equal(proof.store.read('g1').goal.revision, after)

  await proof.store.save({ ...wrapped('cycle-source', ['cycle-target']) }, null)
  await proof.store.save({
    version: 1, goal: goal('cycle-target', { root, cwd: root }),
    board: { nextIntent: 1, messaging: true, intents: [], channel: [] }, citations: [], receipt: null, operation: null,
  }, null)
  await assert.rejects(proof.plane.cite('cycle-target', {
    goal: 'cycle-source', receipt: 'receipt-cycle-source', project: root, path: 'receipt.md', at,
  }), /wait on each other|circular/)
  assert.deepEqual(proof.store.read('cycle-target').goal.dependsOn, [])
  assert.deepEqual(proof.store.read('cycle-target').citations, [])

  await proof.store.save(wrapped('failure-source'), null)
  await proof.store.save({
    version: 1, goal: goal('failure-target', { root, cwd: root }),
    board: { nextIntent: 1, messaging: true, intents: [], channel: [] }, citations: [], receipt: null, operation: null,
  }, null)
  const save = proof.store.save.bind(proof.store)
  proof.store.save = async () => { throw new Error('injected save failure') }
  await assert.rejects(proof.plane.cite('failure-target', {
    goal: 'failure-source', receipt: 'receipt-failure-source', project: root, path: 'receipt.md', at,
  }), /injected save failure/)
  proof.store.save = save
  assert.deepEqual(proof.store.read('failure-target').goal.dependsOn, [])
  assert.deepEqual(proof.store.read('failure-target').citations, [])

  let entered!: () => void
  let release!: () => void
  const checking = new Promise<void>((resolve) => { entered = resolve })
  const paused = new Promise<void>((resolve) => { release = resolve })
  const raced = await rig(root, async () => { entered(); await paused })
  await raced.store.save(wrapped('raced-source'), null)
  await raced.store.save({
    version: 1, goal: goal('raced-target', { root, cwd: root }),
    board: { nextIntent: 1, messaging: true, intents: [], channel: [] }, citations: [], receipt: null, operation: null,
  }, null)
  const racedSave = raced.store.save.bind(raced.store)
  let racedWrites = 0
  raced.store.save = async (...args) => { racedWrites += 1; await racedSave(...args) }
  const pending = raced.plane.cite('raced-target', {
    goal: 'raced-source', receipt: 'receipt-raced-source', project: root, path: 'receipt.md', at,
  })
  await checking
  const closed = wrapped('raced-target')
  await raced.store.save({ ...closed, goal: { ...closed.goal, revision: 1 } }, 0)
  release()
  await assert.rejects(pending, /read-only|finishing/)
  assert.equal(racedWrites, 1)
  assert.deepEqual(raced.store.read('raced-target').citations, [])
})

test('a wrap refused for a stale stamp never stops a flow run first', async () => {
  const proof = await rig()
  let stopFlowsCalls = 0
  proof.port.stopFlows = async () => { stopFlowsCalls += 1 }
  proof.port.flowLive = () => false
  const choices = { summary: 'Done', cards: [{ id: 1, resolution: 'finished' as const, reason: null }] }
  const preview = await proof.plane.preview('g1', choices)
  // The Goal changed after the preview was taken (its sentence, say) — the
  // stamp taken above no longer matches, so the wrap must be refused. It must
  // be refused *before* anything stops the run this test's flag would catch.
  await proof.plane.update('g1', 0, { sentence: 'Finish something else' })
  await assert.rejects(
    proof.plane.wrap('g1', preview.stamp, choices),
    /changed while you reviewed/,
  )
  assert.equal(stopFlowsCalls, 0, 'a refused wrap must not have stopped the run first')
})

test('a wrap that will proceed does stop flow dispatch, exactly once, before it commits', async () => {
  const proof = await rig()
  let stopFlowsCalls = 0
  proof.port.stopFlows = async () => { stopFlowsCalls += 1 }
  proof.port.flowLive = () => false
  const choices = { summary: 'Done', cards: [{ id: 1, resolution: 'finished' as const, reason: null }] }
  const preview = await proof.plane.preview('g1', choices)
  proof.port.closeId = async () => {}
  proof.port.releaseClaim = async () => {}
  proof.port.refuseMail = async () => {}
  proof.port.retainLane = async () => {}
  proof.port.finishWrap = async () => {}
  const receipt = await proof.plane.wrap('g1', preview.stamp, choices)
  assert.equal(receipt.summary, 'Done')
  assert.equal(stopFlowsCalls, 1, 'a wrap that goes on to commit still stops dispatch, once, as its barrier')
})

/*
 * A receipt names its Seats once, while they are still full — read later,
 * `GoalView.members` answers `[]` for a wrapped Goal (see `membersOf`), so
 * this is the only chance to capture a name at all. An Agent's name is
 * trimmed to `null` rather than kept as an empty or blank string: a receipt
 * that carries `''` reads as "this Seat's Agent is named nothing" rather
 * than "no Agent held it", and `nameOf` in `GoalReceipt.tsx` falls back to
 * `seatLabel` only on `null`.
 */
test('a wrap names each Seat once — an Agent’s name, or its bare seatLabel when blank or absent', async () => {
  const proof = await rig()
  proof.seats.push(
    seat('seat-named', { agent: { id: 'a1', name: '  Reviewer  ', origin: 'project' }, seatLabel: 'Claude · Opus' }),
    seat('seat-blank', { agent: { id: 'a2', name: '   ', origin: 'project' }, seatLabel: 'Codex · gpt-5.6' }),
    seat('seat-none', { agent: null, seatLabel: 'Fake · default' }),
  )
  const choices = { summary: 'Done', cards: [{ id: 1, resolution: 'finished' as const, reason: null }] }
  const preview = await proof.plane.preview('g1', choices)
  assert.deepEqual([...preview.receipt.members ?? []].sort((left, right) => left.seat.localeCompare(right.seat)), [
    { seat: 'seat-blank', agent: null, seatLabel: 'Codex · gpt-5.6' },
    { seat: 'seat-named', agent: 'Reviewer', seatLabel: 'Claude · Opus' },
    { seat: 'seat-none', agent: null, seatLabel: 'Fake · default' },
  ].sort((left, right) => left.seat.localeCompare(right.seat)))
})

/*
 * A person step a run on this Goal opened is the person's to answer: the
 * Goal itself says it needs them, the same as the board draws the card.
 */
test('a person step of a run on the Goal makes the Goal need its person', async () => {
  const proof = await rig()
  const document = proof.store.read('g1')
  await proof.store.save({
    ...document,
    board: { ...document.board, nextIntent: 3, intents: [intent(1, { state: 'done' }), intent(2, { state: 'open', role: 'close' })] },
    goal: { ...document.goal, revision: 1 },
  }, 0)
  proof.facts({
    room: 'g1', stamp: 2, checks: ['verify'], refused: [], unreadable: null,
    cards: [{ card: 1, running: [], facts: [{
      record: { id: 'fact', card: { board: 'g1', id: 1 }, observedAt: 2,
        fact: { kind: 'check', name: 'verify', run: 'node --test', exit: 0, timedOut: false, at: 'a'.repeat(40), dirty: false, tail: '' } },
      freshness: { state: 'fresh' }, by: null,
    }] }],
  })
  const execution = {
    version: 2, id: 'flow-1', goal: 'g1', state: 'running', reason: null, operations: [], legacyRun: null,
    document: { format: 'agents', flow: { roles: [{ id: 'close', kind: 'person', outcomes: ['closed'] }] } },
    rounds: [{ n: 2, role: 'close', cards: [2], seats: [], evidence: [], state: 'running', cause: 'after:1:to-close' }],
  } as unknown as FlowExecution
  assert.notEqual((await proof.plane.view('g1')).activity, 'needs-you', 'an open card no run addressed to a person is not the person’s')
  proof.port.executions = () => [execution]
  assert.equal((await proof.plane.view('g1')).activity, 'needs-you')
})

test('a wrap holds the board before it reads it, and lets it go once it is done', async () => {
  const proof = await rig()
  const events: string[] = []
  proof.port.holdBoard = (goal, reason) => { events.push(`hold ${goal}: ${reason}`); return () => { events.push('release') } }
  const read = proof.port.evidence
  proof.port.evidence = async (goal) => { events.push('read'); return read(goal) }
  proof.port.flowLive = () => false
  const choices = { summary: 'Done', cards: [{ id: 1, resolution: 'finished' as const, reason: null }] }
  const preview = await proof.plane.preview('g1', choices)
  events.length = 0
  proof.port.closeId = async () => {}
  proof.port.releaseClaim = async () => {}
  proof.port.refuseMail = async () => {}
  proof.port.retainLane = async () => {}
  proof.port.finishWrap = async () => { events.push('finish') }
  await proof.plane.wrap('g1', preview.stamp, choices)
  const held = events.findIndex((one) => one.startsWith('hold g1: This Goal is wrapping'))
  assert.ok(held >= 0, JSON.stringify(events))
  assert.ok(held < events.lastIndexOf('read'), 'held before the read the receipt is built from')
  assert.deepEqual(events.slice(-2), ['finish', 'release'])
})

test('a wrap reviews the cards as the board’s one writer has them, not an older document', async () => {
  const proof = await rig()
  proof.port.cards = () => [intent(1, { state: 'done' }), intent(2, { state: 'open' })]
  const choices = { summary: 'Done', cards: [{ id: 1, resolution: 'finished' as const, reason: null }] }
  await assert.rejects(proof.plane.preview('g1', choices), /Review every card once/)
})
