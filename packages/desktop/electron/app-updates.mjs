/**
 * The app's own updates — every decision, none of the drawing.
 *
 * The shell hands this module an updater (electron-updater's, or a fake in
 * tests) and callbacks for the two things it cannot do itself: change the menu
 * and show a dialog. Everything else — when to check, what the menu item says
 * in each phase, which results deserve a dialog and which stay quiet — is
 * decided here, away from Electron, where node:test can reach it.
 *
 * The behaviour it encodes:
 *
 * - Checks happen only in the packaged app, shortly after launch and every few
 *   hours after that. `HARNESSDESK_NO_UPDATE_CHECK=1` — the same switch that
 *   silences agent-update advisories — turns them off entirely.
 * - A background check never interrupts. It speaks through one menu item,
 *   which reads "Check for Updates…" until an update is downloaded and
 *   "Restart to Update (x.y.z)" afterwards; quitting installs it regardless.
 * - Only a check the person asked for answers with a dialog — "up to date",
 *   the restart offer, or the error. Silence after a click reads as broken.
 * - `HARNESSDESK_UPDATE_FEED` points the updater somewhere else — a staging
 *   feed, or a local one in the verification rig — and is also the one door
 *   into checking from an unpackaged build.
 * - Downgrades are allowed on purpose: pulling a bad release means republishing
 *   the previous version as latest, and installs walk themselves back.
 */

/** A first check soon after launch, but never in the way of it. */
export const FIRST_CHECK_AFTER_MS = 30_000

/** How often a running app re-asks the feed. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

/** The runtime feed override, empty and whitespace treated as absent. */
export const feedOverride = (env) => {
  const url = env['HARNESSDESK_UPDATE_FEED']
  return typeof url === 'string' && url.trim() !== '' ? url.trim() : null
}

/**
 * Whether this process should look for app updates at all. Packaged builds
 * do unless switched off; a dev build only when explicitly pointed at a feed,
 * which is how the updater is exercised without shipping anything.
 */
export const updatesAllowed = ({ packaged, env }) => {
  if (env['HARNESSDESK_NO_UPDATE_CHECK'] === '1') return false
  return packaged || feedOverride(env) !== null
}

/** What the one menu item says and does in each phase. */
const menuFor = (phase, version) => {
  switch (phase) {
    case 'checking':
      return { label: 'Checking for Updates…', enabled: false, action: 'none' }
    case 'downloading':
      return { label: 'Downloading Update…', enabled: false, action: 'none' }
    case 'ready':
      return { label: `Restart to Update (${version})`, enabled: true, action: 'install' }
    default:
      return { label: 'Check for Updates…', enabled: true, action: 'check' }
  }
}

/**
 * Wire an updater to the shell. Returns `{ check, menu, dispose }`:
 * `check(interactive)` starts a check (the menu item passes true), `menu()`
 * reads the current item, and `dispose()` clears the timers so a test — or a
 * closing app — is not held open by them.
 */
export const attachAppUpdates = ({
  updater,
  env,
  packaged,
  version,
  onMenu,
  showDialog,
  log = () => {},
}) => {
  if (!updatesAllowed({ packaged, env })) {
    onMenu(null)
    return { check: () => {}, menu: () => null, dispose: () => {} }
  }

  // Downloads start on their own; a downloaded update installs on quit even
  // if the restart offer was declined. Downgrade is the rollback path.
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.allowDowngrade = true

  const override = feedOverride(env)
  if (override) {
    // An unpackaged build has no app-update.yml; the override is its config.
    if (!packaged) updater.forceDevUpdateConfig = true
    updater.setFeedURL({ provider: 'generic', url: override })
  }

  let phase = 'idle'
  let readyVersion = null
  // Whether the person is waiting on the current check — only then do results
  // get a dialog. Background checks keep to the menu item.
  let interactive = false

  const menu = () =>
    menuFor(phase, readyVersion) === null
      ? null
      : {
          ...menuFor(phase, readyVersion),
          click: () => {
            if (menuFor(phase, readyVersion).action === 'install') updater.quitAndInstall()
            else check(true)
          },
        }
  const publish = () => onMenu(menu())

  const check = (wanted = false) => {
    if (phase === 'checking' || phase === 'downloading') return
    interactive = Boolean(wanted)
    updater.checkForUpdates()?.catch?.(() => {})
  }

  updater.on('checking-for-update', () => {
    phase = 'checking'
    publish()
  })

  updater.on('update-available', (info) => {
    phase = 'downloading'
    log('app update found', { version: info?.version })
    publish()
  })

  updater.on('update-not-available', () => {
    phase = 'idle'
    publish()
    if (interactive) {
      interactive = false
      void showDialog({
        message: 'You’re up to date',
        detail: `HarnessDesk ${version} is the newest version.`,
        buttons: ['OK'],
      })
    }
  })

  updater.on('update-downloaded', (info) => {
    phase = 'ready'
    readyVersion = info?.version ?? 'update'
    log('app update downloaded', { version: readyVersion })
    publish()
    if (interactive) {
      interactive = false
      void showDialog({
        message: `HarnessDesk ${readyVersion} is ready`,
        detail: 'Restart to finish updating, or keep working — it installs when you next quit.',
        buttons: ['Restart Now', 'Later'],
      }).then((choice) => {
        if (choice === 0) updater.quitAndInstall()
      })
    }
  })

  updater.on('error', (error) => {
    // A downloaded update stays downloaded; anything earlier starts over.
    if (phase !== 'ready') phase = 'idle'
    log('app update check failed', { error: String(error?.message ?? error) })
    publish()
    if (interactive) {
      interactive = false
      void showDialog({
        message: 'The update check failed',
        detail: String(error?.message ?? error),
        buttons: ['OK'],
      })
    }
  })

  publish()
  // Unref'd so no timer ever holds the process open — the app quits when it
  // quits, and a test that forgot dispose() still exits.
  const first = setTimeout(() => check(false), FIRST_CHECK_AFTER_MS)
  first.unref?.()
  const every = setInterval(() => check(false), CHECK_EVERY_MS)
  every.unref?.()

  return {
    check,
    menu,
    dispose: () => {
      clearTimeout(first)
      clearInterval(every)
    },
  }
}
