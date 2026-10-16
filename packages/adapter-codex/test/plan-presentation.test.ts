import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodexProtocol } from '@harnessdesk/codex'
import { mapRateLimits } from '../src/mapping/notifications.js'

for (const [raw, label] of [
  ['self_serve_business_prolite', 'Business Pro Lite'],
  ['self_serve_business_usage_based', 'Business Usage Based'],
  ['prolite', 'Pro Lite'],
  ['promax', 'Pro Max'],
  ['plus', 'Plus'],
  ['self_serve_future_plan', 'Future Plan'],
] as const) test(`plan presentation names ${raw} and preserves the raw type`, () => {
  const limits = mapRateLimits({ planType: raw, primary: null, secondary: null, credits: null } as unknown as CodexProtocol.v2.RateLimitSnapshot)
  assert.equal(limits.planType, raw)
  assert.equal(limits.planLabel, label)
})
