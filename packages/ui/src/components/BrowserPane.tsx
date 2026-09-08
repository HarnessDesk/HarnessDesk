import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'

import { currentTurn, type RuntimeInfo, type SessionKey } from '@harnessdesk/protocol'

import {
  ANNOTATE_ALIVE,
  ANNOTATE_SOURCE,
  ANNOTATION_LABEL,
  annotateCall,
  annotationContext,
  annotationSummary,
  readAnnotations,
} from '../lib/annotate'
import { handOverToComposer, type ComposeRequest } from '../lib/compose'
import { noteKey, wrapContext } from '../lib/context-envelope'
import { desktop, hasInlineBrowser, openExternal } from '../lib/desktop'
import { bareToolName, toolsOfPlugin, toolWords } from '../lib/tool-names'
import { useSnapshot, useStore } from '../state/context'
import { useMount } from '../panels/mount'
import { focusedMount } from '../state/workbench'
import {
  BLANK,
  activeBrowserTab,
  browserDevice,
  conversationPane,
  BROWSER_DEVICES,
  type BrowserDevice,
  type BrowserTab,
  type BrowserView,
} from '../state/layout'
import {
  AnnotateIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  CrossIcon,
  DesktopIcon,
  DevToolsIcon,
  ExternalIcon,
  GlobeIcon,
  MobileIcon,
  MoreIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  ResponsiveIcon,
  RetryIcon,
  SearchIcon,
  TabletIcon,
  TrashIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './Icons'
import { RuntimeMark } from './BrandIcons'
import { ContextMenu, Menu, MenuItem, MenuSeparator, MenuToggle, useContextMenu } from './Menu'
import { Popover } from './Popover'
import { stripEdges, useTabStrip } from './TabStrip'
import { ToolPaneHeader } from './ToolPaneHeader'
import styles from './ToolPanes.module.css'

/**
 * The browser pane: live pages inside the window.
 *
 * In the desktop shell each tab is an Electron `<webview>` — a real browser
 * in its own process and its own session partition, with no preload and no
 * Node, the one place the app shows pages it did not write. One tab carries
 * the *driven* mark, and the pane names that guest to the shell; the browser
 * tools then drive that very page over the DevTools protocol. The shell
 * fronts it before every command, so what the agent clicks stays what the
 * person sees — and, less obviously, stays rasterised at all: Chromium
 * freezes a `<webview>` nobody is looking at, and a frozen tab screenshots
 * blank. The person can use the pane too: open tabs, type a URL, go back,
 * click around — it is a browser.
 *
 * In the browser build there is no webview; the pane falls back to sandboxed
 * iframes, which show what lets itself be framed, and the tools drive the
 * user's Chrome instead.
 *
 * Design and the reasoning behind the driven mark: `docs/browser-control.md`.
 */

interface WebviewElement extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getWebContentsId(): number
  openDevTools(): void
  isDevToolsOpened(): boolean
  stop(): void
  executeJavaScript(code: string): Promise<unknown>
  capturePage(): Promise<{ toDataURL(): string }>
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  setZoomLevel(level: number): void
  getZoomLevel(): number
  inspectElement(x: number, y: number): void
  copy(): void
}

/** What a right-click inside a page reports, of the parts the menu uses. */
interface PageMenuTarget {
  readonly x: number
  readonly y: number
  readonly linkURL: string
  readonly selectionText: string
  readonly srcURL: string
  readonly mediaType: string
}

/**
 * Zoom, on Chrome's own ladder.
 *
 * Chromium's zoom *level* is logarithmic — each unit is a factor of 1.2 —
 * but the steps a person expects from ⌘+ are the percentages in Chrome's
 * menu, so the ladder is written as factors and converted. A step goes to
 * the next rung past where the page actually is, so ⌘+ from a page sitting
 * at 105% of its own accord gives 110%, not 125%.
 */
const ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const
const ZOOM_STEPS: readonly number[] = ZOOM_FACTORS.map((factor) => Math.log(factor) / Math.log(1.2))

export const zoomPercent = (level: number): number => Math.round(1.2 ** level * 100)

export const stepZoom = (level: number, by: 1 | -1): number => {
  // A hair of tolerance, so a rung the page is already standing on is not
  // mistaken for one just below it by a rounding error.
  const nudge = 0.001
  const last = ZOOM_STEPS.length - 1
  return by === 1
    ? (ZOOM_STEPS.find((step) => step > level + nudge) ?? ZOOM_STEPS[last]!)
    : (ZOOM_STEPS.filter((step) => step < level - nudge).at(-1) ?? ZOOM_STEPS[0]!)
}

/** A webview call that may throw for being early; undefined then. */
const safely = <T,>(call: () => T): T | undefined => {
  try {
    return call()
  } catch {
    return undefined
  }
}

/**
 * One annotation-overlay call, run where the page cannot answer for it: the
 * desktop shell executes the code in an isolated world of the guest, named
 * by `webContents` id. `executeJavaScript` on the `<webview>` itself would
 * run in the page's own world, where a hostile page could pre-plant
 * `__hdAnnotate` and feed fabricated marks straight into the composer.
 * Rejects when the shell is absent or the guest is already detached.
 */
const inOverlayWorld = (element: WebviewElement, code: string): Promise<unknown> => {
  const bridge = desktop()
  if (!bridge?.annotateInPage) return Promise.reject(new Error('Annotating needs the desktop app.'))
  try {
    return bridge.annotateInPage(element.getWebContentsId(), code)
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/** A URL's site, for telling one page of it from a change of site. */
const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** What a person typed in the bar, as something a browser can load. */
export const normaliseUrl = (typed: string): string => {
  const text = typed.trim()
  if (!text) return BLANK
  if (/^(https?|file|about):/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return `http://${text}`
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

/** What a tab is called: what the page says, else the host, else "New tab". */
export const tabName = (tab: BrowserTab): string => {
  if (tab.title?.trim()) return tab.title.trim()
  if (tab.url === BLANK) return 'New tab'
  try {
    const parsed = new URL(tab.url)
    return parsed.protocol === 'file:' ? (parsed.pathname.split('/').filter(Boolean).at(-1) ?? 'File') : parsed.host
  } catch {
    return tab.url
  }
}

const DEVICE_ICONS: Record<BrowserDevice, typeof GlobeIcon> = {
  responsive: ResponsiveIcon,
  mobile: MobileIcon,
  tablet: TabletIcon,
  desktop: DesktopIcon,
}

/**
 * How much of the device fits. A preset gives the guest the device's own
 * viewport in CSS pixels — that is what keeps screenshots and click
 * coordinates honest — so when the pane is narrower than the device the
 * whole element is scaled by the compositor rather than reflowed. Hit
 * testing goes through a transform, so the person's clicks still land.
 */
const useStageScale = (size: { width: number; height: number } | null) => {
  const stage = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const node = stage.current
    if (!node || !size) {
      setScale(1)
      return
    }
    const measure = (): void => {
      const box = node.getBoundingClientRect()
      if (box.width < 1 || box.height < 1) return
      setScale(Math.min(1, box.width / size.width, box.height / size.height))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [size])
  return { stage, scale }
}

/**
 * One tab's page, and everything that happens to it.
 *
 * Every tab stays mounted, including the ones behind: a `<webview>` only
 * attaches once it has been laid out, and a tab that never attached could
 * not be driven, restored, or brought back with its scroll position. Hidden
 * tabs are laid out and made invisible rather than removed from flow.
 */
const BrowserTabPage = ({
  tab,
  active,
  partition,
  onReady,
  onNavigate,
  onTitle,
  onLoading,
  onCanGo,
  onIcon,
  onFound,
  onPageMenu,
  zoom,
  register,
}: {
  tab: BrowserTab
  active: boolean
  partition: string
  zoom: number
  onReady: (tabId: string, webContentsId: number) => void
  onNavigate: (tabId: string, url: string) => void
  onTitle: (tabId: string, title: string) => void
  onLoading: (tabId: string, loading: boolean) => void
  onCanGo: (tabId: string, canGo: { back: boolean; forward: boolean }) => void
  onIcon: (tabId: string, dataUrl: string) => void
  onFound: (result: { active: number; total: number }) => void
  onPageMenu: (target: PageMenuTarget, at: { x: number; y: number }) => void
  register: (tabId: string, element: WebviewElement | null, ready: () => boolean) => void
}) => {
  const inline = hasInlineBrowser()
  /*
    The guest is held in *state*, set by a callback ref, not in a `useRef`.
    Changing the partition or the user agent re-keys the element, and React
    then mounts a different one — a ref would leave every listener bound to
    the guest that has gone, so after one switch to Mobile the tab stopped
    reporting its title, its navigations, its icon and its history, and back
    and forward went dead. State makes the element a dependency, so the
    effects rebind to whichever guest is really there.
  */
  const [element, setElement] = useState<WebviewElement | null>(null)
  // A <webview>'s methods throw until it is attached and `dom-ready` has
  // fired; until then only its `src` attribute may be touched.
  const ready = useRef(false)
  const spec = browserDevice(tab.device)
  const { stage, scale } = useStageScale(spec.size)
  // Changing the partition or the user agent has to make a new guest — both
  // are read when one is created, and a mobile user agent is only meaningful
  // if the page loads again under it, which is exactly what a device gate
  // needs.
  const guestKey = `${partition}:${spec.userAgent ?? ''}`
  /*
    The address a guest is *born* on, and nothing after it.

    React reflects every change of `tab.url` into the `src` attribute, and a
    `<webview>` treats a changed attribute as a navigation — including to the
    page it is already on, which Electron documents as a reload. So an agent's
    `Page.navigate` was followed by React's reload of the same page, and then
    by this component's own `loadURL` below: every `browser_open` loaded its
    page three times. The network view showed a 200, an `ERR_ABORTED` and a
    200 again, the first document's response body was gone by the time an
    agent asked for it by id, and an address typed in the bar did the same
    dance. The attribute is set once per guest; every later navigation goes
    through `loadURL`, which is one request.
  */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bornAt = useMemo(() => tab.url, [guestKey])
  /*
    Chromium keeps zoom per *origin*, and a preview pane is per *tab*: zoom
    a page to 150%, follow a link to another site, and Chromium quietly puts
    it back to 100% while the bar still says 150%. So the tab re-asserts its
    zoom every time the guest is rebuilt or navigates. The ref is what the
    listeners read — they are bound once, and a captured `zoom` would freeze
    at whatever it was when the guest attached.
  */
  const zoomAt = useRef(zoom)
  zoomAt.current = zoom
  /** Where the guest last was, for telling a change of site from a page of the same one. */
  const lastUrl = useRef(tab.url)
  /** The icon last asked for, so the same one reported again is not a change. */
  const lastIcon = useRef('')

  // The view's URL is where the tab was told to go — by the person, by a
  // restored layout, or by an agent through the shell. The element follows
  // it; the element's own navigations flow back through `onNavigate`.
  useEffect(() => {
    if (!element || !inline) return
    if (!ready.current) {
      // Before `dom-ready` the element takes an attribute and nothing else —
      // and only when the tab has moved on since the guest was made, because
      // assigning `src` its own value is a reload.
      if (element.getAttribute('src') !== tab.url) element.src = tab.url
      return
    }
    if (safely(() => element.getURL()) !== tab.url) void element.loadURL(tab.url).catch(() => {})
  }, [element, tab.url, inline])

  useEffect(() => {
    if (!element || !inline) return
    // A fresh guest has not reached `dom-ready` yet, whatever the last one did.
    ready.current = false
    register(tab.id, element, () => ready.current)
    const report = (): void =>
      onCanGo(tab.id, {
        back: safely(() => element.canGoBack()) ?? false,
        forward: safely(() => element.canGoForward()) ?? false,
      })
    const onDomReady = () => {
      ready.current = true
      const id = safely(() => element.getWebContentsId())
      if (id !== undefined) onReady(tab.id, id)
      applyZoom()
      report()
    }
    // Always set it, 100% included. Chromium *remembers* a zoom per origin
    // for the whole session, so a tab opened fresh on a site somebody once
    // zoomed comes up magnified with the bar insisting it is at 100%. The
    // tab's own level is the truth, in both directions.
    const applyZoom = () => safely(() => element.setZoomLevel(zoomAt.current))
    const onStart = () => onLoading(tab.id, true)
    const onStop = () => {
      onLoading(tab.id, false)
      report()
    }
    const navigated = (event: Event) => {
      onNavigate(tab.id, (event as Event & { url: string }).url)
      applyZoom()
      report()
    }
    /*
      A new page in the same tab. The mark goes when the *site* changes,
      and only then: Chromium reports icons only when the candidate list
      changes, so a second page of the same site sends nothing — and clearing
      on every navigation left it wearing a globe (measured 2026-09-06). It
      still has to go on a change of site rather than wait for a replacement,
      because a site with no icon of its own sends nothing either: go from
      Baidu to such a site and the strip would still say Baidu.
    */
    const leftTheSite = (event: Event) => {
      const url = (event as Event & { url: string }).url
      if (originOf(url) !== originOf(lastUrl.current)) {
        onIcon(tab.id, '')
        lastIcon.current = ''
      }
      lastUrl.current = url
      navigated(event)
    }
    const titled = (event: Event) => onTitle(tab.id, (event as Event & { title: string }).title)
    /*
      A tab without its site's mark is a row of identical globes, which is
      most of what makes a strip readable. The renderer runs under a CSP that
      forbids fetching anything, so the icon is fetched *by the page itself*
      and handed back as a data URL — which the CSP does allow. Anything that
      fails, or is implausibly large for an icon, simply stays a globe.
    */
    const iconed = (event: Event) => {
      const url = (event as Event & { favicons?: string[] }).favicons?.[0]
      if (!url) return
      // The same icon again — a reload, a navigation within the site — is
      // not a change: taking the mark down to put the same one back was a
      // flash of globe on every page. A *different* candidate replaces it:
      // down now, back when it fetches, so a page of the same site that
      // declares no icon gets the globe rather than the site's mark.
      if (url === lastIcon.current) return
      lastIcon.current = url
      onIcon(tab.id, '')
      void element
        .executeJavaScript(
          `fetch(${JSON.stringify(url)}).then(r => r.blob()).then(b => b.size > 102400 ? '' : new Promise(res => {
             const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => res(''); fr.readAsDataURL(b)
           })).catch(() => '')`,
        )
        .then((data) => {
          if (typeof data === 'string' && data.startsWith('data:image')) onIcon(tab.id, data)
        })
        .catch(() => {})
    }
    const found = (event: Event) => {
      const result = (event as Event & { result?: { activeMatchOrdinal?: number; matches?: number } }).result
      onFound({ active: result?.activeMatchOrdinal ?? 0, total: result?.matches ?? 0 })
    }
    /*
      A right-click in the page. Chromium would otherwise draw its own native
      menu, which knows nothing about tabs or about this app, so the pane
      draws its own instead. Electron reports the point in the *embedder's*
      client coordinates, already through any scaling a device preset
      applies — so it is where the menu goes, with no arithmetic of ours.
    */
    const menued = (event: Event) => {
      const params = (event as Event & { params?: PageMenuTarget }).params
      if (params) onPageMenu(params, { x: params.x, y: params.y })
    }
    element.addEventListener('found-in-page', found)
    element.addEventListener('context-menu', menued)
    element.addEventListener('page-favicon-updated', iconed)
    element.addEventListener('dom-ready', onDomReady)
    element.addEventListener('did-start-loading', onStart)
    element.addEventListener('did-stop-loading', onStop)
    element.addEventListener('did-navigate', leftTheSite)
    // A hash change is the same page; its mark stays.
    element.addEventListener('did-navigate-in-page', navigated)
    element.addEventListener('page-title-updated', titled)
    return () => {
      element.removeEventListener('dom-ready', onDomReady)
      element.removeEventListener('did-start-loading', onStart)
      element.removeEventListener('did-stop-loading', onStop)
      element.removeEventListener('did-navigate', leftTheSite)
      element.removeEventListener('did-navigate-in-page', navigated)
      element.removeEventListener('page-title-updated', titled)
      element.removeEventListener('page-favicon-updated', iconed)
      element.removeEventListener('found-in-page', found)
      element.removeEventListener('context-menu', menued)
      ready.current = false
      register(tab.id, null, () => false)
    }
    // `register` and the reporters are stable callbacks from the pane. `zoom`
    // is read at `dom-ready` and applied by the effect below; making it a
    // dependency here would rebuild every listener on each ⌘+.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, tab.id, inline, onReady, onNavigate, onTitle, onLoading, onCanGo, onIcon, onFound, onPageMenu, register])

  useEffect(() => {
    if (!element || !inline || !ready.current) return
    safely(() => element.setZoomLevel(zoom))
  }, [element, inline, zoom])


  const framed = spec.size
    ? {
        width: spec.size.width,
        height: spec.size.height,
        transform: scale < 1 ? `scale(${scale})` : undefined,
      }
    : undefined

  return (
    <div
      className={styles.tabPage}
      role="tabpanel"
      id={`browser-page-${tab.id}`}
      aria-labelledby={`browser-tab-${tab.id}`}
      aria-hidden={!active}
      {...(active ? { 'data-active': '' } : {})}
    >
      <div className={styles.stage} ref={stage} {...(spec.size ? { 'data-framed': '' } : {})}>
        {inline
          ? createElement('webview', {
              key: guestKey,
              ref: setElement,
              src: bornAt,
              partition,
              /*
                Without this a guest may not open windows at all, and the
                shell's window-open handler — the thing that turns a page's
                `target=_blank` into a tab here or a page in the OS browser —
                is never consulted. Every request still ends in that handler,
                which denies the window and routes the URL; no popup is ever
                actually made.
              */
              allowpopups: 'true',
              ...(spec.userAgent ? { useragent: spec.userAgent } : {}),
              className: styles.webview,
              style: framed,
            })
          : tab.url !== BLANK && (
              <iframe
                className={styles.webview}
                style={framed}
                src={tab.url}
                sandbox="allow-scripts allow-forms allow-same-origin"
                title={tabName(tab)}
              />
            )}
      </div>
      {/*
        A blank page is white whatever the theme is: `about:blank` has no
        styles of its own and Chromium's base colour is white, which no
        setting of ours reaches. So the app draws its own empty state over
        the webview — which stays mounted and attached underneath, because
        a tool may be about to drive it.
      */}
      {tab.url === BLANK && (
        <div className={styles.browserEmpty} {...(inline ? { 'data-over': '' } : {})}>
          <span className={styles.browserEmptyMark}>
            <GlobeIcon size={40} />
          </span>
          <span className={styles.browserEmptyTitle}>Nothing open yet</span>
          <p>
            {inline
              ? 'Type a URL above, or let a turn open one. Whatever an agent does in the marked tab happens here, in front of you.'
              : 'Type a URL above. In the desktop app this pane is a full browser; here it shows what allows itself to be framed.'}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * What the agent is doing to this pane right now.
 *
 * The pane is not a viewer bolted onto the app — it is the thing an agent
 * drives, and you are watching over its shoulder. So while a turn is touching
 * the page, the pane says what it is touching and offers the one control that
 * matters: stop.
 *
 * The sentence is the plugin's own description of the tool, never the wire
 * name it registered under. `browser_click` is what you need to write a
 * permission rule; it is not what you need to read over an agent's shoulder.
 */
interface Driving {
  readonly what: string
  readonly who: string
  readonly step: number
  /**
   * The conversation Stop would interrupt, or null when more than one is
   * mid-call and none of them is the one on screen.
   *
   * The shell drives a single guest and two agents may be calling into it at
   * once; from here their calls are simply both in flight. Picking one by the
   * order the session map happens to hold them chooses by when a conversation
   * was opened, which is not authority over anything — and it was wired
   * straight to Stop, so the button could interrupt a turn nobody was looking
   * at. When it cannot be said, it is not said.
   */
  readonly key: SessionKey | null
  readonly info: RuntimeInfo | null
  /** How many conversations are working the page right now. */
  readonly count: number
}

const useDriving = (): Driving | null => {
  const snapshot = useSnapshot()
  const active = snapshot.activeSessionKey

  return useMemo(() => {
    // What the browser plugin's own tools are called, as the plugin described
    // them. Agents namespace them differently on the wire, so the lookup is by
    // the registered name rather than by the one that arrived.
    const known = toolsOfPlugin('browser', snapshot.plugins, snapshot.contributions)

    /** The browser tool one conversation has in flight, if it has one. */
    const inFlight = (key: SessionKey): Driving | null => {
      const session = snapshot.sessions.get(key)
      if (!session) return null
      const turn = currentTurn(session)
      if (!turn || turn.status !== 'inProgress') return null
      for (let index = turn.items.length - 1; index >= 0; index -= 1) {
        const item = turn.items[index]
        if (!item || item.type !== 'toolCall' || item.status !== 'inProgress') continue
        const bare = bareToolName(item.tool)
        // The prefix is the fallback, not the rule: a host that has not yet
        // reported its contributions would otherwise leave this pane saying it
        // is idle while an agent has both hands on the page.
        const what = known.get(bare) ?? (bare.startsWith('browser_') ? toolWords(bare) : null)
        if (!what) continue
        const info = snapshot.runtimes.find((entry) => entry.id === session.runtime) ?? null
        return {
          what,
          who: info?.presentation.name ?? String(session.runtime),
          step: index + 1,
          key,
          info,
          count: 1,
        }
      }
      return null
    }

    /*
     * The conversation beside the pane first, then every other one.
     *
     * Keying this on the active conversation alone was right while the middle
     * of the window always held one. A Room takes the middle now, and a member
     * of that room drives this pane from a conversation that is not "active" —
     * so the pane sat there saying *Idle* with both of an agent's hands on the
     * page. The tab is driven by whoever called the tool; that is the only
     * thing this can honestly be read from.
     */
    if (active) {
      const here = inFlight(active)
      if (here) return { ...here, count: 1 }
    }

    /*
     * With nothing in the middle, every other conversation is equally a
     * candidate — so they are all collected rather than raced. One is an
     * answer. More than one is a fact the pane can state and an owner it
     * cannot name: their calls are concurrent, the shell drives one guest, and
     * the session map's order records when each was opened. Naming one there
     * would be a guess, and the guess was wired to Stop.
     */
    const others: Driving[] = []
    for (const key of snapshot.sessions.keys()) {
      if (key === active) continue
      const hit = inFlight(key)
      if (hit) others.push({ ...hit, count: 1 })
    }
    if (others.length === 1) return others[0] ?? null
    if (others.length > 1) {
      return {
        what: `${others.length} conversations are working this page`,
        // Said where the one name would have been: the way to stop a
        // particular turn is to stop it where that turn is.
        who: 'Stop it from the conversation you mean to stop',
        step: 0,
        key: null,
        info: null,
        count: others.length,
      }
    }
    return null
  }, [active, snapshot.sessions, snapshot.plugins, snapshot.contributions, snapshot.runtimes])
}

export const BrowserPane = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const mount = useMount()
  const view: BrowserView | null = mount?.view.kind === 'browser' ? mount.view : null
  /* The id of whatever is holding this browser — a pane in the split tree or a
     tab in a panel strip. Every verb below takes it, and none of them cares
     which kind it is; that is what let the browser leave the middle. */
  const paneId = mount?.id ?? null
  const inline = hasInlineBrowser()
  const prefs = snapshot.browserPrefs
  const driving = useDriving()

  /** The runtime of the conversation beside this pane, for the driven mark. */
  const activeRuntime = useMemo(() => {
    const key = snapshot.activeSessionKey
    const session = key ? (snapshot.sessions.get(key) ?? null) : null
    if (!session) return null
    return snapshot.runtimes.find((entry) => entry.id === session.runtime) ?? null
  }, [snapshot.activeSessionKey, snapshot.sessions, snapshot.runtimes])

  /*
   * Who would receive the browser tools if a turn asked for them now.
   *
   * Three sources, most specific first: whoever is driving the pane right this
   * second, then the conversation beside it, then the backend the desk is set
   * to. Reading only the middle one was wrong wherever the middle is not a
   * conversation — with a Room open there is no active session, so the driven
   * tab lost its mark and both menus refused with "This agent cannot receive
   * browser tools" while an agent was, in fact, driving that very tab.
   */
  const drivingRuntime =
    driving?.info ??
    activeRuntime ??
    snapshot.runtimes.find((entry) => entry.id === snapshot.activeRuntime) ??
    null
  const canDrive = drivingRuntime?.capabilities.pluginTools ?? false
  /*
   * Who the mark is allowed to *name*, which is a narrower question than who
   * could drive. Whoever has the wheel this second, else the conversation
   * beside the pane — a real relationship, since that is the agent whose next
   * turn would drive it. Never the selected backend: in a room of Cursor and
   * Claude Code that put "Codex" on a tab Codex has never touched.
   */
  const namedDriver = driving?.info ?? activeRuntime

  const tab = view ? activeBrowserTab(view) : null
  const spec = browserDevice(tab?.device)
  const DeviceGlyph = DEVICE_ICONS[spec.id]

  const [address, setAddress] = useState(tab?.url ?? BLANK)
  const [typing, setTyping] = useState(false)
  /** Site marks, by tab. Kept out of the layout: they are cheap to fetch again. */
  const [icons, setIcons] = useState<Record<string, string>>({})
  /** The tab being dragged along the strip, and where it would land. */
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null)
  const addressBox = useRef<HTMLInputElement>(null)
  /** The right-click menu, and which tab it was opened on. */
  const menu = useContextMenu()
  const [menuTab, setMenuTab] = useState<BrowserTab | null>(null)
  const tabMenu = {
    at: menu.at,
    tab: menuTab,
    open: (event: ReactMouseEvent, entry: BrowserTab) => {
      setMenuTab(entry)
      menu.open(event)
    },
    close: () => {
      menu.close()
      setMenuTab(null)
    },
  }
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [canGo, setCanGo] = useState<Record<string, { back: boolean; forward: boolean }>>({})
  /**
   * Find in page. Open or shut is a property of the pane, not of a tab: ⌘F
   * asks about the page you are looking at, and moving to another tab is
   * how you stop asking. The counts come back from the guest.
   */
  const [find, setFind] = useState<{ query: string; active: number; total: number } | null>(null)
  const findBox = useRef<HTMLInputElement>(null)
  /** What the guest was last asked to look for — it outlives the bar. */
  const searched = useRef('')
  /**
   * Zoom by tab, in Chromium levels. Kept here, not in the layout: it is
   * about this sitting, and a restored session opens at 100% like Chrome.
   * The ref is what stepping reads — two ⌘+ in one frame have to compose,
   * and a state variable read from a closure would give the same answer to
   * both, so a held key would move the page exactly one rung.
   */
  const [zoom, setZoom] = useState<Record<string, number>>({})
  const zoomRef = useRef<Record<string, number>>({})
  /** A right-click inside a page: where, and on what. */
  const [pageMenu, setPageMenu] = useState<{ at: { x: number; y: number }; target: PageMenuTarget } | null>(null)
  const strip = useTabStrip(view?.active, view?.tabs.length ?? 0)

  /** Each tab's element and its readiness, for the controls to act through. */
  const elements = useRef(new Map<string, { element: WebviewElement; ready: () => boolean }>())
  /**
   * Each tab's `webContents` id, so the driven one can be named to the shell.
   * Entries for closed tabs are left alone: only `view.driven` and
   * `view.active` are ever looked up, and both always name a live tab.
   */
  const guests = useRef(new Map<string, number>())
  /** The id last reported as driven, so it is not reported twice. */
  const reported = useRef<number | null>(null)

  // Sessions are kept or not; either way the guests are the app's own, never
  // the person's Chrome profile.
  const partition = prefs.persistSession ? 'persist:harnessdesk-browser' : 'harnessdesk-browser-once'

  const register = useCallback((tabId: string, element: WebviewElement | null, ready: () => boolean) => {
    if (element) elements.current.set(tabId, { element, ready })
    else elements.current.delete(tabId)
  }, [])

  /** The active tab's element, if it can be spoken to yet. */
  const act = useCallback(
    (action: (element: WebviewElement) => void) => {
      const entry = view ? elements.current.get(view.active) : undefined
      if (entry?.ready()) safely(() => action(entry.element))
    },
    [view],
  )

  // Only the tab on screen can be searched or right-clicked, so neither
  // reporter needs to say which tab it speaks for.
  const onFound = useCallback((result: { active: number; total: number }) => {
    setFind((current) => (current ? { ...current, ...result } : current))
  }, [])

  const onPageMenu = useCallback((target: PageMenuTarget, at: { x: number; y: number }) => {
    setPageMenu({ at, target })
  }, [])

  const onReady = useCallback((tabId: string, webContentsId: number) => {
    guests.current.set(tabId, webContentsId)
    // Reported below, by the effect that watches which tab is driven.
    reported.current = null
  }, [])

  const onNavigate = useCallback(
    (tabId: string, url: string) => {
      if (paneId) store.noteBrowserUrl(paneId, tabId, url)
    },
    [paneId, store],
  )

  const onTitle = useCallback(
    (tabId: string, title: string) => {
      if (paneId) store.noteBrowserTitle(paneId, tabId, title)
    },
    [paneId, store],
  )

  const onLoading = useCallback((tabId: string, busy: boolean) => {
    setLoading((was) => (was[tabId] === busy ? was : { ...was, [tabId]: busy }))
  }, [])

  const onCanGo = useCallback((tabId: string, next: { back: boolean; forward: boolean }) => {
    setCanGo((was) =>
      was[tabId]?.back === next.back && was[tabId]?.forward === next.forward ? was : { ...was, [tabId]: next },
    )
  }, [])

  const onIcon = useCallback((tabId: string, dataUrl: string) => {
    setIcons((was) => {
      // An empty mark means "this tab left the site it had one for".
      if (!dataUrl) {
        if (!(tabId in was)) return was
        const { [tabId]: gone, ...rest } = was
        void gone
        return rest
      }
      return was[tabId] === dataUrl ? was : { ...was, [tabId]: dataUrl }
    })
  }, [])

  /** Puts the caret in the address bar with the URL selected, as ⌘L does. */
  const focusAddress = useCallback(() => {
    const box = addressBox.current
    if (!box) return
    box.focus()
    box.select()
  }, [])

  /**
   * Find in page, driven by the guest rather than by us: Chromium highlights
   * every match, scrolls the active one into view and counts them, and the
   * bar only shows what comes back. Closing clears the highlight — a page
   * left painted yellow after the bar is gone is a bug people report.
   */
  const search = useCallback(
    (query: string, options?: { next?: boolean; forward?: boolean }) => {
      if (!query) {
        act((element) => element.stopFindInPage('clearSelection'))
        setFind((current) => (current ? { ...current, query, active: 0, total: 0 } : current))
        return
      }
      /*
        Chromium answers a find request only when something changed. Ask it
        for the same text twice as a *new* search — close the bar and look
        for the same word again, which is what a person does — and it stays
        silent, leaving the bar reading "No results" over a page full of
        highlighted matches. Telling it the repeat is a follow-up gets the
        count back; that walks the active match on by one, which is what
        pressing Enter would have done anyway.
      */
      const repeat = searched.current === query
      searched.current = query
      /*
        `findNext` is only ever *sent* as true. Chromium answers a request
        that spells out `findNext: false` with silence — no `found-in-page`
        at all, measured on Electron 42 — so the bar read "No results" over
        a page full of highlighted matches until Enter asked again as a
        follow-up. A first request is one with the option left out.
      */
      const next = options?.next ?? repeat
      act((element) =>
        element.findInPage(query, {
          ...(next ? { findNext: true } : {}),
          forward: options?.forward ?? true,
        }),
      )
    },
    [act],
  )

  const closeFind = useCallback(() => {
    act((element) => element.stopFindInPage('clearSelection'))
    setFind(null)
  }, [act])

  const openFind = useCallback(() => {
    setFind((current) => current ?? { query: '', active: 0, total: 0 })
    window.setTimeout(() => findBox.current?.select(), 0)
  }, [])

  /** ⌘+, ⌘− and ⌘0, applied to the tab you are looking at. */
  const changeZoom = useCallback(
    (to: 'in' | 'out' | 'reset') => {
      if (!view) return
      const current = zoomRef.current[view.active] ?? 0
      const next = to === 'reset' ? 0 : stepZoom(current, to === 'in' ? 1 : -1)
      if (next === current) return
      zoomRef.current = { ...zoomRef.current, [view.active]: next }
      setZoom(zoomRef.current)
    },
    [view],
  )

  // The shell drives one guest. Whenever the driven tab changes — or its
  // webview attaches — it is named again, so `browser_open` and everything
  // after it land on the page wearing the mark.
  const driven = view?.driven ?? null
  // Deliberately every render: the id arrives from a webview event rather
  // than from a prop, so there is nothing to depend on. `reported` keeps it
  // to one call per guest.
  useEffect(() => {
    if (!inline || !driven) return
    const id = guests.current.get(driven)
    if (id === undefined || id === reported.current) return
    reported.current = id
    desktop()?.browserReady?.(id)
  })

  useEffect(() => {
    if (!inline) return
    const bridge = desktop()
    return () => bridge?.browserGone?.()
  }, [inline])

  // A page's `target=_blank` is handled in the shell, which either hands the
  // link back here as a tab or sends it to the OS browser. The preference
  // lives in the renderer, so the shell is told on every change.
  useEffect(() => {
    desktop()?.setBrowserLinksInPane?.(prefs.linksInPane)
  }, [prefs.linksInPane])

  useEffect(() => {
    if (!paneId) return
    return desktop()?.onBrowserOpenTab?.((url) => store.newBrowserTab(paneId, url))
  }, [paneId, store])

  // While the person is typing, the bar is theirs; otherwise it follows the
  // tab, including when an agent navigates it under them.
  useEffect(() => {
    if (!typing) setAddress(tab?.url ?? BLANK)
  }, [tab?.url, tab?.id, typing])

  const go = (event: FormEvent) => {
    event.preventDefault()
    if (!paneId || !view) return
    const url = normaliseUrl(address)
    setAddress(url)
    setTyping(false)
    // One path to a navigation: the tab's URL changes and the page's effect
    // loads it. Loading here as well raced that and aborted one of the two.
    if (url === tab?.url) act((element) => element.reload())
    else store.noteBrowserUrl(paneId, view.active, url)
  }

  const saveScreenshot = useCallback(async () => {
    if (!view) return
    const id = guests.current.get(view.active)
    const bridge = desktop()
    if (id === undefined || !bridge?.saveBrowserScreenshot) {
      store.notice('warning', 'Screenshots are saved from the desktop app.')
      return
    }
    try {
      const path = await bridge.saveBrowserScreenshot(id, tab ? tabName(tab) : 'screenshot')
      if (path) store.notice('info', `Saved ${path}`)
    } catch (error) {
      store.notice('error', error instanceof Error ? error.message : String(error))
    }
  }, [store, tab, view])

  /**
   * Hands something to the conversation's composer.
   *
   * The composer only listens while its own pane has the focus, and choosing
   * anything from this pane's menu put the focus here. So the conversation
   * gets the focus back first and the hand-over waits a frame for the
   * listener that comes with it — without that the page went nowhere while
   * the notice said it had been sent. With a room in the middle there is no
   * conversation to hand it to, and saying so beats a notice that lies.
   */
  const compose = useCallback(
    async (request: ComposeRequest): Promise<boolean> => {
      const conversation = conversationPane(store.getSnapshot().layout)
      if (!conversation) {
        store.notice('warning', 'Open a conversation first — this goes into its message box.')
        return false
      }
      store.focusPane(conversation.id)
      // Asked for a receipt rather than dispatched on a guessed frame: the
      // composer registers its listener in an effect, and one frame was not
      // always enough (`lib/compose`).
      const taken = await handOverToComposer(request)
      if (!taken) store.notice('warning', 'The message box did not take it — click into the conversation and try again.')
      return taken
    },
    [store],
  )

  const sendPageToChat = useCallback(async () => {
    if (!view) return
    const entry = elements.current.get(view.active)
    if (!entry?.ready()) return
    const element = entry.element
    const title = element.getTitle() || element.getURL()
    const acceptsImages = activeRuntime?.capabilities.imageInput ?? false

    try {
      let sent: boolean
      if (acceptsImages && typeof element.capturePage === 'function') {
        const image = await element.capturePage()
        const dataUrl = image.toDataURL()
        sent = await compose({ text: '', attachments: [{ name: title, path: dataUrl, kind: 'image' }] })
      } else {
        const text = await element.executeJavaScript('document.body.innerText') as string
        const trimmed = typeof text === 'string' ? text.slice(0, 8000) : ''
        sent = await compose({ text: `[Page: ${title}]\n${trimmed}`, replace: false })
      }
      if (sent) store.notice('info', `Page sent to chat.`)
    } catch (error) {
      store.notice('error', error instanceof Error ? error.message : String(error))
    }
  }, [activeRuntime, compose, store, view])

  /*
    Annotating the page: a comment on an element, on a dragged region, or a
    freehand mark. The gesture itself lives inside the guest — a <webview> is
    opaque to the window around it, so nothing out here can know what is
    under the pointer (`lib/annotate`). What this side owns is the mode, the
    count, and what happens when the marks are handed over: the same
    `<context source=…>` envelope every other injected context travels in,
    with the page's own picture of them beside it.
  */
  const [annotate, setAnnotate] = useState<'comment' | 'draw' | null>(null)
  const [marks, setMarks] = useState(0)
  const annotateMode = useRef<'comment' | 'draw'>('comment')

  const guest = useCallback((): WebviewElement | null => {
    if (!view) return null
    const entry = elements.current.get(view.active)
    return entry?.ready() ? entry.element : null
  }, [view])

  const annotating = annotate !== null
  // The tab the overlay is up in, so that leaving it takes the overlay down
  // in the page it was put up in rather than in whatever is showing now.
  const annotatedTab = view?.active

  useEffect(() => {
    if (!annotating || !annotatedTab) return
    // No shell, no isolated world, no annotating: saying so beats a mode
    // that looks armed and marks nothing.
    if (!desktop()?.annotateInPage) {
      store.notice('warning', 'Annotating needs the desktop app.')
      setAnnotate(null)
      return
    }
    const entry = elements.current.get(annotatedTab)
    let alive = true
    const tick = async (): Promise<void> => {
      if (!entry?.ready()) return
      try {
        // A page that navigated or reloaded took the overlay with it. The
        // mode belongs to the pane, not to the document, so it goes back up
        // rather than quietly ending when a page reloads under it.
        if (!(await inOverlayWorld(entry.element, ANNOTATE_ALIVE))) {
          await inOverlayWorld(entry.element, ANNOTATE_SOURCE)
          await inOverlayWorld(entry.element, annotateCall('setMode', annotateMode.current))
        }
        const list = readAnnotations(await inOverlayWorld(entry.element, annotateCall('list')))
        if (alive) setMarks(list.length)
      } catch {
        // Mid-navigation a guest throws at everything; the next tick finds it.
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 700)
    return () => {
      alive = false
      window.clearInterval(timer)
      // Leaving the mode — or the tab — takes the overlay down where it was
      // put up. A page left dressed for annotating would swallow every click
      // in a pane nobody is annotating in any more.
      //
      // `safely`, because this is exactly where the webview is often already
      // gone: a workspace change rebuilds the layout, and a detached guest
      // can throw at the id lookup itself — a throw escaping a cleanup takes
      // the whole renderer down with it.
      safely(() => {
        if (entry) void inOverlayWorld(entry.element, annotateCall('stop')).catch(() => {})
      })
    }
  }, [annotating, annotatedTab, store])

  // The tool, separately: switching between comment and pen must not tear the
  // overlay down and take the marks already made with it.
  useEffect(() => {
    if (!annotate) return
    annotateMode.current = annotate
    safely(() => {
      const element = guest()
      if (element) void inOverlayWorld(element, annotateCall('setMode', annotate)).catch(() => {})
    })
  }, [annotate, guest])

  const clearAnnotations = useCallback(() => {
    safely(() => {
      const element = guest()
      if (element) void inOverlayWorld(element, annotateCall('clear')).catch(() => {})
    })
    setMarks(0)
  }, [guest])

  const addAnnotations = useCallback(async () => {
    const element = guest()
    if (!element) return
    // Whichever agent this would go to: the conversation's own, or the one
    // the composer is set to when no conversation is open yet. Only an agent
    // that has actually said it takes no images gets the sentence saying so —
    // "no agent yet" is not the same answer, and the picture still travels.
    const target =
      activeRuntime ?? snapshot.runtimes.find((entry) => entry.id === snapshot.activeRuntime) ?? null
    const acceptsImages = target ? target.capabilities.imageInput : true
    try {
      // The hover box and the half-typed comment are furniture, not marks:
      // they come down before the picture is taken.
      await inOverlayWorld(element, annotateCall('prepare'))
      const list = readAnnotations(await inOverlayWorld(element, annotateCall('list')))
      if (list.length === 0) {
        store.notice('info', 'Nothing marked yet — click an element, drag a region, or draw on the page.')
        return
      }
      const image =
        acceptsImages && typeof element.capturePage === 'function' ? await element.capturePage() : null
      const title = element.getTitle() || element.getURL()
      const body = annotationContext({ title, url: element.getURL() }, list, { withImage: image !== null })
      // The block rides as a chip, not as text: the box holds what a person
      // typed, and an envelope pasted into it is neither readable nor theirs
      // to edit. It is the picture's caption, so it goes first.
      const block = wrapContext(ANNOTATION_LABEL, body)
      const sent = await compose({
        text: '',
        attachments: [
          {
            name: `${ANNOTATION_LABEL} — ${annotationSummary(list)}`,
            path: noteKey(ANNOTATION_LABEL, block),
            kind: 'note' as const,
            text: block,
          },
          ...(image
            ? [{ name: `${title} — annotated`, path: image.toDataURL(), kind: 'image' as const }]
            : []),
        ],
      })
      if (!sent) return
      setAnnotate(null)
      setMarks(0)
      store.notice('info', `${annotationSummary(list)} added to your message.`)
    } catch (error) {
      store.notice('error', error instanceof Error ? error.message : String(error))
    }
  }, [activeRuntime, compose, guest, snapshot.activeRuntime, snapshot.runtimes, store])

  /*
    A browser's keys, while this pane is the one you are working in: ⌘T, ⌘W,
    ⌘L, ⌘1–9, ⌘[ and ⌘]. They run in the capture phase and stop what they
    handle, because the app binds ⌘W to "close pane" — in a browser ⌘W closes
    the tab, and only the *last* tab takes the panel with it, which is what a
    window does anyway.
  */
  /* Both halves of focus: this browser is usually docked to the right now, and
   `layout.focused` names panes only — the shortcuts stopped arming entirely
   the day the browser stopped being a pane. */
  const focused = focusedMount(snapshot.workbench) === paneId
  useEffect(() => {
    if (!focused || !paneId || !view) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const take = (): void => {
        event.preventDefault()
        event.stopPropagation()
      }
      const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : null
      if (digit !== null) {
        const target = digit === 9 ? view.tabs[view.tabs.length - 1] : view.tabs[digit - 1]
        if (target) {
          take()
          store.selectBrowserTab(paneId, target.id)
        }
        return
      }
      // Shift changes the letter the layout reports — ⌘⇧T arrives as `T` on
      // some keyboards and as `t` on others — so the modifier decides what
      // the key means, never the case of the character.
      switch (event.key.toLowerCase()) {
        case 't':
          take()
          if (event.shiftKey) {
            // ⌘⇧T, the universal "I did not mean to close that".
            store.reopenClosedBrowserTab(paneId)
            return
          }
          store.newBrowserTab(paneId)
          // A new tab wants a URL; the caret goes where you would put it.
          window.setTimeout(focusAddress, 0)
          return
        case 'w':
          if (event.shiftKey) return
          take()
          store.closeBrowserTab(paneId, view.active)
          return
        case 'l':
          take()
          focusAddress()
          return
        case 'r':
          // ⌘R reloads the page, ⌘⇧R without its caches — a browser's own
          // keys, and the two Codex lists as commands. Taken here so the
          // app's reload never reaches the window while a page has focus.
          take()
          act((element) => (event.shiftKey ? element.reloadIgnoringCache() : element.reload()))
          return
        case 'f':
          if (event.shiftKey) return
          take()
          openFind()
          return
        case '=':
        case '+':
          take()
          changeZoom('in')
          return
        case '-':
          take()
          changeZoom('out')
          return
        case '0':
          take()
          changeZoom('reset')
          return
        case '[':
          take()
          act((element) => element.goBack())
          return
        case ']':
          take()
          act((element) => element.goForward())
          return
        default:
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [focused, paneId, view, store, act, focusAddress, openFind, changeZoom])

  // A search belongs to the page it was typed against. Moving to another tab
  // ends it — and clears the highlight the guest left behind.
  const activeTab = view?.active
  useEffect(() => {
    setFind(null)
  }, [activeTab])

  const busy = view ? (loading[view.active] ?? false) : false
  const arrows = view ? (canGo[view.active] ?? { back: false, forward: false }) : { back: false, forward: false }
  const tabs = useMemo(() => view?.tabs ?? [], [view])

  if (!mount || !view || !tab || !paneId) return null

  return (
    <div className={styles.pane}>
      <ToolPaneHeader
        title="Browser"
        lead={
          <div className={styles.tabStrip}>
            <div
              className={styles.tabs}
              role="tablist"
              aria-label="Browser tabs"
              onDoubleClick={(event) => {
                // Only the strip's own empty space, not a tab inside it.
                if (event.target === event.currentTarget) store.newBrowserTab(paneId)
              }}
              ref={strip.strip}
              onScroll={strip.measure}
              {...stripEdges(strip.edges)}
            >
              {tabs.map((entry, index) => {
                const isActive = entry.id === view.active
                const name = tabName(entry)
                const icon = icons[entry.id]
                return (
                  <span
                    key={entry.id}
                    className={styles.tab}
                    role="tab"
                    id={`browser-tab-${entry.id}`}
                    aria-controls={`browser-page-${entry.id}`}
                    aria-selected={isActive}
                    tabIndex={0}
                    draggable
                    {...(isActive ? { 'data-active': '' } : {})}
                    {...(drag?.id === entry.id ? { 'data-dragging': '' } : {})}
                    {...(drag && drag.id !== entry.id && drag.over === index ? { 'data-drop': '' } : {})}
                    onClick={() => store.selectBrowserTab(paneId, entry.id)}
                    onKeyDown={(event) => {
                      // A tab is a span, so that the close button can sit
                      // inside it; the keyboard has to be given what a
                      // button would have brought.
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      store.selectBrowserTab(paneId, entry.id)
                    }}
                    onAuxClick={(event) => {
                      // Middle click closes a tab, as it does everywhere else.
                      if (event.button === 1) store.closeBrowserTab(paneId, entry.id)
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      tabMenu.open(event, entry)
                    }}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      // Firefox and Chromium both need *something* set, and a
                      // tab is only ever dropped back onto this strip.
                      event.dataTransfer.setData('text/plain', entry.id)
                      setDrag({ id: entry.id, over: index })
                    }}
                    onDragOver={(event) => {
                      if (!drag) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      setDrag((was) => (was && was.over !== index ? { ...was, over: index } : was))
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (drag) store.moveBrowserTab(paneId, drag.id, index)
                      setDrag(null)
                    }}
                    onDragEnd={() => setDrag(null)}
                    title={entry.url === BLANK ? name : `${name}\n${entry.url}`}
                  >
                    {icon ? (
                      <img className={styles.tabIcon} src={icon} alt="" aria-hidden="true" />
                    ) : (
                      <GlobeIcon size={13} />
                    )}
                    <span className={styles.tabLabel}>{name}</span>
                    {/* The mark is *offered* on capability — `drivingRuntime`,
                        which falls back to the selected backend, because "can
                        anything here drive a page" is a question the window can
                        always answer. It is *named* only from whoever has the
                        wheel this second: a fallback there puts a real agent's
                        name on a tab it has never touched, and a room of Cursor
                        and Claude Code read "Codex". */}
                    {entry.id === view.driven && canDrive && (
                      <span className={styles.tabDriven} title={`${namedDriver?.presentation.name ?? 'Agents'} drive${namedDriver ? 's' : ''} this tab`}>
                        <span className={styles.tabDrivenDot} />
                        {namedDriver?.presentation.name ?? 'Agents'}
                      </span>
                    )}
                    <button
                      type="button"
                      className={styles.tabClose}
                      onClick={(event) => {
                        event.stopPropagation()
                        store.closeBrowserTab(paneId, entry.id)
                      }}
                      title={tabs.length === 1 ? 'Close the browser' : 'Close this tab'}
                      aria-label={`Close ${name}`}
                    >
                      <CrossIcon size={11} />
                    </button>
                  </span>
                )
              })}
            </div>
            <button
              type="button"
              className={styles.tabAdd}
              onClick={() => store.newBrowserTab(paneId)}
              title="New tab"
              aria-label="New tab"
            >
              <PlusIcon size={12} />
            </button>
          </div>
        }
      >
        <Popover
          label={<MoreIcon size={14} />}
          title="Browser settings"
          triggerClassName={styles.headerButton}
          align="right"
        >
          {(close) => (
            <Menu close={close}>
              <MenuItem
                icon={<CameraIcon size={14} />}
                label="Save screenshot…"
                disabled={inline ? false : 'The desktop app takes the picture.'}
                onSelect={() => void saveScreenshot()}
              />
              <MenuItem
                icon={<PaperclipIcon size={14} />}
                label="Send page to chat"
                disabled={tab.url === BLANK ? 'This tab has no page yet.' : false}
                onSelect={() => void sendPageToChat()}
              />
              <MenuItem
                icon={<DevToolsIcon size={14} />}
                label="Open developer tools"
                disabled={inline ? false : 'Only in the desktop app.'}
                onSelect={() => act((element) => element.openDevTools())}
              />
              <MenuSeparator />
              <MenuItem
                icon={<SearchIcon size={14} />}
                label="Find in page"
                value="⌘F"
                disabled={inline ? false : 'Only in the desktop app.'}
                onSelect={openFind}
              />
              <MenuItem
                icon={<ZoomInIcon size={14} />}
                label="Zoom in"
                value="⌘+"
                disabled={inline ? false : 'Only in the desktop app.'}
                onSelect={() => changeZoom('in')}
              />
              <MenuItem
                icon={<ZoomOutIcon size={14} />}
                label="Zoom out"
                value="⌘−"
                disabled={inline ? false : 'Only in the desktop app.'}
                onSelect={() => changeZoom('out')}
              />
              <MenuItem
                label="Actual size"
                value={`${zoomPercent(zoom[view.active] ?? 0)}%`}
                disabled={(zoom[view.active] ?? 0) === 0 ? 'The page is already at 100%.' : false}
                onSelect={() => changeZoom('reset')}
              />
              <MenuSeparator />
              <MenuItem
                icon={<ExternalIcon size={14} />}
                label="Open in default browser"
                disabled={tab.url === BLANK ? 'This tab has no page yet.' : false}
                onSelect={() => openExternal(tab.url)}
              />
              <MenuSeparator />
              <MenuItem
                icon={<GlobeIcon size={14} />}
                label="Browser tools drive this tab"
                selected={view.driven === view.active}
                disabled={canDrive ? false : `${drivingRuntime?.presentation.name ?? 'This agent'} cannot receive browser tools.`}
                onSelect={() => store.setBrowserDriven(paneId, view.active)}
              />
              <MenuSeparator />
              <MenuToggle
                label="Open links in Browser pane"
                hint="Otherwise a page's new windows leave for the system browser."
                checked={prefs.linksInPane}
                onChange={(next) => store.setBrowserPrefs({ linksInPane: next })}
              />
              <MenuToggle
                label="Persist sessions"
                hint={prefs.persistSession ? 'Cookies and logins survive a restart.' : 'Nothing is kept; pages reload signed out.'}
                checked={prefs.persistSession}
                onChange={(next) => store.setBrowserPrefs({ persistSession: next })}
              />
              <MenuItem
                icon={<TrashIcon size={14} />}
                label="Clear browsing data"
                hint="Cookies, storage and caches for the pane's pages."
                danger
                disabled={inline ? false : 'Only in the desktop app.'}
                onSelect={() => {
                  void desktop()
                    ?.clearBrowserData?.()
                    .then(() => store.notice('info', 'The browser pane’s cookies and storage were cleared.'))
                    .catch((error: unknown) =>
                      store.notice('error', error instanceof Error ? error.message : String(error)),
                    )
                }}
              />
            </Menu>
          )}
        </Popover>
      </ToolPaneHeader>
      <form className={styles.addressBar} onSubmit={go}>
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => act((element) => element.goBack())}
          disabled={!arrows.back}
          title="Back"
          aria-label="Back"
        >
          <ArrowLeftIcon size={14} />
        </button>
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => act((element) => element.goForward())}
          disabled={!arrows.forward}
          title="Forward"
          aria-label="Forward"
        >
          <ArrowRightIcon size={14} />
        </button>
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => act((element) => (busy ? element.stop() : element.reload()))}
          title={busy ? 'Stop loading' : 'Reload'}
          aria-label={busy ? 'Stop' : 'Reload'}
        >
          {busy ? <CrossIcon size={14} /> : <RetryIcon size={14} />}
        </button>
        <input
          ref={addressBox}
          className={styles.address}
          value={address === BLANK ? '' : address}
          placeholder="Enter a URL, or something to search for"
          spellCheck={false}
          onChange={(event) => {
            setTyping(true)
            setAddress(event.target.value)
          }}
          onFocus={(event) => event.target.select()}
          onBlur={() => setTyping(false)}
          aria-label="Address"
        />
        {busy && <span className={styles.addressLoading} aria-label="Loading" />}
        {/* Chrome shows the level in the omnibox while a page is not at
            100%, and offers the way back in one click. So does this. */}
        {(zoom[view.active] ?? 0) !== 0 && (
          <button
            type="button"
            className={styles.zoomLevel}
            onClick={() => changeZoom('reset')}
            title="Back to actual size"
          >
            {zoomPercent(zoom[view.active] ?? 0)}%
          </button>
        )}
        <Popover
          label={<DeviceGlyph size={14} />}
          title={`Size: ${spec.label}`}
          triggerClassName={styles.headerButton}
          align="right"
        >
          {(close) => (
            <Menu close={close}>
              {BROWSER_DEVICES.map((entry) => {
                const Glyph = DEVICE_ICONS[entry.id]
                return (
                  <MenuItem
                    key={entry.id}
                    icon={<Glyph size={14} />}
                    label={entry.label}
                    value={entry.size ? `${entry.size.width} × ${entry.size.height}` : undefined}
                    selected={entry.id === spec.id}
                    onSelect={() => store.setBrowserDevice(paneId, view.active, entry.id)}
                  />
                )
              })}
            </Menu>
          )}
        </Popover>
        {/* Point at the thing you mean. Both incumbents have this; ours puts
            it beside the device sizes, because it is the same kind of switch
            — a way of looking at the page rather than a place to go. */}
        <button
          type="button"
          className={styles.headerButton}
          {...(annotating ? { 'data-primary': '' } : {})}
          onClick={() => setAnnotate(annotating ? null : 'comment')}
          disabled={!inline || tab.url === BLANK}
          title={
            inline
              ? annotating
                ? 'Stop annotating'
                : 'Annotate the page — comment on an element, a region, or draw'
              : 'Only in the desktop app.'
          }
          aria-label="Annotate the page"
          aria-pressed={annotating}
        >
          <AnnotateIcon size={14} />
        </button>
      </form>
      {/*
        The annotating bar, under the address row for the same reason the
        find bar is: a control drawn over the page covers the very thing it
        is about. It stays while marks are made and leaves with them.
      */}
      {annotate && (
        <div className={styles.annotateBar}>
          <div className={styles.annotateTools} role="group" aria-label="Annotation tool">
            <button
              type="button"
              className={styles.annotateTool}
              {...(annotate === 'comment' ? { 'data-on': '' } : {})}
              aria-pressed={annotate === 'comment'}
              onClick={() => setAnnotate('comment')}
            >
              <AnnotateIcon size={13} />
              Comment
            </button>
            <button
              type="button"
              className={styles.annotateTool}
              {...(annotate === 'draw' ? { 'data-on': '' } : {})}
              aria-pressed={annotate === 'draw'}
              onClick={() => setAnnotate('draw')}
            >
              <PencilIcon size={13} />
              Draw
            </button>
          </div>
          <span className={styles.annotateHint}>
            {annotate === 'comment'
              ? 'Click an element or drag a region, then say what you mean.'
              : 'Draw on the page, then say what you mean.'}
          </span>
          <span className={styles.findCount} aria-live="polite">
            {marks === 0 ? '' : `${marks} mark${marks === 1 ? '' : 's'}`}
          </span>
          <button
            type="button"
            className={styles.headerButton}
            onClick={clearAnnotations}
            disabled={marks === 0}
            title="Clear the marks"
            aria-label="Clear the marks"
          >
            <TrashIcon size={14} />
          </button>
          <button
            type="button"
            className={styles.headerButton}
            data-primary=""
            onClick={() => void addAnnotations()}
            disabled={marks === 0}
            title="Add the marks and a picture of them to your message"
          >
            Add to message
          </button>
          <button
            type="button"
            className={styles.headerButton}
            onClick={() => setAnnotate(null)}
            title="Stop annotating"
            aria-label="Stop annotating"
          >
            <CrossIcon size={14} />
          </button>
        </div>
      )}
      {/*
        The find bar. It sits under the address bar rather than floating over
        the page, because a floating bar covers the very text it just found.
        Enter walks forward, ⇧Enter back, Escape puts the page back the way
        it was.
      */}
      {find && (
        <div className={styles.findBar}>
          <input
            ref={findBox}
            className={styles.address}
            value={find.query}
            placeholder="Find in page"
            spellCheck={false}
            autoComplete="off"
            aria-label="Find in page"
            onChange={(event) => {
              setFind({ query: event.target.value, active: 0, total: 0 })
              search(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeFind()
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              search(find.query, { next: true, forward: !event.shiftKey })
            }}
          />
          <span className={styles.findCount} aria-live="polite">
            {find.query === '' ? '' : find.total === 0 ? 'No results' : `${find.active}/${find.total}`}
          </span>
          <button
            type="button"
            className={styles.headerButton}
            onClick={() => search(find.query, { next: true, forward: false })}
            disabled={find.total === 0}
            title="Previous match"
            aria-label="Previous match"
          >
            <ArrowLeftIcon size={14} />
          </button>
          <button
            type="button"
            className={styles.headerButton}
            onClick={() => search(find.query, { next: true, forward: true })}
            disabled={find.total === 0}
            title="Next match"
            aria-label="Next match"
          >
            <ArrowRightIcon size={14} />
          </button>
          <button
            type="button"
            className={styles.headerButton}
            onClick={closeFind}
            title="Close find"
            aria-label="Close find"
          >
            <CrossIcon size={14} />
          </button>
        </div>
      )}
      {/*
        A right-click inside the page. Chromium's own menu would offer
        "Open link in new tab" and mean a window this app does not have, so
        the pane answers with tabs it owns — and with the two things a
        person debugging a page actually reaches for: the real browser, and
        the element inspector at the exact point they clicked.
      */}
      <ContextMenu at={pageMenu?.at ?? null} label="Page" onClose={() => setPageMenu(null)}>
        {pageMenu && (
          <>
            {pageMenu.target.linkURL && (
              <>
                <MenuItem
                  label="Open link in new tab"
                  onSelect={() => store.newBrowserTab(paneId, pageMenu.target.linkURL)}
                />
                <MenuItem
                  label="Copy link"
                  onSelect={() => void navigator.clipboard?.writeText(pageMenu.target.linkURL).catch(() => {})}
                />
                <MenuSeparator />
              </>
            )}
            {/*
              Chromium fills `selectionText` with a link's own text when the
              click was on a link, so the two groups have to be exclusive or
              a right-click on a link offers to copy a selection nobody made.
              Chrome's menu makes the same choice.
            */}
            {!pageMenu.target.linkURL && pageMenu.target.selectionText && (
              <>
                <MenuItem label="Copy" onSelect={() => act((element) => element.copy())} />
                <MenuItem
                  label={`Search for “${pageMenu.target.selectionText.slice(0, 24)}”`}
                  onSelect={() =>
                    store.newBrowserTab(
                      paneId,
                      // Always a search, never a navigation: a selection that
                      // happens to read like a host is still a selection.
                      `https://www.google.com/search?q=${encodeURIComponent(pageMenu.target.selectionText.slice(0, 200))}`,
                    )
                  }
                />
                <MenuSeparator />
              </>
            )}
            <MenuItem
              label="Back"
              disabled={arrows.back ? false : 'Nothing to go back to.'}
              onSelect={() => act((element) => element.goBack())}
            />
            <MenuItem
              label="Forward"
              disabled={arrows.forward ? false : 'Nothing to go forward to.'}
              onSelect={() => act((element) => element.goForward())}
            />
            <MenuItem label="Reload" onSelect={() => act((element) => element.reload())} />
            <MenuSeparator />
            <MenuItem
              icon={<ExternalIcon size={14} />}
              label="Open in default browser"
              disabled={tab.url === BLANK ? 'This tab has no page yet.' : false}
              onSelect={() => openExternal(tab.url)}
            />
            <MenuItem
              icon={<DevToolsIcon size={14} />}
              label="Inspect element"
              onSelect={() =>
                act((element) => element.inspectElement(pageMenu.target.x, pageMenu.target.y))
              }
            />
          </>
        )}
      </ContextMenu>
      <ContextMenu at={tabMenu.at} label="Tab" onClose={tabMenu.close}>
        {tabMenu.tab && (
          <>
            <MenuItem
              label="Duplicate"
              onSelect={() => store.duplicateBrowserTab(paneId, tabMenu.tab!.id)}
            />
            <MenuItem
              label="Copy address"
              disabled={tabMenu.tab.url === BLANK ? 'This tab has no page yet.' : false}
              onSelect={() => void navigator.clipboard?.writeText(tabMenu.tab!.url).catch(() => {})}
            />
            <MenuItem
              label="Browser tools drive this tab"
              selected={view.driven === tabMenu.tab.id}
              disabled={canDrive ? false : `${drivingRuntime?.presentation.name ?? 'This agent'} cannot receive browser tools.`}
              onSelect={() => store.setBrowserDriven(paneId, tabMenu.tab!.id)}
            />
            <MenuSeparator />
            <MenuItem
              label={tabs.length === 1 ? 'Close the browser' : 'Close tab'}
              onSelect={() => store.closeBrowserTab(paneId, tabMenu.tab!.id)}
            />
            <MenuItem
              label="Close other tabs"
              disabled={tabs.length < 2 ? 'There is only this one.' : false}
              onSelect={() => store.closeOtherBrowserTabs(paneId, tabMenu.tab!.id)}
            />
            <MenuItem
              label="Close tabs to the right"
              disabled={
                tabs.findIndex((entry) => entry.id === tabMenu.tab!.id) === tabs.length - 1
                  ? 'Nothing is to the right.'
                  : false
              }
              onSelect={() => store.closeOtherBrowserTabs(paneId, tabMenu.tab!.id, { toTheRight: true })}
            />
          </>
        )}
      </ContextMenu>
      <div className={styles.body} data-browser="">
        {tabs.map((entry) => (
          <BrowserTabPage
            key={entry.id}
            tab={entry}
            active={entry.id === view.active}
            partition={partition}
            onReady={onReady}
            onNavigate={onNavigate}
            onTitle={onTitle}
            onLoading={onLoading}
            onCanGo={onCanGo}
            onIcon={onIcon}
            onFound={onFound}
            onPageMenu={onPageMenu}
            zoom={zoom[entry.id] ?? 0}
            register={register}
          />
        ))}
        {driving && (
          <div className={styles.doing}>
            <span className={styles.doingMark}>
              {driving.info ? <RuntimeMark runtime={driving.info} size={13} /> : <GlobeIcon size={13} />}
            </span>
            <span className={styles.doingText}>
              {driving.what}
              <span className={styles.doingWho}>
                {driving.key ? `${driving.who} — step ${driving.step} of this turn` : driving.who}
              </span>
            </span>
            {/* Offered only where it can be aimed. With two turns in the page
                at once there is no "the" turn to stop, and a button that
                interrupts whichever conversation was opened first is worse
                than no button — you would not know it had happened. */}
            {driving.key !== null && (
              <button
                type="button"
                className={styles.doingStop}
                onClick={() => void store.interrupt(driving.key as SessionKey)}
              >
                Stop
              </button>
            )}
          </div>
        )}
      </div>
      {/* What the pane is, said once at the bottom: whether a turn has the
          wheel, and that the profile is never the one your own browser uses. */}
      <div className={styles.browserFoot}>
        {driving ? (
          <>
            <span className={styles.footDot} />
            Being driven
          </>
        ) : (
          'Idle'
        )}
        <span className={styles.footSpace} />
        {inline ? 'Never your own browser profile' : 'Framed pages only — the desktop app runs a real browser'}
      </div>
    </div>
  )
}
