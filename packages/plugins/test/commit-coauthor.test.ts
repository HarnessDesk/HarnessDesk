import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMMIT_COAUTHOR_PROBLEM, DEFAULT_COMMIT_COAUTHOR, commitCoAuthorOf, gitPlugin } from '../src/index.js'

/**
 * The Git plugin's Commit co-author setting, as the host reads it before a
 * `commit_work` commit. Untouched is the shipped line, blank is none, a
 * well-formed line is used as git spells it, and anything else is never
 * written: the shipped line stands in, with the one sentence Settings shows.
 */

test('the setting ships the desk line it replaced, untouched means that line', () => {
  assert.equal(DEFAULT_COMMIT_COAUTHOR, 'Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>')
  const schema = gitPlugin.manifest.configSchema as { properties: Record<string, { default?: unknown; title?: string }> }
  assert.equal(schema.properties['commitCoAuthor']?.default, DEFAULT_COMMIT_COAUTHOR)
  assert.equal(schema.properties['commitCoAuthor']?.title, 'Commit co-author')
  for (const untouched of [undefined, null]) {
    assert.deepEqual(commitCoAuthorOf(untouched), { line: DEFAULT_COMMIT_COAUTHOR, problem: null })
  }
  assert.deepEqual(commitCoAuthorOf(DEFAULT_COMMIT_COAUTHOR), { line: DEFAULT_COMMIT_COAUTHOR, problem: null })
})

test('blank or only whitespace adds no desk line, and is not a problem', () => {
  for (const blank of ['', ' ', '\t', '  \n  ', '\r\n']) {
    assert.deepEqual(commitCoAuthorOf(blank), { line: null, problem: null }, JSON.stringify(blank))
  }
})

test('a well-formed custom line is used, trimmed and with git’s spelling of the key', () => {
  assert.deepEqual(commitCoAuthorOf('Co-authored-by: Jane Doe <dev@example.com>'),
    { line: 'Co-authored-by: Jane Doe <dev@example.com>', problem: null })
  assert.deepEqual(commitCoAuthorOf('  co-authored-by:Jane Doe   <dev@example.com>  \n'),
    { line: 'Co-authored-by: Jane Doe <dev@example.com>', problem: null })
  assert.deepEqual(commitCoAuthorOf('CO-AUTHORED-BY: Acme Bot (review) <bot+desk@acme.dev>'),
    { line: 'Co-authored-by: Acme Bot (review) <bot+desk@acme.dev>', problem: null })
})

test('a malformed value is never written: the default stands in and the problem is said once', () => {
  for (const malformed of [
    'Jane Doe <dev@example.com>',
    'Signed-off-by: Jane Doe <dev@example.com>',
    'Co-authored-by: <dev@example.com>',
    'Co-authored-by: Jane Doe',
    'Co-authored-by: Jane Doe dev@example.com',
    'Co-authored-by: Jane Doe <dev.example.com>',
    'Co-authored-by: Jane Doe <dev@example.com',
    'Co-authored-by: Jane <Doe> <dev@example.com>',
    'Co-authored-by: Jane Doe <dev@exa mple.com>',
    'Co-authored-by: Jane Doe <dev@@example.com>',
    'Co-authored-by: Jane Doe <dev@example.com> trailing',
    'Co-authored-by: Jane\u0000Doe <dev@example.com>',
    42,
    true,
    {},
  ]) {
    assert.deepEqual(commitCoAuthorOf(malformed), { line: DEFAULT_COMMIT_COAUTHOR, problem: COMMIT_COAUTHOR_PROBLEM }, JSON.stringify(malformed))
  }
})

test('more than one line is refused, never written as a second trailer', () => {
  for (const multiLine of [
    'Co-authored-by: Jane Doe <dev@example.com>\nCo-authored-by: Acme Bot <bot@acme.dev>',
    'Co-authored-by: Jane Doe <dev@example.com>\r\nSigned-off-by: Jane Doe <dev@example.com>',
    'Co-authored-by: Jane\nDoe <dev@example.com>',
    'Co-authored-by: Jane Doe <dev@example.com>\n\nBody text',
  ]) {
    assert.deepEqual(commitCoAuthorOf(multiLine), { line: DEFAULT_COMMIT_COAUTHOR, problem: COMMIT_COAUTHOR_PROBLEM }, JSON.stringify(multiLine))
  }
})
