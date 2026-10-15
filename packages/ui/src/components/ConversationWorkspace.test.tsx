import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtimeId, sessionId, sessionKey, type HostMethodName, type Session, type WorkspaceEntry } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { SessionTree } from './SessionTree'
import { CommandPalette } from './CommandPalette'
import { App } from '../app/App'

// Keep the app's actual link subscription, without mounting unrelated work tools.
vi.mock('../panels/Workbench', () => ({ Workbench: ({ sidebar }: { sidebar: ReactNode }) => <>{sidebar}</> }))
vi.mock('./Notices', async original => ({ ...await original<object>(), Notices: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AGENT = runtimeId('sample-agent')
const OLD: WorkspaceEntry = { path: '/work/old', name: 'old', lastOpenedAt: 1 }
const TARGET: WorkspaceEntry = { path: '/worktrees/storefront/fix', name: 'fix', lastOpenedAt: 2, repo: { root: '/work/storefront', origin: 'example.com/acme/storefront', worktree: true } }
const SESSION: Session = { id: sessionId('cart'), runtime: AGENT, cwd: TARGET.path, title: 'Repair the cart', createdAt: 1, updatedAt: 2, status: { type: 'idle' }, itemsLoaded: true, turns: [] }
let store: AppStore, container: HTMLDivElement, root: Root
let receiveLink: ((request: { runtime: string; sessionId: string }) => void) | undefined
const host = { close: vi.fn(), chooseFolder: vi.fn(), openSettings: vi.fn(), openUsage: vi.fn(), openAgents: vi.fn(), openTeams: vi.fn(), openFrontDoor: vi.fn() }
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { status: 'open', workspace: OLD, workspaces: [OLD], history: [SESSION] })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'session/read' || method === 'session/resume') return SESSION
    if (method === 'workspace/open') return TARGET
    if (method === 'workspace/recent') return [OLD, TARGET]
    if (method === 'session/index') return { data: [SESSION], nextCursor: null }
    if (method === 'app/state/get') return {}
    if (method === 'worktree/list' || method === 'agent/list' || method === 'agent/seat/dry' || method === 'flow/catalog') return []
    return null
  }) as never)
  window.harnessdesk = { platform: 'fixture', onShortcut: () => () => {}, openExternal: () => {}, setTitle: () => {}, onOpenSession: handler => { receiveLink = handler; return () => { receiveLink = undefined } } }
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete window.harnessdesk })
const mount = (children: ReactNode) => act(async () => root.render(<StoreProvider store={store}>{children}</StoreProvider>))
const assertTarget = async () => {
  await vi.waitFor(() => expect(store.getSnapshot().workspace?.path).toBe(TARGET.path))
  expect(store.getSnapshot().activeSessionKey).toBe(sessionKey(AGENT, SESSION.id))
  expect(vi.mocked(store.transport.request).mock.calls.filter(([method]) => method === 'workspace/open').map(([, params]) => params)).toEqual([{ path: TARGET.path }])
}
it('the sidebar opens the conversation folder even when its repository is not open', async () => {
  await mount(<SessionTree now={3} />)
  const row = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Repair the cart'))!
  expect(row).toBeDefined()
  await act(async () => row.click())
  await assertTarget()
})
it('the command palette opens the same conversation folder', async () => {
  await mount(<CommandPalette host={host} />)
  const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Repair the cart'))!
  expect(row).toBeDefined()
  await act(async () => row.click())
  await assertTarget()
})
it('an app conversation link opens the same folder', async () => {
  await mount(<App />)
  expect(receiveLink).toBeDefined()
  await act(async () => receiveLink!({ runtime: AGENT, sessionId: SESSION.id }))
  await assertTarget()
})
