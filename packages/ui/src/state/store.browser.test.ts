import { beforeEach, describe, expect, it } from 'vitest'

import { BLANK, activeBrowserTab, browserView, drivenBrowserTab, type BrowserView } from './layout'
import { AppStore } from './store'
import { findView, viewAt } from './workbench'
// The built-in views, so the browser opens where it does in the app — the
// right-hand dock — rather than in the split tree these tests once assumed.
// Two verbs (closing the panel, remembering a closed tab) only ever looked
// in the split tree, and stayed green here while broken on screen.
import '../panels/builtins'

/**
 * The store's browser-pane actions.
 *
 * The rule these hold is the one the pane is built on: **the tab an agent
 * drives is a tab on screen**. `browser_open` reaches `openBrowser` from the
 * shell, and the shell asks for `focusDrivenBrowserTab` before every
 * command — because Chromium stops painting a `<webview>` nobody is looking
 * at, so a driven tab left behind another screenshots blank.
 */

let store: AppStore

/** The browser, wherever it is mounted; the app puts it in the right dock. */
const browserAnywhere = (): { id: string; view: BrowserView } | null => {
  const workbench = store.getSnapshot().workbench
  const found = findView(workbench, browserView(BLANK))
  if (!found) return null
  const id = found.area === 'main' ? found.pane : found.mounted.id
  const view = viewAt(workbench, id)
  return view?.kind === 'browser' ? { id, view } : null
}

const browser = (): { id: string; view: BrowserView } => {
  const found = browserAnywhere()
  if (!found) throw new Error('no browser pane')
  return found
}

const browserIsOpen = (): boolean => browserAnywhere() !== null

beforeEach(() => {
  // Never connected: the socket queues, and layouts are only persisted once
  // a workspace is open. Nothing here reaches the wire.
  store = new AppStore('ws://localhost:0/')
})

describe('the browser pane', () => {
  it('opens on one tab, which is both shown and driven', () => {
    store.openBrowser('http://localhost:3000/')
    const { view } = browser()
    expect(view.tabs).toHaveLength(1)
    expect(activeBrowserTab(view).url).toBe('http://localhost:3000/')
    expect(view.active).toBe(view.driven)
  })

  it('opens a second browser into the one that exists rather than a second pane', () => {
    store.openBrowser('http://localhost:3000/')
    store.openBrowser('https://example.com/')
    expect(browserIsOpen()).toBe(true)
    expect(drivenBrowserTab(browser().view).url).toBe('https://example.com/')
  })

  /** This is the invariant an agent's turn depends on. */
  it('sends an agent’s page to the driven tab and brings it to the front', () => {
    store.openBrowser('http://localhost:3000/')
    const first = browser()
    const agentTab = first.view.driven
    // The person opens a tab of their own and reads it.
    store.newBrowserTab(first.id, 'https://docs.test/')
    expect(browser().view.active).not.toBe(agentTab)
    expect(browser().view.driven).toBe(agentTab)

    // The agent navigates. Its own tab moves, and comes to the front.
    store.openBrowser('http://localhost:3000/game')
    const after = browser().view
    expect(after.active).toBe(agentTab)
    expect(drivenBrowserTab(after).url).toBe('http://localhost:3000/game')
    // The person's tab is untouched.
    expect(after.tabs.find((tab) => tab.id !== agentTab)?.url).toBe('https://docs.test/')
  })

  it('brings the driven tab forward on request, and does nothing when it is already there', () => {
    store.openBrowser('http://localhost:3000/')
    const { id, view } = browser()
    store.newBrowserTab(id, 'https://docs.test/')
    store.focusDrivenBrowserTab()
    expect(browser().view.active).toBe(view.driven)
    const before = browser().view
    store.focusDrivenBrowserTab()
    // Same object: an idle nudge must not churn the layout or its persistence.
    expect(browser().view).toBe(before)
  })

  it('records where a tab went and what it calls itself', () => {
    store.openBrowser('http://localhost:3000/')
    const { id, view } = browser()
    const tabId = view.tabs[0]!.id
    store.noteBrowserUrl(id, tabId, 'http://localhost:3000/play')
    store.noteBrowserTitle(id, tabId, 'Snake')
    expect(browser().view.tabs[0]).toMatchObject({ url: 'http://localhost:3000/play', title: 'Snake' })
    // A note about a tab that has closed is ignored, not a crash.
    store.noteBrowserUrl(id, 'gone', 'https://nowhere.test/')
    expect(browser().view.tabs).toHaveLength(1)
  })

  it('hands the mark to another tab, and back', () => {
    store.openBrowser('http://localhost:3000/')
    const { id, view } = browser()
    const first = view.driven
    store.newBrowserTab(id, 'https://docs.test/')
    const second = browser().view.active
    store.setBrowserDriven(id, second)
    expect(browser().view.driven).toBe(second)
    store.setBrowserDriven(id, first)
    expect(browser().view.driven).toBe(first)
    // A tab that does not exist cannot take the mark.
    store.setBrowserDriven(id, 'gone')
    expect(browser().view.driven).toBe(first)
  })

  it('keeps exactly one driven tab when the driven one is closed', () => {
    store.openBrowser('https://a.test/')
    const { id } = browser()
    store.newBrowserTab(id, 'https://b.test/')
    const driven = browser().view.driven
    store.closeBrowserTab(id, driven)
    const after = browser().view
    expect(after.tabs).toHaveLength(1)
    expect(after.driven).toBe(after.tabs[0]!.id)
    expect(after.active).toBe(after.tabs[0]!.id)
  })

  it('closes the pane when the last tab goes', () => {
    store.openBrowser('https://a.test/')
    const { id, view } = browser()
    store.closeBrowserTab(id, view.tabs[0]!.id)
    expect(browserIsOpen()).toBe(false)
  })

  /**
   * Closing the panel is "I need the room", not "throw these pages away".
   * Only a tab's own × discards a page — that is the gesture that says so.
   */
  it('keeps the tabs when the panel is closed, and brings them back', () => {
    store.openBrowser('https://a.test/')
    const { id } = browser()
    store.newBrowserTab(id, 'https://b.test/')
    store.newBrowserTab(id, 'https://c.test/')
    const before = browser().view

    store.closeBrowser()
    expect(browserIsOpen()).toBe(false)

    store.openBrowser()
    expect(browser().view).toEqual(before)
  })

  it('sends an agent’s page to the driven tab of a panel it had to reopen', () => {
    store.openBrowser('https://a.test/')
    const { id } = browser()
    store.newBrowserTab(id, 'https://docs.test/')
    const driven = browser().view.driven
    store.closeBrowser()

    // `browser_open` after the person closed the panel: the pages come back
    // and the agent's own tab moves, rather than landing on their reading.
    store.openBrowser('https://a.test/game')
    const after = browser().view
    expect(after.tabs).toHaveLength(2)
    expect(after.driven).toBe(driven)
    expect(after.active).toBe(driven)
    expect(drivenBrowserTab(after).url).toBe('https://a.test/game')
    expect(after.tabs.find((tab) => tab.id !== driven)?.url).toBe('https://docs.test/')
  })

  it('opens in the right-hand dock, where the app puts it', () => {
    store.openBrowser('https://a.test/')
    const found = findView(store.getSnapshot().workbench, browserView(BLANK))
    expect(found?.area).toBe('right')
  })

  /** ⌘⇧T. A tab closed by its own × is the one gesture that discards a page, and the one that can be taken back. */
  it('brings back the last tab closed by its ×, on the page it was on', () => {
    store.openBrowser('https://a.test/')
    const { id } = browser()
    store.newBrowserTab(id, 'https://b.test/')
    const second = browser().view.active
    expect(store.hasClosedBrowserTabs).toBe(false)
    store.closeBrowserTab(id, second)
    expect(browser().view.tabs).toHaveLength(1)
    expect(store.hasClosedBrowserTabs).toBe(true)
    store.reopenClosedBrowserTab(id)
    const after = browser().view
    expect(after.tabs.map((tab) => tab.url)).toEqual(['https://a.test/', 'https://b.test/'])
    expect(activeBrowserTab(after).url).toBe('https://b.test/')
    expect(store.hasClosedBrowserTabs).toBe(false)
  })

  it('does not remember a blank tab as something to bring back', () => {
    store.openBrowser('https://a.test/')
    const { id } = browser()
    store.newBrowserTab(id)
    store.closeBrowserTab(id, browser().view.active)
    expect(store.hasClosedBrowserTabs).toBe(false)
  })

  it('does not bring back a page whose own tab was closed', () => {
    store.openBrowser('https://a.test/')
    const { id, view } = browser()
    store.closeBrowserTab(id, view.tabs[0]!.id)
    store.openBrowser()
    expect(browser().view.tabs.map((tab) => tab.url)).toEqual(['about:blank'])
  })

  it('remembers a device per tab', () => {
    store.openBrowser('https://a.test/')
    const { id, view } = browser()
    store.newBrowserTab(id, 'https://b.test/')
    store.setBrowserDevice(id, view.tabs[0]!.id, 'mobile')
    const after = browser().view
    expect(after.tabs.find((tab) => tab.id === view.tabs[0]!.id)?.device).toBe('mobile')
    expect(after.tabs.find((tab) => tab.id !== view.tabs[0]!.id)?.device).toBeUndefined()
  })

  it('puts back the last tab closed by its ×, and nothing else', () => {
    store.openBrowser('https://a.test/')
    const { id } = browser()
    store.newBrowserTab(id, 'https://b.test/')
    const doomed = browser().view.active
    store.closeBrowserTab(id, doomed)
    expect(browser().view.tabs).toHaveLength(1)

    store.reopenClosedBrowserTab(id)
    expect(browser().view.tabs.map((tab) => tab.url)).toEqual(['https://a.test/', 'https://b.test/'])
    // The stack is empty now; asking again does nothing rather than repeating.
    store.reopenClosedBrowserTab(id)
    expect(browser().view.tabs).toHaveLength(2)
  })

  it('does not offer a blank tab back — there was nothing on it', () => {
    store.openBrowser('https://a.test/')
    const { id } = browser()
    store.newBrowserTab(id)
    store.closeBrowserTab(id, browser().view.active)
    store.reopenClosedBrowserTab(id)
    expect(browser().view.tabs).toHaveLength(1)
  })

  it('keeps cookies and in-pane links unless told otherwise, and opens pages here', () => {
    expect(store.getSnapshot().browserPrefs).toEqual({
      persistSession: true,
      linksInPane: true,
      // Where an agent's pages go. In HarnessDesk by default: the whole
      // point of the pane is that you watch the agent work.
      placement: 'pane',
      externalBinary: '',
      keepExternalProfile: true,
    })
    store.setBrowserPrefs({ persistSession: false })
    expect(store.getSnapshot().browserPrefs.persistSession).toBe(false)
    expect(store.getSnapshot().browserPrefs.linksInPane).toBe(true)
  })

  it('takes a placement and keeps the rest of the answer intact', () => {
    store.setBrowserPrefs({ placement: 'window', externalBinary: '/Applications/Brave' })
    expect(store.getSnapshot().browserPrefs).toEqual({
      persistSession: true,
      linksInPane: true,
      placement: 'window',
      externalBinary: '/Applications/Brave',
      keepExternalProfile: true,
    })
  })
})
