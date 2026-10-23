import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, type HostParams } from '../src/index.js'

test('agent/seating/set preserves an expected absent entry separately from an omitted check', () => {
  const params = { id: 'reviewer', seats: [{ runtime: 'test' }] }
  const parse = (params: unknown) => parseClientMessage({ id: 1, method: 'agent/seating/set', params }).params as HostParams<'agent/seating/set'>
  assert.equal(parse({ ...params, expected: null }).expected, null)
  assert.equal(parse(params).expected, undefined)
  assert.deepEqual(parse({ ...params, expected: params.seats }).expected, parse(params).seats)
})
