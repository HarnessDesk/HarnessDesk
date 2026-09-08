import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'
import type {
  AcpRegistryCatalogInfo,
  AgentRegisterRequest,
  AgentRuntime,
  AgentTemplateInfo,
  RuntimeId,
} from '@harnessdesk/protocol'

import type { AcpRegistry } from './acp-registry.js'
import { channelLabel } from './installs/channels.js'
import { knownAgent } from './installs/known-agents.js'
import type { JudgedInstall } from './installs/locate.js'
import type { InstallService } from './installs/service.js'

/**
 * The agent registry, writable.
 *
 * `agents.json` has always been the way ACP agents join the picker; what was
 * missing was any way to write it that is not a text editor. This module owns
 * the file — reading it exactly as `bootstrap` always has, and now writing it
 * on behalf of the interface — plus the catalogue of agents this build knows
 * how to register on its own: the bridges that ship in this repository and
 * the CLIs that speak ACP directly.
 *
 * The registry points at a command; it does not manage software. Registering
 * a template installs nothing, and removing an entry uninstalls nothing.
 */

const run = promisify(execFile)

/** `app.asar` cannot be spawned from; the unpacked twin can. See `bootstrap`. */
const ASAR = `${sep}app.asar${sep}`

/** The same path, as a process that is not Electron would have to open it. */
export const packagedPath = (entry: string): string =>
  entry.includes(ASAR) ? entry.replace(ASAR, `${sep}app.asar.unpacked${sep}`) : entry

/** A sibling package's entry point, named where it landed on disk. */
const siblingEntry = (relative: string): string =>
  packagedPath(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)))

/**
 * One agent this build can register without the user writing JSON.
 *
 * `bridge` names an in-repo package whose `dist/src/main.js` speaks ACP and
 * is run under this process's own executable — `process.execPath` is Node in
 * a standalone host and Electron in the app, where `ELECTRON_RUN_AS_NODE`
 * makes it one. A template without `bridge` is an agent CLI that speaks ACP
 * itself, and `command`/`args` say how to start it.
 *
 * The bar for a row here: it must run without the user editing anything.
 * DeepSeek Harness is deliberately not a template — even with `dsh` on PATH,
 * our `dsh-acp` server (a separate repository; `packages/dsh-acp` is its
 * untracked build output) needs a machine-specific `--config`, so a template
 * would register an agent that cannot start until a file is written, which
 * is the text-editor step templates exist to remove. DSH registers through
 * the custom-command form; the README's "does not do yet" records the same
 * decision where users read. A test pins this set so a change to it is a
 * choice, never drift.
 */
interface AgentTemplate {
  readonly key: string
  readonly name: string
  readonly brand?: string
  readonly tagline?: string
  readonly bridge?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly account?: AcpAgentConfig['account']
  readonly executable?: AcpAgentConfig['executable']
  readonly requires?: {
    readonly command: string
    /** False when the bridge embeds its own copy and merely prefers the CLI. */
    readonly cliRequired: boolean
    readonly installCommand?: string
  }
}

const TEMPLATES: readonly AgentTemplate[] = [
  {
    key: 'claude-code',
    name: 'Claude',
    brand: 'claudecode',
    tagline: "Anthropic's coding agent, through the bridge that ships with HarnessDesk.",
    bridge: 'claude-acp',
    // The bridge must not believe it is running inside a Claude Code session.
    env: { CLAUDECODE: '' },
    account: {
      status: { command: 'claude', args: ['auth', 'status'] },
      login: { command: 'claude', args: ['auth', 'login'] },
      logout: { command: 'claude', args: ['auth', 'logout'] },
    },
    executable: { command: 'claude', env: 'CLAUDE_CODE_EXECUTABLE' },
    requires: {
      command: 'claude',
      // The bridge ships an embedded copy, so a machine without the CLI still
      // works — it just runs whatever the bridge bundled.
      cliRequired: false,
      installCommand: 'npm install -g @anthropic-ai/claude-code',
    },
  },
  {
    key: 'cursor',
    name: 'Cursor',
    brand: 'cursor',
    tagline: "Cursor's CLI agent, through the bridge that ships with HarnessDesk.",
    bridge: 'cursor-acp',
    account: {
      status: { command: 'cursor-agent', args: ['status'] },
      login: { command: 'cursor-agent', args: ['login'], env: { NO_OPEN_BROWSER: '1' } },
      logout: { command: 'cursor-agent', args: ['logout'] },
    },
    executable: { command: 'cursor-agent', env: 'CURSOR_ACP_COMMAND' },
    requires: {
      command: 'cursor-agent',
      cliRequired: true,
      installCommand: 'curl https://cursor.com/install -fsS | bash',
    },
  },
  {
    key: 'gemini',
    name: 'Gemini CLI',
    brand: 'geminicli',
    tagline: "Google's Gemini CLI, speaking ACP directly.",
    command: 'gemini',
    // `--acp` since 0.58; the install service starts an older copy with the
    // flag it knows, and the row's own spelling is only the last resort.
    args: ['--acp'],
    requires: {
      command: 'gemini',
      cliRequired: true,
      installCommand: 'npm install -g @google/gemini-cli',
    },
  },
  {
    // Not in the public registry: the bridge is a subcommand of the CLI,
    // and it needs the person's own Gateway running, which the install
    // service checks before every start.
    key: 'openclaw',
    name: 'OpenClaw',
    brand: 'openclaw',
    tagline: "OpenClaw's Gateway, through its own ACP bridge.",
    command: 'openclaw',
    args: ['acp'],
    env: { OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1' },
    requires: {
      command: 'openclaw',
      cliRequired: true,
      installCommand: 'npm install -g openclaw',
    },
  },
  {
    // Not in the public registry either; `hermes acp` is the vendor's own
    // ACP server and reads the same ~/.hermes the CLI does.
    key: 'hermes',
    name: 'Hermes Agent',
    brand: 'hermesagent',
    tagline: "Nous Research's Hermes Agent, speaking ACP directly.",
    command: 'hermes',
    args: ['acp'],
    requires: {
      command: 'hermes',
      cliRequired: true,
      installCommand: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    },
  },
]

const templateByKey = (key: string): AgentTemplate | undefined =>
  TEMPLATES.find((template) => template.key === key)

/**
 * The brand a registry entry *would* have carried had it been written by
 * today's template. Entries created before templates carried brands persist
 * without one, and a runtime without a brand makes the host fall back to
 * guessing from the display name — the "Cursor Agent" those entries were
 * written under guesses `cursoragent`, which is not the `cursor` every
 * brand-keyed table is written against. The library then read Cursor's
 * column with no location table at all, and said so only in a footnote.
 * Backfilled at spawn, not migrated on disk: the file stays the user's, and
 * the fix applies to entries however old.
 */
export const templateBrandFor = (key: string): string | undefined => templateByKey(key)?.brand

/**
 * The bridge packages the templates spawn, derived from the table itself so
 * the list cannot drift from it. Exported for the packaging test: every one
 * of these must be a dependency of the desktop app and must be real files on
 * disk in the packaged artifact — a spawned Node child cannot be executed
 * from inside an asar archive, and a template whose bridge did not ship
 * reports "this build does not carry the bridge" to every user.
 */
export const TEMPLATE_BRIDGES: readonly string[] = TEMPLATES.flatMap((template) =>
  template.bridge ? [template.bridge] : [],
)

/** Where a bridge template's entry point is, or null when this build lacks it. */
const bridgeEntryOf = (template: AgentTemplate): string | null => {
  if (!template.bridge) return null
  const entry = siblingEntry(`${template.bridge}/dist/src/main.js`)
  return existsSync(entry) ? entry : null
}

const whichOnPath = async (command: string): Promise<string | null> => {
  try {
    const { stdout } = await run('/usr/bin/which', [command], { timeout: 5_000 })
    const found = stdout.trim().split('\n')[0]
    return found && found.length > 0 ? found : null
  } catch {
    return null
  }
}

/** The full config a stored template entry stands for. Null when this build cannot serve it. */
const expandTemplate = (
  template: AgentTemplate,
  entry: { readonly id: string; readonly env?: Readonly<Record<string, string>> },
): AcpAgentConfig | null => {
  const base = {
    id: entry.id,
    name: template.name,
    ...(template.brand ? { brand: template.brand } : {}),
    ...(template.tagline ? { tagline: template.tagline } : {}),
    ...(template.account ? { account: template.account } : {}),
    ...(template.executable ? { executable: template.executable } : {}),
    ...(template.requires?.installCommand
      ? { installCommand: template.requires.installCommand }
      : {}),
  }
  if (template.bridge) {
    const bridgeEntry = bridgeEntryOf(template)
    if (!bridgeEntry) return null
    return {
      ...base,
      command: process.execPath,
      args: [bridgeEntry],
      env: {
        ...(template.env ?? {}),
        // In the packaged app `process.execPath` is Electron, which runs a
        // script only when told to. Ignored by a real Node.
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        ...(entry.env ?? {}),
      },
    }
  }
  return {
    ...base,
    command: template.command ?? entry.id,
    ...(template.args ? { args: template.args } : {}),
    ...(template.env || entry.env ? { env: { ...(template.env ?? {}), ...(entry.env ?? {}) } } : {}),
  }
}

/** A registry id: something that can serve as a runtime id and a log key. */
const ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/

export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

type Log = (message: string, details?: Record<string, unknown>) => void

/**
 * `agents.json`, read and written.
 *
 * Reads are forgiving for the same reason they always were — the file is
 * hand-editable and an agent that silently never appears is the hardest
 * possible way to be told about a typo. Writes go through a temp file and a
 * rename, and touch only the entry they are about: everything else in the
 * file, unknown fields included, is carried through byte-for-byte as parsed.
 */
export class AgentRegistryStore {
  constructor(
    private readonly path: string,
    private readonly warn: Log = () => {},
  ) {}

  /** The raw entries as stored, unknown fields and all. */
  #raw(): Record<string, unknown>[] {
    return this.#load().entries
  }

  #load(): { entries: Record<string, unknown>[]; unreadable: boolean } {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      return { entries: [], unreadable: false } // No registry is the common case, not an error.
    }
    try {
      const parsed = JSON.parse(text) as { agents?: unknown }
      const list = Array.isArray(parsed.agents) ? parsed.agents : []
      return {
        entries: list.filter(
          (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
        ),
        unreadable: false,
      }
    } catch (error) {
      this.warn('agents.json is unreadable and was ignored', {
        path: this.path,
        error: String(error),
      })
      return { entries: [], unreadable: true }
    }
  }

  #write(entries: readonly Record<string, unknown>[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = join(dirname(this.path), `.agents.json.${process.pid}.tmp`)
    writeFileSync(tmp, `${JSON.stringify({ agents: entries }, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.path)
  }

  ids(): readonly string[] {
    return this.#raw()
      .map((entry) => entry['id'])
      .filter((id): id is string => typeof id === 'string')
  }

  /** The stored entries as they are on disk, for the backup file. */
  entries(): readonly Readonly<Record<string, unknown>>[] {
    return this.#raw()
  }

  has(id: string): boolean {
    return this.ids().includes(id)
  }

  /**
   * Every usable entry as a runnable config. Template entries are expanded
   * against this build's bridges; entries this build cannot serve — an
   * unknown template, a bridge the build lacks, a missing field — are warned
   * about by name and skipped, never silently.
   */
  configs(): readonly AcpAgentConfig[] {
    const out: AcpAgentConfig[] = []
    for (const [index, entry] of this.#raw().entries()) {
      const named =
        typeof entry['id'] === 'string' ? (entry['id'] as string) : `#${index + 1}`
      if (typeof entry['template'] === 'string') {
        const template = templateByKey(entry['template'])
        if (!template || typeof entry['id'] !== 'string') {
          this.warn('an agent in agents.json was ignored', {
            path: this.path,
            agent: named,
            missing: template ? ['id'] : [`template ${JSON.stringify(entry['template'])}`],
          })
          continue
        }
        const expanded = expandTemplate(template, {
          id: entry['id'],
          ...(isEnv(entry['env']) ? { env: entry['env'] } : {}),
        })
        if (!expanded) {
          this.warn('an agent in agents.json needs a bridge this build does not carry', {
            path: this.path,
            agent: named,
            template: template.key,
          })
          continue
        }
        out.push(expanded)
        continue
      }
      const missing = ['id', 'name', 'command'].filter(
        (field) => typeof entry[field] !== 'string',
      )
      if (missing.length > 0) {
        this.warn('an agent in agents.json was ignored', { path: this.path, agent: named, missing })
        continue
      }
      out.push(entry as unknown as AcpAgentConfig)
    }
    return out
  }

  /** Adds one entry. Refuses an id the file already names. */
  add(entry: Record<string, unknown> & { readonly id: string }): void {
    if (!ID_SHAPE.test(entry.id)) {
      throw new Error(
        `Agent ids are lowercase letters, digits and dashes; ${JSON.stringify(entry.id)} is not.`,
      )
    }
    const { entries, unreadable } = this.#load()
    // A file that exists but cannot be parsed is the user's hand-edit gone
    // wrong; writing over it would erase every agent they had. Refuse with
    // the path, which is the one thing they need to fix it.
    if (unreadable) {
      throw new Error(`${this.path} is not valid JSON; fix or remove it, then try again.`)
    }
    if (entries.some((existing) => existing['id'] === entry.id)) {
      throw new Error(`An agent with the id ${JSON.stringify(entry.id)} is already registered.`)
    }
    this.#write([...entries, entry])
  }

  /**
   * Rewrites the named fields of one entry and nothing else. A field set to
   * `undefined` is dropped. Used for what the interface decides about an
   * entry after it exists — a pinned install, a replaced download — so the
   * rest of the row, hand-written fields included, is carried through.
   */
  patch(id: string, fields: Readonly<Record<string, unknown>>): boolean {
    const { entries, unreadable } = this.#load()
    if (unreadable) {
      throw new Error(`${this.path} is not valid JSON; fix or remove it, then try again.`)
    }
    const index = entries.findIndex((entry) => entry['id'] === id)
    if (index === -1) return false
    const next = { ...entries[index] }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    this.#write(entries.map((entry, at) => (at === index ? next : entry)))
    return true
  }

  /** One entry as stored, or null. */
  entry(id: string): Readonly<Record<string, unknown>> | null {
    return this.#raw().find((entry) => entry['id'] === id) ?? null
  }

  /** Removes one entry. An id that is not there is not an error — it left. */
  remove(id: string): boolean {
    const { entries, unreadable } = this.#load()
    if (unreadable) {
      throw new Error(`${this.path} is not valid JSON; fix or remove it, then try again.`)
    }
    const remaining = entries.filter((entry) => entry['id'] !== id)
    if (remaining.length === entries.length) return false
    this.#write(remaining)
    return true
  }
}

const isEnv = (value: unknown): value is Readonly<Record<string, string>> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every((entry) => typeof entry === 'string')

/**
 * What the host asks of the registry: the catalogue, a registration, a
 * removal, and whether an id is the registry's to remove. Constructed by the
 * wiring, because only the wiring knows how a config becomes a runtime — the
 * tool server, the secret resolver and the logger all live there.
 */
export class AgentDirectory {
  constructor(
    private readonly options: {
      readonly store: AgentRegistryStore
      readonly build: (config: AcpAgentConfig) => AgentRuntime
      /** The usage sources this agent's CLI earns, if any. See `localUsageFor`. */
      readonly usageFor: (config: AcpAgentConfig) => AgentUsageBinding | null
      readonly which?: (command: string) => Promise<string | null>
      /** The public ACP registry; without one, its requests say so. */
      readonly registry?: Pick<AcpRegistry, 'catalog' | 'resolve' | 'uninstall'> &
        Partial<Pick<AcpRegistry, 'describe' | 'uninstallVersion'>>
      /**
       * Every copy of an agent on this machine, and which one answers. With
       * it, a template says which copy it found and a registry entry whose
       * agent is already installed is added without a download.
       */
      readonly installs?: InstallService
    },
  ) {}

  /** The config a stored entry stands for, or null when this build cannot serve it. */
  configOf(id: string): AcpAgentConfig | null {
    return this.options.store.configs().find((config) => config.id === id) ?? null
  }

  /**
   * The copy of a known agent that would answer on this machine, when the
   * install service is wired and the agent is one it knows. Null otherwise
   * — which the callers treat as "look on PATH the old way".
   */
  async #installedCopy(knownId: string): Promise<JudgedInstall | null> {
    const installs = this.options.installs
    const known = knownAgent(knownId)
    if (!installs || !known) return null
    return installs.installedCopyOf(known)
  }

  /** The public ACP registry, judged against this machine and this store. */
  async registryCatalog(live: ReadonlySet<string>): Promise<AcpRegistryCatalogInfo> {
    const registry = this.options.registry
    if (!registry) {
      return { agents: [], fetchedAt: null, unavailable: 'This host reads no ACP registry.' }
    }
    const catalog = await registry.catalog((id) => live.has(id) || this.options.store.has(id))
    if (!this.options.installs) return catalog
    const agents = await Promise.all(
      catalog.agents.map(async (agent) => {
        const copy = await this.#installedCopy(agent.id)
        return copy
          ? {
              ...agent,
              // An entry the machine already has is addable even where the
              // registry's own channel is blocked: the copy is the channel.
              available: true,
              installed: { path: copy.path, version: copy.version, channelLabel: channelLabel(copy.channel) },
            }
          : agent
      }),
    )
    return { ...catalog, agents }
  }

  /** The catalogue, computed against what is on this machine right now. */
  async templates(live: ReadonlySet<string>): Promise<readonly AgentTemplateInfo[]> {
    const which = this.options.which ?? whichOnPath
    return Promise.all(
      TEMPLATES.map(async (template): Promise<AgentTemplateInfo> => {
        const registered = live.has(template.key) || this.options.store.has(template.key)
        const bridgeMissing = template.bridge !== undefined && bridgeEntryOf(template) === null
        // The newest copy on the machine, through the install service when
        // it knows this agent; a plain PATH lookup otherwise.
        const copy = template.requires ? await this.#installedCopy(template.key) : null
        const cliPath = copy?.path ?? (template.requires ? await which(template.requires.command) : null)
        const cliMissing =
          template.requires !== undefined && template.requires.cliRequired && cliPath === null
        const reason = bridgeMissing
          ? `This build of HarnessDesk does not carry the ${template.name} bridge.`
          : cliMissing
            ? `${template.requires?.command} is not installed on this machine.`
            : undefined
        return {
          key: template.key,
          name: template.name,
          ...(template.brand ? { brand: template.brand } : {}),
          ...(template.tagline ? { tagline: template.tagline } : {}),
          available: !bridgeMissing && !cliMissing,
          ...(reason ? { reason } : {}),
          registered,
          ...(template.requires
            ? {
                requires: {
                  command: template.requires.command,
                  found: cliPath !== null,
                  ...(template.requires.installCommand
                    ? { installCommand: template.requires.installCommand }
                    : {}),
                  ...(copy
                    ? { version: copy.version, path: copy.path, channelLabel: channelLabel(copy.channel) }
                    : {}),
                },
              }
            : {}),
        }
      }),
    )
  }

  /**
   * Registers one agent: writes the entry, then builds the runtime for the
   * host to own. The write happens first so that a crash between the two
   * leaves an entry the next start will pick up, never a running agent that
   * vanishes on restart.
   */
  async register(
    request: AgentRegisterRequest,
    live: ReadonlySet<string>,
  ): Promise<{ readonly runtime: AgentRuntime; readonly usage: AgentUsageBinding | null }> {
    const { entry, config } = await this.#resolve(request)
    if (live.has(config.id)) {
      throw new Error(`An agent with the id ${JSON.stringify(config.id)} is already running.`)
    }
    this.options.store.add(entry)
    return { runtime: this.options.build(config), usage: this.options.usageFor(config) }
  }

  async #resolve(request: AgentRegisterRequest): Promise<{
    entry: Record<string, unknown> & { readonly id: string }
    config: AcpAgentConfig
  }> {
    if (request.registry) {
      const registry = this.options.registry
      if (!registry) throw new Error('This host reads no ACP registry.')
      // A copy already on the machine is preferred to anything the registry
      // would fetch: the row points at it, the download is deferred, and
      // `agents/update` is the door to the registry's own build later. Only
      // agents whose CLI speaks ACP itself qualify — an adapter entry still
      // needs its adapter, which the registry provides.
      const known = knownAgent(request.registry.id)
      const copy = known && !known.acp.bridge ? await this.#installedCopy(known.id) : null
      if (known && copy) {
        const described = registry.describe ? await registry.describe(request.registry.id) : null
        const entry = {
          id: known.id,
          name: known.name,
          ...(known.brand ? { brand: known.brand } : {}),
          tagline: known.tagline,
          command: copy.path,
          ...(known.acp.args.length > 0 ? { args: [...known.acp.args] } : {}),
          ...(known.acp.env ? { env: { ...known.acp.env } } : {}),
          agent: known.id,
          registry: {
            id: request.registry.id,
            version: described?.version ?? 'unknown',
            // Nothing was downloaded; the registry's build is one update away.
            deferred: true,
          },
        }
        return { entry, config: entry as AcpAgentConfig }
      }
      // Resolving may download: a binary entry is fetched and unpacked here,
      // before anything is written, so a failed download leaves no row.
      return registry.resolve(request.registry.id)
    }
    if (request.template) {
      const template = templateByKey(request.template)
      if (!template) {
        throw new Error(`There is no agent template named ${JSON.stringify(request.template)}.`)
      }
      const config = expandTemplate(template, { id: template.key })
      if (!config) {
        throw new Error(`This build of HarnessDesk does not carry the ${template.name} bridge.`)
      }
      return { entry: { id: template.key, template: template.key }, config }
    }
    const custom = request.custom
    if (!custom) throw new Error('Name a template or a command to register.')
    const name = custom.name.trim()
    const command = custom.command.trim()
    if (!name) throw new Error('The agent needs a name.')
    if (!command) throw new Error('The agent needs a command to run.')
    const id = custom.id ?? slugOf(name)
    if (!ID_SHAPE.test(id)) {
      throw new Error(`A usable id could not be made from ${JSON.stringify(name)}; provide one.`)
    }
    const entry = {
      id,
      name,
      command,
      ...(custom.args && custom.args.length > 0 ? { args: [...custom.args] } : {}),
      ...(custom.env && Object.keys(custom.env).length > 0 ? { env: { ...custom.env } } : {}),
    }
    return { entry, config: entry as AcpAgentConfig }
  }

  owns(id: RuntimeId | string): boolean {
    return this.options.store.has(String(id))
  }

  /** Deletes one version of a download the desk made; nothing else. */
  discardVersion(id: RuntimeId | string, version: string): void {
    const provenance = this.options.store.entry(String(id))?.['registry'] as { id?: unknown } | undefined
    if (typeof provenance?.id !== 'string') return
    try {
      this.options.registry?.uninstallVersion?.(provenance.id, version)
    } catch {
      // A folder that would not go is disk, not correctness.
    }
  }

  /**
   * Replaces the row's fallback with the registry's current build of the
   * same agent — the update story a download the desk made has been owed
   * since it was first recorded with its version. Only rows with registry
   * provenance qualify; anything else is the person's package manager's
   * to update, and the caller says so. Returns the version replaced, so the
   * old download can be deleted once the new one has answered.
   */
  async updateManaged(id: RuntimeId | string): Promise<{ readonly from: string; readonly to: string }> {
    const registry = this.options.registry
    if (!registry) throw new Error('This host reads no ACP registry.')
    const row = this.options.store.entry(String(id))
    const provenance = row?.['registry'] as { id?: unknown; version?: unknown } | undefined
    if (!row || typeof provenance?.id !== 'string') {
      throw new Error('This agent was not installed by HarnessDesk, so its package manager updates it.')
    }
    const from = typeof provenance.version === 'string' ? provenance.version : 'unknown'
    const { entry } = await registry.resolve(provenance.id)
    const to = (entry['registry'] as { version: string }).version
    // The freshly resolved launch replaces the fallback; the person's own
    // fields (a pin, a brand, a name) stay as they were.
    this.options.store.patch(String(id), {
      command: entry['command'],
      args: entry['args'],
      env: entry['env'],
      cwd: entry['cwd'],
      registry: entry['registry'],
      agent: row['agent'] ?? provenance.id,
    })
    return { from, to }
  }

  async remove(id: RuntimeId | string): Promise<void> {
    const key = String(id)
    const entry = this.options.store.entries().find((candidate) => candidate['id'] === key)
    this.options.store.remove(key)
    // A row the ACP registry installed brought a downloaded build with it —
    // sometimes hundreds of megabytes — and the row's provenance is the only
    // thing that knows. Removal is the one moment that can clean it up;
    // entries without provenance (templates, custom commands) own no
    // download and are left entirely alone.
    const provenance = entry?.['registry']
    if (
      typeof provenance === 'object' &&
      provenance !== null &&
      typeof (provenance as Record<string, unknown>)['id'] === 'string'
    ) {
      try {
        this.options.registry?.uninstall((provenance as Record<string, unknown>)['id'] as string)
      } catch {
        // The row is gone either way; a stuck folder is not worth failing for.
      }
    }
  }

  /** The stored entries as they are on disk, for the backup file. */
  entries(): readonly Readonly<Record<string, unknown>>[] {
    return this.options.store.entries()
  }

  /**
   * Takes one entry from a backup: persists it, and builds the runtime when
   * this build can serve it. An entry this build cannot expand — a template
   * from a newer HarnessDesk, say — is still restored to the file; the next
   * build that carries the bridge will pick it up, which is the same promise
   * a hand-written entry gets.
   */
  adopt(
    entry: Readonly<Record<string, unknown>>,
  ): { readonly runtime: AgentRuntime; readonly usage: AgentUsageBinding | null } | null {
    const id = entry['id']
    if (typeof id !== 'string') throw new Error('A backup agent entry has no id.')
    this.options.store.add({ ...entry, id })
    const config = this.options.store.configs().find((candidate) => candidate.id === id)
    if (!config) return null
    return { runtime: this.options.build(config), usage: this.options.usageFor(config) }
  }
}

export interface AgentUsageBinding {
  readonly meter?: import('./usage/meter.js').UsageMeter
  readonly corpus?: 'codex' | 'claude'
}
