import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage, ValidationError } from '../src/index.js'
const start = (params: unknown) => parseClientMessage({ id: 1, method: 'workspace/session/start', params })
test('phone start validates optional model and effort while rejecting hidden controls', () => {
  assert.doesNotThrow(() => start({ text: 'Hello', model: 'model-one', effort: 'extra' }))
  assert.doesNotThrow(() => start({ text: 'Hello', effort: 'low' }))
  for (const params of [{ model: '' }, { model: 1 }, { model: 'x'.repeat(301) }, { effort: 'xhigh' }, { effort: false }, { permissions: 'always' }]) {
    assert.throws(() => start({ text: 'Hello', ...params }), ValidationError)
  }
})
