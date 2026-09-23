import assert from 'node:assert/strict'
import test from 'node:test'

import { activeMilliseconds, pairedCosts } from '../src/insight/compare.js'

const row = (goal: string, side: 'left' | 'right', value: number | null, basis: 'listPrice' | 'vendorMetered' | 'mixed' | 'unknown' = 'listPrice', complete = true) => ({ goal, side, value, basis, complete })

test('paired costs never pool unmatched or incompatible goals', () => {
  const result = pairedCosts([
    row('unmatched-cheap', 'left', 1), row('other', 'right', 20),
    row('basis', 'left', 2, 'listPrice'), row('basis', 'right', 3, 'vendorMetered'),
    row('pair', 'left', 4), row('pair', 'right', 8),
  ])
  assert.deepEqual(result, { goals: ['pair'], left: 4, right: 8 })
})

test('active time unions overlaps', () => {
  assert.equal(activeMilliseconds([{ from: 0, to: 10 }, { from: 5, to: 15 }, { from: 20, to: 25 }]), 20)
  assert.equal(activeMilliseconds([]), null)
})
