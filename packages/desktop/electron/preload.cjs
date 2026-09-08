const { contextBridge, ipcRenderer } = require('electron')

/**
 * The renderer bridge.
 *
 * Deliberately tiny, and CommonJS because a sandboxed preload is not an ES
 * module. Everything the app actually does goes over the host's authenticated
 * loopback socket; the only things that genuinely need the main process are
 * window chrome, menu commands, and opening links in the real browser.
 */

contextBridge.exposeInMainWorld('harnessdesk', {
  platform: process.platform,

  openExternal: (url) => {
    // Re-validated in main. Checking here keeps obvious mistakes local.
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    ipcRenderer.send('harnessdesk:open-external', url)
  },

  setTitle: (title) => {
    if (typeof title === 'string') ipcRenderer.send('harnessdesk:set-title', title.slice(0, 200))
  },

  // Appearance. Light and Dark are the app's own choice and have to reach
  // Chromium, or the browser pane's page follows the OS instead of the app.
  setTheme: (theme) => {
    if (theme === 'light' || theme === 'dark' || theme === 'system') ipcRenderer.send('harnessdesk:set-theme', theme)
  },

  /**
   * What the menu bar's status item says.
   *
   * The renderer already decides what every plan has left; the shell would
   * have to ask the host all over again to learn the same thing, and the two
   * answers would drift. So the renderer hands over the finished sentence and
   * the shell only draws it.
   */
  setTraySummary: (summary) => {
    if (!summary || typeof summary !== 'object') return
    const agents = Array.isArray(summary.agents) ? summary.agents : []
    // A percentage or nothing. NaN through a bridge becomes a bar of some
    // arbitrary length, which is a reading that was never taken.
    const percent = (value) =>
      typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null
    ipcRenderer.send('harnessdesk:tray-summary', {
      title: typeof summary.title === 'string' ? summary.title.slice(0, 12) : '',
      agents: agents.slice(0, 12).map((agent) => ({
        id: String(agent?.id ?? '').slice(0, 64),
        name: String(agent?.name ?? '').slice(0, 60),
        detail: String(agent?.detail ?? '').slice(0, 80),
        needsSignIn: agent?.needsSignIn === true,
        // A key, never a path: the shell looks it up among the images it has.
        brand: typeof agent?.brand === 'string' && /^[a-z0-9-]{1,32}$/.test(agent.brand) ? agent.brand : null,
        left: percent(agent?.left),
      })),
    })
  },

  /** A clicked notification names the conversation it was about. */
  onOpenSession: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, request) => {
      if (typeof request?.runtime === 'string' && typeof request?.sessionId === 'string') {
        handler({ runtime: request.runtime, sessionId: request.sessionId })
      }
    }
    ipcRenderer.on('harnessdesk:open-session', listener)
    return () => ipcRenderer.removeListener('harnessdesk:open-session', listener)
  },

  /** Menu items dispatch here so the renderer owns one implementation of each action. */
  onShortcut: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, name) => handler(String(name))
    ipcRenderer.on('harnessdesk:shortcut', listener)
    return () => ipcRenderer.removeListener('harnessdesk:shortcut', listener)
  },

  // The browser pane ↔ the browser engine in main. The pane names its
  // <webview> by id so main can drive it over the DevTools protocol; main
  // asks for the pane when an agent tool needs a page and none is open.
  browserReady: (id) => {
    if (Number.isInteger(id)) ipcRenderer.send('harnessdesk:browser-ready', id)
  },
  browserGone: () => ipcRenderer.send('harnessdesk:browser-gone'),
  onBrowserShow: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, request) => handler({ url: typeof request?.url === 'string' ? request.url : 'about:blank' })
    ipcRenderer.on('harnessdesk:browser-show', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-show', listener)
  },
  onBrowserClose: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = () => handler()
    ipcRenderer.on('harnessdesk:browser-close', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-close', listener)
  },
  // Before the tools act, the driven tab has to be the tab on screen:
  // Chromium stops rasterising a <webview> nobody is looking at.
  onBrowserFocus: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = () => handler()
    ipcRenderer.on('harnessdesk:browser-focus', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-focus', listener)
  },
  /** Photographs one of the pane's own tabs and writes what the dialog names. */
  saveBrowserScreenshot: (id, name) =>
    ipcRenderer.invoke('harnessdesk:browser-save-screenshot', {
      id,
      name: typeof name === 'string' ? name.slice(0, 200) : '',
    }),
  clearBrowserData: () => ipcRenderer.invoke('harnessdesk:browser-clear-data'),
  /**
   * The annotation overlay's calls, executed in an isolated world of one of
   * the pane's tabs — main checks the id names a guest of this window. The
   * page shares the DOM with that world but not the JavaScript, so it can
   * neither see the overlay nor answer in its place.
   */
  annotateInPage: (id, code) =>
    ipcRenderer.invoke('harnessdesk:browser-annotate', {
      id,
      code: typeof code === 'string' ? code.slice(0, 200000) : '',
    }),
  /** Where a guest's `target=_blank` goes; the handler for it lives in main. */
  setBrowserLinksInPane: (inPane) => ipcRenderer.send('harnessdesk:browser-links', inPane !== false),
  /** A download a page started has ended — where it went, and whether it finished. */
  onBrowserDownload: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, outcome) => {
      if (outcome && typeof outcome.name === 'string' && typeof outcome.path === 'string') {
        handler({ name: outcome.name, path: outcome.path, ok: outcome.ok === true, message: String(outcome.message ?? '') })
      }
    }
    ipcRenderer.on('harnessdesk:browser-download', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-download', listener)
  },
  /** Shows a downloaded file in the Finder; the shell only reveals files it saved itself. */
  revealDownload: (path) => {
    if (typeof path === 'string' && path.length > 0) ipcRenderer.send('harnessdesk:browser-reveal-download', path)
  },
  onBrowserOpenTab: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, request) => {
      if (typeof request?.url === 'string') handler(request.url)
    }
    ipcRenderer.on('harnessdesk:browser-open-tab', listener)
    return () => ipcRenderer.removeListener('harnessdesk:browser-open-tab', listener)
  },
})
