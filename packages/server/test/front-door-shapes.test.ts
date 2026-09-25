import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AgentEntry } from '@harnessdesk/protocol'

import { Agents } from '../src/agents.js'
import { readShapeLayout } from '../src/authoring/model.js'
import { FlowCatalog } from '../src/flow-catalog.js'
import { compileFlowPolicy, parseFlowPolicy } from '../src/flow-policy.js'
import { builtinAgentRoot, builtinFlowRoot } from '../src/host.js'
import { tempDir } from './scratch.js'

/**
 * The front door's six labelled starting points, plus the custom one
 * (`mechanical-contest`), are packaged ordinary files: no hardcoded use case
 * lives in product code, and a person opening the front door on a fresh
 * install sees exactly what these files declare. This is layout metadata
 * only — `layout:` never grants, seats or routes anything, which
 * `readShapeLayout`'s own tests already prove; this file's job is that the
 * six shipped choices actually carry it, with no source checkout, and that
 * every one of them still compiles against the Agents that ship.
 */

const ORDERED: Readonly<Record<string, number>> = {
  'independent-review': 1, 'fan-out': 2, comparison: 3, 'staged-relay': 4, investigation: 5, alignment: 6,
}
const UNORDERED_BUT_LISTED = ['mechanical-contest']
const NO_FRONT_DOOR_METADATA = ['review-pr']

const agentsOf = async (): Promise<readonly AgentEntry[]> => {
  const agents = new Agents({ user: tempDir('hd-front-door-shapes-user-'), builtin: builtinAgentRoot() })
  const ids = (await readdir(builtinAgentRoot(), { withFileTypes: true })).filter((one) => one.isDirectory()).map((one) => one.name)
  const entries: AgentEntry[] = []
  for (const id of ids) {
    const entry = await agents.read(id)
    if (entry) entries.push(entry)
  }
  return entries
}

test('the six labelled starting points carry a distinct order, and mechanical-contest stays a custom one with none', async () => {
  const seen = new Set<number>()
  for (const [id, order] of Object.entries(ORDERED)) {
    const source = await readFile(join(builtinFlowRoot(), `${id}.yml`), 'utf8')
    const parsed = parseFlowPolicy(source)
    assert.equal(parsed.document?.format, 'agents', `${id}: ${JSON.stringify(parsed.problems)}`)
    const layout = readShapeLayout(parsed.document!.flow)
    assert.deepEqual(layout.issues, [], `${id}'s layout is clean`)
    assert.equal(layout.layout.frontDoor?.order, order, `${id} has order ${order}`)
    assert.ok(layout.layout.frontDoor?.contexts?.includes('project'), `${id} starts from a plain project`)
    seen.add(order)
  }
  assert.equal(seen.size, Object.keys(ORDERED).length, 'every order is distinct')

  for (const id of UNORDERED_BUT_LISTED) {
    const source = await readFile(join(builtinFlowRoot(), `${id}.yml`), 'utf8')
    const parsed = parseFlowPolicy(source)
    assert.equal(parsed.document?.format, 'agents')
    const layout = readShapeLayout(parsed.document!.flow)
    assert.deepEqual(layout.issues, [])
    assert.equal(layout.layout.frontDoor?.order, undefined, `${id} names no order — a custom starting point, not one of the six`)
  }

  for (const id of NO_FRONT_DOOR_METADATA) {
    const source = await readFile(join(builtinFlowRoot(), `${id}.yml`), 'utf8')
    const parsed = parseFlowPolicy(source)
    if (parsed.document?.format === 'agents') {
      assert.equal(readShapeLayout(parsed.document.flow).layout.frontDoor, undefined, `${id} carries no front-door metadata`)
    }
  }
})

test('independent review names three specialists — security, performance and API — each a real shipped Agent, at read grant', async () => {
  const source = await readFile(join(builtinFlowRoot(), 'independent-review.yml'), 'utf8')
  const parsed = parseFlowPolicy(source)
  assert.equal(parsed.document?.format, 'agents')
  const specialists = parsed.document!.flow.roles.find((role) => role.id === 'specialists')
  assert.ok(specialists?.kind === 'agent')
  assert.deepEqual(specialists.uses, ['security-reviewer', 'performance-reviewer', 'api-reviewer'])
  assert.equal(specialists.grant, 'read')
  const agents = await agentsOf()
  const compiled = compileFlowPolicy(parsed.document!, agents)
  assert.deepEqual(compiled.problems, [], JSON.stringify(compiled.problems))
  assert.equal(compiled.bindings.filter((binding) => binding.role === 'specialists').length, 3)
})

test('flow/catalog itself surfaces the packaged order and contexts for a real project with no flows of its own', async () => {
  const project = tempDir('hd-front-door-shapes-project-')
  const catalogue = new FlowCatalog({ userRoot: tempDir('hd-front-door-shapes-uflows-'), builtinRoot: builtinFlowRoot(), confine: async () => {} })
  const entries = await catalogue.list(project)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  for (const [id, order] of Object.entries(ORDERED)) {
    const entry = byId.get(id)
    assert.ok(entry, `${id} is listed`)
    assert.equal(entry!.origin, 'builtin')
    assert.equal(entry!.frontDoor?.order, order)
    assert.ok(entry!.frontDoor?.contexts?.includes('project'))
  }
  assert.equal(byId.get('mechanical-contest')?.frontDoor?.order ?? null, null)
})
