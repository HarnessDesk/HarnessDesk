import { expect, test } from 'vitest'
import { chooseTool, setToolOpen, toolOf } from './frame-tools'
test('every historical tool has one fixed destination', () => {
  expect(['run-details', 'agents', 'plugin'].map(kind => toolOf(kind))).toEqual(['details', 'details', 'details'])
  expect(['file', 'preview', 'changes'].map(kind => toolOf(kind))).toEqual(['changes', 'changes', 'changes'])
  expect(['activity', 'trajectory', 'tasks', 'git'].map(kind => toolOf(kind))).toEqual(['activity', 'activity', 'activity', 'activity'])
  expect(toolOf('browser')).toBe('browser')
  expect(toolOf('terminal')).toBeNull()
  expect(toolOf('run-steps')).toBeNull()
})
test('only a toggle request closes a selected tool; reveal and subject memories are independent', () => {
  const first = chooseTool(undefined, 'details', 'run-details', false)
  expect(chooseTool(first, 'details', 'run-details', false).open).toBe(true)
  expect(chooseTool(first, 'details', 'run-details', true).open).toBe(false)
  expect(setToolOpen(first, false)).toEqual({ ...first, open: false })
})
