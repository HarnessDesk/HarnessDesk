import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeGuardMetrics } from './guard-metrics.mjs'

test('only bounded fixed-label receipt metrics are retained', () => {
  const metrics=makeGuardMetrics()
  metrics.add('private-untrusted-text\nHD1545_RECEIPT {"reason":"cache_')
  metrics.add('not_closed"}\nHD1545_RECEIPT {"reason":"forged"}\n')
  metrics.add('HD1545_RECEIPT {"reason":"quiet_live","extra":"secret"}\n')
  assert.deepEqual(metrics.summary(),{counts:{cache_not_closed:1},truncated:false})
  metrics.add('HD1545_RECEIPT {"reason":"quiet_live"}\n'.repeat(2000))
  const answer=metrics.summary()
  assert.equal(answer.truncated,true)
  assert.ok(answer.counts.quiet_live>0)
  assert.doesNotMatch(JSON.stringify(answer),/private|forged|secret/)
})
