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
 * OpenAI's, unless any of those could point it elsewhere — a
 * `model_provider` other than `openai`, any `base_url`, a
 * `[model_providers.*]` table, or `OPENAI_BASE_URL` — and then unknown. A
 * file that exists but cannot be read rules nothing out, so it is unknown
 * too. Read as text, deliberately cruder than a TOML parser: a key in a
 * comment reads as an override, which errs toward unknown, the one answer
 * that can never claim two steps are independent when they are not.
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

/** `model_provider = "<id>"` other than OpenAI's own, any `base_url`, or a provider table. */
const overrides = (text: string): boolean =>
  /^\s*[A-Za-z_]*base_url\s*=/m.test(text) ||
  /^\s*\[\s*model_providers\b/m.test(text) ||
  /model_providers\./.test(text) ||
  [...text.matchAll(/^\s*model_provider\s*=\s*(.*)$/gm)].some((match) => !/^["']openai["']\s*(#.*)?$/.test(match[1]!.trim()))

/** Null when the file is absent; true when it could override; unreadable counts as could. */
const fileOverrides = async (path: string, under?: string): Promise<boolean | null> => {
  const read = await readBounded(path, under === undefined ? {} : { under })
  return read.kind === 'absent' ? null : read.kind === 'unreadable' ? true : overrides(read.text)
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
