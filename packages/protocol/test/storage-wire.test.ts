import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage, ValidationError } from '../src/index.js'

test('Storage accepts only the three reviewed age choices and conversation pointers', () => {
  const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })
  for (const olderThanDays of [30, 60, 90]) {
    const params = { olderThanDays, exclude: [{ runtime: 'alpha', sessionId: 'synthetic' }] }
    assert.deepEqual(request('storage/cleanupPreview', params).params, params)
    assert.equal(request('storage/cleanup', { ...params, includeDirty: true, inventoryToken: 'confirmed' }).method, 'storage/cleanup')
  }
  for (const olderThanDays of [0, 31, '30', Infinity, null]) assert.throws(() => request('storage/cleanupPreview', { olderThanDays, exclude: [] }), ValidationError)
  assert.throws(() => request('storage/cleanupPreview', { olderThanDays: 30, exclude: ['alpha'] }), ValidationError)
  assert.throws(() => request('storage/cleanupPreview', { olderThanDays: 30, exclude: [{ runtime: 'alpha' }] }), ValidationError)
  assert.throws(() => request('storage/cleanup', { olderThanDays: 30, exclude: [], includeDirty: true }), ValidationError)
  assert.throws(() => request('storage/cleanup', { olderThanDays: 30, exclude: [], includeDirty: 'yes', inventoryToken: 'confirmed' }), ValidationError)
})
