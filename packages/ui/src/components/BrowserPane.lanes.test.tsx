import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'

import { browserPartition, type DesktopBridge } from '../lib/desktop'
import { MountProvider } from '../panels/mount'
import { StoreProvider } from '../state/context'
import { browserView, readView, sameView, type BrowserView } from '../state/layout'
import { AppStore, emptySnapshot } from '../state/store'
import { findView, viewAt } from '../state/workbench'
import { BrowserPane } from './BrowserPane'
import '../panels/builtins'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function locate(store: AppStore, profile: string | null) {
  const workbench = store.getSnapshot().workbench
  const found = findView(workbench, browserView('about:blank', profile))
  if (!found) return null
  const id = found.area === 'main' ? found.pane : found.mounted.id
  return { id, view: viewAt(workbench, id) as BrowserView }
}

test('profile switching, close and reopen preserve independent tab sets and the default', () => {
  const store = new AppStore('ws://localhost:0/')
  store.openBrowser('https://example.com/plain')
  store.openBrowser('https://example.com/a', { profile: 'lane-a' })
  store.openBrowser('https://example.com/b', { profile: 'lane-b' })
  const a = locate(store, 'lane-a')!
  const b = locate(store, 'lane-b')!
  expect(a.id).not.toBe(b.id)
  store.newBrowserTab(a.id, 'https://example.com/a2')
  store.focusDrivenBrowserTab('lane-a')
  expect(locate(store, 'lane-a')!.view.active).toBe(a.view.driven)
  store.closeBrowser('lane-b')
  expect(locate(store, 'lane-b')).toBeNull()
  expect(locate(store, 'lane-a')!.view.tabs).toHaveLength(2)
  store.openBrowser(undefined, { profile: 'lane-b' })
  expect(locate(store, 'lane-b')!.view.tabs[0]!.url).toBe('https://example.com/b')
  expect(locate(store, null)!.view.tabs[0]!.url).toBe('https://example.com/plain')
  store.closeBrowserTab(a.id, locate(store, 'lane-a')!.view.tabs[1]!.id)
  store.reopenClosedBrowserTab(b.id)
  expect(locate(store, 'lane-b')!.view.tabs).toHaveLength(1)
})

test('saved views retain profile identity and malformed keys never restore old pages into default', () => {
  const a = browserView('https://example.com/a', 'lane-a')
  expect(readView(JSON.parse(JSON.stringify(a)))).toEqual(a)
  expect(sameView(a, browserView('https://example.com/a', 'lane-b'))).toBe(false)
  expect(sameView(browserView(), { kind: 'browser', tabs: [], active: '', driven: '' })).toBe(true)
  const invalid = readView({ ...a, profile: '../personal' }) as BrowserView
  expect(invalid.profile).toBeUndefined()
  expect(invalid.tabs[0]!.url).toBe('about:blank')
  expect(browserPartition('lane-a', false)).toBe('persist:hd-lane-a')
})

test('simultaneously mounted panes announce separate guest identities and partitions', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const snapshot = emptySnapshot()
  const named: { profile: string | null; webContentsId: number }[] = []
  const original = window.harnessdesk
  window.harnessdesk = {
    platform: 'darwin',
    browserReady: (request: { profile: string | null; webContentsId: number }) => named.push(request),
    browserGone: vi.fn(),
    setBrowserLinksInPane: vi.fn(),
  } as unknown as DesktopBridge
  const store = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    noteBrowserTitle: vi.fn(),
    noteBrowserUrl: vi.fn(),
    notice: vi.fn(),
  } as unknown as AppStore
  try {
    act(() =>
      root.render(
        <StoreProvider store={store}>
          {['lane-a', 'lane-b'].map((profile) => (
            <MountProvider
              key={profile}
              scope={{ area: 'right', id: profile, view: browserView('https://example.com/', profile) }}
            >
              <BrowserPane />
            </MountProvider>
          ))}
        </StoreProvider>,
      ),
    )
    const guests = [...container.querySelectorAll<HTMLElement>('webview')]
    expect(guests.map((guest) => guest.getAttribute('partition'))).toEqual([
      'persist:hd-lane-a',
      'persist:hd-lane-b',
    ])
    act(() =>
      guests.forEach((guest, index) => {
        Object.assign(guest, { getWebContentsId: () => index + 1 })
        guest.dispatchEvent(new Event('dom-ready'))
      }),
    )
    expect(named).toEqual([
      { profile: 'lane-a', webContentsId: 1 },
      { profile: 'lane-b', webContentsId: 2 },
    ])
  } finally {
    act(() => root.unmount())
    container.remove()
    if (original) window.harnessdesk = original
    else delete window.harnessdesk
  }
})
