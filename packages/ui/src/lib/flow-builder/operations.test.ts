import { describe, expect, it } from 'vitest'
import type { FlowAgentRole, FlowPolicy, FlowPolicyRule } from '@harnessdesk/protocol'
import { emptyShapePolicy, defaultGraphPosition } from '../shapes'
import { FLOW_CARD_H, FLOW_CARD_W, FLOW_ROW_GAP } from '../flow-layout'
import { parseFlowPolicy } from '../../../../server/dist/src/flow-policy.js'
import { writeShape } from '../../../../server/dist/src/authoring/model.js'
import {
  addStep, connectSteps, createDocument, deleteRule, deleteStep, documentGraph, graphDocument, documentPolicy,
  moveStep, renameRule, renameStep, setRuleCondition, setRuleWord, setSeat, setAgent, setSeed,
  setCount, createHistory, editHistory, undo, redo, builderFacts, builderProblems,
} from './index'

const agent = (id: string, over: Partial<FlowAgentRole> = {}): FlowAgentRole => ({ id, kind: 'agent', uses: ['implementer'], seats: [], grant: 'edit', isolate: true, independentOf: [], ...over })
const rule = (id: string, on: string, to: string, over: Partial<FlowPolicyRule> = {}): FlowPolicyRule => ({ id, on, then: { role: to, title: 'Continue', detail: 'Kept', files: ['src/**'] }, ...over })
const policy = (over: Partial<FlowPolicy> = {}): FlowPolicy => ({ ...emptyShapePolicy(), inputs: [{ id: 'task', label: 'Task' }], roles: [agent('build'), { id: 'done', kind: 'person', outcomes: ['done'] }], seed: { role: 'build', title: '{{task}}' }, rules: [rule('to-done', 'build', 'done')], ...over })
const frozen = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const part of Object.values(value)) frozen(part)
  }
  return value
}

// Frozen inputs make accidental writes fail in the operation that introduced them.
const doc = (over: Partial<FlowPolicy> = {}) => frozen(createDocument(policy(over)))
const shippedFlows = import.meta.glob('../../../../server/flows/*.yml', { eager: true, query: '?raw', import: 'default' })
const shippedDocument = (name: string) => {
  const source = shippedFlows[`../../../../server/flows/${name}.yml`] as string
  const parsed = parseFlowPolicy(source)
  if (parsed.document?.format !== 'agents') throw new Error(`Expected ${name} to use Agent roles`)
  return createDocument(parsed.document.flow, source)
}

describe('pure edits', () => {
  it('adds each engine kind, fan-out, and an inert note without inventing a role kind', () => {
    let document = doc()
    for (const kind of ['agent', 'check', 'person', 'agents', 'note'] as const) document = addStep(document, kind, 'New step', { x: 300, y: 400 })
    expect(document.policy.roles.map((role) => role.kind)).toEqual(['agent', 'person', 'agent', 'check', 'person', 'agent'])
    expect(document.policy.roles.at(-1)).toMatchObject({ kind: 'agent', count: 2, uses: [], seats: [] })
    expect(document.notes).toHaveLength(1)
    expect(documentGraph(document).nodes.at(-1)!.data).toMatchObject({ kind: 'note', text: 'New step' })
    expect(createDocument(documentPolicy(document)).notes).toEqual(document.notes)
    expect(new Set(documentGraph(document).nodes.map((node) => node.id)).size).toBe(7)
    expect(new Set(document.policy.roles.map((role) => role.id)).size).toBe(6)
  })

  it('connects with one rule per edge, keeps parallel rules ordered and changes its word independently of evidence', () => {
    const document = doc()
    const a = document.steps[0]!.id
    const b = document.steps[1]!.id
    const next = connectSteps(connectSteps(document, a, b, 'published'), a, b, 'failed')
    expect(next.policy.rules).toHaveLength(3)
    expect(next.policy.rules.slice(0, 2).map((one) => one.when)).toEqual([{ every: ['published'] }, { every: ['failed'] }])
    const id = next.rules[1]!.id
    const condition = { any: ['approve'], every: ['published'], evidence: [{ ci: 'green' as const }] }
    const guarded = setRuleCondition(next, id, condition)
    const changed = setRuleWord(guarded, id, 'repaired', 'any')
    expect(changed.policy.rules[1]!.when).toEqual({ any: ['repaired'], evidence: [{ ci: 'green' }] })
    expect(setRuleWord(changed, id, null).policy.rules[1]!.when).toEqual({ evidence: [{ ci: 'green' }] })
    expect(setRuleCondition(changed, id, undefined).policy.rules[1]!.when).toBeUndefined()
    expect(() => connectSteps(next, a, next.notes[0]?.id ?? 'unknown')).toThrow(/step/i)
    const unconditional = connectSteps(document, a, b)
    expect(unconditional.policy.rules[1]!.when).toBeUndefined()
    expect(builderProblems(unconditional).find((one) => one.kind === 'shadowed')?.rule).toBe(unconditional.rules[1]!.id)
  })

  it('addresses duplicate rule names by canvas index through edit, rename, delete and graph projection', () => {
    const duplicate = doc({ rules: [rule('next', 'build', 'done'), rule('next', 'build', 'missing')] })
    const first = duplicate.rules[0]!
    const second = duplicate.rules[1]!
    expect(builderProblems(duplicate).find((one) => one.kind === 'dangling-rule')?.rule).toBe(second.id)

    const edited = setRuleWord(duplicate, second.id, 'changed')
    expect(edited.policy.rules[0]).toEqual(duplicate.policy.rules[0])
    expect(edited.policy.rules[1]!.when).toEqual({ every: ['changed'] })
    const renamed = renameRule(edited, second.id, 'renamed')
    expect(renamed.policy.rules.map((one) => one.id)).toEqual(['next', 'renamed'])
    expect(renamed.rules[0]).toEqual(first)
    const deleted = deleteRule(renamed, second.id)
    expect(deleted.policy.rules).toEqual([duplicate.policy.rules[0]])
    expect(deleted.rules).toEqual([first])
    expect(documentGraph(deleted).edges).toHaveLength(1)
    expect(graphDocument(deleted, documentGraph(deleted))).toBe(deleted)

    const withRetention = doc({ rules: [rule('same', 'build', 'done'), rule('same', 'build', 'missing')] })
    const afterStepDelete = deleteStep(withRetention, withRetention.steps[1]!.id)
    expect(afterStepDelete.policy.rules).toEqual([withRetention.policy.rules[1]])
    expect(afterStepDelete.rules).toEqual([withRetention.rules[1]])
    expect(documentGraph(afterStepDelete).edges).toHaveLength(1)
    expect(graphDocument(afterStepDelete, documentGraph(afterStepDelete))).toBe(afterStepDelete)
  })

  it('adds an automatic step below overlapping placed cards and writes layout only for deliberate placement', () => {
    const unplaced = addStep(createDocument(emptyShapePolicy()), 'person', 'Done')
    expect(unplaced.policy.layout).toBeUndefined()

    const policy = {
      ...emptyShapePolicy(),
      roles: [...emptyShapePolicy().roles, { id: 'other', kind: 'person' as const, outcomes: ['done'] }],
      layout: { positions: { review: defaultGraphPosition(2), other: { x: 400, y: 40 } } },
    }
    const before = createDocument(policy)
    const added = addStep(before, 'person', 'New')
    const step = added.steps.at(-1)!
    const point = added.positions[step.id]!
    expect(point.y).toBe(defaultGraphPosition(2).y + FLOW_CARD_H + FLOW_ROW_GAP)
    for (const other of before.steps) {
      const placed = before.positions[other.id]!
      const overlaps = point.x < placed.x + FLOW_CARD_W && point.x + FLOW_CARD_W > placed.x
        && point.y < placed.y + FLOW_CARD_H && point.y + FLOW_CARD_H > placed.y
      expect(overlaps).toBe(false)
    }
    expect(added.policy.layout).toEqual(policy.layout)

    const deliberate = addStep(createDocument(emptyShapePolicy()), 'person', 'Placed', { x: 600, y: 300 })
    expect(deliberate.policy.layout).toMatchObject({ positions: { review: expect.any(Object), placed: { x: 600, y: 300 } } })
  })

  it('renames seed, endpoints, isolation predecessors, split providers, positions and exact check-id guards together', () => {
    const document = doc({ roles: [agent('build'), agent('review', { independentOf: ['build'] }), { id: 'verify', kind: 'check', check: { run: 'pnpm test', timeout: 900, exits: { 0: 'pass' }, otherwise: 'fail' } }], rules: [
      rule('to-review', 'build', 'review', { then: { role: 'review', title: 'Review', split: 'build' } }),
      rule('test', 'review', 'verify', { when: { evidence: [{ check: 'verify' }, { check: 'pnpm test' }, { review: 'approve' }] } }),
    ], layout: { positions: { build: { x: 20, y: 30 } }, other: 'kept' } })
    const renamed = renameStep(document, document.steps[0]!.id, 'write')
    expect(renamed.policy.seed.role).toBe('write')
    expect(renamed.policy.roles[1]).toMatchObject({ independentOf: ['write'] })
    expect(renamed.policy.rules[0]).toMatchObject({ on: 'write', then: { split: 'write' } })
    expect(renamed.policy.layout).toEqual({ positions: { write: { x: 20, y: 30 } }, other: 'kept' })
    const checkRenamed = renameStep(renamed, document.steps[2]!.id, 'test')
    expect(checkRenamed.policy.rules[1]!.when?.evidence).toEqual([{ check: 'test' }, { check: 'pnpm test' }, { review: 'approve' }])
    const edgeRenamed = renameRule(checkRenamed, checkRenamed.rules[0]!.id, 'handover')
    expect(edgeRenamed.rules[0]!.id).toBe(document.rules[0]!.id)
    expect(edgeRenamed.policy.rules[0]!.id).toBe('handover')
    expect(() => renameStep(document, document.steps[0]!.id, 'verify')).toThrow(/already/i)
  })

  it('moves one step, bounds coordinates, and never changes execution fields', () => {
    const document = doc()
    const next = moveStep(document, document.steps[0]!.id, { x: 1e9, y: -12.7 })
    expect(next.policy.roles).toBe(document.policy.roles)
    expect(next.policy.rules).toBe(document.policy.rules)
    expect(next.policy.seed).toBe(document.policy.seed)
    expect(documentGraph(next).nodes[0]!.position.y).toBe(-13)
    expect(documentGraph(next).nodes[0]!.position.x).toBeLessThan(1e9)
    expect(moveStep(document, document.steps[0]!.id, { x: NaN, y: 0 })).toBe(document)
  })

  it('deletes a step and dependent rules without broadening guards or leaving split/isolation references', () => {
    const document = doc({ roles: [agent('build'), agent('review', { independentOf: ['build'] }), { id: 'done', kind: 'person', outcomes: ['done'] }], rules: [
      rule('to-review', 'build', 'review'),
      rule('using-split', 'review', 'done', { then: { role: 'done', title: 'Done', split: 'build' } }),
      rule('remaining', 'review', 'done'),
    ], layout: { positions: { build: { x: 10, y: 20 }, review: { x: 200, y: 20 }, done: { x: 400, y: 20 } }, frontDoor: { order: 2 } } })
    const deleted = deleteStep(document, document.steps[0]!.id)
    expect(deleted.policy.rules.map((one) => one.id)).toEqual(['remaining'])
    expect(deleted.policy.roles[0]).toMatchObject({ independentOf: [] })
    // Removing the seed never guesses a new entry point; the advisory names the missing seed.
    expect(deleted.policy.seed).toBe(document.policy.seed)
    expect(builderProblems(deleted).some((one) => one.kind === 'missing-seed')).toBe(true)
    expect((deleted.policy.layout as { positions?: unknown } | undefined)?.positions).toEqual({ review: { x: 200, y: 20 }, done: { x: 400, y: 20 } })
    expect(Object.keys(deleted.positions)).toEqual([document.steps[1]!.id, document.steps[2]!.id])
    expect(deleted.rules).toEqual([document.rules[2]])
    expect(deleted.policy.rules).toEqual([document.policy.rules[2]])
    expect(documentGraph(deleted).edges).toHaveLength(1)
    expect(graphDocument(deleted, documentGraph(deleted))).toBe(deleted)
    expect(deleteRule(document, document.rules[0]!.id).policy.rules).toHaveLength(2)
  })

  it('deletes rules that depend on a removed check by id or command, keeping other evidence intact', () => {
    const document = doc({ roles: [...policy().roles, { id: 'verify', kind: 'check', check: { run: 'pnpm test', timeout: 900, exits: { 0: 'pass' }, otherwise: 'fail' } }], rules: [
      ...policy().rules,
      rule('by-id', 'build', 'done', { when: { evidence: [{ check: 'verify' }, { ci: 'green' }] } }),
      rule('by-command', 'build', 'done', { when: { evidence: [{ check: 'pnpm test' }] } }),
    ] })
    expect(deleteStep(document, document.steps[2]!.id).policy.rules.map((one) => one.id)).toEqual(['to-done'])
  })

  it('sets a seat without altering Agents, count or grants, and clears an override back to Agent preference', () => {
    const document = doc()
    const id = document.steps[0]!.id
    const seat = { runtime: 'demo', model: 'example-model', effort: 'high', thinking: true }
    const next = setSeat(document, id, [seat])
    expect(next.policy.roles[0]).toEqual({ ...document.policy.roles[0], seats: [seat] })
    expect(setSeat(next, id, []).policy.roles[0]).toEqual(document.policy.roles[0])
    expect(setAgent(next, id, ['reviewer']).policy.roles[0]).toMatchObject({ uses: ['reviewer'], seats: [seat] })
    expect(() => setSeat(document, document.steps[1]!.id, [seat])).toThrow(/agent/i)
    expect(document.policy.roles[0]).toMatchObject({ seats: [] })
  })

  it('sets the seed and reconciles fan-out counts with Agent or seat lists', () => {
    const document = doc()
    const seeded = setSeed(document, document.steps[1]!.id)
    expect(seeded.policy.seed).toEqual({ ...document.policy.seed, role: 'done' })
    expect(setSeed(seeded, document.steps[1]!.id)).toBe(seeded)

    const fan = addStep(document, 'agents', 'Fan out')
    const fanId = fan.steps.at(-1)!.id
    const threeAgents = setAgent(fan, fanId, ['a', 'b', 'c'])
    expect(threeAgents.policy.roles.at(-1)).toMatchObject({ count: 3, uses: ['a', 'b', 'c'] })
    expect(() => setCount(threeAgents, fanId, 2)).toThrow(/match/i)
    expect(() => writeShape({ ...threeAgents.policy, roles: threeAgents.policy.roles.map((role, index) => index === threeAgents.policy.roles.length - 1 && role.kind === 'agent' ? { ...role, count: 2 } : role) })).toThrow(/count must match/i)
    expect(() => writeShape(threeAgents.policy)).not.toThrow()

    const twoAgents = setAgent(fan, fanId, ['a', 'b'])
    const seats = [{ runtime: 'demo', model: 'example-a' }, { runtime: 'demo', model: 'example-b' }]
    const both = setSeat(twoAgents, fanId, seats)
    expect(both.policy.roles.at(-1)).toMatchObject({ count: 2, uses: ['a', 'b'], seats })
    expect(() => writeShape(both.policy)).toThrow(/choose a list of agents or a list of seats/i)
  })

  it('keeps an undefined count absent after Agent and seat edits so JSON graph copies remain valid', () => {
    const document = doc()
    const id = document.steps[0]!.id
    const seat = { runtime: 'demo', model: 'example-model' }

    for (const edited of [setSeat(document, id, [seat]), setAgent(document, id, ['reviewer'])]) {
      const copied = JSON.parse(JSON.stringify(documentGraph(edited))) as ReturnType<typeof documentGraph>
      expect(() => graphDocument(edited, copied)).not.toThrow()
    }
  })

  it('preserves shipped one-Agent fan-out widths and exposes an explicit count edit', () => {
    const fanOuts = [
      { flow: 'fan-out', role: 'review', count: 3 },
      { flow: 'comparison', role: 'competitor', count: 2 },
      { flow: 'mechanical-contest', role: 'competitor', count: 2 },
    ]
    const seat = { runtime: 'demo', model: 'example-model' }
    for (const { flow, role, count } of fanOuts) {
      const document = shippedDocument(flow)
      const id = document.steps.find((step) => step.role === role)!.id
      expect(document.policy.roles.find((candidate) => candidate.id === role)).toMatchObject({ count })
      expect(setAgent(document, id, ['replacement']).policy.roles.find((candidate) => candidate.id === role)).toMatchObject({ count })
      expect(setSeat(document, id, []).policy.roles.find((candidate) => candidate.id === role)).toMatchObject({ count })
      expect(setSeat(document, id, [seat]).policy.roles.find((candidate) => candidate.id === role)).toMatchObject({ count })
    }

    const specialists = shippedDocument('review')
    const threeSpecialists = specialists.policy.roles.find((candidate): candidate is FlowAgentRole => (
      candidate.kind === 'agent' && candidate.uses.length === 3
    ))!
    const specialistsId = specialists.steps.find((step) => step.role === threeSpecialists.id)!.id
    expect(setSeat(specialists, specialistsId, [])).toBe(specialists)
    expect(setAgent(specialists, specialistsId, threeSpecialists.uses)).toBe(specialists)

    const document = doc()
    const counted = setCount(document, document.steps[0]!.id, 4)
    expect(counted.policy.roles[0]).toMatchObject({ count: 4 })
    expect(setCount(counted, document.steps[0]!.id, 4)).toBe(counted)
    expect(setCount(counted, document.steps[0]!.id, undefined).policy.roles[0]).not.toHaveProperty('count')
    expect(() => setCount(document, document.steps[0]!.id, 0)).toThrow(/1 to 32/i)
    expect(() => setCount(document, document.steps[0]!.id, 1.5)).toThrow(/whole number/i)
    expect(() => setCount(document, document.steps[0]!.id, 33)).toThrow(/1 to 32/i)
  })

  it('refuses invalid wire identifiers with a useful step or rule message', () => {
    const document = doc()
    expect(() => renameStep(document, document.steps[0]!.id, 'bad name')).toThrow(/build.*letters, digits, - or _/i)
    expect(() => renameRule(document, document.rules[0]!.id, 'bad/name')).toThrow(/to-done.*letters, digits, - or _/i)
    expect(renameStep(document, document.steps[0]!.id, 'Valid_id-2').policy.roles[0]!.id).toBe('Valid_id-2')
    expect(() => renameRule(document, document.rules[0]!.id, 'x'.repeat(65))).toThrow(/64/)
    const duplicates = doc({ rules: [rule('first', 'build', 'done'), rule('second', 'build', 'done')] })
    expect(() => renameRule(duplicates, duplicates.rules[1]!.id, 'first')).toThrow(/already exists/i)
  })

  it('accepts wire-valid free-text answers and refuses empty or overlong answers', () => {
    const answers = ['looks good', 'x'.repeat(65), 'révisé', 'a:b']
    for (const answer of answers) {
      const document = doc()
      const [from, to] = document.steps
      const connected = connectSteps(document, from!.id, to!.id, answer)
      expect(connected.policy.rules.find((candidate) => candidate.when?.every?.includes(answer))?.when).toEqual({ every: [answer] })
      expect(setRuleWord(document, document.rules[0]!.id, answer).policy.rules[0]!.when).toEqual({ every: [answer] })
      expect(setRuleCondition(document, document.rules[0]!.id, { any: [answer] }).policy.rules[0]!.when).toEqual({ any: [answer] })
    }

    for (const answer of ['', '   ', 'x'.repeat(201)]) {
      const document = doc()
      const [from, to] = document.steps
      expect(() => connectSteps(document, from!.id, to!.id, answer)).toThrow(/answer/i)
      expect(() => setRuleWord(document, document.rules[0]!.id, answer)).toThrow(/answer/i)
      expect(() => setRuleCondition(document, document.rules[0]!.id, { every: [answer] })).toThrow(/answer/i)
    }

    const document = doc()
    expect(() => setRuleCondition(document, document.rules[0]!.id, { any: ['looks good', '   '] })).toThrow(/answer/i)
    expect(() => setRuleCondition(document, document.rules[0]!.id, { any: Array.from({ length: 65 }, (_value, index) => `answer-${index}`) })).toThrow(/64/i)
  })

  it('mints digit-only labels as ids that the writer reads back unchanged', () => {
    let document = doc()
    document = addStep(document, 'person', '2024')
    document = addStep(document, 'person', '007')
    expect(document.steps.slice(-2).map((step) => step.role)).toEqual(['step-2024', 'step-007'])

    const source = writeShape(document.policy)
    const parsed = parseFlowPolicy(source)
    expect(parsed.problems.filter((one) => one.level === 'error')).toEqual([])
    if (parsed.document?.format !== 'agents') throw new Error('Expected an Agent-routed Flow')
    expect(parsed.document.flow.roles.slice(-2).map((role) => role.id)).toEqual(['step-2024', 'step-007'])
    expect(writeShape(parsed.document.flow)).toBe(source)
  })

  it('edits and deletes a note without creating a rule or an executable role', () => {
    const document = addStep(doc(), 'note', 'Remember this')
    const id = document.notes[0]!.id
    const renamed = renameStep(document, id, 'New note')
    const moved = moveStep(renamed, id, { x: 600, y: 50 })
    expect(moved.notes[0]).toEqual({ id, text: 'New note', position: { x: 600, y: 50 } })
    expect(moved.policy.roles).toBe(document.policy.roles)
    expect(() => connectSteps(moved, moved.steps[0]!.id, id)).toThrow(/step/i)
    expect(deleteStep(moved, id).notes).toEqual([])
    expect(() => addStep(document, 'note', 'x'.repeat(2001))).toThrow(/2,000/)
    expect(() => renameStep(document, id, 'x'.repeat(2001))).toThrow(/2,000/)
  })

  it('caps note count and refuses notes that would exceed the wire layout limit', () => {
    let document = createDocument(emptyShapePolicy())
    for (let i = 0; i < 128; i += 1) document = addStep(document, 'note', 'N')
    expect(document.notes).toHaveLength(128)
    expect(() => addStep(document, 'note', 'One too many')).toThrow(/128/)

    const notes = Array.from({ length: 32 }, (_value, index) => ({ id: `note-${index + 1}`, text: 'x'.repeat(2000), position: { x: index * 8, y: index * 8 } }))
    const crowded = createDocument({ ...emptyShapePolicy(), layout: { builder: { notes } } })
    expect(() => addStep(crowded, 'note', 'x')).toThrow(/layout.*64/i)

    const colliding = createDocument({ ...emptyShapePolicy(), layout: { builder: { notes: [
      { id: 'note-2', text: 'Existing', position: { x: 20, y: 30 } },
    ] } } })
    expect(addStep(colliding, 'note', 'New').notes.map((note) => note.id)).toEqual(['note-2', 'note-3'])
  })
})

describe('history over pure documents', () => {
  const edits = [
    ['add', (current: ReturnType<typeof createDocument>) => addStep(current, 'person', 'New')],
    ['connect', (current: ReturnType<typeof createDocument>) => connectSteps(current, current.steps[0]!.id, current.steps[1]!.id, 'published')],
    ['condition', (current: ReturnType<typeof createDocument>) => setRuleCondition(current, current.rules[0]!.id, { evidence: [{ ci: 'green' }] })],
    ['word', (current: ReturnType<typeof createDocument>) => setRuleWord(current, current.rules[0]!.id, 'published')],
    ['rename step', (current: ReturnType<typeof createDocument>) => renameStep(current, current.steps[0]!.id, 'write')],
    ['rename rule', (current: ReturnType<typeof createDocument>) => renameRule(current, current.rules[0]!.id, 'handover')],
    ['move', (current: ReturnType<typeof createDocument>) => moveStep(current, current.steps[0]!.id, { x: 300, y: 40 })],
    ['delete step', (current: ReturnType<typeof createDocument>) => deleteStep(current, current.steps[1]!.id)],
    ['delete rule', (current: ReturnType<typeof createDocument>) => deleteRule(current, current.rules[0]!.id)],
    ['seat', (current: ReturnType<typeof createDocument>) => setSeat(current, current.steps[0]!.id, [{ runtime: 'demo' }])],
    ['Agent', (current: ReturnType<typeof createDocument>) => setAgent(current, current.steps[0]!.id, ['reviewer'])],
  ] as const
  for (const [name, edit] of edits) it(`${name}: undo restores the input and redo restores the edit`, () => {
    const initial = createHistory(doc())
    const changed = editHistory(initial, edit)
    expect(changed.present).not.toBe(initial.present)
    expect(undo(changed).present).toBe(initial.present)
    expect(redo(undo(changed)).present).toBe(changed.present)
  })

  it('does not mark equivalent guards or seating as new edits', () => {
    const initial = createHistory(doc({ rules: [rule('to-done', 'build', 'done', { when: { every: ['published'] } })] }))
    expect(editHistory(initial, (current) => setRuleCondition(current, current.rules[0]!.id, { every: ['published'] }))).toBe(initial)
    expect(editHistory(initial, (current) => setSeat(current, current.steps[0]!.id, []))).toBe(initial)
    expect(editHistory(initial, (current) => setAgent(current, current.steps[0]!.id, ['implementer']))).toBe(initial)
    expect(editHistory(initial, (current) => moveStep(current, current.steps[0]!.id, documentGraph(current).nodes[0]!.position))).toBe(initial)
  })

  it('bounds undo history at 200 document snapshots', () => {
    let history = createHistory(doc())
    for (let index = 0; index < 205; index += 1) {
      history = editHistory(history, (current) => moveStep(current, current.steps[0]!.id, { x: index, y: index + 1 }))
    }
    expect(history.past).toHaveLength(200)
  })

  it('undoes and redoes semantic and layout changes, restores original source, and forks after undo', () => {
    const document = createDocument(policy(), '# kept source')
    const id = document.steps[0]!.id
    const initial = createHistory(document)
    const renamed = editHistory(initial, (current) => renameStep(current, id, 'write'))
    const moved = editHistory(renamed, (current) => moveStep(current, id, { x: 20, y: 70 }))
    expect(undo(moved).present).toBe(renamed.present)
    expect(undo(undo(moved)).present).toBe(document)
    expect(redo(redo(undo(undo(moved)))).present).toBe(moved.present)
    expect(undo(initial)).toBe(initial)
    expect(redo(initial)).toBe(initial)
    expect(editHistory(initial, (current) => current)).toBe(initial)
    expect(editHistory(undo(moved), (current) => addStep(current, 'check', 'Verify')).future).toEqual([])
  })
})

describe('advisory problems and header facts', () => {
  it('counts rounds of seats, not person/check nodes or note annotations', () => {
    const document = addStep(doc({ roles: [agent('build', { count: 3 }), agent('review', { uses: ['a', 'b'] }), { id: 'done', kind: 'person', outcomes: ['done'] }] }), 'note', 'A note')
    expect(builderFacts(document)).toEqual({ steps: 3, rules: 1, seats: 5 })
  })

  it('names unreachable components, dangling endpoints and missing Agents without calling the shape valid', () => {
    const document = doc({ roles: [agent('build', { uses: [] }), { id: 'done', kind: 'person', outcomes: ['done'] }, { id: 'stray', kind: 'person', outcomes: ['done'] }], rules: [rule('bad', 'build', 'missing'), rule('loop', 'stray', 'stray'), rule('bad-source', 'nowhere', 'done')] })
    const problems = builderProblems(document)
    expect(problems.filter((one) => one.kind === 'unreachable').map((one) => one.step)).toEqual([document.steps[1]!.id, document.steps[2]!.id])
    expect(problems.filter((one) => one.kind === 'dangling-rule').map((one) => one.rule)).toEqual([document.rules[0]!.id, document.rules[2]!.id])
    expect(problems.find((one) => one.kind === 'unseated')?.step).toBe(document.steps[0]!.id)
    expect(problems.find((one) => one.kind === 'unreachable')?.text).toBe('Nothing reaches this step')
    // An Agent with no explicit seats uses its Agent's preference; that is not an empty seat.
    expect(builderProblems(doc()).some((one) => one.kind === 'unseated')).toBe(false)
  })

  it('does not mistake a shadowed rule for a way to finish', () => {
    const document = doc({ rules: [rule('always', 'build', 'build'), rule('shadowed', 'build', 'done')] })
    expect(builderProblems(document).some((one) => one.kind === 'no-finish')).toBe(true)
    expect(builderProblems(document).find((one) => one.kind === 'shadowed')?.rule).toBe(document.rules[1]!.id)
  })

  it('skips unreachable advisories when the seed is absent and reports a missing layout read', () => {
    const document = doc({ layout: { positions: { gone: { x: 1, y: 2 } } } })
    const deleted = deleteStep(document, document.steps[0]!.id)
    const problems = builderProblems(deleted)
    expect(problems.map((one) => one.kind)).toContain('missing-seed')
    expect(problems.map((one) => one.kind)).not.toContain('unreachable')
    const invalid = createDocument({ ...emptyShapePolicy(), layout: { positions: { gone: { x: 1, y: 2 } } } })
    expect(builderProblems(invalid).some((one) => one.kind === 'layout')).toBe(true)
  })

  it('finds a closed unconditional cycle, but allows a conditional loop to finish on an unmatched answer', () => {
    const loop = doc({ rules: [rule('again', 'build', 'build')] })
    expect(builderProblems(loop).some((one) => one.kind === 'no-finish')).toBe(true)
    const conditional = setRuleWord(loop, loop.rules[0]!.id, 'retry')
    expect(builderProblems(conditional).some((one) => one.kind === 'no-finish')).toBe(false)
    expect(builderProblems(doc()).some((one) => one.kind === 'no-finish')).toBe(false)
    const invalid = doc({ rules: [rule('elsewhere', 'build', 'missing')] })
    expect(builderProblems(invalid).some((one) => one.kind === 'no-finish')).toBe(true)
  })
})
