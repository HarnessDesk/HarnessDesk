import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

/**
 * How a binary got onto this machine, read off where it sits.
 *
 * The same agent arrives by several roads — `brew install`, `npm i -g`, a
 * `curl | sh` installer, `uv tool install`, a download this desk made, the
 * copy inside a vendor's own app — and the road decides two things the
 * interface has to say truthfully: what to run to update it, and whether
 * this desk is allowed to. A copy the person installed is theirs: the desk
 * names the command and never runs it behind their back. A copy the desk
 * downloaded is the desk's to replace. Nothing here is a guess about the
 * agent; it is a reading of the path, symlinks followed, against the places
 * each package manager is known to keep its files.
 */
export type InstallChannel =
  | 'harnessdesk'
  | 'homebrew'
  | 'npm-global'
  | 'bun'
  | 'uv-tool'
  | 'pipx'
  | 'cargo'
  | 'app-bundle'
  | 'installer'
  | 'path'

export interface ChannelReading {
  readonly channel: InstallChannel
  /** The path with symlinks resolved — the file that actually runs. */
  readonly realPath: string
  /**
   * What the manager on that road calls the thing, when the path says: a
   * Homebrew formula, an npm package, a uv tool. Null for roads that do not
   * name their packages on disk.
   */
  readonly packageName: string | null
  /**
   * True for a Homebrew *cask* — a Caskroom path rather than a Cellar one.
   * Formulae and casks are two namespaces, and the same token can name
   * different programs in each: `copilot-cli` is the cask for GitHub's CLI,
   * while the `copilot` formula is AWS's deprecated ECS tool. `brew upgrade`
   * is told which was meant with `--cask`, so this is read off the path
   * rather than guessed from the name.
   */
  readonly cask?: boolean
}

export interface ChannelOptions {
  readonly home?: string
  /** The desk's own download folder — `<state>/acp-agents`. */
  readonly managedDir?: string
  readonly realpath?: (path: string) => string
  readonly platform?: NodeJS.Platform
}

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** `…/node_modules/@scope/name/…` → `@scope/name`; `…/node_modules/name/…` → `name`. */
const npmPackageIn = (path: string): string | null => {
  const marker = `${sep}node_modules${sep}`
  const at = path.lastIndexOf(marker)
  if (at === -1) return null
  const parts = path.slice(at + marker.length).split(sep)
  const first = parts[0]
  /* A `.bin` folder holds a package manager's launchers, not a package. pnpm's
     are shell scripts, not links, so `realpath` leaves the path inside it, and
     `.bin` was read as the package's name: `npm install -g .bin` (#69). No
     package can be read off such a path. */
  if (!first || first === '.bin') return null
  return first.startsWith('@') && parts[1] ? `${first}/${parts[1]}` : first
}

/** The vendors' own `curl | sh` folders, and the installers' link farms. */
export const installerDirs = (home: string): readonly string[] => [
  join(home, '.local', 'bin'),
  join(home, '.opencode', 'bin'),
  join(home, '.cursor', 'bin'),
  join(home, '.claude', 'local'),
  join(home, '.kimi', 'bin'),
  join(home, '.kimi-code'),
  join(home, '.hermes'),
  join(home, '.grok', 'bin'),
  join(home, '.local', 'share'),
]

/**
 * Which road, from the path. The order is the order of certainty: the
 * desk's own folder is unambiguous; a package manager's tree names itself;
 * an app bundle is a `.app`; the installer folders are conventions the
 * vendors chose; and `path` is everything else — a binary the person put
 * somewhere by hand, which is a perfectly good install the desk simply
 * cannot update.
 */
export const readChannel = (path: string, options: ChannelOptions = {}): ChannelReading => {
  const home = options.home ?? homedir()
  const realPath = (options.realpath ?? realpathOrSelf)(path)
  const platform = options.platform ?? process.platform
  /* Both sides normalised, not compared as they were written: `/opt/hd//agents`,
     `/opt/hd/agents/` and `/opt/hd/./agents` all name the directory `resolve`
     spells `/opt/hd/agents`, and a bare `startsWith` said the first and third
     were somewhere else entirely. A managed install under a directory spelled
     any of those ways then read as an ordinary `path` entry with no package
     name, so the update command that would keep it current was never offered,
     and nothing said why (#117).

     Lexical normalisation only — no `realpath` here, deliberately. Symlinks are
     already answered one level up by `either`, which asks this question of the
     real path *and* of the path as given, and `readChannel` takes its `realpath`
     as an injection precisely so that reading a channel stays a pure function of
     the path. The security-grade question, where following links is the whole
     point, is `pathWithin`'s (#110) and is a different question. */
  const under = (candidate: string, dir: string): boolean => {
    const base = resolve(dir)
    const at = resolve(candidate)
    return at === base || at.startsWith(base.endsWith(sep) ? base : base + sep)
  }
  const either = (dir: string): boolean => under(realPath, dir) || under(path, dir)

  if (options.managedDir && either(options.managedDir)) {
    /* `relative`, not `.slice(managedDir.length + 1)`: a managed directory
       configured with a trailing separator made the arithmetic take the first
       character of the package name with it. */
    const chosen = under(realPath, options.managedDir) ? realPath : path
    const inside = relative(options.managedDir, chosen)
    return { channel: 'harnessdesk', realPath, packageName: inside.split(sep)[0] || null }
  }

  // Homebrew keeps the real file in a Cellar, or in a Caskroom when what was
  // installed is a cask; the bin entry is a link into whichever.
  const brewed = /[\\/](Cellar|Caskroom)[\\/]([^\\/]+)[\\/]/.exec(realPath)
  if (brewed) {
    return {
      channel: 'homebrew',
      realPath,
      packageName: brewed[2] ?? null,
      ...(brewed[1] === 'Caskroom' ? { cask: true } : {}),
    }
  }

  if (either(join(home, '.bun', 'install', 'global')) || either(join(home, '.bun', 'bin'))) {
    return { channel: 'bun', realPath, packageName: npmPackageIn(realPath) }
  }
  const npmTree =
    /[\\/]lib[\\/]node_modules[\\/]/.test(realPath) ||
    /[\\/]\.nvm[\\/]|[\\/]fnm[\\/]|[\\/]\.volta[\\/]|[\\/]\.asdf[\\/]installs[\\/]nodejs[\\/]/.test(realPath) ||
    either(join(home, '.npm-global'))
  if (npmTree) return { channel: 'npm-global', realPath, packageName: npmPackageIn(realPath) }

  const uv = /[\\/]uv[\\/]tools[\\/]([^\\/]+)[\\/]/.exec(realPath)
  if (uv) return { channel: 'uv-tool', realPath, packageName: uv[1] ?? null }
  const pipx = /[\\/]pipx[\\/]venvs[\\/]([^\\/]+)[\\/]/.exec(realPath)
  if (pipx) return { channel: 'pipx', realPath, packageName: pipx[1] ?? null }
  if (either(join(home, '.cargo', 'bin'))) return { channel: 'cargo', realPath, packageName: null }

  if (platform === 'darwin') {
    const app = /([^\\/]+)\.app[\\/]Contents[\\/]/.exec(realPath)
    if (app) return { channel: 'app-bundle', realPath, packageName: app[1] ?? null }
  }

  if (installerDirs(home).some(either)) return { channel: 'installer', realPath, packageName: null }
  return { channel: 'path', realPath, packageName: null }
}

/** The channel as the interface names it, completing "installed via …". */
export const channelLabel = (channel: InstallChannel): string => {
  switch (channel) {
    case 'harnessdesk':
      return 'HarnessDesk'
    case 'homebrew':
      return 'Homebrew'
    case 'npm-global':
      return 'npm'
    case 'bun':
      return 'bun'
    case 'uv-tool':
      return 'uv'
    case 'pipx':
      return 'pipx'
    case 'cargo':
      return 'cargo'
    case 'app-bundle':
      return 'an app bundle'
    case 'installer':
      return "the vendor's installer"
    case 'path':
      return 'PATH'
  }
}

/** What an agent's vendor publishes, so an update command can be phrased for the road taken. */
export interface UpdateKnowledge {
  readonly npmPackage?: string | null
  readonly brewFormula?: string | null
  readonly pypiPackage?: string | null
  /** The agent's own update verb, when its vendor ships one — `opencode upgrade`. */
  readonly selfUpdate?: string | null
}

/**
 * What to run to bring a copy up to date, when the road has a verb for it.
 * The desk's own downloads are updated by the desk (null here: there is no
 * command to show, there is a button). The agent's own verb wins on the
 * installer road, where the package manager *is* the vendor's script, and
 * stands in on roads with no manager at all. A bare `path` copy with no
 * self-update has no road back to whoever put it there.
 */
export const updateCommandFor = (
  reading: Pick<ChannelReading, 'channel' | 'packageName' | 'cask'>,
  known: UpdateKnowledge = {},
): string | null => {
  switch (reading.channel) {
    case 'homebrew': {
      const formula = known.brewFormula ?? reading.packageName
      if (!formula) return null
      // `--cask` where the path said Caskroom, because the bare token is not
      // enough: a formula of the same name wins the argument, and for GitHub
      // Copilot that formula is a different vendor's program. See `cask`.
      return reading.cask ? `brew upgrade --cask ${formula}` : `brew upgrade ${formula}`
    }
    case 'npm-global': {
      const pkg = known.npmPackage ?? reading.packageName
      return pkg ? `npm install -g ${pkg}@latest` : null
    }
    case 'bun': {
      const pkg = known.npmPackage ?? reading.packageName
      return pkg ? `bun install -g ${pkg}@latest` : null
    }
    case 'uv-tool': {
      const pkg = known.pypiPackage ?? reading.packageName
      return pkg ? `uv tool upgrade ${pkg}` : null
    }
    case 'pipx': {
      const pkg = known.pypiPackage ?? reading.packageName
      return pkg ? `pipx upgrade ${pkg}` : null
    }
    case 'installer':
    case 'cargo':
    case 'app-bundle':
    case 'path':
      return known.selfUpdate ?? null
    case 'harnessdesk':
      return null
  }
}
