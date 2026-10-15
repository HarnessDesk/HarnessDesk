import { expect, test } from 'vitest'
import { groupRunSteps } from './run-step-groups'

test('only equivalent finished neighbors fold, selection data is retained', () => {
  const rows = [
    { id: 'r1', step: 'review', state: 'done', signature: 'same' },
    { id: 'r2', step: 'review', state: 'done', signature: 'same' },
    { id: 'r3', step: 'review', state: 'working', signature: 'same' },
    { id: 'r4', step: 'review', state: 'done', signature: 'different' },
  ]
  const groups = groupRunSteps(rows)
  expect(groups.map(group => group.map(row => row.id))).toEqual([['r1', 'r2'], ['r3'], ['r4']])
  expect(groups[0]?.[1]).toBe(rows[1])
})

test('different steps, outcomes and nonconsecutive equal results remain separate', () => {
  const rows = [
    { id: 1, step: 'review', state: 'done', signature: 'passed 12 checks' },
    { id: 2, step: 'review', state: 'done', signature: 'passed 13 checks' },
    { id: 3, step: 'write', state: 'done', signature: 'passed 13 checks' },
    { id: 4, step: 'review', state: 'done', signature: 'passed 12 checks' },
  ]
  expect(groupRunSteps(rows).map(group => group.map(row => row.id))).toEqual([[1], [2], [3], [4]])
})

test.each(['working', 'failed', 'incomplete', 'attention', 'blocked'])('%s rounds do not fold', state => {
  const row = { step: 'review', state, signature: 'same' }
  expect(groupRunSteps([row, row])).toEqual([[row], [row]])
})
