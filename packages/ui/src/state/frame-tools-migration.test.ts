import { expect, test } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'
import type { PaneView } from './layout'
import { dockViews, emptyWorkbench, normalizeFixedWorkbench, readWorkbench, workRailOpen, rightPanelDrawn, type DockStack, type Mounted } from './workbench'
const mount = (id: string, view: PaneView): Mounted => ({ id, view })
const stack = (id: string, views: readonly Mounted[]): DockStack => ({ kind: 'stack', id, views, active: views.at(-1)?.id ?? null })

test('restored split payloads move without replacement or resource release', () => {
  const runtime = runtimeId('fixture')
  const browser = mount('browser-old', { kind: 'browser', profile: 'lane-fixture',
    tabs: [{ id: 'a', url: 'about:blank', title: 'First' }, { id: 'b', url: 'about:blank', title: 'Second' }], active: 'a', driven: 'b' })
  const terminal = mount('pty-old', { kind: 'terminal', terminalId: 'fixture-pty', runtime, cwd: '/repo' })
  const file = mount('file-old', { kind: 'file', path: '/repo/README.md', runtime })
  const activity = mount('events-old', { kind: 'activity' })
  const changes = mount('changes-old', { kind: 'changes' })
  const before = emptyWorkbench()
  const main = { ...before.main, focused: 'team', root: { kind: 'pane' as const, id: 'team', view: { kind: 'room' as const, room: 'fixture-team' } } }
  const legacy = { ...before, main,
    sidebar: { ...before.sidebar, root: stack('sidebar-old', [file]) },
    right: { ...before.right, root: { kind: 'branch' as const, id: 'right-split', direction: 'row' as const, ratio: 0.5,
      first: stack('right-a', [terminal]), second: stack('right-b', [changes]) } },
    bottom: { ...before.bottom, root: { kind: 'branch' as const, id: 'bottom-split', direction: 'column' as const, ratio: 0.5,
      first: stack('bottom-a', [browser]), second: stack('bottom-b', [activity]) } },
  }
  const decoded = readWorkbench(JSON.parse(JSON.stringify(legacy)))
  expect(decoded).not.toBeNull()
  const after = normalizeFixedWorkbench(decoded!).workbench
  expect(dockViews(after.sidebar)).toEqual([])
  expect(after.right.root.kind).toBe('stack')
  expect(after.bottom.root.kind).toBe('stack')
  expect(dockViews(after.bottom)).toEqual([terminal])
  const right = dockViews(after.right)
  for (const expected of [browser, file, activity, changes]) {
    expect(right.find(one => one.id === expected.id)).toEqual(expected)
    expect(after.toolOwners[expected.id]).toBe('team:fixture-team')
  }
  expect(after.toolOwners[terminal.id]).toBe('team:fixture-team')
  expect(after.frameTools['team:fixture-team']).toEqual({ tool: 'terminal', mode: 'terminal', open: true })
  expect(after.focus).toBeNull()
  expect(after.zoom).toBeNull()
})

import { admitFixedTool, revealFixedTool } from './frame-tools'
import { fixedSubject } from './workbench'
test('equal file payloads retain separate subjects and revealing restores the recorded scope', () => {
  const before = emptyWorkbench()
  const file: PaneView = { kind: 'file', path: '/repo/README.md', runtime: runtimeId('fixture') }
  const first = admitFixedTool(before, file)!
  const owner = fixedSubject(first.main)!
  const remembered = first.frameSubjects[owner]!
  const team = { ...first, main: { ...first.main, root: { kind: 'pane' as const, id: 'team', view: { kind: 'room' as const, room: 'fixture-team' } }, focused: 'team' } }
  const second = admitFixedTool(team, file)!
  const mounted = dockViews(second.right)
  expect(mounted).toHaveLength(2)
  expect(new Set(mounted.map(one => second.toolOwners[one.id]))).toEqual(new Set([owner, 'team:fixture-team']))
  const revealed = revealFixedTool(second, mounted[0]!.id)!
  expect(fixedSubject(revealed.main)).toBe(owner)
  expect(revealed.frameSubjects[owner]).toEqual(remembered)
  expect(revealed.frameTools[owner]).toEqual({ tool: 'files', mode: 'file', open: true })
  expect(revealed.toolOwners).toEqual(second.toolOwners)
})

test('migration retains an old docked conversation while normalizing its placement', () => {
  const conversation = mount('conversation-old', { kind: 'conversation', session: 'fixture\u0000retained' as never })
  const before = emptyWorkbench()
  const legacy = { ...before, sidebar: { ...before.sidebar, root: stack('old-sidebar', [conversation]) } }
  const after = normalizeFixedWorkbench(legacy).workbench
  expect(dockViews(after.sidebar)).toEqual([])
  expect(dockViews(after.right).find(one => one.id === conversation.id)).toEqual(conversation)
})

import { emptySnapshot } from './snapshot'
import { tileBrowserWorkbench } from '../lib/browser-tiles'
test('retained docked conversations never draw as a right tool', () => {
  const before = emptyWorkbench()
  const conversation = mount('retained', { kind: 'conversation', session: 'fixture\u0000retained' as never })
  const legacy = { ...before, right: { ...before.right, root: stack('old-right', [conversation]) } }
  const migrated = normalizeFixedWorkbench(legacy).workbench
  const snapshot = { ...emptySnapshot(), workbench: migrated, layout: migrated.main }
  expect(migrated.frameTools).toEqual({})
  expect(dockViews(tileBrowserWorkbench(snapshot).right)).toEqual([])
  expect(dockViews(migrated.right)).toEqual([conversation])
})

test('persisted subject scopes reject a fallback view and mismatched subject key', () => {
  const decoded = readWorkbench({ ...emptyWorkbench(), frameSubjects: {
    'team:missing': { paneId: 'fixture', view: { kind: 'room' } },
    'team:other': { paneId: 'fixture', view: { kind: 'room', room: 'fixture-team' } },
    'team:fixture-team': { paneId: 'fixture', view: { kind: 'room', room: 'fixture-team' } },
  } })!
  expect(Object.keys(decoded.frameSubjects)).toEqual(['team:fixture-team'])
})


test('legacy pure Details selection becomes an open rail without an empty pane', () => {
  const before = admitFixedTool(emptyWorkbench(), { kind: 'changes' })!
  const subject = fixedSubject(before.main)!
  const decoded = readWorkbench({ ...before, frameTools: {
    [subject]: { tool: 'details', mode: 'details', open: true, expanded: true },
  } })!
  const restored = normalizeFixedWorkbench(decoded).workbench
  expect(restored.frameTools[subject]).toEqual({ tool: 'details', mode: 'details', open: false, railOpen: true, expanded: false })
  expect(workRailOpen(restored)).toBe(true)
  expect(rightPanelDrawn(restored)).toBe(false)
  expect(dockViews(restored.right)).toEqual(dockViews(before.right))
  expect(restored.toolOwners).toEqual(before.toolOwners)
})

test.each(['agents', 'plugin', 'run-details'])('legacy pure Details migration preserves explicit %s panes', mode => {
  const before = emptyWorkbench(), subject = fixedSubject(before.main)!
  const intent = { tool: 'details', mode, open: true, railOpen: false, expanded: true }
  expect(readWorkbench({ ...before, frameTools: { [subject]: intent } })!.frameTools[subject]).toEqual(intent)
})


test('legacy Git history selects Changes while preserving its retained payload', () => {
  const before = admitFixedTool(emptyWorkbench(), { kind: 'git', root: '/repo' })!
  const subject = fixedSubject(before.main)!
  const restored = normalizeFixedWorkbench(readWorkbench({ ...before, frameTools: {
    [subject]: { tool: 'activity', mode: 'git', open: true, railOpen: false, expanded: true },
  } })!).workbench
  expect(restored.frameTools[subject]).toEqual({ tool: 'changes', mode: 'git', open: true, railOpen: false, expanded: true })
  expect(dockViews(restored.right)).toEqual(dockViews(before.right))
  expect(restored.toolOwners).toEqual(before.toolOwners)
})


test.each([true, false])('pure Details migration keeps the explicit rail preference %s', railOpen => {
  const before = emptyWorkbench(), subject = fixedSubject(before.main)!
  const intent = { tool: 'details', mode: 'details', open: false, railOpen }
  expect(readWorkbench({ ...before, frameTools: { [subject]: intent } })!.frameTools[subject]).toEqual(intent)
})
