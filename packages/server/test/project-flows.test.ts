import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { narrower } from '@harnessdesk/protocol'

import { Agents } from '../src/agents.js'
import { builtinAgentRoot, builtinFlowRoot } from '../src/host.js'
import { FlowPreviews } from '../src/flow-preview.js'
import { parseFlowPolicy } from '../src/flow-policy.js'
import { tempDir } from './scratch.js'

const directory = builtinFlowRoot()

test('the repository no longer shadows the shipped writing and comparison shapes', async () => {
  for (const file of ['fix-and-review.yml', 'race.yml']) {
    await assert.rejects(readFile(new URL(`../../../../.harnessdesk/flows/${file}`, import.meta.url), 'utf8'), { code: 'ENOENT' })
  }
})

const projectPreviews = async (): Promise<FlowPreviews> => {
  const catalogue = new Agents({ user: tempDir('hd-project-flows-'), builtin: builtinAgentRoot() })
  const roster = await catalogue.list()
  return new FlowPreviews({
    confine: async () => {},
    now: () => 1,
    agents: async () => roster,
    previewAgent: async (_root, id, _seats, grant) => ({
      id, from: 'prefer', winner: 0, blocked: null,
      ceiling: { level: narrower(roster.find(agent => agent.id === id)!.definition!.ceiling, grant), hold: 'held' },
      candidates: [{ seat: { runtime: id }, label: 'Test Agent', runtimeName: 'Test Agent', state: 'taken', reason: null, fix: null }],
    }),
    providerOf: async runtime => runtime,
  })
}

test('every shipped Flow parses as current and previews with the shipped Agents without problems', async () => {
  const previews = await projectPreviews()
  const files = (await readdir(directory, { recursive: true })).filter(name => /\.ya?ml$/i.test(name))
  assert.ok(files.length > 0)
  for (const file of files) {
    const source = await readFile(join(directory, file), 'utf8')
    const parsed = parseFlowPolicy(source)
    assert.equal(parsed.document?.format, 'agents', file)
    const preview = await previews.preview('/repo', source, { work: 'Build the requested change' })
    assert.deepEqual(preview.problems, [], file)
    assert.ok(preview.token, file)
    if (file === 'comparison.yml') {
      assert.equal(preview.seats.filter(seat => seat.role === 'competitor' && seat.isolate).length, 2)
      assert.equal(preview.commands.length, 1)
      assert.ok(preview.seats.some(seat => seat.role === 'judge' && seat.reviews))
      assert.ok(parsed.document?.flow.roles.some(role => role.kind === 'person'))
    }
    if (file === 'fix-and-review.yml') {
      assert.equal(preview.seats.filter(seat => seat.role === 'reviewer').length, 1)
      assert.ok(parsed.document?.flow.rules.some(rule => rule.on === 'reviewer' && rule.then.role === 'fixer'))
      assert.ok(parsed.document?.flow.roles.some(role => role.kind === 'person'))
    }
  }
})

test('Write and review keeps the fixer as its only publisher', async () => {
  const source = await readFile(join(directory, 'fix-and-review.yml'), 'utf8')
  const parsed = parseFlowPolicy(source)
  assert.deepEqual(parsed.problems, [])
  assert.ok(parsed.document?.format === 'agents')
  const flow = parsed.document.flow
  assert.equal(flow.name, 'Write and review')
  assert.deepEqual(flow.roles.map(role => [role.id, role.kind]), [
    ['fixer', 'agent'], ['reviewer', 'agent'], ['referee', 'person'],
  ])
  assert.equal(flow.rules.map(rule => rule.id).join(','), 'review-it,fix-again,hand-to-the-person')
  const preview = await (await projectPreviews()).preview('/repo', source, { work: 'Fix the retry budget' })
  assert.deepEqual(preview.problems, [])
  assert.ok(preview.token)
  assert.deepEqual(preview.seats.map(seat => [seat.role, seat.index, seat.agent, seat.plan.ceiling?.level]), [
    ['fixer', 0, 'implementer', 'publish'],
    ['reviewer', 0, 'code-reviewer', 'read'],
  ])
})

test('Side by side gives each card of one round its own isolated implementer seat', async () => {
  const source = await readFile(join(directory, 'comparison.yml'), 'utf8')
  const parsed = parseFlowPolicy(source)
  assert.deepEqual(parsed.problems, [])
  assert.ok(parsed.document?.format === 'agents')
  assert.deepEqual(parsed.document.flow.roles.map(role => [role.id, role.kind]), [
    ['competitor', 'agent'], ['verify', 'check'], ['judge', 'agent'], ['referee', 'person'],
  ])
  const preview = await (await projectPreviews()).preview('/repo', source, { work: 'Build the retry budget' })
  assert.deepEqual(preview.problems, [])
  assert.ok(preview.token)
  assert.deepEqual(preview.seats.filter(seat => seat.role === 'competitor')
    .map(seat => [seat.index, seat.agent, seat.isolate, seat.plan.ceiling?.level]), [
    [0, 'implementer', true, 'edit'],
    [1, 'implementer', true, 'edit'],
  ])
  assert.deepEqual(preview.commands.map(command => [command.role, command.run]), [['verify', 'pnpm verify']])
  assert.deepEqual(preview.seats.filter(seat => seat.role === 'judge')
    .map(seat => [seat.index, seat.agent, seat.reviews, seat.plan.ceiling?.level]), [[0, 'judge', true, 'read']])
})

test('version-2 layout positions are carried without changing the execution preview', async () => {
  const source = await readFile(join(directory, 'fix-and-review.yml'), 'utf8')
  const moved = source.replace('x: 40, y: 40', 'x: 900, y: 900')
  const previews = await projectPreviews()
  const plans = []
  for (const [text, position] of [[source, 40], [moved, 900]] as const) {
    const parsed = parseFlowPolicy(text)
    assert.deepEqual(parsed.problems, [])
    assert.ok(parsed.document?.format === 'agents')
    assert.deepEqual(parsed.document.flow.layout, { frontDoor: { order: 0, contexts: ['project'] }, positions: {
      fixer: { x: position, y: position }, reviewer: { x: 300, y: 40 }, referee: { x: 560, y: 40 },
    } })
    const preview = await previews.preview('/repo', text, { work: 'Fix the retry budget' })
    assert.deepEqual(preview.problems, [])
    assert.ok(preview.token)
    const held = await previews.redeem(preview.token, '/repo', text, { work: 'Fix the retry budget' })
    assert.ok(held)
    const { layout, ...execution } = held.compiled.document.flow
    assert.deepEqual(layout, parsed.document.flow.layout)
    plans.push({ execution, bindings: held.compiled.bindings, seats: preview.seats, commands: preview.commands, guards: preview.guards })
  }
  assert.deepEqual(plans[0], plans[1])
})
