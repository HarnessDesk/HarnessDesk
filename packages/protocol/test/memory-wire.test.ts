import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, ValidationError } from '../src/index.js'

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })

const citation = { goal: 'source', receipt: 'receipt-1', project: '/work/repo', path: '.harnessdesk/memory/notes.md', at: 'a'.repeat(40) }

test('memory/list takes a bounded root and a full commit revision, never a ref or a short hash', () => {
  assert.doesNotThrow(() => request('memory/list', { root: '/work/repo', at: 'a'.repeat(40) }))
  assert.doesNotThrow(() => request('memory/list', { root: '/work/repo', at: 'a'.repeat(64) }))
  for (const at of ['a'.repeat(39), 'A'.repeat(40), 'a'.repeat(41), 'HEAD', 'main', '']) {
    assert.throws(() => request('memory/list', { root: '/work/repo', at }), ValidationError)
  }
  assert.throws(() => request('memory/list', { root: '', at: 'a'.repeat(40) }), ValidationError)
  assert.throws(() => request('memory/list', { root: 'x'.repeat(4097), at: 'a'.repeat(40) }), ValidationError)
  assert.throws(() => request('memory/list', { at: 'a'.repeat(40) }), ValidationError)
})

test('memory/read takes an ordinary citation and never an extra host-owned field', () => {
  assert.doesNotThrow(() => request('memory/read', { root: '/work/repo', citation }))
  assert.throws(() => request('memory/read', { root: '/work/repo', citation, text: 'forged contents' }), ValidationError)
  assert.throws(() => request('memory/read', { root: '/work/repo', citation, resolution: { state: 'retained' } }), ValidationError)
  assert.throws(() => request('memory/read', { citation }), ValidationError)
})

test('a citation this wire layer will not even parse can never reach the cross-project check', () => {
  for (const at of ['a'.repeat(39), 'HEAD']) {
    assert.throws(() => request('memory/read', { root: '/work/repo', citation: { ...citation, at } }), ValidationError)
  }
  for (const path of ['', '/absolute', '../outside', 'docs\\result.md', 'C:/result.md']) {
    assert.throws(() => request('memory/read', { root: '/work/repo', citation: { ...citation, path } }), ValidationError)
  }
})
