/**
 * "Install command-line tool…" — every decision, none of the drawing.
 *
 * The app carries the command line (`@harnessdesk/cli`) and the library it
 * needs. This puts one small file, `harnessdesk`, where a terminal will find
 * it, and that file runs the bundled command line on the app's own runtime
 * with `ELECTRON_RUN_AS_NODE=1`, so nobody needs a separate Node install. The
 * shell hands this module its dialog and its clipboard, and everything else —
 * where the file goes, what counts as ours, what the dialog says — is decided
 * here, away from Electron, where node:test can reach it on a temporary home.
 *
 * The rules it encodes, and why:
 *
 * - **A folder the person owns, never an administrator's password.** The
 *   launcher goes in `~/.local/bin`, or `~/bin`, whichever is already on the
 *   PATH their login shell builds (asked of the shell, because an app opened
 *   from the Dock has launchd's PATH and not theirs). Not `/usr/local/bin`,
 *   which needs an administrator; not a version manager's or a package
 *   manager's folder, which the manager rewrites and which moves under a
 *   version change. When neither is on PATH it is installed in `~/.local/bin`
 *   anyway, and the dialog says exactly where it is and the one line that puts
 *   that folder on PATH. No shell file is ever edited: those are the person's.
 * - **Never overwrite a `harnessdesk` that is not ours.** Ours is recognised by
 *   a marker on the second line and by nothing else. A file, a folder or a link
 *   of anyone else's is left exactly as it is, in either candidate folder, and
 *   the dialog says so. Only a file that carries the marker is replaced or
 *   removed.
 * - **The launcher finds the app when it runs, not when it was written.** It
 *   records where the app was, and when that is gone — an upgrade that moved
 *   it, a drag to another folder, the transient path a downloaded app runs from
 *   — it looks in the usual folders and then asks Spotlight for the bundle id.
 *   So an upgrade or a move never strands it, and it never needs rewriting.
 * - **Arguments are never read by the shell.** They reach the program as the
 *   shell's own argument list, so a quote, a `$` or a newline in one is only a
 *   character in it. What the launcher records about the app is quoted; the
 *   arguments are not part of any string it builds.
 * - **A second run offers to remove it.** And before offering, an install over
 *   our own launcher refreshes it, so a launcher written by an older build
 *   follows the newer one.
 */
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** The one thing the menu says. */
export const MENU_LABEL = 'Install command-line tool…'

/** What a person types. */
export const COMMAND_NAME = 'harnessdesk'

/**
 * The app's bundle id, which is how a launcher finds an app that moved.
 * `packaging.test.mjs` holds it equal to `build.appId` in `package.json`.
 */
export const BUNDLE_ID = 'app.harnessdesk.desktop'

/**
 * The second line of our launcher, exactly. A file is ours when its first line
 * is `#!/bin/sh` and its second is this, and for no other reason: a script that
 * quotes the sentence further down is somebody else's script.
 */
export const LAUNCHER_MARKER =
  '# harnessdesk-launcher: installed by the HarnessDesk app. The app replaces or removes only a file that has this line.'

const SHEBANG = '#!/bin/sh'

/** Where an app is looked for when it has moved, before Spotlight is asked. */
const DEFAULT_SEARCH_FOLDERS = ['/Applications', '$HOME/Applications']

/** The candidate folders, in order of preference: the XDG one, then the older one. */
const candidateFolders = (home) => [join(home, '.local', 'bin'), join(home, 'bin')]

/** A string as one shell word, whatever it holds. */
const quoted = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

/** A search folder as one shell word; `$HOME/…` stays expandable, anything else is quoted. */
const searchWord = (folder) => {
  const rest = folder.startsWith('$HOME/') ? folder.slice('$HOME/'.length) : null
  return rest !== null && /^[A-Za-z0-9._/ -]*$/.test(rest) ? `"$HOME/${rest}"` : quoted(folder)
}

/**
 * Where this running app and its bundled command line are, for the launcher to
 * record. A packaged app is a `.app`, so the launcher also records where the
 * runtime and the command line sit *inside* it: that is what lets it recognise
 * a copy of the app that moved. A development build runs out of a checkout,
 * where there is no bundle to search for, so it records its own two paths only.
 */
export const targetOf = ({ execPath, entry, packaged, bundleId = BUNDLE_ID }) => {
  const plain = { runtime: execPath, entry, bundle: null }
  if (!packaged) return plain
  const app = dirname(dirname(dirname(execPath)))
  if (!app.endsWith('.app')) return plain
  const runtimeIn = relative(app, execPath)
  const entryIn = relative(app, entry)
  const inside = (path) => path !== '' && !path.startsWith('..') && !isAbsolute(path)
  if (!inside(runtimeIn) || !inside(entryIn)) return plain
  return { runtime: execPath, entry, bundle: { id: bundleId, path: app, runtimeIn, entryIn } }
}

/**
 * The launcher: one POSIX script, the same on every machine apart from the
 * paths it records.
 *
 * The recorded paths come first and are the fast path: an app that has not
 * moved never reaches the search. The search is for an app that has, and it
 * tries the usual folders before it asks Spotlight, which is slower and may be
 * switched off. It exits 127 with a sentence when there is no app to run.
 */
export const launcherText = ({ runtime, entry, bundle = null, searchFolders = DEFAULT_SEARCH_FOLDERS }) =>
  [
    SHEBANG,
    LAUNCHER_MARKER,
    '#',
    "# This runs the command line bundled inside the HarnessDesk app, on the app's own",
    '# runtime, so no separate Node install is needed. Arguments go through unchanged.',
    '',
    `runtime=${quoted(runtime)}`,
    `entry=${quoted(entry)}`,
    '',
    '# Where the app sits when it is not where it was: its id, its name, and where the',
    '# runtime and the command line are inside it. Empty for a development build.',
    `bundle_id=${quoted(bundle?.id ?? '')}`,
    `app_name=${quoted(bundle ? basename(bundle.path) : '')}`,
    `runtime_in_app=${quoted(bundle?.runtimeIn ?? '')}`,
    `entry_in_app=${quoted(bundle?.entryIn ?? '')}`,
    '',
    'usable() {',
    '  [ -x "$1/$runtime_in_app" ] && [ -f "$1/$entry_in_app" ]',
    '}',
    '',
    'if [ ! -x "$runtime" ] || [ ! -f "$entry" ]; then',
    '  app=',
    '  if [ -n "$bundle_id" ]; then',
    `    for folder in ${searchFolders.map(searchWord).join(' ')}; do`,
    '      if usable "$folder/$app_name"; then',
    '        app=$folder/$app_name',
    '        break',
    '      fi',
    '    done',
    '    if [ -z "$app" ] && command -v mdfind >/dev/null 2>&1; then',
    `      app=$(mdfind "kMDItemCFBundleIdentifier == '$bundle_id'" 2>/dev/null | while IFS= read -r candidate; do`,
    '        if usable "$candidate"; then',
    "          printf '%s\\n' \"$candidate\"",
    '          break',
    '        fi',
    '      done)',
    '    fi',
    '  fi',
    '  if [ -z "$app" ]; then',
    "    printf '%s\\n' 'harnessdesk: HarnessDesk was not found where it was installed or in the usual places.' \\",
    "      'Install HarnessDesk again, then choose Install command-line tool… in its menu.' >&2",
    '    exit 127',
    '  fi',
    '  runtime=$app/$runtime_in_app',
    '  entry=$app/$entry_in_app',
    'fi',
    '',
    'export ELECTRON_RUN_AS_NODE=1',
    'exec "$runtime" "$entry" "$@"',
    '',
  ].join('\n')

/** Whether this text is a launcher this module wrote. */
export const isOurLauncher = (text) => {
  const lines = String(text).split('\n', 3)
  return lines[0] === SHEBANG && lines[1] === LAUNCHER_MARKER
}

/** Our launcher is a few kilobytes; anything much larger is not it, and is not read. */
const LARGEST_LAUNCHER = 64 * 1024

/**
 * What is at `path`: nothing, our launcher, or something else. Never follows a
 * link: a link is somebody's arrangement, however it points.
 */
export const inspectLauncher = (path) => {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'absent' }
    throw error
  }
  if (stat.isSymbolicLink()) return { state: 'foreign', why: 'link' }
  if (stat.isDirectory()) return { state: 'foreign', why: 'folder' }
  if (!stat.isFile() || stat.size > LARGEST_LAUNCHER) return { state: 'foreign', why: 'file' }
  const text = readFileSync(path, 'utf8')
  return isOurLauncher(text) ? { state: 'ours', text } : { state: 'foreign', why: 'file' }
}

/** What is at `harnessdesk` in each candidate folder, in order. */
const findLaunchers = (home) =>
  candidateFolders(home).map((dir) => {
    const path = join(dir, COMMAND_NAME)
    return { dir, path, ...inspectLauncher(path) }
  })

const tildify = (path, home) => {
  const inside = relative(home, path)
  if (inside === '') return '~'
  return inside.startsWith('..') || isAbsolute(inside) ? path : `~/${inside}`
}

class LauncherError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LauncherError'
    this.code = code
    Object.assign(this, details)
  }
}

const reasonOf = (error) => {
  switch (error?.code) {
    case 'EEXIST':
    case 'ENOTDIR':
      return 'it is not a folder'
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'it is not writable'
    default:
      return String(error?.message ?? error)
  }
}

/** Absolute, normalised entries of a PATH string; a relative entry is not a folder anyone can name. */
const entriesOf = (loginPath) =>
  String(loginPath)
    .split(':')
    .filter((entry) => isAbsolute(entry))
    .map((entry) => resolve(entry))

const sameFolder = (a, b) => {
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

const isOnPath = (dir, entries) => entries.some((entry) => sameFolder(entry, dir))

/** A folder this person can put a file in, made if it is not there yet. */
const usableFolder = (dir) => {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    const stat = statSync(dir)
    if (!stat.isDirectory()) return { ok: false, reason: 'it is not a folder' }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return { ok: false, reason: 'it belongs to another user' }
    }
    accessSync(dir, constants.W_OK)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}

const temporaryIn = (dir) => join(dir, `.${COMMAND_NAME}.${process.pid}.${randomUUID()}.tmp`)

/**
 * A new launcher, atomically and without ever replacing something that
 * appeared there a moment ago: the file is written beside its place and then
 * linked into it, and a link refuses a name that is taken. (Exported for its
 * test: the race it answers cannot be made to happen from outside.)
 */
export const createLauncher = (path, text) => {
  const temporary = temporaryIn(dirname(path))
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o755 })
    chmodSync(temporary, 0o755)
    try {
      linkSync(temporary, path)
    } catch (error) {
      if (error.code === 'EEXIST') throw error
      // A folder on a volume with no hard links: create it in place, still without replacing.
      writeFileSync(path, text, { flag: 'wx', mode: 0o755 })
      chmodSync(path, 0o755)
    }
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      // Never written, or already gone.
    }
  }
}

/** Our own launcher, replaced atomically; refused if it stopped being ours since it was read. */
export const replaceLauncher = (path, text) => {
  if (inspectLauncher(path).state !== 'ours') {
    throw new LauncherError('foreign', 'A harnessdesk that is not ours is there.', { path })
  }
  const temporary = temporaryIn(dirname(path))
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o755 })
    chmodSync(temporary, 0o755)
    renameSync(temporary, path)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      // Renamed into place, or never written.
    }
  }
}

/**
 * Puts the launcher where a terminal will find it, and says where and whether
 * that folder is on the PATH the person's login shell builds.
 *
 * `loginPath` is that PATH, or null when it could not be read. Returns
 * `{ status: 'installed' | 'updated' | 'unchanged', path, dir, onPath }`, with
 * `onPath` null when the PATH was unknown. Throws a `foreign` error before it
 * writes anything when a `harnessdesk` that is not ours is in either candidate
 * folder, and a `no-folder` error when neither can take a file.
 */
export const installLauncher = ({ home, target, loginPath, searchFolders }) => {
  const text = launcherText({ ...target, ...(searchFolders ? { searchFolders } : {}) })
  const found = findLaunchers(home)
  const entries = typeof loginPath === 'string' ? entriesOf(loginPath) : null
  const onPathFor = (dir) => (entries === null ? null : isOnPath(dir, entries))

  // Ours is replaced where it is, and what sits in the other candidate folder
  // is not this install's business: that command was there before it, or after.
  const ours = found.find((one) => one.state === 'ours')
  if (ours) {
    if (ours.text === text) return { status: 'unchanged', path: ours.path, dir: ours.dir, onPath: onPathFor(ours.dir) }
    replaceLauncher(ours.path, text)
    return { status: 'updated', path: ours.path, dir: ours.dir, onPath: onPathFor(ours.dir) }
  }

  // A first install stops at anyone else's harnessdesk, in either folder: two
  // commands of one name would shadow each other, and which wins would
  // depend on an order the person never chose.
  const foreign = found.find((one) => one.state === 'foreign')
  if (foreign) {
    throw new LauncherError('foreign', `${tildify(foreign.path, home)} is not ours.`, { path: foreign.path, why: foreign.why })
  }

  // A folder that is already on PATH wins; the order within each group is the candidates' own.
  const candidates = candidateFolders(home)
  const order =
    entries === null
      ? candidates
      : [...candidates.filter((dir) => isOnPath(dir, entries)), ...candidates.filter((dir) => !isOnPath(dir, entries))]
  const tried = []
  for (const dir of order) {
    const folder = usableFolder(dir)
    if (!folder.ok) {
      tried.push({ dir, reason: folder.reason })
      continue
    }
    const path = join(dir, COMMAND_NAME)
    try {
      createLauncher(path, text)
    } catch (error) {
      if (error.code === 'EEXIST') throw new LauncherError('foreign', `${tildify(path, home)} is not ours.`, { path, why: 'file' })
      tried.push({ dir, reason: reasonOf(error) })
      continue
    }
    return { status: 'installed', path, dir, onPath: onPathFor(dir) }
  }
  throw new LauncherError(
    'no-folder',
    `The launcher could not be put in ${tried.map((one) => `${tildify(one.dir, home)} (${one.reason})`).join(' or ')}.`,
    { tried },
  )
}

/** Deletes our launcher, and only ours. */
export const removeLauncher = ({ home }) => {
  const found = findLaunchers(home)
  const ours = found.find((one) => one.state === 'ours')
  if (ours) {
    // Read again at the last moment: it is the file that is checked, not the memory of it.
    if (inspectLauncher(ours.path).state === 'ours') {
      unlinkSync(ours.path)
      return { status: 'removed', path: ours.path }
    }
  }
  const foreign = found.find((one) => one.state === 'foreign')
  if (foreign) return { status: 'foreign', path: foreign.path }
  return { status: 'absent' }
}

/**
 * The one line that puts a folder on PATH, in the person's own shell's words,
 * and the file it belongs in. Said to the person; never written for them.
 */
export const pathAdvice = ({ dir, home, shell }) => {
  const inside = relative(home, dir)
  const spelled = inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) ? `$HOME/${inside}` : dir
  const name = basename(shell ?? '')
  if (name === 'fish') return { file: null, line: `fish_add_path ${spelled}` }
  const file = name === 'zsh' ? '~/.zshrc' : name === 'bash' ? '~/.bash_profile' : '~/.profile'
  return { file, line: `export PATH="${spelled}:$PATH"` }
}

const dialog = (message, detail, buttons = ['OK']) => ({ message, detail, buttons, defaultId: 0, cancelId: 0 })

const installedDialog = (result, { home, shell }) => {
  const where = tildify(result.path, home)
  if (result.onPath === true) {
    return { request: dialog('The command-line tool is installed', `Run ${COMMAND_NAME} in a terminal to use it. It is at ${where}.`) }
  }
  const advice = pathAdvice({ dir: result.dir, home, shell })
  const how = advice.file
    ? `add this line to ${advice.file} and open a new terminal window:`
    : 'run this once in a terminal:'
  const lead =
    result.onPath === false
      ? [`It is at ${where}, and that folder is not on your PATH.`, `To run it as ${COMMAND_NAME}, ${how}`]
      : [
          `It is at ${where}. HarnessDesk could not read your shell’s PATH to check whether that folder is on it.`,
          `If ${COMMAND_NAME} is not found, ${how}`,
        ]
  return {
    request: dialog(
      result.onPath === false
        ? 'The command-line tool is installed, but its folder is not on your PATH'
        : 'The command-line tool is installed',
      [...lead, '', advice.line].join('\n'),
      ['OK', 'Copy Line'],
    ),
    copy: advice.line,
  }
}

const presentDialog = (path, home) =>
  dialog(
    'The command-line tool is already installed',
    `${COMMAND_NAME} is at ${tildify(path, home)}.\n\nRemove it to stop using ${COMMAND_NAME} from a terminal. HarnessDesk itself is not affected.`,
    ['Done', 'Remove'],
  )

const removedDialog = (path, home) =>
  dialog(
    'The command-line tool was removed',
    `${tildify(path, home)} was deleted. Choose ${MENU_LABEL} to add it again.`,
  )

const foreignDialog = (path, home) =>
  dialog(
    'The command-line tool was not installed',
    `${tildify(path, home)} is already there, and HarnessDesk did not put it there, so it was left as it is. Move or rename it, then choose ${MENU_LABEL} again.`,
  )

const unavailableDialog = (missing, home) =>
  dialog(
    'This build of HarnessDesk does not include the command-line tool',
    `The bundled command line was not found${missing ? ` at ${tildify(missing, home)}` : ''}. Reinstall HarnessDesk and try again.`,
  )

const failedDialog = (message) => dialog('The command-line tool could not be installed', message)

/**
 * The menu item. `run()` is its click: it never throws and never rejects, as
 * the shell treats an unhandled rejection as a crash, and it answers the same
 * promise to a second click while the first is still open.
 *
 * - `target()` is what this running app and its bundled command line are
 *   (`targetOf`); it may throw.
 * - `loginPath()` resolves to the PATH the person's login shell builds, or null.
 * - `showDialog(request)` resolves to the index of the button pressed.
 * - `copyText(text)` puts a line on the clipboard.
 */
export const createCommandLineTool = ({
  platform = process.platform,
  home = homedir(),
  shell = process.env['SHELL'],
  target,
  loginPath = async () => null,
  showDialog,
  copyText = () => {},
  log = () => {},
  searchFolders,
}) => {
  const available = platform === 'darwin' || platform === 'linux'
  const where = { home, shell }

  /** Every dialog goes through here: one that cannot be shown is logged and read as the first button. */
  const ask = async (request) => {
    try {
      return await showDialog(request)
    } catch (error) {
      log('command-line tool dialog failed', { error: String(error?.message ?? error) })
      return 0
    }
  }

  /** The app and the bundled command line, or the first thing that is missing. */
  const checked = () => {
    let found
    try {
      found = target()
    } catch (error) {
      // A build that cannot even name its command line does not carry it.
      throw new LauncherError('no-tool', 'The bundled command line is missing.', { path: error?.path ?? null })
    }
    for (const path of [found.entry, found.runtime]) {
      if (!existsSync(path)) throw new LauncherError('no-tool', 'The bundled command line is missing.', { path })
    }
    return found
  }

  const shellPath = async () => {
    try {
      return await loginPath()
    } catch (error) {
      log('command-line tool could not read the login shell PATH', { error: String(error?.message ?? error) })
      return null
    }
  }

  const execute = async () => {
    if (!available) return { outcome: 'unavailable' }
    const ours = findLaunchers(home).find((one) => one.state === 'ours')
    let app = null
    let missing = null
    try {
      app = checked()
    } catch (error) {
      if (error.code !== 'no-tool') throw error
      missing = error.path
    }

    if (ours) {
      // An install over our own launcher refreshes it first, so a launcher an
      // older build wrote follows this one; then the person is offered the way out.
      let refreshed = false
      if (app) {
        const result = installLauncher({ home, target: app, loginPath: null, searchFolders })
        refreshed = result.status === 'updated'
        if (refreshed) log('command-line tool launcher refreshed', { path: result.path })
      }
      const choice = await ask(presentDialog(ours.path, home))
      if (choice !== 1) return { outcome: 'kept', path: ours.path, refreshed }
      const removal = removeLauncher({ home })
      if (removal.status !== 'removed') return { outcome: 'kept', path: ours.path, refreshed }
      log('command-line tool removed', { path: removal.path })
      await ask(removedDialog(removal.path, home))
      return { outcome: 'removed', path: removal.path }
    }

    if (!app) {
      await ask(unavailableDialog(missing, home))
      return { outcome: 'unavailable', missing }
    }

    const login = await shellPath()
    let result
    try {
      result = installLauncher({ home, target: app, loginPath: login, searchFolders })
    } catch (error) {
      if (error.code === 'foreign') {
        log('command-line tool left a harnessdesk that is not ours', { path: error.path })
        await ask(foreignDialog(error.path, home))
        return { outcome: 'refused', path: error.path }
      }
      log('command-line tool install failed', { error: String(error?.message ?? error) })
      await ask(failedDialog(String(error?.message ?? error)))
      return { outcome: 'failed', error: String(error?.message ?? error) }
    }
    log('command-line tool installed', { path: result.path, onPath: result.onPath })
    const shown = installedDialog(result, where)
    const choice = await ask(shown.request)
    if (shown.copy && choice === 1) copyText(shown.copy)
    return { outcome: 'installed', path: result.path, onPath: result.onPath }
  }

  let current = null
  const run = () => {
    current ??= execute()
      .catch(async (error) => {
        // Anything that was not foreseen is said once and logged; a menu click must never crash the shell.
        log('command-line tool failed', { error: String(error?.stack ?? error) })
        await ask(failedDialog(String(error?.message ?? error)))
        return { outcome: 'failed', error: String(error?.message ?? error) }
      })
      .finally(() => {
        current = null
      })
    return current
  }

  return { available, run }
}
