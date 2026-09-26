import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import { ConfinedTree } from '../confined-tree.js'
import { parseYaml, YamlError } from '../yaml.js'
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
  /**
   * The row's own launch arguments, when the caller has them (`knowledgeOverlay`
   * passes the row's `args`). A reader that only knows what profile or mode a
   * flag selects — DSH's `--profile acp` — needs these to see a flag the
   * files it reads would never mention; see `dshProvider`.
   */
  readonly args?: readonly string[]
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
    case 'dsh':
      return () => dshProvider(context)
    // Cursor's provider is a per-session model choice, not a runtime- or
    // project-level setting `providerAt`/`providerOf` can answer: the same
    // `cursor` runtime id can be running Claude, GPT or Gemini models at
    // once across its live sessions, and this reader is asked about the
    // runtime, never the session. Mapping a model id to its vendor here
    // would silently answer for the wrong session as often as the right
    // one, which is exactly the guess `independentOf` cannot afford — so
    // Cursor stays unknown, on purpose, until a provider check can be asked
    // per session.
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

/**
 * DeepSeek Harness (`dsh --profile acp`): DeepSeek's own API, but only when
 * every one of these holds across both layers a person can patch — the
 * `acp` profile's own `cordis.patch.yml`, and the home-level one that
 * outranks every profile (DSH always starts on `acp`; see the `dsh` entry
 * in `known-agents.ts`, and `codexProvider` for the same reasoning about a
 * profile nothing selects):
 *
 * - the row's own launch arguments are exactly `--profile acp`, DSH's own
 *   template — anything else, including the same flag with more after it,
 *   could load a profile or an overlay these two files never speak for, and
 *   this reader has no way to tell what that would do;
 * - `DEEPSEEK_BASE_URL` is not set in the environment it starts with;
 * - no layer's `llm-deepseek`, `llm-deepseek-account` or
 *   `llm-deepseek-api-key` entry sets `baseURL` outside `api.deepseek.com`;
 * - no layer's `agent-default-model` entry sets a `provider` other than the
 *   vendor default, `deepseek-official` — absent is the default, present and
 *   different is a redirect;
 * - no layer's `llm-pi-ai` entry carries any `config` at all: that entry
 *   ships mounted dormant, with zero routes, until a settings document gives
 *   it one — so any config on it at all means some other provider's routes
 *   could be live, and which one `agent-default-model` might then pick is
 *   not this reader's to guess;
 * - no layer has an `insert` anywhere: a patch that inserts a plugin can add
 *   any capability, including a different default model or provider, and
 *   this reader does not attempt to understand an inserted tree.
 *
 * A file that is absent contributes nothing (the vendor default holds); one
 * that cannot be read, like one that redirects anything above, answers
 * unknown. DSH's own secret file (`.credentials.yaml`) is never opened:
 * nothing it can hold changes where a request goes, and its contents are
 * not this decision's business.
 */
const DSH_BASE_URL_ENV = 'DEEPSEEK_BASE_URL'
const DSH_HOST = 'api.deepseek.com'
const DSH_DEFAULT_PROVIDER = 'deepseek-official'
const DSH_ENTRY_IDS = new Set(['llm-deepseek', 'llm-deepseek-account', 'llm-deepseek-api-key'])
/**
 * The arguments DSH's own known-agent entry launches with (`known-agents.ts`'s
 * `dsh` entry keeps its own `acp.args` empty on purpose, so a person's own
 * profile flag is never silently replaced — see `service.ts`'s
 * `launchFor`). This is what `dshProvider` checks a row's own args against:
 * anything else could select a profile this reader never looked at.
 */
const DSH_ACP_ARGS: readonly string[] = ['--profile', 'acp']

const isYamlMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The parsed top-level list of a patch file's items, each held to the shape
 * this reader actually understands — a list of maps. `null` for anything
 * else: a parse failure (`YamlError`, refused by `parseYaml`'s own strict
 * subset), a document that isn't a list, or a list holding something other
 * than a map. An empty file parses to `null` from `parseYaml` itself and is
 * read as a patch with no items, not a shape this reader fails to recognise.
 */
const dshPatchItems = (text: string): readonly Record<string, unknown>[] | null => {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error) {
    if (error instanceof YamlError) return null
    throw error
  }
  if (parsed === null) return []
  if (!Array.isArray(parsed) || !parsed.every(isYamlMap)) return null
  return parsed as Record<string, unknown>[]
}

/**
 * Every item whose `id` is this one. DSH applies every patch in order and the
 * later one wins, so a reader that checked only the first could pass a later
 * override it never looked at.
 */
const yamlItemsById = (items: readonly Record<string, unknown>[], id: string): Record<string, unknown>[] =>
  items.filter((item) => item['id'] === id)

/**
 * Whether one patch layer's text could point DSH's default session anywhere
 * but DeepSeek's own API — every condition documented above `dshProvider`,
 * checked against this layer alone (the caller checks all of them
 * together). Any doubt along the way — a parse failure, a shape this reader
 * does not recognise, a value of the wrong type — answers `true`: it could
 * override, so the caller treats it exactly like one that does.
 */
const dshLayerOverrides = (text: string): boolean => {
  const items = dshPatchItems(text)
  if (items === null) return true
  if (items.some((item) => Object.prototype.hasOwnProperty.call(item, 'insert'))) return true

  for (const piAi of yamlItemsById(items, 'llm-pi-ai')) {
    if (Object.prototype.hasOwnProperty.call(piAi, 'config')) return true
  }

  for (const defaultModel of yamlItemsById(items, 'agent-default-model')) {
    if (!Object.prototype.hasOwnProperty.call(defaultModel, 'config')) continue
    const config = defaultModel['config']
    if (!isYamlMap(config)) return true
    if (Object.prototype.hasOwnProperty.call(config, 'provider')) {
      const provider = config['provider']
      if (typeof provider !== 'string' || provider !== DSH_DEFAULT_PROVIDER) return true
    }
  }

  for (const id of DSH_ENTRY_IDS) {
    for (const item of yamlItemsById(items, id)) {
      if (!Object.prototype.hasOwnProperty.call(item, 'config')) continue
      const config = item['config']
      if (!isYamlMap(config)) return true
      if (!Object.prototype.hasOwnProperty.call(config, 'baseURL')) continue
      const baseUrl = config['baseURL']
      if (typeof baseUrl !== 'string') return true
      try {
        if (new URL(baseUrl).hostname !== DSH_HOST) return true
      } catch {
        return true
      }
    }
  }
  return false
}

/** Expands DSH's own supported tilde forms (`~`, `~/…`) against the OS home; any other path is returned unchanged. */
const expandDshHome = (path: string, home: string): string => {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/** Whether two argument lists are exactly the same, in order. */
const sameArgs = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, at) => value === b[at])

const dshProvider = async (context: ProviderContext): Promise<string | null> => {
  const env = context.env ?? process.env
  if ((env[DSH_BASE_URL_ENV] ?? '').trim() !== '') return null
  // This reader only ever looks at the `acp` profile's own files. A row
  // launched with anything else on the command line — another flag, or a
  // different profile altogether — could load an overlay these files never
  // mention, so anything but the template's own args is unknown outright.
  if (context.args === undefined || !sameArgs(context.args, DSH_ACP_ARGS)) return null
  const osHome = context.home ?? homedir()
  const configured = env['DSH_HOME']?.trim()
  const dshHome = configured ? expandDshHome(configured, osHome) : join(osHome, '.dsh')
  // DSH itself resolves a still-relative home against its own process's
  // working directory; this reader has no reliable claim to that directory,
  // so guessing which files it would mean is refused rather than risked.
  if (!isAbsolute(dshHome)) return null
  const reads = await Promise.all([
    readOwn(join(dshHome, 'cordis.patch.yml')),
    readOwn(join(dshHome, 'profiles', 'acp', 'cordis.patch.yml')),
  ])
  for (const read of reads) {
    if (read.kind === 'absent') continue
    if (read.kind === 'unreadable') return null
    if (dshLayerOverrides(read.text)) return null
  }
  return 'deepseek'
}
