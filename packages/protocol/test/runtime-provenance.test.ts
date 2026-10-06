import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('native commit credit docs name the adapter and retain provenance', () => {
  const root = process.cwd()
  const runtime = readFileSync(join(root, 'packages/protocol/src/runtime.ts'), 'utf8')
  const extending = readFileSync(join(root, 'docs/extending.md'), 'utf8')
  const decisions = readFileSync(join(root, 'docs/decisions.md'), 'utf8')

  assert.match(runtime, /Native commit credit supplied by the adapter/)
  assert.match(extending, /Card commits retain the desk's co-author and add the native commit credit\nsupplied by the running adapter/)
  assert.match(decisions, /native commit credit supplied by the running adapter through its\npresentation/)
  assert.match(decisions, /Credits come from local observations or cited sources; an unknown address is null,/)
})
