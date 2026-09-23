import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { KnownAgent } from './known-agents.js'

/**
 * Which vendor's models an agent's sessions reach, read from the agent's own
 * configuration the way the agent reads it — never from its name.
 *
 * What a flow step that must be independent of an earlier one is checked
 * against (`RuntimeInfo.provider`). So every reader here answers the vendor
 * only when nothing the person configured could point the agent anywhere
 * else, and unknown the moment anything could: an environment variable, a
 * settings file's `env` block, a project's own settings or `.env`, or a file
 * that exists but cannot be read. Unknown is never taken for independent, so
 * erring toward it can only refuse a step, never wrongly admit one.
 *
 * Read-only, and read the way `identity.ts` reads: the agent's own files,
 * no write, no network call. An agent with no reader here is unknown.
 */

export interface ProviderContext {
  /** The environment the agent is started with. Defaults to the host's own. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The home directory. Tests point it somewhere else. */
  readonly home?: string
  /** Claude Code's managed settings file; null reads none. Defaults to this platform's. */
  readonly managed?: string | null
}

export type ProviderReader = (cwd?: string) => string | null

/** The reader for the agent a row drives, when the desk knows where that agent keeps its provider. */
export const providerReaderFor = (
  known: Pick<KnownAgent, 'id'> | undefined,
  context: ProviderContext = {},
): ProviderReader | undefined => {
  switch (known?.id) {
    case 'claude-code':
      return (cwd) => claudeProvider(context, cwd)
    case 'gemini':
      return (cwd) => geminiProvider(context, cwd)
    default:
      return undefined
  }
}

type Read = { readonly kind: 'absent' } | { readonly kind: 'unreadable' } | { readonly kind: 'text'; readonly text: string }

const LIMIT = 1024 * 1024

const readText = (path: string): Read => {
  try {
    const bytes = readFileSync(path)
    return bytes.length > LIMIT ? { kind: 'unreadable' } : { kind: 'text', text: bytes.toString('utf8') }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' }
  }
}

const set = (value: unknown): boolean => typeof value === 'string' ? value.trim() !== '' && value.trim() !== '0' && value.trim() !== 'false' : value !== undefined && value !== null && value !== false

/**
 * Claude Code: Anthropic's models unless a base URL or another host is set —
 * `ANTHROPIC_*BASE_URL`, `CLAUDE_CODE_USE_*` (Bedrock, Vertex, Foundry) — in
 * the environment it is started with or in the `env` block of any settings
 * file it reads: the managed file, the user's (`CLAUDE_CONFIG_DIR` moves it),
 * and the project's own `.claude/settings.json` and `settings.local.json`.
 */
const claudeOverride = (name: string): boolean => /^ANTHROPIC_.*BASE_URL$/.test(name) || /^CLAUDE_CODE_USE_/.test(name)

const claudeProvider = (context: ProviderContext, cwd?: string): string | null => {
  const env = context.env ?? process.env
  if (Object.entries(env).some(([name, value]) => claudeOverride(name) && set(value))) return null
  const home = context.home ?? homedir()
  const user = env['CLAUDE_CONFIG_DIR']?.trim() || join(home, '.claude')
  const managed = context.managed === undefined
    ? (process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json')
    : context.managed
  const files = [
    ...(managed ? [managed] : []),
    join(user, 'settings.json'),
    ...(cwd ? [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')] : []),
  ]
  for (const file of files) {
    const read = readText(file)
    if (read.kind === 'absent') continue
    if (read.kind === 'unreadable') return null
    let parsed: unknown
    try { parsed = JSON.parse(read.text) } catch { return null }
    const block = typeof parsed === 'object' && parsed !== null ? (parsed as { env?: unknown }).env : undefined
    if (block === undefined) continue
    if (typeof block !== 'object' || block === null) return null
    if (Object.entries(block as Record<string, unknown>).some(([name, value]) => claudeOverride(name) && set(value))) return null
  }
  return 'anthropic'
}

/**
 * Gemini CLI: Google's models unless a base URL is set — any `GOOGLE_*` or
 * `GEMINI_*` variable naming one, in the environment or in a `.env` file it
 * loads (walking up from the folder it works in, then its own home), or a
 * gateway sign-in or a base URL in its settings (`GEMINI_CLI_HOME` moves the
 * home they are in).
 */
const geminiOverride = (name: string): boolean => /^(GOOGLE|GEMINI)_.*BASE_URL$/.test(name)

const geminiProvider = (context: ProviderContext, cwd?: string): string | null => {
  const env = context.env ?? process.env
  if (Object.entries(env).some(([name, value]) => geminiOverride(name) && set(value))) return null
  const home = env['GEMINI_CLI_HOME']?.trim() || context.home || homedir()
  const dotenvs: string[] = []
  for (let folder = cwd; folder; ) {
    dotenvs.push(join(folder, '.gemini', '.env'), join(folder, '.env'))
    const parent = dirname(folder)
    folder = parent === folder ? undefined : parent
  }
  dotenvs.push(join(home, '.gemini', '.env'), join(home, '.env'))
  for (const file of dotenvs) {
    const read = readText(file)
    if (read.kind === 'unreadable') return null
    if (read.kind === 'text' && read.text.split('\n').some((line) => geminiOverride(line.split('=')[0]!.replace(/^\s*export\s+/, '').trim()))) return null
  }
  for (const file of [join(home, '.gemini', 'settings.json'), ...(cwd ? [join(cwd, '.gemini', 'settings.json')] : [])]) {
    const read = readText(file)
    if (read.kind === 'absent') continue
    if (read.kind === 'unreadable' || /base_?url/i.test(read.text) || /"gateway"/.test(read.text)) return null
  }
  return 'google'
}
