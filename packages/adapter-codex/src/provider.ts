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
 * OpenAI's, unless the configuration actually *in force* could point it
 * elsewhere — a `model_provider` other than `openai` reachable from the
 * file's own root or from the `[profiles.<name>]` table its root `profile`
 * selects, any `base_url` set there or in the `[model_providers.<id>]` table
 * that active `model_provider` names, or `OPENAI_BASE_URL` — and then
 * unknown. Defining another profile or provider table that nothing selects
 * is not an override: a `config.toml` kept around for occasional use is not
 * what a session actually run on it reaches. A file that exists but cannot
 * be read rules nothing out, so it is unknown too. Read as text, deliberately
 * cruder than a TOML parser: a key in a comment reads as an override, which
 * errs toward unknown, the one answer that can never claim two steps are
 * independent when they are not.
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

/** A line's key and raw value, cruder than a TOML parser: no comment or string escaping beyond a trailing `#`. */
const ASSIGNMENT = /^(?:([A-Za-z0-9_-]+)|"([^"]*)"|'([^']*)')\s*=\s*(.*)$/

/** Strips a trailing `# comment` and surrounding quotes; a bare identifier is trimmed only. */
const dequote = (raw: string): string => {
  const value = raw.trim().replace(/\s*#.*$/, '').trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
  return value
}

/** A `[profiles.<id>]` or `[model_providers.<id>]` table header; any other header, or none, otherwise. */
type Section = 'root' | 'other' | { readonly kind: 'profile' | 'provider'; readonly id: string }

const sectionFor = (header: string): Section => {
  const profile = /^profiles\.(.+)$/.exec(header.trim())
  if (profile) return { kind: 'profile', id: dequote(profile[1]!) }
  const provider = /^model_providers\.(.+)$/.exec(header.trim())
  if (provider) return { kind: 'provider', id: dequote(provider[1]!) }
  return 'other'
}

const isBaseUrlKey = (key: string): boolean => /^[A-Za-z_]*base_url$/.test(key)

/**
 * Whether the configuration actually in force — the root table, the
 * `[profiles.<name>]` table the root's own `profile` selects, and the
 * `[model_providers.<id>]` table its active `model_provider` names — could
 * point Codex anywhere but OpenAI's own endpoint. A profile or provider table
 * nothing here selects is read, but never counted: defining one is not
 * turning it on.
 */
const activeOverrides = (text: string): boolean => {
  let current: Section = 'root'
  let rootProfile: string | null = null
  let rootProvider: string | null = null
  let rootBaseUrl = false
  const profileLines = new Map<string, string[]>()
  const providerLines = new Map<string, string[]>()

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[[')) { current = 'other'; continue }
    const header = /^\[\s*([^[\]]+?)\s*\]$/.exec(line)
    if (header) { current = sectionFor(header[1]!); continue }
    const assignment = ASSIGNMENT.exec(line)
    if (!assignment) continue
    const key = (assignment[1] ?? assignment[2] ?? assignment[3])!
    const value = assignment[4]!
    if (current === 'root') {
      if (key === 'profile') rootProfile = dequote(value)
      else if (key === 'model_provider') rootProvider = dequote(value)
      else if (isBaseUrlKey(key)) rootBaseUrl = true
    } else if (current !== 'other') {
      const bucket = current.kind === 'profile' ? profileLines : providerLines
      if (!bucket.has(current.id)) bucket.set(current.id, [])
      bucket.get(current.id)!.push(line)
    }
  }
  if (rootBaseUrl) return true

  let activeProvider = rootProvider
  for (const line of rootProfile !== null ? profileLines.get(rootProfile) ?? [] : []) {
    const assignment = ASSIGNMENT.exec(line)
    if (!assignment) continue
    const key = (assignment[1] ?? assignment[2] ?? assignment[3])!
    const value = assignment[4]!
    if (key === 'model_provider') activeProvider = dequote(value)
    else if (isBaseUrlKey(key)) return true
  }
  if (activeProvider !== null && activeProvider !== 'openai') return true

  return (providerLines.get(activeProvider ?? 'openai') ?? []).some((line) => {
    const assignment = ASSIGNMENT.exec(line)
    if (!assignment) return false
    const key = (assignment[1] ?? assignment[2] ?? assignment[3])!
    return isBaseUrlKey(key)
  })
}

/** Null when the file is absent; true when it could override; unreadable counts as could. */
const fileOverrides = async (path: string, under?: string): Promise<boolean | null> => {
  const read = await readBounded(path, under === undefined ? {} : { under })
  return read.kind === 'absent' ? null : read.kind === 'unreadable' ? true : activeOverrides(read.text)
}

export const codexProvider = async (
  home: string | null,
  env: Readonly<Record<string, string | undefined>>,
  cwd?: string,
): Promise<string | null> => {
  if (PROVIDER_ENV.some((name) => (env[name] ?? '').trim() !== '')) return null
  const root = rootOf(home)
  if (await fileOverrides(join(root, 'config.toml'))) return null
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
  for (const name of profiles) {
    if (await fileOverrides(join(root, name))) return null
  }
  if (cwd !== undefined && await fileOverrides(join(cwd, '.codex', 'config.toml'), cwd)) return null
  return 'openai'
}
