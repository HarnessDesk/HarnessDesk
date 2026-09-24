import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import type { EvidenceRecord, WrapChoices } from '@harnessdesk/protocol'

import { EvidenceStore } from '../src/evidence/store.js'
import { FindingsPlane } from '../src/findings/plane.js'
import { Publications, type PublicationJournal, type StoredPublication } from '../src/findings/publication.js'
import { SerialRun } from '../src/flow-execution.js'
import { migrateDesk } from '../src/goals/migration.js'
import { GoalPlane } from '../src/goals/plane.js'
import { GoalStore } from '../src/goals/store.js'
import { previewWrap, wrapStamp, Wraps, type WrapInput, type WrapPort } from '../src/goals/wrap.js'
import { goal, intent } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const choices = (over: Partial<WrapChoices> = {}): WrapChoices => ({
  summary: 'The requested change is complete.',
  cards: [{ id: 1, resolution: 'finished', reason: null }],
  ...over,
})

const input = (over: Partial<WrapInput> = {}): WrapInput => ({
  goal: goal(),
  cards: [{ id: 1, state: 'done' }],
  dependencies: [],
  busy: false,
  flow: false,
  pending: false,
  seats: ['seat-1'],
  members: [{ seat: 'seat-1', agent: 'Reviewer', seatLabel: 'Fake · one' }],
  evidence: ['fact-1'],
  evidenceSeats: [{ id: 'fact-1', seat: 'seat-1' }],
  answers: [{
    seat: 'seat-1', session: { runtime: 'fake', sessionId: 'one' }, turn: 'turn-1',
    text: 'Finished.', partial: false, stopReason: null,
  }],
  lanes: [{ lane: 'lane-1', cwd: '/work/lane', dirty: false, retained: true }],
  citations: [],
  gaps: [],
  revisions: [{ cwd: '/work/repo', head: 'a'.repeat(40), dirty: false }],
  ...over,
})

test('a wrap preview requires one explicit disposition for every card and no live work', () => {
  assert.throws(() => previewWrap(input(), choices({ summary: ' ' })), /Say what finished/)
  assert.throws(() => previewWrap(input(), choices({ cards: [] })), /Review every card once/)
  assert.throws(() => previewWrap(input(), choices({ cards: [
    { id: 1, resolution: 'finished', reason: null },
    { id: 1, resolution: 'finished', reason: null },
  ] })), /Review every card once/)
  assert.throws(() => previewWrap(input({ cards: [{ id: 1, state: 'open' }] }), choices()), /Say why card 1 is finished/)
  assert.throws(() => previewWrap(input(), choices({ cards: [{ id: 1, resolution: 'dropped', reason: ' ' }] })), /Say why card 1 is dropped/)
  for (const state of [{ busy: true }, { flow: true }, { pending: true }]) {
    assert.throws(() => previewWrap(input(state), choices()), /Stop the running work/)
  }
  assert.throws(() => previewWrap(input({
    goal: goal('g1', { dependsOn: ['dependency'] }),
    dependencies: [{ id: 'dependency', state: 'open' }],
  }), choices()), /Wrap the Goals this one is waiting on first/)
})

test('a preview owns immutable copies of every reviewed collection', () => {
  const source = input()
  const approved = choices()
  const preview = previewWrap(source, approved)
  ;(source.answers as WrapInput['answers'] & unknown[]).push({
    seat: 'seat-2', session: { runtime: 'fake', sessionId: 'two' }, turn: null,
    text: 'late', partial: true, stopReason: 'interrupted',
  })
  ;(approved.cards as WrapChoices['cards'] & unknown[]).push({ id: 2, resolution: 'dropped', reason: 'late' })
  assert.equal(preview.receipt.answers.length, 1)
  assert.equal(preview.receipt.cards.length, 1)
  assert.equal(preview.stamp, wrapStamp(input(), choices()))
})

test('receipt freezes citation references: a later revision of the same input never changes the wrapped copy', () => {
  const citation = {
    goal: 'source', receipt: 'receipt-source', project: '/work/repo',
    path: '.harnessdesk/memory/note.md', at: 'a'.repeat(40),
  }
  const source = input({ citations: [citation] })
  const preview = previewWrap(source, choices())
  assert.deepEqual(preview.receipt.citations, [citation])
  // A later citation naming the same source at a newer commit — or the
  // same input object mutated in place by a caller that kept a reference —
  // must never reach back into the already-built receipt: `previewWrap`
  // clones on the way in, once, and the receipt owns its own copy from then on.
  ;(source.citations as WrapInput['citations'] & unknown[])[0] = { ...citation, at: 'b'.repeat(40) }
  assert.deepEqual(preview.receipt.citations, [citation])
  assert.notDeepEqual(preview.receipt.citations, source.citations)
})

test('a changed reviewed snapshot stages, closes and finishes nothing', async () => {
  let current = input()
  const effects: string[] = []
  const port: WrapPort = {
    read: async () => current,
    stage: async () => { effects.push('stage') },
    closeSeats: async () => { effects.push('close') },
    finish: async () => { effects.push('finish') },
  }
  const wraps = new Wraps(port)
  const approved = choices()
  const stamp = previewWrap(current, approved).stamp
  current = input({ revisions: [{ cwd: '/work/repo', head: 'b'.repeat(40), dirty: false }] })
  await assert.rejects(wraps.commit('g1', stamp, approved, 'receipt-1', 10), /changed while you reviewed/)
  assert.deepEqual(effects, [])
})

test('a wrap journals before closing, fixes its identity, and admits one queued winner', async () => {
  const effects: string[] = []
  let state = input()
  let release!: () => void
  let staged!: () => void
  const paused = new Promise<void>((resolve) => { release = resolve })
  const stageReached = new Promise<void>((resolve) => { staged = resolve })
  const port: WrapPort = {
    read: async () => state,
    stage: async (_goal, receipt) => {
      effects.push(`stage:${receipt.id}`)
      staged()
      await paused
      state = input({ goal: goal('g1', { state: 'wrapping' }) })
    },
    closeSeats: async (_goal, ids) => { effects.push(`close:${ids.join(',')}`) },
    finish: async (_goal, receipt) => { effects.push(`finish:${receipt.id}`) },
  }
  const wraps = new Wraps(port)
  const approved = choices()
  const stamp = previewWrap(state, approved).stamp
  const first = wraps.commit('g1', stamp, approved, 'receipt-1', 10)
  const second = wraps.commit('g1', stamp, approved, 'receipt-2', 20)
  await stageReached
  assert.deepEqual(effects, ['stage:receipt-1'])
  release()
  assert.equal((await first).id, 'receipt-1')
  await assert.rejects(second, /changed while you reviewed/)
  assert.deepEqual(effects, ['stage:receipt-1', 'close:seat-1', 'finish:receipt-1'])
})

test('a failed stage closes no Seat and a failed close never writes finished state', async () => {
  const stamp = previewWrap(input(), choices()).stamp
  const stageEffects: string[] = []
  await assert.rejects(new Wraps({
    read: async () => input(),
    stage: async () => { stageEffects.push('stage'); throw new Error('disk full') },
    closeSeats: async () => { stageEffects.push('close') },
    finish: async () => { stageEffects.push('finish') },
  }).commit('g1', stamp, choices(), 'receipt-1', 10), /disk full/)
  assert.deepEqual(stageEffects, ['stage'])

  const closeEffects: string[] = []
  await assert.rejects(new Wraps({
    read: async () => input(),
    stage: async () => { closeEffects.push('stage') },
    closeSeats: async () => { closeEffects.push('close'); throw new Error('close failed') },
    finish: async () => { closeEffects.push('finish') },
  }).commit('g1', stamp, choices(), 'receipt-1', 10), /close failed/)
  assert.deepEqual(closeEffects, ['stage', 'close'])
})

test('the board hold is let go when a wrap throws while closing Seats or finishing', async () => {
  for (const failing of ['closeSeats', 'finish'] as const) {
    const effects: string[] = []
    const port: WrapPort = {
      hold: () => {
        effects.push('hold')
        return () => { effects.push('let go') }
      },
      read: async () => input(),
      stage: async () => { effects.push('stage') },
      closeSeats: async () => {
        effects.push('close')
        if (failing === 'closeSeats') throw new Error('EIO')
      },
      finish: async () => {
        effects.push('finish')
        if (failing === 'finish') throw new Error('EIO')
      },
    }
    const approved = choices()
    await assert.rejects(new Wraps(port).commit('g1', previewWrap(input(), approved).stamp, approved, 'receipt-1', 10), /EIO/)
    assert.equal(effects.at(-1), 'let go', `after ${failing} threw: ${effects.join(', ')}`)
    assert.equal(effects.filter((one) => one === 'let go').length, 1)
  }
})

// ------------------------------------------------------------- findings (phase 7)
/*
 * Named addition for the findings ledger: a wrap freezes the findings the
 * Goal owns — their event ids and views — as part of its stamp, so an event
 * that lands after the preview makes that preview stale.
 */

const findingRaise = (id: string, sequence: number, event: NonNullable<EvidenceRecord['finding']>['event'], at = 'a'.repeat(40), state: 'open' | 'repaired' = 'open'): EvidenceRecord => ({
  id, fact: { kind: 'finding', id: 'finding-00000000-0000-4000-8000-000000000001', state, at },
  card: { board: 'g1', id: 1 }, checkout: { cwd: '/work/repo', branch: 'fix' }, seat: event.kind === 'raise' ? 'seat-r' : 'seat-w', round: 1, observedAt: sequence, posted: null,
  finding: { version: 1, sequence, operation: `op-${id}`, origin: { goal: 'g1', run: 'run-1', round: 1, card: 1, seat: 'seat-r', at: 'a'.repeat(40) }, event },
})

test('new finding invalidates wrap preview', async () => {
  const home = tempDir('hd-goal-wrap-findings-')
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  await store.save({
    version: 1, goal: goal('g1'), board: { nextIntent: 2, messaging: true, intents: [intent(1, { state: 'done' })], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  const evidence = new EvidenceStore(join(home, 'evidence'))
  await evidence.append('/work/repo', 'evidence', [{ type: 'evidence', record: findingRaise('raise-1', 1, { kind: 'raise', title: 'Unbounded', body: '', category: 'ordinary', blocking: true, related: null, anchor: null }) }])
  const findings = new FindingsPlane({
    store: evidence, seats: { byId: () => null, latestKeptOf: () => null },
    flows: { binding: () => null, candidate: async () => null, journal: async () => { throw new Error('no runs') }, pending: () => [] },
    projectOf: async () => '/work/repo', headOf: async () => ({ at: null, dirty: false }), now: () => 1, log: () => {},
  })
  const forbidden = async (): Promise<never> => { throw new Error('not in this test') }
  const plane = new GoalPlane(store, {
    seats: { all: () => [], byId: () => null }, confine: forbidden, known: async () => null, claimable: () => false, opening: forbidden,
    board: (id) => { const document = store.read(id); return { ...document.board, id, name: document.goal.sentence, root: document.goal.root, updatedAt: 1, members: [] } },
    evidence: async (id) => ({ room: id, stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }),
    evidenceIds: async () => [{ id: 'fact-1', seat: null }], flow: () => undefined, busy: () => false, waits: () => false, stranded: () => false, held: () => false,
    settledFor: async () => {}, answer: async () => ({ answer: null, gaps: [] }), revision: async () => ({ head: null, dirty: null }),
    changed: () => {}, activity: () => {}, ready: () => ({ ok: true }), seatAgent: forbidden, openLegacySeat: forbidden,
    importOpening: forbidden, closeId: forbidden, claim: forbidden, releaseClaim: forbidden, refuseMail: forbidden, retainLane: forbidden,
    finish: forbidden, wake: () => {},
    finishWrap: async (operation) => {
      const document = store.read(operation.goal)
      await store.save({
        ...document, receipt: operation.receipt, operation: null,
        goal: { ...document.goal, state: 'wrapped', receipt: operation.receipt.id, revision: document.goal.revision + 1 },
      }, document.goal.revision)
    },
    findings: (id) => findings.receiptWithGaps(id),
  })
  const approved = choices()
  const first = await plane.preview('g1', approved)
  assert.deepEqual(first.receipt.findings?.evidence, ['raise-1'])
  // A repair claim lands after the person reviewed the receipt.
  await evidence.append('/work/repo', 'evidence', [{ type: 'evidence', record: findingRaise('repair-1', 2, { kind: 'repair', note: 'Bounded.' }, 'b'.repeat(40), 'repaired') }])
  await assert.rejects(plane.wrap('g1', first.stamp, approved), /changed while you reviewed/)
  assert.equal(store.read('g1').goal.state, 'open', 'nothing was staged')
  const second = await plane.preview('g1', approved)
  assert.deepEqual(second.receipt.findings?.evidence, ['raise-1', 'repair-1'])
  assert.equal(second.receipt.findings?.findings[0]?.lifecycle.state, 'repaired')
  const wrapped = await plane.wrap('g1', second.stamp, approved)
  assert.deepEqual(wrapped.findings, second.receipt.findings)
  assert.deepEqual(store.read('g1').receipt?.findings, second.receipt.findings)
})

/*
 * Named addition for the findings ledger's publication: a posting the desk
 * could not settle is never silently dropped from a wrap, nor silently
 * recorded. The person says so, and the receipt then says exactly that.
 */
test('wrap shows partial publication gaps', async () => {
  const home = tempDir('hd-goal-wrap-publication-')
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  await store.save({
    version: 1, goal: goal('g1'), board: { nextIntent: 2, messaging: true, intents: [intent(1, { state: 'done' })], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  let publication: string[] = ['Posting finding finding-1 to pull request #7 is uncertain: The pull request shows 2 copies of this. Look at them before deciding which one stands.']
  const receipt = { version: 1 as const, evidence: ['raise-1', 'post-1'], findings: [], overrides: [] }
  const forbidden = async (): Promise<never> => { throw new Error('not in this test') }
  let settled = 0
  const plane = new GoalPlane(store, {
    seats: { all: () => [], byId: () => null }, confine: forbidden, known: async () => null, claimable: () => false, opening: forbidden,
    board: (id) => { const document = store.read(id); return { ...document.board, id, name: document.goal.sentence, root: document.goal.root, updatedAt: 1, members: [] } },
    evidence: async (id) => ({ room: id, stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }),
    evidenceIds: async () => [{ id: 'fact-1', seat: null }], flow: () => undefined, busy: () => false, waits: () => false, stranded: () => false, held: () => false,
    settledFor: async () => { settled += 1 }, answer: async () => ({ answer: null, gaps: [] }), revision: async () => ({ head: null, dirty: null }),
    changed: () => {}, activity: () => {}, ready: () => ({ ok: true }), seatAgent: forbidden, openLegacySeat: forbidden,
    importOpening: forbidden, closeId: forbidden, claim: forbidden, releaseClaim: forbidden, refuseMail: forbidden, retainLane: forbidden,
    finish: forbidden, wake: () => {},
    finishWrap: async (operation) => {
      const document = store.read(operation.goal)
      await store.save({
        ...document, receipt: operation.receipt, operation: null,
        goal: { ...document.goal, state: 'wrapped', receipt: operation.receipt.id, revision: document.goal.revision + 1 },
      }, document.goal.revision)
    },
    findings: async () => ({ receipt, gaps: [], publication }),
  })
  // Posting was worked to its end first, and one posting is still uncertain: the person has to say what to do with it.
  await assert.rejects(plane.preview('g1', choices()), /One posting of this Goal's findings could not be confirmed on the pull request/)
  assert.ok(settled > 0, 'the wrap waited for posting to settle before reading it')
  const recorded = await plane.preview('g1', choices({ publicationGaps: 'record' }))
  assert.ok(recorded.receipt.gaps.includes(publication[0]!), 'the receipt says exactly what is unsettled')
  assert.deepEqual(recorded.receipt.findings, receipt)
  // Reconciled after the preview — that copy was found after all — the preview no longer describes the Goal.
  publication = []
  await assert.rejects(plane.wrap('g1', recorded.stamp, choices({ publicationGaps: 'record' })), /changed while you reviewed/)
  const clean = await plane.preview('g1', choices())
  assert.equal(clean.receipt.gaps.some((gap) => /Posting finding/.test(gap)), false)
  // Uncertain again, and recorded: the wrapped receipt freezes it.
  publication = ['Posting a review summary to pull request #7 is not posted: Pull request #7 moved from aaaaaaaaaaaa to bbbbbbbbbbbb since this was reviewed, so it was not posted. A person has to look at it at the new head.']
  const again = await plane.preview('g1', choices({ publicationGaps: 'record' }))
  const wrapped = await plane.wrap('g1', again.stamp, choices({ publicationGaps: 'record' }))
  assert.ok(wrapped.gaps.includes(publication[0]!))
  assert.deepEqual(store.read('g1').receipt?.gaps, wrapped.gaps)
})

/*
 * The two real queues of the deadlock a review found, as the host holds them
 * (host.ts, "Lock order"): a run step holds its run queue and seats a card,
 * which asks for the Goal queue; a wrap preview holds the Goal queue and
 * reads the publication gaps. The gaps are a snapshot read, so neither waits.
 */
test('a wrap preview and a run step seating a card never wait on each other', async () => {
  const home = tempDir('hd-goal-wrap-lock-order-')
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  await store.save({
    version: 1, goal: goal('g1'), board: { nextIntent: 2, messaging: true, intents: [intent(1, { state: 'done' })], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  const runQueue = new SerialRun()
  const journaled: StoredPublication = { rounds: {}, ops: {} }
  const publications = new Publications({
    journal: (run: string, step: (journal: PublicationJournal) => Promise<unknown>) => runQueue.within(run, () => step({
      round: () => null, entry: () => null, entries: () => [], decide: async () => {}, put: async () => {}, backfill: async () => {},
    })),
    runs: () => [{ run: 'r1', goal: 'g1' }],
    snapshot: () => journaled,
  } as unknown as ConstructorParameters<typeof Publications>[0])
  let letRevisionGo!: () => void
  const revisionGate = new Promise<void>((resolve) => { letRevisionGo = resolve })
  let inPreview!: () => void
  const previewStarted = new Promise<void>((resolve) => { inPreview = resolve })
  const forbidden = async (): Promise<never> => { throw new Error('not in this test') }
  let seated = 0
  const plane = new GoalPlane(store, {
    seats: { all: () => [], byId: () => null }, confine: forbidden, known: async () => null, claimable: () => false, opening: forbidden,
    board: (id) => { const document = store.read(id); return { ...document.board, id, name: document.goal.sentence, root: document.goal.root, updatedAt: 1, members: [] } },
    evidence: async (id) => ({ room: id, stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }),
    evidenceIds: async () => [{ id: 'fact-1', seat: null }], flow: () => undefined, busy: () => false, waits: () => false, stranded: () => false, held: () => false,
    settledFor: async () => {}, answer: async () => ({ answer: null, gaps: [] }),
    // Reading git: the await inside the preview where the run step gets in.
    revision: async () => { inPreview(); await revisionGate; return { head: null, dirty: null } },
    changed: () => {}, activity: () => {}, ready: () => ({ ok: true }),
    seatAgent: async () => { seated += 1; throw new Error('seated, then refused by this test') },
    openLegacySeat: forbidden, importOpening: forbidden, closeId: forbidden, claim: forbidden, releaseClaim: forbidden,
    refuseMail: forbidden, retainLane: forbidden, finish: forbidden, wake: () => {}, finishWrap: forbidden,
    findings: async () => ({ receipt: { version: 1, evidence: [], findings: [], overrides: [] }, gaps: [], publication: await publications.gaps('g1') }),
  })
  const preview = plane.preview('g1', choices()).then(() => 'previewed', (error: Error) => `refused: ${error.message}`)
  await previewStarted
  const step = runQueue.within('r1', async () => {
    await plane.seat({ goal: 'g1', agent: 'x' }).catch(() => undefined)
    return 'stepped'
  })
  letRevisionGo()
  const stuck = new Promise<string>((resolve) => { const timer = setTimeout(() => resolve('stuck'), 2_000); timer.unref() })
  const results = await Promise.all([Promise.race([preview, stuck]), Promise.race([step, stuck])])
  assert.deepEqual(results, ['previewed', 'stepped'])
  assert.equal(seated, 1, 'the run step reached the seating once the preview let the Goal queue go')
})
