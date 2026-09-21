import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage } from '../src/wire-validators.js'
import { ValidationError } from '../src/validate.js'

const request = (method: string, params: unknown) => ({ id: 1, method, params })

test('all five provenance verbs validate their actual request envelopes', () => {
  const cases = [
    ['provenance/commits', { root: '/work/project', shas: [] }],
    ['provenance/status', {}],
    ['provenance/status', { root: '/work/project' }],
    ['provenance/capture', { root: '/work/project', enabled: false }],
    ['provenance/retry', { root: '/work/project' }],
    ['provenance/seat', { root: '/work/project', seat: 'seat-1' }],
  ] as const
  for (const [method, params] of cases) {
    const parsed = parseClientMessage(request(method, params))
    assert.equal(parsed.method, method)
    assert.equal('id' in parsed && parsed.id, 1)
  }
})

test('root and Seat bounds reject before any host dispatch can run', () => {
  let dispatched = 0
  for (const root of ['', 'x'.repeat(4097), '/work/\0project', 12, null]) {
    for (const method of ['provenance/status', 'provenance/commits', 'provenance/capture', 'provenance/retry', 'provenance/seat']) {
      assert.throws(() => {
        parseClientMessage(request(method, { root, shas: [], enabled: true, seat: 'seat-1' }))
        dispatched += 1
      }, ValidationError)
    }
  }
  for (const seat of ['', 's'.repeat(201), 'bad\nseat', '\x7f', 2]) {
    assert.throws(() => parseClientMessage(request('provenance/seat', { root: '/work/project', seat })), ValidationError)
  }
  for (const enabled of ['true', 1, null, undefined]) {
    assert.throws(() => parseClientMessage(request('provenance/capture', { root: '/work/project', enabled })), ValidationError)
  }
  assert.equal(dispatched, 0)
})

test('the actual wire rejects 1001 SHAs before deduplication', () => {
  assert.throws(() => parseClientMessage(request('provenance/commits', {
    root: '/work/project', shas: Array(1001).fill('a'.repeat(40)),
  })), /expected at most 1000 full object ids/)
})

test('full object IDs of both formats survive in first-requested order and nothing executable does', () => {
  const one = 'a'.repeat(40)
  const two = 'b'.repeat(64)
  const parsed = parseClientMessage(request('provenance/commits', { root: '/work/project', shas: [two, one, two] }))
  assert.equal(parsed.method, 'provenance/commits')
  assert.deepEqual((parsed as unknown as { params: { shas: readonly string[] } }).params.shas, [two, one])
  for (const value of ['HEAD~1', '--output=/work/escape', 'abc1234', 'g'.repeat(40), 'A'.repeat(40), 42]) {
    assert.throws(() => parseClientMessage(request('provenance/commits', { root: '/work/project', shas: [value] })), ValidationError)
  }
  assert.doesNotThrow(() => parseClientMessage(request('provenance/commits', { root: '/work/project', shas: Array(1000).fill(one) })))
})
