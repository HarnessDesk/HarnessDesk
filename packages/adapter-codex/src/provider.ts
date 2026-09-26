import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { rootOf } from './profiles.js'

/**
 * Which vendor's models a Codex session reaches, read from Codex's own
 * configuration the way Codex reads it: `config.toml` in its home, each
 * profile beside it (`<name>.config.toml`), a project's own
 * `.codex/config.toml`, and the environment it is started with.
 *
 * OpenAI's, unless the configuration actually *in force*, merged across
 * every layer above, could point it elsewhere: a `profile` selecting
 * something other than the built-in default (and every layer must agree on
 * which one, or the answer is unknown outright), a `model_provider` other
 * than `openai` reachable from any layer's own root or from the
 * `[profiles.<name>]` table the agreed `profile` selects in any layer, any
 * `base_url` set there or in the `[model_providers.<id>]` table that active
 * `model_provider` names in any layer, or `OPENAI_BASE_URL`. Defining
 * another profile or provider table that nothing selects is not an
 * override: a `config.toml` kept around for occasional use is not what a
 * session actually run on it reaches.
 *
 * The rule is: doubt answers unknown. A file that exists but cannot be read
 * rules nothing out. Read as text, deliberately cruder than a TOML parser —
 * but never *silently* cruder: a header this scanner cannot fully parse (a
 * trailing comment and whitespace around a dot are normalized; anything
 * else is not), a dotted key, an inline table, or any multi-line
 * (`"""`/`'''`) string anywhere in the file — which could hide a header or
 * a key a line-based scan cannot see into — each answer unknown rather than
 * being skipped or guessed at. That is what keeps a comment-in-a-header, a
 * `[[...]]` array of tables, `a.b = 1`, `x = { y = 1 }` and a multi-line
 * string that merely *looks* like it contains a table header from ever
 * reading as "no override."
 *
 * Every read is bounded and never holds the desk's thread: opened without
 * blocking, only a regular file, its size checked before a byte is read, and
 * at most `LIMIT` bytes read. A project's file arrives with a clone, so it is
 * also opened refusing a link anywhere below the project folder — a planted
 * `.codex/config.toml -> /dev/zero` is unknown, never read. Codex's own home
 * is the person's, so a link there (a dotfiles checkout, say) is followed,
 * and what it reaches is still held to the same bounds.
 */

const PROVIDER_ENV = ['OPENAI_BASE_URL', 'OPENAI_API_BASE'] as const
const LIMIT = 1024 * 1024
const MAX_PROFILES = 256
/** macOS `O_NOFOLLOW_ANY`: refuse a symbolic link in any component of the path. */
const NOFOLLOW_ANY = 0x20000000

type Read = { readonly kind: 'absent' } | { readonly kind: 'unreadable' } | { readonly kind: 'text'; readonly text: string }

const ABSENT = new Set(['ENOENT', 'ENOTDIR'])

/**
 * One file, bounded. `under` names the folder a hostile tree hangs from:
 * the file is then opened refusing a link at any component below it (on
 * macOS in the open itself; elsewhere each component is looked at first).
 */
export const readBounded = async (path: string, options: { readonly under?: string } = {}): Promise<Read> => {
  let flags = constants.O_RDONLY | constants.O_NONBLOCK
  let target = path
  try {
    if (options.under !== undefined) {
      const base = await realpath(options.under)
      const rest = path.slice(options.under.length).split('/').filter(Boolean)
      target = join(base, ...rest)
      if (process.platform === 'darwin') {
        flags |= NOFOLLOW_ANY
      } else {
        let at = base
        for (const part of rest) {
          at = join(at, part)
          if ((await lstat(at)).isSymbolicLink()) return { kind: 'unreadable' }
        }
        flags |= constants.O_NOFOLLOW
      }
    }
    const handle = await open(target, flags)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > LIMIT) return { kind: 'unreadable' }
      const bytes = Buffer.alloc(LIMIT + 1)
      let used = 0
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used)
        if (bytesRead === 0) break
        used += bytesRead
      }
      return used > LIMIT ? { kind: 'unreadable' } : { kind: 'text', text: bytes.subarray(0, used).toString('utf8') }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return ABSENT.has((error as NodeJS.ErrnoException).code ?? '') ? { kind: 'absent' } : { kind: 'unreadable' }
  }
}

/** A launch's `-c key=value` overrides that this scanner cannot itself see, so their mere naming is enough. */
const LAUNCH_OVERRIDE = /model_provider|base_url|profile/

/** Whether any `-c` override on the launch names something that could move the provider or pick a different profile. */
export const launchOverridesProvider = (overrides: readonly string[]): boolean =>
  overrides.some((one) => LAUNCH_OVERRIDE.test(one))

/** A bare or quoted key, `=`, and the rest of the line, cruder than a TOML parser: no comment or string escaping beyond what `stripComment` already removed. */
const ASSIGNMENT = /^(?:([A-Za-z0-9_-]+)|"([^"]*)"|'([^']*)')\s*=\s*(.*)$/

/** Strips a trailing `# comment` outside any quoted string; a quote character inside a string is never mistaken for the start of one. */
const stripComment = (line: string): string => {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quote === '"' && char === '\\') {
      index += 1
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') return line.slice(0, index)
  }
  return line
}

/** Strips a trailing `# comment` already removed by `stripComment`, and one layer of surrounding quotes. */
const dequote = (raw: string): string => {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
  return value
}

/** A bare or quoted path segment, dot-separated — `profiles.x`, `model_providers."x y"` — the only header shape this scanner fully understands. */
const SEGMENT = '(?:[A-Za-z0-9_-]+|"[^"]*"|\'[^\']*\')'
const HEADER = new RegExp(`^\\[\\s*(${SEGMENT}(?:\\s*\\.\\s*${SEGMENT})*)\\s*\\]$`)

/** A `[profiles.<id>]` or `[model_providers.<id>]` table header; any other header, or none, otherwise. */
type Section = 'root' | 'other' | { readonly kind: 'profile' | 'provider'; readonly id: string }

const sectionFor = (header: string): Section => {
  const profile = /^profiles\.(.+)$/.exec(header)
  if (profile) return { kind: 'profile', id: dequote(profile[1]!) }
  const provider = /^model_providers\.(.+)$/.exec(header)
  if (provider) return { kind: 'provider', id: dequote(provider[1]!) }
  return 'other'
}

const isBaseUrlKey = (key: string): boolean => /^[A-Za-z_]*base_url$/.test(key)

/** One layer's own root selector/overrides and its named tables — never yet merged with any other layer. */
interface Layer {
  readonly profile: string | null
  readonly rootProvider: string | null
  readonly rootBaseUrl: boolean
  readonly profileLines: ReadonlyMap<string, readonly string[]>
  readonly providerLines: ReadonlyMap<string, readonly string[]>
}

/**
 * Parses one file's text into its root selector, its root overrides, and
 * its named `[profiles.*]`/`[model_providers.*]` tables — `'unknown'` the
 * moment anything is seen that this scanner cannot fully account for: a
 * multi-line string anywhere, a header it cannot parse cleanly (comments
 * and whitespace around a dot aside), a line that is not a clean
 * `key = value` assignment, or a value that could be an inline table.
 */
const parseLayer = (text: string): Layer | 'unknown' => {
  if (/"""|'''/.test(text)) return 'unknown'

  let current: Section = 'root'
  let profile: string | null = null
  let rootProvider: string | null = null
  let rootBaseUrl = false
  const profileLines = new Map<string, string[]>()
  const providerLines = new Map<string, string[]>()

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim()
    if (!line) continue
    if (line.startsWith('[')) {
      const header = HEADER.exec(line)
      if (!header) return 'unknown'
      current = sectionFor(header[1]!.replace(/\s*\.\s*/g, '.'))
      continue
    }
    const assignment = ASSIGNMENT.exec(line)
    if (!assignment) return 'unknown'
    const key = (assignment[1] ?? assignment[2] ?? assignment[3])!
    const value = assignment[4]!.trim()
    if (value.includes('{')) return 'unknown'
    if (current === 'root') {
      if (key === 'profile') profile = dequote(value)
      else if (key === 'model_provider') rootProvider = dequote(value)
      else if (isBaseUrlKey(key)) rootBaseUrl = true
    } else if (current !== 'other') {
      const bucket = current.kind === 'profile' ? profileLines : providerLines
      if (!bucket.has(current.id)) bucket.set(current.id, [])
      bucket.get(current.id)!.push(line)
    }
  }
  return { profile, rootProvider, rootBaseUrl, profileLines, providerLines }
}

/** A line already known to be a clean `key = value` assignment (parsed once by `parseLayer`); null when it somehow is not. */
const keyValueOf = (line: string): readonly [string, string] | null => {
  const assignment = ASSIGNMENT.exec(line)
  if (!assignment) return null
  return [(assignment[1] ?? assignment[2] ?? assignment[3])!, assignment[4]!.trim()]
}

/**
 * Whether the union of every layer's own configuration could point Codex
 * anywhere but OpenAI's own endpoint. An absent file contributes nothing; an
 * `'unknown'` layer decides the whole answer, at once. `profile` is
 * collected from every layer before any table is chosen: layers that
 * disagree about which one is active cannot be merged into a single
 * decision, so that disagreement is itself unknown. Once a profile is
 * agreed (or none is set anywhere), its table and any root override are
 * read from *every* layer that has one, not only the layer that happened to
 * set `profile` — a home table a project merely selects still counts.
 */
const layersOverride = (layers: readonly (Layer | 'unknown' | null)[]): boolean => {
  if (layers.some((one) => one === 'unknown')) return true
  const parsed = layers.filter((one): one is Layer => one !== null)
  if (parsed.some((one) => one.rootBaseUrl)) return true

  const profiles = new Set(parsed.map((one) => one.profile).filter((one): one is string => one !== null))
  if (profiles.size > 1) return true
  const activeProfileName = profiles.size === 1 ? [...profiles][0]! : null

  for (const layer of parsed) {
    if (layer.rootProvider !== null && layer.rootProvider !== 'openai') return true
  }

  if (activeProfileName !== null) {
    for (const layer of parsed) {
      for (const line of layer.profileLines.get(activeProfileName) ?? []) {
        const pair = keyValueOf(line)
        if (!pair) continue
        const [key, value] = pair
        if (key === 'model_provider' && dequote(value) !== 'openai') return true
        if (isBaseUrlKey(key)) return true
      }
    }
  }

  for (const layer of parsed) {
    for (const line of layer.providerLines.get('openai') ?? []) {
      const pair = keyValueOf(line)
      if (pair && isBaseUrlKey(pair[0])) return true
    }
  }
  return false
}

/** `'unknown'` when the file could not be read at all; `null` when it is simply absent; otherwise its parsed layer. */
const layerFrom = async (path: string, under?: string): Promise<Layer | 'unknown' | null> => {
  const read = await readBounded(path, under === undefined ? {} : { under })
  if (read.kind === 'absent') return null
  if (read.kind === 'unreadable') return 'unknown'
  return parseLayer(read.text)
}

export const codexProvider = async (
  home: string | null,
  env: Readonly<Record<string, string | undefined>>,
  cwd?: string,
): Promise<string | null> => {
  if (PROVIDER_ENV.some((name) => (env[name] ?? '').trim() !== '')) return null
  const root = rootOf(home)

  const profiles: string[] = []
  try {
    const folder = await opendir(root)
    for await (const entry of folder) {
      if (entry.name.endsWith('.config.toml')) profiles.push(entry.name)
      if (profiles.length > MAX_PROFILES) return null
    }
  } catch (error) {
    if (!ABSENT.has((error as NodeJS.ErrnoException).code ?? '')) return null
  }

  const layers = await Promise.all([
    layerFrom(join(root, 'config.toml')),
    ...profiles.map((name) => layerFrom(join(root, name))),
    ...(cwd !== undefined ? [layerFrom(join(cwd, '.codex', 'config.toml'), cwd)] : []),
  ])
  return layersOverride(layers) ? null : 'openai'
}
