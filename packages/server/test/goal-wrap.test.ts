import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { WrapChoices } from '@harnessdesk/protocol'

import { previewWrap, wrapStamp, Wraps, type WrapInput, type WrapPort } from '../src/goals/wrap.js'
import { goal } from './fixtures/goals.js'

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
  evidence: ['fact-1'],
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
