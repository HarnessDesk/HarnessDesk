import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { CodexError } from './errors.js'

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

const probe = async (path: string): Promise<CodexInstallation | null> => {
  try {
    const { stdout } = await run(path, ['--version'], { timeout: 10_000 })
    const semver = parseVersion(stdout)
    if (!semver) return null
    return { path, version: stdout.trim(), semver }
  } catch {
    return null
  }
}

const fromPathLookup = async (): Promise<string | null> => {
  try {
    const { stdout } = await run('/usr/bin/which', ['codex'], { timeout: 5_000 })
    const found = stdout.trim().split('\n')[0]
    return found && found.length > 0 ? found : null
  } catch {
    return null
  }
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
 * still wins between equals. Returns `null` when nothing usable is present so
 * callers can render first-run guidance instead of crashing.
 */
export const discoverCodex = async (override?: string | null): Promise<CodexInstallation | null> => {
  if (override) {
    try {
      await access(override, constants.X_OK)
    } catch {
      throw new CodexError('notInstalled', `Configured Codex path is not executable: ${override}`)
    }
    const probed = await probe(override)
    if (!probed) {
      throw new CodexError('notInstalled', `Could not read a version from ${override}`)
    }
    return probed
  }

  const onPath = await fromPathLookup()
  const candidates = [...(onPath ? [onPath] : []), ...CANDIDATE_PATHS()]
  return newestOf(await Promise.all(candidates.map(probe)))
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

/** Throws with actionable text when the installation is missing or too old. */
export const requireCodex = async (override?: string | null): Promise<CodexInstallation> => {
  const found = await discoverCodex(override)
  if (!found) {
    throw new CodexError(
      'notInstalled',
      'Codex is not installed. Install it with `brew install codex` or `npm i -g @openai/codex`.',
    )
  }
  if (compareVersions(found.semver, MINIMUM_CODEX_VERSION) < 0) {
    throw new CodexError(
      'versionTooOld',
      `Codex ${found.version} is older than the minimum supported ${MINIMUM_CODEX_VERSION.join('.')}. Upgrade with \`brew upgrade codex\` or \`npm i -g @openai/codex@latest\`.`,
    )
  }
  return found
}
