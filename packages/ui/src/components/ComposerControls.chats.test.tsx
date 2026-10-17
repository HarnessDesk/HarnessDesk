import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { PlaceControl } from './ComposerControls'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
afterEach(() => { act(() => root.render(null)); vi.restoreAllMocks() })

it('lists No folder first and clears a chosen folder and worktree when selected', async () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { chatsFolder: '/data/chats', workspace: { path: '/project', name: 'project' } })
  vi.spyOn(store.transport, 'request').mockResolvedValue([] as never)
  await act(async () => root.render(<StoreProvider store={store}><PlaceControl onChooseProject={() => {}} /></StoreProvider>))
  await act(async () => host.querySelector<HTMLButtonElement>('button[title="/project"]')!.click())
  const items = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
  expect(items[0]?.textContent).toBe('No folder')
  await act(async () => items[0]!.click())
  expect(store.getSnapshot().workspace).toBeNull()
  const noFolder = host.querySelector<HTMLButtonElement>('button[title="Starts in /data/chats"]')!
  expect(noFolder?.textContent).toContain('No folder')
  expect(host.textContent).not.toContain('/data/chats')
  expect(host.textContent).not.toContain('worktree')
})

it('recovers the worktree menu when the open repository had no live facts in recents', async () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { workspace: { path: '/project', name: 'project', git: null } })
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) =>
    method === 'git/status' ? { branch: 'main', headSha: 'abcd', files: [] } : []) as never)
  await act(async () => root.render(<StoreProvider store={store}><PlaceControl onChooseProject={() => {}} /></StoreProvider>))
  expect(request).toHaveBeenCalledWith('git/status', { root: '/project' })
  await act(async () => { await new Promise<void>(done => requestAnimationFrame(() => done())) })
  expect([...host.querySelectorAll('button')].map(button => button.title)).toContain('Starts in project, on main')
})
