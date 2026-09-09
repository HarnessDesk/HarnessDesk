import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isAppNavigation } from './navigation.mjs'

const APP = 'http://127.0.0.1:54321/?token=secret'

test('the app is its own origin, and a path within it is still the app', () => {
  assert.equal(isAppNavigation(APP, 'http://127.0.0.1:54321/?token=secret'), true)
  assert.equal(isAppNavigation(APP, 'http://127.0.0.1:54321/index.html'), true)
  assert.equal(isAppNavigation(APP, '/relative/path'), true, 'resolved against the app URL')
})

test('userinfo before the host does not make a target the app', () => {
  // The whole reason this module exists. Everything up to `@` is userinfo, so
  // this navigates to evil.com — and it carries the app's prefix exactly.
  const spoof = 'http://127.0.0.1:54321@evil.com/steal'
  assert.equal(new URL(spoof).hostname, 'evil.com', 'the target really is evil.com')
  assert.equal(spoof.startsWith(APP.split('/?')[0]), true, 'and the old prefix test admitted it')
  assert.equal(isAppNavigation(APP, spoof), false)
})

test('a different origin is not the app, however similar it looks', () => {
  assert.equal(isAppNavigation(APP, 'http://127.0.0.1:54322/'), false, 'another port')
  assert.equal(isAppNavigation(APP, 'https://127.0.0.1:54321/'), false, 'another scheme')
  assert.equal(isAppNavigation(APP, 'http://localhost:54321/'), false, 'another host spelling')
  assert.equal(isAppNavigation(APP, 'http://evil.com/'), false)
})

test('an opaque origin is never the app, and neither is nonsense', () => {
  assert.equal(isAppNavigation(APP, 'file:///etc/passwd'), false)
  assert.equal(isAppNavigation(APP, 'data:text/html,<script>1</script>'), false)
  assert.equal(isAppNavigation('file:///a/index.html', 'file:///etc/passwd'), false, 'two opaque origins are not one identity')
  assert.equal(isAppNavigation(null, 'http://127.0.0.1:54321/'), false, 'no app URL yet')
  // Not a counter-example: a bare word is a valid *relative* reference and
  // resolves against the app URL, which is the app's own origin. Electron hands
  // will-navigate an absolute URL, so this is theory — but the answer is right.
  assert.equal(new URL('not a url', APP).href, 'http://127.0.0.1:54321/not%20a%20url')
  assert.equal(isAppNavigation(APP, 'not a url'), true)
})
