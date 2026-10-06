import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('native commit credit docs name the adapter and retain provenance', () => {
  const root = process.cwd()
  const runtime = readFileSync(join(root, 'packages/protocol/src/runtime.ts'), 'utf8')
  const extending = readFileSync(join(root, 'docs/extending.md'), 'utf8')
  const decisions = readFileSync(join(root, 'docs/decisions.md'), 'utf8')
  const interfaceDoc = readFileSync(join(root, 'docs/interface.md'), 'utf8')

  assert.match(runtime, /Native commit credit supplied by the adapter/)
  assert.match(extending, /Card commits retain the desk's co-author and add the native commit credit\s+supplied by the running adapter/)
  assert.match(decisions, /native commit credit supplied by the running adapter through its\s+presentation/)
  assert.match(decisions, /Credits come from local observations or cited sources; an unknown address is null,/)
  const pins: readonly [string, string][] = [
    [extending, 'other role ids use letters, digits and hyphens; other characters become `-`'],
    [extending, '32 characters at most; nothing usable reads `role`'],
    [extending, 'Description updates retain the latest seat for each role and agent pair.'],
    [extending, "The current template's contributor portion renders each distinct credit once"],
    [decisions, 'Other role ids use letters, digits and hyphens; other characters become `-`.'],
    [decisions, 'description keeps the latest seat for each role and agent pair in its hidden signature marker.'],
    [interfaceDoc, 'A description keeps the latest seat for each role and agent pair'],
  ]
  for (const [document, sentence] of pins) {
    const pattern = new RegExp(sentence.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'))
    assert.match(document, pattern)
    assert.match(document.replace(/\s+/g, '\n'), pattern, 'layout does not change the contract')
  }
  assert.doesNotMatch(decisions, /other role words remain its own/)
  assert.doesNotMatch(interfaceDoc, /keeps each role and seat that wrote it/)
})
