import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserProfileStorageName, browserProfileSession, isBrowserProfile, sessionBrowserProfile } from '../src/browser-profile.js'

test('browser identity is a reversible UTF-8 tuple with no delimiter, Unicode or runtime collisions', () => {
  const identities = [['a', 'b'], ['a', 'c'], ['other', 'b'], ['a:b', 'c'], ['a', 'b:c'], ['助手', '猫😺'], ['a', '\ud800']]
  const profiles = identities.map(([runtime, session]) => sessionBrowserProfile(runtime!, session!))
  assert.equal(profiles[0], 'session-WyJhIiwiYiJd')
  assert.equal(new Set(profiles).size, identities.length)
  identities.forEach(([runtime, sessionId], index) => {
    assert.deepEqual(browserProfileSession(profiles[index]!), { runtime, sessionId })
    assert.equal(isBrowserProfile(profiles[index]), true)
  })
})

test('only canonical tuple encodings and legacy opaque lane identifiers are browser profiles', () => {
  for (const profile of ['session-forged', 'session-WyJhIiwiYiJd=', 'session-WyJhIiwiYiJd\n', 'session-W10', 'session-Li4vcHJpdmF0ZQ', '../private', 'lane-a\n', 'lane-a/b']) {
    assert.equal(browserProfileSession(profile), null)
    assert.equal(isBrowserProfile(profile), false)
  }
  assert.equal(isBrowserProfile('lane-fixture'), true)
})

test('bounded lowercase storage names match SHA-256 across padding boundaries, Unicode and long identities', () => {
  const profiles = [sessionBrowserProfile('fixture', 'aaa'), sessionBrowserProfile('fixture', 'aaG'), sessionBrowserProfile('助手', '猫😺'),
    ...[0, 1, 47, 48, 55, 56, 63, 64, 65, 127, 128, 180, 10000].map(size => `session-${'a'.repeat(size)}`)]
  for (const profile of profiles) {
    const storage = browserProfileStorageName(profile)
    assert.equal(storage, `session-${createHash('sha256').update(profile).digest('hex')}`)
    assert.match(storage, /^session-[a-f0-9]{64}$/)
    assert.equal(storage.length, 72)
  }
  assert.notEqual(browserProfileStorageName(profiles[0]!), browserProfileStorageName(profiles[1]!))
  assert.equal(browserProfileStorageName('lane-fixture'), 'lane-fixture')
})
