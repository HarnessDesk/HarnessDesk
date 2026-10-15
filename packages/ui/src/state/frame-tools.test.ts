import { expect, test } from 'vitest'
import { chooseTool, readToolIntents, setToolOpen, toolOf } from './frame-tools'
import { toggleWorkRail, swapWorkPane, workRailOpen, workPaneExpanded } from './workbench'

test('the rail is independent of the selected pane and remembered per subject', () => {
  const before = emptyWorkbench()
  expect(workRailOpen(before)).toBe(true)
  const hidden = toggleWorkRail(before)
  expect(workRailOpen(hidden)).toBe(false)
  expect(hidden.frameTools[Object.keys(hidden.frameTools)[0]!]?.open).toBe(false)
  const subject = Object.keys(hidden.frameTools)[0]!
  const chosen = chooseTool(hidden.frameTools[subject], 'changes')
  expect(chosen.railOpen).toBe(false)
  expect(chooseTool(chosen, 'changes', 'changes', true).railOpen).toBe(false)
  expect(workRailOpen({ ...hidden, main: { ...hidden.main, focused: 'other', root: { kind: 'pane', id: 'other', view: { kind: 'conversation', session: null } } } })).toBe(true)
})

test('swapping a pane preserves its subject, payloads and rail preference', () => {
  const before = admitFixedTool(toggleWorkRail(emptyWorkbench()), { kind: 'changes' })!
  const swapped = swapWorkPane(before)
  expect(workPaneExpanded(swapped)).toBe(true)
  expect(swapped.main).toBe(before.main)
  expect(swapped.right).toBe(before.right)
  expect(swapped.toolOwners).toBe(before.toolOwners)
  expect(workRailOpen(swapped)).toBe(false)
  expect(workPaneExpanded(swapWorkPane(swapped))).toBe(false)
  const subject = Object.keys(swapped.frameTools)[0]!
  expect(chooseTool(swapped.frameTools[subject], 'changes', 'changes', true).expanded).toBe(false)
})

test('rail and swap preferences survive reading valid pane intents', () => {
  expect(readToolIntents({ subject: { tool: 'files', mode: 'files', open: true, railOpen: false, expanded: true } })).toEqual({
    subject: { tool: 'files', mode: 'files', open: true, railOpen: false, expanded: true },
  })
  expect(toolOf('terminal')).toBe('terminal')
})

test('Editor reload retains its prior expanded pane, rail preference and cached mount', () => {
  const stored = { subject: {
    tool: 'conversation', mode: 'conversation', open: true, railOpen: true,
    beforeEditor: { tool: 'files', mode: 'file', open: true, railOpen: false, expanded: true, mount: 'prior-file' },
  } }
  expect(readToolIntents(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
})

test('a terminal tool retains the process cache and reveals its captured subject', () => {
  const before = emptyWorkbench()
  const admitted = admitFixedTool(before, { kind: 'terminal', terminalId: 'fixture-pty', runtime: runtimeId('fixture'), cwd: '/repo' })!
  expect(admitted.right.root).toBe(before.right.root)
  const held = admitted.bottom.root.kind === 'stack' ? admitted.bottom.root.views[0]! : null
  expect(held?.view.kind).toBe('terminal')
  const other = { ...admitted, main: { ...admitted.main, root: { kind: 'pane' as const, id: 'other', view: { kind: 'conversation' as const, session: null } }, focused: 'other' } }
  const restored = revealFixedTool(other, held!.id)!
  expect(restored.main).toEqual(admitted.main)
  expect(restored.frameTools[Object.keys(admitted.frameTools)[0]!]?.tool).toBe('terminal')
})
test('every historical tool has one fixed destination', () => {
  expect(['run-details', 'agents', 'plugin'].map(kind => toolOf(kind))).toEqual(['details', 'details', 'details'])
  expect(['file', 'preview', 'changes'].map(kind => toolOf(kind))).toEqual(['files', 'files', 'changes'])
  expect(['activity', 'trajectory', 'tasks'].map(kind => toolOf(kind))).toEqual(['activity', 'activity', 'activity'])
  expect(toolOf('git')).toBe('changes')
  expect(toolOf('browser')).toBe('browser')
  expect(toolOf('terminal')).toBe('terminal')
  expect(toolOf('run-steps')).toBeNull()
})
test('only a toggle request closes a selected tool; reveal and subject memories are independent', () => {
  const first = chooseTool(undefined, 'details', 'run-details', false)
  expect(chooseTool(first, 'details', 'run-details', false).open).toBe(true)
  expect(chooseTool(first, 'details', 'run-details', true).open).toBe(false)
  expect(setToolOpen(first, false)).toEqual({ ...first, open: false })
})

import { admitFixedTool, revealFixedTool, supportsFixedTool, conversationToolContext } from './frame-tools'
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
