import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'

import { moves, reconcile, seed, surviving, type Patch } from '../src/provenance/model.js'
import { sourceFromFacts } from '../src/provenance/reconcile.js'

const patch: Patch = { stable: 'stable', exact: 'verbatim', files: ['one'] }
const input = {
  cwd: '/work/project', project: '/work/project', from: 'a', to: 'b',
  firstSeen: 15, patch,
}
const seat = {
  id: 'seat-a', cwd: input.cwd, project: input.project,
  openedAt: 10, closedAt: 20, restored: false,
}
const fact = {
  id: 'fact-a', seat: seat.id, cwd: input.cwd, project: input.project,
  from: input.from, to: input.to, observedAt: 16, restored: false,
}

export const recordedSeat = (id = 'seat-a'): SeatRecord => ({
  id,
  agent: null,
  briefDigest: null,
  seat: { runtime: 'fixture' },
  seatLabel: 'Fixture seat',
  passedOver: [],
  standing: { kind: 'permission', permission: 'read' },
  ceiling: null,
  checkout: { cwd: input.cwd, project: input.project, branch: 'topic', head: 'a' },
  session: { runtime: 'fixture', sessionId: `session-${id}` },
  board: null,
  role: null,
  openedAt: 10,
  closed: { at: 20, why: 'deleted' },
})

const record = (overrides: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: 'fact-a',
  fact: { kind: 'diff', files: 1, added: 1, removed: 0, from: 'a', to: 'b' },
  seat: 'seat-a',
  checkout: { cwd: input.cwd, branch: 'topic' },
  observedAt: 16,
  ...overrides,
})

const fromRecords = (records: readonly EvidenceRecord[], seats = [recordedSeat()]) =>
  sourceFromFacts(input.project, input.cwd, 'a', 'b', patch, seats, records)

test('an open Seat alone cannot bind a patch', () => {
  assert.equal(seed(input, [{ ...seat, closedAt: null }], []), null)
  assert.equal(fromRecords([]), null)
})

test('both the fact and Seat must belong to the same admitted checkout and project', () => {
  assert.deepEqual(seed(input, [seat], [fact])?.seats, ['seat-a'])
  assert.equal(seed(input, [{ ...seat, cwd: '/work/other' }], [
    { ...fact, cwd: '/work/other' },
  ]), null, 'a different checkout must not seed this patch')
  assert.equal(seed(input, [{ ...seat, project: '/work/other' }], [
    { ...fact, project: '/work/other' },
  ]), null)
  assert.equal(seed(input, [], [fact]), null)
  assert.equal(seed(input, [seat], [{ ...fact, from: 'other' }]), null)
  assert.equal(seed(input, [seat], [{ ...fact, to: 'other' }]), null)
})

test('the binding observation is inside the Seat lifetime, including both endpoints', () => {
  for (const at of [10, 20]) {
    assert.ok(seed({ ...input, firstSeen: at }, [seat], [{ ...fact, observedAt: at }]))
  }
  for (const at of [9, 21]) {
    assert.equal(seed({ ...input, firstSeen: at }, [seat], [fact]), null)
    assert.equal(seed(input, [seat], [{ ...fact, observedAt: at }]), null)
  }
  assert.equal(seed(input, [{ ...seat, restored: true }], [fact]), null)
  assert.equal(seed(input, [seat], [{ ...fact, restored: true }]), null)
})

test('duplicate facts agree, while two valid Seats preserve ambiguity', () => {
  const one = fromRecords([record(), record({ id: 'fact-copy' })])
  assert.deepEqual(one?.seats, ['seat-a'])
  assert.equal(one?.ambiguous, false)
  const two = fromRecords([
    record(), record({ id: 'fact-b', seat: 'seat-b' }),
  ], [recordedSeat(), recordedSeat('seat-b')])
  assert.deepEqual(two?.seats, ['seat-a', 'seat-b'])
  assert.equal(two?.ambiguous, true)
  assert.deepEqual(reconcile(patch, two ? [two] : []), {
    state: 'unattributed', reason: 'ambiguous-patch',
  })
})

test('only local diff facts can bind a patch; other evidence remains byte-for-byte unchanged', () => {
  const others: EvidenceRecord['fact'][] = [
    { kind: 'check', name: 'unit', run: 'node --test', exit: 0, timedOut: false, at: 'a', dirty: false, tail: '' },
    { kind: 'ci', checks: [], at: 'a' },
    { kind: 'review', verdict: 'approve', by: 'seat-a', at: 'a' },
    { kind: 'pr', number: 1, head: 'a', state: 'open', url: null },
    { kind: 'finding', id: 'finding', state: 'open', at: 'a' },
    { kind: 'spend', usd: 1, turns: 1, exact: true },
  ]
  const records = others.map((other, n) => record({ id: `other-${n}`, fact: other }))
  const before = JSON.stringify(records)
  for (const other of records) assert.equal(fromRecords([other]), null)
  assert.equal(fromRecords([record({ restored: { at: 30 } })]), null)
  assert.equal(fromRecords([record({ checkout: null })]), null)
  assert.equal(fromRecords([record({ seat: null })]), null)
  assert.equal(JSON.stringify(records), before)
})

test('catch-up uses retained host observation time, not discovery time or author time', () => {
  assert.ok(fromRecords([record()]))
  assert.equal(fromRecords([record({ observedAt: 21 })]), null)
  assert.equal(fromRecords([record()], [{ ...recordedSeat(), restored: { at: 30 } }]), null)
})

test('stable patch equality alone never authorizes a whitespace-changing rewrite', () => {
  const source = { id: 'source-a', seats: ['seat-a'], patch }
  assert.deepEqual(reconcile({ ...patch, exact: 'different whitespace' }, [source]), {
    state: 'unattributed', reason: 'no-matching-patch',
  })
  assert.deepEqual(reconcile(patch, [source, { ...source, id: 'source-copy' }]), {
    state: 'attributed', seats: ['seat-a'], sources: ['source-a', 'source-copy'],
  })
  assert.deepEqual(reconcile(patch, [source, { ...source, id: 'unknown', seats: [] }]), {
    state: 'unattributed', reason: 'ambiguous-patch',
  })
  assert.deepEqual(reconcile({ ...patch, files: [] }, [source]), {
    state: 'unattributed', reason: 'empty-change',
  })
})

test('partial matching keeps exact file patches and names every unresolved target path', () => {
  const before = [{ path: 'one', stable: 's', exact: 'e' }]
  assert.deepEqual(surviving(before, [
    ...before, { path: 'two', stable: 't', exact: 't' },
  ]), { retained: ['one'], unresolved: ['two'] })
  assert.deepEqual(surviving(before, [{ ...before[0]!, exact: 'changed' }]), {
    retained: [], unresolved: ['one'],
  })
  assert.deepEqual(surviving(before, []), { retained: [], unresolved: [] })
})

test('snapshot movements include creation, deletion and rewind in a stable order', () => {
  assert.deepEqual(moves(new Map([['refs/heads/a', 'old'], ['refs/heads/b', 'gone']]),
    new Map([['refs/heads/a', 'older'], ['refs/tags/v1', 'tag']])), [
    { ref: 'refs/heads/a', before: 'old', after: 'older' },
    { ref: 'refs/heads/b', before: 'gone', after: null },
    { ref: 'refs/tags/v1', before: null, after: 'tag' },
  ])
})
