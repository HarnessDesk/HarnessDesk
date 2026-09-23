import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { test } from 'node:test'

import type { BoardEvidence, GoalCitation, SeatRecord } from '@harnessdesk/protocol'

import { GoalPlane, type GoalMemorySupport, type GoalPlanePort } from '../src/goals/plane.js'
import { UNOBSERVED_LOADING_REFUSAL } from '../src/goals/assignments.js'
import { migrateDesk } from '../src/goals/migration.js'
import { MemoryPlane } from '../src/memory/plane.js'
import { GoalStore } from '../src/goals/store.js'
import { goal, intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const exec = promisify(execFile)

/** A real `MemoryPlane`, optionally wrapping `capture` with a caller-controlled delay — this file's own stand-in for the old bare `citationCheck` injection point. */
const rig = async (
  root = '/work/repo',
  delayCapture?: (citation: GoalCitation) => Promise<void>,
  attachmentsObserved?: GoalPlanePort['attachmentsObserved'],
) => {
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
    evidenceIds: async () => facts.cards.flatMap((card) => card.facts.map((fact) => fact.record.id)),
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
    ...(attachmentsObserved ? { attachmentsObserved } : {}),
  }
  const real = new MemoryPlane(tempDir('hd-goal-plane-memory-'), {
    receiptOf: (id) => { try { return store.read(id).receipt } catch { return null } },
    seats: { byId: (id) => seats.find((one) => one.id === id) ?? null },
  })
  const memory: GoalMemorySupport = {
    capture: async (citation) => {
      if (delayCapture) await delayCapture(citation)
      return real.capture(citation)
    },
    resolve: (citation) => real.resolve(citation),
    register: (index, restored) => real.register(index, restored),
    isKnownRestored: (citation) => real.isKnownRestored(citation),
  }
  return {
    store, seats, port, transitions,
    plane: new GoalPlane(store, port, undefined, Date.now, memory),
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
  // Citations now name a memory file specifically (decision 1, phase 12):
  // `.harnessdesk/memory/<slug>.md`, never an arbitrary repository path.
  await mkdir(`${root}/.harnessdesk/memory`, { recursive: true })
  await writeFile(`${root}/.harnessdesk/memory/receipt.md`, 'reviewed\n')
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
  const citation = { goal: 'source', receipt: 'receipt-source', project: root, path: '.harnessdesk/memory/receipt.md', at }
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
    goal: 'cycle-source', receipt: 'receipt-cycle-source', project: root, path: '.harnessdesk/memory/receipt.md', at,
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
    goal: 'failure-source', receipt: 'receipt-failure-source', project: root, path: '.harnessdesk/memory/receipt.md', at,
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
    goal: 'raced-source', receipt: 'receipt-raced-source', project: root, path: '.harnessdesk/memory/receipt.md', at,
  })
  await checking
  const closed = wrapped('raced-target')
  await raced.store.save({ ...closed, goal: { ...closed.goal, revision: 1 } }, 0)
  release()
  await assert.rejects(pending, /read-only|finishing/)
  assert.equal(racedWrites, 1)
  assert.deepEqual(raced.store.read('raced-target').citations, [])
})

test('a port that reports unobserved attachment loading refuses to adopt the session into a card', async () => {
  const proof = await rig('/work/repo', undefined, async () => false)
  await assert.rejects(
    proof.plane.assign('g1', 1, { runtime: 'fake', sessionId: 's1' }),
    (error: Error) => error.message === UNOBSERVED_LOADING_REFUSAL,
  )
})

test('a port with nothing to say about attachments keeps letting a claimable card through to commit', async () => {
  // No `attachmentsObserved` at all — the default rig. `opening` stays
  // `forbidden`, so reaching it (rather than an earlier refusal) is itself
  // the proof that nothing upstream of `commit` silently swallowed the
  // missing-port-method case as a refusal.
  const proof = await rig()
  await assert.rejects(proof.plane.assign('g1', 1, { runtime: 'fake', sessionId: 's1' }), /must not seat or close/)
})
