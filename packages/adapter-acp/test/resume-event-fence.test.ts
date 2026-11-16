import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ResumeEventFence } from '../src/resume-event-fence.js'

test('retired replay suppression is scoped to its exact connection and replay object', () => {
  const fence = new ResumeEventFence(), owner = {}, connection = {}, replay = {}, otherConnection = {}, existing = {}
  fence.track('s', owner, connection, replay)
  assert.equal(fence.suppress('s', connection, replay), false)
  fence.retire('s', owner)
  assert.equal(fence.suppress('s', connection, replay), true)
  assert.equal(fence.suppress('s', otherConnection, replay), false)
  assert.equal(fence.suppress('s', connection, existing), false)
  assert.equal(fence.suppress('other', connection, replay), false)
  fence.forget('s', {})
  assert.equal(fence.suppress('s', connection, replay), true)
  fence.forget('s', owner)
  assert.equal(fence.suppress('s', connection, replay), false)
})
