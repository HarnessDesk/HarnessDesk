import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, ValidationError } from '../src/index.js'

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

const FINDING = `finding-${'a'.repeat(8)}`
const STAMP = 'f'.repeat(64)

test('finding/list and finding/read accept only known shapes and reject forged fields', () => {
  assert.doesNotThrow(() => request('finding/list', { goal: 'g1' }))
  assert.doesNotThrow(() => request('finding/list', { goal: 'g1', filter: 'open' }))
  assert.doesNotThrow(() => request('finding/list', { goal: 'g1', filter: 'blocking', cursor: 'abc' }))
  assert.doesNotThrow(() => request('finding/read', { goal: 'g1', finding: FINDING }))

  // Bad IDs and filters.
  assert.throws(() => request('finding/list', { goal: '' }), ValidationError)
  assert.throws(() => request('finding/list', { goal: 'g1', filter: 'closed' }), ValidationError)
  assert.throws(() => request('finding/read', { goal: 'g1', finding: 'not-a-finding-id' }), ValidationError)
  assert.throws(() => request('finding/read', { goal: 'g1', finding: '../etc/passwd' }), ValidationError)
  assert.throws(() => request('finding/list', { goal: 'g1', cursor: 'x'.repeat(513) }), ValidationError)

  // Forged fields: a request may not name a Seat, an origin, a revision or an authority.
  for (const field of ['seat', 'origin', 'revision', 'posted', 'authority', 'problem', 'totals']) {
    assert.throws(() => request('finding/list', { goal: 'g1', [field]: 'x' }), ValidationError)
    assert.throws(() => request('finding/read', { goal: 'g1', finding: FINDING, [field]: 'x' }), ValidationError)
  }
})

test('finding/carry accepts 1 to 200 distinct findings and a bounded request token', () => {
  const valid = { goal: 'g1', revision: 0, source: 'g0', receipt: 'r1', findings: [FINDING], request: 'req-1' }
  assert.doesNotThrow(() => request('finding/carry', valid))
  assert.throws(() => request('finding/carry', { ...valid, findings: [] }), ValidationError)
  assert.throws(() => request('finding/carry', { ...valid, findings: [FINDING, FINDING] }), ValidationError)
  assert.throws(() => request('finding/carry', { ...valid, findings: Array(201).fill(FINDING).map((_, i) => `finding-${i}`) }), ValidationError)
  assert.throws(() => request('finding/carry', { ...valid, revision: -1 }), ValidationError)
  assert.throws(() => request('finding/carry', { ...valid, request: '' }), ValidationError)
  assert.throws(() => request('finding/carry', { ...valid, request: 'x'.repeat(201) }), ValidationError)
  assert.throws(() => request('finding/carry', { ...valid, request: 'has\nnewline' }), ValidationError)
  for (const field of ['seat', 'at', 'origin']) {
    assert.throws(() => request('finding/carry', { ...valid, [field]: 'x' }), ValidationError)
  }
})

test('finding/publication is a plain boolean preference bound to a read revision', () => {
  assert.doesNotThrow(() => request('finding/publication', { goal: 'g1', revision: 3, enabled: true }))
  assert.doesNotThrow(() => request('finding/publication', { goal: 'g1', revision: 0, enabled: false }))
  assert.throws(() => request('finding/publication', { goal: 'g1', revision: 3, enabled: 'yes' }), ValidationError)
  assert.throws(() => request('finding/publication', { goal: 'g1', revision: -1, enabled: true }), ValidationError)
  assert.throws(() => request('finding/publication', { goal: 'g1', enabled: true }), ValidationError)
})

test('a request cannot forge the stamp finding/run and finding/decide read back', () => {
  assert.doesNotThrow(() => request('finding/run', { goal: 'g1', run: 'run-1' }))
  assert.throws(() => request('finding/run', { goal: 'g1', run: 'run-1', stamp: STAMP }), ValidationError)
  const decide = { goal: 'g1', run: 'run-1', round: 1, stamp: STAMP, action: { kind: 'another-round' }, reason: 'the ceiling was reached' }
  assert.doesNotThrow(() => request('finding/decide', decide))
  assert.throws(() => request('finding/decide', { ...decide, stamp: 'short' }), ValidationError)
  assert.throws(() => request('finding/decide', { ...decide, round: 0 }), ValidationError)
  assert.throws(() => request('finding/decide', { ...decide, reason: '' }), ValidationError)
  assert.throws(() => request('finding/decide', { ...decide, reason: 'x'.repeat(4097) }), ValidationError)
  assert.doesNotThrow(() => request('finding/decide', { ...decide, action: { kind: 'merge-anyway' } }))
  assert.doesNotThrow(() => request('finding/decide', { ...decide, action: { kind: 'drop' } }))
  assert.doesNotThrow(() => request('finding/decide', { ...decide, action: { kind: 'admit-exceptions', findings: [FINDING] } }))
  assert.doesNotThrow(() => request('finding/decide', { ...decide, action: { kind: 'decline-exceptions', findings: [FINDING] } }))
  assert.doesNotThrow(() => request('finding/decide', { ...decide, action: { kind: 'adjudicate', finding: FINDING, state: 'withdrawn' } }))
  assert.throws(() => request('finding/decide', { ...decide, action: { kind: 'adjudicate', finding: FINDING, state: 'approved' } }), ValidationError)
  assert.throws(() => request('finding/decide', { ...decide, action: { kind: 'admit-exceptions', findings: [] } }), ValidationError)
  assert.throws(() => request('finding/decide', { ...decide, action: { kind: 'nonsense' } }), ValidationError)
  for (const field of ['seat', 'by', 'head', 'authority']) {
    assert.throws(() => request('finding/decide', { ...decide, [field]: 'x' }), ValidationError)
  }
})

test('a person’s posting actions name one journaled operation or one previewed backfill, and nothing a request may not carry', () => {
  const KEY = `pub-${'a'.repeat(48)}`
  assert.doesNotThrow(() => request('finding/publications', { goal: 'g1', run: 'run-1' }))
  assert.throws(() => request('finding/publications', { goal: 'g1' }), ValidationError)
  const publish = (action: unknown) => request('finding/publish', { goal: 'g1', run: 'run-1', action })
  assert.doesNotThrow(() => publish({ kind: 'post-again', key: KEY }))
  assert.doesNotThrow(() => publish({ kind: 'skip', key: KEY, reason: 'nobody needs it now' }))
  assert.doesNotThrow(() => publish({ kind: 'backfill', stamp: STAMP }))
  assert.throws(() => publish({ kind: 'post-again', key: 'pub-short' }), ValidationError)
  assert.throws(() => publish({ kind: 'post-again', key: KEY, force: true }), ValidationError)
  assert.throws(() => publish({ kind: 'skip', key: KEY, reason: '' }), ValidationError)
  assert.throws(() => publish({ kind: 'skip', key: KEY }), ValidationError)
  assert.throws(() => publish({ kind: 'backfill', stamp: 'x' }), ValidationError)
  assert.throws(() => publish({ kind: 'send-anyway', key: KEY }), ValidationError)
  assert.throws(() => request('finding/publish', { goal: 'g1', run: 'run-1', action: { kind: 'post-again', key: KEY }, url: 'https://example.com' }), ValidationError)
})
