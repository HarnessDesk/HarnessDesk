import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { runForOutput } from './run.js'

/**
 * The PATH a person's terminal has, given to a process that was not started
 * from one.
 *
 * An app opened from Finder or the Dock inherits launchd's environment, and
 * on a stock Mac `launchctl getenv PATH` prints nothing: the process gets
 * `/usr/bin:/bin:/usr/sbin:/sbin`, and nothing the person installed is on
 * it. Not Homebrew's `/opt/homebrew/bin`, not npm's global prefix, not
 * `~/.local/bin` where the Claude and Cursor installers put their binaries,
 * not `npx` itself. Every "is it installed?" the desk asks then answers no —
 * for agents the person runs in a terminal every day. Measured on this
 * machine: with that PATH, `which` finds none of npx, claude, gemini, codex,
 * cursor-agent, uvx or openclaw.
 *
 * The person's own answer to "where are my tools" is written in their shell
 * profile, so the honest reading is to ask the shell. The login shell is run
 * once, interactively (many profiles set PATH in `.zshrc`, which a
 * non-interactive shell never reads), asked to print its environment, and
 * only the PATH line is kept. On top of that come the well-known install
 * directories — the places a package manager or an installer puts a binary
 * whether or not the person's profile mentions it yet — so a tool installed
 * five minutes ago, before the profile was reloaded, is still found.
 *
 * Order matters and is the person's: their shell PATH first, in their order,
 * then anything this process already had, then the well-known directories.
 * Nothing is removed. `HARNESSDESK_PATH` prepends directories of the
 * person's choosing, for the one machine where the shell cannot be asked.
 */

/**
 * The shell, run the way every other probe here is run: in a process group
 * of its own, killed as a family at the deadline.
 *
 * A login shell is the likeliest thing on this machine to leave children
 * behind — a profile that starts a version manager, a daemon check, an
 * update notifier — and killing only the shell would leave those running
 * for as long as they liked. Nothing waits on this call, so a lingering
 * subtree would never be noticed; that is a reason to clean it up, not to
 * leave it. See `run.ts`, which owns the discipline.
 */
const runShell =
  (timeoutMs: number) =>
  async (shell: string, args: readonly string[]): Promise<string> => {
    const result = await runForOutput(shell, args, {
      timeoutMs,
      // A profile that waits on a terminal must not wait on this process.
      env: { TERM: 'dumb', HARNESSDESK_SHELL_PROBE: '1' },
    })
    return result.stdout
  }

/**
 * What was learned last time, and what it was learned from.
 *
 * Asking the shell costs whatever the person's profile costs, every launch.
 * The answer only changes when the shell or one of its profile files does,
 * so it is remembered against their modification times: an unchanged setup
 * pays nothing at all, and an edited `.zshrc` pays once.
 */
export interface PathCache {
  readonly shell: string
  readonly stamps: Readonly<Record<string, number>>
  readonly path: string
}

export interface ShellPathOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
  /** Runs the shell and returns what it printed; injectable for tests. */
  readonly run?: (shell: string, args: readonly string[]) => Promise<string>
  /** Where the answer is remembered between launches; no cache without it. */
  readonly stateDir?: string
  /** File stamps, for the cache's freshness check. Injectable for tests. */
  readonly stampOf?: (path: string) => number | null
  /** Reads and writes the cache. Injectable for tests. */
  readonly cache?: {
    read(): PathCache | null
    write(entry: PathCache): void
  }
  readonly exists?: (path: string) => boolean
  /** Lists a directory's entries, for version-manager trees like nvm's. */
  readonly list?: (path: string) => readonly string[]
  readonly timeoutMs?: number
}

const DELIMITER = '__HARNESSDESK_PATH__'

/**
 * What the shell is asked to print: its `PATH`, bracketed, and nothing else.
 *
 * This used to ask for the whole environment and read the first line that
 * began `PATH=`, which is ambiguous in a way that matters — an exported
 * bash function or a multi-line `LS_COLORS` can carry a line of its own
 * that starts that way, and whichever sorts first would win. Asking for the
 * one variable removes the class of problem rather than parsing around it.
 * Fish holds `PATH` as a list, so it is joined there explicitly; every
 * POSIX shell already holds it colon-joined.
 */
const script = (shell: string): string =>
  shell.endsWith('fish')
    ? `printf '%s%s%s' '${DELIMITER}' (string join : $PATH) '${DELIMITER}'`
    : `printf '%s%s%s' '${DELIMITER}' "$PATH" '${DELIMITER}'`

/**
 * The PATH between the delimiters, or null when the shell printed none.
 * Anything the profile said before or after — a greeting, a version notice,
 * a warning — falls outside the brackets and is discarded.
 */
export const pathFromProbe = (printed: string): string | null => {
  const start = printed.indexOf(DELIMITER)
  if (start === -1) return null
  const end = printed.indexOf(DELIMITER, start + DELIMITER.length)
  if (end === -1) return null
  return printed.slice(start + DELIMITER.length, end).trim() || null
}

/** How the shell is invoked: as a terminal window would, which is the point. */
const shellArgs = (shell: string): readonly string[] =>
  // `-l` reads the login profile, `-i` the interactive one; the two together
  // are what a terminal window runs, which is the environment being copied.
  shell.endsWith('fish')
    ? ['-l', '-i', '-c', script(shell)]
    : ['-ilc', script(shell)]

/** The shell to ask, or null when there is none to ask. */
const shellOf = (options: ShellPathOptions): string | null => {
  if ((options.platform ?? process.platform) === 'win32') return null
  const shell = (options.env ?? process.env)['SHELL']
  return shell && (options.exists ?? existsSync)(shell) ? shell : null
}

/**
 * The shell's PATH, or null when there is no shell to ask or it did not
 * answer in time. Only Unix shells are asked: on Windows the environment a
 * window gets is the one the person set.
 *
 * Asynchronous, and deliberately so. This runs an interactive login shell,
 * which sources the person's `.zshrc` — `nvm`, `conda init`, a plugin
 * manager, anything that touches the network — and doing that synchronously
 * blocked the Electron main process before its first window: the app bounced
 * in the Dock with nothing on screen for as long as the profile took. The
 * work is the same; what changed is that the process stays alive while it
 * happens, and nothing waits for it (see `applyLoginShellPath`).
 */
export const loginShellPath = async (options: ShellPathOptions = {}): Promise<string | null> => {
  const shell = shellOf(options)
  if (!shell) return null
  const run = options.run ?? runShell(options.timeoutMs ?? 5_000)
  try {
    return pathFromProbe(await run(shell, shellArgs(shell)))
  } catch {
    return null
  }
}

/**
 * Where installers put binaries, whether or not a profile names the place
 * yet. Each is included only when it exists, so the merged PATH never names
 * a folder that is not there. Version managers keep one folder per runtime
 * version; the newest few are added, newest first, which is the order the
 * manager itself would pick.
 */
export const wellKnownBinDirs = (options: ShellPathOptions = {}): readonly string[] => {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const exists = options.exists ?? existsSync
  const list = options.list ?? listDir
  if (platform === 'win32') {
    const appData = options.env?.['APPDATA'] ?? process.env['APPDATA']
    const local = options.env?.['LOCALAPPDATA'] ?? process.env['LOCALAPPDATA']
    return [
      ...(appData ? [join(appData, 'npm')] : []),
      ...(local ? [join(local, 'Programs', 'Python', 'Scripts')] : []),
      join(home, '.bun', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, '.local', 'bin'),
    ].filter(exists)
  }
  const fixed = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/home/linuxbrew/.linuxbrew/bin',
    join(home, '.linuxbrew', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.npm', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, 'go', 'bin'),
    '/usr/local/go/bin',
    join(home, '.pyenv', 'shims'),
    join(home, '.pixi', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.cursor', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.kimi', 'bin'),
    join(home, '.hermes', 'bin'),
    join(home, '.antigravity', 'antigravity', 'bin'),
    join(home, '.antigravity-ide', 'antigravity-ide', 'bin'),
  ]
  const managed = [
    ...versionedBins(join(home, '.nvm', 'versions', 'node'), list, exists),
    ...versionedBins(join(home, '.local', 'share', 'fnm', 'node-versions'), list, exists, 'installation'),
    ...versionedBins(join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), list, exists, 'installation'),
    ...versionedBins(join(home, '.asdf', 'installs', 'nodejs'), list, exists),
  ]
  return [...fixed.filter(exists), ...managed]
}

const listDir = (path: string): readonly string[] => {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** `<root>/<version>[/<between>]/bin` for the newest three versions present. */
const versionedBins = (
  root: string,
  list: (path: string) => readonly string[],
  exists: (path: string) => boolean,
  between?: string,
): readonly string[] =>
  [...list(root)]
    .filter((entry) => /^v?\d+\.\d+/.test(entry))
    .sort(compareVersionNames)
    .reverse()
    .slice(0, 3)
    .map((entry) => (between ? join(root, entry, between, 'bin') : join(root, entry, 'bin')))
    .filter(exists)

const compareVersionNames = (a: string, b: string): number => {
  const parse = (name: string) =>
    name
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * One PATH out of several, first occurrence wins, empties dropped. The
 * person's `HARNESSDESK_PATH` goes first, then the shell's answer, then what
 * the process had, then the well-known directories.
 */
export const mergePaths = (
  ...sources: readonly (string | readonly string[] | null | undefined)[]
): string => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const source of sources) {
    if (!source) continue
    const entries = typeof source === 'string' ? source.split(delimiter) : source
    for (const raw of entries) {
      const entry = raw.trim()
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      out.push(entry)
    }
  }
  return out.join(delimiter)
}

export interface ResolvedPath {
  readonly path: string
  /** The shell that answered, for the log; null when none did. */
  readonly shell: string | null
  /** Directories the merge added beyond what the process already had. */
  readonly added: readonly string[]
}

/** The files a shell reads on the way to a login prompt, when they exist. */
export const profileFiles = (shell: string, home: string): readonly string[] => {
  const name = shell.slice(shell.lastIndexOf('/') + 1)
  const own =
    name === 'fish'
      ? [join(home, '.config', 'fish', 'config.fish')]
      : name === 'bash'
        ? [join(home, '.bashrc'), join(home, '.bash_profile'), join(home, '.profile'), '/etc/profile']
        : name === 'zsh'
          ? [
              join(home, '.zshenv'),
              join(home, '.zprofile'),
              join(home, '.zshrc'),
              join(home, '.zlogin'),
              '/etc/zshenv',
              '/etc/zprofile',
              '/etc/zshrc',
            ]
          : [join(home, `.${name}rc`), join(home, '.profile')]
  // macOS builds PATH from these before any profile runs, so a new entry
  // here is a new PATH even when nothing in the home directory moved.
  return [shell, ...own, '/etc/paths', '/etc/paths.d']
}

const stampOnDisk = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** The stamps of every profile file that exists, for the cache's key. */
const stampsFor = (shell: string, options: ShellPathOptions): Record<string, number> => {
  const stamp = options.stampOf ?? stampOnDisk
  const home = options.home ?? homedir()
  const out: Record<string, number> = {}
  for (const file of profileFiles(shell, home)) {
    const at = stamp(file)
    if (at !== null) out[file] = at
  }
  return out
}

const sameStamps = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean => {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

const diskCache = (stateDir: string): NonNullable<ShellPathOptions['cache']> => {
  const file = join(stateDir, 'path-cache.json')
  return {
    read: () => {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PathCache>
        if (typeof parsed.shell !== 'string' || typeof parsed.path !== 'string') return null
        return { shell: parsed.shell, path: parsed.path, stamps: parsed.stamps ?? {} }
      } catch {
        return null
      }
    },
    write: (entry) => {
      try {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, `${JSON.stringify(entry)}\n`, 'utf8')
        renameSync(tmp, file)
      } catch {
        // A cache that cannot be written costs a probe next time, nothing more.
      }
    },
  }
}

/** The PATH this process should be using, given a shell answer or none. */
export const resolvePath = (
  shellPath: string | null,
  options: ShellPathOptions = {},
): ResolvedPath => {
  const env = options.env ?? process.env
  const current = env['PATH'] ?? ''
  const path = mergePaths(env['HARNESSDESK_PATH'], shellPath, current, wellKnownBinDirs(options))
  const had = new Set(current.split(delimiter).filter((entry) => entry.length > 0))
  return {
    path,
    shell: shellPath !== null ? (env['SHELL'] ?? null) : null,
    added: path.split(delimiter).filter((entry) => !had.has(entry)),
  }
}

export interface AppliedPath {
  /** What `process.env.PATH` is right now — the cache, or the machine alone. */
  readonly applied: ResolvedPath
  /**
   * The same, once the shell has answered. Resolves immediately when the
   * cache was fresh. Nothing has to await it: what it adds is the person's
   * own PATH order and any directory the well-known list does not know, and
   * a runtime started before it lands is re-checked on the next tick.
   */
  readonly settled: Promise<ResolvedPath>
}

/**
 * Makes the resolved PATH this process's own.
 *
 * Every `which`, every spawned agent and every account command inherits
 * `process.env`, so this one assignment is what lets the desk see what the
 * terminal sees. It happens in two steps, because the honest source is slow
 * and the app must not wait on it:
 *
 * 1. **Now, without a subprocess.** The remembered answer when the shell and
 *    its profile files are untouched since it was learned; otherwise the
 *    process's own PATH plus the well-known install directories, which is
 *    where Homebrew, npm, `~/.local/bin`, nvm, bun and cargo put things —
 *    nearly every agent CLI is findable from that alone.
 * 2. **Shortly, from the shell.** The probe runs in the background and its
 *    answer is merged in front when it lands, then remembered for next time.
 *
 * The first step is what the interface starts on, and it is never worse than
 * what the process had. The second is what makes an unusual PATH work.
 */
export const applyLoginShellPath = (
  options: ShellPathOptions & { readonly log?: (message: string, details?: unknown) => void } = {},
): AppliedPath => {
  const cache = options.cache ?? (options.stateDir ? diskCache(options.stateDir) : null)
  const shell = shellOf(options)
  const stamps = shell ? stampsFor(shell, options) : {}
  const remembered = cache?.read() ?? null
  const fresh =
    remembered !== null && shell !== null && remembered.shell === shell && sameStamps(remembered.stamps, stamps)

  const put = (resolved: ResolvedPath): ResolvedPath => {
    if (resolved.path !== (process.env['PATH'] ?? '')) process.env['PATH'] = resolved.path
    return resolved
  }

  const applied = put(resolvePath(fresh ? remembered.path : null, options))
  options.log?.('PATH resolved for the desk', {
    shell: shell ?? null,
    from: fresh ? 'cache' : 'this process and the known install folders',
    added: applied.added,
  })
  if (fresh || !shell) return { applied, settled: Promise.resolve(applied) }

  const settled = loginShellPath(options).then((answer) => {
    if (answer === null) return applied
    const next = put(resolvePath(answer, options))
    cache?.write({ shell, stamps, path: answer })
    options.log?.('PATH refined by the login shell', { shell, added: next.added })
    return next
  })
  // A probe that throws must not become an unhandled rejection in a process
  // that was told it need not wait.
  return { applied, settled: settled.catch(() => applied) }
}
