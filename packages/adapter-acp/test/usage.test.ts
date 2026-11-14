import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usageLimits } from '../src/usage.js'

test('the modern usage frame also supplies legacy windows and preserves severity and reached', () => {
  const result = usageLimits({ limits: { lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 100,
    windowMinutes: 10_080, resetsAt: 200_000, scope: 'Example model', severity: 'critical' }],
    reached: 'weekly', fetchedAt: 100_000 } })
  assert.deepEqual(result?.windows, [{ label: 'Weekly · Example model', usedPercent: 100, windowMinutes: 10_080, resetsAt: 200_000 }])
  assert.equal(result?.lanes?.[0]?.severity, 'critical')
  assert.equal(result?.reached, 'weekly')
})
