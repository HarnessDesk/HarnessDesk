import assert from 'node:assert/strict'
import test from 'node:test'

import { sumMeasures } from '../src/insight/measures.js'

test('unknown and explicit free remain distinct', () => {
  assert.deepEqual(sumMeasures([]), { value: null, quality: 'unknown' })
  assert.deepEqual(sumMeasures([{ value: 0, quality: 'exact' }]), { value: 0, quality: 'exact' })
  assert.deepEqual(sumMeasures([{ value: 3, quality: 'exact' }, { value: null, quality: 'unknown' }]), { value: 3, quality: 'floor' })
})

test('estimates and streaming floors retain their qualification', () => {
  assert.deepEqual(sumMeasures([{ value: 1, quality: 'estimate' }, { value: 2, quality: 'exact' }]), { value: 3, quality: 'estimate' })
  assert.deepEqual(sumMeasures([{ value: 1, quality: 'floor' }]), { value: 1, quality: 'floor' })
})

test('invalid and overflowing totals refuse', () => {
  assert.throws(() => sumMeasures([{ value: -1, quality: 'exact' }]), /invalid number/)
  assert.throws(() => sumMeasures([{ value: Number.MAX_VALUE, quality: 'exact' }, { value: Number.MAX_VALUE, quality: 'exact' }]), /too large/)
})
