import assert from 'node:assert/strict'
import test from 'node:test'

import { parseClientMessage, ValidationError } from '../src/index.js'

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

const query = { root: '/work/repo', from: 1, to: 2 }
const selector = { agent: 'reviewer', origin: 'project' as const, briefDigest: 'a'.repeat(64), seat: { runtime: 'codex' } }

test('Insight reads accept only bounded host-owned queries', () => {
  assert.doesNotThrow(() => request('insight/usage', query))
  assert.doesNotThrow(() => request('insight/goal', { goal: 'goal-1' }))
  assert.doesNotThrow(() => request('insight/agent', { root: '/work/repo', agent: 'reviewer', origin: 'project' }))
  assert.doesNotThrow(() => request('insight/compare', { ...query, goals: ['goal-1'], left: selector, right: selector }))
  for (const invalid of [
    { ...query, from: -1 },
    { ...query, from: 2, to: 1 },
    { ...query, to: 2 + 91 * 86_400_000 },
    { ...query, amount: 0 },
  ]) assert.throws(() => request('insight/usage', invalid), ValidationError)
  assert.throws(() => request('insight/compare', { ...query, goals: Array.from({ length: 51 }, () => 'goal-1'), left: selector, right: selector }), ValidationError)
})

test('Insight order accepts a bounded host stamp, never a submitted order or cost', () => {
  assert.doesNotThrow(() => request('insight/order/apply', { stamp: 'a'.repeat(32) }))
  assert.throws(() => request('insight/order/apply', { stamp: 'a'.repeat(32), seats: [selector.seat] }), ValidationError)
  assert.throws(() => request('insight/order/apply', { stamp: '' }), ValidationError)
  assert.throws(() => request('insight/order/apply', { stamp: 'a'.repeat(257) }), ValidationError)
  assert.doesNotThrow(() => request('insight/order/preview', {
    ...query, goals: ['goal-1'], left: selector, right: { ...selector, seat: { runtime: 'codex', model: 'gpt-5.6' } }, agent: 'reviewer', origin: 'project',
  }))
})
