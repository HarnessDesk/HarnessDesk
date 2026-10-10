import { expect, it, vi } from 'vitest'
import type { HostMethodName } from '@harnessdesk/protocol'
import { AppStore } from './store'
import { dock, emptyWorkbench, dockViews, rightPanelDrawn } from './workbench'
import '../panels/builtins'

it('retains a saved Run-only cache without drawing Steps before its Team mounts', async () => {
  const store = new AppStore('ws://localhost:0/')
  const workspace = { path: '/work/project', name: 'project', lastOpenedAt: 1 }
  const empty = emptyWorkbench()
  const overview = { ...empty, main: { ...empty.main, root: { kind: 'pane' as const, id: 'team', view: { kind: 'room' as const, room: 'overview-team' } } } }
  const saved = dock(dock(overview, 'right', { kind: 'run-details' }), 'right', { kind: 'run-steps' })
  const requests = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'app/state/get') return { layouts: { [workspace.path]: saved } }
    if (method === 'workspace/recent') return [workspace]
    if (method === 'worktree/list') return []
    return null
  }) as never)

  await store.loadPreferences()
  await store.loadWorkspaces()

  const restored = store.getSnapshot().workbench
  expect(dockViews(restored.right)).toEqual(dockViews(saved.right))
  expect(restored.main.root).toMatchObject({ kind: 'pane', view: { kind: 'room', room: 'overview-team' } })
  expect(rightPanelDrawn(restored)).toBe(false)
  expect(requests.mock.calls.some(([method]) => method === 'session/close' || method === 'terminal/close')).toBe(false)
})

it.each(['right', 'bottom', 'sidebar'] as const)('normalizes a mixed %s cache to right without losing its Run payloads', async area => {
  const store = new AppStore('ws://localhost:0/')
  const workspace = { path: '/work/project', name: 'project', lastOpenedAt: 1 }
  let saved = dock(dock(emptyWorkbench(), area, { kind: 'changes' }), area, { kind: 'agents' })
  saved = dock(dock(saved, area, { kind: 'run-details' }), area, { kind: 'run-steps' })
  const requests = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'app/state/get') return { layouts: { [workspace.path]: saved } }
    if (method === 'workspace/recent') return [workspace]
    if (method === 'worktree/list') return []
    return null
  }) as never)
  await store.loadPreferences()
  await store.loadWorkspaces()
  const restored = store.getSnapshot().workbench
  expect(dockViews(restored.right)).toEqual(dockViews(saved[area]))
  expect(dockViews(restored.bottom)).toEqual([])
  expect(dockViews(restored.sidebar)).toEqual([])
  expect(rightPanelDrawn(restored)).toBe(false)
  expect(requests.mock.calls.some(([method]) => method === 'session/close' || method === 'terminal/close')).toBe(false)
})
