import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { migrateDesk } from '../src/goals/migration.js'
import { atomicJson, documentOf, GoalStore, type GoalDocument } from '../src/goals/store.js'
import { goal } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const document = (id = 'g1'): GoalDocument => ({
  version: 1, goal: goal(id),
  board: { nextIntent: 1, messaging: true, intents: [], channel: [] },
  citations: [], receipt: null, operation: null,
})

const empty = async (): Promise<string> => {
  const home = tempDir('hd-goal-store-')
  await migrateDesk(home, async () => {})
  return home
}

test('create and update are durable, advance once, and do not expose mutable cache objects', async () => {
  const home = await empty()
  const store = new GoalStore(home)
  await store.load()
  await store.save(document('/work/old-room'), null)
  const before = store.read('/work/old-room')
  await store.save({ ...before, goal: { ...before.goal, revision: 1, sentence: 'A new sentence' } }, 0)
  const copy = store.read('/work/old-room')
  ;(copy.goal as { sentence: string }).sentence = 'mutated'
  assert.equal(store.read('/work/old-room').goal.sentence, 'A new sentence')
  const reopened = new GoalStore(home)
  await reopened.load()
  assert.equal(reopened.read('/work/old-room').goal.revision, 1)
  assert.equal(reopened.read('/work/old-room').goal.sentence, 'A new sentence')
  assert.equal((await readdir(join(home, 'goals'))).includes('%2Fwork%2Fold-room.json'), true)
})

test('two revision-zero updates serialize and only one wins', async () => {
  const home = await empty()
  const store = new GoalStore(home)
  await store.load()
  const original = document()
  await store.save(original, null)
  const results = await Promise.allSettled(['one', 'two'].map((sentence) => store.save({
    ...original, goal: { ...original.goal, revision: 1, sentence },
  }, 0)))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(store.read('g1').goal.revision, 1)
})

test('a failed write exposes no unpersisted snapshot and flush repeats the failure', async () => {
  const home = await empty()
  const store = new GoalStore(home, async () => { throw new Error('disk refused') })
  await store.load()
  await assert.rejects(store.save(document(), null), /disk refused/)
  assert.deepEqual(store.list(), [])
  assert.equal(store.problem, 'disk refused')
  await assert.rejects(store.flush(), /disk refused/)
  assert.deepEqual(await readdir(join(home, 'goals')), ['index.json'])
})

test('a create interrupted after its document rename repairs the index on restart', async () => {
  const home = await empty()
  const store = new GoalStore(home, async (file, value) => {
    if (file.endsWith('/index.json')) throw new Error('index sync failed')
    await atomicJson(file, value)
  })
  await store.load()
  await assert.rejects(store.save(document(), null), /index sync failed/)
  assert.deepEqual(store.list(), [])
  const reopened = new GoalStore(home)
  await reopened.load()
  assert.equal(reopened.read('g1').goal.id, 'g1')
  assert.deepEqual(JSON.parse(await readFile(join(home, 'goals', 'index.json'), 'utf8')).ids, ['g1'])
})

test('an indexed missing document and a future document version refuse startup without rewriting', async () => {
  const home = await empty()
  const index = JSON.stringify({ version: 1, ids: ['missing'], noticeSeen: true })
  await writeFile(join(home, 'goals', 'index.json'), index)
  await assert.rejects(new GoalStore(home).load(), /indexed Goal missing is missing/)
  assert.equal(await readFile(join(home, 'goals', 'index.json'), 'utf8'), index)
  await writeFile(join(home, 'goals', 'missing.json'), JSON.stringify({ ...document('missing'), version: 2 }))
  await assert.rejects(new GoalStore(home).load(), /Goal document cannot be read/)
})

test('the 8 MiB limit refuses before making a temporary file', async () => {
  const home = await empty()
  await assert.rejects(atomicJson(join(home, 'goals', 'huge.json'), { text: 'x'.repeat(8 * 1024 * 1024) }), /larger than 8 MiB/)
  assert.deepEqual(await readdir(join(home, 'goals')), ['index.json'])
})

test('wrap journals and receipts are validated as complete durable facts', () => {
  const receipt = {
    version: 1 as const, id: 'receipt-1', goal: 'g1', sentence: 'Finish the Goal', wrappedAt: 3,
    summary: 'Finished.', cards: [], seats: [], evidence: [], answers: [], lanes: [], revisions: [],
    citations: [], gaps: [],
  }
  const open = document()
  const wrapping = {
    ...open,
    goal: { ...open.goal, state: 'wrapping' as const, revision: 1 },
    operation: { kind: 'wrap' as const, id: 'operation-1', goal: 'g1', stamp: 'a'.repeat(64), receipt },
  }
  assert.equal(documentOf(wrapping).operation?.kind, 'wrap')
  assert.throws(() => documentOf({ ...wrapping, operation: { ...wrapping.operation, stamp: 'short' } }), /cannot be read/)
  assert.throws(() => documentOf({ ...wrapping, operation: { ...wrapping.operation,
    receipt: { ...receipt, answers: [{ seat: 's1', session: {}, turn: null, text: '', partial: false, stopReason: null }] },
  } }), /cannot be read/)
  assert.throws(() => documentOf({ ...wrapping, goal: { ...wrapping.goal, receipt: 'receipt-1' }, receipt }), /cannot be read/)
  const wrapped = { ...open, goal: { ...open.goal, state: 'wrapped' as const, receipt: 'receipt-1', revision: 1 }, receipt }
  assert.equal(documentOf(wrapped).receipt?.id, 'receipt-1')
})

/*
 * `members` and `evidenceSeats` are optional additions to `GoalReceipt`, on
 * an already-durable shape: a receipt this store already holds, wrapped
 * before either field existed, has neither and must go on being read back
 * exactly as it was. Present, each is validated the same as every other
 * array here — malformed is refused, not silently repaired or dropped.
 */
test('a receipt from before members and evidenceSeats existed is still read; malformed ones are refused', () => {
  const base = {
    version: 1 as const, id: 'receipt-1', goal: 'g1', sentence: 'Finish the Goal', wrappedAt: 3,
    summary: 'Finished.', cards: [], seats: ['seat-1'], evidence: ['fact-1'], answers: [], lanes: [], revisions: [],
    citations: [], gaps: [],
  }
  const open = document()
  const wrappedWith = (receipt: unknown) => documentOf({
    ...open,
    goal: { ...open.goal, state: 'wrapped' as const, receipt: 'receipt-1', revision: 1 },
    receipt,
  })

  // No `members`/`evidenceSeats` at all: the pre-#875 shape, read exactly as before.
  assert.equal(wrappedWith(base).receipt?.id, 'receipt-1')

  // Present and well-formed: an Agent's name, a flow-seated runtime with
  // none, and evidence attributed to a Seat, to nobody, or to a restored
  // Seat by its own captured label (#875 review — a restored Seat has no
  // entry in `members`, so its evidence carries `seatLabel` directly).
  const named = {
    ...base,
    members: [
      { seat: 'seat-1', agent: 'Code reviewer', seatLabel: 'Claude · Opus' },
      { seat: 'seat-2', agent: null, seatLabel: 'Codex · gpt-5.6' },
    ],
    evidenceSeats: [
      { id: 'fact-1', seat: 'seat-1' },
      { id: 'fact-2', seat: null },
      { id: 'fact-3', seat: 'restored-seat', seatLabel: 'Claude · Opus' },
    ],
  }
  assert.equal(wrappedWith(named).receipt?.id, 'receipt-1')

  // Malformed `members`: missing seatLabel, and a non-string agent.
  assert.throws(() => wrappedWith({ ...base, members: [{ seat: 'seat-1', agent: null }] }), /cannot be read/)
  assert.throws(() => wrappedWith({ ...base, members: [{ seat: 'seat-1', agent: 7, seatLabel: 'Claude' }] }), /cannot be read/)
  assert.throws(() => wrappedWith({ ...base, members: 'seat-1' }), /cannot be read/)

  // Malformed `evidenceSeats`: missing id, a non-string non-null seat, and a
  // non-string non-null seatLabel.
  assert.throws(() => wrappedWith({ ...base, evidenceSeats: [{ seat: 'seat-1' }] }), /cannot be read/)
  assert.throws(() => wrappedWith({ ...base, evidenceSeats: [{ id: 'fact-1', seat: 7 }] }), /cannot be read/)
  assert.throws(() => wrappedWith({ ...base, evidenceSeats: [{ id: 'fact-1', seat: 'seat-1', seatLabel: 7 }] }), /cannot be read/)
  assert.throws(() => wrappedWith({ ...base, evidenceSeats: 'fact-1' }), /cannot be read/)
})
