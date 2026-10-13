import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage, ValidationError } from '../src/index.js'
const parse = (params: unknown) => parseClientMessage({ id: 1, method: 'workspace/browse', params })
test('folder-picker browse remains optional and entries mode requires an explicit root', () => {
  assert.doesNotThrow(() => parse({}))
  assert.doesNotThrow(() => parse({ path: '/project', runtime: 'agent' }))
  assert.doesNotThrow(() => parse({ mode: 'entries', root: '/project', path: '/project/src', runtime: 'agent' }))
  assert.throws(() => parse({ mode: 'entries', path: '/project' }), ValidationError)
  assert.throws(() => parse({ mode: 'unknown', root: '/project' }), ValidationError)
})
