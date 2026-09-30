import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentEntry } from '@harnessdesk/protocol'

import { compileFlowPolicy, parseFlowPolicy } from '../src/flow-policy.js'
import { rolesAtPredecessor } from '../src/flow-handed.js'

const agent = (id: string): AgentEntry => ({
  id, origin: 'project', path: `.harnessdesk/agents/${id}/AGENT.md`, digest: `${id}-digest`, shadows: [], problems: [],
  definition: {
    id, name: id, ceiling: 'edit', ceilingFrom: 'ceiling', answers: ['done'], produces: ['diff'], skills: [], mcp: [],
    prefer: [{ runtime: 'fixture' }], brief: `${id} brief`,
  },
})

const compiled = (source: string, agents: readonly AgentEntry[]) => {
  const parsed = parseFlowPolicy(source)
  assert.ok(parsed.document, JSON.stringify(parsed.problems))
  const result = compileFlowPolicy(parsed.document!, agents)
  assert.deepEqual(result.problems, [])
  return result
}

test('a role reached through one lane and one named predecessor is marked as may', () => {
  const flow = compiled(`
version: 2
name: Mixed predecessor routes
roles:
  start: { kind: person, outcomes: [one, many] }
  one: { kind: agent, uses: one, isolate: true, grant: edit }
  many: { kind: agent, uses: many, count: 2, isolate: true, grant: edit }
  target: { kind: agent, uses: target, grant: read }
seed: { role: start, title: Start }
rules:
  - { id: start-one, on: start, when: { any: [one] }, then: { role: one, title: One } }
  - { id: start-many, on: start, when: { any: [many] }, then: { role: many, title: Many } }
  - { id: one-target, on: one, when: { every: [done] }, then: { role: target, title: Target } }
  - { id: many-target, on: many, when: { every: [done] }, then: { role: target, title: Target } }
`, [agent('one'), agent('many'), agent('target')])

  assert.equal(rolesAtPredecessor(flow).get('target'), 'may')
})

test('a role whose every rule hands one apart writer keeps the unconditional marker', () => {
  const flow = compiled(`
version: 2
name: All predecessor routes
roles:
  start: { kind: person, outcomes: [one, other] }
  one: { kind: agent, uses: one, isolate: true, grant: edit }
  other: { kind: agent, uses: other, isolate: true, grant: edit }
  target: { kind: agent, uses: target, grant: read }
seed: { role: start, title: Start }
rules:
  - { id: start-one, on: start, when: { any: [one] }, then: { role: one, title: One } }
  - { id: start-other, on: start, when: { any: [other] }, then: { role: other, title: Other } }
  - { id: one-target, on: one, when: { every: [done] }, then: { role: target, title: Target } }
  - { id: other-target, on: other, when: { every: [done] }, then: { role: target, title: Target } }
`, [agent('one'), agent('other'), agent('target')])

  assert.equal(rolesAtPredecessor(flow).get('target'), 'always')
})

test('a trigger again round is a shared-checkout way into its role', () => {
  const flow = compiled(`
version: 2
name: Trigger again predecessor route
roles:
  writer: { kind: agent, uses: writer, isolate: true, grant: edit }
  target: { kind: agent, uses: target, grant: read }
seed: { role: writer, title: Write }
rules:
  - { id: writer-target, on: writer, when: { every: [done] }, then: { role: target, title: Target } }
`, [agent('writer'), agent('target')])

  assert.equal(rolesAtPredecessor(flow, 'target').get('target'), 'may')
})

test('a mixed upstream role keeps its downstream route conditional', () => {
  const flow = compiled(`
version: 2
name: Mixed upstream route
roles:
  start: { kind: person, outcomes: [shared, isolated] }
  writer: { kind: agent, uses: writer, isolate: true, grant: edit }
  upstream: { kind: agent, uses: upstream, grant: edit }
  target: { kind: agent, uses: target, grant: read }
seed: { role: start, title: Start }
rules:
  - { id: start-shared, on: start, when: { any: [shared] }, then: { role: upstream, title: Shared } }
  - { id: start-isolated, on: start, when: { any: [isolated] }, then: { role: writer, title: Isolated } }
  - { id: writer-upstream, on: writer, when: { every: [done] }, then: { role: upstream, title: Isolated } }
  - { id: upstream-target, on: upstream, when: { every: [done] }, then: { role: target, title: Target } }
`, [agent('writer'), agent('upstream'), agent('target')])

  assert.equal(rolesAtPredecessor(flow).get('upstream'), 'may')
  assert.equal(rolesAtPredecessor(flow).get('target'), 'may')
})
