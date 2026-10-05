import { describe, expect, it } from 'vitest'
import type { FlowAgentRole, FlowPolicy, FlowPolicyRule } from '@harnessdesk/protocol'
import { emptyShapePolicy } from '../shapes'
import {
  addStep, connectSteps, createDocument, deleteRule, deleteStep, documentGraph, documentPolicy,
  moveStep, renameRule, renameStep, setRuleCondition, setRuleWord, setSeat, setAgent,
  createHistory, editHistory, undo, redo, builderFacts, builderProblems,
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
    expect(next.policy.rules.slice(1).map((one) => one.when)).toEqual([{ every: ['published'] }, { every: ['failed'] }])
    const id = next.rules[1]!.id
    const condition = { any: ['approve'], every: ['published'], evidence: [{ ci: 'green' as const }] }
    const guarded = setRuleCondition(next, id, condition)
    const changed = setRuleWord(guarded, id, 'repaired', 'any')
    expect(changed.policy.rules[1]!.when).toEqual({ any: ['repaired'], evidence: [{ ci: 'green' }] })
    expect(setRuleWord(changed, id, null).policy.rules[1]!.when).toEqual({ evidence: [{ ci: 'green' }] })
    expect(setRuleCondition(changed, id, undefined).policy.rules[1]!.when).toBeUndefined()
    expect(() => connectSteps(next, a, next.notes[0]?.id ?? 'unknown')).toThrow(/step/i)
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
    ] })
    const deleted = deleteStep(document, document.steps[0]!.id)
    expect(deleted.policy.rules.map((one) => one.id)).toEqual(['remaining'])
    expect(deleted.policy.roles[0]).toMatchObject({ independentOf: [] })
    // Removing the seed never guesses a new entry point; the advisory names the missing seed.
    expect(deleted.policy.seed).toBe(document.policy.seed)
    expect(builderProblems(deleted).some((one) => one.kind === 'missing-seed')).toBe(true)
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

  it('edits and deletes a note without creating a rule or an executable role', () => {
    const document = addStep(doc(), 'note', 'Remember this')
    const id = document.notes[0]!.id
    const renamed = renameStep(document, id, 'New note')
    const moved = moveStep(renamed, id, { x: 600, y: 50 })
    expect(moved.notes[0]).toEqual({ id, text: 'New note', position: { x: 600, y: 50 } })
    expect(moved.policy.roles).toBe(document.policy.roles)
    expect(() => connectSteps(moved, moved.steps[0]!.id, id)).toThrow(/step/i)
    expect(deleteStep(moved, id).notes).toEqual([])
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
