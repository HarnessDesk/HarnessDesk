import { randomUUID } from 'node:crypto'
import { answerIosCall } from './ios.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  BrowserInvocations,
  ConsentRecord,
  consentPath,
  listInstalled,
  mergePermissions,
  pluginsRoot,
  readInstalledManifest,
  withIosInputSignal, iosCallTimeoutMs,
  type IosCapability,
  canonicalScopeQuery,
  canonicalRoot,
  setEditorEngine,
  setForgeEngine,
  validateForgeArgs,
  type ForgePush, type ForgeCreate, type ForgeUpdate, type ForgeMerge, type ForgeReview, type ForgeComment, type ForgeRecordQuery, type ForgeAttribute, type ForgeVerb,
  setTeamEngine,
  type BrowserEngine,
  type BrowserSettings,
  type EditorEngine,
  type ExtensionKernel,
  type ForgeEngine,
  type ForgeScope,
  type TeamEngine,
  type TeamScope,
  type HarnessPlugin,
  type KernelLogger,
  PluginCapabilityHost,
  capabilityWorkMs,
  readCapabilityRequest,
  type CapabilityLease,
  placedBrowserEngine,
  handPageToSystem,
} from '@harnessdesk/cordis-host'
import {
  choosePluginRuntime,
  confinedArgs,
  hostPluginRuntime,
  real,
  runtimeEnvironment,
  type PluginRuntime,
  type PluginRuntimeChoice,
  type PluginRuntimeProber,
} from './confinement.js'
import {
  EXTENSION_PROTOCOL_VERSION,
  isChildMessage,
  type BrowserSettingsWire,
  type ChildToHostRequest,
  type ChildToHostMethods,
  type HostToChildResponse,
  type InspectedPlugin,
  type PluginHostMethodName,
  type PluginHostMethods,
  type PluginHostNotification,
  type PluginHostStats,
} from '@harnessdesk/extension-protocol'
import {
  isForgeReference,
  pluginInstanceId,
  scopeApplies,
  type PluginInstanceId,
  type CapabilityContribution,
  type ContextImage,
  type ContributionId,
  type ContributionKind,
  type EditorEdit,
  type ExtensionEvent,
  type ForgeReference,
  type HookInvocation,
  type HookVerdict,
  type JsonSchema,
  type PluginIdentity,
  type PluginInstance,
  type PluginPermissions,
  type IosInvocationAuthority,
  type ScopeQuery,
  type WorkspaceAdmission,
  type SessionId,
  type ToolResult,
  type UiDecoration,
} from '@harnessdesk/protocol'

/**
 * The parent's half of plugin process isolation.
 *
 * `PluginHostProcess` owns one child process speaking the extension protocol:
 * spawn, handshake, request/response with a deadline, crash detection, restart
 * with backoff, and a cached snapshot of the child's plugins and contributions
 * so the host's synchronous `list()` can be answered without IPC.
 *
 * `SupervisedExtensionHost` is what the rest of HarnessDesk sees: one
 * `ExtensionHost` combining the in-process kernel (trusted built-ins only —
 * they are this repository's own code) with the child (everything installed).
 * Nothing above this file knows there are two.
 */

const CHILD_ENTRY = fileURLToPath(new URL('./child.js', import.meta.url))

/** Where a request may wait before the child is declared wedged. */
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000
/** Restart delays; after the last one the host stays down until asked again. */
const BACKOFF_MS = [250, 1000, 4000]
const IOS_NOT_GRANTED = 'This plugin has no simulator access: it was not granted when the plugin was installed, or its manifest has changed since.'

interface ForgeLease {
  readonly controller: AbortController
  readonly scope: ForgeScope
  readonly resume: ReturnType<typeof AsyncLocalStorage.snapshot>
  hold: () => () => void
}
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * The one installed plugin a process runs, as the host knows it. Every field
 * comes from the host's own reading of the plugin's directory, never from the
 * process: identity and permissions a plugin reports about itself count for
 * nothing.
 */
export interface BoundPlugin {
  readonly id: string
  readonly directory: string
  readonly identity: PluginIdentity
  readonly permissions: PluginPermissions
}

export interface PluginHostOptions {
  /**
   * The installed plugin this process runs. Absent for the installer process,
   * which inspects, installs and removes packages and never imports one.
   */
  readonly plugin?: BoundPlugin
  /** How long a single request may take. A wedged child is killed and restarted. */
  readonly invokeTimeoutMs?: number
  /** Scale request clocks in deadline tests; production uses one. */
  readonly requestTimeoutScale?: number
  readonly logger?: KernelLogger
  /** Extra environment for the child, e.g. HARNESSDESK_HOME in tests. */
  readonly env?: Readonly<Record<string, string>>
  readonly onEvent?: (event: ExtensionEvent) => void
  readonly onSnapshot?: () => void
  /**
   * Runs before every spawn, the first and each restart. Throwing keeps the
   * process down, and the message is what the plugin is listed as failing
   * with: a plugin whose manifest changed while it ran does not come back
   * under the permissions it gave itself.
   */
  readonly beforeStart?: () => Promise<void>
  /**
   * Told when `beforeStart` refused a start. The process drops the snapshot
   * it kept for the restart, since the plugin will not come back on its own,
   * and whoever shows its row and its tools has to hear that.
   */
  readonly onRefused?: () => void
  /**
   * Whether the plugin's manifest is still the one the person agreed to,
   * asked each time simulator authority is handed out. A manifest changed
   * while the plugin runs withdraws that authority at once, not only at the
   * next start. Any failure to answer reads as no, and a process built
   * without it is given no simulator access at all.
   */
  readonly stillConsented?: () => Promise<boolean>
  /**
   * The parent's own browser page, when it has one — the desktop shell's
   * pane. A child `ctx.browser` is then served from here; without it, the
   * child starts its own Chrome.
   */
  readonly iosEngine?: IosCapability
  readonly browserEngine?: BrowserEngine | null
  /**
   * The editor plane. Always the parent's, because the plane is host-owned:
   * a child has no window to fall back to, and no local editor to be.
   */
  readonly editorEngine?: EditorEngine | null
  /**
   * The team plane — the shared board and inter-agent messages. Host-owned
   * for the reason the editor plane is: a child has no session registry to
   * decide a claim against, and no routing guards of its own.
   */
  readonly teamEngine?: TeamEngine | null
  /**
   * The forge plane — the calling conversation's seat and the record of what
   * it published. Host-owned for the reason the team plane is: a child knows
   * no conversation, no model and no transcript.
   */
  readonly forgeEngine?: ForgeEngine | null
  /**
   * The runtime that holds the plugin's process to the Node permission
   * model, asked before each start (`confinement.ts`). Absent, or a choice
   * with no runtime, and the process runs as before — its own process, not
   * confined — and its stats say why. Never given to the installer.
   */
  readonly confinement?: () => Promise<PluginRuntimeChoice>
}

/** How a plugin's process is held, as its stats report it. */
export type PluginConfinement = { readonly confined: true; readonly runtime: string } | { readonly confined: false; readonly reason: string }

export class PluginHostProcess {
  readonly #iosInvocations = new Map<string, { owner: string; signal: AbortSignal; hold: () => () => void; abort: () => void }>()
  #child: ChildProcess | null = null
  /**
   * The name the plugin's kernel gave it inside this process (`<id>#<n>`).
   * The host addresses the plugin by its own name everywhere; this one is
   * used only to hand the process a simulator token under the name its
   * `ctx.ios` looks it up by.
   */
  #reportedInstanceId: string | null = null
  #nextId = 0
  readonly #pending = new Map<number, Pending>()
  readonly #browserInvocations = new BrowserInvocations()
  #plugins: readonly PluginInstance[] = []
  #contributions: readonly CapabilityContribution[] = []
  /**
   * Conversations with a scope-carrying request in flight to the child,
   * refcounted — the parent-issued identity a `team/*` request must ride.
   *
   * The child process is shared by every installed plugin, so nothing the
   * child *says* about who is calling can be trusted: a malicious plugin can
   * write raw protocol JSON with any scope it likes. What the parent does
   * know is which scopes it is currently invoking the child on behalf of,
   * and for which plugin. A team call whose scope is not among them — or
   * whose invocation belongs to no plugin granted `team` — is refused, so a
   * plugin can at worst act as a conversation while genuinely dispatched
   * for it, never as an arbitrary live session.
   */
  readonly #teamScopes = new Map<string, number>()
  /**
   * Tool calls in flight into this process: an agent's, each of them. While
   * one runs, an editor write from the process may be that agent's, and is
   * refused (see `#editorRefusal`).
   */
  #agentCalls = 0
  /**
   * The plugin's own reach — files, network, programs, Android — served here
   * for its process, which has none of its own (see `#serveCapability`).
   * Null for the installer, which runs no plugin.
   */
  readonly #capabilities: PluginCapabilityHost | null
  /** Invocations in flight into this process, by the lease each was handed. */
  readonly #capabilityLeases = new Map<string, { readonly lease: CapabilityLease; readonly hold: () => () => void }>()

  /** True while the running process is held to the permission model. */
  get #confined(): boolean {
    return this.#confinement?.confined === true
  }

  /** How the running (or last) process is held; null for the installer and before a start. */
  get confinement(): PluginConfinement | null {
    return this.#confinement
  }
  /** Ends every program this process asked for, when the process goes. */
  #capabilityRuns = new AbortController()
  /** Whether the running process is under the permission model, and on what. */
  #confinement: PluginConfinement | null = null
  /**
   * Each workspace-scoped contribution's root as this host resolved it when
   * first seen, by the process's contribution id and the spelling it gave.
   */
  readonly #roots = new Map<string, string>()
  /** Resolutions the process has not been told yet. */
  #unresolved: Record<string, { from: string; to: string }> = {}
  readonly #forgeLifetimes = new Map<string, Set<ForgeLease>>()
  #crashes = 0
  #browser: BrowserSettingsWire | null = null
  #startedAt = 0
  #wantInstalled = false
  /** The plugin's configuration, replayed into every restarted process. */
  #config: Readonly<Record<string, unknown>> | null = null
  #disposed = false
  #starting: Promise<void> | null = null
  /** Why the last start was refused before a process was spawned, if it was. */
  #problem: string | null = null
  #options: PluginHostOptions
  readonly #logger: KernelLogger

  constructor(options: PluginHostOptions = {}) {
    const scale = options.requestTimeoutScale ?? 1
    if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error('Request timeout scale must be greater than zero and at most one.')
    this.#options = options
    this.#logger = options.logger ?? {}
    const plugin = options.plugin
    this.#capabilities = plugin
      ? new PluginCapabilityHost(plugin.id, plugin.permissions, () => ({
          env: pluginEnvironment(this.#options.env),
          signal: this.#capabilityRuns.signal,
        }))
      : null
  }

  /**
   * Points `ctx.editor` at a plane that exists.
   *
   * A setter rather than a constructor argument because the plane belongs to
   * the host, and the host is built *after* this — it needs the extension
   * surface at construction so a session started early is not born with an
   * empty tool set. Nothing is sent to the child: the engine is consulted per
   * request, so a child already running picks it up on its next call.
   */
  setEditorEngine(engine: EditorEngine | null): void {
    this.#options = { ...this.#options, editorEngine: engine }
  }

  /** Points `ctx.team` at a plane that exists — a setter for the reason the editor's is. */
  setTeamEngine(engine: TeamEngine | null): void {
    this.#options = { ...this.#options, teamEngine: engine }
  }

  /** Points `ctx.forge` at a plane that exists — the team plane's reasoning, verbatim. */
  setForgeEngine(engine: ForgeEngine | null): void {
    this.#options = { ...this.#options, forgeEngine: engine }
  }

  /** The child's last-pushed truth; empty while it is down. */
  get plugins(): readonly PluginInstance[] {
    return this.#plugins
  }

  get contributions(): readonly CapabilityContribution[] {
    return this.#contributions
  }

  get alive(): boolean {
    return this.#child !== null && this.#child.exitCode === null
  }

  /** Whether it crashed too often and is stopped until someone starts it again. */
  get failed(): boolean {
    return this.#crashes > BACKOFF_MS.length
  }

  /** The plugin this process runs, or null for the installer. */
  get bound(): BoundPlugin | null {
    return this.#options.plugin ?? null
  }

  /** Why the last start was refused before a process was spawned; null when it was not. */
  get problem(): string | null {
    return this.#problem
  }

  /**
   * The instance id the host gives this plugin. The process numbers its own
   * instances, and a plugin can write any number it likes into a frame, so
   * the id everyone else sees is the host's, and it stays the same across
   * restarts.
   */
  get instanceId(): PluginInstanceId | null {
    return this.#options.plugin ? installedInstanceId(this.#options.plugin.id) : null
  }

  /** Whether an instance id the process reported is its own plugin's. */
  #isOwn(instanceId: unknown): boolean {
    const bound = this.#options.plugin
    if (!bound || typeof instanceId !== 'string') return false
    const prefix = `${bound.id}#`
    return instanceId.startsWith(prefix) && /^[0-9]+$/.test(instanceId.slice(prefix.length))
  }

  /** The prefix every contribution id from this process carries. */
  get #prefix(): string {
    return this.#options.plugin ? `plugin:${this.#options.plugin.id}:` : CHILD_ID_PREFIX
  }

  #namespaced(id: string | ContributionId): ContributionId {
    return `${this.#prefix}${String(id)}` as ContributionId
  }

  /** Whether a namespaced id belongs to this process. */
  owns(id: ContributionId): boolean {
    return String(id).startsWith(this.#prefix)
  }

  /** The id as the process knows it. */
  strip(id: ContributionId): string {
    return String(id).slice(this.#prefix.length)
  }

  /** Stores the configuration and sends it; a restarted process is sent it again. */
  async reconfigure(config: Readonly<Record<string, unknown>>): Promise<void> {
    const plugin = this.#options.plugin
    if (!plugin) throw new Error('The installer process runs no plugin to configure.')
    this.#config = config
    await this.call('plugin/reconfigure', { pluginId: plugin.id, config })
  }

  /** Brings the child up if it is not already. Concurrent callers share one start. */
  async ensure(): Promise<void> {
    if (this.#disposed) throw new Error('The plugin host has been disposed.')
    if (this.alive) return
    if (this.#crashes > BACKOFF_MS.length) {
      const plugin = this.#options.plugin
      throw new Error(
        plugin
          ? `${plugin.identity.name} crashed repeatedly and has been stopped. Turn it off and on again to retry.`
          : 'The plugin installer crashed repeatedly and has been stopped. Restart HarnessDesk.',
      )
    }
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null
    })
    await this.#starting
  }

  /** Loads everything installed, now and after every restart. */
  async loadInstalled(): Promise<void> {
    this.#wantInstalled = true
    await this.ensure()
    await this.call('plugins/loadInstalled', {})
  }

  async #start(): Promise<void> {
    if (this.#options.beforeStart) {
      try {
        await this.#options.beforeStart()
        this.#problem = null
      } catch (error) {
        this.#refuse(error)
        throw error
      }
    }
    const plugin = this.#options.plugin
    // Asked before the check below, because nothing may await between that
    // check and the spawn. The answer is cached per runtime, so only the
    // first start pays for the probe.
    const choice: PluginRuntimeChoice | null = plugin
      ? await (this.#options.confinement?.() ?? Promise.resolve({ runtime: null, reason: 'confinement is off' } as const)).catch(
          (error: unknown) => ({ runtime: null, reason: `the runtime could not be chosen (${error instanceof Error ? error.message : String(error)})` }) as const,
        )
      : null
    // A stop or uninstall that landed while the checks above were reading must
    // not be followed by a spawn: the plugin's code would load and run, and
    // its files may already be on their way out. Nothing awaits between here
    // and the spawn, so a later dispose() finds the child and ends it.
    if (this.#disposed) throw new Error('The plugin host has been disposed.')
    let command = process.execPath
    let args: readonly string[] = [CHILD_ENTRY]
    // A plugin's process starts from an allowlist, never the host's own
    // environment: a token the host was started with is not the plugin's.
    // The installer runs no plugin code and needs the package manager's
    // configuration, so it keeps the host's. ELECTRON_RUN_AS_NODE makes the
    // same spawn work when the parent is the Electron main process: the
    // child must be plain Node, never a second app.
    let env: NodeJS.ProcessEnv = plugin
      ? pluginProcessEnvironment(this.#options.env)
      : { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...this.#options.env }
    if (plugin && choice?.runtime) {
      // Read access to the child's own code and the plugin's directory, and
      // nothing else: no writes, network, programs, workers or addons.
      command = choice.runtime.binary
      args = confinedArgs(CHILD_ENTRY, plugin.directory)
      env = runtimeEnvironment(env, choice.runtime)
      this.#confinement = { confined: true, runtime: `${choice.runtime.label} (Node ${choice.runtime.version})` }
    } else if (plugin && choice) {
      const reason = choice.runtime === null ? choice.reason : 'no runtime'
      if (this.#confinement?.confined !== false) {
        this.#logger.warn?.('plugin runs unconfined', { plugin: plugin.id, reason })
      }
      this.#confinement = { confined: false, reason }
    }
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env })
    this.#child = child
    this.#reportedInstanceId = null
    // A new process numbers its contributions afresh.
    this.#roots.clear()
    this.#unresolved = {}

    // A write that lands after the child is gone answers EPIPE on stdin; an
    // unheard `error` there is an uncaught exception in the host process.
    child.stdin?.on('error', (error) => this.#logger.warn?.('plugin host stdin', { error: error.message }))
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => this.#onLine(line))
    const errors = createInterface({ input: child.stderr! })
    errors.on('line', (line) => this.#logger.debug?.('plugin host', { line }))

    child.on('exit', (code, signal) => {
      if (this.#child !== child) return
      this.#child = null
      // A program the process started dies with it, as it did when the
      // process ran it itself.
      this.#capabilityRuns.abort()
      this.#capabilityRuns = new AbortController()
      // The snapshot is deliberately kept: the plugins are still installed and
      // will return with the restart, and a Settings page that flickers empty
      // on every crash would be lying about what is installed. Consumers see
      // `alive` for the difference.
      //
      // Every waiting caller learns immediately: a turn blocked on a tool
      // must fail now, not when a timeout eventually fires.
      const how = signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''
      const bound = this.#options.plugin
      const reason = new Error(
        bound
          ? `${bound.identity.name} exited${how}. Its tools are unavailable until it restarts.`
          : `The plugin installer exited${how}.`,
      )
      for (const pending of this.#pending.values()) {
        if (pending.timer) clearTimeout(pending.timer)
        pending.reject(reason)
      }
      this.#pending.clear()
      if (this.#disposed) return
      // A crash after a long healthy run is a fresh incident, not the next
      // rung of the backoff ladder.
      if (Date.now() - this.#startedAt > 30_000) this.#crashes = 0
      this.#crashes += 1
      this.#logger.warn?.('plugin host exited', { code, signal, crashes: this.#crashes })
      this.#options.onEvent?.({
        type: 'extension/log',
        owner: this.instanceId ?? pluginInstanceId('plugin-host'),
        level: 'error',
        message: reason.message,
      })
      if (this.#crashes > BACKOFF_MS.length) {
        this.#logger.error?.('plugin host crashed repeatedly; giving up')
        return
      }
      const delay = BACKOFF_MS[Math.min(this.#crashes - 1, BACKOFF_MS.length - 1)]
      setTimeout(() => {
        if (!this.#disposed && !this.alive) {
          void this.ensure().catch((error: unknown) =>
            this.#logger.error?.('plugin host restart failed', { error: String(error) }),
          )
        }
      }, delay).unref?.()
    })

    this.#startedAt = Date.now()
    const hello = await this.call('host/hello', {
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      ...(this.#options.requestTimeoutScale !== undefined ? { requestTimeoutScale: this.#options.requestTimeoutScale } : {}),
      inlineBrowser: Boolean(this.#options.browserEngine) || this.#confined,
      ...(this.#confined ? { confined: true } : {}),
      // A restarted child starts on the defaults, so where pages open goes
      // in the greeting rather than being sent once and forgotten.
      ...(this.#browser ? { browser: this.#browser } : {}),
      ...(this.#options.plugin
        ? {
            plugin: {
              id: this.#options.plugin.id,
              directory: this.#confined ? real(this.#options.plugin.directory) : this.#options.plugin.directory,
              permissions: this.#options.plugin.permissions,
            },
          }
        : {}),
    })
    this.#logger.info?.('plugin host ready', { pid: hello.pid, plugin: this.#options.plugin?.id })
    // A restarted child must reach the same state the crashed one had; a
    // fresh, empty child answering hook or tool calls would silently allow
    // what a loaded plugin might have denied. That includes its settings.
    if (this.#wantInstalled) {
      try {
        await this.call('plugins/loadInstalled', {})
        if (this.#config && this.#options.plugin) {
          await this.call('plugin/reconfigure', { pluginId: this.#options.plugin.id, config: this.#config })
        }
      } catch (error) {
        // A child that could not take the plugin back is not that plugin: it
        // would answer the hooks and tools the snapshot still names with an
        // empty kernel. It is ended, without a restart, and the plugin is
        // shown as failed until someone starts it again.
        if (this.#child === child) {
          this.#child = null
          child.kill('SIGKILL')
          const reason = error instanceof Error ? error : new Error(String(error))
          for (const pending of this.#pending.values()) {
            if (pending.timer) clearTimeout(pending.timer)
            pending.reject(reason)
          }
          this.#pending.clear()
        }
        this.#refuse(error)
        throw error
      }
    }
  }

  /** A start that did not bring the plugin back: nothing it advertised stays, and the reason is shown. */
  #refuse(error: unknown): void {
    this.#problem = error instanceof Error ? error.message : String(error)
    // The snapshot was kept so a restart would not flicker; a refused
    // restart is not one, and tools it still advertised would fail.
    this.#plugins = []
    this.#contributions = []
    this.#options.onRefused?.()
  }

  #onLine(line: string): void {
    if (line.trim().length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.#logger.warn?.('unparseable line from plugin host', { line: line.slice(0, 200) })
      return
    }
    if (!isChildMessage(parsed)) return
    if ('request' in parsed) {
      void this.#answer(parsed)
      return
    }
    if ('notification' in parsed) {
      try {
        this.#onNotification(parsed.notification)
      } catch (error) {
        // A frame the checks below did not foresee is still only that
        // process's mistake: dropped here, it cannot take the host down with it.
        this.#logger.warn?.('malformed notification from plugin host', { error: String(error) })
      }
      return
    }
    const pending = this.#pending.get(parsed.id)
    if (!pending) return
    this.#pending.delete(parsed.id)
    if (pending.timer) clearTimeout(pending.timer)
    if ('error' in parsed) pending.reject(new Error(parsed.error.message))
    else pending.resolve(parsed.result)
  }

  /**
   * A contribution as the host keeps it: its id namespaced, and a workspace
   * scope's root resolved here. A confined process cannot resolve a path it
   * has no grant for, so the root it reports may be a spelling, not the
   * checkout; resolving it in the host is what a process that could would do.
   */
  #received<T extends CapabilityContribution>(entry: T): T {
    const scope = entry.scope
    if (scope.kind !== 'workspace') return { ...entry, id: this.#namespaced(entry.id) }
    // Resolved once per contribution and spelling, when first seen, so a
    // symlink retargeted later cannot move a scope already registered.
    const key = `${entry.id}\0${scope.root}`
    let root = this.#roots.get(key)
    if (root === undefined) {
      root = canonicalRoot(scope.root)
      this.#roots.set(key, root)
      if (root !== scope.root) this.#unresolved[entry.id] = { from: scope.root, to: root }
    }
    return { ...entry, id: this.#namespaced(entry.id), scope: { ...scope, root } }
  }

  /** Tells the process what the roots it could not resolve resolved to; see `scopes/resolved`. */
  #sendResolvedRoots(): void {
    const roots = this.#unresolved
    if (Object.keys(roots).length === 0) return
    this.#unresolved = {}
    void this.call('scopes/resolved', { roots }).catch((error: unknown) =>
      this.#logger.debug?.('plugin host did not take resolved roots', { error: String(error) }))
  }

  /** A notification from the process: a snapshot of its plugin, or an event about it. */
  #onNotification(notification: PluginHostNotification): void {
    if (notification.kind === 'snapshot') {
      // Child ids are namespaced at this boundary: both kernels number
      // their contributions c1, c2, … independently, and unprefixed child
      // ids shadow in-process ones — a live Codex run resolved a child
      // browser tool to c2 and executed the built-in Search tool that
      // owned c2 in the kernel. Ids must be unique across the merge.
      const { plugins, contributions } = this.#checked(notification.plugins, notification.contributions)
      this.#plugins = plugins.map((plugin) => ({
        ...plugin,
        contributions: plugin.contributions.map((entry) => this.#received(entry)),
      }))
      this.#contributions = contributions.map((entry) => this.#received(entry))
      // Forget the resolutions of contributions the process no longer has.
      const live = new Set(contributions.map((entry) => String(entry.id)))
      for (const key of this.#roots.keys()) if (!live.has(key.slice(0, key.indexOf('\0')))) this.#roots.delete(key)
      this.#sendResolvedRoots()
      this.#options.onSnapshot?.()
    } else {
      this.#crashes = 0 // A healthy event stream clears the backoff ladder.
      const event = this.#checkedEvent(notification.event)
      this.#sendResolvedRoots()
      if (event) this.#options.onEvent?.(event)
    }
  }

  /**
   * A snapshot, held to what the host knows about the plugin on this pipe.
   *
   * The process reports what its plugin registered; it does not get to say
   * which plugin it is or what that plugin may do. Only the bound plugin's
   * entry is kept, its identity and permissions are replaced with the host's
   * own, and a contribution its permissions do not allow is dropped.
   */
  #checked(
    plugins: readonly PluginInstance[],
    contributions: readonly CapabilityContribution[],
  ): { plugins: readonly PluginInstance[]; contributions: readonly CapabilityContribution[] } {
    const bound = this.#options.plugin
    const own = this.instanceId
    if (!bound || !own || !Array.isArray(plugins)) return { plugins: [], contributions: [] }
    // The frame is the process's, so its shape is too: anything that is not
    // a plugin entry is not one, rather than something to dereference.
    const reported = plugins.find((plugin) =>
      isRecord(plugin) && isRecord(plugin.identity) && plugin.identity.id === bound.id && this.#isOwn(plugin.instanceId))
    if (!reported) return { plugins: [], contributions: [] }
    this.#reportedInstanceId = String(reported.instanceId)
    const kept = this.#allowed(reported.instanceId, contributions)
    return {
      plugins: [{
        ...reported,
        instanceId: own,
        identity: bound.identity,
        permissions: bound.permissions,
        contributions: this.#allowed(reported.instanceId, reported.contributions),
      }],
      contributions: kept,
    }
  }

  /** The contributions `owner` may make, re-owned by the host's instance id. */
  #allowed(owner: PluginInstanceId, contributions: readonly CapabilityContribution[]): CapabilityContribution[] {
    const bound = this.#options.plugin
    const own = this.instanceId
    if (!bound || !own || !Array.isArray(contributions)) return []
    return contributions
      .filter((entry) => isRecord(entry) && entry.owner === owner && (entry.kind !== 'ui' || bound.permissions.ui.contribute))
      .map((entry) => ({ ...entry, owner: own }))
  }

  /**
   * An event, held to the same rule as a snapshot: it may speak only about
   * this process's own plugin, and what it says is what the host knows.
   * Events go straight to Settings and the renderer, which key plugins and
   * contributions by instance id, so an unchecked one could rewrite or remove
   * another plugin's row.
   */
  #checkedEvent(event: ExtensionEvent): ExtensionEvent | null {
    const own = this.instanceId
    if (!own) return null
    switch (event?.type) {
      case 'plugin/added':
      case 'plugin/updated': {
        if (!isRecord(event.plugin)) return null
        const plugin = this.#checked([event.plugin], event.plugin.contributions).plugins[0]
        if (!plugin) return null
        return {
          type: event.type,
          plugin: { ...plugin, contributions: plugin.contributions.map((entry) => this.#received(entry)) },
        }
      }
      case 'plugin/removed':
        // Whether an installed plugin is there is the host's to say, like
        // whether it is on: only an uninstall removes its row. A process
        // reporting its own plugin gone would take the row, and the switch
        // that stops it, away while the process ran on.
        return null
      case 'contributions/changed':
        if (!this.#isOwn(event.owner) || !Array.isArray(event.contributions)) return null
        return {
          type: 'contributions/changed',
          owner: own,
          revision: event.revision,
          contributions: this.#allowed(event.owner, event.contributions).map((entry) => this.#received(entry)),
        }
      case 'extension/log':
        return { type: 'extension/log', owner: own, level: event.level, message: String(event.message) }
      default:
        return null
    }
  }

  /**
   * Who is asking is the pipe the request came in on, never a field in it.
   * Every place a request names a plugin is overwritten with this process's
   * own, so a request naming another plugin is simply a request from this one.
   */
  #attributed(request: ChildToHostRequest): ChildToHostRequest {
    const bound = this.#options.plugin
    if (!bound) return request
    const params = { ...(request.params as Record<string, unknown>) }
    if (request.method.startsWith('editor/')) params['pluginId'] = bound.id
    if (request.method.startsWith('team/') || request.method.startsWith('forge/')) {
      const instance = this.#plugins[0]?.instanceId
      const { plugin: _claimed, ...scope } = (params['scope'] ?? {}) as Record<string, unknown>
      params['scope'] = instance === undefined ? scope : { ...scope, plugin: String(instance) }
    }
    return { ...request, params } as ChildToHostRequest
  }

  /**
   * A child's request, answered from the parent's own engines.
   *
   * Each family checks for its own engine, not one guard for both: a host
   * with a browser but no editor plane must answer `browser/*` and refuse
   * `editor/*`, and the single up-front check this method used to open with
   * would have refused every editor call on a host that simply had no pane.
   */
  async #answer(request: ChildToHostRequest): Promise<void> {
    const sourceChild = this.#child
    request = this.#attributed(request)
    const reply = (message: HostToChildResponse): void => {
      if (this.#child !== sourceChild) return
      sourceChild?.stdin?.write(`${JSON.stringify(message)}\n`)
    }
    const refuse = (message: string): void => {
      reply({ response: request.request, error: { message } })
    }
    try {
      if (request.method === 'capability/call') {
        const result = await this.#serveCapability(request.params)
        reply({ response: request.request, result: result === undefined ? null : result })
        return
      }
      if (request.method === 'ios/call') {
        const child = this.#child
        const current = this.#iosState()
        if (!await this.#iosGranted() || !current()) throw new Error(IOS_NOT_GRANTED)
        const params = request.params as ChildToHostMethods['ios/call']['params']
        const lease = this.#iosInvocations.get(params?.invocation)
        const plugin = this.#plugins.find(p => String(p.instanceId) === lease?.owner)
        // The process holds one plugin, and its grant is the host's record of what was consented to.
        if (!plugin?.enabled || plugin.permissions.ios !== true || !lease || lease.signal.aborted || !this.#options.iosEngine) throw new Error('This simulator request has no live invocation with an iOS permission grant.')
        if (this.#child !== child || this.#iosInvocations.get(params.invocation) !== lease) throw new Error('This simulator invocation has ended.')
        const timeoutMs = iosCallTimeoutMs(params.call) * (this.#options.requestTimeoutScale ?? 1)
        const release = lease.hold()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('The simulator operation exceeded its bounded work deadline.'))
              lease.abort()
            }, timeoutMs)
            timer.unref?.()
          })
          const result = await Promise.race([withIosInputSignal(lease.signal, () => answerIosCall(this.#options.iosEngine!, params.call)), expired])
          reply({ response: request.request, result: result === undefined ? null : result }); return
        } finally { clearTimeout(timer); release() }
      }
      if (request.method.startsWith('editor/')) {
        const plane = this.#options.editorEngine
        if (!plane) {
          refuse('The host has no editor plane.')
          return
        }
        const refusal = this.#editorRefusal(request.method)
        if (refusal) {
          refuse(refusal)
          return
        }
        switch (request.method) {
          case 'editor/open': {
            const { path, pluginId } = request.params as { path: string; pluginId: string }
            await plane.open(path, pluginId)
            reply({ response: request.request, result: null })
            return
          }
          case 'editor/applyEdits': {
            const { path, edits, pluginId } = request.params as {
              path: string
              edits: readonly EditorEdit[]
              pluginId: string
            }
            reply({ response: request.request, result: await plane.applyEdits(path, edits, pluginId) })
            return
          }
          case 'editor/decorate': {
            const { path, decorations, pluginId } = request.params as {
              path: string
              decorations: readonly UiDecoration[]
              pluginId: string
            }
            await plane.decorate(path, decorations, pluginId)
            reply({ response: request.request, result: null })
            return
          }
          case 'editor/close': {
            const { path } = request.params as { path: string }
            await plane.close(path)
            reply({ response: request.request, result: null })
            return
          }
          case 'editor/events': {
            const { pluginId } = request.params as { pluginId: string }
            reply({ response: request.request, result: await plane.drain(pluginId) })
            return
          }
          default:
            refuse(`Unknown request ${String(request.method)}.`)
            return
        }
      }

      if (request.method.startsWith('forge/')) {
        const plane = this.#options.forgeEngine
        if (!plane) {
          refuse('The host has no forge plane.')
          return
        }
        const params = request.params as Record<string, unknown>
        // Every forge verb rides a live invocation the parent dispatched to
        // the plugin that speaks — the identity too. It names no
        // conversation, but the grant it needs is per plugin, and the arming
        // is the one thing the parent knows about which plugin is speaking:
        // without it, any plugin in the shared child could read the forge
        // login by writing the frame itself. See the team block below.
        const scope = (params['scope'] ?? {}) as ForgeScope
        if (!this.#armedFor(scope, 'forge')) {
          refuse(
            'Refused: this forge call does not ride a live invocation the host dispatched to this plugin for that conversation, so it cannot be attributed. Forge verbs work only while a tool call, context resolution, or command for that conversation — dispatched to this plugin, which must be granted `forge` — is in flight.',
          )
          return
        }
        const verb = request.method.slice(6) as ForgeVerb
        if (['push', 'create', 'update', 'merge', 'review', 'comment', 'record', 'attribute', 'repository', 'associatedPullRequest'].includes(verb)) {
          const plugin = this.#plugins.find(entry => String(entry.instanceId) === scope.plugin)
          const grant = plugin?.permissions.forge
          if (!['record', 'attribute', 'repository', 'associatedPullRequest'].includes(verb) && !(typeof grant === 'object' && grant.write === true)) {
            refuse('Permission denied: forge.write'); return
          }
          validateForgeArgs(verb, params['args'])
          // The parent stamps the actor, turn and lifetime; none is a child's claim.
          const leases = this.#forgeLifetimes.get(teamScopeKey(scope.runtime!, scope.sessionId!, scope.plugin!))
          if (leases?.size !== 1) { refuse('This forge call has no unambiguous live invocation.'); return }
          const lease = leases.values().next().value
          if (!lease) { refuse('This forge call has no live invocation.'); return }
          if (!['record', 'attribute', 'repository', 'associatedPullRequest'].includes(verb) && lease.scope.actor === 'context') {
            refuse('Context resolution cannot write to the forge.'); return
          }
          const trusted = { ...lease.scope, plugin: scope.plugin, signal: lease.controller.signal }
          const release = lease.hold()
          try {
            await lease.resume(async () => {
              const args = params['args']
              let result: unknown
              switch (verb) {
                case 'repository': result = await plane.repository(trusted); break
                case 'associatedPullRequest': result = await plane.associatedPullRequest(trusted); break
                case 'push': result = await plane.push(args as ForgePush, trusted); break
                case 'create': result = await plane.pullRequest.create(args as ForgeCreate, trusted); break
                case 'update': result = await plane.pullRequest.update(args as ForgeUpdate, trusted); break
                case 'merge': result = await plane.pullRequest.merge(args as ForgeMerge, trusted); break
                case 'review': result = await plane.review(args as ForgeReview, trusted); break
                case 'comment': result = await plane.comment(args as ForgeComment, trusted); break
                case 'record': result = await plane.record(args as ForgeRecordQuery, trusted); break
                case 'attribute': result = await plane.attribute(args as ForgeAttribute, trusted); break
              }
              reply({ response: request.request, result })
            })
          } finally { release() }
          return
        }
        // The rest answer for the invocation the parent dispatched, too: its
        // actor and turn come from the host's lease, never from the frame.
        const live = this.#forgeLifetimes.get(teamScopeKey(scope.runtime!, scope.sessionId!, scope.plugin!))
        const held = live?.size === 1 ? live.values().next().value : undefined
        if (!held) { refuse('This forge call has no unambiguous live invocation.'); return }
        const leased: ForgeScope = { ...held.scope, plugin: scope.plugin }
        switch (request.method) {
          case 'forge/identity': {
            reply({ response: request.request, result: await plane.identity(leased) })
            return
          }
          case 'forge/seat': {
            reply({ response: request.request, result: await plane.seat(leased) })
            return
          }
          case 'forge/publicationAllowed': {
            // Answered for the invocation the parent armed, never for a scope the child names.
            reply({ response: request.request, result: await plane.publicationAllowed(leased) })
            return
          }
          case 'forge/publish': {
            // The reference crosses from the child into every window's
            // transcript; a shape the renderer does not expect stops here.
            const reference = params['reference']
            if (!isForgeReference(reference)) {
              refuse(
                'Refused: the publication is not a forge reference — kind, repo, number, url and via are required, in their types.',
              )
              return
            }
            if (held.scope.actor === 'context') { refuse('Context resolution cannot publish to the transcript.'); return }
            await plane.publish(reference, leased)
            reply({ response: request.request, result: null })
            return
          }
          default:
            refuse(`Unknown request ${String(request.method)}.`)
            return
        }
      }

      if (request.method.startsWith('team/')) {
        const plane = this.#options.teamEngine
        if (!plane) {
          refuse('The host has no team plane.')
          return
        }
        const params = request.params as Record<string, unknown>
        const claimed = (params['scope'] ?? {}) as TeamScope
        // The scope is the child's claim; the armed set is the parent's
        // knowledge. See `#teamScopes` — a claim the parent is not currently
        // standing behind is refused, not believed.
        //
        // The claim now includes *which plugin* is calling, and the parent
        // arms one key per plugin it actually dispatched to. Before this, the
        // key was the conversation alone: any enabled plugin holding the
        // `team` grant armed it for everything in the process, so a sibling
        // plugin with no grant at all could write a raw `team/*` request to
        // the shared stdout and be attributed to that conversation. The child
        // remains one trust domain — a plugin that lies about its identity is
        // still only reaching a window where the plugin it names is itself
        // mid-invocation — but the ambient, always-on grant is gone.
        if (!this.#armedFor(claimed, 'team')) {
          refuse(
            'Refused: this team call does not ride a live invocation the host dispatched to this plugin for that conversation, so it cannot be attributed. Team verbs work only while a tool call, context resolution, or command for that conversation — dispatched to this plugin, which must be granted `team` — is in flight.',
          )
          return
        }
        const scope: TeamScope = {
          ...claimed,
          ...(claimed.invocation
            ? { signal: this.#browserInvocations.signal(claimed.invocation, claimed.plugin) }
            : {}),
        }
        switch (request.method) {
          case 'team/board': {
            reply({ response: request.request, result: await plane.board(scope) })
            return
          }
          case 'team/addIntent': {
            const { title, detail, files, dependsOn } = params as unknown as {
              title: string
              detail?: string
              files?: readonly string[]
              dependsOn?: readonly number[]
            }
            reply({
              response: request.request,
              result: await plane.addIntent(
                {
                  title,
                  ...(detail !== undefined ? { detail } : {}),
                  ...(files !== undefined ? { files } : {}),
                  ...(dependsOn !== undefined ? { dependsOn } : {}),
                },
                scope,
              ),
            })
            return
          }
          case 'team/claim': {
            reply({
              response: request.request,
              result: await plane.claim(
                Number(params['intent']),
                scope,
                Array.isArray(params['files']) ? (params['files'] as readonly string[]) : undefined,
              ),
            })
            return
          }
          case 'team/claimNext': {
            reply({
              response: request.request,
              result: await plane.claimNext(
                scope,
                Array.isArray(params['files']) ? (params['files'] as readonly string[]) : undefined,
              ),
            })
            return
          }
          case 'team/awaitWork': {
            const { cycle, blockMs } = params as { cycle?: number; blockMs?: number }
            reply({
              response: request.request,
              result: await plane.awaitWork(scope, {
                ...(cycle !== undefined ? { cycle: Number(cycle) } : {}),
                ...(blockMs !== undefined ? { blockMs: Number(blockMs) } : {}),
              }),
            })
            return
          }
          case 'team/awaitMember': {
            const { member, cycle, blockMs } = params as { member: string; cycle?: number; blockMs?: number }
            reply({
              response: request.request,
              result: await plane.awaitMember(scope, {
                member: String(member ?? ''),
                ...(cycle !== undefined ? { cycle: Number(cycle) } : {}),
                ...(blockMs !== undefined ? { blockMs: Number(blockMs) } : {}),
              }),
            })
            return
          }
          case 'team/conflicts': {
            const paths = (params['paths'] ?? []) as readonly string[]
            reply({ response: request.request, result: await plane.conflicts(paths, scope) })
            return
          }
          case 'team/commitWork': {
            reply({
              response: request.request,
              result: await plane.commitWork(Number(params['intent']), String(params['message'] ?? ''), scope),
            })
            return
          }
          case 'team/runCheck': {
            const { name, commit } = params as { name?: unknown; commit?: unknown }
            reply({
              response: request.request,
              result: await plane.runCheck(Number(params['intent']), {
                ...(typeof name === 'string' ? { name } : {}),
                ...(typeof commit === 'string' ? { commit } : {}),
              }, scope),
            })
            return
          }
          case 'team/complete': {
            const { note, handoff, outcome, split } = params as {
              note?: string
              handoff?: string
              outcome?: string
              split?: readonly (readonly string[])[]
            }
            reply({
              response: request.request,
              result: await plane.complete(
                Number(params['intent']),
                {
                  ...(note !== undefined ? { note } : {}),
                  ...(handoff !== undefined ? { handoff } : {}),
                  ...(outcome !== undefined ? { outcome } : {}),
                  ...(split !== undefined ? { split } : {}),
                },
                scope,
              ),
            })
            return
          }
          case 'team/release': {
            const { reason, blocked } = params as { reason?: string; blocked?: boolean }
            reply({
              response: request.request,
              result: await plane.release(
                Number(params['intent']),
                {
                  ...(reason !== undefined ? { reason } : {}),
                  ...(blocked !== undefined ? { blocked } : {}),
                },
                scope,
              ),
            })
            return
          }
          case 'team/handoff': {
            reply({
              response: request.request,
              result: await plane.handoff(Number(params['intent']), scope),
            })
            return
          }
          case 'team/status': {
            reply({ response: request.request, result: await plane.status(scope) })
            return
          }
          case 'team/send': {
            const { to, text, wake } = params as { to: string; text: string; wake?: boolean }
            reply({
              response: request.request,
              result: await plane.send({ to, text, ...(wake !== undefined ? { wake } : {}) }, scope),
            })
            return
          }
          case 'team/notify': {
            const { where, title, body, task } = params as { where: string; title: string; body?: string; task?: string }
            reply({
              response: request.request,
              result: await plane.notify(
                {
                  where: where === 'composer' ? 'composer' : 'inbox',
                  title: String(title ?? ''),
                  ...(typeof body === 'string' ? { body } : {}),
                  ...(typeof task === 'string' ? { task } : {}),
                },
                scope,
              ),
            })
            return
          }
          case 'team/reviewCandidates': {
            reply({ response: request.request, result: await plane.reviewCandidates(Number(params['intent']), scope) })
            return
          }
          case 'team/recordReview': {
            const { intent, candidate, verdict, against } = params as {
              intent: number
              candidate: string
              verdict: string
              against?: readonly string[]
            }
            reply({
              response: request.request,
              result: await plane.recordReview(
                { intent: Number(intent), candidate: String(candidate), verdict: String(verdict), ...(against !== undefined ? { against } : {}) },
                scope,
              ),
            })
            return
          }
          /*
           * The findings ledger: the input is handed on exactly as the child
           * sent it, never spread into the scope, so a key it may not carry —
           * a Seat, a revision, an authority — reaches the host's validator
           * and is refused there, whole, before anything is written.
           */
          case 'team/raiseFinding': {
            reply({ response: request.request, result: await plane.raiseFinding(params['input'] as never, scope) })
            return
          }
          case 'team/repairFinding': {
            reply({ response: request.request, result: await plane.repairFinding(params['input'] as never, scope) })
            return
          }
          case 'team/decideFinding': {
            reply({ response: request.request, result: await plane.decideFinding(params['input'] as never, scope) })
            return
          }
          case 'team/listFindings': {
            reply({ response: request.request, result: await plane.listFindings(params['input'] as never, scope) })
            return
          }
          default:
            refuse(`Unknown request ${String(request.method)}.`)
            return
        }
      }

      const invocation = (request.params as { invocation?: unknown })?.invocation
      const identity = this.#browserInvocations.resolve(invocation)
      const owner = this.#browserInvocations.owner(invocation)
      if (
        !this.#plugins.some(
          (plugin) =>
            String(plugin.instanceId) === owner &&
            plugin.enabled &&
            plugin.permissions.browser,
        )
      ) {
        throw new Error('This plugin no longer has a browser grant.')
      }
      // A confined process can start no browser of its own, so every
      // placement it is set to is served here, by the same settings.
      const engine = this.#confined ? placedBrowserEngine(this.#options.browserEngine ?? null) : this.#options.browserEngine
      if (!engine) {
        refuse('The host has no browser of its own.')
        return
      }
      switch (request.method) {
        case 'browser/handoff': {
          if (!this.#confined) {
            refuse('Only a confined plugin process hands pages over.')
            return
          }
          const url = (request.params as { url?: unknown }).url
          if (typeof url !== 'string') {
            refuse('A hand-off needs the address of the page.')
            return
          }
          await handPageToSystem(url)
          reply({ response: request.request, result: null })
          return
        }
        case 'browser/ensure':
          await engine.ensure(identity)
          reply({ response: request.request, result: null })
          return
        case 'browser/send': {
          const { method, params } = request.params as { method: string; params?: Record<string, unknown> }
          const sender = await engine.ensure(identity)
          reply({ response: request.request, result: (await sender.send(method, params)) ?? null })
          return
        }
        case 'browser/events': {
          const sender = await engine.ensure(identity)
          reply({ response: request.request, result: (await sender.drain?.()) ?? [] })
          return
        }
        case 'browser/close':
          await engine.close(identity)
          reply({ response: request.request, result: null })
          return
        default:
          refuse(`Unknown request ${String(request.method)}.`)
      }
    } catch (error) {
      reply({ response: request.request, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }

  /**
   * A plugin's `ctx.fs`, `ctx.http`, `ctx.shell` or `ctx.android` call, run
   * here: the process runs under the Node permission model and has no disk,
   * network or programs of its own (docs/plugin-isolation.md).
   *
   * The call is checked against the permissions the person agreed to, which
   * the host holds; nothing the process says about itself widens them. The
   * lease names the invocation the call belongs to, and the call runs in the
   * checkout the host admitted for it. A lease this process was not handed,
   * or one whose invocation has ended, is background work, and runs in the
   * open workspace — where background work in the host has always run.
   */
  async #serveCapability(raw: unknown): Promise<unknown> {
    const capabilities = this.#capabilities
    if (!capabilities) throw new Error('The installer process runs no plugin.')
    const params = typeof raw === 'object' && raw !== null ? raw as { readonly lease?: unknown; readonly call?: unknown } : {}
    const leased = typeof params.lease === 'string' ? this.#capabilityLeases.get(params.lease) : undefined
    const call = readCapabilityRequest(params.call)
    // While the host does the work, the invocation's deadline waits for it,
    // up to the call's own bound: a plugin is not timed out for waiting on
    // the host, and a call that outlives its bound gives the deadline back.
    const hold = leased?.hold()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      hold?.()
    }
    const bound = setTimeout(release, capabilityWorkMs(call) * (this.#options.requestTimeoutScale ?? 1))
    bound.unref?.()
    try {
      return await capabilities.serve(call, leased?.lease)
    } finally {
      clearTimeout(bound)
      release()
    }
  }

  /**
   * The checkout an invocation's capability calls run in: the one the host
   * admitted for a tool call or a context read, as the kernel runs those in
   * the host; the open workspace for a command or a hook, as there.
   */
  #leaseFor(method: string, params: unknown): CapabilityLease {
    if (method !== 'tool/invoke' && !method.startsWith('context/')) return { enterCheckout: false }
    const input = params as { readonly scope?: ScopeQuery; readonly query?: ScopeQuery }
    const scope = input.scope ?? input.query
    const root = scope?.workspaceRoot
    return { ...(root === undefined ? {} : { root }), enterCheckout: scope?.enterCheckout === true }
  }

  /**
   * Why this process may not make an `editor/*` request, or null if it may.
   *
   * `ctx.editor` checks the same grants inside the process, but a plugin can
   * write the frame itself and skip `ctx.editor` entirely, so the host checks
   * them again against what it holds: the permissions the person agreed to,
   * never the process's own report. Opening or marking a file shows it, so it
   * takes `workspace.read`; changing one takes `workspace.write`; the plane
   * keeps the path inside the workspace. A write is refused while an agent's
   * tool call runs in this process too: the frame cannot say who asked, and a
   * write on an agent's behalf belongs to that agent's own runtime and its
   * own approval, which is the rule `ctx.editor` holds inside the process.
   */
  #editorRefusal(method: string): string | null {
    const permissions = this.#options.plugin?.permissions
    if (!permissions) return 'This process holds no plugin that may use the editor.'
    if (!permissions.editor) return 'Refused: this plugin was not granted `editor`, so it cannot open or annotate files in the editor.'
    if ((method === 'editor/open' || method === 'editor/decorate') && !permissions.workspace.read) {
      return 'Refused: this plugin was not granted `workspace.read`, so it cannot show a file.'
    }
    if (method === 'editor/applyEdits') {
      if (!permissions.workspace.write) return 'Refused: this plugin was not granted `workspace.write`, so it cannot change a file.'
      if (this.#agentCalls > 0) {
        return 'Refused: an agent cannot write files through a plugin. Editing on an agent’s behalf belongs to that agent’s own runtime, where its own approval applies.'
      }
    }
    return null
  }

  /**
   * One request. If it overruns the deadline the child's event loop is wedged
   * — a plugin spinning — and the only recovery is on this side: kill it. The
   * exit handler fails everything else in flight and schedules the restart.
   */
  async call<M extends PluginHostMethodName>(
    method: M,
    params: PluginHostMethods[M]['params'],
  ): Promise<PluginHostMethods[M]['result']> {
    await this.ensure()
    const iosOwners = this.#iosOwnersFor(method, params)
    const current = this.#iosState()
    // Withhold simulator authority without preventing the invocation itself.
    const iosGranted = iosOwners.length > 0 && await this.#iosGranted() && current()
    let browserInvocation: string | undefined
    const iosInvocations: Record<string, IosInvocationAuthority> = {}
    const iosController = new AbortController()
    let capabilityLease: string | undefined
    if (method === 'tool/invoke') {
      const input = params as PluginHostMethods['tool/invoke']['params']
      const namespaced = this.#namespaced(input.id)
      const owner = this.#plugins.find((plugin) =>
        plugin.contributions.some((entry) => entry.id === namespaced),
      )
      if (
        input.browser &&
        owner?.enabled &&
        owner.contributions.some(
          (entry) => entry.id === namespaced && scopeApplies(entry.scope, input.scope),
        )
      ) {
        const identity = this.#browserInvocations.begin(input.browser.profile, String(owner.instanceId))
        browserInvocation = identity.invocation
        params = { ...params, browser: identity } as PluginHostMethods[M]['params']
      } else if (input.browser) {
        const { browser: _browser, ...plain } = params as PluginHostMethods['tool/invoke']['params']
        params = plain as PluginHostMethods[M]['params']
      }
    } else if (method === 'command/run' || method === 'context/resolve' || method === 'context/resolveOne') {
      // A command or a context read places pages too. The process holds one
      // plugin, so the identity is that plugin's, for this call only.
      const input = params as { readonly browser?: { readonly profile: string } }
      const owner = this.#plugins.length === 1 ? this.#plugins[0] : undefined
      if (input.browser && owner?.enabled) {
        const identity = this.#browserInvocations.begin(input.browser.profile, String(owner.instanceId))
        browserInvocation = identity.invocation
        params = { ...params, browser: identity } as PluginHostMethods[M]['params']
      } else if (input.browser) {
        const { browser: _browser, ...plain } = params as { browser?: unknown }
        params = plain as PluginHostMethods[M]['params']
      }
    }
    if (['tool/invoke','command/run','context/resolve','context/resolveOne','hooks/run','hooks/runOne'].includes(method)) {
      for (const owner of iosOwners) {
        if (!iosGranted) {
          iosInvocations[this.#reportedInstanceId ?? String(owner.instanceId)] = { refused: IOS_NOT_GRANTED }
          continue
        }
        const token = randomUUID()
        iosInvocations[this.#reportedInstanceId ?? String(owner.instanceId)] = token
        this.#iosInvocations.set(token, { owner: String(owner.instanceId), signal: iosController.signal, hold: () => lifetime.hold(), abort: () => iosController.abort() })
      }
      const { iosInvocations: _untrusted, capabilityLease: _forged, ...plain } = params as { iosInvocations?: unknown; capabilityLease?: unknown }
      params = { ...plain, iosInvocations } as PluginHostMethods[M]['params']
      if (this.#capabilities) {
        capabilityLease = randomUUID()
        this.#capabilityLeases.set(capabilityLease, { lease: this.#leaseFor(method, params), hold: () => lifetime.hold() })
        params = { ...params, capabilityLease } as PluginHostMethods[M]['params']
      }
    }
    if (method === 'workspace/set') {
      const state = params as PluginHostMethods['workspace/set']['params']
      this.#capabilities?.setWorkspace({ root: state.root, branch: state.branch, ...(state.admitted ? { admitted: state.admitted } : {}) })
    }
    const armKeys = this.#armedScopesFor(method, params)
    const controller = new AbortController()
    const inputScope = (params as { scope?: ScopeQuery; query?: ScopeQuery }).scope ?? (params as { query?: ScopeQuery }).query ?? {}
    const lifetime: ForgeLease = { controller, resume: AsyncLocalStorage.snapshot(), hold: () => () => {},
      scope: { ...inputScope, actor: method === 'command/run' ? 'human' : method.startsWith('context/') ? 'context' : 'agent' } }
    for (const key of armKeys) {
      const lifetimes = this.#forgeLifetimes.get(key) ?? new Set<ForgeLease>()
      lifetimes.add(lifetime); this.#forgeLifetimes.set(key, lifetimes)
    }
    for (const key of armKeys) this.#teamScopes.set(key, (this.#teamScopes.get(key) ?? 0) + 1)
    const agent = method === 'tool/invoke'
    if (agent) this.#agentCalls += 1
    try {
      return await this.#dispatch(method, params, lifetime)
    } finally {
      if (agent) this.#agentCalls -= 1
      if (capabilityLease) this.#capabilityLeases.delete(capabilityLease)
      iosController.abort()
      for (const value of Object.values(iosInvocations)) if (typeof value === 'string') this.#iosInvocations.delete(value)
      if (browserInvocation) this.#browserInvocations.end(browserInvocation)
      controller.abort()
      for (const key of armKeys) {
        const lifetimes = this.#forgeLifetimes.get(key)
        lifetimes?.delete(lifetime)
        if (!lifetimes?.size) this.#forgeLifetimes.delete(key)
        const count = (this.#teamScopes.get(key) ?? 1) - 1
        if (count <= 0) this.#teamScopes.delete(key)
        else this.#teamScopes.set(key, count)
      }
    }
  }

  #iosState(): () => boolean {
    const child = this.#child, snapshot = this.#plugins
    return () => this.#child === child && this.#plugins === snapshot
  }
  /**
   * Simulator authority for this process. It holds exactly one plugin, so the
   * grant is that plugin's own: the permissions the host read from the
   * manifest the person consented to, never what the process reports.
   */
  async #iosGranted(): Promise<boolean> {
    const consented = this.#options.stillConsented
    // No way to ask is no grant: a process built without the check never
    // reaches the simulator, rather than reaching it unchecked.
    if (this.#child === null || this.#options.plugin?.permissions?.ios !== true || !consented) return false
    try { return await consented() } catch { return false }
  }
  #iosOwnersFor(method: PluginHostMethodName, value: unknown): readonly PluginInstance[] {
    const params = value as Record<string, unknown>
    const hook = params['invocation'] as HookInvocation | undefined
    const scope = (method === 'context/resolve' ? params['query'] : method === 'hooks/run' || method === 'hooks/runOne' ? hook?.scope : params['scope']) as ScopeQuery ?? {}
    return this.#plugins.filter(plugin => plugin.enabled && plugin.permissions.ios && plugin.contributions.some(entry => {
      if (!scopeApplies(entry.scope, scope)) return false
      if (method === 'tool/invoke' || method === 'context/resolveOne' || method === 'hooks/runOne') return entry.id === this.#namespaced(params['id'] as string)
      if (method === 'command/run') return entry.kind === 'command' && entry.name === params['name']
      if (method === 'context/resolve') return entry.kind === 'context' && !entry.chip
      return method === 'hooks/run' && entry.kind === 'hook' && entry.event === hook?.event && (!entry.match || typeof hook.toolName === 'string' && entry.match.includes(hook.toolName))
    }))
  }

  /**
   * The scopes this request arms for `team/*` calls — one per plugin the host
   * is actually dispatching to, and empty when the request carries no
   * conversation.
   *
   * A plugin is armed only if it both holds the `team` grant and is genuinely
   * being invoked: the contribution's owner for a tool call or a single
   * context resolution, the command's owner for `command/run`, and every
   * context provider for `context/resolve`, which really does run them all.
   * The previous version armed the conversation alone whenever *any* enabled
   * plugin held the grant, which handed the whole shared process a live
   * attribution for as long as that plugin existed.
   */
  #armedScopesFor(method: PluginHostMethodName, params: unknown): readonly string[] {
    const record = params as Record<string, unknown>
    const scoped = (value: unknown): { runtime: string; sessionId: string } | null => {
      const query = value as ScopeQuery | undefined
      return query && typeof query.runtime === 'string' && typeof query.sessionId === 'string'
        ? { runtime: query.runtime, sessionId: String(query.sessionId) }
        : null
    }

    let scope: { runtime: string; sessionId: string } | null = null
    let owners: readonly string[] = []
    if (method === 'tool/invoke' || method === 'context/resolveOne') {
      scope = scoped(record['scope'])
      const id = typeof record['id'] === 'string' ? record['id'] : null
      owners = this.#ownersOfContribution(id)
    } else if (method === 'context/resolve') {
      scope = scoped(record['query'])
      // Every context provider is asked, so every one of them is invoked.
      owners = this.#ownersWhere((entry) => entry.kind === 'context')
    } else if (method === 'command/run') {
      scope = scoped(record['scope'])
      const name = typeof record['name'] === 'string' ? record['name'] : null
      owners = this.#ownersWhere(
        (entry) => entry.kind === 'command' && entry.name === name,
      )
    } else {
      return []
    }
    if (!scope) return []
    return owners.map((plugin) => teamScopeKey(scope.runtime, scope.sessionId, plugin))
  }

  /** The team-granted plugin owning a contribution, by its stripped child id. */
  #ownersOfContribution(strippedId: string | null): readonly string[] {
    if (strippedId === null) return []
    const namespaced = this.#namespaced(strippedId)
    return this.#teamPlugins()
      .filter((plugin) => plugin.contributions.some((entry) => entry.id === namespaced))
      .map((plugin) => String(plugin.instanceId))
  }

  /** Team-granted plugins owning a contribution the predicate accepts. */
  #ownersWhere(predicate: (entry: { kind: string; name?: string }) => boolean): readonly string[] {
    return this.#teamPlugins()
      .filter((plugin) =>
        plugin.contributions.some((entry) => predicate(entry as { kind: string; name?: string })),
      )
      .map((plugin) => String(plugin.instanceId))
  }

  /**
   * Whether a child's claim to be a plugin mid-invocation for a conversation
   * is one the parent stands behind, *and* that plugin holds the grant for
   * the plane it is reaching. The arming says the plugin is running; the
   * grant says which plane it may touch. Both are checked, because the
   * arming is shared between the two planes — one live invocation arms a
   * plugin for whichever it is granted — and a forge-only plugin that could
   * write a `team/*` frame while armed would reach the board without the
   * grant the manifest never asked for.
   */
  #armedFor(scope: { readonly runtime?: unknown; readonly sessionId?: unknown; readonly plugin?: unknown; readonly invocation?: unknown }, plane: 'team' | 'forge'): boolean {
    if (typeof scope.runtime !== 'string' || typeof scope.sessionId !== 'string' || typeof scope.plugin !== 'string') {
      return false
    }
    if ((this.#teamScopes.get(teamScopeKey(scope.runtime, scope.sessionId, scope.plugin)) ?? 0) <= 0) return false
    const plugin = this.#plugins.find((entry) => String(entry.instanceId) === scope.plugin)
    if (plugin === undefined || !plugin.enabled || (plane === 'team' ? plugin.permissions.team !== true : !(plugin.permissions.forge === true || typeof plugin.permissions.forge === 'object' && (plugin.permissions.forge.publish || plugin.permissions.forge.write)))) return false
    if (scope.invocation !== undefined) {
      try {
        this.#browserInvocations.resolve(scope.invocation, scope.plugin)
      } catch {
        return false
      }
    }
    return true
  }

  /** The plugins whose scoped engine calls — team or forge — a live invocation arms. */
  #teamPlugins(): readonly PluginInstance[] {
    return this.#plugins.filter(
      (plugin) => plugin.enabled && (plugin.permissions.team || plugin.permissions.forge),
    )
  }

  async #dispatch<M extends PluginHostMethodName>(
    method: M,
    params: PluginHostMethods[M]['params'],
    lease?: ForgeLease,
  ): Promise<PluginHostMethods[M]['result']> {
    // call() has ensured the child and checked authority; do not yield between
    // minting an invocation's capabilities and sending them to that same child.
    const child = this.#child
    if (!child?.stdin?.writable) throw new Error('The plugin host is not running.')
    const id = ++this.#nextId
    const timeoutMs = this.#options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (value: unknown) => void, reject, timer: null }
      const arm = () => {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new Error(`The plugin host did not answer within ${Math.round(timeoutMs / 1000) || 1}s and was restarted. A plugin is monopolising it.`))
          this.#logger.warn?.('plugin host wedged; killing', { method })
          child.kill('SIGKILL')
        }, timeoutMs)
        pending.timer.unref?.()
      }
      let held = 0
      if (lease) lease.hold = () => {
        held++
        if (pending.timer) clearTimeout(pending.timer)
        pending.timer = null
        return () => { if (--held === 0 && this.#pending.has(id)) arm() }
      }
      arm()
      this.#pending.set(id, pending)
      child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  /** Where pages open. Kept, so a child that restarts is told again. */
  setBrowserSettings(settings: BrowserSettingsWire): void {
    this.#browser = settings
    if (this.alive) void this.call('browser/settings', { settings }).catch(() => {})
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    const child = this.#child
    if (!child) return
    // Closing stdin asks politely; the deadline answers for plugins that will not.
    child.stdin?.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 2000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

// ---------------------------------------------------------------- composite

export interface SupervisedExtensionHostOptions {
  readonly logger?: KernelLogger
  readonly invokeTimeoutMs?: number
  readonly requestTimeoutScale?: number
  readonly env?: Readonly<Record<string, string>>
  /** The parent's own browser page for child plugins' `ctx.browser`; see `PluginHostOptions`. */
  readonly iosEngine?: IosCapability
  readonly browserEngine?: BrowserEngine | null
  /** The editor plane for child plugins' `ctx.editor`; see `PluginHostOptions`. */
  readonly editorEngine?: EditorEngine | null
  /**
   * The team plane — the shared board and inter-agent messages. Host-owned
   * for the reason the editor plane is: a child has no session registry to
   * decide a claim against, and no routing guards of its own.
   */
  readonly teamEngine?: TeamEngine | null
  /**
   * The forge plane — the calling conversation's seat and the record of what
   * it published. Host-owned for the reason the team plane is: a child knows
   * no conversation, no model and no transcript.
   */
  readonly forgeEngine?: ForgeEngine | null
  /**
   * The runtimes that may hold a plugin's process to the Node permission
   * model, in order of preference — the Lead's candidates on the desktop.
   * Absent: the runtime this host runs on. The first one whose probe refuses
   * the network, files outside its grants and starting programs is used.
   */
  readonly runtimes?: readonly PluginRuntime[]
  /** False runs every plugin unconfined. Tests that drive a plugin's own I/O turn it off. */
  readonly confine?: boolean
  /** Replaces the probe, for tests. */
  readonly probeRuntime?: PluginRuntimeProber
}

/**
 * The one extension surface the host consumes.
 *
 * Trusted built-ins run in-proc — they are this repository's own code and
 * review gates them, not a proc boundary. Every installed plugin runs in a
 * proc of its own, and one more proc, the installer, inspects, installs
 * and removes packages without importing any. Routing is by contribution id:
 * each installed plugin's ids carry its own prefix, so callers never say which
 * proc they mean. docs/plugin-isolation.md is the design.
 *
 * Failure posture, deliberately asymmetric:
 * - a tool call into a plugin that is down fails with a clear error (the turn
 *   continues; the agent is told the tool is unavailable);
 * - a *hook* whose plugin is down denies (a security review that cannot run
 *   must not silently allow);
 * - context from a plugin that is down is simply absent (context is additive).
 */
export class SupervisedExtensionHost {
  readonly #kernel: ExtensionKernel
  readonly #installer: PluginHostProcess
  /** One entry per installed plugin, in install order, running or not. */
  readonly #members = new Map<string, Member>()
  /** The lifecycle operation each plugin is in, so the next one waits for it. */
  readonly #lifecycle = new Map<string, Promise<void>>()
  readonly #listeners = new Set<(event: ExtensionEvent) => void>()
  readonly #logger: KernelLogger
  readonly #options: SupervisedExtensionHostOptions
  readonly #root: string
  readonly #consent: ConsentRecord
  #engines: { browser: BrowserEngine | null; editor: EditorEngine | null; team: TeamEngine | null; forge: ForgeEngine | null }
  #browserSettings: BrowserSettingsWire | null = null
  #workspace: { root: string | null; branch: string | null; admitted?: readonly string[] } = { root: null, branch: null }
  #browserResolver: (scope: ScopeQuery) => string | undefined = () => 'default'
  #disposed = false
  /** The runtime plugins are confined on, chosen once, at the first start that asks. */
  #runtimeChoice: Promise<PluginRuntimeChoice> | null = null

  constructor(kernel: ExtensionKernel, options: SupervisedExtensionHostOptions = {}) {
    this.#kernel = kernel
    this.#options = options
    this.#logger = options.logger ?? {}
    this.#root = pluginsRoot({ ...process.env, ...options.env })
    this.#consent = new ConsentRecord(consentPath(this.#root))
    this.#engines = {
      browser: options.browserEngine ?? null,
      editor: options.editorEngine ?? null,
      team: options.teamEngine ?? null,
      forge: options.forgeEngine ?? null,
    }
    this.#installer = new PluginHostProcess({
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.invokeTimeoutMs ? { invokeTimeoutMs: options.invokeTimeoutMs } : {}),
      ...(options.requestTimeoutScale !== undefined ? { requestTimeoutScale: options.requestTimeoutScale } : {}),
      ...(options.env ? { env: options.env } : {}),
      onEvent: (event) => this.#emit(event),
    })
    kernel.subscribe((event) => this.#emit(event))
    // The constructor option must reach *both* halves — every plugin proc
    // (through `#engines`) and the in-proc kernel's module state — exactly
    // as the setter does; an option accepted but half-honoured is a builtin
    // plugin whose `ctx.team` quietly points at nothing.
    if (options.teamEngine !== undefined) setTeamEngine(options.teamEngine)
    if (options.forgeEngine !== undefined) setForgeEngine(options.forgeEngine)
  }

  /** Where plugins' processes run confined, or why they do not. */
  #pluginRuntime(): Promise<PluginRuntimeChoice> {
    if (this.#options.confine === false) return Promise.resolve({ runtime: null, reason: 'confinement is off' })
    this.#runtimeChoice ??= choosePluginRuntime(
      this.#options.runtimes ?? [hostPluginRuntime()],
      CHILD_ENTRY,
      ...(this.#options.probeRuntime ? [this.#options.probeRuntime] : []),
    )
    return this.#runtimeChoice
  }

  /** Loads one of the repository's own plugins, in-proc. Not for third-party code. */
  async loadBuiltin(plugin: HarnessPlugin): Promise<void> {
    await this.#kernel.load(plugin)
  }

  /**
   * Starts a proc for every installed plugin, in parallel. One plugin that
   * fails to start is listed with the reason and does not stop the others.
   */
  async loadInstalledPlugins(): Promise<void> {
    const installed = await listInstalled(this.#root)
    const started: Promise<void>[] = []
    for (const entry of installed) {
      // A plugin is the directory it was installed into, never what its
      // manifest says now: the manifest is the plugin's to rewrite, and a
      // plugin that renamed itself would otherwise come back as a plugin
      // nobody agreed to, with no record to hold it to. #start then refuses
      // a manifest that names anything else.
      const id = basename(entry.directory)
      if (this.#members.has(id)) continue
      const member: Member = { id, directory: entry.directory, proc: null, enabled: true, problem: null, config: null, identity: null, configSchema: null, permissions: null, uninstalling: false, generation: 0 }
      this.#members.set(id, member)
      started.push(this.#start(member))
    }
    await Promise.all(started)
  }

  /**
   * Brings one installed plugin's proc up, or says why it is not.
   *
   * An installed plugin does not stand in for a built-in of the same id. This
   * happens for one reason, and it is a good one: a plugin that shipped as an
   * example, and was installed from there, later becomes part of the app.
   * Leaving both loaded hands an agent two `browser_open` tools that differ
   * only by a namespace it never sees. The installed copy is switched off and
   * the reason is logged — nothing is deleted, because uninstalling is the
   * user's to do and their copy may be one they have since edited.
   */
  async #start(member: Member): Promise<void> {
    if (this.#disposed || member.uninstalling) return
    // Each start is a generation. Whatever stops or restarts this plugin
    // while a start is under way moves the generation on, and the start that
    // finds itself overtaken gives up and disposes the process it made, so
    // two starts never leave two processes, and a plugin turned off mid-start
    // stays off.
    const generation = ++member.generation
    const current = (): boolean => !this.#disposed && !member.uninstalling && member.generation === generation
    const previous = member.proc
    member.proc = null
    await previous?.dispose()
    let proc: PluginHostProcess | null = null
    try {
      const { package: pkg, bytes } = await readInstalledManifest(member.directory)
      if (!current()) return
      if (pkg.manifest.id !== member.id) {
        throw new Error(`The manifest in ${member.directory} names ${JSON.stringify(pkg.manifest.id)}, not ${JSON.stringify(member.id)}.`)
      }
      member.identity = {
        id: pkg.manifest.id,
        name: pkg.manifest.name,
        ...(pkg.manifest.description ? { description: pkg.manifest.description } : {}),
        ...(pkg.manifest.version ? { version: pkg.manifest.version } : {}),
        source: pkg.manifest.source ?? { kind: 'local', path: member.directory },
      }
      member.configSchema = pkg.manifest.configSchema ?? null
      if (this.#kernelPluginIds().has(member.id)) {
        member.enabled = false
        this.#logger.warn?.('an installed plugin shadows a built-in of the same id and was switched off', { plugin: member.id })
        return
      }
      if (!member.enabled) {
        // Read-only: a plugin that is off records nothing, but one whose
        // manifest is the agreed one shows what it may do once it is on.
        member.permissions = (await this.#consent.matches(member.id, bytes).catch(() => false))
          ? mergePermissions(pkg.manifest.permissions)
          : null
        return
      }
      // Checked against the bytes the permissions below were parsed from.
      if ((await this.#consent.check(member.id, bytes)) === 'changed') {
        member.permissions = null
        throw new Error(MANIFEST_CHANGED)
      }
      member.permissions = mergePermissions(pkg.manifest.permissions)
      if (!current()) return
      proc = new PluginHostProcess({
        plugin: {
          id: member.id,
          directory: member.directory,
          identity: member.identity,
          permissions: mergePermissions(pkg.manifest.permissions),
        },
        ...(this.#options.logger ? { logger: this.#options.logger } : {}),
        ...(this.#options.invokeTimeoutMs ? { invokeTimeoutMs: this.#options.invokeTimeoutMs } : {}),
        ...(this.#options.requestTimeoutScale !== undefined ? { requestTimeoutScale: this.#options.requestTimeoutScale } : {}),
        ...(this.#options.env ? { env: this.#options.env } : {}),
        ...(this.#options.iosEngine ? { iosEngine: this.#options.iosEngine } : {}),
        ...(this.#engines.browser ? { browserEngine: this.#engines.browser } : {}),
        ...(this.#engines.editor ? { editorEngine: this.#engines.editor } : {}),
        ...(this.#engines.team ? { teamEngine: this.#engines.team } : {}),
        ...(this.#engines.forge ? { forgeEngine: this.#engines.forge } : {}),
        confinement: () => this.#pluginRuntime(),
        // Every restart is held to the record too, not only the first start:
        // a plugin that rewrites its manifest and exits must not come back
        // under the permissions it gave itself.
        beforeStart: async () => {
          const { package: pkg, bytes: now } = await readInstalledManifest(member.directory)
          // Before the record is consulted: a missing record is recorded as
          // agreed, and must not be for a manifest that renamed its plugin.
          if (pkg.manifest.id !== member.id) throw new Error(MANIFEST_CHANGED)
          if ((await this.#consent.check(member.id, now)) === 'changed') throw new Error(MANIFEST_CHANGED)
        },
        stillConsented: async () => this.#consent.matches(member.id, (await readInstalledManifest(member.directory)).bytes),
        onRefused: () => {
          if (member.proc !== proc) return
          this.#emit({ type: 'contributions/changed', owner: installedInstanceId(member.id), revision: 0, contributions: [] })
          this.#emit({ type: 'plugin/updated', plugin: this.#describe(member) })
        },
        onEvent: (event) => this.#emit(
          event.type === 'plugin/added' || event.type === 'plugin/updated'
            ? { type: event.type, plugin: this.#hostLifecycle(member, event.plugin) }
            : event,
        ),
        onSnapshot: () => {
          // The proc (re)announced itself; replay what it cannot know.
          if (this.#workspace.root !== null && proc?.alive) {
            void proc.call('workspace/set', this.#workspace).catch(() => {})
          }
        },
      })
      if (this.#browserSettings) proc.setBrowserSettings(this.#browserSettings)
      member.proc = proc
      member.problem = null
      await proc.loadInstalled()
      if (member.config) await proc.reconfigure(member.config)
      if (!current()) {
        if (member.proc !== proc) await proc.dispose()
        return
      }
    } catch (error) {
      if (!current()) {
        if (proc && member.proc !== proc) await proc.dispose()
        return
      }
      member.problem = error instanceof Error ? error.message : String(error)
      member.proc = null
      await proc?.dispose()
      this.#logger.error?.('installed plugin failed to start', { plugin: member.id, error: member.problem })
    }
    this.#emit({ type: 'plugin/updated', plugin: this.#describe(member) })
  }

  /**
   * Stops a plugin's proc, and any start of it under way. Its contributions
   * are withdrawn at once: the renderer keys them by the plugin's instance
   * id, and a stopped plugin offers nothing.
   */
  async #stop(member: Member): Promise<void> {
    member.generation += 1
    const proc = member.proc
    member.proc = null
    if (!proc) return
    await proc.dispose()
    this.#emit({ type: 'contributions/changed', owner: installedInstanceId(member.id), revision: 0, contributions: [] })
  }

  /**
   * A plugin's report about itself, with the parts the host owns put back.
   *
   * Whether a plugin is on, and its configuration, are the host's: it starts
   * and stops the process and keeps the config. A plugin that reported itself
   * off, or unloaded, while its process ran would show a switch that no longer
   * matched what was running, and turning it "on" again would do nothing. So
   * those come from the member, and of the process's own states only loading,
   * waiting for a service, and a failure of its own are taken; anything else from a running process
   * is active.
   */
  #hostLifecycle(member: Member, reported: PluginInstance): PluginInstance {
    const state = reported.state
    return {
      ...reported,
      state: state?.type === 'failed' ? { type: 'failed', message: String(state.message) }
        : state?.type === 'loading' ? { type: 'loading' }
        : state?.type === 'pending' ? { type: 'pending', waitingFor: Array.isArray(state.waitingFor) ? state.waitingFor.map(String) : [] }
        : { type: 'active' },
      enabled: member.enabled,
      ...(member.config ? { config: member.config } : {}),
    }
  }

  /** What Settings shows for an installed plugin: its proc's report, or what the host knows when it has none. */
  #describe(member: Member): PluginInstance {
    const proc = member.proc
    const reported = proc?.plugins[0]
    const problem = proc?.problem
      ?? (proc?.failed ? `${member.identity?.name ?? member.id} crashed repeatedly and has been stopped. Turn it off and on again to retry.` : null)
      ?? (proc ? null : member.problem)
    if (reported && !problem) return this.#hostLifecycle(member, reported)
    return {
      instanceId: installedInstanceId(member.id),
      identity: member.identity ?? { id: member.id, name: member.id, source: { kind: 'local', path: member.directory } },
      state: problem ? { type: 'failed', message: problem } : { type: 'disposed' },
      revision: reported?.revision ?? 0,
      permissions: member.permissions ?? NO_PLUGIN_PERMISSIONS,
      injects: [],
      provides: [],
      contributions: [],
      enabled: member.enabled,
      ...(member.configSchema ? { configSchema: member.configSchema } : {}),
      ...(member.config ? { config: member.config } : {}),
    }
  }

  /** Each proc's figures, and their sum: the cost of a heavy plugin is visible and attributed. */
  async stats(): Promise<PluginHostStats> {
    const running = [...this.#members.values()].filter((member) => member.proc?.alive)
    const each = await Promise.all(running.map(async (member) => {
      try {
        const proc = member.proc!
        return { plugin: member.id, confinement: proc.confinement, ...(await proc.call('host/stats', {})) }
      } catch {
        return null
      }
    }))
    const processes = each.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    const invocations: Record<string, number> = {}
    for (const entry of processes) {
      for (const [key, count] of Object.entries(entry.invocations)) invocations[key] = (invocations[key] ?? 0) + count
    }
    return {
      pid: processes[0]?.pid ?? 0,
      rssBytes: processes.reduce((sum, entry) => sum + entry.rssBytes, 0),
      activeHandles: processes.reduce((sum, entry) => sum + entry.activeHandles, 0),
      invocations,
      processes: processes.map(({ plugin, pid, rssBytes, activeHandles, confinement }) => ({
        plugin,
        pid,
        rssBytes,
        activeHandles,
        ...(confinement ? { confinement } : {}),
      })),
    }
  }

  // ---------------------------------------------------- CapabilityRegistry

  list<K extends ContributionKind>(
    kind: K,
    query?: ScopeQuery,
  ): readonly Extract<CapabilityContribution, { kind: K }>[] {
    if (query) query = canonicalScopeQuery(query)
    const applies = (contribution: CapabilityContribution): boolean =>
      contribution.kind === kind && (!query || scopeApplies(contribution.scope, query))
    return [
      ...this.#kernel.list(kind, query),
      ...(this.#installedContributions().filter(applies) as unknown as readonly Extract<
        CapabilityContribution,
        { kind: K }
      >[]),
    ]
  }

  plugins(): readonly PluginInstance[] {
    return [...this.#kernel.plugins(), ...[...this.#members.values()].map((member) => this.#describe(member))]
  }

  #shellWorkspaceResolver: (scope: ScopeQuery) => Promise<WorkspaceAdmission | undefined> = async (scope) => scope.workspaceRoot === undefined
    ? undefined : { root: scope.workspaceRoot, enterCheckout: scope.enterCheckout === true }

  /** Resolve in the parent: installed plugins never get a shell-root setter. */
  setShellWorkspaceResolver(resolve: (scope: ScopeQuery) => Promise<WorkspaceAdmission | undefined>): void {
    this.#shellWorkspaceResolver = resolve
    this.#kernel.setShellWorkspaceResolver(resolve)
  }

  async #shellScope(scope: ScopeQuery): Promise<ScopeQuery> {
    const { workspaceRoot: _hint, enterCheckout: _mode, ...identity } = scope
    const admitted = await this.#shellWorkspaceResolver(scope)
    const workspaceRoot = typeof admitted === 'string' ? admitted : admitted?.root
    const enterCheckout = typeof admitted === 'object' && admitted.enterCheckout
    return Object.freeze(canonicalScopeQuery({ ...identity, ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(enterCheckout ? { enterCheckout: true } : {}) }))
  }

  setBrowserResolver(resolve: (scope: ScopeQuery) => string | undefined): void {
    this.#browserResolver = resolve
    this.#kernel.setBrowserResolver(resolve)
  }

  async invokeTool(id: ContributionId, args: unknown, scope: ScopeQuery): Promise<ToolResult> {
    if (this.#ownsInProcess(id)) return this.#kernel.invokeTool(id, args, scope)
    const proc = this.#processFor(id)
    if (!proc) return { ok: false, error: `No tool is registered with id ${String(id)}` }
    scope = await this.#shellScope(scope)
    try {
      const profile = this.#browserResolver(scope)
      return await proc.call('tool/invoke', {
        id: proc.strip(id),
        args,
        scope,
        ...(profile ? { browser: { invocation: 'pending-parent-lease', profile } } : {}),
      })
    } catch (error) {
      // The failure is the answer: the turn goes on, told plainly why.
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Built-ins first, then every installed plugin's matching hooks, ordered by
   * priority across processes exactly as they are ordered within one, each run
   * in its own plugin's proc. The first `deny` or `ask` decides.
   */
  async runHooks(invocation: HookInvocation): Promise<HookVerdict> {
    const own = await this.#kernel.runHooks(invocation)
    if (own.decision !== 'allow') return own
    const query = invocation.scope ? canonicalScopeQuery(invocation.scope) : undefined
    const matching = [...this.#members.values()]
      .flatMap((member) => (member.enabled && member.proc ? member.proc.contributions : [])
        .filter((entry): entry is Extract<CapabilityContribution, { kind: 'hook' }> => entry.kind === 'hook')
        .filter((hook) => hook.event === invocation.event)
        .filter((hook) => !hook.match || (invocation.toolName !== undefined && hook.match.includes(invocation.toolName)))
        .filter((hook) => !query || scopeApplies(hook.scope, query))
        .map((hook) => ({ hook, proc: member.proc! })))
    // A stable sort: equal priorities keep install order, then registration order.
    matching.sort((a, b) => a.hook.priority - b.hook.priority)
    for (const { hook, proc } of matching) {
      try {
        const verdict = await proc.call('hooks/runOne', { id: proc.strip(hook.id), invocation })
        if (verdict.decision !== 'allow') return verdict
      } catch (error) {
        // Fail closed: a review that could not run must not read as approval.
        return {
          decision: 'deny',
          reason: `A plugin hook could not run: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    return own
  }

  /** Every installed plugin that provides context is asked at once; the answers keep install order. */
  async resolveContext(query: ScopeQuery): Promise<readonly { label: string; text: string }[]> {
    const own = await this.#kernel.resolveContext(query)
    query = await this.#shellScope(query)
    const providers = [...this.#members.values()].filter((member) =>
      member.enabled && member.proc?.contributions.some((entry) => entry.kind === 'context'))
    const answers = await Promise.all(providers.map(async (member) => {
      try {
        const profile = this.#browserResolver(query)
        return await member.proc!.call('context/resolve', { query, ...(profile ? { browser: { invocation: 'pending-parent-lease', profile } } : {}) })
      } catch {
        return []
      }
    }))
    return [...own, ...answers.flat()]
  }

  async resolveOne(
    id: ContributionId,
    ref: string | undefined,
    scope: ScopeQuery,
  ): Promise<{ label: string; text: string; image?: ContextImage } | null> {
    if (this.#ownsInProcess(id)) return this.#kernel.resolveOne(id, ref, scope)
    const proc = this.#processFor(id)
    if (!proc) return null
    scope = await this.#shellScope(scope)
    const profile = this.#browserResolver(scope)
    return proc.call('context/resolveOne', {
      id: proc.strip(id), ...(ref === undefined ? {} : { ref }), scope,
      ...(profile ? { browser: { invocation: 'pending-parent-lease', profile } } : {}),
    })
  }

  subscribe(listener: (event: ExtensionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  // -------------------------------------------------------- ExtensionHost

  /** Turning an installed plugin off stops its proc; turning it on starts a fresh one. */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (this.#kernelPluginIds().has(pluginId)) return this.#kernel.setEnabled(pluginId, enabled)
    const member = this.#members.get(pluginId)
    if (!member) return
    if (member.uninstalling) throw new Error(`${member.identity?.name ?? pluginId} is being uninstalled.`)
    return this.#serially(pluginId, () => this.#setEnabled(member, enabled))
  }

  async #setEnabled(member: Member, enabled: boolean): Promise<void> {
    if (member.uninstalling || this.#members.get(member.id) !== member) {
      throw new Error(`${member.identity?.name ?? member.id} is being uninstalled.`)
    }
    if (!enabled) {
      member.enabled = false
      member.problem = null
      await this.#stop(member)
      this.#emit({ type: 'plugin/updated', plugin: this.#describe(member) })
      return
    }
    if (member.enabled && member.proc && !member.proc.failed && !member.proc.problem) return
    member.enabled = true
    await this.#start(member)
  }

  /** Kept by the host and replayed into every restart of that plugin's proc. */
  async reconfigure(pluginId: string, config: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#kernelPluginIds().has(pluginId)) return this.#kernel.reconfigure(pluginId, config)
    const member = this.#members.get(pluginId)
    if (!member) return
    member.config = config
    if (member.proc) await member.proc.reconfigure(config)
  }

  async runCommand(
    name: string,
    argument: string,
    scope: { sessionId?: SessionId },
  ): Promise<boolean> {
    if (await this.#kernel.runCommand(name, argument, scope)) return true
    const owner = [...this.#members.values()].find((member) =>
      member.enabled && member.proc?.contributions.some((entry) => entry.kind === 'command' && entry.name === name))
    if (!owner?.proc) return false
    // The command exists over there; a failure is an answer, not an absence.
    const profile = this.#browserResolver(scope)
    const { handled } = await owner.proc.call('command/run', {
      name, argument, scope,
      ...(profile ? { browser: { invocation: 'pending-parent-lease', profile } } : {}),
    })
    return handled
  }

  /**
   * Where an agent's pages open. Every side is told: built-ins run here,
   * installed plugins run in their own processes, and none may disagree about
   * which browser they are driving.
   */
  setBrowserSettings(settings: BrowserSettings): void {
    this.#kernel.setBrowserSettings(settings)
    this.#browserSettings = {
      placement: settings.placement,
      ...(settings.binary === undefined ? {} : { binary: settings.binary }),
      ...(settings.keepProfile === undefined ? {} : { keepProfile: settings.keepProfile }),
      ...(settings.profileDir === undefined ? {} : { profileDir: settings.profileDir }),
    }
    for (const proc of this.#processes()) proc.setBrowserSettings(this.#browserSettings)
  }

  /**
   * The editor plane, to every side.
   *
   * Built-ins run in this proc and reach it through the module-level
   * engine; installed plugins reach it by forwarding. Told separately for the
   * same reason browser settings are: none may disagree about which plane
   * they are driving.
   */
  setEditorEngine(engine: EditorEngine | null): void {
    setEditorEngine(engine)
    this.#engines.editor = engine
    for (const proc of this.#processes()) proc.setEditorEngine(engine)
  }

  /** The team plane, to every side — the editor plane's reasoning, verbatim. */
  setTeamEngine(engine: TeamEngine | null): void {
    setTeamEngine(engine)
    this.#engines.team = engine
    for (const proc of this.#processes()) proc.setTeamEngine(engine)
  }

  /** The forge plane, to every side, for the same reason. */
  setForgeEngine(engine: ForgeEngine | null): void {
    setForgeEngine(engine)
    this.#engines.forge = engine
    for (const proc of this.#processes()) proc.setForgeEngine(engine)
  }

  setWorkspace(state: { root: string | null; branch: string | null; admitted?: readonly string[] }): void {
    this.#workspace = state
    this.#kernel.setWorkspace(state)
    for (const proc of this.#processes()) {
      if (proc.alive) void proc.call('workspace/set', state).catch(() => {})
    }
  }

  /**
   * Read in the installer proc: nothing from the package is imported. That
   * proc runs no plugins, so whether one with this id is already installed,
   * and would be replaced, is the host's to answer from its own inventory.
   */
  async inspectPlugin(specifier: string): Promise<InspectedPlugin> {
    const inspected = await this.#installer.call('plugin/inspect', { specifier })
    return {
      ...inspected,
      alreadyInstalled: this.#members.has(inspected.id),
    }
  }

  /**
   * The installer copies the package into place; the host records the
   * manifest the person agreed to, then starts the plugin in a proc of its
   * own. An older version's proc is stopped first.
   *
   * `manifestDigest` is the digest `inspectPlugin` reported for the manifest
   * the person was shown. The install is refused unless the copy it makes
   * has exactly that manifest, and that digest, not the copy's, is what the
   * consent record keeps.
   */
  async installPlugin(specifier: string, manifestDigest: string): Promise<string> {
    // An older version of the same plugin stops before its files are
    // replaced: a process left running through the install could rewrite the
    // new manifest before the host records it. The id comes from inspecting
    // the package, which runs none of its code.
    const inspected = await this.#installer.call('plugin/inspect', { specifier })
    if (inspected.manifestDigest !== manifestDigest) {
      throw new Error(
        `The manifest of ${inspected.id} changed after it was shown to you, so nothing was installed. ` +
          'Read it again before installing.',
      )
    }
    if (this.#members.get(inspected.id)?.uninstalling) {
      throw new Error(`${inspected.name} is being uninstalled; install it again once that is done.`)
    }
    return this.#serially(inspected.id, () => this.#install(inspected.id, inspected.name, specifier, manifestDigest))
  }

  async #install(id: string, name: string, specifier: string, manifestDigest: string): Promise<string> {
    const existing = this.#members.get(id)
    if (existing?.uninstalling) throw new Error(`${name} is being uninstalled; install it again once that is done.`)
    if (existing) await this.#stop(existing)
    // The record is written before the copy replaces anything. A record that
    // cannot be written then leaves the installed version's files as they
    // were, and a copy that fails puts the earlier entry back, so the version
    // that was running still matches what the person agreed to for it.
    let previous: string | undefined
    try {
      previous = await this.#consent.record(id, manifestDigest)
    } catch (error) {
      if (existing?.enabled) await this.#start(existing)
      throw error
    }
    try {
      const installed = await this.#installer.call('plugin/install', { specifier, manifestDigest })
      if (installed.id !== id) throw new Error(`The package installed as ${JSON.stringify(installed.id)}, not ${JSON.stringify(id)}.`)
    } catch (error) {
      // The install did not happen, so the version that was running comes back.
      await this.#consent.restore(id, previous).catch((restoreError: unknown) =>
        this.#logger.error?.('the plugin consent record could not be put back', { plugin: id, error: String(restoreError) }),
      )
      if (existing?.enabled) await this.#start(existing)
      throw error
    }
    const directory = join(this.#root, id)
    const member = this.#members.get(id) ?? { id, directory, proc: null, enabled: true, problem: null, config: null, identity: null, configSchema: null, permissions: null, uninstalling: false, generation: 0 }
    this.#members.set(id, member)
    if (member !== existing && existing) await this.#stop(existing)
    member.directory = directory
    member.enabled = true
    member.problem = null
    await this.#start(member)
    return id
  }

  /**
   * Removes an installed plugin's copy from disk.
   *
   * The check is "is there a copy on disk", not "is this id also a built-in".
   * They come apart in exactly the case `#start` switches off: a plugin
   * installed from the examples before it shipped as part of the app leaves a
   * copy behind under the same id, and refusing to remove it because a
   * built-in now answers to that id left the only thing that resolves the
   * situation permanently disabled.
   */
  async uninstallPlugin(pluginId: string): Promise<void> {
    const member = this.#members.get(pluginId)
    if (!member) {
      throw new Error('Built-in plugins are part of HarnessDesk and cannot be uninstalled.')
    }
    if (member.uninstalling) throw new Error(`${member.identity?.name ?? pluginId} is already being uninstalled.`)
    // Marked at once, so a switch flipped or an install made from here on is
    // refused rather than queued behind the removal; one already under way
    // finishes first, and nothing it starts outlives what follows.
    member.uninstalling = true
    return this.#serially(pluginId, () => this.#uninstall(member))
  }

  async #uninstall(member: Member): Promise<void> {
    const pluginId = member.id
    // Off first, so nothing restarts it while its files go.
    member.enabled = false
    await this.#stop(member)
    try {
      await this.#installer.call('plugin/uninstall', { pluginId })
    } catch (error) {
      member.uninstalling = false
      member.problem = `It could not be removed: ${error instanceof Error ? error.message : String(error)}`
      this.#emit({ type: 'plugin/updated', plugin: this.#describe(member) })
      throw error
    }
    // The files are gone, so the plugin is too, whatever happens to its
    // entry in the record. One left behind grants nothing new: a later install
    // of the same id writes its own before it copies anything.
    this.#members.delete(pluginId)
    this.#emit({ type: 'plugin/removed', instanceId: installedInstanceId(pluginId) })
    await this.#consent.forget(pluginId).catch((error: unknown) =>
      this.#logger.error?.('the plugin consent record could not forget an uninstalled plugin', { plugin: pluginId, error: String(error) }),
    )
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.all([this.#installer.dispose(), ...[...this.#members.values()].map((member) => member.proc?.dispose())])
    await this.#kernel.dispose()
  }

  // ------------------------------------------------------------------ private

  /**
   * Installs, uninstalls and switches of one plugin, one at a time. Each of
   * them awaits the installer or a process, and one that read the member
   * before another's await and acted after it would undo what the other did:
   * an uninstall landing while an install copied files was followed by the
   * install starting the plugin it had just removed.
   */
  #serially<T>(pluginId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.#lifecycle.get(pluginId) ?? Promise.resolve()).then(work, work)
    const settled = next.then(() => undefined, () => undefined)
    this.#lifecycle.set(pluginId, settled)
    void settled.then(() => {
      if (this.#lifecycle.get(pluginId) === settled) this.#lifecycle.delete(pluginId)
    })
    return next
  }

  #processes(): PluginHostProcess[] {
    return [...this.#members.values()].flatMap((member) => (member.proc ? [member.proc] : []))
  }

  #installedContributions(): readonly CapabilityContribution[] {
    return [...this.#members.values()].flatMap((member) => (member.enabled && member.proc ? member.proc.contributions : []))
  }

  /** The proc that answers a namespaced id, by the prefix it carries. */
  #processFor(id: ContributionId): PluginHostProcess | null {
    for (const member of this.#members.values()) {
      if (member.enabled && member.proc?.owns(id)) return member.proc
    }
    return null
  }

  #ownsInProcess(id: ContributionId): boolean {
    if (String(id).startsWith('plugin:')) return false
    return this.#kernel
      .plugins()
      .some((plugin) => plugin.contributions.some((entry) => entry.id === id))
  }

  #kernelPluginIds(): Set<string> {
    return new Set(this.#kernel.plugins().map((plugin) => plugin.identity.id))
  }

  #emit(event: ExtensionEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}

/** An installed plugin, as the host keeps it: its directory, and its proc when it has one. */
interface Member {
  readonly id: string
  directory: string
  proc: PluginHostProcess | null
  enabled: boolean
  /** Why it is not running, when it should be. */
  problem: string | null
  config: Readonly<Record<string, unknown>> | null
  identity: PluginIdentity | null
  /** The settings form its manifest declares, kept so a stopped plugin can still be configured. */
  configSchema: JsonSchema | null
  /**
   * What it may do, from the last manifest checked against the record, so a
   * stopped plugin still shows the access it gets back when it is turned on.
   * Null until a manifest has matched: one that did not was never agreed to.
   */
  permissions: PluginPermissions | null
  /** Set while it is being removed: nothing may start it again. */
  uninstalling: boolean
  /** Moves on with every start and stop; a start that finds it moved was overtaken. */
  generation: number
}

const isRecord = (value: unknown): value is Record<string, unknown> & object =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The instance id the host gives an installed plugin, the same in every process it runs in. */
export const installedInstanceId = (id: string): PluginInstanceId => pluginInstanceId(`${id}#installed`)

const MANIFEST_CHANGED =
  'Its manifest has changed since it was installed. Install it again to review what it asks for; it stays off until then.'

/** What a plugin with no agreed manifest is shown to hold: nothing. */
const NO_PLUGIN_PERMISSIONS: PluginPermissions = mergePermissions(undefined)

/**
 * The environment a plugin's `ctx.shell` programs run with, from scratch:
 * what finding a program and reaching the network from where the person is
 * needs — search path, home, proxy and the certificates it presents — and
 * locale and time. Never the host's tokens, and never `NODE_OPTIONS`.
 */
const SHELL_ENVIRONMENT = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  'HARNESSDESK_HOME', 'HARNESSDESK_PLUGINS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
] as const

/**
 * A plugin process's own environment: less again. Its files, network and
 * programs are served by the host (docs/plugin-isolation.md, layer 4), so it
 * keeps only where plugins live, locale, time and the temporary directory —
 * not the search path, home, proxy or certificates the shell's programs get.
 */
const PROCESS_ENVIRONMENT = [
  'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  'HARNESSDESK_HOME', 'HARNESSDESK_PLUGINS', 'SystemRoot', 'windir',
] as const

const fromScratch = (
  names: readonly string[],
  extra: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const { NODE_OPTIONS: _never, ...rest } = extra ?? {}
  // Last, so nothing passed in can make the process a second app.
  return { ...env, ...rest, ELECTRON_RUN_AS_NODE: '1' }
}

/** What a plugin's `ctx.shell` programs run with. */
export const pluginEnvironment = (extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv =>
  fromScratch(SHELL_ENVIRONMENT, extra)

/** What a plugin's own process starts with. */
export const pluginProcessEnvironment = (extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv =>
  fromScratch(PROCESS_ENVIRONMENT, extra)

/**
 * Unambiguous for any runtime/session/plugin triple, and plain ASCII in the
 * source. Each process runs one plugin now, so the plugin part is always that
 * process's own; it stays in the key so a lease can never be read as another
 * plugin's.
 */
const teamScopeKey = (runtime: string, sessionId: string, plugin: string): string =>
  JSON.stringify([runtime, sessionId, plugin])

/**
 * The installer's ids, which it never has: it loads no plugin. A plugin's own
 * process namespaces its ids `plugin:<id>:` instead (`PluginHostProcess.owns`),
 * so they can never collide with the in-process kernel's or another plugin's.
 */
const CHILD_ID_PREFIX = 'child:'

