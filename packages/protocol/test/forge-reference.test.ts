import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isForgeReference } from '../src/index.js'

/**
 * A forge reference at a trust boundary: the required parts in their types,
 * and the optional words — action, subject, state — from their own sets, so
 * a verb in the transcript cannot silently degrade to a fallback because a
 * plugin spelled one differently.
 */

const sound = {
  kind: 'pullRequest',
  action: 'opened',
  repo: 'acme/widgets',
  number: 7,
  url: 'https://github.com/acme/widgets/pull/7',
  title: 'Add widgets',
  state: 'open',
  author: 'octocat',
  additions: 12,
  deletions: 3,
  files: 2,
  excerpt: null,
  via: 'gh',
  signature: null,
}

test('a reference with its required parts, in their types, is one', () => {
  assert.equal(isForgeReference(sound), true)
  assert.equal(isForgeReference({ ...sound, subject: 'issue', kind: 'comment', action: 'posted' }), true)
  // The optional parts may be absent or null.
  assert.equal(isForgeReference({ kind: 'issue', repo: 'a/b', number: 1, url: 'https://x/issues/1', via: 'app' }), true)
})

test('a required part missing or of the wrong type is refused', () => {
  assert.equal(isForgeReference(null), false)
  assert.equal(isForgeReference('https://github.com/acme/widgets/pull/7'), false)
  assert.equal(isForgeReference({ ...sound, number: '7' }), false)
  assert.equal(isForgeReference({ ...sound, number: Number.NaN }), false)
  assert.equal(isForgeReference({ ...sound, url: 'acme/widgets#7' }), false)
  assert.equal(isForgeReference({ ...sound, kind: 'gist' }), false)
  assert.equal(isForgeReference({ ...sound, via: 'api' }), false)
  const { repo: _repo, ...noRepo } = sound
  assert.equal(isForgeReference(noRepo), false)
})

test('the optional words come from their own sets, or the row would fall back without a word', () => {
  assert.equal(isForgeReference({ ...sound, action: 'deleted' }), false)
  assert.equal(isForgeReference({ ...sound, subject: 'gist' }), false)
  assert.equal(isForgeReference({ ...sound, state: 'archived' }), false)
  assert.equal(isForgeReference({ ...sound, additions: 'many' }), false)
  assert.equal(isForgeReference({ ...sound, title: 7 }), false)
})
