import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_FLOW_BUDGET, DEFAULT_TRIGGER_BUDGET, type AgentEntry, type FlowPolicy, type TriggerDefinition } from '@harnessdesk/protocol'

import { parseAgentDefinition } from '../src/agent-def.js'
import { editAgentSource, readShapeLayout, shapeLayout, writeShape, writeTriggers } from '../src/authoring/model.js'
import { compileFlowPolicy, parseFlowPolicy } from '../src/flow-policy.js'
import { AGAIN_TITLE, parseTriggers } from '../src/intake/definition.js'

const AGENT = '---\nname: Reviewer   # shown\ndescription: Reads the change\nceiling: read\nanswers: [approve, changes]\nprefer: ["fixture"]\n---\n\nReview the change.\n'

test('reparse prevents semantic injection', () => {
  const hostile = [
    'a: b',
    'x # y',
    'He said "hi"',
    "it's",
    'ceiling: merge',
    '"quoted" : key',
    '[list]',
    '{ map: 1 }',
    '\\"escaped\\"',
    'ünïcødé — dash',
  ]
  for (const value of hostile) {
    const out = editAgentSource(AGENT, 'reviewer', { key: 'name', value })
    assert.deepEqual(out.issues, [], `${value} should be written`)
    const parsed = parseAgentDefinition(out.source, 'reviewer')
    assert.equal(parsed.agent?.name, value)
    // Nothing else moved: the ceiling a hostile name spells is never a key.
    assert.equal(parsed.agent?.ceiling, 'read')
    assert.deepEqual(parsed.agent?.answers, ['approve', 'changes'])
    assert.equal(parsed.agent?.brief, 'Review the change.')
    assert.ok(out.source.includes('# shown'), 'the comment is kept')
  }
  for (const value of ['line\nceiling: merge', 'tab\there', 'bell\u0007', 'nul\u0000', 'del\u007f', 'lone \uD800 surrogate']) {
    const out = editAgentSource(AGENT, 'reviewer', { key: 'name', value })
    assert.equal(out.source, AGENT, `${JSON.stringify(value)} is refused, not written`)
    assert.ok(out.issues.length > 0)
    assert.ok(out.issues.every((issue) => issue.fix.length > 0))
  }
  const answers = editAgentSource(AGENT, 'reviewer', { key: 'answers', value: ['ok, merge: now', '#tag', ']'] })
  assert.deepEqual(answers.issues, [])
  assert.deepEqual(parseAgentDefinition(answers.source, 'reviewer').agent?.answers, ['ok, merge: now', '#tag', ']'])
  const seats = editAgentSource(AGENT, 'reviewer', {
    key: 'prefer',
    value: [{ runtime: 'fixture', model: 'vendor/model-1', effort: 'high' }, { runtime: 'other', thinking: true }],
  })
  assert.deepEqual(seats.issues, [])
  assert.deepEqual(parseAgentDefinition(seats.source, 'reviewer').agent?.prefer, [
    { runtime: 'fixture', model: 'vendor/model-1', effort: 'high' },
    { runtime: 'other', thinking: true },
  ])
  const ceiling = editAgentSource(AGENT, 'reviewer', { key: 'ceiling', value: 'publish' })
  assert.equal(parseAgentDefinition(ceiling.source, 'reviewer').agent?.ceiling, 'publish')
  const forged = editAgentSource(AGENT, 'reviewer', { key: 'ceiling', value: 'root' as never })
  assert.equal(forged.source, AGENT)
  assert.ok(forged.issues.length > 0)
})

test('a field edit refuses what it cannot keep, with a route to the file', () => {
  const legacy = '---\nname: Old\npermission: read\n---\nBrief.\n'
  const renamed = editAgentSource(legacy, 'old', { key: 'ceiling', value: 'edit' })
  assert.equal(renamed.source, legacy)
  assert.match(renamed.issues[0]!.text, /permission/)
  const block = '---\nname: A\ndescription: >\n  folded\n  text\n---\nBrief.\n'
  const refused = editAgentSource(block, 'a', { key: 'description', value: 'flat' })
  assert.equal(refused.source, block)
  assert.match(refused.issues[0]!.fix, /Open the file/)
  const broken = '---\nname: [unclosed\n---\nBrief.\n'
  assert.equal(editAgentSource(broken, 'a', { key: 'name', value: 'B' }).source, broken)
  const unknownBefore = '---\nname: A\ncolour: blue\n---\nBrief.\n'
  const kept = editAgentSource(unknownBefore, 'a', { key: 'name', value: 'B' })
  assert.deepEqual(kept.issues, [])
  assert.ok(kept.source.includes('colour: blue'))
})

const policy = (layout?: unknown): FlowPolicy => {
  const parsed = parseFlowPolicy([
    'version: 2',
    'name: Review',
    'inputs:',
    '  branch: { label: Branch }',
    '  pr: { label: Pull request }',
    'roles:',
    '  reviewer: { kind: agent, uses: [reviewer], grant: read }',
    '  person: { kind: person, outcomes: [done] }',
    'seed: { role: reviewer, title: "Review {{branch}}" }',
    'rules:',
    '  - { id: handoff, on: reviewer, then: { role: person, title: Decide } }',
    ...(layout === undefined ? [] : [`layout: ${JSON.stringify(layout)}`]),
    '',
  ].join('\n'))
  assert.equal(parsed.document?.format, 'agents', JSON.stringify(parsed.problems))
  return parsed.document!.flow as FlowPolicy
}

const reviewer: AgentEntry = {
  id: 'reviewer', origin: 'project', path: '.harnessdesk/agents/reviewer/AGENT.md', digest: 'd', shadows: [], problems: [],
  definition: { id: 'reviewer', name: 'Reviewer', description: null, ceiling: 'edit', ceilingFrom: 'ceiling', answers: [], produces: [], skills: [], mcp: [], prefer: [{ runtime: 'fixture' }], brief: 'b' },
}

test('context metadata grants nothing', () => {
  const good = {
    frontDoor: { order: 2, contexts: ['branch', 'pull-request'], bindings: [{ input: 'branch', value: 'branch' }, { input: 'pr', value: 'pr' }] },
    positions: { reviewer: { x: 10, y: -20.5 }, person: { x: 300, y: 0 } },
    canvas: { zoom: 2 },
  }
  const read = readShapeLayout(policy(good))
  assert.deepEqual(read.issues, [])
  assert.deepEqual(read.layout, { frontDoor: good.frontDoor, positions: good.positions })
  const plain = compileFlowPolicy({ format: 'agents', flow: policy() }, [reviewer])
  const hostile = [
    { frontDoor: { order: 1, grant: 'merge' } },
    { frontDoor: { ceiling: 'merge', contexts: ['branch'] } },
    { frontDoor: { bindings: [{ input: 'branch', value: 'branch' }, { input: 'branch', value: 'head' }] } },
    { frontDoor: { bindings: [{ input: 'missing', value: 'branch' }] } },
    { frontDoor: { bindings: [{ input: 'branch', value: '$(rm -rf /)' }] } },
    { frontDoor: { contexts: ['branch', 'branch'] } },
    { frontDoor: { contexts: ['shell'] } },
    { positions: { reviewer: { x: 'NaN', y: 0 } } },
    { positions: { reviewer: { x: 10001, y: 0 } } },
    { positions: { nobody: { x: 1, y: 1 } } },
    { positions: { constructor: { x: 1, y: 1 } } },
    { positions: { reviewer: { x: 1, y: 1, grant: 'merge' } } },
    { positions: Object.fromEntries(Array.from({ length: 129 }, (_value, index) => [`r${index}`, { x: 0, y: 0 }])) },
    'a string',
  ]
  for (const layout of hostile) {
    const shaped = policy(layout)
    const result = readShapeLayout(shaped)
    assert.ok(result.issues.length > 0, `${JSON.stringify(layout).slice(0, 80)} should be refused`)
    for (const issue of result.issues) assert.ok(issue.text && issue.fix)
    // The shortcut it spoiled is gone; the flow itself is untouched, and compiles the same.
    assert.equal(JSON.stringify(shapeLayout(shaped)).includes('merge'), false)
    const compiled = compileFlowPolicy({ format: 'agents', flow: shaped }, [reviewer])
    assert.deepEqual(compiled.bindings, plain.bindings)
    assert.deepEqual(compiled.problems, plain.problems)
    assert.deepEqual({ ...shaped, layout: undefined }, { ...policy(), layout: undefined })
  }
})

test('writeShape round-trips through the flow parser or refuses', () => {
  // A save always writes the budget a run would stop at, the default included.
  const shaped = { ...policy({ frontDoor: { order: 1 }, positions: { reviewer: { x: 1, y: 2 } }, foreign: ['kept'] }), budget: DEFAULT_FLOW_BUDGET }
  const written = writeShape(shaped)
  assert.deepEqual(parseFlowPolicy(written).document?.flow, shaped)
  const blind: FlowPolicy = { ...shaped, roles: shaped.roles.map((role) => (role.kind === 'agent' ? { ...role, blind: false } : role)) }
  assert.deepEqual(parseFlowPolicy(writeShape(blind)).document?.flow, blind)
  const files: FlowPolicy = { ...shaped, seed: { ...shaped.seed, files: ['src/a.ts'] } }
  assert.deepEqual(parseFlowPolicy(writeShape(files)).document?.flow, files)
  assert.throws(() => writeShape({ ...shaped, name: 'bell\u0007' }), /written/)
  assert.throws(() => writeShape({ ...shaped, layout: { positions: { reviewer: { x: 1e-9, y: 0 } } } }), /written/)
})

test('writeShape round-trips a shape with no rules yet — a bare "rules:" key is null, not the empty list a fresh draft needs', () => {
  // Found through the front door's own "your own shape" empty draft, which
  // is exactly this: one step, no rules until a person adds one.
  const empty: FlowPolicy = {
    version: 2, name: 'Draft', inputs: [], messaging: 'board-only', wait: 240,
    roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }],
    rules: [],
    seed: { role: 'review', title: 'Go' },
    budget: DEFAULT_FLOW_BUDGET,
  }
  const written = writeShape(empty)
  assert.match(written, /^rules: \[\]$/m)
  assert.deepEqual(parseFlowPolicy(written).document?.flow, empty)
})

const definitions: TriggerDefinition[] = [
  {
    id: 'review-pr', on: { kind: 'pull-request', events: ['opened', 'pushed'] }, opens: { flow: 'review-pr' },
    goal: ['pr'], again: { role: 'reviewer', title: AGAIN_TITLE, detail: null }, dedupe: ['pr', 'head', 'event'],
    concurrency: 2, forks: 'allow', budget: { usd: 2.5, rounds: 4, hours: 0.5, withoutProgress: 1 },
  },
  {
    id: 'triage', on: { kind: 'issue', events: ['labelled'] }, opens: { agent: 'triager' }, goal: ['issue'], again: null,
    dedupe: ['issue', 'event'], concurrency: 1, forks: 'never', budget: DEFAULT_TRIGGER_BUDGET, label: ['agent-ready', 'needs triage'],
  },
  {
    id: 'answer', on: { kind: 'issue', events: ['commented', 'closed'] }, opens: { agent: 'triager' }, goal: ['issue'], again: null,
    dedupe: ['issue', 'event'], concurrency: 1, forks: 'never', budget: DEFAULT_TRIGGER_BUDGET, from: 'collaborators',
  },
  {
    id: 'hourly', on: { kind: 'schedule', events: ['tick'], everyMinutes: 60 }, opens: { flow: 'sweep' }, goal: ['slot'], again: null,
    dedupe: ['slot'], concurrency: 1, forks: 'never', budget: { usd: 10000, rounds: 100, hours: 1 / 60, withoutProgress: 100 },
  },
]

test('trigger output uses intake vocabulary', () => {
  const source = writeTriggers(definitions)
  const parsed = parseTriggers(source)
  assert.deepEqual(parsed.problems, [])
  assert.deepEqual(parsed.definitions, definitions)
  assert.equal(writeTriggers([]), '')
  assert.deepEqual(parseTriggers(writeTriggers([])), { definitions: [], problems: [] })
  const scheduleAgain = { ...definitions[3]!, again: { role: 'reviewer', title: AGAIN_TITLE, detail: null } }
  assert.throws(() => writeTriggers([scheduleAgain]), /again/)
  assert.throws(() => writeTriggers([{ ...definitions[3]!, on: { kind: 'schedule', events: ['tick'], everyMinutes: 0 } }]), /every/)
  assert.throws(() => writeTriggers([{ ...definitions[0]!, again: { role: 'reviewer', title: 'Something else', detail: null } }]), /again/)
  assert.throws(() => writeTriggers([definitions[0]!, definitions[0]!]), /twice/)
})
