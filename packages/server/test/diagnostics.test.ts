import assert from 'node:assert/strict'
import { test } from 'node:test'

import { redactorFor } from '../src/diagnostics.js'

/**
 * The diagnostics bundle's promise: useful without carrying credentials or
 * private paths. What is pinned is each class of thing that must not leave —
 * tokens, JWTs, secret-named JSON fields, the home directory, and the folders
 * work is kept in — and that an ordinary failure line survives untouched,
 * because a bundle scrubbed into mush helps nobody.
 */

const redact = redactorFor({
  home: '/Users/sam',
  roots: ['/Volumes/Work/acme', '/Users/sam/clients/initech'],
})

test('credential-shaped strings are struck whole', () => {
  assert.equal(
    redact('auth with sk-abc123DEF456ghi failed'),
    'auth with [redacted] failed',
  )
  assert.equal(redact('push using ghp-tokentokentoken1'), 'push using [redacted]')
  assert.equal(
    redact('bearer eyJabcdefghijklmnop.eyJqrstuvwxyz012345.sig12345 rejected'),
    'bearer [redacted-jwt] rejected',
  )
  assert.equal(
    redact('{"apiKey":"very-secret-value","kept":"yes"}'),
    '{"apiKey":"[redacted]","kept":"yes"}',
  )
})

test('the home directory reads as ~, work folders as [workspace], wherever they are', () => {
  assert.equal(redact('log at /Users/sam/.harnessdesk/logs/h.ndjson'), 'log at ~/.harnessdesk/logs/h.ndjson')
  // A workspace outside home — the old homedir-only scrub missed these.
  assert.equal(redact('spawn failed in /Volumes/Work/acme/src'), 'spawn failed in [workspace]/src')
  // A workspace under home is a workspace first, not merely somewhere in ~.
  assert.equal(
    redact('watching /Users/sam/clients/initech/api/index.ts'),
    'watching [workspace]/api/index.ts',
  )
})

test('a nested workspace is not half-replaced by its parent', () => {
  const nested = redactorFor({ home: '/Users/sam', roots: ['/w', '/w/deep/project'] })
  assert.equal(nested('at /w/deep/project/file'), 'at [workspace]/file')
})

test('an ordinary line passes untouched, and hostile roots cannot eat it', () => {
  assert.equal(redact('agent exited with code 1'), 'agent exited with code 1')
  // '/' or '' as a root would replace everything; both are refused.
  const wild = redactorFor({ home: '/Users/sam', roots: ['/', ''] })
  assert.equal(wild('kept /etc/hosts as-is'), 'kept /etc/hosts as-is')
})
