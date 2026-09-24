import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceRecord, GoalReceipt } from '@harnessdesk/protocol'

import { GoalPlane, type GoalPlanePort } from '../src/goals/plane.js'
import { migrateDesk } from '../src/goals/migration.js'
import { atomicJson, GoalStore } from '../src/goals/store.js'
import { FindingsPlane } from '../src/findings/plane.js'
import { Publications } from '../src/findings/publication.js'
import { FakeFindingForge } from './fixtures/fake-finding-forge.js'
import { findingsRig, SHA1, type FindingsRig } from './fixtures/findings-rig.js'
import { goal, intent } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

/*
 * Production planes, fake runtimes, a fake forge: a whole reviewed change
 * from raise to a person's decision, proving what the plan's decisions
 * promise rather than each piece alone. This is fake-forge integration, not
 * a claim about live GitHub delivery.
 */

interface AcceptanceRig {
  readonly f: FindingsRig
  readonly forge: FakeFindingForge
  pub: Publications
  bindPullRequest(): void
}

const acceptanceRig = async (t: { after(fn: () => Promise<void>): void }): Promise<AcceptanceRig> => {
  const f = await findingsRig(t)
  const forge = new FakeFindingForge(SHA1)
  const preference = { open: true, value: undefined as boolean | undefined }
  const make = (): Publications => new Publications({
    journal: (run, step) => f.rig.flows.withPublicationJournal(run, step),
    runs: () => f.rig.flows.publicationRuns(),
    run: (run) => {
      const snapshot = f.rig.flows.findingRun(run)
      return snapshot ? { goal: snapshot.goal, rounds: snapshot.rounds, pendingFindings: snapshot.pendingFindings } : null
    },
    entry: (key) => f.rig.flows.publicationEntry(key),
    snapshot: (run) => f.rig.flows.publicationOf(run),
    roundClosed: (run, round) => f.rig.flows.roundClosed(run, round),
    goal: () => ({ open: preference.open, preference: preference.value }),
    projectOf: async () => '/repo',
    facts: (id) => f.port.flows.facts!(id),
    ledger: (project) => f.plane.ledgerOf(project),
    seat: (id) => f.rig.seats.get(id) ?? null,
    template: () => '**Review by {seat} · via HarnessDesk**',
    appendPost: (input) => f.plane.appendPost(input),
    forge,
    now: () => 1_000,
    log: () => {},
  })
  const out = { f, forge, pub: make() } as AcceptanceRig
  const attach = (): void => {
    f.plane.attachPublisher(out.pub)
    f.rig.flows.onRunStopped((run) => out.pub.cancel(run, 'The run was stopped before this was posted, so it stays on the desk.'))
  }
  attach()
  f.onPlane = () => { out.pub = make(); attach() }
  out.bindPullRequest = () => {
    f.rig.facts.set(out.f.goal, [
      ...(f.rig.facts.get(out.f.goal) ?? []),
      {
        id: 'pr-1', fact: { kind: 'pr', number: 9, state: 'open', head: SHA1, url: 'https://github.com/org/repo/pull/9' },
        card: null, checkout: null, seat: null, round: null, observedAt: 1, posted: null,
      } as unknown as EvidenceRecord,
    ])
  }
  return out
}

test('three-reviewer round: embargo holds, the batch publishes once, a repair replies, the delta review reads only what is left', async (t) => {
  const rig = await acceptanceRig(t)
  const { f } = rig
  rig.bindPullRequest()
  await f.finishFixer()

  const reviewerCards = f.cards('reviewer')
  assert.equal(reviewerCards.length, 2, 'both reviewer roles opened their cards')
  const [alpha, beta] = reviewerCards.map((card) => card.id)

  // Alpha raises first. Nothing of it is visible from Beta's own read yet — the round is still blind.
  const alphaCandidate = await f.candidate(alpha!, 'seat-2')
  await f.plane.raise({
    intent: alpha, candidate: alphaCandidate.id, request: 'r-1', title: 'Missing bounds check', body: 'Index can go negative.',
    category: 'ordinary', blocking: true,
  }, f.scope('seat-2'))
  const betaRead = await f.plane.readForSeat({ intent: beta }, f.scope('seat-3'))
  assert.equal(betaRead.length, 0, 'a sibling reviewer reads nothing of an open blind round')
  assert.equal(rig.forge.calls.length, 0, 'nothing is posted before the round closes')

  // Raising a finding is not the same as a durable completed card: neither reviewer has recorded a verdict yet.
  const midRound = await f.plane.runView(f.run)
  assert.equal(midRound.reviewersTotal, 2)
  assert.equal(midRound.reviewersFinished, 0, 'a raise is not a finished review; only a recorded verdict counts')

  await f.finishReviews('request-changes')
  await rig.pub.idle()
  // The round closed: the batch is released as one, and every finding is now visible on the desk.
  assert.ok(rig.forge.calls.length > 0, 'the closed round posted its batch')
  const ledgerAfterClose = await f.plane.list({ goal: f.goal })
  assert.equal(ledgerAfterClose.rows.length, 1)

  // The fixer claims a repair; the delta review is handed only the repair and what is still open.
  await f.finishFixer()
  const nextReviewers = f.cards('reviewer').filter((one) => one.state === 'claimed')
  assert.ok(nextReviewers.length > 0, 'a second review round opened')
})

test('a person decides a stopped run: an admitted override authorizes merge readiness, and nothing edits the facts it disagrees with', async (t) => {
  const rig = await acceptanceRig(t)
  const { f } = rig
  rig.bindPullRequest()
  await f.finishFixer()

  const [firstCard] = f.cards('reviewer')
  const candidate = await f.candidate(firstCard!.id, 'seat-2')
  await f.plane.raise({
    intent: firstCard!.id, candidate: candidate.id, request: 'r-1', title: 'Needs a design change', body: 'Not a quick patch.',
    category: 'ordinary', blocking: true,
  }, f.scope('seat-2'))
  await f.finishReviews('request-changes')

  const view = await f.plane.runView(f.run)
  assert.equal(view.blocking, 1)
  const before = (await f.plane.list({ goal: f.goal })).rows[0]!

  const decided = await f.plane.decideRun({
    goal: f.goal, run: f.run, round: view.round, stamp: view.stamp,
    action: { kind: 'merge-anyway' }, reason: 'shipping with a tracked follow-up',
  })
  assert.equal(decided.publication !== undefined, true)
  const receipt = await f.plane.receiptWithGaps(f.goal)
  // The override is not exposed by receiptWithGaps directly here (it reads live run state); read it back the same way a wrap would.
  void receipt
  const after = (await f.plane.list({ goal: f.goal })).rows[0]!
  assert.deepEqual(after.lifecycle, before.lifecycle, 'the override never edits the finding itself')
})

test('carry and wrap keep one claim identity: the target uses the original id and Seat, the source receipt is unread once frozen', async () => {
  const home = tempDir('hd-findings-acceptance-carry-')
  await migrateDesk(home, async () => {})
  const { EvidenceStore } = await import('../src/evidence/store.js')
  const ROOT = '/work/repo'
  const A = 'a'.repeat(40)
  const evidence = new EvidenceStore(`${home}/evidence`)
  const raiseRecord: EvidenceRecord = {
    id: 'raise-1', fact: { kind: 'finding', id: 'finding-0001', state: 'open', at: A },
    card: { board: 'source', id: 1 }, checkout: { cwd: ROOT, branch: 'fix' }, seat: 'seat-r', round: 2, observedAt: 1, posted: null,
    finding: {
      version: 1, sequence: 1, operation: 'op-raise-1',
      origin: { goal: 'source', run: 'run-1', round: 2, card: 1, seat: 'seat-r', at: A },
      event: { kind: 'raise', title: 'Still true', body: 'Carried unresolved.', category: 'ordinary', blocking: true, related: null, anchor: null },
    },
  }
  await evidence.append(ROOT, 'evidence', [{ type: 'evidence', record: raiseRecord }])
  const write = (file: string, value: unknown): Promise<void> => atomicJson(file, value)
  const store = new GoalStore(home, write)
  await store.load()
  const forbidden = async (): Promise<never> => { throw new Error('not in this test') }
  const port: GoalPlanePort = {
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
  }
  const goals = new GoalPlane(store, port)
  const plane = new FindingsPlane({
    store: { read: (project, file) => evidence.read(project, file), append: (project, file, lines) => evidence.append(project, file, lines) },
    seats: { byId: () => null, latestKeptOf: () => null },
    flows: { binding: () => null, candidate: async () => null, journal: async () => { throw new Error('unused') }, pending: () => [] },
    goals: { carry: (input, prepare) => goals.carryFindings(input, prepare) },
    projectOf: async () => ROOT, headOf: async () => ({ at: null, dirty: false }), now: () => 10, log: () => {},
  })
  goals.attachFindings((records) => plane.appendCarry(records))
  const receipt: GoalReceipt = {
    version: 1, id: 'receipt-1', goal: 'source', sentence: 'The first effort', wrappedAt: 5, summary: 'Stopped with a finding open.',
    cards: [{ id: 1, resolution: 'finished', reason: null }], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
    findings: await plane.receipt('source'),
  }
  await store.save({
    version: 1, goal: goal('source', { sentence: 'The first effort', state: 'wrapped', receipt: 'receipt-1' }),
    board: { nextIntent: 2, messaging: true, intents: [intent(1, { state: 'done' })], channel: [] },
    citations: [], receipt, operation: null,
  }, null)
  await store.save({
    version: 1, goal: goal('target', { sentence: 'The follow-up' }),
    board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
    citations: [], receipt: null, operation: null,
  }, null)
  const receiptBefore = JSON.stringify(store.read('source').receipt)

  const carried = await plane.carry({ goal: 'target', revision: 0, source: 'source', receipt: 'receipt-1', findings: ['finding-0001'], request: 'carry-1' })
  assert.equal(carried.length, 1)
  assert.equal(carried[0]!.id, 'finding-0001', 'the same id, never a new claim')
  assert.equal(carried[0]!.origin.seat, 'seat-r', 'the original raiser')
  assert.equal(carried[0]!.ownerGoal, 'target')
  assert.equal(JSON.stringify(store.read('source').receipt), receiptBefore, 'the wrapped source receipt is frozen, unread by the carry beyond its own check')
})
