import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Resolved through every symlink in its own path, not only joined together.
 *
 * macOS resolves `/var` and `/tmp` to `/private/var` and `/private/tmp`, so a
 * path built from `$TMPDIR` or a bare `HD_SHOTS_HOME`/`HD_SHOTS_WORK` override
 * is not the path Electron hands back once it has looked at the same folder —
 * the app reports the resolved form, `/private/...`, while this constant would
 * otherwise still say the as-given one. Two things read this path and compare
 * it against what is on screen: `audit.mjs`'s `TILDIFY`, matching a prefix to
 * shorten, and the frame history check, matching a root to allow. Both need
 * the same string the window shows, so it is resolved once here rather than
 * wherever it is later compared (#904).
 *
 * `realpathSync` needs the folder to exist, so it is created first — harmless
 * even when a driver only wants the name, since every driver creates it
 * itself moments later regardless.
 *
 * The leaf itself is refused if it is a symlink, before anything reads
 * through it, writes into it or deletes what `seed.mjs`'s `RESIDUE` names
 * inside it. This resolves every symlink *in* a path's ancestors on purpose
 * (`/tmp` to `/private/tmp`) — the leaf is the one component that has to be a
 * real folder this rig controls: `HD_SHOTS_HOME`/`HD_SHOTS_WORK`, or their
 * defaults, followed blindly through a link would read, write and delete
 * wherever that link points instead of this rig's own folder, which is the
 * same mistake `seed.mjs`'s non-empty-unmarked-folder guard exists to catch,
 * wearing a different shape. Caught here rather than left to whichever
 * `fs` call happens to hit it first, because every driver imports this
 * module before it does anything else.
 */
const refuseSymlink = (path) => {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (info.isSymbolicLink()) {
    throw new Error(
      `${path} is a symlink, not a real folder. This rig will not read, write or delete through a link — ` +
        'point HD_SHOTS_HOME/HD_SHOTS_WORK at the real folder, or remove the link.',
    )
  }
}

const canonical = (path) => {
  refuseSymlink(path)
  mkdirSync(path, { recursive: true })
  return realpathSync(path)
}

/**
 * Refuses a resolved path that *is* this machine's real home or its real desk
 * home (`~/.harnessdesk`) — checked by equality, after every symlink in
 * either side has been followed, so a rig home that merely points at one
 * through a link, or that was reused as one outright, is caught the same way.
 *
 * `seed.mjs`'s own guard asks a narrower question: whether *this rig* marked
 * the folder, or found it empty. That guard would happily mark and then later
 * clear a folder that happens to be empty on its first seed — which a real
 * desk's home always is, before its first launch — and only bites once that
 * folder is reused for real, on the very next reseed (#910). Checked here
 * instead, against what the folder resolves to rather than what it is marked
 * as, so the marker cannot make the question moot.
 */
const refuseRealDeskHome = (path) => {
  const home = realpathSync(homedir())
  if (path === home) {
    throw new Error(
      `${path} is this machine's real home ($HOME). This rig will not read, write or delete there — ` +
        'point HD_SHOTS_HOME at an empty folder, or leave it unset for the default (a folder under the OS temp directory).',
    )
  }
  const deskHome = (() => {
    const asGiven = join(home, '.harnessdesk')
    try {
      return realpathSync(asGiven)
    } catch {
      return asGiven
    }
  })()
  if (path === deskHome) {
    throw new Error(
      `${path} is this machine's real desk home (~/.harnessdesk). This rig will not read, write or delete there — ` +
        'point HD_SHOTS_HOME at an empty folder, or leave it unset for the default (a folder under the OS temp directory).',
    )
  }
}

/**
 * Refuses a resolved home this process does not own.
 *
 * `/tmp` (and the OS temp directory generally) is shared on a multi-user
 * machine, so the rig's own default path is a name any account on the box
 * could have created first — and once it exists, `canonical()`'s `mkdirSync`
 * is a harmless no-op on a folder somebody else made, which would otherwise
 * let this rig reuse and later clear a home it does not own (#928). Skipped
 * where there is no POSIX owner to ask, rather than guessing.
 */
const refuseUnownedHome = (path) => {
  if (typeof process.getuid !== 'function') return
  const owner = statSync(path).uid
  const me = process.getuid()
  if (owner !== me) {
    throw new Error(
      `${path} is owned by another account on this machine (uid ${owner}, not this process's ${me}). ` +
        'This rig will not reuse or clear a home it does not own — point HD_SHOTS_HOME at a folder of your own.',
    )
  }
}

const canonicalHome = (path) => {
  const home = canonical(path)
  refuseRealDeskHome(home)
  refuseUnownedHome(home)
  return home
}

/**
 * Off the real machine's home entirely — a fixed folder under the OS temp
 * directory, not `~/.harnessdesk-shots`. The staged desk, the fake Codex home
 * and every repository this rig builds live under here, so nothing it writes
 * or photographs can carry this machine's actual home path.
 */
export const HOME = canonicalHome(process.env['HD_SHOTS_HOME'] ?? join(tmpdir(), 'harnessdesk-shots'))

/**
 * A "person" folder inside the staged home, one level above where the
 * repositories actually sit.
 *
 * The project path is on camera — the board header prints it and so does the
 * approval dialog — and the app writes it with a tilde where it can. Nesting
 * `work` a level under a folder the drivers shorten to `~` (`shoot.mjs` and
 * `gif.mjs` both tildify `dirname(WORK)`, not `WORK` itself) means a frame
 * still reads `~/work/storefront`, the way a real checkout would, without the
 * repositories ever sitting under this machine's actual home.
 *
 * The default is deliberately *not* created here the way `canonical()`
 * creates everything else. `HOME` is already resolved through every symlink
 * in its own path, and `person`/`work` are plain literal segments with none
 * of their own to resolve — so the string is already in the same form
 * `canonical()` would hand back, without the `mkdirSync` that earns it
 * elsewhere. That `mkdirSync` is exactly what must not happen before
 * `seed.mjs` has had a chance to ask whether this home is `seed.mjs`'s own:
 * importing this module used to leave an empty `person/work` scaffold
 * sitting inside a brand-new default `HOME` on its own, which made every
 * later `seed.mjs` run see a non-empty, unmarked folder and refuse to seed
 * it — the #909 guard doing exactly its job against a mess this module
 * caused. `refuseSymlink` still runs, because a link can sit at a path that
 * does not exist yet just as well as one that does.
 *
 * An override (`HD_SHOTS_WORK`) is a different folder from `HOME` by
 * definition, so creating it here cannot poison that check — it keeps the
 * full `canonical()` treatment, the same as always.
 */
export const WORK = process.env['HD_SHOTS_WORK']
  ? canonical(process.env['HD_SHOTS_WORK'])
  : (() => {
      const path = join(HOME, 'person', 'work')
      refuseSymlink(join(HOME, 'person'))
      refuseSymlink(path)
      return path
    })()

/**
 * Whether `codex` is the real built-in adapter, on its scripted fixture,
 * rather than a camera ACP row wearing the Codex brand.
 *
 * Defaults on (#927). ACP gives no reliable ceiling read-back at all — an ACP
 * fixture cannot report holding any level, documented in
 * `docs/agent-capabilities.md` — so a camera-only desk refuses every seat a
 * front-door start asks for, `{ kind: 'unheld', level: 'read', required: true }`,
 * and no rig scene or in-app walk that starts a Goal through a shape can ever
 * run end to end. The one row that can hold is the real adapter, which answers
 * over the same `fake-codex.mjs` every `adapter-codex` test already runs
 * against — no less invented than the camera rows it replaces, and every
 * scene that cares which is running already branches on this flag rather than
 * assuming one or the other. `'0'` opts back into the all-camera desk, the
 * shape the rig staged before #927, for whatever still wants it.
 */
export const NATIVE_CODEX = process.env['HD_SHOTS_NATIVE_CODEX'] !== '0'

// The built-in adapter is constructed even when a camera ACP row replaces it.
// Capture and seed both use this inert configuration; importing it never stages
// or clears the desk.
export const SHOT_ENV = {
  ...process.env,
  CODEX_HOME: join(HOME, 'codex-home'),
  HARNESSDESK_CODEX_BINARY: join(APP, 'packages/adapter-codex/test/fixtures/fake-codex.mjs'),
  FAKE_CODEX_VERSION_FILE: join(HOME, 'codex-version'),
}

/**
 * Refuses to drive the real app against a home nothing has seeded, rather
 * than launching it onto an empty desk and failing confusingly several steps
 * later — a missing runtime, a scene that cannot find a workspace, or a
 * blank window an unattended run has no way to explain.
 *
 * The two facts this checks for are the same two `seed.mjs`'s own guard
 * tracks: the marker an earlier seed wrote, and `agents.json`, one of the
 * files that seed writes alongside it. Either missing means this home has
 * never been seeded, or was seeded and then emptied — the new default lives
 * under the OS temp directory, which macOS (and most Linux distributions) is
 * free to clear on every reboot, so "just seeded yesterday" is not something
 * a driver can assume.
 *
 * `seed.mjs` never calls this — importing `config.mjs` is the one thing it
 * does before it goes on to seed exactly this home, and refusing here would
 * make seeding a home impossible the first time. It is for `shoot.mjs` and
 * `gif.mjs`, the drivers, to ask before they launch the real app.
 */
export const requireSeeded = () => {
  if (existsSync(join(HOME, '.rig-home.json')) && existsSync(join(HOME, 'agents.json'))) return
  process.stderr.write(`\n  ${HOME} has not been seeded. Run \`node script/shots/seed.mjs\` first.\n\n`)
  process.exit(1)
}
