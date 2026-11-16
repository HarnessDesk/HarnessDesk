import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkCookies } from './browser-cookie-policy.mjs'

test('the two processes require separate retained sessions and an ephemeral session', () => {
  assert.doesNotThrow(() => checkCookies('write', { a: 'fixture=a', b: 'fixture=b', memory: 'fixture=memory' }))
  assert.doesNotThrow(() => checkCookies('read', { a: 'fixture=a', b: 'fixture=b', memory: '' }))
  assert.throws(() => checkCookies('read', { a: '', b: 'fixture=b', memory: '' }))
  assert.throws(() => checkCookies('read', { a: 'fixture=a', b: 'fixture=a', memory: '' }))
  assert.throws(() => checkCookies('read', { a: 'fixture=a', b: 'fixture=b', memory: 'fixture=memory' }))
  assert.throws(() => checkCookies('other', { a: 'fixture=a', b: 'fixture=b', memory: '' }))
})

test('restart cookie failures identify the exact missing or contaminated session', () => {
  assert.throws(() => checkCookies('read', { a: '', b: 'fixture=b', memory: '' }), /cookie A after restart/)
  assert.throws(() => checkCookies('read', { a: 'fixture=a', b: 'fixture=a', memory: '' }), /cookie B after restart/)
})
