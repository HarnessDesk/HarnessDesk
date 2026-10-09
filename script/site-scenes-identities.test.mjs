import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSiteIdentities } from './site-scenes-identities.mjs'

test('allows only demo and placeholder domains and returns the built addresses', () => {
  assert.deepEqual(assertSiteIdentities('shane@harnessdesk.app olivia@harnessdesk.app dev@example.com demo@acme.dev'),
    ['shane@harnessdesk.app', 'olivia@harnessdesk.app', 'dev@example.com', 'demo@acme.dev'])
})
test('refuses another domain even when it contains an allowed suffix', () => {
  assert.throws(() => assertSiteIdentities('dev@' + 'example.com.invalid'), /Unexpected site identity/)
})
test('refuses an unapproved identity on the public demo domain', () => {
  assert.throws(() => assertSiteIdentities('dev@' + 'harnessdesk.app'), /Unexpected site identity/)
})

test('scans readable bundle text without treating encoded parser integers as accounts', () => {
  const packed = 'parser.deserialize({states:"O.KmQpOAN' + '@wO.KxQdO",nodeNames:"Program"});'
  assert.deepEqual(assertSiteIdentities(packed + '"dev@example.com"'), ['dev@example.com'])
  assert.throws(() => assertSiteIdentities(packed + '"dev@' + 'example.com.invalid"'), /Unexpected site identity/)
})
