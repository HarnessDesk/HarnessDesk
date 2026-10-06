import { expect, it, vi } from 'vitest'
import type { HostMethodName } from '@harnessdesk/protocol'
import { AppStore } from './store'
import { dock, emptyWorkbench, dockViews } from './workbench'
import '../panels/builtins'

it('restores a Run-only dock collapsed before the Team mounts', async () => {
  const store = new AppStore('ws://localhost:0/')
  const workspace = { path: '/work/project', name: 'project', lastOpenedAt: 1 }
  const empty = emptyWorkbench()
  const overview = { ...empty, main: { ...empty.main, root: { kind: 'pane' as const, id: 'team', view: { kind: 'room' as const, room: 'overview-team' } } } }
  const saved = dock(dock(overview, 'right', { kind: 'run-details' }), 'right', { kind: 'run-steps' })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'app/state/get') return { layouts: { [workspace.path]: saved } }
    if (method === 'workspace/recent') return [workspace]
    if (method === 'worktree/list') return []
    return null
  }) as never)

  await store.loadPreferences()
  await store.loadWorkspaces()

  expect(dockViews(store.getSnapshot().workbench.right).map(one => one.view.kind)).toEqual(['run-details', 'run-steps'])
  expect(store.getSnapshot().workbench.main.root).toMatchObject({ kind: 'pane', view: { kind: 'room', room: 'overview-team' } })
  expect(store.getSnapshot().workbench.right.collapsed).toBe(true)
})

it.each(['right', 'bottom', 'sidebar'] as const)('removes saved Run tabs from a mixed %s dock before the Team mounts', async area => {
  const store = new AppStore('ws://localhost:0/')
  const workspace = { path: '/work/project', name: 'project', lastOpenedAt: 1 }
  let saved = dock(dock(emptyWorkbench(), area, { kind: 'changes' }), area, { kind: 'agents' })
  saved = dock(dock(saved, area, { kind: 'run-details' }), area, { kind: 'run-steps' })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'app/state/get') return { layouts: { [workspace.path]: saved } }
    if (method === 'workspace/recent') return [workspace]
    if (method === 'worktree/list') return []
    return null
  }) as never)
  await store.loadPreferences()
  await store.loadWorkspaces()
  const restored = store.getSnapshot().workbench[area]
  expect(dockViews(restored).map(one => one.view.kind)).toEqual(['changes', 'agents'])
  expect(restored.collapsed).toBe(false)
})
