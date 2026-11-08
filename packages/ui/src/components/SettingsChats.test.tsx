import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { GeneralSectionRows } from './Settings'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
afterEach(() => { act(() => root.render(null)); vi.restoreAllMocks() })

it('changes and resets Chats folder through the in-app picker without opening a project', async () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { chatsFolder: '/data/chats', chatsFolderRoots: [] })
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: { patch?: { chatsFolder?: string | null } }) => {
    if (method === 'workspace/browse') return { path: '/custom', parent: '/', entries: [] }
    if (method === 'app/state/set') return { chatsFolder: params.patch?.chatsFolder ?? '/data/chats', chatsFolderRoots: [] }
    return []
  }) as never)
  await act(async () => root.render(<StoreProvider store={store}><GeneralSectionRows /></StoreProvider>))
  expect(host.textContent).toContain('Chats folder')
  const action = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
  await act(async () => action('Change…').click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => action('Open “custom”').click())
  expect(request).toHaveBeenCalledWith('app/state/set', { patch: { chatsFolder: '/custom' } })
  expect(store.getSnapshot().chatsFolder).toBe('/custom')
  expect(request.mock.calls.some(([method]) => method === 'workspace/open')).toBe(false)
  await act(async () => action('Reset').click())
  expect(store.getSnapshot().chatsFolder).toBe('/data/chats')
  expect(request).toHaveBeenCalledWith('app/state/set', { patch: { chatsFolder: null } })
})

it('shows the host refusal in Settings and retains the previous chats location', async () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { chatsFolder: '/data/chats' })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'workspace/browse') return { path: '/project', parent: '/', entries: [] }
    if (method === 'app/state/set') throw new Error('Chats folder contains an opened project.')
    return []
  }) as never)
  await act(async () => root.render(<StoreProvider store={store}><GeneralSectionRows /></StoreProvider>))
  const action = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
  await act(async () => action('Change…').click())
  await act(async () => action('Open “project”').click())
  expect(document.body.textContent?.split('Chats folder contains an opened project.').length).toBe(2)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Chats folder contains an opened project.')
  expect(store.getSnapshot().chatsFolder).toBe('/data/chats')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => action('Cancel').click())
  expect(document.body.textContent).not.toContain('Chats folder contains an opened project.')
  await act(async () => action('Change…').click())
  expect(document.body.textContent).not.toContain('Chats folder contains an opened project.')
})


it('ignores a late refusal after cancelling, and shows a failed reset once', async () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { chatsFolder: '/data/chats' })
  let reject!: (error: Error) => void
  vi.spyOn(store.transport, 'request').mockImplementation(((method: string, params: { patch?: { chatsFolder?: string | null } }) => {
    if (method === 'workspace/browse') return Promise.resolve({ path: '/project', parent: '/', entries: [] })
    if (method === 'app/state/set' && params.patch?.chatsFolder === null) return Promise.reject(new Error('Reset refused'))
    if (method === 'app/state/set') return new Promise((_resolve, fail) => { reject = fail })
    return Promise.resolve([])
  }) as never)
  await act(async () => root.render(<StoreProvider store={store}><GeneralSectionRows /></StoreProvider>))
  const action = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
  await act(async () => action('Change…').click())
  act(() => action('Open “project”').click())
  await act(async () => action('Cancel').click())
  await act(async () => reject(new Error('Late refusal')))
  expect(document.body.textContent).not.toContain('Late refusal')
  await act(async () => action('Reset').click())
  expect(document.body.textContent?.split('Reset refused').length).toBe(2)
})
