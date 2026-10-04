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
 *   removed, and only the very file that was looked at: it is taken by being
 *   renamed to a name only this call knows, and is then checked (a regular
 *   file, opened without following a link, our marker, the same device and
 *   inode as the one that was looked at) before it is replaced or deleted.
 *   Anything else is put back, and the item says the launcher changed. A check
 *   made just before a change leaves a window for a swap in between; the file
 *   being held is what closes it.
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
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
 * How a launcher is opened to be read: not through a link, and without waiting
 * for a writer if it turns out to be a pipe. It is one open, and everything
 * known about the file comes from that descriptor, so what was read and who it
 * was (device and inode) are the same file by construction. A look that took
 * the type from the name and then read the name again could be handed a
 * different file, or a pipe to wait on forever, by a swap in between.
 */
const READ_WITHOUT_FOLLOWING = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/**
 * What is at `path`: nothing, our launcher, or something else. Never follows a
 * link: a link is somebody's arrangement, however it points. Our launcher comes
 * back with its `id`, the device and inode of the file that was read.
 */
export const inspectLauncher = (path) => {
  let descriptor
  try {
    descriptor = openSync(path, READ_WITHOUT_FOLLOWING)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'absent' }
    // O_NOFOLLOW refuses a link, one that points nowhere included.
    if (error.code === 'ELOOP' || error.code === 'EMLINK') return { state: 'foreign', why: 'link' }
    // A socket or a device is not a file this module wrote.
    if (error.code === 'ENXIO' || error.code === 'ENODEV' || error.code === 'EOPNOTSUPP') return { state: 'foreign', why: 'file' }
    throw error
  }
  try {
    const stat = fstatSync(descriptor, { bigint: true })
    if (stat.isDirectory()) return { state: 'foreign', why: 'folder' }
    if (!stat.isFile() || stat.size > BigInt(LARGEST_LAUNCHER)) return { state: 'foreign', why: 'file' }
    const buffer = Buffer.alloc(LARGEST_LAUNCHER + 1)
    let length = 0
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (read === 0) break
      length += read
    }
    // A file that grew past the limit since it was measured is not ours either.
    if (length > LARGEST_LAUNCHER) return { state: 'foreign', why: 'file' }
    const text = buffer.toString('utf8', 0, length)
    return isOurLauncher(text)
      ? { state: 'ours', text, id: { dev: stat.dev, ino: stat.ino } }
      : { state: 'foreign', why: 'file' }
  } finally {
    closeSync(descriptor)
  }
}

/** Whether two looks were at one file. */
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

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

/** The name a file is held under while it is being decided about: in its own folder, and known to nobody else. */
const heldIn = (dir) => join(dir, `.${COMMAND_NAME}.${process.pid}.${randomUUID()}.held`)

const unlinkQuietly = (path) => {
  try {
    unlinkSync(path)
  } catch {
    // Never written, already moved into place, or already gone.
  }
}

/** A new launcher, written and made executable beside its place, before anything is taken. */
const prepareLauncher = (path, text) => {
  const temporary = temporaryIn(dirname(path))
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o755 })
    chmodSync(temporary, 0o755)
  } catch (error) {
    unlinkQuietly(temporary)
    throw error
  }
  return temporary
}

/** Gives a prepared launcher its name, and never replaces anything: a link refuses a name that is taken. */
const placeLauncher = (temporary, path) => {
  try {
    linkSync(temporary, path)
  } catch (error) {
    if (error.code === 'EEXIST') throw error
    // A folder on a volume with no hard links: create it in place, still without replacing.
    writeFileSync(path, readFileSync(temporary), { flag: 'wx', mode: 0o755 })
    chmodSync(path, 0o755)
  }
}

/**
 * A new launcher, atomically and without ever replacing something that
 * appeared there a moment ago: the file is written beside its place and then
 * linked into it, and a link refuses a name that is taken. (Exported for its
 * test: the race it answers cannot be made to happen from outside.)
 */
export const createLauncher = (path, text) => {
  const temporary = prepareLauncher(path, text)
  try {
    placeLauncher(temporary, path)
  } finally {
    unlinkQuietly(temporary)
  }
}

/**
 * Takes the file at `path` by moving it to a name only this call knows, in its
 * own folder. A rename is atomic and takes whatever is at the name at that
 * instant, so from then on the file cannot be swapped under what is decided
 * about it: nothing else knows where it is. (The alternative, checking the name
 * and then deleting or renaming over it, leaves a window between the two.)
 */
const claim = (path) => {
  const held = heldIn(dirname(path))
  renameSync(path, held)
  return held
}

/**
 * Puts a claimed file back under its name. Never over something that has taken
 * the name since: then it stays where it is, and this answers with
 * its recovery location. Only a regular file goes back, by a link which
 * refuses a taken name atomically. There is no check-then-rename fallback:
 * volumes without hard links and other file types stay held and are named
 * in the result, rather than risking a newcomer at the original name.
 */
const restore = (held, path) => {
  try {
    if (!lstatSync(held).isFile()) return { restored: false, held }
    linkSync(held, path)
  } catch {
    return { restored: false, held }
  }
  try {
    unlinkSync(held)
    return { restored: true }
  } catch {
    return { restored: true, held }
  }
}

/** Every failure after taking a file carries the result of its recovery. */
const recoverFailure = (held, path, error) => new LauncherError(
  'recovery',
  String(error?.message ?? error),
  { path, ...restore(held, path) },
)

/**
 * Takes hold of the launcher at `path`, and of nothing but the launcher that
 * was looked at (`expected`). The file is claimed first, and then checked as
 * what is held: the same device and inode, a regular file, our marker, opened
 * without following a link. If it is anything else it is put back and this
 * throws `changed`, naming where it is kept when it could not be put back.
 *
 * `hooks` are for tests, which swap the file at the two instants that matter:
 * `afterCheck` just before it is claimed, `afterClaim` just after.
 */
const holdOurs = (path, expected, hooks) => {
  hooks.afterCheck?.({ path })
  let held
  try {
    held = claim(path)
  } catch (error) {
    if (error.code === 'ENOENT') throw new LauncherError('changed', `${path} was gone when it was to be changed.`, { path, gone: true })
    throw error
  }
  let seen
  try {
    hooks.afterClaim?.({ path, held })
    seen = inspectLauncher(held)
  } catch (error) {
    throw recoverFailure(held, path, error)
  }
  if (seen.state === 'ours' && sameFile(seen.id, expected.id)) return held
  throw new LauncherError('changed', `${path} was changed while it was being worked on.`, { path, ...restore(held, path) })
}

/**
 * Our own launcher, replaced; refused if the file at its name is not the one
 * that was looked at (`expected`, or a look taken now), whatever happened in
 * between. The new launcher is written first, so the name is without a file
 * only for as long as it takes to check the old one and link the new one in.
 */
export const replaceLauncher = (path, text, { expected, hooks = {} } = {}) => {
  const looked = expected ?? inspectLauncher(path)
  if (looked.state !== 'ours') throw new LauncherError('foreign', 'A harnessdesk that is not ours is there.', { path })
  const temporary = prepareLauncher(path, text)
  try {
    const held = holdOurs(path, looked, hooks)
    try {
      placeLauncher(temporary, path)
    } catch (error) {
      if (error.code === 'EEXIST') {
        // Something took the name while ours was set aside. It stays; ours, which was being replaced, goes.
        try {
          unlinkSync(held)
        } catch (cleanupError) {
          throw recoverFailure(held, path, cleanupError)
        }
        throw new LauncherError('changed', `${path} was taken by something else while it was being replaced.`, { path })
      }
      throw recoverFailure(held, path, error)
    }
    try {
      unlinkSync(held)
    } catch (error) {
      throw recoverFailure(held, path, error)
    }
  } finally {
    unlinkQuietly(temporary)
  }
}

/**
 * Puts the launcher where a terminal will find it, and says where and whether
 * that folder is on the PATH the person's login shell builds.
 *
 * `loginPath` is that PATH, or null when it could not be read. Returns
 * `{ status: 'installed' | 'updated' | 'unchanged', path, dir, onPath }`, with
 * `onPath` null when the PATH was unknown. Our own launcher, wherever it is, is
 * brought up to date in place, and a `changed` error is thrown, with the file
 * left as it is, if it was swapped for something else while that was done.
 * Otherwise a first install throws a `foreign` error, before it writes
 * anything, when a `harnessdesk` that is not ours is in either candidate
 * folder, and a `no-folder` error when neither can take a file.
 */
export const installLauncher = ({ home, target, loginPath, searchFolders, hooks = {} }) => {
  const text = launcherText({ ...target, ...(searchFolders ? { searchFolders } : {}) })
  const found = findLaunchers(home)
  const entries = typeof loginPath === 'string' ? entriesOf(loginPath) : null
  const onPathFor = (dir) => (entries === null ? null : isOnPath(dir, entries))

  // Ours is replaced where it is, and what sits in the other candidate folder
  // is not this install's business: that command was there before it, or after.
  const ours = found.find((one) => one.state === 'ours')
  if (ours) {
    if (ours.text === text) return { status: 'unchanged', path: ours.path, dir: ours.dir, onPath: onPathFor(ours.dir) }
    replaceLauncher(ours.path, text, { expected: ours, hooks })
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

/**
 * Deletes our launcher, and only ours: the file that was looked at, taken and
 * checked before it is deleted (see `holdOurs`). Throws `changed`, with the
 * file left as it is, if it was swapped for something else in between; a
 * launcher that somebody else removed first is simply gone.
 */
export const removeLauncher = ({ home, hooks = {} }) => {
  const found = findLaunchers(home)
  const ours = found.find((one) => one.state === 'ours')
  if (ours) {
    let held
    try {
      held = holdOurs(ours.path, ours, hooks)
    } catch (error) {
      if (error.code === 'changed' && error.gone) return { status: 'absent' }
      throw error
    }
    try {
      unlinkSync(held)
    } catch (error) {
      throw recoverFailure(held, ours.path, error)
    }
    return { status: 'removed', path: ours.path }
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

const recoveryDialog = (verb, error, home) => dialog(
  `The command-line tool could not be ${verb}`,
  `${error.message}\n\n${error.restored
    ? `${tildify(error.path, home)} was restored.`
    : `${tildify(error.path, home)} could not be restored.`}${error.held
    ? ` The file is kept as ${tildify(error.held, home)}.`
    : ''} Choose ${MENU_LABEL} to try again.`,
)

/** The launcher was swapped for something else while it was being updated or removed, and was left as it is. */
const changedDialog = (verb, error, home) =>
  dialog(
    `The command-line tool was not ${verb}`,
    `${tildify(error.path, home)} was changed while HarnessDesk was ${verb === 'removed' ? 'removing' : 'updating'} it, so it was left as it is.${
      error.held ? ` What was there is kept as ${tildify(error.held, home)}.` : ''
    } Choose ${MENU_LABEL} to look again.`,
  )

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
 * - `hooks` are for tests: they run at the instants a swap would matter (see `holdOurs`).
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
  hooks = {},
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

  const reportRecovery = async (verb, error) => {
    log('command-line tool recovery', { path: error.path, held: error.held, restored: error.restored })
    await ask(recoveryDialog(verb, error, home))
    return { outcome: 'failed', error: error.message, path: error.path, restored: error.restored, ...(error.held ? { held: error.held } : {}) }
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
        try {
          const result = installLauncher({ home, target: app, loginPath: null, searchFolders, hooks })
          refreshed = result.status === 'updated'
          if (refreshed) log('command-line tool launcher refreshed', { path: result.path })
        } catch (error) {
          if (error.code === 'recovery') return reportRecovery('updated', error)
          if (error.code !== 'changed') throw error
          log('command-line tool launcher changed while it was updated', { path: error.path })
          await ask(changedDialog('updated', error, home))
          return { outcome: 'changed', path: error.path, ...(error.held ? { held: error.held } : {}) }
        }
      }
      const choice = await ask(presentDialog(ours.path, home))
      if (choice !== 1) return { outcome: 'kept', path: ours.path, refreshed }
      let removal
      try {
        removal = removeLauncher({ home, hooks })
      } catch (error) {
        if (error.code === 'recovery') return reportRecovery('removed', error)
        if (error.code !== 'changed') throw error
        log('command-line tool launcher changed while it was removed', { path: error.path })
        await ask(changedDialog('removed', error, home))
        return { outcome: 'changed', path: error.path, ...(error.held ? { held: error.held } : {}) }
      }
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
