import { mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
 */
const canonical = (path) => {
  mkdirSync(path, { recursive: true })
  return realpathSync(path)
}

/**
 * Off the real machine's home entirely — a fixed folder under the OS temp
 * directory, not `~/.harnessdesk-shots`. The staged desk, the fake Codex home
 * and every repository this rig builds live under here, so nothing it writes
 * or photographs can carry this machine's actual home path.
 */
export const HOME = canonical(process.env['HD_SHOTS_HOME'] ?? join(tmpdir(), 'harnessdesk-shots'))

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
 */
export const WORK = canonical(process.env['HD_SHOTS_WORK'] ?? join(HOME, 'person', 'work'))

// The built-in adapter is constructed even when a camera ACP row replaces it.
// Capture and seed both use this inert configuration; importing it never stages
// or clears the desk.
export const SHOT_ENV = {
  ...process.env,
  CODEX_HOME: join(HOME, 'codex-home'),
  HARNESSDESK_CODEX_BINARY: join(APP, 'packages/adapter-codex/test/fixtures/fake-codex.mjs'),
  FAKE_CODEX_VERSION_FILE: join(HOME, 'codex-version'),
}
