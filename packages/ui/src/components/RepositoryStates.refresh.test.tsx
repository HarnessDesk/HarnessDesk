import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostMethodName, WorkspaceEntry } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { PlaceControl } from './ComposerControls'
import { WorkspaceMenu } from './WorkspaceMenu'
import { Sidebar } from './Sidebar'
import { CommandPalette } from './CommandPalette'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const PATH = '/work/storefront'
const workspace: WorkspaceEntry = { path: PATH, name: 'storefront', lastOpenedAt: 1,
  git: { branch: 'main', sha: null }, repo: { root: PATH, worktree: false } }
const noop = () => {}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => button.textContent === name || button.getAttribute('aria-label') === name)!

it.each(['composer', 'sidebar', 'project', 'palette'] as const)('%s re-reads an external first commit on reopening', async (surface) => {
  const store = new AppStore('ws://localhost:0/')
  let committed = false
  // Project actions must refresh their own folder, even when another one is open.
  const current = surface === 'project' ? { ...workspace, path: '/work/other', name: 'other', repo: { root: '/work/other', worktree: false } } : workspace
  Object.assign(store.getSnapshot(), { status: 'open', workspace: current,
    workspaces: [current, ...(surface === 'project' ? [workspace] : [])], agents: [] })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (method === 'git/status') return { root: PATH, branch: 'main', headSha: committed ? 'beef123456' : null, files: [], ahead: 0, behind: 0 }
    if (method === 'worktree/list') return []
    if (method === 'flow/catalog') return []
    return null
  }) as never)
  const show = async () => {
    await act(async () => root.render(<StoreProvider store={store}>
      {surface === 'composer' ? <PlaceControl /> : surface === 'project' ? <WorkspaceMenu
        group={{ root: PATH, name: 'storefront', folders: [PATH], sessions: [], updatedAt: 0 }}
        current={false} actualRoot={PATH} at={{ x: 10, y: 10 }} onClose={noop} onNewWorktree={noop} />
        : surface === 'palette' ? <CommandPalette host={{ close: noop, chooseFolder: noop, openSettings: noop, openUsage: noop, openAgents: noop, openFrontDoor: noop }} />
        : <Sidebar onOpenSettings={noop} onOpenTeams={noop} onOpenAgents={noop}
          onOpenUsage={noop} onBrowseFolders={noop} onSignIn={noop} onSearch={noop} />}
    </StoreProvider>))
    if (surface === 'composer' || surface === 'sidebar') {
      await act(async () => button(surface === 'composer' ? 'storefront' : 'More ways to start').click())
    }
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
  }
  await show()
  expect(document.body.textContent).toContain('Make a first commit to work in a worktree')
  await act(async () => root.render(null))
  committed = true // An agent or terminal commits; no dialog refresh or focus event.
  await show()
  expect(document.body.textContent).not.toContain('Make a first commit to work in a worktree')
  expect(document.body.textContent).toContain('New worktree')
  expect(store.transport.request).toHaveBeenCalledWith('git/status', { root: PATH })
})
