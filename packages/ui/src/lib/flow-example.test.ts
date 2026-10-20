import { expect, it } from 'vitest'
import { flowModel } from './flow-model'
import { emptyShapePolicy } from './shapes'
import { examplePaths, exampleFrame } from './flow-example'

const policy = { ...emptyShapePolicy(), seed: { role: 'build', title: 'Task' }, budget: { rounds: 7, withoutProgress: 2 }, roles: [
  { id: 'build', kind: 'agent' as const, grant: 'edit' as const, uses: [], seats: [], isolate: false, independentOf: [] },
  { id: 'review', kind: 'agent' as const, grant: 'read' as const, uses: [], seats: [], isolate: false, independentOf: [] },
  { id: 'person', kind: 'person' as const, outcomes: ['merged'] },
], rules: [
  { id: 'review', on: 'build', then: { role: 'review', title: 'Read' } },
  { id: 'repair', on: 'review', when: { any: ['request-changes'] }, then: { role: 'build', title: 'Repair' } },
  { id: 'handoff', on: 'review', when: { every: ['approve'] }, then: { role: 'person', title: 'Choose' } },
] }
it('derives finite paths including a return and a later handoff from policy rules', () => {
  const model = flowModel(policy)
  const paths = examplePaths(model, 7)
  expect(paths.some(path => path.rules.join(',') === 'review,repair,review,handoff')).toBe(true)
  expect(paths.every(path => path.steps.length <= 7)).toBe(true)
  expect(paths.flatMap(path => path.rules).every(id => model.rules.some(rule => rule.id === id))).toBe(true)
})
it('projects a separate example with person pause and only the current handoff moving', () => {
  const model = flowModel(policy), path = examplePaths(model, 7).find(path => path.rules.length === 4)!
  const frame = exampleFrame(model, path, 4)
  expect(frame.person).toBe(true)
  expect(frame.overlay.steps.get('person')?.state).toBe('waiting')
  expect([...frame.overlay.rules.values()].filter(rule => rule.current)).toHaveLength(1)
  expect(frame.overlay.rules.get('review')?.count).toBe(2)
  expect(exampleFrame(model, path, 5).complete).toBe(true)
})
it('describes an unguarded handoff without inventing approval', () => {
  const model = flowModel(policy), frame = exampleFrame(model, examplePaths(model, 7)[0]!, 1)
  expect(frame.rule?.when).toBe('Whatever the outcome')
  expect(frame.overlay.steps.get('build')?.line).toBeNull()
})
