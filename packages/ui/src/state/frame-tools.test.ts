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

import { admitFixedTool, supportsFixedTool, conversationToolContext } from './frame-tools'
import { emptyWorkbench } from './workbench'
import { sessionKey, sessionId, runtimeId } from '@harnessdesk/protocol'
test('Conversation admission requires Editor and exactly its live main subject', () => {
  const session = sessionKey(runtimeId('fixture'), sessionId('one'))
  const base = emptyWorkbench(), view = { kind: 'conversation' as const, session }
  const main = { ...base.main, root: { kind: 'pane' as const, id: 'current', view }, focused: 'current' }
  const workbench = { ...base, main }
  expect(toolOf('conversation')).toBe('conversation')
  expect(supportsFixedTool(view)).toBe(false)
  expect(admitFixedTool(workbench, view)).toBeNull()
  expect(admitFixedTool(workbench, view, false, conversationToolContext(workbench, false))).toBeNull()
  const context = conversationToolContext(workbench, true)
  expect(supportsFixedTool(view, [], context)).toBe(true)
  expect(admitFixedTool(workbench, { ...view, session: null }, false, context)).toBeNull()
  expect(admitFixedTool(workbench, { ...view, session: sessionKey(runtimeId('fixture'), sessionId('two')) }, false, context)).toBeNull()
  const admitted = admitFixedTool(workbench, view, false, context)!
  expect(admitted.main).toBe(main)
  expect(admitted.right.root).toBe(workbench.right.root)
  expect(admitted.frameTools[`session:${session}`]).toEqual({ tool: 'conversation', mode: 'conversation', open: true })
})
