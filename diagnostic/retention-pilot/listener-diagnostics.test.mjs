import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listenerCounts } from './listener-diagnostics.mjs'

test('listener observations count addresses without returning them', () => {
  const raw='p123\nn127.0.0.1:12\np456\nn[::1]:34\nn*:56\n'
  const counts=listenerCounts(raw)
  assert.deepEqual(counts,{total:3,loopback:2,nonloopback:1})
  assert.doesNotMatch(JSON.stringify(counts),/127|::1|123|456/)
  assert.deepEqual(listenerCounts(''),{total:0,loopback:0,nonloopback:0})
})
