import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mapTurnError } from '../src/mapping/errors.js'

test('rateLimitExceeded (0.153.0) is a rate limit, not an unknown', () => {
  const error = mapTurnError({ message: 'slow down', codexErrorInfo: 'rateLimitExceeded' })
  assert.equal(error.code, 'rateLimit')
})

test('a misalignment block carries its explanation and the way to continue', () => {
  const error = mapTurnError({
    message: 'Turn blocked by misalignment policy',
    codexErrorInfo: 'misalignmentPolicyViolation',
    additionalDetails: null,
    misalignment: {
      errorType: 'scope',
      detailedExplanation: 'The requested change reaches outside the task you described.',
      steer: { message: 'Proceed with the change to the deployment script as well.' },
    },
  })
  assert.equal(error.message, 'Turn blocked by misalignment policy')
  assert.ok(error.details?.includes('reaches outside the task'))
  assert.ok(error.details?.includes('To continue anyway, send: Proceed with the change'))
})

test('a misalignment block with no continuation offers none', () => {
  const error = mapTurnError({
    message: 'blocked',
    misalignment: { errorType: null, detailedExplanation: 'Not allowed here.', steer: null },
  })
  assert.equal(error.details, 'Not allowed here.')
})

test('a turn error without misalignment keeps its details as before', () => {
  const error = mapTurnError({ message: 'boom', additionalDetails: 'stack' })
  assert.equal(error.details, 'stack')
})

/**
 * Measured mid-review on 2026-09-06, codex-cli 0.149.0: a workspace that has
 * run out says so in a sentence and nothing else — no discriminant the
 * taxonomy can read. Classified as `unknown` it was indistinguishable from a
 * crash, which is how a reviewer that had stopped for the afternoon looked
 * exactly like one still reading.
 */
test('a workspace spend cap is running out of credit, not an unknown failure', () => {
  const error = mapTurnError({
    message: 'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
  })
  assert.equal(error.code, 'credits')
})

test('a usage limit in the message is read the same way', () => {
  assert.equal(mapTurnError({ message: "You've hit your usage limit. It resets at 3:20 PM." }).code, 'credits')
})
