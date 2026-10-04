import assert from 'node:assert/strict'
import test from 'node:test'

import { repoKey } from '../src/repo-key.js'

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
  assert.equal(repoKey('/Users/jane/code/ledger-api'), null)
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
