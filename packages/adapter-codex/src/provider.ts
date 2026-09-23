import { readdirSync, readFileSync } from 'node:fs'
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
 */

const PROVIDER_ENV = ['OPENAI_BASE_URL', 'OPENAI_API_BASE'] as const
const LIMIT = 1024 * 1024

/** `model_provider = "<id>"` other than OpenAI's own, any `base_url`, or a provider table. */
const overrides = (text: string): boolean =>
  /^\s*[A-Za-z_]*base_url\s*=/m.test(text) ||
  /^\s*\[\s*model_providers\b/m.test(text) ||
  /model_providers\./.test(text) ||
  [...text.matchAll(/^\s*model_provider\s*=\s*(.*)$/gm)].some((match) => !/^["']openai["']\s*(#.*)?$/.test(match[1]!.trim()))

/** Null when the file is absent; true when it could override; unreadable counts as could. */
const fileOverrides = (path: string): boolean | null => {
  let text: string
  try {
    const bytes = readFileSync(path)
    if (bytes.length > LIMIT) return true
    text = bytes.toString('utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : true
  }
  return overrides(text)
}

export const codexProvider = (
  home: string | null,
  env: Readonly<Record<string, string | undefined>>,
  cwd?: string,
): string | null => {
  if (PROVIDER_ENV.some((name) => (env[name] ?? '').trim() !== '')) return null
  const root = rootOf(home)
  if (fileOverrides(join(root, 'config.toml'))) return null
  let names: string[]
  try {
    names = readdirSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    names = []
  }
  for (const name of names.filter((one) => one.endsWith('.config.toml')).slice(0, 256)) {
    if (fileOverrides(join(root, name))) return null
  }
  if (cwd !== undefined && fileOverrides(join(cwd, '.codex', 'config.toml'))) return null
  return 'openai'
}
