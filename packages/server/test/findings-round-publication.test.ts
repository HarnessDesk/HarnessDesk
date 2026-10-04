import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceRecord, EvidenceView } from '@harnessdesk/protocol'
import { Publications, type PublicationEntry, type PublicationRound, type StoredPublication } from '../src/findings/publication.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'
import { FakeFindingForge } from './fixtures/fake-finding-forge.js'

const decision = (round: number, over: Partial<PublicationRound> = {}): PublicationRound => ({
  round, mode: 'batch', reason: null, repo: 'acme/widgets', pr: 7, keys: [], decidedAt: 1, ...over,
})
const entry = (round: number, state: PublicationEntry['state'], reason: string | null = null): PublicationEntry => ({
  key: `op-${round}-${state}`, run: 'run-1', round, project: '/repo', repo: 'acme/widgets', pr: 7,
  at: 'a'.repeat(40), finding: 'finding-1', evidence: [], actor: 'seat-1', parent: null, marker: 'marker', digest: 'digest',
  state, reason, location: state === 'posted' ? {
    repo: 'acme/widgets', pr: 7, comment: 1, kind: 'issue-comment', url: 'https://github.com/acme/widgets/pull/7#issuecomment-1', operation: `op-${round}-${state}`,
  } : null, placement: null, expected: null, wrote: null,
})
const review = (card: number, over: Partial<EvidenceRecord> = {}): EvidenceView => ({
  record: { id: `review-${card}`, fact: { kind: 'review', verdict: 'approve', by: 'Jane Doe', at: 'a'.repeat(40) },
    card: { board: 'goal-1', id: card }, observedAt: 1, ...over },
  freshness: { state: 'fresh' }, by: null,
})
const rig = (decisions: readonly PublicationRound[], entries: readonly PublicationEntry[], facts: readonly EvidenceView[] = [], records: readonly EvidenceRecord[] = []) => {
  const stored: StoredPublication = {
    rounds: Object.fromEntries(decisions.map((one) => [String(one.round), one])),
    ops: Object.fromEntries(entries.map((one) => [one.key, one])),
  }
  return new Publications({
    journal: async () => { throw new Error('a round read must not take the journal queue') },
    runs: () => decisions.length ? [{ run: 'run-1', goal: 'goal-1' }] : [],
    run: (run) => run === 'run-1' ? { goal: 'goal-1', rounds: [
      { n: 1, cards: [11, 12] }, { n: 2, cards: [21] }, { n: 3, cards: [31] },
    ], pendingFindings: 0 } : null,
    entry: () => null, snapshot: () => stored, roundClosed: () => true,
    goal: () => ({ open: true, preference: true }), projectOf: async () => '/repo', facts: async () => facts,
    ledger: async () => ({ records, views: [], unreadable: 0 }), seat: () => null, template: () => '',
    appendPost: async () => {}, forge: new FakeFindingForge('a'.repeat(40)), now: () => 1, log: () => {},
  })
}

test('rounds distinguish posted and local decisions while status keeps the run aggregate', async () => {
  const pub = rig([decision(1), decision(2, { mode: 'local', pr: null, repo: null, reason: 'Posting is off.' })], [entry(1, 'posted')], [review(21)])
  assert.deepEqual(await pub.rounds('run-1'), [
    { round: 1, state: 'posted', reason: null, pr: 7, cards: [11, 12] },
    { round: 2, state: 'local', reason: 'Posting is off.', pr: null, cards: [21] },
  ])
  assert.deepEqual(await pub.status('run-1'), { publication: 'posted', reason: null })
})

test('an uncertain second round leaves the posted first round alone', async () => {
  const pub = rig([decision(1), decision(2)], [entry(1, 'posted'), entry(2, 'uncertain', 'Read-back is ambiguous.')])
  assert.deepEqual(await pub.rounds('run-1'), [
    { round: 1, state: 'posted', reason: null, pr: 7, cards: [11, 12] },
    { round: 2, state: 'uncertain', reason: 'Read-back is ambiguous.', pr: 7, cards: [21] },
  ])
  assert.equal((await pub.status('run-1')).publication, 'uncertain')
})

test('review records without a decision read none, confined to the run cards and Goal', async () => {
  const pub = rig([], [], [review(11), review(21, { restored: { at: 2 } }), review(31, { card: { board: 'another-goal', id: 31 } }), review(99)])
  assert.deepEqual(await pub.rounds('run-1'), [
    { round: 1, state: 'none', reason: null, pr: null, cards: [11, 12] },
    { round: 2, state: 'none', reason: null, pr: null, cards: [21] },
  ], 'restored review history is visible without granting publication authority')
  assert.deepEqual(await pub.rounds('missing'), [])
})

test('each round uses the aggregate fold rules and prefers an unposted operation reason', async () => {
  for (const [entries, state, reason] of [
    [[], 'local', 'Decision reason.'],
    [[entry(1, 'prepared')], 'pending', 'Decision reason.'],
    [[entry(1, 'started', 'Send in progress.')], 'pending', 'Send in progress.'],
    [[entry(1, 'prepared', 'Held.')], 'partial', 'Held.'],
    [[entry(1, 'skipped', 'Skipped.')], 'partial', 'Skipped.'],
    [[entry(1, 'posted', 'Old posted reason.')], 'posted', 'Decision reason.'],
    [[entry(1, 'started'), entry(1, 'uncertain', 'Uncertain.')], 'uncertain', 'Uncertain.'],
  ] as const) {
    const pub = rig([decision(1, { reason: 'Decision reason.' })], entries, [review(11)])
    assert.deepEqual(await pub.rounds('run-1'), [{ round: 1, state, reason, pr: 7, cards: [11, 12] }])
    assert.equal((await pub.status('run-1')).publication, state)
  }
})

test('empty release decisions do not invent a review publication', async () => {
  for (const mode of ['batch', 'local', 'refused'] as const) {
    const pub = rig([decision(1, { mode })], [])
    assert.equal((await pub.rounds('run-1'))[0]?.state, 'none')
    assert.equal((await pub.status('run-1')).publication, 'local', 'the aggregate remains the host fold')
  }
})

test('a finding-only round kept before binding still has a local publication', async () => {
  const record: EvidenceRecord = { ...review(11).record,
    fact: { kind: 'finding', id: 'finding-1', state: 'repaired', at: 'a'.repeat(40) },
    finding: { version: 1, sequence: 2, operation: 'repair-1',
      origin: { goal: 'goal-1', run: 'run-1', round: 1, card: 11, seat: 'seat-1', at: 'a'.repeat(40) },
      event: { kind: 'repair', note: 'Bound the retries.' } } }
  const pub = rig([decision(1, { mode: 'local', pr: null })], [], [], [record])
  assert.equal((await pub.rounds('run-1'))[0]?.state, 'local')
  const otherGoal = rig([decision(1)], [], [], [{ ...record, card: { board: 'another-goal', id: 11 } }])
  assert.equal((await otherGoal.rounds('run-1'))[0]?.state, 'none')
})


test('durable publication changes notify their Goal; reads, repeat decisions and failed writes stay silent', async (t) => {
  const goals: string[] = []
  const f = await goalRig(t, { publicationChanged: (goal) => goals.push(goal) })
  const run = await f.start(`
version: 2
name: Publication notification
roles:
  author: { kind: agent, uses: writer }
seed: { role: author, title: Write it }
rules: []
`, [agent('writer', ['done'])])
  const local = decision(1, { mode: 'local', pr: null, repo: null })
  await f.executions.withPublicationJournal(run.id, async (journal) => { await journal.decide(local, []) })
  assert.deepEqual(goals, [run.goal])
  assert.deepEqual(f.executions.publicationOf(run.id)?.rounds['1'], local)
  await f.executions.withPublicationJournal(run.id, async (journal) => {
    journal.round(1); journal.entries(); journal.entry('missing')
    await journal.decide(local, [])
  })
  f.executions.publicationOf(run.id)
  assert.equal(goals.length, 1, 'reads and an idempotent decision do not wake clients')
  const prepared = { ...entry(1, 'prepared'), run: run.id }
  const batch = decision(1, { keys: [prepared.key], backfilled: { at: 2, from: null } })
  await f.executions.withPublicationJournal(run.id, async (journal) => { await journal.backfill(batch, [prepared]) })
  assert.equal(goals.length, 2)
  for (const state of ['started', 'uncertain'] as const) {
    await f.executions.withPublicationJournal(run.id, async (journal) => { await journal.put({ ...prepared, state }) })
  }
  assert.deepEqual(goals, [run.goal, run.goal, run.goal, run.goal])
  f.files.failOnce = (stored) => stored.publication?.ops[prepared.key]?.state === 'posted'
  await assert.rejects(f.executions.withPublicationJournal(run.id, async (journal) => {
    await journal.put({ ...prepared, state: 'posted' })
  }), /journal write failed/)
  assert.equal(f.executions.publicationOf(run.id)?.ops[prepared.key]?.state, 'uncertain')
  await f.executions.withPublicationJournal(run.id, async (journal) => { await journal.backfill(batch, [prepared]) })
  assert.equal(goals.length, 4, 'neither an unsuccessful write nor a repeat backfill announces success')
})
