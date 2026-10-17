import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, runtimeId, sessionId } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { useFlowCatalogue } from '../lib/flow-catalogue'
import { WorkspacesSection } from './Settings'
import { HistorySection } from './History'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const box = document.createElement('div')
document.body.append(box)
const root = createRoot(box)
afterEach(() => { act(() => root.render(null)); vi.restoreAllMocks() })
const chat = '/data/chats/2026-10-16-ABC123'
const project = { path: '/project', name: 'Real project', lastOpenedAt: 1 }
const setup = () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { chatsFolder: '/data/chats', chatsFolderRoots: [chat],
    workspace: { path: chat, name: 'Managed chat', lastOpenedAt: 2 },
    workspaces: [{ path: chat, name: 'Managed chat', lastOpenedAt: 2 }, project] })
  vi.spyOn(store.transport, 'request').mockResolvedValue([] as never)
  return store
}

it('omits managed chats from Settings folders and its count', async () => {
  const store = setup()
  await act(async () => root.render(<StoreProvider store={store}><WorkspacesSection project={null} onProject={() => {}} /></StoreProvider>))
  expect(box.textContent).toContain('Real project')
  expect(box.textContent).not.toContain('Managed chat')
  expect(box.textContent).toContain('Folders · 1')
})

it('omits managed chats from both recent and imported History project filters', async () => {
  const store = setup()
  const id = runtimeId('demo')
  Object.assign(store.getSnapshot(), { runtimes: [{ id, presentation: { name: 'Demo' }, capabilities: NO_CAPABILITIES }] })
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'history/list'
    ? { data: [chat, '/project', ''].map((cwd, index) => ({ runtime: id, id: sessionId(String(index)), cwd, title: 'Question', createdAt: 1, updatedAt: 2 })), nextCursor: null } : []) as never)
  await act(async () => root.render(<StoreProvider store={store}><HistorySection onOpen={() => {}} onOpenAgent={() => {}} /></StoreProvider>))
  const options = [...box.querySelectorAll<HTMLOptionElement>('select[aria-label="Project"] option')].map(one => one.value)
  expect(options).toEqual(['', '/project'])
})

it('reads the Flow catalogue only for projects, including when a managed chat is open', async () => {
  const store = setup()
  const read = vi.spyOn(store, 'flowCatalog').mockResolvedValue([])
  const Catalogue = () => { useFlowCatalogue(); return null }
  await act(async () => root.render(<StoreProvider store={store}><Catalogue /></StoreProvider>))
  expect(read.mock.calls).toEqual([['/project']])
})
