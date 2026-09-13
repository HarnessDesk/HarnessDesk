import { Context } from '@deepseek-ai/cordis'

import { asActor } from './provenance.js'
import {
  NO_PERMISSIONS,
  pluginInstanceId,
  scopeApplies,
  type CapabilityContribution,
  type CapabilityRegistry,
  type ContextImage,
  type ContributionId,
  type ContributionKind,
  type ExtensionEvent,
  type HookInvocation,
  type HookVerdict,
  type JsonSchema,
  type PluginIdentity,
  type PluginInstance,
  type PluginInstanceId,
  type PluginPermissions,
  type PluginSource,
  type PluginState,
  type ScopeQuery,
  type ToolResult,
} from '@harnessdesk/protocol'

import { FsService, HttpService, ShellService, WorkspaceService } from './capabilities.js'
import { BrowserService, setBrowserSettings, type BrowserSettings } from './browser.js'
import { EditorService } from './editor.js'
import { TeamService } from './team.js'
import { ForgeService } from './forge.js'
import { IosService } from './ios.js'
import { AndroidService } from './android.js'
import { install, inspect, listInstalled, loadInstalled, uninstall } from './installer.js'
import { describePermissions } from './manifest.js'
import { PermissionDenied } from './permissions.js'
import { ALL_PERMISSIONS, HostRuntime, type WorkspaceState } from './runtime.js'
import {
  CommandsService,
  ContextService,
  HooksService,
  PluginInfoService,
  ToolsService,
  UiService,
} from './services.js'
import { ContributionStore } from './store.js'

/**
 * The extension kernel.
 *
 * Owns one Cordis root context, installs HarnessDesk's services onto it, and
 * loads plugins as Cordis fibers. It implements `CapabilityRegistry` so the rest
 * of HarnessDesk can consume contributions without importing Cordis — the same
 * anti-corruption boundary `adapter-codex` draws around Codex.
 */

/** Cordis `FiberState`, which is a const enum and so not importable at runtime. */
const FIBER = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

export interface PluginManifest {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly source?: PluginSource
  /** Anything not declared is denied. */
  readonly permissions?: Partial<PluginPermissions>
  readonly configSchema?: JsonSchema
}

/** A Cordis plugin plus the manifest that governs what it may do. */
export interface HarnessPlugin {
  readonly manifest: PluginManifest
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly plugin: any
  readonly config?: Readonly<Record<string, unknown>>
}

export interface KernelLogger {
  debug?(message: string, details?: unknown): void
  info?(message: string, details?: unknown): void
  warn?(message: string, details?: unknown): void
  error?(message: string, details?: unknown): void
}

export interface KernelOptions {
  readonly logger?: KernelLogger
  /** Plugins listed here run fully trusted. Reserved for HarnessDesk's own features. */
  readonly trusted?: readonly string[]
}

interface Loaded {
  readonly instanceId: PluginInstanceId
  readonly identity: PluginIdentity
  readonly permissions: PluginPermissions
  readonly configSchema?: JsonSchema
  config: Readonly<Record<string, unknown>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definition: HarnessPlugin
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fiber: any | null
  enabled: boolean
  injects: string[]
  provides: string[]
}

const mergePermissions = (
  requested: Partial<PluginPermissions> | undefined,
): PluginPermissions => ({
  workspace: { ...NO_PERMISSIONS.workspace, ...requested?.workspace },
  shell: requested?.shell ?? false,
  network: { hosts: requested?.network?.hosts ?? [] },
  agents: { invoke: requested?.agents?.invoke ?? false },
  ui: { contribute: requested?.ui?.contribute ?? false },
  browser: requested?.browser ?? false,
  ios: requested?.ios ?? false,
  android: requested?.android ?? false,
  editor: requested?.editor ?? false,
  team: requested?.team ?? false,
  forge: requested?.forge ?? false,
  secrets: requested?.secrets ?? [],
})

export class ExtensionKernel implements CapabilityRegistry {
  readonly #root: Context
  readonly #store = new ContributionStore()
  readonly #runtime: HostRuntime
  readonly #plugins = new Map<string, Loaded>()
  /** The host's own services, in the order they were installed. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly #services: any[] = []
  readonly #logger: KernelLogger
  readonly #trusted: Set<string>
  #counter = 0

  /** One host service on the root, kept so that `dispose` can stop it. */
  #install(service: Parameters<Context['plugin']>[0]): void {
    this.#services.push(this.#root.plugin(service))
  }

  constructor(options: KernelOptions = {}) {
    this.#logger = options.logger ?? {}
    this.#trusted = new Set(options.trusted ?? [])
    this.#root = new Context()
    this.#runtime = new HostRuntime(this.#store)

    // Services are installed on the root, so every plugin can inject them.
    const runtime = this.#runtime
    this.#install(class extends ToolsService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends HooksService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends ContextService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends CommandsService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends UiService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends FsService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends HttpService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends ShellService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends BrowserService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends EditorService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends TeamService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends ForgeService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends IosService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends AndroidService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends WorkspaceService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
    this.#install(class extends PluginInfoService {
      constructor(ctx: Context) {
        super(ctx, runtime)
      }
    })
  }

  /** The Cordis root. Exposed for tests and for hosting sub-kernels. */
  get context(): Context {
    return this.#root
  }

  setWorkspace(state: WorkspaceState): void {
    this.#runtime.setWorkspace(state)
  }

  /**
   * Where an agent's pages open. The browser service is module state — one
   * driven browser per process — so this is a process-wide answer, which is
   * exactly right: two plugins pointing at two different browsers would be
   * two answers to a question the user asked once.
   */
  setBrowserSettings(settings: BrowserSettings): void {
    setBrowserSettings(settings)
  }

  // ------------------------------------------------------------ plugin lifecycle

  async load(definition: HarnessPlugin): Promise<PluginInstanceId> {
    const manifest = definition.manifest
    if (this.#plugins.has(manifest.id)) {
      throw new Error(`A plugin with id ${JSON.stringify(manifest.id)} is already loaded.`)
    }

    const instanceId = pluginInstanceId(`${manifest.id}#${++this.#counter}`)
    const permissions = this.#trusted.has(manifest.id)
      ? ALL_PERMISSIONS
      : mergePermissions(manifest.permissions)

    const entry: Loaded = {
      instanceId,
      identity: {
        id: manifest.id,
        name: manifest.name,
        ...(manifest.description ? { description: manifest.description } : {}),
        ...(manifest.version ? { version: manifest.version } : {}),
        source: manifest.source ?? { kind: 'builtin' },
      },
      permissions,
      ...(manifest.configSchema ? { configSchema: manifest.configSchema } : {}),
      config: definition.config ?? {},
      definition,
      fiber: null,
      enabled: true,
      injects: normaliseInject(definition.plugin),
      provides: normaliseProvide(definition.plugin),
    }
    this.#plugins.set(manifest.id, entry)

    await this.#start(entry)
    this.#store.emit({ type: 'plugin/added', plugin: this.#describe(entry) })
    return instanceId
  }

  async #start(entry: Loaded): Promise<void> {
    this.#store.beginRevision(entry.instanceId)

    // Ownership is planted on the plugin's own context before it is loaded, so
    // the first thing `apply()` registers is already attributed correctly.
    // Every child context the plugin creates inherits it.
    const { meta } = this.#runtime.register(entry.instanceId, entry.permissions)
    const scope = this.#root.extend(meta)

    try {
      const fiber = scope.plugin(entry.definition.plugin, entry.config as never)
      entry.fiber = fiber
      await Promise.resolve(fiber)
    } catch (error) {
      this.#logger.error?.('plugin failed to load', {
        plugin: entry.identity.id,
        error: String(error),
      })
    }
    this.#store.commit(entry.instanceId)
  }

  async unload(id: string): Promise<void> {
    const entry = this.#plugins.get(id)
    if (!entry) return
    await this.#stop(entry)
    this.#plugins.delete(id)
    this.#store.emit({ type: 'plugin/removed', instanceId: entry.instanceId })
  }

  async #stop(entry: Loaded): Promise<void> {
    const fiber = entry.fiber
    entry.fiber = null
    if (fiber) {
      try {
        await fiber.dispose()
      } catch (error) {
        this.#logger.warn?.('plugin disposal threw', {
          plugin: entry.identity.id,
          error: String(error),
        })
      }
    }
    // Cordis withdraws effect-bound registrations on its own; this catches
    // anything a plugin registered outside an effect.
    this.#store.removeOwner(entry.instanceId)
    this.#runtime.forget(entry.instanceId)
  }

  /** Disabling stops the fiber but keeps the plugin listed, so it can come back. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.#plugins.get(id)
    if (!entry || entry.enabled === enabled) return
    entry.enabled = enabled
    if (enabled) await this.#start(entry)
    else await this.#stop(entry)
    this.#store.emit({ type: 'plugin/updated', plugin: this.#describe(entry) })
  }

  /** Reloads with new config. The contribution set swaps as one revision. */
  async reconfigure(id: string, config: Readonly<Record<string, unknown>>): Promise<void> {
    const entry = this.#plugins.get(id)
    if (!entry) return
    entry.config = config
    if (!entry.enabled) return
    await this.#stop(entry)
    await this.#start(entry)
    this.#store.emit({ type: 'plugin/updated', plugin: this.#describe(entry) })
  }

  async dispose(): Promise<void> {
    for (const entry of [...this.#plugins.values()]) await this.#stop(entry)
    this.#plugins.clear()
    /* Then the host's own services, newest first. Stopping only the plugins
       left every effect a service registered on its own scope running past
       the quit, the browser's shutdown among them: the one that ends the CDP
       connection and removes a profile that was never meant to be kept. */
    for (const fiber of this.#services.splice(0).reverse()) {
      try {
        await fiber.dispose()
      } catch (error) {
        this.#logger.warn?.('service disposal threw', { error: String(error) })
      }
    }
  }

  // ------------------------------------------------------- CapabilityRegistry

  list<K extends ContributionKind>(
    kind: K,
    query: ScopeQuery = {},
  ): readonly Extract<CapabilityContribution, { kind: K }>[] {
    return this.#store.list(kind, query)
  }

  plugins(): readonly PluginInstance[] {
    return [...this.#plugins.values()].map((entry) => this.#describe(entry))
  }

  readonly #invocations = new Map<string, number>()

  /** Tool invocations served per plugin instance: the isolation accounting. */
  invocationCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.#invocations)
  }

  async invokeTool(id: ContributionId, args: unknown, scope: ScopeQuery): Promise<ToolResult> {
    const entry = this.#store.get(id)
    if (!entry?.executor) {
      return { ok: false, error: `No tool is registered with id ${String(id)}` }
    }
    /* `list` has always applied the contribution's scope; invoking one by id
       did not, so a tool scoped to one conversation or workspace answered for
       whoever held the id. Nothing offers it out of scope now, and this is the
       half that does not depend on the caller having asked the right question. */
    if (!scopeApplies(entry.contribution.scope, scope)) {
      return { ok: false, error: 'That tool is not available in this scope.' }
    }
    const owner = String(entry.contribution.owner)
    this.#invocations.set(owner, (this.#invocations.get(owner) ?? 0) + 1)
    try {
      // Tools are what agents call — nothing else reaches this method — so the
      // cause travels with the call and `ctx.editor` can refuse a write that
      // is really an agent's. See `provenance.ts` and the editor-plane decision.
      return await asActor('agent', () => entry.executor!(args, scope))
    } catch (error) {
      if (error instanceof PermissionDenied) {
        return { ok: false, error: error.message }
      }
      this.#logger.warn?.('plugin tool threw', { id: String(id), error: String(error) })
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Runs matching hooks in priority order and returns the first non-allow
   * verdict. A hook that overruns its deadline is skipped rather than awaited,
   * because a hung hook would hang the turn.
   */
  async runHooks(invocation: HookInvocation): Promise<HookVerdict> {
    const matching = this.#store
      .list('hook', invocation.scope)
      .filter((hook) => hook.event === invocation.event)
      .filter((hook) => !hook.match || (invocation.toolName && hook.match.includes(invocation.toolName)))
      .sort((a, b) => a.priority - b.priority)

    for (const hook of matching) {
      const handler = this.#store.get(hook.id)?.hook
      if (!handler) continue
      try {
        const verdict = await withTimeout(handler(invocation), hook.timeoutMs)
        if (!verdict || verdict.decision === 'allow') continue
        return verdict.decision === 'deny'
          ? { decision: 'deny', reason: verdict.reason }
          : { decision: 'ask', reason: verdict.reason }
      } catch (error) {
        this.#logger.warn?.('hook failed; treating as allow', {
          event: hook.event,
          error: String(error),
        })
      }
    }
    return { decision: 'allow' }
  }

  async resolveContext(query: ScopeQuery): Promise<readonly { label: string; text: string }[]> {
    const out: { label: string; text: string }[] = []
    for (const contribution of this.#store.list('context', query)) {
      // A chip is attached on purpose; it does not ride every turn.
      if (contribution.chip) continue
      const resolver = this.#store.get(contribution.id)?.resolver
      if (!resolver) continue
      try {
        const text = await withTimeout(Promise.resolve(resolver(query)), 5_000)
        if (typeof text === 'string' && text.trim().length > 0) {
          out.push({ label: contribution.label, text })
        }
      } catch (error) {
        this.#logger.warn?.('context provider failed', {
          label: contribution.label,
          error: String(error),
        })
      }
    }
    return out
  }

  /** One context provider, resolved because the user attached its chip. */
  async resolveOne(
    id: ContributionId,
    ref: string | undefined,
    scope: ScopeQuery,
  ): Promise<{ label: string; text: string; image?: ContextImage } | null> {
    const entry = this.#store.get(id)
    if (!entry || entry.contribution.kind !== 'context' || !entry.resolver) return null
    /* `list` has always applied the contribution's scope; resolving one by id
       did not, so a chip scoped to one conversation answered for whoever asked.
       Nothing offers it out of scope now, and this is the half that does not
       depend on the caller having asked the right question. */
    if (!scopeApplies(entry.contribution.scope, scope)) return null
    const value = await withTimeout(Promise.resolve(entry.resolver(scope, ref)), 30_000)
    if (typeof value === 'string') return { label: entry.contribution.label, text: value }
    return {
      label: entry.contribution.label,
      text: value?.text ?? '',
      ...(value?.image ? { image: value.image } : {}),
    }
  }

  async runCommand(name: string, argument: string, scope: ScopeQuery): Promise<boolean> {
    const found = this.#store.list('command', scope).find((entry) => entry.name === name)
    if (!found) return false
    const handler = this.#store.get(found.id)?.command
    if (!handler) return false
    try {
      // A command is a person: they typed it, or pressed a control that names
      // it. An agent's slash commands go to the agent, never here.
      await asActor('human', () => handler(argument, scope))
    } catch (error) {
      // A command that exists and fails is not "unhandled" — it failed, and
      // the person who typed it deserves the reason, named.
      throw new Error(
        `/${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return true
  }

  subscribe(listener: (event: ExtensionEvent) => void): () => void {
    return this.#store.subscribe(listener)
  }

  // ------------------------------------------------------------- installation

  /**
   * Reads a manifest so the user can see what a plugin asks for.
   *
   * Nothing from the plugin is imported: the manifest is data, and the decision
   * to run its code comes after this, not before it.
   */
  async inspectPlugin(specifier: string): Promise<{
    id: string
    name: string
    description?: string
    version?: string
    source: PluginSource
    permissions: readonly string[]
    alreadyInstalled: boolean
  }> {
    const pkg = await inspect(specifier)
    const manifest = pkg.manifest
    return {
      id: manifest.id,
      name: manifest.name,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.version ? { version: manifest.version } : {}),
      source: manifest.source ?? { kind: 'local', path: pkg.directory },
      permissions: describePermissions(mergePermissions(manifest.permissions)),
      alreadyInstalled: this.#plugins.has(manifest.id),
    }
  }

  /** Installs and loads in one step; the consent decision happened already. */
  async installPlugin(specifier: string): Promise<string> {
    const installed = await install(specifier)
    // Replacing an existing plugin means unloading the old one first, or two
    // revisions of the same id would both be live.
    if (this.#plugins.has(installed.id)) await this.unload(installed.id)
    const definition = await loadInstalled(installed.directory)
    await this.load(definition)
    return installed.id
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    await this.unload(pluginId)
    await uninstall(pluginId)
  }

  /** Loads everything already installed. Called once at startup. */
  async loadInstalledPlugins(): Promise<void> {
    for (const entry of await listInstalled()) {
      if (this.#plugins.has(entry.id)) continue
      try {
        await this.load(await loadInstalled(entry.directory))
      } catch (error) {
        // One broken plugin must not stop the others from loading.
        this.#logger.error?.('installed plugin failed to load', {
          plugin: entry.id,
          error: String(error),
        })
      }
    }
  }

  // ------------------------------------------------------------------ private

  #describe(entry: Loaded): PluginInstance {
    return {
      instanceId: entry.instanceId,
      identity: entry.identity,
      state: this.#stateOf(entry),
      revision: this.#store.revisionOf(entry.instanceId),
      permissions: entry.permissions,
      injects: entry.injects,
      provides: entry.provides,
      contributions: this.#store.forOwner(entry.instanceId),
      enabled: entry.enabled,
      ...(entry.configSchema ? { configSchema: entry.configSchema } : {}),
      config: entry.config,
    }
  }

  #stateOf(entry: Loaded): PluginState {
    if (!entry.enabled) return { type: 'disposed' }
    const fiber = entry.fiber
    if (!fiber) return { type: 'disposed' }
    switch (fiber.state) {
      case FIBER.PENDING:
        // Cordis holds a fiber pending until every injected service exists;
        // naming them is the difference between "broken" and "waiting".
        return { type: 'pending', waitingFor: missingInjects(entry, fiber) }
      case FIBER.LOADING:
        return { type: 'loading' }
      case FIBER.ACTIVE:
        return { type: 'active' }
      case FIBER.FAILED:
        return { type: 'failed', message: String(fiber.error ?? 'plugin failed to load') }
      case FIBER.UNLOADING:
        return { type: 'unloading' }
      default:
        return { type: 'disposed' }
    }
  }
}

const missingInjects = (entry: Loaded, fiber: { ctx?: Context }): string[] => {
  const ctx = fiber.ctx
  if (!ctx) return entry.injects
  return entry.injects.filter((name) => {
    try {
      return ctx.get(name) === undefined
    } catch {
      return true
    }
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normaliseInject = (plugin: any): string[] => {
  const inject = plugin?.inject
  if (!inject) return []
  if (Array.isArray(inject)) return inject.map(String)
  return Object.keys(inject)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normaliseProvide = (plugin: any): string[] => {
  const provide = plugin?.provide
  if (!provide) return []
  return Array.isArray(provide) ? provide.map(String) : [String(provide)]
}

/**
 * Bound a callback the host does not own.
 *
 * The timer is deliberately *not* unref'd. An unref'd timer cannot fire once
 * the thing it is racing is the only work left: the event loop drains, the
 * timeout never arrives, and the promise stays pending forever — precisely the
 * hang this exists to prevent. Clearing it when the race settles is what keeps
 * a resolved call from holding the process open instead.
 */
const withTimeout = <T>(promise: Promise<T> | T, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    Promise.resolve(promise),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
