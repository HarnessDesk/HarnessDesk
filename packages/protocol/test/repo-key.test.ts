import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizedRepoKey, repoKey } from '../src/repo-key.js'

/**
 * One key per repository, whoever spelled the remote.
 *
 * The host reads `origin` for every folder it lists and sends this key, not the
 * URL, so a project cloned a dozen times is a dozen folders and one key.
 */

test('one repository is one key, however its remote is spelled', () => {
  assert.equal(repoKey('git@github.com-work:AcmeCo/ledger-api.git'), 'github.com/acmeco/ledger-api')
  assert.equal(repoKey('https://github.com/AcmeCo/ledger-api'), 'github.com/acmeco/ledger-api')
  assert.equal(repoKey('https://github.com/AcmeCo/ledger-api.git/'), 'github.com/acmeco/ledger-api')
  assert.equal(repoKey('ssh://git@github.com/AcmeCo/ledger-api.git'), 'github.com/acmeco/ledger-api')
})

test('the same name on another host is another repository', () => {
  assert.notEqual(repoKey('https://git.example.com/AcmeCo/ledger-api'), repoKey('https://github.com/AcmeCo/ledger-api'))
})

test('a remote with no value says nothing', () => {
  assert.equal(repoKey(null), null)
  assert.equal(repoKey(undefined), null)
  assert.equal(repoKey(''), null)
  assert.equal(repoKey('   '), null)
})

test('a path on this machine is not an address, so it names nothing', () => {
  // `git clone ./source ./copy` points a clone's origin at a folder; two folders sharing a source are not a repository's identity.
  assert.equal(repoKey('/Users/dev/code/ledger-api'), null)
  assert.equal(repoKey('../ledger-api.git'), null)
  assert.equal(repoKey('file:///srv/git/ledger-api.git'), null)
  assert.equal(repoKey('C:\\repos\\ledger-api'), null)
  assert.equal(repoKey('C:/repos/ledger-api'), null)
})

test('credentials a remote carries never reach the key', () => {
  assert.equal(repoKey('https://jane:not-a-real-token@example.com/acme/widgets.git'), 'example.com/acme/widgets')
  assert.equal(repoKey('https://x-access-token:abc123@github.com/acme/widgets'), 'github.com/acme/widgets')
})

test('a key is its own key, so a value that was already read comes back unchanged', () => {
  const key = repoKey('git@github.com:acme/widgets.git')!
  assert.equal(repoKey(key), key)
})

test('an invalid remote never falls back to its raw userinfo', () => {
  assert.equal(repoKey('https://jane:not-a-real-token@example.com:invalid/acme/widgets.git'), null)
  assert.equal(repoKey('https://jane:not-a-real-token@/acme/widgets.git'), null)
})

test('relative local origins are not shared repository identities', () => {
  assert.equal(repoKey('widgets.git'), null)
  assert.equal(repoKey('source/widgets.git'), null)
  assert.equal(repoKey('source/acme/widgets.git'), null)
})

test('malformed scheme spellings cannot be mistaken for SCP remotes', () => {
  for (const origin of [
    'https:/jane:not-a-real-token@example.com/acme/widgets.git',
    'https:jane:not-a-real-token@example.com/acme/widgets.git',
    'ssh:/git@example.com/acme/widgets.git',
    'git:/example.com/acme/widgets.git',
  ]) assert.equal(repoKey(origin), null)
})

test('SCP remotes require a host and a relative repository path without userinfo', () => {
  for (const origin of ['git@bad host:acme/widgets', 'git@example.com:/acme/widgets', 'git@example.com:token@acme/widgets', 'git@example.com:acme/widgets?token=demo']) {
    assert.equal(repoKey(origin), null)
  }
  assert.equal(repoKey('git@internal:acme/widgets.git'), 'internal/acme/widgets')
})

test('single-label host identities roundtrip without accepting relative raw origins', () => {
  const key = repoKey('git@internal:acme/widgets.git')
  assert.equal(normalizedRepoKey(key), key)
  assert.equal(normalizedRepoKey('INTERNAL/Acme/Widgets'), key)
  assert.equal(repoKey('internal/acme/widgets'), null)
  for (const identity of [null, '', 'jane@example.com/acme/widgets', 'https://example.com/acme/widgets', 'internal/acme/widgets?token=demo']) {
    assert.equal(normalizedRepoKey(identity), null)
  }
})
