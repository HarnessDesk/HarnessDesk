import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, ValidationError, type HostParams } from '../src/index.js'

test('library/apply preserves optional bundle guards and rejects malformed digests', () => {
  const op = { id: 'op-1', kind: 'skill', name: 'demo', action: 'create', targetPath: '/work/.agents/skills/demo', content: 'demo', guardDigest: null, backup: false }
  const request = (fields: object) => parseClientMessage({ id: 1, method: 'library/apply', params: { ops: [{ ...op, ...fields }] } })
  const fields = { guardBundle: null, sourceBundle: 'd'.repeat(64) }
  const parsed = request(fields)
  assert.equal(parsed.method, 'library/apply')
  const result = (parsed.params as HostParams<'library/apply'>).ops[0]!
  assert.equal(result.guardBundle, null)
  assert.equal(result.sourceBundle, fields.sourceBundle)
  assert.doesNotThrow(() => request({ guardBundle: 'a'.repeat(64) }))
  assert.doesNotThrow(() => request({})) // Apply tells old plans to plan again.
  assert.throws(() => request({ guardBundle: 1 }), ValidationError)
  assert.throws(() => request({ sourceBundle: null }), ValidationError)
})
