import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { CodexError } from './errors.js'
import { whichOnPath } from './which.js'

const run = promisify(execFile)

/**
 * Finding the user's Codex installation.
 *
 * HarnessDesk never bundles or ships Codex — it drives whatever the user already
 * has, so their `~/.codex` config, auth, MCP servers, and skills all apply
 * unchanged. That is also why discovery has to handle the several places the
 * three supported installation methods put the binary.
 */

export interface CodexInstallation {
  readonly path: string
  readonly version: string
  /** Parsed `version`, for comparisons that should not be string-wise. */
  readonly semver: readonly [number, number, number]
}

/**
 * The oldest app-server we will talk to. 0.145.0 is the first release where
 * `thread/items/list` pages turn-tagged entries: 0.142 and earlier still named
 * the method `thread/turns/items/list`, and 0.143/0.144 returned bare items.
 * The vendored protocol is generated from one release, so below this floor we
 * refuse rather than fail mysteriously mid-session.
 */
export const MINIMUM_CODEX_VERSION: readonly [number, number, number] = [0, 145, 0]

/**
 * Everything discovery reads from the machine, so a test can hand it a small one.
 * Production passes nothing and gets this process's own PATH and the real
 * install locations.
 */
export interface DiscoveryOptions {
  /** Where PATH is read from, and what a probe runs with. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** The well-known install locations. Default `CANDIDATE_PATHS`. */
  readonly locations?: readonly string[]
  /** Waits between attempts when a copy is there and will not answer. Default `RETRY_DELAYS_MS`. */
  readonly retryDelaysMs?: readonly number[]
  /** Ends the waiting between attempts: the app is quitting. */
  readonly signal?: AbortSignal
}

/**
 * How long a copy that is there gets to start answering, in waits between
 * attempts. The longest single wait outlasts the login shell's own deadline
 * (5 s): the app asks for its PATH in the background and opens before it
 * lands, so a Codex that needs a folder only that PATH names is unreadable for
 * the first moments and fine after. Together they stay under the 15 s the host
 * waits on any one runtime before it carries on without it.
 */
export const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 3_000, 5_000]

/** The whole of the waiting is bounded, however long each attempt takes. */
const RETRY_BUDGET_MS = 15_000

/** How long one copy gets to print its version. */
const PROBE_TIMEOUT_MS = 10_000

const CANDIDATE_PATHS = (): string[] => {
  const home = homedir()
  return [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(home, '.local/bin/codex'),
    join(home, '.npm-global/bin/codex'),
    join(home, '.bun/bin/codex'),
    '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
  ]
}

export const parseVersion = (raw: string): readonly [number, number, number] | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export const compareVersions = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])

/** A copy that is on disk and would not say what version it is. */
export interface UnreadableCopy {
  readonly path: string
  /** What happened when it was run, as a clause that follows "it": `exited with code 127: …`. */
  readonly reason: string
}

/** What discovery found: the newest copy that answered, and every copy that is there and did not. */
export interface Located {
  readonly installation: CodexInstallation | null
  readonly unreadable: readonly UnreadableCopy[]
}

const firstLine = (text: unknown): string =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 160) ?? ''

/**
 * Why running a copy failed, in the words the person would need to fix it.
 *
 * A Node-script Codex has more ways to fail than a binary has: the `node` it
 * names may not be on the PATH it is run with (the shell's own exit 127), it
 * may be slow on a machine that has just started, a process limit may refuse
 * the spawn. Each reads differently and none of them is "not installed".
 */
const describeFailure = (error: unknown): string => {
  const failed = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown }
  const said = firstLine(failed.stderr)
  if (failed.killed === true) return `did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds`
  if (typeof failed.signal === 'string' && failed.signal.length > 0) return `was ended by ${failed.signal}`
  if (typeof failed.code === 'number') return `exited with code ${failed.code}${said ? `: ${said}` : ''}`
  if (typeof failed.code === 'string') return `could not be started (${failed.code})`
  return `could not be run (${error instanceof Error ? error.message : String(error)})`
}

const isInstallation = (probed: CodexInstallation | UnreadableCopy): probed is CodexInstallation => 'semver' in probed

const probe = async (path: string, env?: NodeJS.ProcessEnv): Promise<CodexInstallation | UnreadableCopy> => {
  try {
    const { stdout } = await run(path, ['--version'], { timeout: PROBE_TIMEOUT_MS, ...(env ? { env } : {}) })
    const semver = parseVersion(stdout)
    if (!semver) return { path, reason: `printed no version number${firstLine(stdout) ? ` ("${firstLine(stdout)}")` : ''}` }
    return { path, version: stdout.trim(), semver }
  } catch (error) {
    return { path, reason: describeFailure(error) }
  }
}

// A PATH walk. `/usr/bin/which` is absent on Windows and on minimal images, and there Codex read as not installed (#129).
const fromPathLookup = async (env?: NodeJS.ProcessEnv): Promise<string | null> =>
  whichOnPath('codex', env ? { env } : {})

/**
 * The files to ask, each once: those a person could run, with a symlink and
 * its target counted as one so a Codex reached three ways is not started three
 * times. Order is kept, so `PATH` still wins between equals.
 */
const copiesOf = (paths: readonly (string | null)[], env?: NodeJS.ProcessEnv): string[] => {
  const seen = new Set<string>()
  const copies: string[] = []
  for (const path of paths) {
    if (path === null || whichOnPath(path, env ? { env } : {}) === null) continue
    const real = realpathOrSelf(path)
    if (seen.has(real)) continue
    seen.add(real)
    copies.push(path)
  }
  return copies
}

/**
 * Locates Codex: an explicit override if given, otherwise the **newest** of
 * everything found on `PATH` and in the well-known install locations.
 *
 * Newest rather than first, because the model list is whatever the chosen
 * binary can read from its vendor, and an older Codex reads less of it — a
 * 0.135.0 cannot decode the catalogue that names GPT-5.6's reasoning levels
 * and falls back to its compiled-in presets. Two installs side by side (a
 * Homebrew one and an npm one, say) are common enough that "the one on PATH"
 * was regularly the stale one. Ties keep the earlier candidate, so `PATH`
 * still wins between equals.
 *
 * Says what it saw rather than what it concluded: a copy that is on disk and
 * would not answer is `unreadable`, not absent. Whether that is a Codex that
 * is not installed is for the caller, and `requireCodex` says it is not.
 */
export const locateCodex = async (
  override?: string | null,
  options: DiscoveryOptions = {},
): Promise<Located> => {
  if (override) {
    try {
      await access(override, constants.X_OK)
    } catch {
      throw new CodexError('notInstalled', `Configured Codex path is not executable: ${override}`)
    }
    const probed = await probe(override, options.env)
    return isInstallation(probed) ? { installation: probed, unreadable: [] } : { installation: null, unreadable: [probed] }
  }

  const onPath = await fromPathLookup(options.env)
  const copies = copiesOf([onPath, ...(options.locations ?? CANDIDATE_PATHS())], options.env)
  const probed = await Promise.all(copies.map((path) => probe(path, options.env)))
  return {
    installation: newestOf(probed.filter(isInstallation)),
    unreadable: probed.filter((one): one is UnreadableCopy => !isInstallation(one)),
  }
}

/**
 * The newest Codex that answers, or `null` when none does. A configured path
 * that is there and would not answer throws, as one that is not there does.
 */
export const discoverCodex = async (
  override?: string | null,
  options: DiscoveryOptions = {},
): Promise<CodexInstallation | null> => {
  const { installation, unreadable } = await locateCodex(override, options)
  if (!installation && override && unreadable.length > 0) throw unreadableError(unreadable)
  return installation
}

/**
 * The highest-versioned of the probed installations, deduplicated by real
 * path so a symlink and its target are one candidate, not two. First wins
 * among equals.
 */
export const newestOf = (
  probed: readonly (CodexInstallation | null)[],
): CodexInstallation | null => {
  const seen = new Set<string>()
  let best: CodexInstallation | null = null
  for (const found of probed) {
    if (!found) continue
    const key = realpathOrSelf(found.path)
    if (seen.has(key)) continue
    seen.add(key)
    if (!best || compareVersions(found.semver, best.semver) > 0) best = found
  }
  return best
}

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const unreadableError = (unreadable: readonly UnreadableCopy[]): CodexError => {
  const [first, ...others] = unreadable
  const more = others.length > 0 ? ` (${others.length} more ${others.length === 1 ? 'copy is' : 'copies are'} the same)` : ''
  return new CodexError(
    'spawnFailed',
    `Codex was found at ${first?.path ?? 'this machine'} but would not report its version: it ${first?.reason ?? 'did not answer'}${more}.`,
    unreadable,
  )
}

const stoppedWhileStarting = (): CodexError =>
  new CodexError('notRunning', 'The app-server was stopped while it was starting.')

/**
 * Waits `ms`, unless the app quits first. A quit is `notRunning`, the same
 * refusal a start gets when it is overtaken anywhere else.
 */
const pause = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) throw stoppedWhileStarting()
  try {
    await delay(ms, undefined, signal ? { signal } : {})
  } catch {
    throw stoppedWhileStarting()
  }
}

/**
 * Throws with actionable text when the installation is missing, will not
 * answer, or is too old.
 *
 * **Missing and not answering are different, and only one of them is final.**
 * No copy anywhere on the machine is `notInstalled`, said at once. A copy that
 * is there and does not print its version is a machine in some state — a PATH
 * that has not been completed yet, a spawn refused under load — and that state
 * passes. So it is asked again, a few times, over the seconds in which it
 * usually does; and if it still will not answer the error says which copy and
 * what it did (`spawnFailed`), because "not installed" about a Codex that
 * `ls` can see sends the person to install what they already installed, and
 * the verdict is not looked at again until the app restarts.
 */
export const requireCodex = async (
  override?: string | null,
  options: DiscoveryOptions = {},
): Promise<CodexInstallation> => {
  const waits = options.retryDelaysMs ?? RETRY_DELAYS_MS
  const began = Date.now()
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) throw stoppedWhileStarting()
    const { installation: found, unreadable } = await locateCodex(override, options)
    if (found) return checked(found)
    const wait = waits[attempt]
    if (unreadable.length === 0) {
      throw new CodexError(
        'notInstalled',
        'Codex is not installed. Install it with `brew install codex` or `npm i -g @openai/codex`.',
      )
    }
    if (wait === undefined || Date.now() - began + wait > RETRY_BUDGET_MS) throw unreadableError(unreadable)
    await pause(wait, options.signal)
  }
}

const checked = (found: CodexInstallation): CodexInstallation => {
  if (compareVersions(found.semver, MINIMUM_CODEX_VERSION) < 0) {
    throw new CodexError(
      'versionTooOld',
      `Codex ${found.version} is older than the minimum supported ${MINIMUM_CODEX_VERSION.join('.')}. Upgrade with \`brew upgrade codex\` or \`npm i -g @openai/codex@latest\`.`,
    )
  }
  return found
}
