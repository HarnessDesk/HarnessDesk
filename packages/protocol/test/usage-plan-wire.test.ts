import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, ValidationError } from '../src/index.js'

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

test('usage/plan/set accepts a fee, a budget, both, or either cleared with null', () => {
  const base = { runtime: 'claude-code', account: 'dev@example.com' }
  assert.doesNotThrow(() => request('usage/plan/set', { ...base, fee: { amount: 20, currency: 'USD', period: 'month' } }))
  assert.doesNotThrow(() => request('usage/plan/set', { ...base, budget: { amount: 50, currency: 'USD' } }))
  assert.doesNotThrow(() =>
    request('usage/plan/set', {
      ...base,
      fee: { amount: 20, currency: 'USD', period: 'year' },
      budget: { amount: 50, currency: 'USD' },
    }),
  )
  assert.doesNotThrow(() => request('usage/plan/set', { ...base, fee: null }))
  assert.doesNotThrow(() => request('usage/plan/set', { ...base, budget: null }))
  assert.doesNotThrow(() => request('usage/plan/set', base))
})

test('usage/plan/set refuses a bad period, a non-numeric amount, or a missing runtime/account', () => {
  const base = { runtime: 'claude-code', account: 'dev@example.com' }
  assert.throws(() => request('usage/plan/set', { ...base, fee: { amount: 20, currency: 'USD', period: 'week' } }), ValidationError)
  assert.throws(() => request('usage/plan/set', { ...base, fee: { amount: '20', currency: 'USD', period: 'month' } }), ValidationError)
  assert.throws(() => request('usage/plan/set', { ...base, budget: { amount: 50 } }), ValidationError)
  assert.throws(() => request('usage/plan/set', { account: 'dev@example.com', fee: { amount: 20, currency: 'USD', period: 'month' } }), ValidationError)
  assert.throws(() => request('usage/plan/set', { runtime: 'claude-code', fee: { amount: 20, currency: 'USD', period: 'month' } }), ValidationError)
})

test('usage/plan/read takes no meaningful params', () => {
  assert.doesNotThrow(() => request('usage/plan/read', {}))
})
