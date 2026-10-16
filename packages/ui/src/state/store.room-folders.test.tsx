import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, sessionId, type GoalView, type HostMethodName, type SessionSummary, type TeamState, type WireNotification } from '@harnessdesk/protocol'

import { AppStore } from './store'
import { StoreProvider } from './context'
import { SessionTree, useProjectList } from '../components/SessionTree'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const gone = '/work/deleted-clone'
const live = '/work/kept-clone'
const board = (id: string, root: string, folderGone?: boolean): TeamState => ({
  id, root, folderGone, name: `Team ${id}`, updatedAt: 1, members: [], messaging: true, intents: [], channel: [],
})
const goal = (board: TeamState): GoalView => ({
  goal: { id: board.id, root: board.root, cwd: board.root, sentence: board.name, state: 'open', revision: 1,
    checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, receipt: null },
  board, activity: 'working', waitingOn: [], members: [], receipt: null, problem: null,
})
const changed = (store: AppStore, state: TeamState): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(event: WireNotification): void } }
  transport.handlers.onNotification({ method: 'team/changed', params: { state } })
}
const roots: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => { for (const dispose of roots.splice(0)) dispose(); vi.useRealTimers() })
const paint = () => act(async () => { await vi.advanceTimersByTimeAsync(40) })

async function rig() {
  const store = new AppStore('ws://localhost:0/')
  const views = [goal(board('gone', gone, true)), goal(board('same-root', gone, true)), goal(board('live', live, false))]
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => method === 'goal/list' ? views : null) as never)
  await store.loadGoals()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(() => { act(() => root.unmount()); container.remove() })
  let list: ReturnType<typeof useProjectList>
  const Tree = ({ searching = false }: { searching?: boolean }) => {
    list = useProjectList({ searching })
    return <SessionTree now={2} searching={searching} />
  }
  const render = (searching = false) => act(() => root.render(<StoreProvider store={store}><Tree searching={searching} /></StoreProvider>))
  render()
  return { store, views, container, render, list: () => list! }
}

it('measures room-only roots without session history, hides gone projects and counts each folder once', async () => {
  const { store, list, container } = await rig()
  expect(store.getSnapshot().history).toEqual([])
  expect(store.getSnapshot().foldersGone.has(gone)).toBe(true)
  expect(list().groups.map(group => group.root)).toEqual([live])
  expect(list().gone).toEqual([gone])
  expect(container.querySelector('[data-region="gone-folders"]')?.textContent).toContain('1 folder is gone')
  expect(container.querySelector('[aria-label="Room Team live"]')).not.toBeNull()
})

it('keeps gone rooms reachable when searching, including after Forget, without deleting their Goals', async () => {
  const { store, list, container, render, views } = await rig()
  await act(async () => { await store.forgetFolders([gone]) })
  await paint()
  expect(list().gone).toEqual([])
  expect(list().groups.map(group => group.root)).toEqual([live])
  expect(store.getSnapshot().goals.size).toBe(views.length)
  expect(store.getSnapshot().teams.size).toBe(views.length)
  render(true)
  expect(list().groups.map(group => group.root)).toContain(gone)
  expect(container.querySelector('[aria-label="Room Team gone"]')).not.toBeNull()
})

it('refreshes folder facts from room events and list reloads without extra requests', async () => {
  const { store, list, views } = await rig()
  act(() => changed(store, board('gone', gone, false)))
  expect(store.getSnapshot().foldersGone.has(gone)).toBe(false)
  // All rooms sharing a root receive the same fresh measurement from the host.
  act(() => changed(store, board('same-root', gone, false)))
  await paint()
  expect(store.getSnapshot().foldersGone.has(gone)).toBe(false)
  expect(list().groups.map(group => group.root)).toContain(gone)
  await act(async () => { await store.loadGoals() })
  await paint()
  expect(store.getSnapshot().foldersGone.has(gone)).toBe(true)
  expect(store.getSnapshot().goals.size).toBe(views.length)
  expect(vi.mocked(store.transport.request).mock.calls.every(([method]) => method === 'goal/list')).toBe(true)
})

it('keeps a gone alias out of an existing project even when recent folders remember its resolved path', async () => {
  const { store, list, container } = await rig()
  vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName) => method === 'workspace/recent'
    ? [{ path: live, name: 'kept-clone', lastOpenedAt: 2 }, { path: gone, realPath: live, name: 'deleted-clone', lastOpenedAt: 1 }]
    : null) as never)
  await act(async () => { await store.loadWorkspaces() })
  await paint()
  expect(list().groups.map(group => group.root)).toEqual([live])
  expect(list().gone).toEqual([gone])
  expect(container.querySelector('[aria-label="Room Team gone"]')).toBeNull()
})

it('hides gone Teams filed through a surviving clone with history, but keeps them searchable after Forget', async () => {
  const { store, list, container, render } = await rig()
  const history: SessionSummary[] = [live, gone].map((cwd, index) => ({
    id: sessionId(`clone-${index}`), runtime: runtimeId('agent'), title: `Clone ${index}`, preview: null,
    cwd, status: { type: 'notLoaded' }, createdAt: index + 1, updatedAt: index + 1,
    git: { sha: 'x', branch: 'main', originUrl: 'https://acme.dev/storefront.git' },
    folderGone: cwd === gone,
  }))
  vi.mocked(store.transport.request).mockImplementation((async (method: HostMethodName) => method === 'session/index'
    ? { data: history, nextCursor: null } : null) as never)
  await act(async () => { await store.loadHistory({ reset: true }) })
  await paint()
  expect(list().groups).toHaveLength(1)
  expect(list().groups[0]?.folders).toContain(gone)
  expect(container.querySelector('[aria-label="Room Team live"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Room Team gone"]')).toBeNull()
  expect(list().gone).toEqual([gone])
  await act(async () => { await store.forgetFolders([gone]) })
  await paint()
  expect(list().gone).toEqual([])
  expect(container.querySelector('[aria-label="Room Team gone"]')).toBeNull()
  render(true)
  expect(container.querySelector('[aria-label="Room Team gone"]')).not.toBeNull()
  expect(store.getSnapshot().teams.size).toBe(3)
})
