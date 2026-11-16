import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { FlowPolicy } from '@harnessdesk/protocol'

import { parseFlowPolicy } from '../src/flow-policy.js'
import { builtinFlowRoot } from '../src/host.js'

const fixtureHint = 'Expected TEAM_START_POLICIES as a JSON object literal followed by satisfies Readonly<Record<string, FlowPolicy>> in team-start-fixture.ts; restore that declaration or update this extractor if its format intentionally changed.'
const previewPolicies = (fixture: string): Record<string, FlowPolicy> => {
  const literal = /export\s+const\s+TEAM_START_POLICIES\s*=\s*([\s\S]+)\s+satisfies\s+Readonly\s*<\s*Record\s*<\s*string\s*,\s*FlowPolicy\s*>\s*>/.exec(fixture)
  if (!literal) throw new Error(fixtureHint)
  let value: unknown
  try { value = JSON.parse(literal[1]!) }
  catch (error) { throw new Error(`${fixtureHint} The literal is not valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(fixtureHint)
  return value as Record<string, FlowPolicy>
}

test('the New Team preview policies match every shipped flow parser result', async (t) => {
  // The preview table is JSON with a TypeScript type check. Read its data here
  // so the New Team UI test never needs this package's build output.
  const fixture = await readFile(new URL('../../../ui/src/preview/team-start-fixture.ts', import.meta.url), 'utf8')
  const policies = previewPolicies(fixture)
  const root = builtinFlowRoot()
  const files = (await readdir(root)).filter(name => name.endsWith('.yml')).sort()
  const ids = files.map(name => name.slice(0, -4)).sort()
  assert.ok(ids.length > 0, 'No shipped .yml flows were found for preview comparison')
  assert.deepEqual(Object.keys(policies).sort(), ids, 'Preview policy keys must match the shipped flow files')
  for (const file of files) {
    const id = file.slice(0, -4)
    await t.test(id, async () => {
      const parsed = parseFlowPolicy(await readFile(join(root, file), 'utf8'))
      assert.deepEqual(parsed.problems, [], `${id}: shipped flow has parser problems`)
      assert.equal(parsed.document?.format, 'agents', `${id}: expected a current policy`)
      if (parsed.document?.format !== 'agents') throw new Error(`${id}: expected a current policy`)
      assert.deepEqual(policies[id], parsed.document.flow, `${id}: preview differs from the shipped parser result`)
    })
  }
})

test('a missing or invalid preview table explains the expected declaration', () => {
  const embedded = 'export const TEAM_START_POLICIES = {"example":{"description":"satisfies Readonly<Record<string, FlowPolicy>>"}} satisfies Readonly<Record<string, FlowPolicy>>'
  assert.equal(previewPolicies(embedded).example?.description, 'satisfies Readonly<Record<string, FlowPolicy>>')
  assert.throws(() => previewPolicies('export const OTHER = {}'), /Expected TEAM_START_POLICIES as a JSON object literal.*restore that declaration/)
  assert.throws(() => previewPolicies('export const TEAM_START_POLICIES = { broken } satisfies Readonly<Record<string, FlowPolicy>>'), /literal is not valid JSON/)
  assert.throws(() => previewPolicies('export const TEAM_START_POLICIES = [] satisfies Readonly<Record<string, FlowPolicy>>'), /Expected TEAM_START_POLICIES as a JSON object literal/)
})
