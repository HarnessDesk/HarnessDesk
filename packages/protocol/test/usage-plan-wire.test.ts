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

/**
 * `runtime` never carries the `plan-store.ts` row-key separator, and
 * `account` is never empty and never past a sane length — both apply to
 * `usage/plan/read` and `usage/plan/set` alike, since both key the same row.
 */
test('usage/plan/set refuses an empty account, an over-length account, or a runtime containing ":"', () => {
  assert.throws(() => request('usage/plan/set', { runtime: 'claude-code', account: '', fee: { amount: 20, currency: 'USD', period: 'month' } }), ValidationError)
  assert.throws(() => request('usage/plan/set', { runtime: 'claude-code', account: '   ', fee: { amount: 20, currency: 'USD', period: 'month' } }), ValidationError)
  assert.throws(() => request('usage/plan/set', { runtime: 'claude-code', account: 'x'.repeat(257), fee: { amount: 20, currency: 'USD', period: 'month' } }), ValidationError)
  assert.throws(() => request('usage/plan/set', { runtime: 'claude:code', account: 'dev@example.com', fee: { amount: 20, currency: 'USD', period: 'month' } }), ValidationError)
  assert.doesNotThrow(() => request('usage/plan/set', { runtime: 'claude-code', account: 'x'.repeat(256), fee: { amount: 20, currency: 'USD', period: 'month' } }))
})

test('usage/plan/read takes { runtime, account }, and an optional plan string to match a suggestion against', () => {
  assert.doesNotThrow(() => request('usage/plan/read', { runtime: 'claude-code', account: 'dev@example.com' }))
  assert.doesNotThrow(() => request('usage/plan/read', { runtime: 'claude-code', account: 'dev@example.com', plan: 'Pro' }))
  assert.doesNotThrow(() => request('usage/plan/read', { runtime: 'claude-code', account: 'dev@example.com', plan: null }))
  assert.throws(() => request('usage/plan/read', {}), ValidationError)
  assert.throws(() => request('usage/plan/read', { runtime: 'claude-code', account: '' }), ValidationError)
  assert.throws(() => request('usage/plan/read', { runtime: 'claude:code', account: 'dev@example.com' }), ValidationError)
})
