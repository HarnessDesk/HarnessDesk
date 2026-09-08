import { realpathSync } from 'node:fs'
import {
  CodexAppServer,
  CodexError,
  CodexRpcError,
  discoverCodex,
  type CodexAppServerOptions,
  type CodexInstallation,
  type CodexLogger,
  type CodexProtocol,
  type ConnectionState,
  type ServerRequestResponder,
} from '@harnessdesk/codex'
import {
  sessionId as makeSessionId,
  type AccountStatus,
  findOption,
  NO_CAPABILITIES,
  refuseOptionValue,
  SessionBusyError,
  type CapabilityRegistry,
  type AgentEvent,
  type AgentRuntime,
  type CatalogRefresh,
  type SkillProblem,
  type AgentSession,
  type ConfigOption,
  type HookInfo,
  type ListSessionsQuery,
  type LoginStart,
  type ModelInfo,
  type OptionValue,
  type Page,
  type RateLimits,
  type RuntimeHealth,
  type RuntimeId,
  type RuntimeInfo,
  type InstallationCheck,
  type Session,
  type SessionId,
  type SessionOptions,
  type SessionSummary,
  type SkillInfo,
  type Unsubscribe,
} from '@harnessdesk/protocol'

import { contextPreamble, ToolProjection, toCodexToolResponse } from './capabilities.js'
import { CodexCatalog, catalogWarningIn } from './catalog.js'
import { CodexFiles } from './files.js'
import { CodexExtensions } from './extensions.js'
import { iconDataUri } from './icon-uri.js'
import { CodexProcesses } from './processes.js'
import { CodexTasks } from './tasks.js'
import { loginParamsFor, mapAccount, mapLoginStart, signInMethods } from './mapping/account.js'
import { mapThrown } from './mapping/errors.js'
import { mapNotification, mapRateLimits } from './mapping/notifications.js'
import {
  effortLabel,
  featureNameOf,
  overlayDraftValues,
  runtimeOptions,
  sessionOptions,
  settingsFromState,
  splitStartOptions,
  noteUnservedModel,
  stateFromConfig,
  stateFromStartResponse,
  type Catalog,
  type StartOptionParams,
  type ThreadState,
} from './mapping/options.js'
import { CODEX_RUNTIME_ID, mapSession, mapSummary } from './mapping/session.js'
import { salvageSession } from './salvage.js'
import { CodexSession } from './session.js'
import { ApprovalRouter } from './approvals.js'
import { holderOf, isBusyRefusal, sessionStoreOf } from './writer-lock.js'

/**
 * `AgentRuntime` over `codex app-server`.
 *
 * Owns exactly one app-server process and every live session on it. Codex keeps
 * its own thread store in `~/.codex`, so this class deliberately does not shadow
 * history — it reads through.
 */

export interface CodexRuntimeOptions {
  /**
   * What to register this instance as. Defaults to `codex`, which is the
   * user's own `~/.codex`. A second account of the same Codex is a second
   * instance over a credential home of its own, and it needs an id of its own
   * to be a separate row everywhere the interface lists agents.
   */
  readonly id?: RuntimeId
  /** Overrides the name shown for this instance; accounts want their own. */
  readonly name?: string
  /**
   * Set when this instance's `codexHome` shares its session store with another
   * — see the account slots in the server package, which mirror the agent's
   * real home in symlinks and keep only the credential apart. The threads are
   * then literally the same files, so this instance stops offering to list
   * them: one shared history listed once is the truth, and listing it per
   * account would show every Codex thread as many times as there are accounts.
   */
  readonly sharesHistory?: boolean
  readonly clientName?: string
  readonly clientVersion?: string
  readonly binaryPath?: string | null
  readonly codexHome?: string | null
  readonly configOverrides?: readonly string[]
  readonly logger?: CodexLogger
  /** Extra environment for the Codex process. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Plugin contributions to project into Codex. Optional: the runtime works
   * unchanged without an extension kernel, which is what keeps the two planes
   * independent.
   */
  readonly capabilities?: CapabilityRegistry
}

/**
 * Notifications we never map, suppressed at the source so the process does not
 * spend time serialising traffic we would discard.
 */
const OPT_OUT_NOTIFICATIONS = [
  'thread/realtime/outputAudio/delta',
  'thread/realtime/transcript/delta',
  'rawResponseItem/completed',
]

const CAPABILITIES = {
  resume: true,
  fork: true,
  steer: true,
  interrupt: true,
  listHistory: true,
  searchHistory: true,
  imageInput: true,
  mcp: true,
  skills: true,
  plans: true,
  reasoning: true,
  metered: true,
  account: true,
  goals: true,
  undo: true,
  compaction: true,
  memory: true,
  review: true,
  archiveHistory: true,
  nameHistory: true,
  deleteHistory: true,
  extensionStore: true,
  hooks: true,
  pluginTools: true,
  backgroundTasks: true,
} as const

/**
 * How the interface should talk about Codex.
 *
 * Everything a shell would otherwise hard-code — the sign-in command, where
 * history comes from, what skills are called — lives here, so the same shell
 * describes a different runtime accurately without knowing anything about it.
 */
const PRESENTATION = {
  name: 'Codex',
  brand: 'codex',
  tagline: "OpenAI's coding agent, running locally through the Codex CLI.",
  historySource: 'the Codex CLI or the VS Code extension',
  signIn: { command: 'codex login' },
  signOut: { command: 'codex logout' },
  configLocation: '~/.codex',
  skillsLabel: 'Skills',
  install: {
    command: 'brew install codex',
    url: 'https://github.com/openai/codex',
    package: '@openai/codex',
  },
} as const

/**
 * The install command that matches how *this* Codex got here, so the update
 * advisory names the package manager that can actually replace it: an npm
 * global install lives under `node_modules/@openai/codex`, anything else is
 * assumed to be Homebrew's. Unknown stays the documented default.
 */
export const installCommandFor = (path: string | null | undefined): string => {
  if (!path) return 'brew install codex'
  let real = path
  try {
    real = realpathSync(path) // `/opt/homebrew/bin/codex` is npm's symlink as often as brew's binary
  } catch {
    // A path that no longer resolves is judged by its spelling.
  }
  return /node_modules\/@openai\/codex\//.test(real) ? 'npm i -g @openai/codex' : 'brew install codex'
}

export class CodexRuntime implements AgentRuntime {
  readonly #server: CodexAppServer
  readonly #binaryPath: string | null
  readonly #logger: CodexLogger | undefined
  readonly #approvals: ApprovalRouter
  readonly #catalog: CodexCatalog
  /** Codex's filesystem view; see `RuntimeFiles` for what it is and is not. */
  readonly files: CodexFiles
  /** Sandboxed processes over `command/exec`; see `RuntimeProcesses`. */
  readonly processes: CodexProcesses
  /** Codex's marketplaces, apps and MCP servers; see `RuntimeExtensions`. */
  readonly extensions: CodexExtensions
  /** The shell sessions a thread has left running; see `RuntimeTasks`. */
  readonly tasks: CodexTasks
  readonly #sessions = new Map<string, CodexSession>()
  readonly #eventListeners = new Set<(event: AgentEvent) => void>()
  readonly #healthListeners = new Set<(health: RuntimeHealth) => void>()
  #version: string | null = null
  #disposeServer: Unsubscribe[] = []

  readonly #capabilities: CapabilityRegistry | null
  readonly #id: RuntimeId
  readonly #name: string
  readonly #sharesHistory: boolean
  /** Where this instance's Codex keeps its rollouts, for `salvageSession`. */
  readonly #codexHome: string | null
  /** Resolved once and refreshed on start; see `AgentRuntime.sessionStore`. */
  #sessionStore: string

  constructor(options: CodexRuntimeOptions = {}) {
    this.#id = options.id ?? CODEX_RUNTIME_ID
    this.#name = options.name ?? 'Codex'
    this.#sharesHistory = options.sharesHistory ?? false
    this.#codexHome = options.codexHome ?? null
    this.#sessionStore = sessionStoreOf(this.#codexHome)
    this.#binaryPath = options.binaryPath ?? null
    this.#logger = options.logger
    this.#capabilities = options.capabilities ?? null
    const serverOptions: CodexAppServerOptions = {
      clientInfo: {
        name: options.clientName ?? 'harnessdesk',
        title: 'HarnessDesk',
        version: options.clientVersion ?? '0.1.0',
      },
      binaryPath: options.binaryPath ?? null,
      codexHome: options.codexHome ?? null,
      configOverrides: options.configOverrides ?? [],
      experimentalApi: true,
      optOutNotifications: OPT_OUT_NOTIFICATIONS,
      ...(options.env ? { env: options.env } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    }
    this.#server = new CodexAppServer(serverOptions)
    this.#catalog = new CodexCatalog(this.#server)
    this.files = new CodexFiles(this.#server)
    this.processes = new CodexProcesses(this.#server, (session) =>
      this.#sessions.get(session)?.permissionProfile(),
    )
    this.extensions = new CodexExtensions(this.#server)
    this.tasks = new CodexTasks(this.#server, (sessionId, tasks) =>
      this.#emit({ type: 'session/tasks', sessionId, tasks }),
    )
    this.#approvals = new ApprovalRouter((event) => this.#emit(event))

    this.#disposeServer.push(
      this.#server.onNotification((notification) => {
        this.#track(notification)
        for (const event of mapNotification(notification, this.#id)) this.#emit(event)
      }),
      this.#server.onServerRequest((request, responder) =>
        this.#onServerRequest(request, responder),
      ),
      this.#server.onStateChange((state) => this.#onStateChange(state)),
      // The one stderr line worth keeping: why the model list is the fallback.
      this.#server.onLog((line) => {
        const warning = catalogWarningIn(line)
        if (warning) this.#catalog.noteWarning(warning)
      }),
    )
  }

  get info(): RuntimeInfo {
    return {
      id: this.#id,
      name: this.#name,
      version: this.#version,
      // Observations, not defaults: a Codex that has never come up has shown
      // it can do nothing, and claiming the full table for it is how a
      // machine without the binary came to advertise `interrupt` and
      // `pluginTools`. Once the app-server has answered, the claims are about
      // the software and survive its restarts.
      capabilities: !this.#everStarted
        ? NO_CAPABILITIES
        : this.#sharesHistory
          ? { ...CAPABILITIES, listHistory: false, searchHistory: false }
          : CAPABILITIES,
      presentation: {
        ...PRESENTATION,
        install: {
          ...PRESENTATION.install,
          command: installCommandFor(this.#server.installation?.path),
        },
      },
      // Codex ≥0.135.0 refuses `wire_api = "chat"` outright (probed; see
      // script/probe/README.md), so Responses is the whole truth here.
      supportedWireProtocols: ['responses'],
    }
  }

  /**
   * `AgentRuntime.sessionStore`: the threads this instance can see and write.
   *
   * Every account of one Codex answers with the same string, because a slot's
   * home is the agent's home in symlinks — which is exactly the condition
   * under which one account can be holding a conversation another is listing.
   */
  get sessionStore(): string {
    return this.#sessionStore
  }

  async start(): Promise<void> {
    await this.#spawnServer()
    // The links a slot's home is made of are relaid on every start, and a home
    // that had never held a thread now has a `sessions` directory to resolve.
    this.#sessionStore = sessionStoreOf(this.#codexHome)
    this.#version = this.#server.installation?.version ?? null
    if (!this.#everStarted) {
      this.#everStarted = true
      // The capability table just went from nothing to everything; a window
      // drawn before the server answered is holding the nothing.
      for (const listener of this.#infoListeners) listener()
    }
  }

  /**
   * Set by `dispose()` before its first `await`, and never cleared, so a
   * start already parked on an await of its own reads it as soon as it wakes.
   * See `#spawnServer`.
   */
  #disposed = false

  /**
   * The only place an app-server is born, and the last gate before it is.
   *
   * The same door `AcpRuntime` closes, in the same words, because Codex has
   * the same two callers: a start, and `checkInstallation` moving onto a
   * build that appeared on disk. That second one asks the machine what is
   * installed first, and a quit arriving during that question finds a runtime
   * with nothing in flight — its stop returns at once — while the answer,
   * when it comes, starts an app-server and every MCP server Codex launches
   * behind it with nobody left to end them.
   *
   * The check is welded to the spawn for the reason spelled out on
   * `AcpRuntime.#spawnBridge`: a guard placed by hand a few lines above the
   * spawn is sized for the awaits that are there today.
   */
  async #spawnServer(): Promise<void> {
    if (this.#disposed) throw new Error(`${this.#name} has been shut down.`)
    await this.#server.start()
  }

  /** Whether the app-server has ever answered — what makes `CAPABILITIES` a claim with evidence. */
  #everStarted = false
  readonly #infoListeners = new Set<() => void>()

  onInfoChange(listener: () => void): Unsubscribe {
    this.#infoListeners.add(listener)
    return () => this.#infoListeners.delete(listener)
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const unsubscribe of this.#disposeServer) unsubscribe()
    this.#disposeServer = []
    this.#approvals.abandonAll('The Codex runtime is shutting down.')
    this.#sessions.clear()
    this.tasks.dispose()
    await this.#server.stop()
  }

  health(): RuntimeHealth {
    const state = this.#server.state
    switch (state.type) {
      case 'ready':
        return { state: 'ready' }
      case 'starting':
      case 'restarting':
        return { state: 'starting' }
      case 'stopped':
        return {
          state: 'unavailable',
          reason: 'unknown',
          message: 'The Codex runtime is not running.',
          remediation: 'Start HarnessDesk again, or check the diagnostics log.',
        }
      case 'failed':
        return healthFromError(state.error)
    }
  }

  onHealthChange(listener: (health: RuntimeHealth) => void): Unsubscribe {
    this.#healthListeners.add(listener)
    return () => this.#healthListeners.delete(listener)
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  // ------------------------------------------------------------- capabilities

  async listModels(): Promise<readonly ModelInfo[]> {
    const models = await this.#catalog.models()
    return models
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.id,
        displayName: model.displayName,
        description: model.description,
        reasoningLevels: model.supportedReasoningEfforts.map((option) => ({
          id: option.reasoningEffort,
          label: effortLabel(option.reasoningEffort),
        })),
        supportsImages: model.inputModalities.includes('image'),
        isDefault: model.isDefault,
      }))
  }

  /** Experimental features, as runtime-wide toggles. */
  async listOptions(): Promise<readonly ConfigOption[]> {
    return runtimeOptions(await this.#listFeatures())
  }

  /**
   * Flips a feature. Codex can change only some features while running —
   * the rest need its configuration file — and says which in the error, so
   * that message is passed through rather than paraphrased.
   */
  async setOption(id: string, value: OptionValue): Promise<void> {
    const options = await this.listOptions()
    const option = findOption(options, id)
    const feature = featureNameOf(id)
    if (!option || !feature) throw new Error(`Codex has no runtime option named ${JSON.stringify(id)}.`)
    const refusal = refuseOptionValue(option, value)
    if (refusal) throw new Error(refusal)
    const response: CodexProtocol.v2.ExperimentalFeatureEnablementSetResponse = await this.#server.request(
      'experimentalFeature/enablement/set',
      { enablement: { [feature]: value as boolean } },
    )
    // The response lists what was actually changed. Codex 0.153.0 answers a
    // key it will not flip at runtime with an empty map and no error — the
    // toggle snapped back with nothing said until this read the answer.
    if (response.enablement[feature] !== value) {
      throw new Error(
        `Codex will not change ${feature} while running. Set features.${feature} in ~/.codex/config.toml and restart Codex.`,
      )
    }
    this.#emit({ type: 'runtime/options', runtime: this.#id, options: await this.listOptions() })
  }

  /**
   * The options a new thread would start with, read from the effective
   * configuration rather than a live thread. `config/read` resolves project
   * layers when given a cwd, so a repo that pins its own model shows that
   * model here — the same answer `thread/start` would give.
   */
  async defaultSessionOptions(
    cwd?: string,
    values?: Readonly<Record<string, OptionValue>>,
  ): Promise<readonly ConfigOption[]> {
    const where = cwd ?? process.cwd()
    const [{ config }, catalog] = await Promise.all([
      this.#server.request('config/read', { cwd: where }),
      this.#catalog.load(where),
    ])
    let state = stateFromConfig(config, catalog, where)
    if (values) state = overlayDraftValues(state, values, catalog)
    return noteUnservedModel(sessionOptions(state, catalog), config.model, catalog)
  }

  async #listFeatures(): Promise<CodexProtocol.v2.ExperimentalFeature[]> {
    const features: CodexProtocol.v2.ExperimentalFeature[] = []
    let cursor: string | null = null
    do {
      const page: CodexProtocol.v2.ExperimentalFeatureListResponse = await this.#server.request(
        'experimentalFeature/list',
        { cursor, limit: 200 },
      )
      features.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)
    return features
  }

  async getAccount(): Promise<AccountStatus> {
    const [response, forced] = await Promise.all([
      this.#server.request('account/read', {}),
      this.#forcedLoginMethod(),
    ])
    return { accounts: mapAccount(response.account), signInMethods: signInMethods(forced) }
  }

  /**
   * `forced_login_method` from the effective configuration, or null when it is
   * unset or unreadable. A config that cannot be read should not make the
   * account unreadable too; it only means no method is forbidden.
   */
  async #forcedLoginMethod(): Promise<CodexProtocol.ForcedLoginMethod | null> {
    try {
      const response = await this.#server.request('config/read', {})
      return response.config.forced_login_method ?? null
    } catch {
      return null
    }
  }

  /**
   * Starts a ChatGPT sign-in. Codex runs the OAuth callback server and the
   * device-code poll itself; what comes back is only what the interface must
   * show. Codex allows one login at a time and cancels the previous one when
   * another starts, which arrives as a failed `account/loginCompleted` for the
   * old id — the interface is expected to ignore ids it did not start.
   */
  async login(method: string): Promise<LoginStart> {
    const params = loginParamsFor(method)
    if (!params) {
      throw new Error(`Sign-in method ${JSON.stringify(method)} cannot be started from the interface.`)
    }
    const response = await this.#server.request('account/login/start', params)
    return mapLoginStart(response)
  }

  /**
   * Abandons a sign-in. Codex answers `notFound` for a login it has already
   * superseded and a JSON-RPC error for an id it never issued; both mean the
   * same thing to the caller — nothing is in flight under that id — so
   * neither is surfaced.
   */
  async cancelLogin(loginId: string): Promise<void> {
    try {
      await this.#server.request('account/login/cancel', { loginId })
    } catch (error) {
      if (error instanceof CodexRpcError && /invalid login id/i.test(error.message)) return
      throw error
    }
  }

  async logout(): Promise<void> {
    await this.#server.request('account/logout', undefined)
  }

  /**
   * Skills, flattened across the roots Codex scanned.
   *
   * Codex reports them per working directory; the UI wants one list, and a skill
   * available from two roots is still one skill.
   */
  async listSkills(cwd?: string): Promise<readonly SkillInfo[]> {
    try {
      const response = await this.#server.request('skills/list', cwd ? { cwds: [cwd] } : {})
      const seen = new Map<string, SkillInfo>()
      for (const entry of response.data) {
        for (const skill of entry.skills) {
          if (seen.has(skill.name)) continue
          seen.set(skill.name, {
            name: skill.name,
            description: skill.description ?? '',
            enabled: skill.enabled !== false,
            path: skill.path ?? null,
            // The scope word (`user`/`repo`/`system`/`admin`), not the cwd it
            // was scanned from — a list of 100 rows all "scoped" to the same
            // folder said nothing.
            scope: skill.scope,
            ...(skill.interface?.displayName ? { displayName: skill.interface.displayName } : {}),
            shortDescription: skill.shortDescription ?? skill.interface?.shortDescription ?? null,
            // The installed skill's own icon file, inlined. `iconSmallUrl` is
            // remote and the renderer's CSP forbids remote images, so it is
            // not read — see the note in `extensions.ts`.
            iconUrl: iconDataUri(skill.interface?.iconSmall),
            brandColor: skill.interface?.brandColor ?? null,
          })
        }
      }
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
      // Not swallowed into an empty list: "none" is Codex's answer to give,
      // and this reply is treated as the agent's own report — the library's
      // reach column lets it outrank the disk, so a broken server returning
      // [] here would paint every skill on disk as unreachable for Codex.
      // Callers that only render skills already treat a throw as "no list".
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * `AgentRuntime.listSkillProblems`: the definitions Codex read and refused.
   *
   * `skills/list` answers with an `errors` array beside the skills — one
   * entry per file, naming the file and the reason. This adapter used to
   * drop it, and dropping it is what left the library unable to tell a
   * definition an agent will never load from one it has not re-read yet.
   *
   * Never throws: a problem list is an extra, and a caller that cannot get
   * one is exactly as informed as it was before the method existed. The
   * *skills* list is the one whose silence would be a lie, and it still
   * throws for that reason.
   */
  async listSkillProblems(cwd?: string): Promise<readonly SkillProblem[]> {
    try {
      const response = await this.#server.request('skills/list', cwd ? { cwds: [cwd] } : {})
      const seen = new Map<string, SkillProblem>()
      for (const entry of response.data) {
        for (const problem of entry.errors ?? []) {
          if (!problem.path || seen.has(problem.path)) continue
          seen.set(problem.path, { path: problem.path, message: problem.message })
        }
      }
      return [...seen.values()]
    } catch {
      return []
    }
  }

  /** Enables or disables a skill; Codex writes it into config and re-scans. */
  async setSkillEnabled(
    skill: { readonly path?: string | null; readonly name: string },
    enabled: boolean,
  ): Promise<void> {
    await this.#server.request('skills/config/write', {
      ...(skill.path ? { path: skill.path } : { name: skill.name }),
      enabled,
    })
  }

  /** Configured hooks with their trust state, flattened across the scanned roots. */
  async listHooks(cwd?: string): Promise<readonly HookInfo[]> {
    try {
      const response = await this.#server.request('hooks/list', cwd ? { cwds: [cwd] } : {})
      const seen = new Map<string, HookInfo>()
      for (const entry of response.data) {
        for (const hook of entry.hooks) {
          if (seen.has(hook.key)) continue
          seen.set(hook.key, {
            id: hook.key,
            event: hook.eventName,
            source: hook.source,
            trust: hook.trustStatus,
            enabled: hook.enabled,
            managed: hook.isManaged,
          })
        }
      }
      return [...seen.values()]
    } catch {
      return []
    }
  }

  async getRateLimits(): Promise<RateLimits | null> {
    try {
      const response = await this.#server.request('account/rateLimits/read', undefined)
      const snapshot = (response as unknown as { rateLimits?: CodexProtocol.v2.RateLimitSnapshot })
        .rateLimits
      return snapshot ? mapRateLimits(snapshot) : null
    } catch {
      // Rate limits are advisory; a provider that does not meter should not
      // make the whole settings pane fail to load.
      return null
    }
  }

  // ------------------------------------------------------------------ history

  /**
   * The stored threads, with the ones open here laid over them.
   *
   * Codex lists a thread once it has something stored about it, which is not
   * true of a thread that is *working* on its first turn: `thread/start`
   * writes nothing, so a conversation someone is watching run was missing
   * from the list — no row, no place in the "Working" band — until its turn
   * ended. A live session knows its own name, its opening ask and whether a
   * turn is running, so it answers for itself and the stored row (once there
   * is one) is the fallback rather than the only source.
   *
   * Only on the first page: later pages are Codex's alone, or a live row
   * would repeat itself down the list.
   */
  async listSessions(query: ListSessionsQuery = {}): Promise<Page<SessionSummary>> {
    const onlyArchived = query.archived === 'only'
    const response = await this.#server.request('thread/list', {
      cursor: query.cursor ?? null,
      limit: query.pageSize ?? 40,
      // Codex reads this as a side, not as an inclusion: true returns the
      // archived threads and nothing else, which is what `only` means.
      archived: onlyArchived,
    })
    const stored = response.data.map((thread) => mapSummary(thread, this.#id))
    const live =
      query.cursor
        ? []
        : [...this.#sessions.values()]
            .map((session) => session.summary())
            // A thread open here belongs on whichever side it was archived
            // to, the same as a stored one: out of the ordinary list once it
            // is archived, and into the archive's.
            .filter((summary) => this.#archived.has(summary.id) === onlyArchived)
    let data = [
      ...live,
      ...stored.filter((row) => !live.some((summary) => summary.id === row.id)),
    ]
    if (query.cwd) data = data.filter((summary) => summary.cwd === query.cwd)
    return { data: data.sort((a, b) => b.updatedAt - a.updatedAt), nextCursor: response.nextCursor }
  }

  async searchSessions(query: string): Promise<Page<SessionSummary>> {
    const response = await this.#server.request('thread/search', { searchTerm: query })
    return {
      data: response.data.map((result) => mapSummary(result.thread, this.#id)),
      nextCursor: response.nextCursor,
    }
  }

  /**
   * Reads a full transcript without making the session live.
   *
   * `thread/read` returns turns but may leave their items unloaded, so any turn
   * that comes back short is paged through explicitly. Real threads reach
   * several hundred items, well past one page.
   */
  async readSession(id: SessionId): Promise<Session> {
    let thread: CodexProtocol.v2.Thread
    try {
      const response = await this.#server.request('thread/read', {
        threadId: id,
        includeTurns: true,
      })
      thread = response.thread
    } catch (error) {
      // Codex refuses a whole thread over one item it cannot deserialize — a
      // rollout saved by a newer build. The file itself still reads line by
      // line; a recovered transcript beats an unopenable conversation.
      const recovered = await salvageSession(this.#codexHome, this.#id, id)
      if (recovered) {
        this.#logger?.warn?.(`codex thread/read failed for ${id}; salvaged from the rollout`, {
          error: error instanceof Error ? error.message : String(error),
        })
        return recovered
      }
      throw error
    }
    const turns: CodexProtocol.v2.Turn[] = []
    for (const turn of thread.turns) {
      if (turn.itemsView === 'full') {
        turns.push(turn)
        continue
      }
      turns.push({ ...turn, items: await this.#loadTurnItems(id, turn.id), itemsView: 'full' })
    }
    return mapSession(
      { ...thread, turns },
      {
        runtime: this.#id,
        itemsLoaded: true,
        // Codex answers `thread/read` with no token figures whatsoever, so the
        // last ones it reported are carried across from the live session — the
        // read path `AcpSession` already has. A thread this process never
        // opened has none, and the ring stays off until its next turn.
        usage: this.#sessions.get(id)?.usage ?? null,
      },
    )
  }

  async #loadTurnItems(
    id: SessionId,
    turn: string,
  ): Promise<CodexProtocol.v2.ThreadItem[]> {
    const items: CodexProtocol.v2.ThreadItem[] = []
    let cursor: string | null = null
    do {
      const page: CodexProtocol.v2.ThreadItemsListResponse = await this.#server.request(
        'thread/items/list',
        { threadId: id, turnId: turn, cursor, limit: 200 },
      )
      // 0.149.0 pages entries rather than bare items, each tagged with the turn
      // it belongs to; the request is already scoped to one turn.
      items.push(...page.data.map((entry) => entry.item))
      cursor = page.nextCursor
    } while (cursor)
    return items
  }

  async archiveSession(id: SessionId, archived: boolean): Promise<void> {
    if (archived) await this.#server.request('thread/archive', { threadId: id })
    else await this.#server.request('thread/unarchive', { threadId: id })
    // A thread archived while it is still open here would otherwise keep the
    // row `listSessions` lays over Codex's page: Codex stops listing it, and
    // the live overlay would put it straight back.
    if (archived) this.#archived.add(id)
    else this.#archived.delete(id)
  }

  async deleteSession(id: SessionId): Promise<void> {
    await this.#server.request('thread/delete', { threadId: id })
    this.#archived.delete(id)
  }

  /** Threads archived while open here, so the overlay below leaves them out. */
  readonly #archived = new Set<string>()

  // ------------------------------------------------------------ live sessions

  async createSession(options: SessionOptions): Promise<AgentSession> {
    const projection = new ToolProjection()
    const dynamicTools = this.#projectTools(projection, { workspaceRoot: options.cwd })
    const { start, after } = startParamsFor(options)
    const response = await this.#server.request('thread/start', {
      cwd: options.cwd,
      ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      ...(options.workspaceRoots ? { runtimeWorkspaceRoots: [...options.workspaceRoots] } : {}),
      ...(options.ephemeral ? { ephemeral: true } : {}),
      ...start,
    })
    const session = await this.#register(response.thread, stateFromStartResponse(response), projection, true)
    return this.#applyAfterStart(session, after)
  }

  async resumeSession(id: SessionId, options: Partial<SessionOptions> = {}): Promise<AgentSession> {
    const existing = this.#sessions.get(id)
    if (existing) return existing
    const { start, after } = startParamsFor(options)
    let response: CodexProtocol.v2.ThreadResumeResponse
    try {
      response = await this.#server.request('thread/resume', {
        threadId: id,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...start,
        excludeTurns: true,
      })
    } catch (error) {
      throw (await this.#busyOr(error, id)) ?? error
    }
    // `dynamicTools` is only accepted on thread/start, so a resumed thread keeps
    // whatever tool set it was created with. The session reports that as stale
    // rather than pretending newly loaded plugins are available.
    const session = await this.#register(response.thread, stateFromStartResponse(response), new ToolProjection())
    return this.#applyAfterStart(session, after)
  }

  /**
   * Codex's "already has an active writer", turned into something a person can
   * act on — or `null` when the refusal was about something else.
   *
   * Only one process may write a thread, and every Codex on the machine shares
   * one home, so the holder is as likely to be the desktop app or a terminal
   * as it is to be another account here. The host names the accounts it runs
   * itself; this names anything else it can find. See `writer-lock.ts`.
   */
  async #busyOr(error: unknown, id: SessionId): Promise<SessionBusyError | null> {
    if (!isBusyRefusal(error)) return null
    const holder = await holderOf(this.#codexHome, id)
    this.#logger?.info?.('codex refused a thread another writer holds', {
      runtime: this.#id,
      session: String(id),
      ...(holder ? { holder } : {}),
    })
    return new SessionBusyError(
      `This conversation is open in ${holder ?? `another ${this.#name}`}, which is the only one that can continue it.`,
      holder,
    )
  }

  async forkSession(id: SessionId, options: Partial<SessionOptions> = {}): Promise<AgentSession> {
    const { start, after } = startParamsFor(options)
    const response = await this.#server.request('thread/fork', {
      threadId: id,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...start,
    })
    const session = await this.#register(response.thread, stateFromStartResponse(response), new ToolProjection())
    return this.#applyAfterStart(session, after)
  }

  /**
   * Options the thread verbs cannot take directly are applied as settings
   * updates straight after. If one is refused the session is closed and the
   * error surfaces: a session that silently ignored part of what it was asked
   * for would be worse than none.
   */
  async #applyAfterStart(
    session: CodexSession,
    after: readonly (readonly [string, OptionValue])[],
  ): Promise<CodexSession> {
    try {
      for (const [id, value] of after) await session.setOption(id, value)
    } catch (error) {
      await session.close()
      throw error
    }
    return session
  }

  #projectTools(
    projection: ToolProjection,
    scope: { workspaceRoot?: string },
  ): CodexProtocol.v2.DynamicToolSpec[] {
    const registry = this.#capabilities
    if (!registry) return []
    return projection.build(registry, { ...scope, runtime: this.#id })
  }

  async #register(
    thread: CodexProtocol.v2.Thread,
    state: ThreadState,
    projection: ToolProjection,
    created = false,
  ): Promise<CodexSession> {
    const catalog = await this.#catalog.load(state.cwd)
    const session = new CodexSession({
      runtime: this.#id,
      server: this.#server,
      approvals: this.#approvals,
      thread,
      state,
      catalog,
      projection,
      created,
      ...(this.#capabilities ? { capabilities: this.#capabilities } : {}),
      onClosed: (id) => {
        this.#sessions.delete(id)
        this.tasks.forget(id)
      },
      emit: (event) => this.#emit(event),
    })
    this.#sessions.set(thread.id, session)
    this.#emit({
      type: 'session/started',
      session: mapSession(thread, {
        runtime: this.#id,
        settings: settingsFromState(state),
        options: session.options(),
        // A thread we just started has no history to load, so its transcript
        // is complete from the first item — which is what lets the host save
        // it. Marked unloaded, a conversation's first sitting was never
        // written down, and the commands in it are the ones `thread/read`
        // does not keep.
        itemsLoaded: created,
      }),
    })
    return session
  }

  /**
   * Signing in or out changes which models and profiles exist, so every live
   * session is handed the refetched catalogue and re-declares its options.
   */
  async #refreshCatalog(): Promise<void> {
    this.#catalog.invalidate()
    for (const session of this.#sessions.values()) {
      try {
        session.noteCatalog(await this.#catalog.load(session.settings().cwd))
      } catch {
        // A session whose catalogue cannot be reloaded keeps the old one; the
        // next change will try again.
      }
    }
    this.#emit({ type: 'catalog/changed', runtime: this.#id })
  }

  /** `AgentRuntime.refreshCatalog`: the same re-read a sign-in triggers, on request. */
  async refreshCatalog(): Promise<CatalogRefresh> {
    // A dead app-server cannot be re-asked anything, and saying so is the
    // difference between a button that did nothing and a button that
    // explained itself.
    if (this.#server.state.type !== 'ready') {
      return { refreshed: false, reason: 'The Codex app-server is not running.' }
    }
    await this.#refreshCatalog()
    return { refreshed: true }
  }

  /**
   * `AgentRuntime.checkInstallation`: runs discovery again and, when it lands
   * on a different build than the one running and no turn is in flight,
   * stops the app-server and starts it on the new one. Live sessions are
   * dropped as on any restart — Codex keeps the threads, and the host resumes
   * them — which is why a turn in flight makes this wait for the next call.
   */
  async checkInstallation(): Promise<InstallationCheck> {
    const running = this.#server.installation
    if (!running || this.#server.state.type !== 'ready') return { changed: false }
    let found: CodexInstallation | null
    try {
      found = await discoverCodex(this.#binaryPath)
    } catch {
      return { changed: false }
    }
    if (!found || (found.path === running.path && found.version === running.version)) {
      return { changed: false }
    }
    const report = { changed: true as const, from: running.version, to: found.version }
    if (this.#busy()) return { ...report, restarted: false }
    this.#logger?.info?.('codex changed on disk; restarting onto it', {
      from: running.version,
      to: found.version,
      path: found.path,
    })
    await this.#server.stop()
    // `stop` reports `stopped`, which the state hook treats as any other
    // exit: sessions, watches and the catalogue are dropped there.
    await this.#spawnServer()
    this.#emit({ type: 'catalog/changed', runtime: this.#id })
    return { ...report, restarted: true }
  }

  /** True while any live session has a turn in flight. */
  #busy(): boolean {
    for (const session of this.#sessions.values()) {
      if (session.activeTurnId !== null) return true
    }
    return false
  }

  /** The live session handle, if this runtime currently owns one. */
  session(id: SessionId): AgentSession | undefined {
    return this.#sessions.get(id)
  }

  // ------------------------------------------------------------------ private

  /**
   * Per-session bookkeeping that the pure notification mapper cannot do:
   * which turn is live (needed by steer and interrupt), and which diffs belong
   * to which file-change item (needed when an approval for it arrives later).
   */
  #track(notification: CodexProtocol.ServerNotification): void {
    switch (notification.method) {
      case 'thread/settings/updated':
        this.#sessions
          .get(notification.params.threadId)
          ?.noteSettings(notification.params.threadSettings)
        return
      case 'thread/name/updated':
        this.#sessions
          .get(notification.params.threadId)
          ?.noteName(notification.params.threadName ?? null)
        return
      case 'thread/tokenUsage/updated':
        // The mapper turns this into a `usage/updated` event, which is enough
        // for a pane that is already open and nothing at all for one re-opened
        // later: `thread/read` reports no tokens, so the session is the only
        // place the last figures can be found again.
        this.#sessions
          .get(notification.params.threadId)
          ?.noteUsage(notification.params.tokenUsage)
        return
      case 'account/updated':
        void this.#refreshCatalog()
        return
      case 'fs/changed':
        this.files.dispatch(notification.params)
        return
      case 'command/exec/outputDelta':
        this.processes.dispatch(notification.params)
        return
      case 'turn/started':
        this.#sessions.get(notification.params.threadId)?.noteTurnStarted(notification.params.turn.id)
        return
      case 'turn/completed':
        this.#sessions.get(notification.params.threadId)?.noteTurnEnded(notification.params.turn.id)
        return
      case 'item/started':
      case 'item/completed': {
        const item = notification.params.item
        if (item.type === 'fileChange') {
          this.#sessions
            .get(notification.params.threadId)
            ?.recordFileChanges(item.id, item.changes)
        }
        if (item.type === 'commandExecution') {
          this.#sessions.get(notification.params.threadId)?.recordCommand(item.id, item.command)
        }
        this.tasks.noteItem(
          notification.params.threadId,
          item,
          notification.method === 'item/completed',
        )
        return
      }
      case 'item/fileChange/patchUpdated':
        this.#sessions
          .get(notification.params.threadId)
          ?.recordFileChanges(notification.params.itemId, notification.params.changes)
        return
      default:
        return
    }
  }

  #onServerRequest(
    request: CodexProtocol.ServerRequest,
    responder: ServerRequestResponder,
  ): void {
    if (request.method === 'item/tool/call') {
      void this.#invokePluginTool(request.params, responder)
      return
    }

    const handled = this.#approvals.handle(
      request,
      responder,
      (threadId, itemId) => this.#sessions.get(threadId)?.pendingFileChanges(itemId),
      (threadId, itemId) => this.#sessions.get(threadId)?.commandOf(itemId),
    )
    if (!handled) {
      // Refusing is safer than silence: an unanswered request stalls the turn
      // with no way for the user to tell why.
      responder.fail(-32601, `HarnessDesk does not handle ${request.method}`)
    }
  }

  /**
   * Runs a plugin tool on Codex's behalf.
   *
   * Hooks and the permission engine run first, so a plugin tool is governed by
   * the same policy as anything else the agent does — the extension plane does
   * not become a way around approvals.
   */
  async #invokePluginTool(
    params: CodexProtocol.v2.DynamicToolCallParams,
    responder: ServerRequestResponder,
  ): Promise<void> {
    const registry = this.#capabilities
    const session = this.#sessions.get(params.threadId)
    const label = `${params.namespace ?? ''}/${params.tool}`

    if (!registry) {
      responder.respond(
        toCodexToolResponse({ ok: false, error: `HarnessDesk has no tool named ${label}.` }),
      )
      return
    }

    const scope = {
      sessionId: makeSessionId(params.threadId),
      turnId: turnIdOf(params.turnId),
      runtime: this.#id,
      ...(session ? { workspaceRoot: session.settings().cwd } : {}),
    }

    // Resolved by name against the registry as it is NOW — contribution ids
    // are reissued when a plugin reloads, and a pinned id can silently name a
    // different tool. Codex was told the tool set at thread/start; a tool
    // that has since vanished gets a plain explanation instead of the
    // registry's opaque "no such id".
    const contribution = ToolProjection.resolveLive(registry, scope, params)
    if (!contribution) {
      responder.respond(
        toCodexToolResponse({
          ok: false,
          error: `${label} is not available any more — its plugin was reloaded or removed after this session started. Start a new session to pick up the current tool set.`,
        }),
      )
      return
    }

    try {
      const verdict = await registry.runHooks({
        event: 'preToolUse',
        toolName: params.tool,
        arguments: params.arguments,
        scope,
      })
      if (verdict.decision === 'deny') {
        responder.respond(toCodexToolResponse({ ok: false, error: verdict.reason }))
        return
      }

      const result = await registry.invokeTool(contribution, params.arguments, scope)
      void registry.runHooks({
        event: 'postToolUse',
        toolName: params.tool,
        arguments: params.arguments,
        result,
        scope,
      })
      responder.respond(toCodexToolResponse(result))
    } catch (error) {
      responder.respond(
        toCodexToolResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  #onStateChange(state: ConnectionState): void {
    if (state.type === 'ready') this.#version = state.installation.version
    if (state.type === 'restarting' || state.type === 'failed') {
      // A restarted app-server has no memory of live threads or watches. Drop
      // the handles so the host resumes rather than sending turns into a dead
      // session, and so a watcher is not left waiting for changes that will
      // never arrive. The catalogue goes too: the new process asks its vendor
      // afresh, and may be answered differently — or be a different binary.
      this.#sessions.clear()
      this.tasks.dispose()
      this.#catalog.invalidate()
      this.#catalog.forgetWarning()
      this.#approvals.abandonAll('The Codex runtime restarted.')
      this.files.abandon()
      this.processes.abandon()
    }
    if (state.type === 'failed') {
      this.#emit({ type: 'error', error: mapThrown(state.error) })
    }
    const health = this.health()
    for (const listener of this.#healthListeners) listener(health)
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#eventListeners) listener(event)
  }
}

const healthFromError = (error: CodexError): RuntimeHealth => {
  switch (error.code) {
    case 'notInstalled':
      return {
        state: 'unavailable',
        reason: 'notInstalled',
        message: 'Codex is not installed on this machine.',
        remediation: 'Install it with `brew install codex` or `npm i -g @openai/codex`.',
      }
    case 'versionTooOld':
      return {
        state: 'unavailable',
        reason: 'versionTooOld',
        message: error.message,
        remediation: 'Upgrade with `brew upgrade codex` or `npm i -g @openai/codex@latest`.',
      }
    case 'crashed':
      return {
        state: 'unavailable',
        reason: 'crashed',
        message: error.message,
        remediation: 'Check the diagnostics log, then restart HarnessDesk.',
      }
    default:
      return { state: 'unavailable', reason: 'unknown', message: error.message }
  }
}

const turnIdOf = (value: string) => value as unknown as import('@harnessdesk/protocol').TurnId

/**
 * `SessionOptions.model` and `options.model` say the same thing; the explicit
 * option wins when both are given, because it is the newer, deliberate form.
 */
/** The provider name injected routes appear under. Exists in no config file. */
const ROUTE_PROVIDER = 'harnessdesk_route'

const startParamsFor = (
  options: Partial<SessionOptions>,
): {
  start: StartOptionParams & {
    modelProvider?: string
    config?: Record<string, string | number>
  }
  after: readonly (readonly [string, OptionValue])[]
} => {
  const { start, after } = splitStartOptions(options.options ?? {})
  const route = options.route
  return {
    start: {
      ...(options.model ? { model: options.model } : {}),
      ...start,
      // A model route becomes a provider defined only for this thread, via
      // thread/start's dotted config overrides — the user's own config.toml
      // is never written (probed working: script/probe/appserver-inject.mjs).
      // The gateway token rides the base URL, so the provider needs no
      // env_key and nothing lands in this process's environment.
      ...(route
        ? {
            modelProvider: ROUTE_PROVIDER,
            ...(route.model ? { model: route.model } : {}),
            config: {
              [`model_providers.${ROUTE_PROVIDER}.name`]: route.name,
              [`model_providers.${ROUTE_PROVIDER}.base_url`]: route.endpoint,
              [`model_providers.${ROUTE_PROVIDER}.wire_api`]: route.wireProtocol,
              [`model_providers.${ROUTE_PROVIDER}.request_max_retries`]: 1,
              [`model_providers.${ROUTE_PROVIDER}.stream_max_retries`]: 1,
            },
          }
        : {}),
    },
    after,
  }
}

export { makeSessionId }
