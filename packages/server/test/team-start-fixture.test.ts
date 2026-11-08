import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { FlowPolicy } from '@harnessdesk/protocol'

import { parseFlowPolicy } from '../src/flow-policy.js'
import { builtinFlowRoot } from '../src/host.js'

test('the New Team preview policy matches the shipped Write and review parser result', async () => {
  // The preview's generated policy table is JSON with a TypeScript type check.
  // Read its data here so the UI suite never needs this package's build output.
  const fixture = await readFile(new URL('../../../ui/src/preview/team-start-fixture.ts', import.meta.url), 'utf8')
  const literal = /export const TEAM_START_POLICIES = ([\s\S]+) satisfies Readonly<Record<string, FlowPolicy>>/.exec(fixture)
  assert.ok(literal, 'the generated preview policy table is present')
  const policies = JSON.parse(literal[1]!) as Record<string, FlowPolicy>
  const source = await readFile(join(builtinFlowRoot(), 'fix-and-review.yml'), 'utf8')
  const parsed = parseFlowPolicy(source)
  assert.deepEqual(parsed.problems, [])
  assert.equal(parsed.document?.format, 'agents')
  if (parsed.document?.format !== 'agents') throw new Error('Expected a current policy')
  assert.deepEqual(policies['fix-and-review'], parsed.document.flow)
})
