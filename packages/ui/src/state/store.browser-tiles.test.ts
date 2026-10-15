import { expect, it } from 'vitest'
import { sessionKey } from '@harnessdesk/protocol'
import { browserView, type BrowserView, type PaneView } from './layout'
import { AppStore } from './store'
import { findView, viewAt } from './workbench'
import { fromStored } from '../lib/side-by-side'
import '../panels/builtins'

const key = sessionKey('assistant', 'alpha')
function setup() {
  const store = new AppStore('ws://localhost:0/')
  store.openDefaultView({ kind: 'room', room: 'demo', sideBySide: { tiles: [key], focused: key, modes: { [key]: 'browser' } } })
  const room = findView(store.getSnapshot().workbench, { kind: 'room', room: 'demo' })!
  const paneId = room.area === 'main' ? room.pane : room.mounted.id
  store.openBrowser('https://example.com/alpha', { profile: 'lane-alpha' })
  const found = findView(store.getSnapshot().workbench, browserView('about:blank', 'lane-alpha'))!
  const browserId = found.area === 'main' ? found.pane : found.mounted.id
  return { store, paneId, browserId }
}

it('a tile owns the existing browser without duplicating its tabs or revealing its dock for agent commands', () => {
  const { store, paneId, browserId } = setup()
  const release = store.mountBrowserTile('lane-alpha', { paneId, key })
  store.focusPane(paneId)
  const before = store.getSnapshot().workbench
  store.openBrowser('https://example.com/updated', { profile: 'lane-alpha' })
  expect(store.getSnapshot().workbench.focus).toBeNull()
  expect(store.getSnapshot().layout.focused).toBe(paneId)
  expect((viewAt(store.getSnapshot().workbench, browserId) as BrowserView).tabs[0]!.url).toBe('https://example.com/updated')
  expect(store.getSnapshot().browserTiles.get('lane-alpha')).toEqual({ paneId, key })
  store.focusDrivenBrowserTab('lane-alpha')
  expect(store.getSnapshot().layout.focused).toBe(paneId)
  expect(store.getSnapshot().workbench.right.root.kind).toBe(before.right.root.kind)
  release()
  expect(store.getSnapshot().browserTiles.size).toBe(0)
  expect(viewAt(store.getSnapshot().workbench, browserId)?.kind).toBe('browser')
})

it('focusing a hidden tile follows expansion and keeps both browser modes', () => {
  const { store, paneId } = setup()
  const beta = sessionKey('assistant', 'beta')
  store.setRoomSideBySide(paneId, fromStored({ tiles: [key, beta], expanded: beta, modes: { [key]: 'browser', [beta]: 'browser' } }))
  const release = store.mountBrowserTile('lane-alpha', { paneId, key })
  store.focusDrivenBrowserTab('lane-alpha')
  const room = viewAt(store.getSnapshot().workbench, paneId) as Extract<PaneView, { kind: 'room' }>
  expect(room.sideBySide?.focused).toBe(key)
  expect(room.sideBySide?.expanded).toBe(key)
  expect(room.sideBySide?.modes).toEqual({ [key]: 'browser', [beta]: 'browser' })
  release()
})

it('closing the last tab clears the tile browser and reopening retains its profile', () => {
  const { store, paneId, browserId } = setup()
  const release = store.mountBrowserTile('lane-alpha', { paneId, key })
  const view = viewAt(store.getSnapshot().workbench, browserId) as BrowserView
  store.closeBrowserTab(browserId, view.tabs[0]!.id)
  expect(findView(store.getSnapshot().workbench, browserView('about:blank', 'lane-alpha'))).toBeNull()
  store.openBrowser('https://example.com/new', { profile: 'lane-alpha' })
  const found = findView(store.getSnapshot().workbench, browserView('about:blank', 'lane-alpha'))!
  const id = found.area === 'main' ? found.pane : found.mounted.id
  expect((viewAt(store.getSnapshot().workbench, id) as BrowserView).profile).toBe('lane-alpha')
  expect(store.getSnapshot().layout.focused).toBe(paneId)
  release()
})

it('an agent command restores the tile when another area has filled the content', () => {
  const { store, paneId } = setup()
  const release = store.mountBrowserTile('lane-alpha', { paneId, key })
  store.zoomPanel('right', 'content')
  store.focusDrivenBrowserTab('lane-alpha')
  expect(store.getSnapshot().workbench.zoom).toBeNull()
  expect(store.getSnapshot().layout.focused).toBe(paneId)
  release()
})
