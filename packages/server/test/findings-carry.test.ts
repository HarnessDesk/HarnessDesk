import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import type { EvidenceRecord, Goal, GoalReceipt } from '@harnessdesk/protocol'

import { EvidenceStore } from '../src/evidence/store.js'
import { foldFindings } from '../src/findings/model.js'
import { FindingsPlane, type FindingsPort } from '../src/findings/plane.js'
import { GoalPlane, type GoalPlanePort } from '../src/goals/plane.js'
import { migrateDesk } from '../src/goals/migration.js'
import { atomicJson, GoalStore } from '../src/goals/store.js'
import { goal, intent } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

/*
 * A person carries unresolved findings from a wrapped Goal's receipt into an
 * open Goal of the same project: the same finding, the same raiser, round and
 * revision, a new owner, and a dependency on the source — journaled as one
 * Goal operation before either side changes, so a stop part-way finishes
 * both sides once and the target does no work until it has.
 */

const ROOT = '/work/repo'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const F1 = 'finding-00000000-0000-4000-8000-000000000001'
const F2 = 'finding-00000000-0000-4000-8000-000000000002'
const F3 = 'finding-00000000-0000-4000-8000-000000000003'

const raise = (finding: string, blocking = true): EvidenceRecord => ({
  id: `raise-${finding.slice(-1)}`,
  fact: { kind: 'finding', id: finding, state: 'open', at: A },
  card: { board: 'source', id: 2 }, checkout: { cwd: ROOT, branch: 'fix' }, seat: 'seat-r', round: 2, observedAt: 1, posted: null,
  finding: {
    version: 1, sequence: 1, operation: `op-raise-${finding.slice(-1)}`,
    origin: { goal: 'source', run: 'run-1', round: 2, card: 2, seat: 'seat-r', at: A },
    event: { kind: 'raise', title: `Finding ${finding.slice(-1)}`, body: 'Details.', category: 'ordinary', blocking, related: null, anchor: null },
  },
})
const repair = (finding: string): EvidenceRecord => ({
  id: `repair-${finding.slice(-1)}`,
  fact: { kind: 'finding', id: finding, state: 'repaired', at: B },
  card: { board: 'source', id: 3 }, checkout: { cwd: ROOT, branch: 'fix' }, seat: 'seat-w', round: 3, observedAt: 2, posted: null,
  finding: { version: 1, sequence: 2, operation: `op-repair-${finding.slice(-1)}`, origin: raise(finding).finding!.origin, event: { kind: 'repair', note: 'Fixed.' } },
})
const confirm = (finding: string): EvidenceRecord => ({
  id: `confirm-${finding.slice(-1)}`,
  fact: { kind: 'finding', id: finding, state: 'repaired', at: B },
  card: { board: 'source', id: 4 }, checkout: { cwd: ROOT, branch: 'fix' }, seat: 'seat-r2', round: 4, observedAt: 3, posted: null,
  finding: { version: 1, sequence: 3, operation: `op-confirm-${finding.slice(-1)}`, origin: raise(finding).finding!.origin, event: { kind: 'verdict', state: 'repaired', note: 'Confirmed.', by: 'seat' } },
})

interface CarryRig {
  home: string
  store: GoalStore
  goals: GoalPlane
  findings: FindingsPlane
  evidence: EvidenceStore
  appendHook: (() => Promise<void>) | null
  failWrite: ((file: string, value: unknown) => boolean) | null
  reopen(): Promise<void>
  records(): Promise<EvidenceRecord[]>
  receipt: GoalReceipt
}

const carryRig = async (over: { source?: Partial<Goal>; target?: Partial<Goal> } = {}): Promise<CarryRig> => {
  const home = tempDir('hd-findings-carry-')
  await migrateDesk(home, async () => {})
  const evidence = new EvidenceStore(join(home, 'evidence'))
  await evidence.append(ROOT, 'evidence', [raise(F1), raise(F2), repair(F2), raise(F3), repair(F3), confirm(F3)].map((record) => ({ type: 'evidence', record }) as const))
  const rig = { home, evidence, appendHook: null, failWrite: null } as unknown as CarryRig
  const write = async (file: string, value: unknown): Promise<void> => {
    if (rig.failWrite?.(file, value)) { rig.failWrite = null; throw new Error('the Goal file could not be written') }
    await atomicJson(file, value)
  }
  const findingsPort: FindingsPort = {
    store: {
      read: (project, file) => evidence.read(project, file),
      append: async (project, file, lines) => { if (rig.appendHook) await rig.appendHook(); await evidence.append(project, file, lines) },
    },
    seats: { byId: () => null, latestKeptOf: () => null },
    flows: {
      binding: () => null,
      candidate: async () => null,
      journal: async () => { throw new Error('no runs in this test') },
      pending: () => [],
    },
    projectOf: async () => ROOT,
    headOf: async () => ({ at: null, dirty: false }),
    now: () => 10,
    log: () => {},
    goals: { carry: (input, prepare) => rig.goals.carryFindings(input, prepare) },
  }
  const forbidden = async (): Promise<never> => { throw new Error('not in this test') }
  const goalPort = (store: GoalStore): GoalPlanePort => ({
    seats: { all: () => [], byId: () => null },
    confine: async (input) => ({ root: input.root, cwd: input.cwd ?? input.root }),
    known: async () => null, claimable: () => false, opening: forbidden,
    board: (id) => { const document = store.read(id); return { ...document.board, id, name: document.goal.sentence, root: document.goal.root, updatedAt: 1, members: [] } },
    evidence: async (id) => ({ room: id, stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }),
    evidenceIds: async () => [], flow: () => undefined, busy: () => false, waits: () => false, stranded: () => false,
    held: () => false, settledFor: async () => {}, answer: async () => ({ answer: null, gaps: [] }),
    revision: async () => ({ head: null, dirty: null }), changed: () => {}, activity: () => {}, ready: () => ({ ok: true }),
    seatAgent: forbidden, openLegacySeat: forbidden, importOpening: forbidden, closeId: forbidden, claim: forbidden,
    releaseClaim: forbidden, refuseMail: forbidden, retainLane: forbidden, finish: forbidden, finishWrap: forbidden, wake: () => {},
  })
  rig.reopen = async () => {
    rig.store = new GoalStore(home, write)
    await rig.store.load()
    rig.findings = new FindingsPlane(findingsPort)
    rig.goals = new GoalPlane(rig.store, goalPort(rig.store))
    rig.goals.attachFindings((records) => rig.findings.appendCarry(records))
  }
  await rig.reopen()
  // The source: wrapped, its receipt frozen from the ledger as it stood.
  rig.receipt = {
    version: 1, id: 'receipt-1', goal: 'source', sentence: 'The first effort', wrappedAt: 5, summary: 'Stopped with findings open.',
    cards: [{ id: 1, resolution: 'finished', reason: null }], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
    findings: await rig.findings.receipt('source'),
  }
  const sourceOpen = over.source?.state === 'open'
  await rig.store.save({
    version: 1, goal: goal('source', { sentence: 'The first effort', state: 'wrapped', receipt: 'receipt-1', ...over.source, ...(sourceOpen ? { receipt: null } : {}) }),
    board: { nextIntent: 2, messaging: true, intents: [intent(1, { state: 'done' })], channel: [] },
    citations: [], receipt: sourceOpen ? null : rig.receipt, operation: null,
  }, null)
  await rig.store.save({
    version: 1, goal: goal('target', { sentence: 'The follow-up', ...over.target }),
    board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  rig.records = async () => (await evidence.read(ROOT, 'evidence')).lines.flatMap((line) => (line.type === 'evidence' ? [line.record] : []))
  return rig
}

const carryInput = (over: Partial<Parameters<FindingsPlane['carry']>[0]> = {}) => ({
  goal: 'target', revision: 0, source: 'source', receipt: 'receipt-1', findings: [F1, F2], request: 'carry-1', ...over,
})

test('wrapped source becomes reference in later Goal', async () => {
  const rig = await carryRig()
  const receiptBefore = JSON.stringify(rig.store.read('source').receipt)
  const carried = await rig.findings.carry(carryInput())
  assert.deepEqual(carried.map((one) => one.id), [F1, F2])
  for (const view of carried) {
    assert.equal(view.ownerGoal, 'target')
    assert.equal(view.origin.goal, 'source', 'the origin is the raise’s, unchanged')
    assert.equal(view.origin.seat, 'seat-r')
    assert.equal(view.origin.at, A)
  }
  assert.equal(carried[1]!.lifecycle.state, 'repaired', 'a claimed repair is carried as it stands, still unconfirmed')
  const target = rig.store.read('target')
  assert.deepEqual(target.goal.dependsOn, ['source'])
  assert.equal(target.operation, null)
  assert.equal(target.goal.revision, 2, 'staged, then finished: two revisions')
  const records = await rig.records()
  assert.equal(records.filter((record) => record.finding?.event.kind === 'raise').length, 3, 'no raise was copied')
  assert.equal(records.filter((record) => record.finding?.event.kind === 'carry').length, 2)
  assert.equal(JSON.stringify(rig.store.read('source').receipt), receiptBefore, 'the source receipt is frozen')
  // The target owns them now; the source's receipt still says what it said.
  assert.deepEqual((await rig.findings.receipt('target')).findings.map((one) => one.id), [F1, F2])
  // The same request again is the same carry.
  const again = await rig.findings.carry(carryInput({ revision: 2 }))
  assert.deepEqual(again.map((one) => one.id), [F1, F2])
  assert.equal((await rig.records()).length, records.length)
})

test('carry recovery finishes both sides once', async () => {
  // A failed stage: the Goal store stops, and on reopening nothing happened.
  let rig = await carryRig()
  rig.failWrite = (_file, value) => (value as { operation?: { kind?: string } }).operation?.kind === 'carry'
  await assert.rejects(rig.findings.carry(carryInput()), /could not be written/)
  await rig.reopen()
  assert.equal(rig.store.read('target').operation, null)
  assert.deepEqual(rig.store.read('target').goal.dependsOn, [])
  assert.equal((await rig.records()).filter((record) => record.finding?.event.kind === 'carry').length, 0)

  // A failed append: the operation is staged, the target refuses work, and recovery finishes it.
  rig = await carryRig()
  let appends = 0
  rig.appendHook = async () => { appends += 1; if (appends === 2) throw new Error('the evidence store stopped') }
  await assert.rejects(rig.findings.carry(carryInput()), /evidence store stopped/)
  rig.appendHook = null
  assert.equal(rig.store.read('target').operation?.kind, 'carry')
  assert.equal(rig.goals.canDispatch('target').ok, false, 'the target does no work while the carry is part-way')
  await rig.reopen()
  await rig.goals.recover()
  assert.equal(rig.store.read('target').operation, null)
  assert.deepEqual(rig.store.read('target').goal.dependsOn, ['source'])
  assert.equal((await rig.records()).filter((record) => record.finding?.event.kind === 'carry').length, 2, 'each carry event once')

  // A failed finish: both events are durable, the Goal still says part-way, and recovery finishes it without a second event.
  rig = await carryRig()
  rig.failWrite = (_file, value) => {
    const document = value as { operation?: unknown; goal?: { dependsOn?: string[] } }
    return document.operation === null && (document.goal?.dependsOn ?? []).includes('source')
  }
  await assert.rejects(rig.findings.carry(carryInput()), /could not be written/)
  await rig.reopen()
  assert.equal(rig.store.read('target').operation?.kind, 'carry')
  assert.equal(rig.goals.canDispatch('target').ok, false)
  await rig.goals.recover()
  assert.equal(rig.store.read('target').operation, null)
  assert.deepEqual(rig.store.read('target').goal.dependsOn, ['source'])
  const carries = (await rig.records()).filter((record) => record.finding?.event.kind === 'carry')
  assert.equal(carries.length, 2)
  assert.deepEqual(foldFindings(await rig.records()).filter((one) => one.ownerGoal === 'target').map((one) => one.id), [F1, F2])
})

test('cross-project unwrapped cyclic and stale carry refuse', async () => {
  const unchanged = async (rig: CarryRig): Promise<void> => {
    assert.equal(rig.store.read('target').operation, null)
    assert.deepEqual(rig.store.read('target').goal.dependsOn.filter((one) => one === 'source'), [])
    assert.equal((await rig.records()).filter((record) => record.finding?.event.kind === 'carry').length, 0)
  }
  const crossProject = await carryRig({ target: { root: '/work/other', cwd: '/work/other' } })
  await assert.rejects(crossProject.findings.carry(carryInput()), /within one project/)
  await unchanged(crossProject)

  const unwrapped = await carryRig({ source: { state: 'open' } })
  await assert.rejects(unwrapped.findings.carry(carryInput()), /wrapped receipt/)
  await unchanged(unwrapped)

  const cyclic = await carryRig({ source: { dependsOn: ['target'] } })
  await assert.rejects(cyclic.findings.carry(carryInput()), /wait on each other/)
  await unchanged(cyclic)

  const stale = await carryRig()
  await assert.rejects(stale.findings.carry(carryInput({ revision: 7 })), /changed/)
  await unchanged(stale)

  // A resolved finding, one the receipt never named, and an empty or repeated list.
  const resolved = await carryRig()
  await assert.rejects(resolved.findings.carry(carryInput({ findings: [F3] })), /resolved/)
  await assert.rejects(resolved.findings.carry(carryInput({ findings: ['finding-00000000-0000-4000-8000-00000000000f'] })), /receipt did not/)
  await assert.rejects(resolved.findings.carry(carryInput({ findings: [] })), /1 to 200/)
  await assert.rejects(resolved.findings.carry(carryInput({ findings: [F1, F1] })), /1 to 200/)
  await unchanged(resolved)

  // Once carried, a second carry of the same finding elsewhere is refused: one active owner.
  const twice = await carryRig()
  await twice.findings.carry(carryInput())
  await twice.store.save({
    version: 1, goal: goal('third', { sentence: 'Another follow-up' }),
    board: { nextIntent: 1, messaging: true, intents: [], channel: [] }, citations: [], receipt: null, operation: null,
  }, null)
  await assert.rejects(twice.findings.carry(carryInput({ goal: 'third', request: 'carry-2' })), /already carried/)
})
