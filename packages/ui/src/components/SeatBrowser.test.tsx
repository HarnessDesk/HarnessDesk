import { act, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { sessionKey, type GoalView, type Lane, type SeatRecord } from '@harnessdesk/protocol'
import { browserMount, tileBrowserWorkbench } from '../lib/browser-tiles'
import { fromStored, type SideBySideState } from '../lib/side-by-side'
import type { DesktopBridge } from '../lib/desktop'
import { MountProvider } from '../panels/mount'
import { StoreProvider, useSnapshot } from '../state/context'
import { AppStore } from '../state/store'
import { findView, focusedMount } from '../state/workbench'
import { BrowserPane } from './BrowserPane'
import { SideBySide } from './SideBySide'
import '../panels/builtins'

vi.mock('./Conversation', () => ({ Conversation: () => <textarea aria-label="Message" /> }))
vi.mock('./Approvals', () => ({ Approvals: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('two tiles borrow separate live profiles, route browser keys and agent focus, and keep guests across expansion', async () => {
  const keys = [sessionKey('assistant', 'alpha'), sessionKey('assistant', 'beta')]
  const lanes = ['alpha', 'beta'].map(name => ({ id: name, goal: 'demo', seat: name, cwd: `/workspace/${name}`, browserProfile: `lane-${name}`, state: 'active' } as Lane))
  const members = lanes.map(lane => ({ id: lane.seat, board: 'demo', checkout: { cwd: lane.cwd }, session: { runtime: 'assistant', sessionId: lane.id }, closed: null } as SeatRecord))
  const goal = { goal: { id: 'demo', root: '/workspace', revision: 1 }, board: { id: 'demo', members: keys }, members } as unknown as GoalView
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'goal/list') return [goal]
    if (method === 'lane/list') return lanes
    if (method === 'lane/preferences') return { start: 30000, width: 20, browserProfile: true }
    return null
  }) as never)
  await store.loadGoals('/workspace')
  await store.loadLanePreferences()
  store.openDefaultView({ kind: 'room', room: 'demo' })
  const found = findView(store.getSnapshot().workbench, { kind: 'room', room: 'demo' })!
  const paneId = found.area === 'main' ? found.pane : found.mounted.id
  const initial = fromStored({ tiles: keys, focused: keys[0], modes: Object.fromEntries(keys.map(key => [key, 'browser' as const])) })
  store.setRoomSideBySide(paneId, initial)
  for (const lane of lanes) store.openBrowser(`https://example.com/${lane.id}`, { profile: lane.browserProfile })
  store.focusPane(paneId)
  const bridge = window.harnessdesk
  const ready = vi.fn()
  window.harnessdesk = { platform: 'darwin', browserReady: ready, browserGone: vi.fn(), setBrowserLinksInPane: vi.fn() } as unknown as DesktopBridge
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1200, height: 700 } as DOMRect)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let state = initial
  const Harness = () => {
    const snapshot = useSnapshot()
    const [grid, setGrid] = useState(initial)
    state = grid
    useEffect(() => store.setRoomSideBySide(paneId, grid), [grid])
    return <>
      <SideBySide state={grid} onChange={setGrid} paneId={paneId} memberOf={key => ({ nickname: key === keys[0] ? 'Alpha' : 'Beta' })} entryOf={() => null} onOpenMember={vi.fn()} conversationProps={{ onChooseProject: vi.fn(), onSignIn: vi.fn(), onOpenUsage: vi.fn(), onOpenRuntimes: vi.fn() }} />
      {lanes.map(lane => {
        const mount = browserMount(snapshot, lane.browserProfile!)
        return mount ? <MountProvider key={lane.id} scope={mount}><BrowserPane /></MountProvider> : null
      })}
    </>
  }
  const click = (node: Element) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  const tileAction = (nickname: string, action: 'Expand' | 'Collapse') => {
    click(container.querySelector(`button[aria-label="${nickname} actions"]`)!)
    click(document.body.querySelector(`[role="menuitem"][aria-label="${action} ${nickname}"]`)!)
  }
  try {
    await act(async () => root.render(<StoreProvider store={store}><Harness /></StoreProvider>))
    const guests = [...container.querySelectorAll<HTMLElement>('webview')]
    expect(guests).toHaveLength(2)
    expect(guests.map(node => node.getAttribute('partition'))).toEqual(['persist:hd-lane-alpha', 'persist:hd-lane-beta'])
    expect(tileBrowserWorkbench(store.getSnapshot()).right.root).toMatchObject({ kind: 'stack', views: [] })
    act(() => guests.forEach((guest, index) => {
      let url = guest.getAttribute('src')!
      Object.assign(guest, { getWebContentsId: () => index + 1, getURL: () => url, loadURL: vi.fn(async (next: string) => { url = next }) })
      guest.dispatchEvent(new Event('dom-ready'))
    }))
    expect(ready.mock.calls.map(([request]) => request)).toEqual([{ profile: 'lane-alpha', webContentsId: 1 }, { profile: 'lane-beta', webContentsId: 2 }])
    tileAction('Alpha', 'Expand')
    expect([...container.querySelectorAll('webview')]).toEqual(guests)
    act(() => store.focusDrivenBrowserTab('lane-beta'))
    expect(state.expanded).toBe(keys[1])
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true })))
    const betaTile = container.querySelectorAll('[data-slot="side-by-side-tile"]')[1]!
    expect(betaTile.contains(document.activeElement)).toBe(true)
    tileAction('Beta', 'Collapse')
    expect([...container.querySelectorAll('webview')]).toEqual(guests)
    await act(async () => store.openBrowser('https://example.com/beta-updated', { profile: 'lane-beta' }))
    expect((guests[1] as unknown as { loadURL: ReturnType<typeof vi.fn> }).loadURL).toHaveBeenCalledWith('https://example.com/beta-updated')
    expect(store.getSnapshot().layout.focused).toBe(paneId)
    // The selected tile stays selected while a different mount has the keys.
    // None of its browser shortcuts may take those keys or change its tabs.
    act(() => store.showViewIn('bottom', { kind: 'tasks' }))
    const bottom = findView(store.getSnapshot().workbench, { kind: 'tasks' })!
    expect(bottom.area).toBe('bottom')
    const bottomId = bottom.area === 'main' ? bottom.pane : bottom.mounted.id
    expect(bottomId).not.toBe(paneId)
    await act(async () => {
      store.focusView(bottomId)
      await new Promise(requestAnimationFrame)
    })
    expect(focusedMount(store.getSnapshot().workbench)).toBe(bottomId)
    const before = lanes.map(lane => browserMount(store.getSnapshot(), lane.browserProfile!)!.view)
    const activeElement = document.activeElement
    const forwarded = vi.fn()
    document.addEventListener('keydown', forwarded)
    try {
      for (const key of ['t', 'w', 'l', '1', '[', ']']) {
        const event = new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true })
        act(() => document.dispatchEvent(event))
        expect(event.defaultPrevented, key).toBe(false)
      }
      expect(forwarded).toHaveBeenCalledTimes(6)
      expect(document.activeElement).toBe(activeElement)
      expect(lanes.map(lane => browserMount(store.getSnapshot(), lane.browserProfile!)!.view)).toEqual(before)
    } finally {
      document.removeEventListener('keydown', forwarded)
    }
    await act(async () => {
      store.focusPane(paneId)
      await new Promise(requestAnimationFrame)
    })
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true, cancelable: true })))
    const after = lanes.map(lane => browserMount(store.getSnapshot(), lane.browserProfile!)!.view)
    expect(after[0]).toEqual(before[0])
    expect(after[1]!.tabs.slice(0, before[1]!.tabs.length)).toEqual(before[1]!.tabs)
    expect(after[1]!.tabs).toHaveLength(before[1]!.tabs.length + 1)
    click(betaTile.querySelector('button[aria-label="Back to the conversation"]')!)
    expect(betaTile.querySelector('[data-mode="conversation"]')).not.toBeNull()
    expect(betaTile.querySelector('textarea[aria-label="Message"]')).not.toBeNull()
    click(betaTile.querySelector('button[aria-label="Show the browser"]')!)
    expect(state.modes[keys[1]!]).toBe('browser')
    expect(betaTile.querySelector('webview')?.getAttribute('partition')).toBe('persist:hd-lane-beta')
  } finally {
    act(() => root.unmount())
    container.remove()
    rect.mockRestore()
    if (bridge) window.harnessdesk = bridge
    else delete window.harnessdesk
  }
})
