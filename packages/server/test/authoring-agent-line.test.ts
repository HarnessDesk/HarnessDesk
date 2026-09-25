import assert from 'node:assert/strict'
import { test } from 'node:test'

import { replaceAgentLine } from '../src/authoring/agent-line.js'

const BRIEF = '\r\nReview the change.\r\n\r\n## How to report\r\n\r\nOne line. # not a comment\r\n'

test('preserves BOM CRLF comment and brief', () => {
  const source = `﻿---\r\nname: "Old # name"   # the shown name\r\nceiling: read\r\n---${BRIEF}`
  const next = replaceAgentLine(source, 'name', '"New name"')
  assert.equal(next, `﻿---\r\nname: "New name"   # the shown name\r\nceiling: read\r\n---${BRIEF}`)
  // Only the value's bytes moved: everything before and after them is the file's own.
  const before = source.indexOf('"Old # name"')
  assert.equal(next.slice(0, before), source.slice(0, before))
  assert.equal(next.slice(before + '"New name"'.length), source.slice(before + '"Old # name"'.length))
})

test('inserts absent field before closing fence', () => {
  const source = '---\r\nname: Reviewer\r\n# answers are added below\r\n---\r\nThe brief.\r\n---\r\nnot a fence of the front matter\r\n'
  const next = replaceAgentLine(source, 'answers', '["approve", "changes"]')
  assert.equal(
    next,
    '---\r\nname: Reviewer\r\n# answers are added below\r\nanswers: ["approve", "changes"]\r\n---\r\nThe brief.\r\n---\r\nnot a fence of the front matter\r\n',
  )
  const lines = source.split('\r\n')
  const written = next.split('\r\n')
  assert.deepEqual(written.filter((line) => !line.startsWith('answers:')), lines)
})

test('refuses duplicate key', () => {
  const source = '---\nname: One\nceiling: read\nname: Two\n---\nBrief.\n'
  const copy = String(source)
  assert.throws(() => replaceAgentLine(source, 'name', '"Three"'), /Keep one declaration of this field in the file\./)
  assert.equal(source, copy)
})

test('refuses block scalar', () => {
  const source = '---\nname: One\ndescription: |\n  Two lines\n  of description\n---\nBrief.\n'
  assert.throws(() => replaceAgentLine(source, 'description', '"flat"'), /spans lines\. Open the file/)
})

test('refuses multiline list', () => {
  const source = '---\nname: One\nanswers:\n  - approve # keep\n  - changes\n---\nBrief.\n'
  assert.throws(() => replaceAgentLine(source, 'answers', '["approve"]'), /spans lines\. Open the file/)
})

test('refuses value with newline', () => {
  const source = '---\nname: One\nceiling: read\n---\nBrief.\n'
  assert.throws(() => replaceAgentLine(source, 'name', '"x"\nceiling: merge'), /Use one YAML value on this line\./)
  assert.throws(() => replaceAgentLine(source, 'name', '"x"\rceiling: merge'), /Use one YAML value on this line\./)
})

test('refuses a field that is not edited on a row, and a file without front matter', () => {
  assert.throws(() => replaceAgentLine('---\nname: a\n---\nb\n', 'skills', '[x]'), /This field is edited in the file\./)
  assert.throws(() => replaceAgentLine('Just a brief.\n', 'name', '"a"'), /add its front matter first/)
  assert.throws(() => replaceAgentLine('---\nname: a\nBrief.\n', 'name', '"b"'), /Close the front matter/)
})

test('an apostrophe inside a plain value opens no quote, so its trailing comment survives', () => {
  // The review's reproduction: a plain scalar with an apostrophe mid-value.
  const source = "---\nname: Reviewer\ndescription: The team's reviewer   # shown in lists\nceiling: read\n---\nBrief.\n"
  assert.equal(
    replaceAgentLine(source, 'description', '"New text"'),
    "---\nname: Reviewer\ndescription: \"New text\"   # shown in lists\nceiling: read\n---\nBrief.\n",
  )
  // A quote still opens where a scalar starts — at the value, and at an item of a flow list — and '' stays inside it.
  const quoted = "---\nname: 'It''s # still the name'   # the shown name\nanswers: [approve, 'won''t # merge']  # the verdicts\n---\nBrief.\n"
  assert.equal(
    replaceAgentLine(quoted, 'name', '"Its"'),
    "---\nname: \"Its\"   # the shown name\nanswers: [approve, 'won''t # merge']  # the verdicts\n---\nBrief.\n",
  )
  assert.equal(
    replaceAgentLine(quoted, 'answers', '["approve"]'),
    "---\nname: 'It''s # still the name'   # the shown name\nanswers: [\"approve\"]  # the verdicts\n---\nBrief.\n",
  )
})
