import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, session, shell, Tray, webContents } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDefaultHost, loadBuiltinPlugins, recordCrash, serve } from '@harnessdesk/server'
import electronUpdater from 'electron-updater'

import { createInlineBrowserEngine } from './browser-engine.mjs'
import { downloadOutcome, remember, uniqueName } from './downloads.mjs'
import { respondToCrash } from './crash-policy.mjs'
import { MARK, drawTrayMeter } from './meter.mjs'
import { attachAppUpdates } from './app-updates.mjs'
import { decide, relevant } from './notifications.mjs'

import { readWindowState, writeWindowState } from './window-state.mjs'
import { isAppNavigation } from './navigation.mjs'

/**
 * The macOS shell.
 *
 * The host runs in this process rather than as a child: it is the only thing
 * that needs Node, keeping it here means one process tree to supervise, and the
 * renderer stays a sandboxed page that can only reach the host through an
 * authenticated loopback socket.
 */

const here = dirname(fileURLToPath(import.meta.url))
const stateDir = process.env['HARNESSDESK_HOME'] ?? join(homedir(), '.harnessdesk')
const windowStateFile = join(stateDir, 'window.json')

/**
 * An uncaught exception in this process is Electron's cue to put up a modal
 * error box and wait for a click — which freezes the whole desk, tools and
 * agents included, behind a dialog nobody asked for. Seen live: a helper's
 * stdin answered EPIPE after the helper had gone, and the window sat behind
 * "A JavaScript error occurred in the main process" until it was killed.
 *
 * The rule is in `crash-policy.mjs`: a pipe that went away is another
 * process's exit and the shell carries on; anything else is recorded and
 * the shell relaunches itself — the layout and the conversations are on
 * disk and come back — unless it just did, in which case it exits rather
 * than loop. Never a dialog, and never carrying on after an unknown failure.
 */
const relaunchMarker = join(stateDir, 'logs', 'last-relaunch')
const crashHooks = {
  record: (kind, error) => recordCrash(kind, error),
  log: (kind, error, decision) =>
    logger?.error(`${kind} in the shell`, {
      error: String(error instanceof Error ? error.stack : error),
      decision,
    }),
  readMarker: () => readFileSync(relaunchMarker, 'utf8'),
  writeMarker: (at) => {
    mkdirSync(dirname(relaunchMarker), { recursive: true })
    writeFileSync(relaunchMarker, String(at))
  },
  relaunch: () => app.relaunch(),
  exit: (code) => app.exit(code),
}
process.on('uncaughtException', (error) => respondToCrash('uncaughtException', error, crashHooks))
// A rejected promise nobody awaited goes the same way. Node's own default is
// to make it fatal; installing this listener suppresses that, so it has to
// answer for it rather than log and carry on.
process.on('unhandledRejection', (reason) => respondToCrash('unhandledRejection', reason, crashHooks))

/** UI assets: packaged under Resources, or the workspace build during development. */
const uiRoot = app.isPackaged
  ? join(process.resourcesPath, 'ui')
  : resolve(here, '../../ui/dist')

/** Rendered from assets/brand/svgs by `pnpm run icons`; packaged alongside the shell. */
const assetsDir = join(here, 'assets')
const sessionUrl = () => (running ? `${running.url}/?token=${running.token}` : null)

let mainWindow = null
let aboutWindow = null
let tray = null
let running = null
let host = null
let logger = null
let extensions = null
/** The app menu's update item — `app-updates.mjs` decides what it says. */
let updateMenuItem = null

if (!app.requestSingleInstanceLock()) {
  // A second launch should focus the window that already exists, not race it
  // for the same host port and state file.
  app.quit()
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

const pickDirectory = async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: 'Choose a project folder',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open',
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/** Finder, with the folder selected — what "Reveal in Finder" means on a Mac. */
const revealPath = async (path) => {
  shell.showItemInFolder(path)
}

const createWindow = async (url) => {
  const displays = screen.getAllDisplays()
  const state = await readWindowState(windowStateFile, displays)

  const window = new BrowserWindow({
    ...state.bounds,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'HarnessDesk',
    // The renderer reserves space for the traffic lights in its own chrome.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 15 },
    // The click that brings the window forward is also a click on whatever it
    // landed on. Without this, the first click on an inactive window only
    // focuses it and the button, row or composer under the pointer does
    // nothing — every other Mac app, and Codex, act on that click.
    acceptFirstMouse: true,
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The browser pane is a <webview>: the one place the app shows a page
      // it did not write. Guests get no preload and no Node (enforced again
      // in will-attach-webview below) and their own session partition.
      webviewTag: true,
      spellcheck: true,
    },
  })

  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (!/^(https?|file|about):/i.test(params.src ?? '')) event.preventDefault()
  })

  // Where a page's `target=_blank` goes. A guest is never allowed to open a
  // window of its own; the link either becomes a tab in the pane — which is
  // what a browser does, and the reason the pane has tabs — or leaves for the
  // OS browser. The renderer keeps `linksInPane` and tells us on every change.
  window.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url: target }) => {
      if (!/^(https?|file):/i.test(target)) return { action: 'deny' }
      if (browserLinksInPane) window.webContents.send('harnessdesk:browser-open-tab', { url: target })
      else if (/^https?:/i.test(target)) void shell.openExternal(target)
      return { action: 'deny' }
    })
    watchDownloads(guest.session)
  })

  // Nothing in this app should navigate away from the host, and nothing should
  // open a window of its own. Links go to the user's browser instead.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, target) => {
    // Origin, not prefix: `http://127.0.0.1:<port>@evil.com/` carries the app's
    // own prefix and goes to evil.com. See navigation.test.mjs.
    if (!isAppNavigation(url, target)) {
      event.preventDefault()
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    }
  })

  // Renderer trouble lands in the diagnostics log instead of vanishing with
  // the window's console, which nobody can open in a packaged app.
  window.webContents.on('render-process-gone', (_event, details) => {
    logger?.error('renderer gone', { reason: details.reason, exitCode: details.exitCode })
  })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') {
      logger?.warn('renderer console', {
        message: String(event.message).slice(0, 500),
        line: event.lineNumber,
        source: event.sourceId,
      })
    }
  })

  window.once('ready-to-show', () => {
    window.show()
    if (state.maximized) window.maximize()
  })

  const persist = () => {
    if (!window || window.isDestroyed() || window.isMinimized()) return
    void writeWindowState(windowStateFile, {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    })
  }

  window.on('resize', debounce(persist, 400))
  window.on('move', debounce(persist, 400))
  window.on('close', persist)
  window.on('closed', () => {
    mainWindow = null
  })

  await window.loadURL(url)
  return window
}

const debounce = (fn, ms) => {
  let timer = null
  return (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

/** Bring the window forward, or make one if the last was closed. */
const showMainWindow = async () => {
  // A status-item click never activates the app, and on macOS a window cannot
  // take focus while another app is active; this is the one place stealing it
  // is right, because the user just clicked us.
  app.focus({ steal: true })
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  const url = sessionUrl()
  if (url) mainWindow = await createWindow(url)
}

/**
 * Our own About window. The standard macOS panel only ever shows the bundle
 * icon, and its `iconPath` option is honoured on Linux and Windows alone, so
 * the mark is drawn here instead — on the same tile the Dock icon bakes in.
 */
const showAbout = () => {
  app.focus({ steal: true })
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.show()
    aboutWindow.focus()
    return
  }
  aboutWindow = new BrowserWindow({
    width: 300,
    height: 360,
    title: 'About HarnessDesk',
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hidden',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  aboutWindow.setMenuBarVisibility(false)
  aboutWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  aboutWindow.once('ready-to-show', () => aboutWindow?.show())
  aboutWindow.on('closed', () => {
    aboutWindow = null
  })
  void aboutWindow.loadFile(join(assetsDir, 'about.html'), {
    query: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    },
  })
}

/**
 * The menu-bar status item. The app keeps running with no windows, so this is
 * the way back in: either click drops the menu, whose first item raises the
 * window. The image is a template (black + alpha, `…Template.png`), which macOS
 * recolours itself for light and dark menu bars.
 */
/**
 * What the renderer last said every plan has left. The status item is drawn
 * from this and nothing else — the shell never asks the host itself, because
 * two sources for one number is two numbers.
 */
let traySummary = { title: '', agents: [] }

/**
 * The images the menu draws beside its rows.
 *
 * A macOS menu item's image is a raster — `nativeImage` has no SVG decoder —
 * so the glyphs are rendered ahead of time by `pnpm run icons`, from the same
 * two collections the interface draws from: Lucide for the actions, lobe-icons
 * for the makers. Each is a template image, which is what lets macOS recolour
 * it for a light or a dark menu and invert it under the highlight.
 *
 * Read once and kept: the menu is rebuilt on every usage update, and going
 * back to disk each time for the same dozen glyphs is work nobody asked for.
 */
const glyphs = new Map()

const glyph = (file) => {
  if (glyphs.has(file)) return glyphs.get(file)
  const image = nativeImage.createFromPath(join(assetsDir, file))
  // A missing file must cost a row its picture and nothing else: a menu with
  // no way back into the app is a far worse failure than a menu with a gap.
  const drawn = image.isEmpty() ? null : image
  drawn?.setTemplateImage(true)
  glyphs.set(file, drawn)
  return drawn
}

/** A row and its glyph, when there is one. */
const withGlyph = (item, file) => {
  const image = glyph(file)
  return image ? { ...item, icon: image } : item
}

/** The mark for an agent's row: its maker's, or the generic agent glyph. */
const markFor = (brand) => (brand ? glyph(`brands/${brand}.png`) : null) ?? glyph('brands/agent.png')

/*
 * The meters, drawn once per reading.
 *
 * A menu item takes a raster and nothing else, so every bar in the menu is a
 * PNG this process encoded. The menu is rebuilt on every usage snapshot and
 * every minute besides, and nothing about a 42% bar changes between two
 * rebuilds — so the drawing is keyed on what it depicts.
 *
 * Every one is a template image, tinted by macOS to whatever appearance the
 * menu turns out to have. See `meter.mjs` for why the shell must not try to
 * colour them itself.
 */
const meters = new Map()

const meterIcon = (agent) => {
  const key = `${agent.brand ?? ''}|${agent.left === null ? 'none' : Math.round(agent.left)}`
  if (meters.has(key)) return meters.get(key)

  const image = markFor(agent.brand)
  const size = image?.getSize()
  const drawn = drawTrayMeter({
    // An agent with nothing to report draws its mark on the same canvas and no
    // bar at all, so its row still starts where every other row starts.
    fraction: agent.left === null ? null : Math.round(agent.left) / 100,
    // A mark of some other size would land in the wrong pixels; the slot stays
    // reserved and empty rather than filled with a guess.
    mark:
      image && size?.width === MARK && size?.height === MARK
        ? image.toBitmap({ scaleFactor: 2 })
        : null,
  })
  const icon = nativeImage.createFromBuffer(drawn.png, {
    width: drawn.width,
    height: drawn.height,
    scaleFactor: 2,
  })
  icon.setTemplateImage(true)
  meters.set(key, icon)
  return icon
}

const agentRow = (agent) => {
  // The meter carries the mark inside it, because a row has one image slot and
  // the reading is worth more than the picture is on its own.
  const icon = meterIcon(agent) ?? markFor(agent.brand)
  const row = {
    label: agent.needsSignIn ? `${agent.name} — Sign in…` : `${agent.name} — ${agent.detail}`,
    // A signed-out agent's row is the way in; a signed-in one's is a
    // reading, and a reading you can click is a reading you distrust.
    enabled: agent.needsSignIn,
    click: agent.needsSignIn
      ? () => void showMainWindow().then(() => sendShortcut(agent.id ? `sign-in:${agent.id}` : 'sign-in'))
      : undefined,
  }
  return icon ? { ...row, icon } : row
}

const buildTrayMenu = () =>
  Menu.buildFromTemplate([
    withGlyph({ label: 'Show HarnessDesk', click: () => void showMainWindow() }, 'menu/show.png'),
    ...(traySummary.agents.length > 0 ? [{ type: 'separator' }, ...traySummary.agents.map(agentRow)] : []),
    { type: 'separator' },
    withGlyph(
      { label: 'New Session', click: () => void showMainWindow().then(() => sendShortcut('new-session')) },
      'menu/new-session.png',
    ),
    withGlyph(
      { label: 'Open Folder…', click: () => void showMainWindow().then(() => sendShortcut('open-folder')) },
      'menu/open-folder.png',
    ),
    withGlyph(
      { label: 'Dashboard…', click: () => void showMainWindow().then(() => sendShortcut('usage')) },
      'menu/usage.png',
    ),
    { type: 'separator' },
    withGlyph(
      { label: 'Settings…', click: () => void showMainWindow().then(() => sendShortcut('settings')) },
      'menu/settings.png',
    ),
    withGlyph({ label: 'About HarnessDesk', click: showAbout }, 'menu/about.png'),
    { type: 'separator' },
    withGlyph({ label: 'Quit HarnessDesk', click: () => app.quit() }, 'menu/quit.png'),
  ])

const createTray = () => {
  if (process.platform !== 'darwin' || tray) return
  const image = nativeImage.createFromPath(join(assetsDir, 'trayTemplate.png'))
  if (image.isEmpty()) return
  image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('HarnessDesk')
  // A menu set this way is what macOS opens on either button, and it keeps the
  // status item highlighted while it is open — `popUpContextMenu` does neither.
  tray.setContextMenu(buildTrayMenu())
}

const buildMenu = () => {
  const template = [
    {
      label: 'HarnessDesk',
      submenu: [
        { label: 'About HarnessDesk', click: showAbout },
        // Absent entirely when update checks are off — a disabled item would
        // read as broken rather than as a choice.
        ...(updateMenuItem
          ? [
              {
                label: updateMenuItem.label,
                enabled: updateMenuItem.enabled,
                click: updateMenuItem.click,
              },
            ]
          : []),
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => sendShortcut('settings'),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'Cmd+N',
          click: () => sendShortcut('new-session'),
        },
        {
          label: 'Open Folder…',
          accelerator: 'Cmd+O',
          click: () => sendShortcut('open-folder'),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'Cmd+B',
          click: () => sendShortcut('toggle-sidebar'),
        },
        {
          label: 'Show Changes',
          accelerator: 'Shift+Cmd+D',
          click: () => sendShortcut('show-changes'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Open Diagnostics Folder',
          click: () => void shell.openPath(join(stateDir, 'logs')),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Menu items drive the renderer's own handlers rather than duplicating their
 * behaviour, so there is exactly one implementation of each action.
 */
const sendShortcut = (name) => {
  mainWindow?.webContents.send('harnessdesk:shortcut', name)
}

/**
 * Browser tools drive the pane inside this window, not a separate Chrome.
 * Kept in a binding as well as handed to the host, because the pane's own
 * *Save screenshot* photographs a tab through the very debugger session the
 * tools use — one attachment, not two.
 */
const browserEngine = createInlineBrowserEngine({
  window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  show: async () => {
    await showMainWindow()
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  },
})

/** The partition the browser pane's guests use when sessions are kept. */
const BROWSER_PARTITION = 'persist:harnessdesk-browser'

/** The renderer's `linksInPane` preference, mirrored here because the guest's
 *  window-open handler runs in this process. */
let browserLinksInPane = true

/**
 * A page's downloads, for the pane's guests.
 *
 * A guest session nobody listens to drops a download on the floor — no
 * dialog, no file, no word, measured on 2026-09-06 with a plain
 * `Content-Disposition: attachment` link. The pane is a browser, so the
 * file goes where a browser puts it: the Downloads folder, under the name
 * the server gave, a second copy numbered rather than the first replaced,
 * and the renderer told when it lands so a notice can say so. One listener
 * per session — the kept partition and the throwaway one are two sessions,
 * and every attached guest passes through here.
 * @type {WeakSet<import('electron').Session>}
 */
const watchedSessions = new WeakSet()
/**
 * Every file the pane has downloaded — the only paths the renderer may ask
 * to reveal. Bounded: a desk that runs for weeks should not remember every
 * file it ever saved, and "Show in Finder" is for the download just made.
 */
const downloadedPaths = new Set()
const REMEMBERED_DOWNLOADS = 200
/** Destinations handed out but not yet written — two `report.csv` at once must not share one. */
const inFlightDownloads = new Set()
const watchDownloads = (guestSession) => {
  if (watchedSessions.has(guestSession)) return
  watchedSessions.add(guestSession)
  guestSession.on('will-download', (_event, item) => {
    const dir = app.getPath('downloads')
    const name = uniqueName(dir, item.getFilename(), (candidate) => existsSync(candidate) || inFlightDownloads.has(candidate))
    const path = join(dir, name)
    inFlightDownloads.add(path)
    item.setSavePath(path)
    item.once('done', (_done, state) => {
      inFlightDownloads.delete(path)
      const outcome = downloadOutcome({ name, path, state, bytes: item.getReceivedBytes() })
      if (outcome.ok) remember(downloadedPaths, path, REMEMBERED_DOWNLOADS)
      logger?.info('browser pane download', outcome)
      // The window of the moment, not the one the listener was made in: on
      // macOS the app outlives its window, and the session outlives both.
      const target = mainWindow
      if (target && !target.isDestroyed()) target.webContents.send('harnessdesk:browser-download', outcome)
    })
  })
}

const start = async () => {
  const bootstrap = createDefaultHost({
    stateDir,
    version: app.getVersion(),
    browserEngine,
    // At-rest protection for stored credentials comes from the OS —
    // safeStorage keys live in the macOS Keychain. This is the only file in
    // the repository allowed to touch a keystore API; CI enforces that.
    credentialCipher: safeStorage.isEncryptionAvailable()
      ? {
          protection: process.platform === 'darwin' ? 'macOS Keychain' : 'OS keystore',
          encrypt: (plaintext) => safeStorage.encryptString(plaintext),
          decrypt: (blob) => safeStorage.decryptString(blob),
        }
      : undefined,
    logLevel: process.env['HARNESSDESK_LOG_LEVEL'] ?? 'info',
    // Packaged apps have no terminal to write to, and the NDJSON file is what
    // the diagnostics bundle ships anyway.
    console: !app.isPackaged,
    pickDirectory,
    revealPath,
  })
  host = bootstrap.host
  logger = bootstrap.logger
  extensions = bootstrap.extensions

  // The built-in plugins are what give every agent its tools — browser,
  // simulators, tests, search. The standalone host loads them in bin.ts;
  // the shell has to do the same or the app ships with an empty toolbox.
  await loadBuiltinPlugins(extensions)
  await host.start()

  if (!existsSync(uiRoot)) {
    logger.error('UI assets are missing', { uiRoot })
    dialog.showErrorBox(
      'HarnessDesk is incomplete',
      `The interface files were not found at:\n${uiRoot}\n\nRun \`pnpm build\` and try again.`,
    )
    app.quit()
    return
  }

  running = await serve({ host, logger, uiRoot, port: 0 })
  logger.info('desktop shell ready', { url: running.url })

  // macOS notifications for the moments worth leaving another app for: a
  // finished turn, a failed one, an approval, a question. `decide` owns the
  // rules (and is tested away from Electron); this block only looks up the
  // words and draws. Nothing while the window is focused — the pane already
  // shows everything — and each kind answers to Settings › Notifications.
  host.addBroadcaster((notification) => {
    // The broadcaster fires for every push, streaming deltas most of all.
    // The two cheap facts — the window has focus, or this is not one of the
    // kinds that can notify — filter nearly everything before the
    // preferences call below; `decide` still enforces both rules itself.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return
    if (!relevant(notification)) return
    void (async () => {
      try {
        const preferences = await host.call('app/state/get', {})
        const plan = decide(notification, {
          focused: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
          prefs: preferences['systemNotifications'],
          agentName: (id) =>
            host
              .syncPayload()
              .params.runtimes.find((entry) => entry.id === id)?.presentation?.name ?? id,
          sessionTitle: (runtime, sessionId) => {
            const record = host.registry.get(runtime, sessionId)
            return record?.session?.title ?? record?.session?.preview ?? null
          },
        })
        if (!plan || !Notification.isSupported()) return
        const note = new Notification({ title: plan.title, body: plan.body })
        note.on('click', () => {
          void showMainWindow().then(() => {
            // The window opens on the conversation the notification is about,
            // not merely on the app.
            if (plan.sessionId && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('harnessdesk:open-session', {
                runtime: plan.runtime,
                sessionId: String(plan.sessionId),
              })
            }
          })
        })
        note.show()
        logger?.debug('system notification shown', { kind: plan.kind, runtime: plan.runtime })
      } catch (error) {
        logger?.debug('system notification skipped', { error: String(error) })
      }
    })()
  })

  buildMenu()
  createTray()

  // The app keeping itself current: a check soon after launch and every few
  // hours, speaking through one menu item unless the person asked. All the
  // rules live in `app-updates.mjs`; this block only lends it the menu, the
  // dialog box and the log. electron-updater's own logger is ours too, so
  // its complaints land in the same NDJSON file the diagnostics bundle ships.
  electronUpdater.autoUpdater.logger = {
    info: (message) => logger?.debug('app updater', { message: String(message) }),
    warn: (message) => logger?.warn('app updater', { message: String(message) }),
    error: (message) => logger?.warn('app updater', { message: String(message) }),
    debug: (message) => logger?.debug('app updater', { message: String(message) }),
  }
  attachAppUpdates({
    updater: electronUpdater.autoUpdater,
    env: process.env,
    packaged: app.isPackaged,
    version: app.getVersion(),
    onMenu: (item) => {
      updateMenuItem = item
      buildMenu()
    },
    showDialog: async (request) => {
      const shown = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
      const result = shown
        ? await dialog.showMessageBox(shown, { type: 'info', ...request })
        : await dialog.showMessageBox({ type: 'info', ...request })
      return result.response
    },
    log: (message, data) => logger?.info(message, data),
  })

  mainWindow = await createWindow(sessionUrl())
}

/**
 * *Save screenshot* from the browser pane's menu. The renderer names one of
 * its own tabs by `webContents` id; the engine refuses any id the pane never
 * reported, so this cannot be pointed at the app's own window. Returns the
 * path written, or null when the person cancelled the dialog.
 */
ipcMain.handle('harnessdesk:browser-save-screenshot', async (_event, request) => {
  const id = request?.id
  if (!Number.isInteger(id) || !browserEngine.knows(id)) throw new Error('That page is not open in the browser pane.')
  const png = await browserEngine.capture(id)
  const suggested = typeof request?.name === 'string' && request.name.trim() ? request.name.trim() : 'screenshot'
  const chosen = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: 'Save screenshot',
    defaultPath: join(app.getPath('downloads'), `${suggested.replace(/[/\\:]/g, '-').slice(0, 80)}.png`),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  })
  if (chosen.canceled || !chosen.filePath) return null
  await writeFile(chosen.filePath, png)
  return chosen.filePath
})

ipcMain.on('harnessdesk:browser-links', (_event, inPane) => {
  browserLinksInPane = inPane !== false
})

/** "Show in Finder" on a download's notice — only for a file this shell saved. */
ipcMain.on('harnessdesk:browser-reveal-download', (_event, path) => {
  if (typeof path === 'string' && downloadedPaths.has(path)) shell.showItemInFolder(path)
})

/**
 * The isolated world the annotation overlay lives in. Any id above zero is
 * outside the page's own world; this one is fixed so repeated calls land in
 * the same world and find the overlay they installed last time.
 */
const ANNOTATE_WORLD = 1013

/**
 * The annotation overlay's calls, run in an isolated world of one of the
 * pane's own tabs. Isolated, so the page can neither see the overlay's state
 * nor answer in its place: what `list` returns comes from the overlay's
 * closure, not from anything the page planted on `window`. The gate is
 * structural — the id must name a `<webview>` guest embedded in this app's
 * window, which only the browser pane creates.
 */
ipcMain.handle('harnessdesk:browser-annotate', async (_event, request) => {
  const id = request?.id
  const wc = Number.isInteger(id) ? webContents.fromId(id) : null
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || !mainWindow || wc.hostWebContents !== mainWindow.webContents) {
    throw new Error('That page is not open in the browser pane.')
  }
  const code = typeof request?.code === 'string' ? request.code : ''
  if (code.length === 0 || code.length > 200000) throw new Error('Not an annotation script.')
  return wc.executeJavaScriptInIsolatedWorld(ANNOTATE_WORLD, [{ code }])
})

/** Empties the pane's persistent partition — cookies, storage, caches. */
ipcMain.handle('harnessdesk:browser-clear-data', async () => {
  await session.fromPartition(BROWSER_PARTITION).clearStorageData()
})

ipcMain.on('harnessdesk:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
})

ipcMain.on('harnessdesk:set-title', (_event, title) => {
  if (typeof title === 'string') mainWindow?.setTitle(title)
})

// The app's appearance choice, as the shell's native theme. The renderer can
// dress itself, but the browser pane's page is Chromium's, not ours: what a
// site reads from `prefers-color-scheme` comes from `themeSource` and nothing
// else. `system` leaves it to the OS, which is also what the renderer does.
ipcMain.on('harnessdesk:set-theme', (_event, theme) => {
  if (theme === 'light' || theme === 'dark' || theme === 'system') nativeTheme.themeSource = theme
})

// What the status item says, and what its menu lists. The title is the
// tightest figure of the lot: the one number worth two characters of menu bar.
ipcMain.on('harnessdesk:tray-summary', (_event, summary) => {
  if (!summary || typeof summary !== 'object') return
  traySummary = {
    title: typeof summary.title === 'string' ? summary.title : '',
    agents: Array.isArray(summary.agents) ? summary.agents : [],
  }
  if (!tray) return
  tray.setTitle(traySummary.title)
  tray.setContextMenu(buildTrayMenu())
})

app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox('HarnessDesk could not start', String(error?.stack ?? error))
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && running) void showMainWindow()
})

// macOS convention: the app stays running with no windows. Quitting is explicit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  if (!running && !host) return
  event.preventDefault()
  const closing = running
  const closingHost = host
  const closingExtensions = extensions
  running = null
  host = null
  extensions = null
  try {
    await closing?.close()
    await closingHost?.dispose()
    await closingExtensions?.dispose()
    await logger?.flush()
  } finally {
    tray?.destroy()
    tray = null
    app.quit()
  }
})
