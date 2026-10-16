import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId } from '@harnessdesk/protocol'
import { Menu } from '../design'
import { StoreProvider } from '../state/context'
import { dockViews, terminals } from '../state/workbench'
import { AppStore } from '../state/store'
import { TerminalToggle, TerminalMenuItem, toggleTerminal } from './TerminalToggle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root, store: AppStore
let request: ReturnType<typeof vi.spyOn>, serial: number
beforeEach(async () => {
  vi.stubGlobal('innerWidth', 1440); vi.stubGlobal('innerHeight', 900)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1 })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  store = new AppStore('ws://localhost:0/'); serial = 0
  request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'workspace/open') return { path: '/work/project', name: 'Project', lastOpenedAt: 1 }
    if (method === 'terminal/open') return { terminalId: `fixture-${++serial}`, runtime: runtimeId('fixture') }
    return null
  }) as never)
  await store.selectRuntime(runtimeId('fixture'))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const render = () => act(() => root.render(<StoreProvider store={store}><TerminalToggle /></StoreProvider>))
const press = async () => act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
const button = () => container.querySelector<HTMLButtonElement>('button')!
const calls = (method: string) => request.mock.calls.filter((call: unknown[]) => call[0] === method)
const ready = async () => { await store.openWorkspace('/work/project'); render() }

it('opens the current work terminal only when its folder is available', async () => {
  render(); await press(); expect(calls('terminal/open')).toHaveLength(0)
  await act(async () => store.openWorkspace('/work/project'))
  await press(); expect(calls('terminal/open')).toHaveLength(1)
  expect(button().getAttribute('aria-label')).toBe('Close terminal')
})
it('putting a terminal pane away and back keeps the same process', async () => {
  await ready(); await press()
  const held = terminals(store.getSnapshot().workbench)[0]!
  await press()
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.open).toBe(false)
  expect(terminals(store.getSnapshot().workbench)).toEqual([held])
  expect(calls('terminal/close')).toHaveLength(0)
  await press(); expect(calls('terminal/open')).toHaveLength(1)
  expect(button().getAttribute('aria-label')).toBe('Close terminal')
})
it('the keyboard toggle cannot close another subject’s terminal', async () => {
  await ready()
  await act(async () => store.openDefaultView({ kind: 'room', room: 'team-a' }))
  await press()
  const held = dockViews(store.getSnapshot().workbench.bottom)[0]!
  await act(async () => store.openDefaultView({ kind: 'room', room: 'team-b' }))
  expect(button().getAttribute('aria-label')).toBe('Open terminal')
  await act(async () => toggleTerminal(store))
  expect(calls('terminal/close')).toHaveLength(0)
  expect(calls('terminal/open')).toHaveLength(2)
  expect(dockViews(store.getSnapshot().workbench.bottom)).toContainEqual(held)
  await press()
  expect(calls('terminal/close')).toHaveLength(0)
  expect(terminals(store.getSnapshot().workbench)).toHaveLength(2)
})
it('two presses during allocation keep one process and leave its pane closed', async () => {
  await ready()
  let finish!: (value: unknown) => void
  request.mockImplementation((async (method: string) => method === 'terminal/open' ? new Promise(resolve => { finish = resolve }) : null) as never)
  await press(); expect(button().getAttribute('aria-label')).toBe('Close terminal')
  await press(); expect(button().getAttribute('aria-label')).toBe('Open terminal')
  await act(async () => finish({ terminalId: 'late-pty', runtime: runtimeId('fixture') }))
  expect(calls('terminal/open')).toHaveLength(1)
  expect(calls('terminal/close')).toHaveLength(0)
  expect(terminals(store.getSnapshot().workbench)).toHaveLength(1)
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.open).toBe(false)
})
it('a repeated pending request survives a remounted toggle without allocating twice', async () => {
  await ready()
  let finish!: (value: unknown) => void
  request.mockImplementation((async (method: string) => method === 'terminal/open' ? new Promise(resolve => { finish = resolve }) : null) as never)
  await press(); await press(); await press()
  act(() => root.render(null)); render()
  expect(button().getAttribute('aria-label')).toBe('Close terminal')
  await act(async () => finish({ terminalId: 'kept-pty', runtime: runtimeId('fixture') }))
  expect(calls('terminal/open')).toHaveLength(1)
  expect(terminals(store.getSnapshot().workbench)).toHaveLength(1)
})
it('a folderless page preserves retained processes and omits the menu action', async () => {
  await ready(); await press()
  const before = store.getSnapshot().workbench.bottom
  Object.assign(store.getSnapshot(), { workspace: null })
  Object.assign(store.getSnapshot().workbench.navigation, { current: { kind: 'agents', id: null } })
  act(() => toggleTerminal(store))
  expect(store.getSnapshot().workbench.bottom).toBe(before)
  expect(calls('terminal/close')).toHaveLength(0)
  act(() => root.render(<StoreProvider store={store}><Menu close={() => {}}><TerminalMenuItem close={() => {}} /></Menu></StoreProvider>))
  expect(container.querySelector('[role="menuitemradio"]')).toBeNull()
})
