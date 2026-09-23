import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

import { ConfinedTree } from '../confined-tree.js'
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
 *
 * Every read is bounded and never holds the desk's thread: opened without
 * blocking, a regular file only, its size checked before a byte is read.
 * A file inside the project a session works in arrived with a clone, so it
 * is read through `ConfinedTree`, which also refuses a link at any component
 * — a planted `.claude/settings.json -> /dev/zero` is unknown, never read.
 * The agent's own home, and the folders above the project up to it, are the
 * person's, so a link there is followed and what it reaches held to the
 * same bounds.
 */

export interface ProviderContext {
  /** The environment the agent is started with. Defaults to the host's own. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The home directory. Tests point it somewhere else. */
  readonly home?: string
  /** Claude Code's managed settings file; null reads none. Defaults to this platform's. */
  readonly managed?: string | null
}

export type ProviderReader = (cwd?: string) => Promise<string | null>

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
const ABSENT = new Set(['ENOENT', 'ENOTDIR'])

/** One of the person's own files, bounded: a link is followed, a device, FIFO or oversized file is not read. */
const readOwn = async (path: string): Promise<Read> => {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
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

/** A project's file, through the confined tree rooted at `root`: no link anywhere below it, bounded. */
const readProject = async (root: string, rel: string): Promise<Read> => {
  try {
    const text = await (await ConfinedTree.open(root)).read(rel, LIMIT)
    return text === null ? { kind: 'absent' } : { kind: 'text', text }
  } catch (error) {
    return ABSENT.has((error as NodeJS.ErrnoException).code ?? '') ? { kind: 'absent' } : { kind: 'unreadable' }
  }
}

/**
 * The checkout a folder is in: the nearest folder at or above it holding a
 * `.git` entry, looked at without following anything — or the folder itself
 * when none is found. What a project-side walk stays inside.
 */
const checkoutOf = async (cwd: string): Promise<string> => {
  for (let folder = cwd, hop = 0; hop < 64; hop += 1) {
    if (await lstat(join(folder, '.git')).then(() => true, () => false)) return folder
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return cwd
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

const claudeProvider = async (context: ProviderContext, cwd?: string): Promise<string | null> => {
  const env = context.env ?? process.env
  if (Object.entries(env).some(([name, value]) => claudeOverride(name) && set(value))) return null
  const home = context.home ?? homedir()
  const user = env['CLAUDE_CONFIG_DIR']?.trim() || join(home, '.claude')
  const managed = context.managed === undefined
    ? (process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json')
    : context.managed
  const reads: Promise<Read>[] = [
    ...(managed ? [readOwn(managed)] : []),
    readOwn(join(user, 'settings.json')),
    ...(cwd ? [readProject(cwd, '.claude/settings.json'), readProject(cwd, '.claude/settings.local.json')] : []),
  ]
  for (const read of await Promise.all(reads)) {
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
 * loads (walking up from the folder it works in — inside its checkout
 * through the confined tree, above it only through the person's own folders
 * up to their home — then its own home), or a
 * gateway sign-in or a base URL in its settings (`GEMINI_CLI_HOME` moves the
 * home they are in).
 */
const geminiOverride = (name: string): boolean => /^(GOOGLE|GEMINI)_.*BASE_URL$/.test(name)

const geminiProvider = async (context: ProviderContext, cwd?: string): Promise<string | null> => {
  const env = context.env ?? process.env
  if (Object.entries(env).some(([name, value]) => geminiOverride(name) && set(value))) return null
  const home = env['GEMINI_CLI_HOME']?.trim() || context.home || homedir()
  const dotenvs: Promise<Read>[] = []
  const settings: Promise<Read>[] = [readOwn(join(home, '.gemini', 'settings.json'))]
  if (cwd) {
    // Inside the checkout, through the confined tree; above it, only the person's own folders up to their home.
    const top = await checkoutOf(cwd)
    const inside = relative(top, cwd)
    const steps = inside === '' ? [] : inside.split(sep)
    for (let depth = steps.length; depth >= 0; depth -= 1) {
      const at = steps.slice(0, depth)
      dotenvs.push(readProject(top, [...at, '.gemini', '.env'].join('/')), readProject(top, [...at, '.env'].join('/')))
    }
    settings.push(readProject(top, [...steps, '.gemini', 'settings.json'].join('/')))
    if (top.startsWith(`${home}${sep}`)) {
      for (let folder = dirname(top); folder.startsWith(`${home}${sep}`); folder = dirname(folder)) {
        dotenvs.push(readOwn(join(folder, '.gemini', '.env')), readOwn(join(folder, '.env')))
      }
    }
  }
  dotenvs.push(readOwn(join(home, '.gemini', '.env')), readOwn(join(home, '.env')))
  for (const read of await Promise.all(dotenvs)) {
    if (read.kind === 'unreadable') return null
    if (read.kind === 'text' && read.text.split('\n').some((line) => geminiOverride(line.split('=')[0]!.replace(/^\s*export\s+/, '').trim()))) return null
  }
  for (const read of await Promise.all(settings)) {
    if (read.kind === 'absent') continue
    if (read.kind === 'unreadable' || /base_?url/i.test(read.text) || /"gateway"/.test(read.text)) return null
  }
  return 'google'
}
