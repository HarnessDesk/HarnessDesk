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
    mcp: [],
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

test('v2 checks keep the ordinary pass-at-zero default and reject mixed forms', () => {
  const parsed = parseFlowPolicy(`
version: 2
name: Check
roles:
  verify:
    kind: check
    run: pnpm test
  person:
    kind: person
    outcomes: [done]
seed: { role: verify, title: Verify }
`)
  assert.equal(parsed.document?.format, 'agents')
  const check = parsed.document!.flow.roles.find((role) => role.kind === 'check')
  assert.deepEqual(check?.kind === 'check' ? check.check : null, {
    run: 'pnpm test', timeout: 900, exits: { 0: 'pass' }, otherwise: 'fail',
  })
  const mixed = parseFlowPolicy(`
version: 2
name: Check
roles:
  verify:
    kind: check
    check: { run: pnpm test }
    run: pnpm lint
seed: { role: verify, title: Verify }
`)
  assert.ok(mixed.problems.some((one) => /nested check or flat check/.test(one.text)))
  const unknown = parseFlowPolicy(`
version: 2
name: Check
roles:
  verify:
    kind: check
    check: { run: pnpm test, messages: leaked }
seed: { role: verify, title: Verify }
`)
  assert.ok(unknown.problems.some((one) => /messages.*not read here/.test(one.text)))
})

test('independence names a preceding Agent path and rules use every possible Agent answer', () => {
  const parsed = parseFlowPolicy(`
version: 2
name: Independent
roles:
  writer:
    kind: agent
    uses: writer
  judge:
    kind: agent
    uses: [judge, alternate]
    independentOf: [writer]
  person:
    kind: person
seed: { role: judge, title: Judge }
rules:
  - { on: judge, when: { every: approve }, then: { role: person, title: Decide } }
`)
  assert.ok(parsed.problems.some((one) => /no predecessor path/.test(one.text)))

  const connected = parseFlowPolicy(`
version: 2
name: Independent
roles:
  writer:
    kind: agent
    uses: writer
  judge:
    kind: agent
    uses: [judge, alternate]
    independentOf: [writer]
  person:
    kind: person
seed: { role: writer, title: Write }
rules:
  - { on: writer, then: { role: judge, title: Judge } }
  - { on: judge, when: { every: approve }, then: { role: person, title: Decide } }
`)
  const compiled = compileFlowPolicy(connected.document!, [
    agent('writer'), { ...agent('judge'), definition: { ...agent('judge').definition!, answers: ['approve'] } },
    { ...agent('alternate'), definition: { ...agent('alternate').definition!, answers: ['request-changes'] } },
  ])
  assert.ok(compiled.problems.some((one) => /alternate never answers "approve"/.test(one.text)))
})

test('hostile v2 source is refused before a policy can compile', () => {
  const manyRules = Array.from({ length: 257 }, (_value, index) =>
    `  - { id: r${index}, on: worker, then: { role: person, title: Next } }`,
  ).join('\n')
  const base = `
version: 2
name: Boundaries
roles:
  worker:
    kind: agent
    uses: writer
  person:
    kind: person
seed: { role: worker, title: Work }
rules:
${manyRules}
`
  assert.ok(parseFlowPolicy(base).problems.some((one) => /at most 256 rules/.test(one.text)))
  assert.ok(parseFlowPolicy(base.replace('rules:', 'messages: nope\nrules:')).problems.some((one) => /not read here/.test(one.text)))
  assert.ok(parseFlowPolicy(base.replace('    uses: writer', '    uses: writer\n    count: 33')).problems.some((one) => /whole number from 1 to 32/.test(one.text)))
  assert.ok(parseFlowPolicy('version: 2\nname: Broken\nroles: &roles {}').problems.some((one) => one.at === 'line 3'))
  assert.ok(parseFlowPolicy(`version: 2\nname: ${'x'.repeat(256 * 1024)}\nroles: {}`).problems.some((one) => /256 KiB/.test(one.text)))
})

test('policy collections reject non-text members instead of dropping them', () => {
  const collections: readonly (readonly [string, string])[] = [
    ['uses: [writer, 3]', 'roles.person.uses[1]'],
    ['independentOf: [writer, false]', 'roles.person.independentOf[1]'],
    ['outcomes: [done, 3]', 'roles.person.outcomes[1]'],
  ]
  for (const [field, at] of collections) {
    const body = field.startsWith('outcomes')
      ? `    kind: person\n    ${field}`
      : `    kind: agent\n    ${field}`
    const text = source(`    kind: agent\n    uses: writer`).replace('  person:\n    kind: person\n    outcomes: [done]', `  person:\n${body}`)
    const parsed = parseFlowPolicy(text)
    assert.equal(parsed.document, null, field)
    assert.ok(parsed.problems.some((problem) => problem.at === at), field)
  }
  const rule = parseFlowPolicy(source('    kind: agent\n    uses: writer').replace('when: { every: done }', 'when: { every: [done, 3], any: [done, false] }'))
  assert.equal(rule.document, null)
  assert.ok(rule.problems.some((problem) => problem.at === 'rules[0].when.every[1]'))
  assert.ok(rule.problems.some((problem) => problem.at === 'rules[0].when.any[1]'))
  const files = parseFlowPolicy(source('    kind: agent\n    uses: writer').replace('then: { role: person, title: Review }', 'then: { role: person, title: Review, files: [safe, 3] }'))
  assert.equal(files.document, null)
  assert.ok(files.problems.some((problem) => problem.at === 'rules[0].then.files[1]'))
})

test('legacy parsing preserves old meanings and names the compatibility exception', () => {
  const legacy = parseFlowPolicy(`
name: Old
roles:
  writer:
    kind: agent
    seat: fixture=writer
    permission: read
    outcomes: [published]
  verify:
    kind: check
    check: { run: pnpm test, exits: { 0: pass }, otherwise: fail }
seed: { role: writer, title: Write }
`)
  assert.equal(legacy.document?.format, 'legacy')
  assert.equal(legacy.document?.flow.roles.find((role) => role.id === 'writer')?.permission, 'read')
  assert.ok(legacy.problems.some((one) => one.text === 'This flow uses the old format'))
  assert.ok(legacy.problems.some((one) => one.text === 'Old read permission allows editing and committing.'))
})

test('rules must be a list: a scalar, a map or null is a parse error, never an empty list', () => {
  const base = source('    kind: agent\n    uses: writer')
  const rules = '  - { id: handoff, on: worker, when: { every: done }, then: { role: person, title: Review } }\n'
  for (const [label, value] of [['scalar', ' handoff'], ['map', '\n  handoff: { on: worker, then: { role: person, title: Review } }'], ['null', ' null'], ['empty', '']] as const) {
    const parsed = parseFlowPolicy(base.replace(`rules:\n${rules}`, `rules:${value}\n`))
    assert.ok(parsed.problems.some((one) => one.level === 'error' && one.at === 'rules' && /list of rules/.test(one.text)), `${label}: ${JSON.stringify(parsed.problems)}`)
  }
  // An absent collection is still simply no rules.
  const absent = parseFlowPolicy(base.replace(`rules:\n${rules}`, ''))
  assert.equal(absent.problems.filter((one) => one.at === 'rules').length, 0)
  assert.deepEqual(absent.document?.format === 'agents' ? absent.document.flow.rules : null, [])
})

test('when.evidence must be a list: a scalar, a map or null is a parse error, never an empty guard', () => {
  for (const [label, value] of [['scalar', 'verify'], ['map', '{ check: verify }'], ['null', 'null']] as const) {
    const parsed = parseFlowPolicy(source('    kind: agent\n    uses: writer').replace('when: { every: done }', `when: { every: done, evidence: ${value} }`))
    assert.ok(parsed.problems.some((one) => one.level === 'error' && one.at === 'rules[0].when.evidence' && /list of guards/.test(one.text)), `${label}: ${JSON.stringify(parsed.problems)}`)
  }
  const listed = parseFlowPolicy(source('    kind: agent\n    uses: writer').replace('when: { every: done }', 'when: { every: done, evidence: [{ check: verify }] }'))
  assert.equal(listed.problems.filter((one) => one.level === 'error').length, 0)
})

// ------------------------------------------------------------- findings (phase 7)
/*
 * Named addition for the findings ledger: a flow's budget. YAML spells the
 * second key `without-progress`; each is a whole number from 1 to 100; a file
 * that names none keeps no budget in its document — a run started from it
 * freezes the default — and a save writes the budget out explicitly.
 */
test('budget spelling and strict bounds', () => {
  const withBudget = (budget: string) => `${source('    kind: agent\n    uses: writer')}${budget}\n`
  const parsed = parseFlowPolicy(withBudget('budget: { rounds: 5, without-progress: 4 }'))
  assert.equal(parsed.document?.format, 'agents')
  assert.deepEqual(parsed.document!.format === 'agents' ? parsed.document!.flow.budget : null, { rounds: 5, withoutProgress: 4 })
  // Absent: the document says nothing, so a run saved before budgets existed still reads as it was written.
  const plain = parseFlowPolicy(source('    kind: agent\n    uses: writer'))
  assert.equal(plain.document!.format === 'agents' && 'budget' in plain.document!.flow, false)
  // Saved, the budget is written out — the file's own, or the default.
  const saved = serializeFlowPolicy(parsed.document!.format === 'agents' ? parsed.document!.flow : (null as never))
  assert.match(saved, /budget: \{ rounds: 5, without-progress: 4 \}/)
  const defaulted = serializeFlowPolicy(plain.document!.format === 'agents' ? plain.document!.flow : (null as never))
  assert.match(defaulted, /budget: \{ rounds: 3, without-progress: 2 \}/)
  const reread = parseFlowPolicy(defaulted)
  assert.deepEqual(reread.document!.format === 'agents' ? reread.document!.flow.budget : null, { rounds: 3, withoutProgress: 2 })
  // Each bad value is refused at its own key.
  for (const [budget, at] of [
    ['budget: { rounds: 0, without-progress: 2 }', 'budget.rounds'],
    ['budget: { rounds: 1.5, without-progress: 2 }', 'budget.rounds'],
    ['budget: { rounds: 101, without-progress: 2 }', 'budget.rounds'],
    ['budget: { rounds: "3", without-progress: 2 }', 'budget.rounds'],
    ['budget: { rounds: 3, without-progress: 0 }', 'budget.without-progress'],
    ['budget: { rounds: 3, without-progress: 101 }', 'budget.without-progress'],
    ['budget: { rounds: 3, withoutProgress: 2 }', 'budget.withoutProgress'],
    ['budget: { rounds: 3 }', 'budget.without-progress'],
    ['budget: 3', 'budget'],
  ] as const) {
    const refused = errors(withBudget(budget))
    assert.ok(refused.some((one) => one.startsWith(`${at}:`)), `${budget} → ${refused.join(' | ')}`)
    assert.equal(parseFlowPolicy(withBudget(budget)).document, null)
  }
})

test('layout survives without changing compilation', () => {
  const layout = '\nlayout: { frontDoor: { order: 1, contexts: [branch] }, positions: { worker: { x: 12.5, y: -4 } }, foreign: { keep: [1, "two"] } }\n'
  const plain = parseFlowPolicy(source('    kind: agent\n    uses: writer'))
  const laid = parseFlowPolicy(source('    kind: agent\n    uses: writer') + layout)
  assert.equal(laid.document?.format, 'agents')
  const compiledPlain = compileFlowPolicy(plain.document!, [agent('writer')])
  const compiledLaid = compileFlowPolicy(laid.document!, [agent('writer')])
  assert.deepEqual(compiledLaid.bindings, compiledPlain.bindings)
  assert.deepEqual(compiledLaid.problems, compiledPlain.problems)
  const policy = laid.document!.format === 'agents' ? laid.document!.flow : null
  assert.deepEqual(policy?.layout, { frontDoor: { order: 1, contexts: ['branch'] }, positions: { worker: { x: 12.5, y: -4 } }, foreign: { keep: [1, 'two'] } })
  // The reserved subtree comes back whole, foreign siblings included, and still compiles the same.
  const again = parseFlowPolicy(serializeFlowPolicy(policy!))
  assert.deepEqual(again.document!.format === 'agents' ? again.document!.flow.layout : null, policy?.layout)
  assert.deepEqual(compileFlowPolicy(again.document!, [agent('writer')]).bindings, compiledPlain.bindings)
  assert.deepEqual(
    { ...(again.document!.flow as object), layout: undefined },
    { ...(plain.document!.flow as object), layout: undefined, budget: { rounds: 3, withoutProgress: 2 } },
  )
})

test('blindness is a boolean Agent-role policy', () => {
  const role = (extra: string) => parseFlowPolicy(source(`    kind: agent\n    uses: writer${extra}`))
  const blindOf = (parsed: ReturnType<typeof parseFlowPolicy>) =>
    parsed.document?.format === 'agents' ? parsed.document.flow.roles.find((one) => one.id === 'worker') : undefined
  for (const [extra, expected] of [['', undefined], ['\n    blind: true', true], ['\n    blind: false', false]] as const) {
    const parsed = role(extra)
    const worker = blindOf(parsed)
    assert.equal(worker?.kind === 'agent' ? worker.blind : 'missing', expected)
    const reread = parseFlowPolicy(serializeFlowPolicy(parsed.document!.flow as import('@harnessdesk/protocol').FlowPolicy))
    const back = blindOf(reread)
    assert.equal(back?.kind === 'agent' ? back.blind : 'missing', expected)
  }
  for (const bad of ['\n    blind: "false"', '\n    blind: yes', '\n    blind: 0', '\n    blind: [true]']) {
    assert.ok(errors(source(`    kind: agent\n    uses: writer${bad}`)).some((one) => one.startsWith('roles.worker.blind:')), bad)
  }
  const check = errors(source('    kind: agent\n    uses: writer').replace('  person:\n    kind: person\n', '  person:\n    kind: person\n    blind: false\n'))
  assert.ok(check.some((one) => one.startsWith('roles.person.blind:')), check.join(' | '))
  const checkRole = errors(`
version: 2
name: Checked
roles:
  verify: { kind: check, run: "pnpm test", blind: true }
seed: { role: verify, title: Verify }
`)
  assert.ok(checkRole.some((one) => one.startsWith('roles.verify.blind:')), checkRole.join(' | '))
})

test('a round of several cards takes its files from an agreed split, never one shared list (#1015)', () => {
  const flow = (then: string, seed = '{ role: contract, title: Agree }') => `
version: 2
name: Pair
roles:
  contract: { kind: agent, uses: writer }
  dev: { kind: agent, uses: writer, count: 2, isolate: true }
  person: { kind: person, outcomes: [done] }
seed: ${seed}
rules:
  - { id: build, on: contract, when: { every: done }, then: ${then} }
`
  assert.deepEqual(errors(flow('{ role: dev, title: Build, files: [src/**] }')), [
    'rules[0].then.files: all 2 cards of "dev" would own the same paths, and two cards whose paths overlap are never both worked — give each card its own part with split: naming the role that agrees it',
  ])
  assert.deepEqual(errors(flow('{ role: dev, title: Build, split: contract, files: [src/**] }')).slice(0, 1), [
    'rules[0].then.split: a round takes its files from files or from split, not both',
  ])
  assert.deepEqual(errors(flow('{ role: dev, title: Build, split: person }')), [
    'rules[0].then.split: "person" is not an Agent role, so it cannot agree a split',
  ])
  assert.deepEqual(errors(flow('{ role: dev, title: Build, split: dev }')), [
    'rules[0].then.split: "dev" never finishes before this rule, so no split of its would be recorded yet',
  ])
  assert.deepEqual(errors(flow('{ role: dev, title: Build }', '{ role: contract, title: Agree, split: dev }')), [
    'seed.split: the seed opens the first round, so no round before it can have agreed a split',
  ])
  // One card may own one list, and a split reads back exactly as written.
  assert.deepEqual(errors(flow('{ role: person, title: Check, files: [src/**] }')), [])
  const parsed = parseFlowPolicy(flow('{ role: dev, title: Build, split: contract }'))
  assert.deepEqual(parsed.problems, [])
  const again = parseFlowPolicy(serializeFlowPolicy(parsed.document!.format === 'agents' ? parsed.document!.flow : (null as never)))
  assert.equal(again.document?.format === 'agents' ? again.document.flow.rules[0]!.then.split : null, 'contract')
})
