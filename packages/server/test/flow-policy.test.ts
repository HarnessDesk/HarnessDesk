import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentEntry } from '@harnessdesk/protocol'

import { compileFlowPolicy, parseFlowPolicy, serializeFlowPolicy } from '../src/flow-policy.js'

const agent = (id: string, ceiling: 'read' | 'edit' | 'publish' | 'merge' = 'edit'): AgentEntry => ({
  id,
  origin: 'project',
  path: `.harnessdesk/agents/${id}/AGENT.md`,
  digest: `${id}-digest`,
  shadows: [],
  problems: [],
  definition: {
    id,
    name: id,
    ceiling,
    ceilingFrom: 'ceiling',
    answers: ['done'],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'fixture' }],
    brief: `${id} brief`,
  },
})

const source = (role: string) => `
version: 2
name: Policy
roles:
  worker:
${role}
  person:
    kind: person
    outcomes: [done]
seed: { role: worker, title: Work }
rules:
  - { id: handoff, on: worker, when: { every: done }, then: { role: person, title: Review } }
`

const errors = (text: string): readonly string[] => parseFlowPolicy(text).problems.map((one) => `${one.at}: ${one.text}`)

test('specialisation and diversity have one card per list entry', () => {
  const specialisation = parseFlowPolicy(source('    kind: agent\n    uses: [writer, reviewer, tester]'))
  assert.equal(specialisation.document?.format, 'agents')
  const compiled = compileFlowPolicy(specialisation.document!, [agent('writer'), agent('reviewer'), agent('tester')])
  assert.deepEqual(compiled.bindings.map((binding) => [binding.agent.id, binding.seats.length]), [
    ['writer', 0], ['reviewer', 0], ['tester', 0],
  ])

  const diversity = parseFlowPolicy(source('    kind: agent\n    uses: writer\n    seats: [fixture=first, fixture=second]'))
  const diverse = compileFlowPolicy(diversity.document!, [agent('writer')])
  assert.deepEqual(diverse.bindings.map((binding) => [binding.agent.id, binding.seats[0]?.model]), [
    ['writer', 'first'], ['writer', 'second'],
  ])

  const repeated = parseFlowPolicy(source('    kind: agent\n    uses: writer\n    count: 3'))
  assert.equal(compileFlowPolicy(repeated.document!, [agent('writer')]).bindings.length, 3)
})

test('cross products and contradictory counts refuse', () => {
  assert.ok(errors(source('    kind: agent\n    uses: [writer, reviewer]\n    seats: [fixture=one, fixture=two]')).some((one) => /Choose a list/.test(one)))
  assert.ok(errors(source('    kind: agent\n    uses: [writer, reviewer]\n    count: 1')).some((one) => /Count must match/.test(one)))
  assert.ok(errors(source('    kind: agent\n    uses: writer\n    count: 0')).some((one) => /must be a whole/i.test(one)))
  assert.ok(errors(source('    kind: agent\n    uses: writer\n    count: 1.5')).some((one) => /must be a whole/i.test(one)))
})

test('generation detection never chooses a permission by precedence', () => {
  for (const fields of [
    '    kind: agent\n    uses: writer\n    permission: publish',
    '    kind: agent\n    seat: fixture\n    grant: edit',
  ]) {
    const found = errors(source(fields))
    assert.ok(found.some((one) => /mixes old and new fields/.test(one)), found.join('\n'))
  }
  const mixedRoles = parseFlowPolicy(`
name: Mixed
roles:
  new:
    kind: agent
    uses: writer
  old:
    kind: agent
    seat: fixture
    permission: publish
seed: { role: new, title: Work }
`)
  assert.ok(mixedRoles.problems.some((one) => /mixes old and new Agent roles/.test(one.text)))
})

test('merge grant requires evidence on every entry', () => {
  const merge = source('    kind: agent\n    uses: writer\n    grant: merge')
  assert.ok(errors(merge).some((one) => /merge step needs fresh evidence/.test(one)))
  const guarded = merge
    .replace('seed: { role: worker, title: Work }', 'seed: { role: person, title: Start }')
    .replace('when: { every: done }', 'when: { evidence: [{ check: verify }] }')
  assert.equal(errors(guarded).filter((one) => /merge step needs fresh evidence/.test(one)).length, 0)
})

test('Agent lookup keeps a broken nearer shadow', () => {
  const parsed = parseFlowPolicy(source('    kind: agent\n    uses: writer'))
  const broken = { ...agent('writer'), definition: null, digest: null, problems: [{ level: 'error' as const, at: 'file', text: 'broken project Agent' }] }
  const compiled = compileFlowPolicy(parsed.document!, [broken, agent('writer')])
  assert.equal(compiled.bindings.length, 0)
  assert.ok(compiled.problems.some((one) => /broken project Agent/.test(one.text)))
})

test('hostile YAML stops before Agent lookup', () => {
  const parsed = parseFlowPolicy('version: 2\nname: Bad\nroles: &roles {}\nseed: { role: worker, title: Work }')
  assert.equal(parsed.document, null)
  assert.ok(parsed.problems.some((one) => one.at === 'line 3'))
})

test('serialized policy round-trips without interpreting input text', () => {
  const parsed = parseFlowPolicy(`
version: 2
name: "A {{literal}} policy"
inputs:
  task: { label: "Task", default: "use {{literal}}\\nand punctuation: []" }
roles:
  worker:
    kind: agent
    uses: writer
  person:
    kind: person
    outcomes: [done]
seed: { role: worker, title: "{{task}}" }
rules:
  - id: handoff
    on: worker
    when: { every: done, evidence: [{ check: verify }] }
    then: { role: person, title: "Review {{task}}" }
`)
  assert.equal(parsed.document?.format, 'agents')
  const reread = parseFlowPolicy(serializeFlowPolicy(parsed.document!.flow))
  assert.equal(reread.document?.format, 'agents')
  assert.deepEqual(reread.document!.flow.inputs, parsed.document!.flow.inputs)
  assert.deepEqual(reread.document!.flow.rules, parsed.document!.flow.rules)
})
