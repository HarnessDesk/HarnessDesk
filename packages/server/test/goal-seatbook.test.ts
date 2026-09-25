import assert from 'node:assert/strict'
import { test } from 'node:test'

import { foldSeats, lineOf, type SeatOpening } from '../src/evidence/records.js'
import { SeatBook } from '../src/evidence/seats.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const opening = (id: string): SeatOpening => {
  const { closed: _closed, ...record } = seat(id, { standing: { kind: 'unknown' } })
  return record
}

test('unknown is recorded as unknown and arbitrary standing-order tags are refused', () => {
  const record = opening('legacy-one')
  const where = { file: 'seats', project: '/work/repo' } as const
  assert.deepEqual(lineOf({ v: 1, type: 'seat', record }, where), { type: 'seat', record })
  assert.equal(lineOf({ v: 1, type: 'seat', record: { ...record, standing: { kind: 'invented' } } }, where), null)
})

test('an identical import is idempotent and a different opening under the same id refuses', async () => {
  const store = new EvidenceStore(tempDir('hd-goal-evidence-'))
  const book = new SeatBook(store, () => 10)
  await book.importOpening('/work/repo', opening('one'))
  await book.importOpening('/work/repo', { ...opening('one'), standing: { kind: 'unknown' } })
  assert.equal(book.all().length, 1)
  assert.equal((await store.read('/work/repo', 'seats')).lines.length, 1)
  await assert.rejects(book.importOpening('/work/repo', { ...opening('one'), role: 'another-role' }), /different Seat/)
})

test('close by id keeps another Seat on the same conversation and preserves the first closing', async () => {
  const store = new EvidenceStore(tempDir('hd-goal-evidence-'))
  const book = new SeatBook(store, () => 10)
  const first = opening('one')
  const second = { ...opening('two'), session: first.session, board: null }
  await book.importOpening('/work/repo', first)
  await book.importOpening('/work/repo', second)
  const closed = await book.closeId('one', 'released')
  assert.deepEqual(closed.closed, { at: 10, why: 'released' })
  assert.equal(book.byId('two')?.closed, null)
  await book.closeId('one', 'deleted')
  const { lines } = await store.read('/work/repo', 'seats')
  assert.equal(lines.filter((line) => line.type === 'seat-closed').length, 1)
  assert.deepEqual(foldSeats(lines).find((one) => one.id === 'one')?.closed, { at: 10, why: 'released' })
})

test('a restored Seat cannot be closed by a Goal release', async () => {
  const store = new EvidenceStore(tempDir('hd-goal-evidence-'))
  const book = new SeatBook(store, () => 10)
  await book.importOpening('/work/repo', { ...opening('restored'), restored: { at: 2 } })
  await assert.rejects(book.closeId('restored', 'released'), /history and cannot be closed/)
  assert.equal((await store.read('/work/repo', 'seats')).lines.length, 1)
})
