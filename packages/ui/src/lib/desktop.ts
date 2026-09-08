/**
 * The Electron bridge, as the renderer sees it.
 *
 * Everything here is optional: HarnessDesk also runs in a plain browser against
 * the standalone host, so each call degrades to a no-op rather than assuming the
 * shell is present.
 */

/** One agent, as the menu bar's status item lists it. */
export interface TrayAgent {
  /** The runtime id, so a row can act on the agent it names. */
  readonly id: string
  readonly name: string
  /** What it has left, said the way the header strip says it. */
  readonly detail: string
  readonly needsSignIn: boolean
  /**
   * Whose mark to draw beside the name — a lobe-icons key, the same one
   * `lib/brands.ts` gives every other surface. The shell keeps a rendered
   * image per key, because a menu item's image is a raster and the shell has
   * no build step of its own. Null when the agent has no mark of ours.
   */
  readonly brand: string | null
  /**
   * Percent left on the binding lane, for the meter drawn beside the mark.
   * Null when the agent reports nothing to draw — no account, no lane, or a
   * figure the source did not give. A row with no reading gets no bar; a
   * permanent empty track teaches people to stop looking.
   */
  readonly left: number | null
}

export interface TraySummary {
  /** The tightest figure of the lot — two characters of menu bar, well spent. */
  readonly title: string
  readonly agents: readonly TrayAgent[]
}

export interface DesktopBridge {
  readonly platform: string
  openExternal(url: string): void
  setTitle(title: string): void
  /**
   * The appearance choice, handed to the shell's native theme. Only the
   * desktop build has one; it is what the browser pane's page reads as
   * `prefers-color-scheme`, so an explicit Light or Dark reaches sites too.
   */
  setTheme?(theme: 'light' | 'dark' | 'system'): void
  /**
   * What the menu bar's status item says. The renderer already decides what
   * every plan has left; handing over the finished sentence is what keeps the
   * status item and the header strip from disagreeing.
   */
  setTraySummary?(summary: TraySummary): void
  onShortcut(handler: (name: string) => void): () => void
  /**
   * A clicked macOS notification, naming the conversation it was about. The
   * shell has already brought the window forward; the renderer's job is to
   * open that conversation.
   */
  onOpenSession?(handler: (request: { runtime: string; sessionId: string }) => void): () => void
  /**
   * The browser pane's side of the agent-driven browser. The pane reports
   * its `<webview>` by id once the page can be driven, and says when it
   * goes; the shell asks for the pane to be shown or closed when a tool
   * needs it. Absent in the browser build, where tools drive Chrome instead.
   */
  browserReady?(webContentsId: number): void
  browserGone?(): void
  onBrowserShow?(handler: (request: { url: string }) => void): () => void
  onBrowserClose?(handler: () => void): () => void
  /**
   * The shell asking for the driven tab to be brought forward, which it does
   * before every tool command: Chromium freezes a `<webview>` nobody is
   * looking at, so a backgrounded tab screenshots stale.
   */
  onBrowserFocus?(handler: () => void): () => void
  /**
   * Photographs one of the pane's tabs — named by `webContents` id, which
   * the shell checks against the tabs the pane itself reported — and writes
   * it where the save dialog says. Resolves to the path, or null if the
   * person cancelled.
   */
  saveBrowserScreenshot?(webContentsId: number, name: string): Promise<string | null>
  /** Empties the browser pane's persistent partition. */
  clearBrowserData?(): Promise<void>
  /**
   * Runs the annotation overlay's code in an *isolated world* of one of the
   * pane's tabs, named by `webContents` id and checked in the shell to be a
   * guest of this window. Isolated, so the page can neither see the
   * overlay's state nor answer in its place — `executeJavaScript` on the
   * `<webview>` itself runs in the page's own world, where a hostile page
   * could pre-plant `__hdAnnotate` and feed fabricated marks to the
   * composer.
   */
  annotateInPage?(webContentsId: number, code: string): Promise<unknown>
  /**
   * Where a guest's `target=_blank` goes. The handler runs in the shell, so
   * the preference has to be mirrored there on every change.
   */
  setBrowserLinksInPane?(inPane: boolean): void
  /** A link a page tried to open in a window of its own, to be shown as a tab. */
  onBrowserOpenTab?(handler: (url: string) => void): () => void
  /**
   * A download a page in the pane started has ended. The shell put it in the
   * Downloads folder under the server's name; this is where, and whether it
   * finished, for a notice to say.
   */
  onBrowserDownload?(handler: (outcome: { name: string; path: string; ok: boolean; message: string }) => void): () => void
  /** Shows a downloaded file in the Finder; the shell reveals only files it saved itself. */
  revealDownload?(path: string): void
}

declare global {
  interface Window {
    harnessdesk?: DesktopBridge
  }
}

export const desktop = (): DesktopBridge | null =>
  typeof window !== 'undefined' && window.harnessdesk ? window.harnessdesk : null

export const isDesktop = (): boolean => desktop() !== null

export const openExternal = (url: string): void => {
  const bridge = desktop()
  if (bridge) bridge.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export const setNativeTheme = (theme: 'light' | 'dark' | 'system'): void => {
  desktop()?.setTheme?.(theme)
}

export const setTraySummary = (summary: TraySummary): void => {
  desktop()?.setTraySummary?.(summary)
}

export const setWindowTitle = (title: string): void => {
  desktop()?.setTitle(title)
  document.title = title === 'HarnessDesk' ? title : `${title} — HarnessDesk`
}

export const onShortcut = (handler: (name: string) => void): (() => void) =>
  desktop()?.onShortcut(handler) ?? (() => {})

/** A clicked macOS notification, asking for its conversation on screen. */
export const onOpenSession = (
  handler: (request: { runtime: string; sessionId: string }) => void,
): (() => void) => desktop()?.onOpenSession?.(handler) ?? (() => {})

/**
 * Whether the window's top-left is occupied by macOS traffic lights. The
 * desktop shell uses an inset title bar, so chrome on that row starts after
 * them; the browser build has none and starts at the edge.
 */
export const hasTrafficLights = (): boolean => desktop()?.platform === 'darwin'

/** Whether this shell can render a real browser pane (Electron's `<webview>`). */
export const hasInlineBrowser = (): boolean => typeof desktop()?.browserReady === 'function'
