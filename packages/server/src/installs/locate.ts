import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, sep } from 'node:path'

import { versionIn } from '@harnessdesk/adapter-acp'

import { parseSemver } from '../updates.js'
import { readChannel, updateCommandFor, type InstallChannel, type UpdateKnowledge } from './channels.js'
import { runForOutput } from './run.js'

/**
 * Every copy of one agent on this machine, and which of them should answer.
 *
 * Codex learned this the expensive way: two installs side by side, and the
 * one on PATH was the stale one — a 0.135 that could not read its vendor's
 * catalogue while a 0.149 sat one folder over. `discoverCodex` has run the
 * newest copy ever since. This is that rule for every agent: look everywhere
 * a copy could be, ask each what version it is, and run the newest that is
 * new enough — unless the person pinned one, in which case run that and say
 * so. Nothing is picked by which folder happens to come first.
 *
 * A copy is found, never trusted: each candidate is asked for its version
 * with a timeout, and one that does not answer is listed as unreadable and
 * never chosen. Symlinks are followed before two paths count as two copies,
 * so a bin link and its target are one.
 */

export interface InstallSpec {
  /** Names the CLI answers to on PATH; the first is canonical. */
  readonly commands: readonly string[]
  /** Places to look beyond PATH; `~` is the home. */
  readonly paths?: readonly string[]
  readonly versionArgs?: readonly string[]
  /** The oldest version that can do the job; older copies are listed but not chosen. */
  readonly minVersion?: string
  /** What the vendor publishes, so an update can be phrased. */
  readonly publish?: UpdateKnowledge
}

export interface FoundInstall {
  /** The path as it was found — a bin link, usually. */
  readonly path: string
  /** The file that actually runs. */
  readonly realPath: string
  readonly version: string | null
  readonly channel: InstallChannel
  readonly packageName: string | null
  /** True when this copy lives in the desk's own download folder. */
  readonly managed: boolean
  /** True when a plain `which` would have found it. */
  readonly onPath: boolean
  /** What to run to update this copy, when its road has a verb; null for the desk's own. */
  readonly updateCommand: string | null
}

export type CopyStanding = 'chosen' | 'pinned' | 'older' | 'too-old' | 'unreadable'

export interface JudgedInstall extends FoundInstall {
  readonly standing: CopyStanding
}

export interface LocateOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly home?: string
  /** The desk's download folder; copies inside it are `managed`. */
  readonly managedDir?: string
  readonly platform?: NodeJS.Platform
  readonly exists?: (path: string) => boolean
  readonly realpath?: (path: string) => string
  /** Runs a candidate for its version line; injectable for tests. */
  readonly probe?: (path: string, args: readonly string[]) => Promise<string | null>
  /** Extra places to look — the row's own stored command, say. */
  readonly also?: readonly string[]
  readonly timeoutMs?: number
}

const printedVersion = (timeoutMs: number) => async (path: string, args: readonly string[]) => {
  const result = await runForOutput(path, args, { timeoutMs, maxBytes: 64 * 1024 })
  if (result.timedOut) return null
  const line = `${result.stdout}\n${result.stderr}`.split('\n').find((one) => /\d+\.\d+/.test(one))
  return line?.trim() ?? null
}

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** One spelling for a directory: no trailing separator, and never empty. */
const normalizeDir = (dir: string): string =>
  dir.length > 1 && dir.endsWith(sep) ? dir.slice(0, -1) : dir

/** `~/x` → `/home/me/x`; anything else unchanged. */
export const expandHome = (path: string, home: string): string =>
  path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path

const executableNames = (command: string, platform: NodeJS.Platform): readonly string[] =>
  platform === 'win32' ? [`${command}.exe`, `${command}.cmd`, command] : [command]

/**
 * Where to look, in the order that breaks ties: PATH in the person's own
 * order, then the well-known places, then whatever the caller adds. The
 * order matters only between copies of equal version.
 */
export const candidatePaths = (spec: InstallSpec, options: LocateOptions = {}): readonly string[] => {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const dirs = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir.length > 0)
  const out: string[] = []
  const seen = new Set<string>()
  const add = (path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    out.push(path)
  }
  for (const dir of dirs) {
    for (const command of spec.commands) {
      for (const name of executableNames(command, platform)) add(join(dir, name))
    }
  }
  for (const path of spec.paths ?? []) add(expandHome(path, home))
  for (const path of options.also ?? []) if (isAbsolute(path)) add(path)
  return out
}

/**
 * The version a copy reports — or, for a download the desk made whose
 * `--version` prints no release number (Antigravity's prints a build
 * sentence), the version folder it was unpacked into, which the registry
 * named. A printed line with no triple is otherwise kept whole, capped so a
 * paragraph cannot pose as a version.
 */
const versionOf = (printed: string | null, managedPath: string | null, managedDir: string | undefined): string | null => {
  const read = versionIn(printed)
  if (read && /\d+\.\d+\.\d+/.test(read)) return read
  if (managedPath && managedDir) {
    const inside = managedPath.slice(managedDir.length + 1).split(sep)
    const folder = inside[1]
    if (folder && /\d+\.\d+/.test(folder)) return folder
  }
  return read ? read.slice(0, 40) : null
}

/** Version triples compare; anything unparseable sorts last. Newest first. */
export const compareVersionsDesc = (a: string | null, b: string | null): number => {
  const x = a ? parseSemver(a) : null
  const y = b ? parseSemver(b) : null
  if (!x && !y) return 0
  if (!x) return 1
  if (!y) return -1
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
}

export const meetsFloor = (version: string | null, floor: string | undefined): boolean => {
  if (!floor) return true
  const have = version ? parseSemver(version) : null
  const need = parseSemver(floor)
  if (!have || !need) return false
  return (have[0] - need[0] || have[1] - need[1] || have[2] - need[2]) >= 0
}

/**
 * Every copy found, newest first — probed in parallel, deduplicated by real
 * path, each one read for the road it came by.
 */
export const findInstalls = async (
  spec: InstallSpec,
  options: LocateOptions = {},
): Promise<readonly FoundInstall[]> => {
  const exists = options.exists ?? existsSync
  const realpath = options.realpath ?? realpathOrSelf
  const probe = options.probe ?? printedVersion(options.timeoutMs ?? 10_000)
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  // Normalised on both sides: a PATH entry written with a trailing slash is
  // the same directory as the one `join` produced, and comparing the raw
  // strings reported a copy that was plainly on PATH as not being on it.
  const pathDirs = new Set(
    (env['PATH'] ?? '')
      .split(delimiter)
      .filter((dir) => dir.length > 0)
      .map(normalizeDir),
  )
  const candidates = candidatePaths(spec, options).filter(exists)
  const byReal = new Map<string, string>()
  for (const path of candidates) {
    const real = realpath(path)
    if (!byReal.has(real)) byReal.set(real, path)
  }
  const found = await Promise.all(
    [...byReal.entries()].map(async ([realPath, path]): Promise<FoundInstall> => {
      const printed = await probe(path, spec.versionArgs ?? ['--version'])
      const reading = readChannel(path, {
        home,
        ...(options.managedDir ? { managedDir: options.managedDir } : {}),
        ...(options.platform ? { platform: options.platform } : {}),
        realpath: () => realPath,
      })
      return {
        path,
        realPath,
        version: versionOf(printed, reading.channel === 'harnessdesk' ? path : null, options.managedDir),
        channel: reading.channel,
        packageName: reading.packageName,
        managed: reading.channel === 'harnessdesk',
        onPath: pathDirs.has(normalizeDir(path.slice(0, path.lastIndexOf(sep)))),
        updateCommand: updateCommandFor(reading, spec.publish ?? {}),
      }
    }),
  )
  // Stable: equal versions keep candidate order, so PATH wins between equals.
  return found
    .map((copy, index) => ({ copy, index }))
    .sort((a, b) => compareVersionsDesc(a.copy.version, b.copy.version) || a.index - b.index)
    .map(({ copy }) => copy)
}

/**
 * Which copy answers. A pinned path wins when it is among the copies and
 * readable; otherwise the newest readable copy that meets the floor. Every
 * copy comes back with its standing, so the interface can say why each one
 * is or is not the one running.
 */
export const judgeInstalls = (
  found: readonly FoundInstall[],
  options: { readonly minVersion?: string; readonly pinnedPath?: string | null } = {},
): { readonly chosen: JudgedInstall | null; readonly copies: readonly JudgedInstall[] } => {
  const pinned = options.pinnedPath
    ? found.find((copy) => copy.path === options.pinnedPath || copy.realPath === options.pinnedPath)
    : undefined
  const usable = (copy: FoundInstall) => copy.version !== null && meetsFloor(copy.version, options.minVersion)
  const chosenCopy = pinned && usable(pinned) ? pinned : (found.find(usable) ?? null)
  const copies = found.map((copy): JudgedInstall => {
    if (chosenCopy && copy.realPath === chosenCopy.realPath) {
      return { ...copy, standing: pinned && copy.realPath === pinned.realPath ? 'pinned' : 'chosen' }
    }
    if (copy.version === null) return { ...copy, standing: 'unreadable' }
    if (!meetsFloor(copy.version, options.minVersion)) return { ...copy, standing: 'too-old' }
    return { ...copy, standing: 'older' }
  })
  return { chosen: copies.find((copy) => copy.standing === 'chosen' || copy.standing === 'pinned') ?? null, copies }
}
