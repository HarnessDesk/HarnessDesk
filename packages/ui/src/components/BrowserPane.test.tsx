import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest'

import type { Session, SessionKey } from '@harnessdesk/protocol'

import type { DesktopBridge } from '../lib/desktop'
import { StoreProvider } from '../state/context'
import { MountProvider } from '../panels/mount'
import { addBrowserTab, browserView, patchBrowserTab, type BrowserView, type PaneId } from '../state/layout'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { BrowserPane, normaliseUrl, stepZoom, tabName, zoomPercent } from './BrowserPane'

describe('normaliseUrl', () => {
  test('turns what a person types into something a browser loads', () => {
    expect(normaliseUrl('http://localhost:3000')).toBe('http://localhost:3000')
    expect(normaliseUrl('localhost:3000/app')).toBe('http://localhost:3000/app')
    expect(normaliseUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(normaliseUrl('example.com/path')).toBe('https://example.com/path')
    expect(normaliseUrl('file:///tmp/index.html')).toBe('file:///tmp/index.html')
    expect(normaliseUrl('  ')).toBe('about:blank')
    expect(normaliseUrl('model catalogue drift')).toBe('https://www.google.com/search?q=model%20catalogue%20drift')
  })
})

describe('tabName', () => {
  test('prefers what the page calls itself, then the host, then the file', () => {
    expect(tabName({ id: 't', url: 'https://example.com/a/b', title: 'Snake' })).toBe('Snake')
    expect(tabName({ id: 't', url: 'https://example.com/a/b' })).toBe('example.com')
    expect(tabName({ id: 't', url: 'file:///tmp/games/snake.html' })).toBe('snake.html')
    expect(tabName({ id: 't', url: 'about:blank' })).toBe('New tab')
    // A page whose title is only whitespace must not produce a nameless tab.
    expect(tabName({ id: 't', url: 'https://example.com/', title: '   ' })).toBe('example.com')
    expect(tabName({ id: 't', url: 'not a url' })).toBe('not a url')
  })
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(window as { harnessdesk?: Partial<DesktopBridge> }).harnessdesk = {
    platform: 'darwin',
    browserReady: () => {},
    browserGone: () => {},
    setBrowserLinksInPane: () => {},
  } as Partial<DesktopBridge> as DesktopBridge
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as { harnessdesk?: DesktopBridge }).harnessdesk
})

/** A store that records what the pane asked it to do. */
const storeOf = (persistSession = true, focused = false) => {
  const base = emptySnapshot()
  const snapshot = {
    ...base,
    // The browser's keys only bind while this pane is the one you are in.
    /* Docked focus, because the browser is docked here — and this fixture
       used to set `layout.focused` while mounting into `right`, a shape the
       app can never be in. The shortcuts read `workbench.focus` for a docked
       mount, so the old fixture proved nothing and hid a real regression. */
    ...(focused ? { workbench: { ...base.workbench, focus: 'p1' } } : {}),
    browserPrefs: { persistSession, linksInPane: true },
  }
  const calls = {
    selectBrowserTab: vi.fn(),
    closeBrowserTab: vi.fn(),
    newBrowserTab: vi.fn(),
    reopenClosedBrowserTab: vi.fn(),
    setBrowserDriven: vi.fn(),
    setBrowserDevice: vi.fn(),
    setBrowserPrefs: vi.fn(),
    moveBrowserTab: vi.fn(),
    duplicateBrowserTab: vi.fn(),
    closeOtherBrowserTabs: vi.fn(),
    noteBrowserUrl: vi.fn(),
    noteBrowserTitle: vi.fn(),
    notice: vi.fn(),
    focusPane: vi.fn(),
  }
  return {
    calls,
    store: {
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      ...calls,
    } as unknown as AppStore,
  }
}

/**
 * A store where a turn is in flight and its current step is one of the
 * browser plugin's own tools — the state the pane has to notice, because it
 * is the whole difference between watching a page and watching an agent.
 */
const drivingStore = (tool: string, withContributions = true, active = true) => {
  const base = emptySnapshot()
  const key = 'codex:s1' as unknown as SessionKey
  const session = {
    id: 's1',
    runtime: 'codex',
    turns: [
      {
        id: 't1',
        status: 'inProgress',
        items: [{ id: 'i1', type: 'toolCall', tool, status: 'inProgress', source: { kind: 'plugin' }, args: {} }],
      },
    ],
  } as unknown as Session
  const snapshot = {
    ...base,
    browserPrefs: { persistSession: true, linksInPane: true },
    activeSessionKey: active ? key : null,
    sessions: new Map([[key, session]]),
    runtimes: [
      { id: 'codex', presentation: { name: 'OpenAI Codex' }, capabilities: { pluginTools: true } },
    ] as unknown as AppSnapshot['runtimes'],
    plugins: withContributions
      ? ([{ instanceId: 'pi1', identity: { id: 'browser', name: 'Browser' } }] as unknown as AppSnapshot['plugins'])
      : [],
    contributions: withContributions
      ? ([
          {
            kind: 'tool',
            owner: 'pi1',
            namespace: 'browser',
            name: 'browser_click',
            description: 'Click at a point in the page. A screenshot’s pixels are the coordinates.',
          },
        ] as unknown as AppSnapshot['contributions'])
      : [],
  }
  const harness = storeOf()
  return {
    ...harness,
    store: { ...harness.store, getSnapshot: () => snapshot, interrupt: vi.fn() } as unknown as AppStore,
  }
}

const mount = (view: BrowserView, harness = storeOf()) => {
  act(() => {
    root.render(
      <StoreProvider store={harness.store}>
        {/* The browser reads its pages and its own id from the mount, not
            from a pane: every tab verb takes that id, and none of them cares
            whether it came from the split tree or a panel strip — which is
            what let the browser default to the right-hand edge. */}
        <MountProvider scope={{ area: 'right', id: 'p1', view }}>
          <BrowserPane />
        </MountProvider>
      </StoreProvider>,
    )
  })
  return harness
}

const tabs = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
const webviews = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('webview')]
const pages = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
/** Typing, the way React sees it: the tracked value has to move too. */
const type = (field: HTMLInputElement, value: string): void => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const click = (element: Element | null | undefined): void => {
  act(() => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('BrowserPane', () => {
  it('covers a blank page with an empty state of its own, webview and all', () => {
    mount(browserView())
    expect(webviews()).toHaveLength(1)
    expect(container.textContent).toContain('Type a URL above')
  })

  it('gets out of the way as soon as there is a page', () => {
    mount(browserView('https://example.com/'))
    expect(webviews()).toHaveLength(1)
    expect(container.textContent).not.toContain('Type a URL above')
  })

  it('draws one tab per page, named by the page', () => {
    const view = patchBrowserTab(addBrowserTab(browserView('https://example.com/'), 'https://other.test/'), 'x', {})
    mount(view)
    expect(tabs().map((tab) => tab.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('example.com'), expect.stringContaining('other.test')]),
    )
  })

  /**
   * Every tab keeps its guest. An Electron <webview> only attaches once it
   * has been laid out, so a hidden tab that were unmounted — or hidden with
   * `display: none` — could never be driven, restored, or brought back where
   * it was.
   */
  it('keeps every tab mounted, hiding the ones behind rather than removing them', () => {
    mount(addBrowserTab(browserView('https://a.test/'), 'https://b.test/'))
    expect(webviews()).toHaveLength(2)
    const shown = pages().filter((page) => page.getAttribute('aria-hidden') === 'false')
    expect(shown).toHaveLength(1)
    expect(pages().filter((page) => page.getAttribute('aria-hidden') === 'true')).toHaveLength(1)
  })

  it('marks the tab the browser tools drive, and only that one', () => {
    const view = addBrowserTab(browserView('https://a.test/'), 'https://b.test/')
    const base = storeOf()
    const key = 'codex:s1' as unknown as SessionKey
    const session = { id: 's1', runtime: 'codex', turns: [] } as unknown as Session
    const snapshot = {
      ...base.store.getSnapshot(),
      activeSessionKey: key,
      sessions: new Map([[key, session]]),
      runtimes: [{ id: 'codex', presentation: { name: 'OpenAI Codex' }, capabilities: { pluginTools: true } }] as unknown as AppSnapshot['runtimes'],
    }
    const harness = { ...base, store: { ...base.store, getSnapshot: () => snapshot } as unknown as AppStore }
    mount(view, harness)
    const marked = container.querySelectorAll('[title="OpenAI Codex drives this tab"]')
    expect(marked).toHaveLength(1)
    expect(marked[0]?.textContent).toContain('OpenAI Codex')
    expect(tabs()[0]?.contains(marked[0]!)).toBe(true)
  })

  /**
   * The pane says whether a turn has the wheel. Two agents spell the same
   * tool differently on the wire, and a check that only knows one of the
   * spellings leaves the pane claiming to be idle for the other.
   */
  it('says what the agent is doing to the page, in the plugin’s own words', () => {
    mount(browserView('https://a.test/'), drivingStore('browser_click'))
    expect(container.textContent).toContain('Click at a point in the page')
    expect(container.textContent).toContain('Being driven')
    expect(container.textContent).not.toContain('browser_click')
  })

  it('recognises the same tool under the name another agent gives it', () => {
    mount(browserView('https://a.test/'), drivingStore('mcp__harnessdesk__browser_click'))
    expect(container.textContent).toContain('Click at a point in the page')
  })

  it('still notices a browser step when the host has reported no contributions', () => {
    mount(browserView('https://a.test/'), drivingStore('browser_click', false))
    expect(container.textContent).toContain('Being driven')
    expect(container.textContent).toContain('Browser click')
  })

  /**
   * The middle of the window is not always a conversation.
   *
   * A Room takes the middle, and a member of that room drives this pane from a
   * conversation that is not the "active" one — there is no active one. Read
   * off `activeSessionKey` alone, the pane said *Idle* with both of an agent's
   * hands on the page, dropped the driven tab's mark, and refused its own
   * control with "This agent cannot receive browser tools" about the agent
   * that was driving it. Recorded live: `build-and-verify-a-game`.
   */
  it('names the agent driving it when the middle of the window is a Room', () => {
    mount(browserView('https://a.test/'), drivingStore('browser_click', true, false))
    expect(container.textContent).toContain('Being driven')
    expect(container.textContent).toContain('Click at a point in the page')
    expect(container.textContent).not.toContain('Idle')
  })

  it('keeps the driven mark, and does not refuse, with no active conversation', () => {
    mount(browserView('https://a.test/'), drivingStore('browser_click', true, false))
    expect(container.querySelectorAll('[title="OpenAI Codex drives this tab"]')).toHaveLength(1)
    expect(container.textContent).not.toContain('cannot receive browser tools')
  })

  /**
   * The mark is offered on capability and named on fact, and those are two
   * different questions. Answering the second one with the first put "Codex"
   * on a tab in a room of Cursor and Claude Code — an agent that was not in
   * the room, on a page it had never touched. Seen in a live take.
   */
  it('does not name the selected backend on a tab it has never driven', () => {
    const base = storeOf()
    const snapshot = {
      ...base.store.getSnapshot(),
      // A Room in the middle: no active conversation, and the only thing the
      // window can say about agents is which backend is selected.
      activeSessionKey: null,
      activeRuntime: 'codex',
      sessions: new Map(),
      runtimes: [{ id: 'codex', presentation: { name: 'OpenAI Codex' }, capabilities: { pluginTools: true } }] as unknown as AppSnapshot['runtimes'],
    }
    const harness = { ...base, store: { ...base.store, getSnapshot: () => snapshot } as unknown as AppStore }
    mount(browserView('https://a.test/'), harness)
    // Still marked — something here can drive a page, and the tab says so.
    expect(container.querySelectorAll('[title="Agents drive this tab"]')).toHaveLength(1)
    expect(container.textContent).not.toContain('OpenAI Codex')
  })

  /**
   * Two members of one room, both mid-call, and no conversation in the middle.
   *
   * Scanning the session map answers with whichever entered it first, and that
   * order records when a session was opened rather than which caller owns the
   * one browser the shell drives. The pane wired that answer straight to Stop,
   * so pressing it could interrupt a turn nobody was looking at. Raised on the
   * pull request, reproduced here: with the pair reversed the old code named
   * the other one.
   */
  const twoDriving = (first: 'codex' | 'claude') => {
    const base = emptySnapshot()
    const turn = (tool: string) => ({
      id: 't1',
      status: 'inProgress',
      items: [{ id: 'i1', type: 'toolCall', tool, status: 'inProgress', source: { kind: 'plugin' }, args: {} }],
    })
    const codex = ['codex:s1' as unknown as SessionKey, { id: 's1', runtime: 'codex', turns: [turn('browser_click')] } as unknown as Session] as const
    const claude = ['claude-code:s2' as unknown as SessionKey, { id: 's2', runtime: 'claude-code', turns: [turn('browser_open')] } as unknown as Session] as const
    const snapshot = {
      ...base,
      browserPrefs: { persistSession: true, linksInPane: true },
      // A Room holds the middle: there is no active conversation to prefer.
      activeSessionKey: null,
      sessions: new Map(first === 'codex' ? [codex, claude] : [claude, codex]),
      runtimes: [
        { id: 'codex', presentation: { name: 'OpenAI Codex' }, capabilities: { pluginTools: true } },
        { id: 'claude-code', presentation: { name: 'Claude' }, capabilities: { pluginTools: true } },
      ] as unknown as AppSnapshot['runtimes'],
    }
    const harness = storeOf()
    const interrupt = vi.fn()
    return {
      interrupt,
      store: { ...harness.store, getSnapshot: () => snapshot, interrupt } as unknown as AppStore,
    }
  }

  it('offers no Stop when it cannot say which conversation owns the page', () => {
    for (const order of ['codex', 'claude'] as const) {
      const harness = twoDriving(order)
      mount(browserView('https://a.test/'), harness as unknown as ReturnType<typeof storeOf>)
      // It is still honest about the page being driven.
      expect(container.textContent).toContain('Being driven')
      // But it must not pick one by the order they happen to be stored in.
      const stop = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Stop')
      expect(stop).toBeUndefined()
      expect(container.textContent).toContain('2 conversations')
      act(() => root.unmount())
      container.remove()
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    }
  })

  it('still offers Stop, wired to that one conversation, when only one is driving', () => {
    mount(browserView('https://a.test/'), drivingStore('browser_click', true, false))
    const stop = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Stop')
    expect(stop).toBeDefined()
  })

  it('is idle when nothing is touching the page', () => {
    mount(browserView('https://a.test/'))
    expect(container.textContent).toContain('Idle')
    expect(container.textContent).not.toContain('Being driven')
  })

  it('names the driven tab to the shell, not whichever tab is on screen', () => {
    const named: number[] = []
    ;(window as { harnessdesk?: Partial<DesktopBridge> }).harnessdesk = {
      platform: 'darwin',
      browserReady: (id: number) => named.push(id),
      browserGone: () => {},
      setBrowserLinksInPane: () => {},
    } as Partial<DesktopBridge> as DesktopBridge
    const view = addBrowserTab(browserView('https://a.test/'), 'https://b.test/')
    mount(view)
    const guests = webviews()
    // The second tab is on screen; the first wears the mark.
    Object.assign(guests[0]!, { getWebContentsId: () => 11 })
    Object.assign(guests[1]!, { getWebContentsId: () => 22 })
    act(() => {
      guests[1]!.dispatchEvent(new Event('dom-ready'))
      guests[0]!.dispatchEvent(new Event('dom-ready'))
    })
    expect(named).toEqual([11])
  })

  /**
   * Sending the page to the conversation, end to end: the hand-over has to
   * reach a composer that is not listening yet, and the notice has to say
   * which of those two things happened. Before the receipt protocol the pane
   * said "Page sent to chat" whether or not anyone took it.
   */
  describe('sending the page to the conversation', () => {
    const withGuest = (harness = storeOf()) => {
      mount(browserView('https://a.test/'), harness)
      const guest = webviews()[0]!
      Object.assign(guest, {
        getWebContentsId: () => 9,
        getTitle: () => 'A page',
        getURL: () => 'https://a.test/',
        capturePage: () => Promise.resolve({ toDataURL: () => 'data:image/png;base64,AAAA' }),
        executeJavaScript: () => Promise.resolve('the page as text'),
      })
      act(() => {
        guest.dispatchEvent(new Event('dom-ready'))
      })
      return harness
    }

    /** Waits for something the pane does after an await, without guessing a frame count. */
    const settle = async (until: () => boolean, ms = 1500): Promise<void> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline && !until()) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
        })
      }
    }

    const chooseMenu = async (label: string): Promise<void> => {
      click(container.querySelector('button[title="Browser settings"]'))
      const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((entry) =>
        (entry.textContent ?? '').includes(label),
      )
      if (!item) throw new Error(`no menu row says ${label}`)
      await act(async () => {
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
    }

    it('hands the page over, and says so once a composer has it', async () => {
      // No conversation is open in this harness, so no agent has said it
      // takes images: the page goes as the text a person would read.
      const taken: string[] = []
      const listener = (event: Event): void => {
        const detail = (event as CustomEvent<{ text: string; onReceived?: () => void }>).detail
        taken.push(detail.text)
        detail.onReceived?.()
      }
      window.addEventListener('harnessdesk:compose', listener)
      const harness = withGuest()
      try {
        await chooseMenu('Send page to chat')
        await settle(() => taken.length > 0)
        // The composer has the focus back before anything is dispatched.
        expect(harness.calls.focusPane).toHaveBeenCalled()
        expect(taken[0]).toContain('[Page: A page]')
        expect(taken[0]).toContain('the page as text')
        expect(harness.calls.notice).toHaveBeenCalledWith('info', 'Page sent to chat.')
      } finally {
        window.removeEventListener('harnessdesk:compose', listener)
      }
    })

    it('says the box did not take it when nobody is listening, rather than claiming it sent', async () => {
      const harness = withGuest()
      await chooseMenu('Send page to chat')
      // The retry runs for a fixed number of frames before it gives up.
      await settle(() => harness.calls.notice.mock.calls.some(([level]) => level === 'warning'))
      expect(harness.calls.notice).toHaveBeenCalledWith(
        'warning',
        'The message box did not take it — click into the conversation and try again.',
      )
      expect(harness.calls.notice).not.toHaveBeenCalledWith('info', 'Page sent to chat.')
    })
  })

  it('selects, opens and closes tabs through the store', () => {
    const harness = storeOf()
    const view = addBrowserTab(browserView('https://a.test/'), 'https://b.test/')
    mount(view, harness)
    click(tabs()[0])
    expect(harness.calls.selectBrowserTab).toHaveBeenCalledWith('p1', view.tabs[0]!.id)
    click(tabs()[1]?.querySelector('button'))
    expect(harness.calls.closeBrowserTab).toHaveBeenCalledWith('p1', view.tabs[1]!.id)
    click(container.querySelector('[aria-label="New tab"]'))
    expect(harness.calls.newBrowserTab).toHaveBeenCalledWith('p1')
  })

  it('sizes the guest to the device, so a screenshot is those pixels', () => {
    const view = browserView('https://a.test/')
    mount(patchBrowserTab(view, view.tabs[0]!.id, { device: 'mobile' }))
    const guest = webviews()[0]!
    expect(guest.style.width).toBe('375px')
    expect(guest.style.height).toBe('812px')
    // A phone user agent, because a load-time device gate reads that and not
    // the width.
    expect(guest.getAttribute('useragent')).toMatch(/Mobile/)
  })

  it('lets the page fill the pane when it is responsive, with no user agent of its own', () => {
    mount(browserView('https://a.test/'))
    const guest = webviews()[0]!
    expect(guest.style.width).toBe('')
    expect(guest.getAttribute('useragent')).toBeNull()
  })

  it('puts guests in an ephemeral partition when sessions are not kept', () => {
    mount(browserView('https://a.test/'), storeOf(true))
    expect(webviews()[0]?.getAttribute('partition')).toBe('persist:harnessdesk-browser')
    act(() => root.unmount())
    root = createRoot(container)
    mount(browserView('https://a.test/'), storeOf(false))
    expect(webviews()[0]?.getAttribute('partition')).toBe('harnessdesk-browser-once')
  })

  /**
   * The bug this exists for: the pane header is a window-drag region, and a
   * control inside it that does not declare `no-drag` is not a control — a
   * click on it moves the window and the tab never opens. The tab strip
   * sits where a title would, so it must be in a real no-drag box.
   */
  it('keeps the whole tab strip out of the window-drag region', () => {
    mount(addBrowserTab(browserView('https://a.test/'), 'https://b.test/'))
    const header = container.querySelector('header')
    expect(header?.className).toContain('hd-drag')
    for (const control of [
      ...container.querySelectorAll('[role="tab"]'),
      container.querySelector('[aria-label="New tab"]')!,
      container.querySelector('[role="tab"] button[aria-label^="Close"]')!,
    ]) {
      expect(control.closest('.hd-no-drag'), `${control.getAttribute('aria-label') ?? control.textContent} is draggable`).not.toBeNull()
    }
  })

  it('offers a tab its own menu on right-click', () => {
    const harness = storeOf()
    const view = addBrowserTab(browserView('https://a.test/'), 'https://b.test/')
    mount(view, harness)
    act(() => {
      tabs()[0]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 20 }))
    })
    const rows = [...container.querySelectorAll('[role^="menuitem"]')].map((row) => row.textContent)
    expect(rows.join('|')).toContain('Duplicate')
    expect(rows.join('|')).toContain('Close other tabs')
    expect(rows.join('|')).toContain('Close tabs to the right')
  })

  it('reorders tabs by dragging one along the strip', () => {
    const harness = storeOf()
    const view = addBrowserTab(browserView('https://a.test/'), 'https://b.test/')
    mount(view, harness)
    const data = { effectAllowed: '', dropEffect: '', setData: () => {}, getData: () => view.tabs[0]!.id }
    const fire = (node: Element, type: string) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true }) as MouseEvent & { dataTransfer: unknown }
      Object.defineProperty(event, 'dataTransfer', { value: data })
      act(() => {
        node.dispatchEvent(event)
      })
    }
    fire(tabs()[0]!, 'dragstart')
    fire(tabs()[1]!, 'dragover')
    fire(tabs()[1]!, 'drop')
    expect(harness.calls.moveBrowserTab).toHaveBeenCalledWith('p1', view.tabs[0]!.id, 1)
  })

  it('turns the reload button into a stop button while a page is loading', () => {
    const view = browserView('https://a.test/')
    mount(view)
    expect(container.querySelector('[aria-label="Reload"]')).not.toBeNull()
    const guest = webviews()[0]!
    act(() => {
      guest.dispatchEvent(new Event('did-start-loading'))
    })
    expect(container.querySelector('[aria-label="Stop"]')).not.toBeNull()
    act(() => {
      guest.dispatchEvent(new Event('did-stop-loading'))
    })
    expect(container.querySelector('[aria-label="Reload"]')).not.toBeNull()
  })

  /**
   * Switching to Mobile gives the guest a phone user agent, which means a
   * *new* `<webview>` — and every listener has to follow it. Held in a ref,
   * they stayed bound to the guest that had gone: the tab stopped reporting
   * its title and its history, so back and forward were dead for the rest of
   * the session.
   */
  it('rebinds to the new guest when a device preset replaces it', () => {
    const view = browserView('https://a.test/')
    const id = view.tabs[0]!.id
    const harness = mount(view)
    const first = webviews()[0]!
    act(() => {
      first.dispatchEvent(new Event('dom-ready'))
    })

    mount(patchBrowserTab(view, id, { device: 'mobile' }), harness)
    const second = webviews()[0]!
    expect(second).not.toBe(first)

    // The old guest is gone; nothing it says may still be heard.
    act(() => {
      first.dispatchEvent(Object.assign(new Event('page-title-updated'), { title: 'ghost' }))
    })
    expect(harness.calls.noteBrowserTitle).not.toHaveBeenCalled()

    // The live one is heard.
    act(() => {
      second.dispatchEvent(Object.assign(new Event('page-title-updated'), { title: 'Alpha' }))
    })
    expect(harness.calls.noteBrowserTitle).toHaveBeenCalledWith('p1', id, 'Alpha')
  })

  it('enables back and forward from what the guest reports', () => {
    mount(browserView('https://a.test/'))
    const guest = webviews()[0]!
    Object.assign(guest, { canGoBack: () => true, canGoForward: () => false, getWebContentsId: () => 7 })
    const back = () => container.querySelector<HTMLButtonElement>('[aria-label="Back"]')!
    expect(back().disabled).toBe(true)
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })
    expect(back().disabled).toBe(false)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Forward"]')!.disabled).toBe(true)
  })

  /**
   * One navigation, one load. React reflecting `tab.url` into the `src`
   * attribute made a `<webview>` reload the page it had just been navigated
   * to — Electron treats a changed attribute as a navigation, the same URL
   * included — so every `browser_open` loaded its page three times and the
   * first document's response body was gone before an agent could ask for
   * it. The attribute is the guest's birth address; everything after goes
   * through `loadURL`.
   */
  it('navigates a live guest by loadURL and never re-sets its src', () => {
    const view = browserView('https://a.test/')
    const harness = mount(view)
    const guest = webviews()[0]!
    const loadURL = vi.fn(() => Promise.resolve())
    Object.assign(guest, { getURL: () => 'https://a.test/', loadURL, getWebContentsId: () => 7 })
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })
    mount(patchBrowserTab(view, view.tabs[0]!.id, { url: 'https://moved.test/' }), harness)
    expect(guest.getAttribute('src')).toBe('https://a.test/')
    expect(loadURL).toHaveBeenCalledTimes(1)
    expect(loadURL).toHaveBeenCalledWith('https://moved.test/')
  })

  it('does not reload a guest that is already on the tab’s page', () => {
    const view = browserView('https://a.test/')
    const harness = mount(view)
    const guest = webviews()[0]!
    const loadURL = vi.fn(() => Promise.resolve())
    // What an agent's own navigation looks like from here: the guest moved
    // first, and the tab is only catching up.
    Object.assign(guest, { getURL: () => 'https://moved.test/', loadURL, getWebContentsId: () => 7 })
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })
    mount(patchBrowserTab(view, view.tabs[0]!.id, { url: 'https://moved.test/' }), harness)
    expect(loadURL).not.toHaveBeenCalled()
  })

  it('follows the tab in the address bar when an agent navigates it', () => {
    const view = browserView('https://a.test/')
    const harness = mount(view)
    const address = () => container.querySelector<HTMLInputElement>('[aria-label="Address"]')!
    expect(address().value).toBe('https://a.test/')
    mount(patchBrowserTab(view, view.tabs[0]!.id, { url: 'https://moved.test/' }), harness)
    expect(address().value).toBe('https://moved.test/')
  })
})

/**
 * A browser's keys.
 *
 * The letter a keyboard reports for ⌘⇧T is not settled — some layouts say
 * `T`, some say `t` — and a switch that reads the character rather than the
 * modifier gets one of the two and silently drops the other. That is exactly
 * what happened: two `case 't'` clauses, the second unreachable, and reopen
 * worked or did not depending on the keyboard. Both spellings are pressed
 * here for every shortcut that has a shifted twin.
 */
describe('BrowserPane keys', () => {
  const press = (key: string, extra: Partial<KeyboardEventInit> = {}): void => {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true, ...extra }),
      )
    })
  }

  it('⌘T opens a tab and ⌘⇧T reopens the last closed one, whichever case arrives', () => {
    const harness = mount(browserView(), storeOf(true, true))
    press('t')
    expect(harness.calls.newBrowserTab).toHaveBeenCalledTimes(1)
    expect(harness.calls.reopenClosedBrowserTab).not.toHaveBeenCalled()

    press('T', { shiftKey: true })
    press('t', { shiftKey: true })
    expect(harness.calls.reopenClosedBrowserTab).toHaveBeenCalledTimes(2)
    // Reopen is not a new blank tab; it must never be mistaken for one.
    expect(harness.calls.newBrowserTab).toHaveBeenCalledTimes(1)
  })

  it('⌘W closes the tab, ⌘L goes to the address, ⌘2 selects the second tab', () => {
    let view = browserView('https://a.test')
    view = addBrowserTab(view, 'https://b.test')
    const harness = mount(view, storeOf(true, true))

    press('w')
    expect(harness.calls.closeBrowserTab).toHaveBeenCalledWith('p1', view.active)

    press('l')
    expect(document.activeElement).toBe(container.querySelector('input'))

    press('2')
    expect(harness.calls.selectBrowserTab).toHaveBeenCalledWith('p1', view.tabs[1]!.id)
    // ⌘9 is the last tab, as in every browser — not the ninth.
    press('9')
    expect(harness.calls.selectBrowserTab).toHaveBeenLastCalledWith('p1', view.tabs[view.tabs.length - 1]!.id)
  })

  it('⌘R reloads the page and ⌘⇧R reloads it without its caches', () => {
    const view = browserView('https://a.test/')
    mount(view, storeOf(true, true))
    const guest = webviews()[0]!
    const reload = vi.fn()
    const hard = vi.fn()
    Object.assign(guest, { reload, reloadIgnoringCache: hard, getWebContentsId: () => 7 })
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })
    press('r')
    expect(reload).toHaveBeenCalledTimes(1)
    press('R', { shiftKey: true })
    expect(hard).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('⌘+ twice in a frame moves two rungs, and the level shows in the bar', () => {
    // A held ⌘+ fires faster than React re-renders; stepping from a state
    // variable gave both presses the same answer and moved the page once.
    mount(browserView('https://a.test'), storeOf(true, true))
    const guest = webviews()[0]!
    const levels: number[] = []
    Object.assign(guest, { getWebContentsId: () => 5, setZoomLevel: (level: number) => levels.push(level) })
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })

    press('=')
    press('=')
    expect(container.textContent).toContain('125%')
    // The 100% at the front is the tab asserting its level at `dom-ready`.
    expect(levels.map((level) => Math.round(1.2 ** level * 100))).toEqual([100, 110, 125])

    // The level in the bar is the way back to 100%.
    click([...container.querySelectorAll('button')].find((b) => b.textContent === '125%'))
    expect(container.textContent).not.toContain('125%')
  })

  it('puts the tab’s zoom back after a navigation, because Chromium drops it', () => {
    // Chromium keeps zoom per origin. Follow a link to another site and it
    // silently returns to 100% — while the bar still claims 150%.
    mount(browserView('https://a.test'), storeOf(true, true))
    const guest = webviews()[0]!
    const levels: number[] = []
    Object.assign(guest, { getWebContentsId: () => 5, setZoomLevel: (level: number) => levels.push(level) })
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })
    press('=')
    const zoomed = levels.at(-1)!
    expect(zoomPercent(zoomed)).toBe(110)

    act(() => {
      guest.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://elsewhere.test/' }))
    })
    expect(levels.at(-1)).toBe(zoomed)
  })

  it('asserts 100% too, because Chromium remembers a zoom per site', () => {
    // Zoom a site once and every later tab that opens it comes up magnified,
    // with the bar claiming 100%. The tab says what its zoom is.
    mount(browserView('https://a.test'), storeOf(true, true))
    const guest = webviews()[0]!
    const levels: number[] = []
    Object.assign(guest, { getWebContentsId: () => 5, setZoomLevel: (level: number) => levels.push(level) })
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })
    expect(levels).toEqual([0])
  })

  it('drops the site mark when the tab leaves the site', async () => {
    // A site with no favicon sends no event, so waiting for a replacement
    // leaves the tab wearing the previous site's mark for ever.
    mount(browserView('https://a.test'), storeOf(true, true))
    const guest = webviews()[0]!
    Object.assign(guest, {
      getWebContentsId: () => 5,
      executeJavaScript: () => Promise.resolve('data:image/png;base64,iVBOR'),
    })
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })
    act(() => {
      guest.dispatchEvent(
        Object.assign(new Event('page-favicon-updated'), { favicons: ['https://a.test/icon.png'] }),
      )
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.querySelector('img')).not.toBeNull()

    act(() => {
      guest.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://blank.test/' }))
    })
    expect(container.querySelector('img')).toBeNull()
  })

  it('keeps the site mark across pages of the same site, which report no new icon', async () => {
    // Chromium only reports icons when the candidate list changes, so the
    // second page of a site sends nothing; clearing on every navigation left
    // it wearing a globe.
    mount(browserView('https://a.test/'), storeOf(true, true))
    const guest = webviews()[0]!
    Object.assign(guest, {
      getWebContentsId: () => 5,
      executeJavaScript: () => Promise.resolve('data:image/png;base64,iVBOR'),
    })
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })
    act(() => {
      guest.dispatchEvent(Object.assign(new Event('page-favicon-updated'), { favicons: ['https://a.test/icon.png'] }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.querySelector('img')).not.toBeNull()
    act(() => {
      guest.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://a.test/second' }))
    })
    expect(container.querySelector('img')).not.toBeNull()
    // A page of the site that declares a different (or no) icon replaces it.
    act(() => {
      guest.dispatchEvent(Object.assign(new Event('page-favicon-updated'), { favicons: ['https://a.test/favicon.ico'] }))
    })
    expect(container.querySelector('img')).toBeNull()
  })

  it('does not take the mark down for the same icon reported again', async () => {
    mount(browserView('https://a.test/'), storeOf(true, true))
    const guest = webviews()[0]!
    let fetches = 0
    Object.assign(guest, {
      getWebContentsId: () => 5,
      executeJavaScript: () => {
        fetches += 1
        return Promise.resolve('data:image/png;base64,iVBOR')
      },
    })
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })
    const report = () =>
      act(() => {
        guest.dispatchEvent(Object.assign(new Event('page-favicon-updated'), { favicons: ['https://a.test/icon.png'] }))
      })
    report()
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.querySelector('img')).not.toBeNull()
    // A reload reports the same candidate; the mark stays up and nothing is fetched again.
    report()
    expect(container.querySelector('img')).not.toBeNull()
    expect(fetches).toBe(1)
  })

  it('leaves the keys alone when the pane is not the focused one', () => {
    const harness = mount(browserView(), storeOf(true, false))
    press('t')
    press('w')
    expect(harness.calls.newBrowserTab).not.toHaveBeenCalled()
    expect(harness.calls.closeBrowserTab).not.toHaveBeenCalled()
  })
})

describe('zoom', () => {
  test('walks Chrome’s own ladder and stops at its ends', () => {
    expect(zoomPercent(0)).toBe(100)
    expect(zoomPercent(stepZoom(0, 1))).toBe(110)
    expect(zoomPercent(stepZoom(stepZoom(0, 1), 1))).toBe(125)
    expect(zoomPercent(stepZoom(0, -1))).toBe(90)

    // From between rungs — a page that set a zoom of its own — a step lands
    // on the next rung past it, the way Chrome's does, not on the one after.
    const between = Math.log(1.05) / Math.log(1.2)
    expect(zoomPercent(stepZoom(between, 1))).toBe(110)
    expect(zoomPercent(stepZoom(between, -1))).toBe(100)

    let level = 0
    for (let i = 0; i < 40; i += 1) level = stepZoom(level, 1)
    expect(zoomPercent(level)).toBe(500)
    for (let i = 0; i < 80; i += 1) level = stepZoom(level, -1)
    expect(zoomPercent(level)).toBe(25)
  })
})

/**
 * Find in page belongs to the guest — Chromium highlights, scrolls and
 * counts — so what is tested here is the part the pane owns: that ⌘F opens
 * the bar and asks, that Enter walks and ⇧Enter walks back, that closing
 * puts the page back, and that leaving the tab ends the search rather than
 * leaving a page painted yellow behind you.
 */
describe('BrowserPane find', () => {
  const findField = (): HTMLInputElement | null =>
    container.querySelector<HTMLInputElement>('input[aria-label="Find in page"]')

  const openWithGuest = () => {
    let view = browserView('https://a.test')
    view = addBrowserTab(view, 'https://b.test')
    const harness = mount(view, storeOf(true, true))
    // A new tab takes the screen, so the guest to drive is the second one.
    const guest = webviews()[1]!
    const calls: { find: [string, unknown][]; stopped: string[] } = { find: [], stopped: [] }
    Object.assign(guest, {
      getWebContentsId: () => 3,
      findInPage: (text: string, options: unknown) => {
        calls.find.push([text, options])
        return 1
      },
      stopFindInPage: (action: string) => calls.stopped.push(action),
    })
    act(() => {
      guest.dispatchEvent(new Event('dom-ready'))
    })
    return { harness, guest, calls, view }
  }

  const press = (key: string, extra: Partial<KeyboardEventInit> = {}): void => {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true, ...extra }),
      )
    })
  }

  it('⌘F opens the bar, typing asks the guest, and the count comes back', () => {
    const { guest, calls } = openWithGuest()
    expect(findField()).toBeNull()

    press('f')
    const field = findField()
    expect(field).not.toBeNull()

    type(field!, 'snake')
    // A first request leaves `findNext` out. Spelled out as `false`, Chromium
    // answers with nothing at all — measured on Electron 42 — and the bar
    // read "No results" over a page of highlighted matches until Enter.
    expect(calls.find).toEqual([['snake', { forward: true }]])

    act(() => {
      guest.dispatchEvent(
        Object.assign(new Event('found-in-page'), { result: { activeMatchOrdinal: 2, matches: 7 } }),
      )
    })
    expect(container.textContent).toContain('2/7')
  })

  it('Enter walks forward, ⇧Enter back, Escape clears the highlight', () => {
    const { calls } = openWithGuest()
    press('f')
    const field = findField()!
    type(field, 'x')

    const enter = (shiftKey: boolean) =>
      act(() => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }))
      })
    enter(false)
    enter(true)
    expect(calls.find.slice(1)).toEqual([
      ['x', { findNext: true, forward: true }],
      ['x', { findNext: true, forward: false }],
    ])

    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(findField()).toBeNull()
    expect(calls.stopped).toEqual(['clearSelection'])
  })

  it('asking twice for the same word still answers', () => {
    // Chromium goes quiet when a find request repeats one it already served,
    // which used to leave the bar saying "No results" over a highlighted page.
    const { calls } = openWithGuest()
    press('f')
    type(findField()!, 'needle')
    act(() => {
      findField()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    press('f')
    type(findField()!, 'needle')
    expect(calls.find).toEqual([
      ['needle', { forward: true }],
      ['needle', { findNext: true, forward: true }],
    ])
  })

  it('an empty field stops the search rather than searching for nothing', () => {
    const { calls } = openWithGuest()
    press('f')
    const field = findField()!
    type(field, 'x')
    type(field, '')
    expect(calls.stopped).toEqual(['clearSelection'])
    expect(calls.find).toHaveLength(1)
  })

  it('moving to another tab ends the search', () => {
    const { harness, view } = openWithGuest()
    press('f')
    expect(findField()).not.toBeNull()
    // The pane follows the store, so the switch arrives as a new view.
    mount({ ...view, active: view.tabs[0]!.id }, harness)
    expect(findField()).toBeNull()
  })
})
