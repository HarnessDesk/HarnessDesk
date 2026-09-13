import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  setEditorEngine,
  setForgeEngine,
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
} from '@harnessdesk/cordis-host'
import {
  EXTENSION_PROTOCOL_VERSION,
  isChildMessage,
  type BrowserSettingsWire,
  type ChildToHostRequest,
  type HostToChildResponse,
  type InspectedPlugin,
  type PluginHostMethodName,
  type PluginHostMethods,
  type PluginHostStats,
} from '@harnessdesk/extension-protocol'
import {
  isForgeReference,
  pluginInstanceId,
  scopeApplies,
  type CapabilityContribution,
  type ContextImage,
  type ContributionId,
  type ContributionKind,
  type EditorEdit,
  type ExtensionEvent,
  type ForgeReference,
  type HookInvocation,
  type HookVerdict,
  type PluginInstance,
  type ScopeQuery,
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

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export interface PluginHostOptions {
  /** How long a single request may take. A wedged child is killed and restarted. */
  readonly invokeTimeoutMs?: number
  readonly logger?: KernelLogger
  /** Extra environment for the child, e.g. HARNESSDESK_HOME in tests. */
  readonly env?: Readonly<Record<string, string>>
  readonly onEvent?: (event: ExtensionEvent) => void
  readonly onSnapshot?: () => void
  /**
   * The parent's own browser page, when it has one — the desktop shell's
   * pane. A child `ctx.browser` is then served from here; without it, the
   * child starts its own Chrome.
   */
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
}

export class PluginHostProcess {
  #child: ChildProcess | null = null
  #nextId = 0
  readonly #pending = new Map<number, Pending>()
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
  #crashes = 0
  #browser: BrowserSettingsWire | null = null
  #startedAt = 0
  #wantInstalled = false
  #disposed = false
  #starting: Promise<void> | null = null
  #options: PluginHostOptions
  readonly #logger: KernelLogger

  constructor(options: PluginHostOptions = {}) {
    this.#options = options
    this.#logger = options.logger ?? {}
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

  /** Brings the child up if it is not already. Concurrent callers share one start. */
  async ensure(): Promise<void> {
    if (this.#disposed) throw new Error('The plugin host has been disposed.')
    if (this.alive) return
    if (this.#crashes > BACKOFF_MS.length) {
      throw new Error(
        'The plugin host crashed repeatedly and has been stopped. ' +
          'Disable or uninstall the failing plugin, then restart HarnessDesk.',
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
    // ELECTRON_RUN_AS_NODE makes the same spawn work when the parent is the
    // Electron main process: the child must be plain Node, never a second app.
    const child = spawn(process.execPath, [CHILD_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...this.#options.env },
    })
    this.#child = child

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
      // The snapshot is deliberately kept: the plugins are still installed and
      // will return with the restart, and a Settings page that flickers empty
      // on every crash would be lying about what is installed. Consumers see
      // `alive` for the difference.
      //
      // Every waiting caller learns immediately: a turn blocked on a tool
      // must fail now, not when a timeout eventually fires.
      const reason = new Error(
        `The plugin host exited${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}. ` +
          'Third-party plugin tools are unavailable until it restarts.',
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
        owner: pluginInstanceId('plugin-host'),
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
      inlineBrowser: Boolean(this.#options.browserEngine),
      // A restarted child starts on the defaults, so where pages open goes
      // in the greeting rather than being sent once and forgotten.
      ...(this.#browser ? { browser: this.#browser } : {}),
    })
    this.#logger.info?.('plugin host ready', { pid: hello.pid })
    // A restarted child must reach the same state the crashed one had; a
    // fresh, empty child answering hook or tool calls would silently allow
    // what a loaded plugin might have denied.
    if (this.#wantInstalled) await this.call('plugins/loadInstalled', {})
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
      const notification = parsed.notification
      if (notification.kind === 'snapshot') {
        // Child ids are namespaced at this boundary: both kernels number
        // their contributions c1, c2, … independently, and unprefixed child
        // ids shadow in-process ones — a live Codex run resolved a child
        // browser tool to c2 and executed the built-in Search tool that
        // owned c2 in the kernel. Ids must be unique across the merge.
        this.#plugins = notification.plugins.map((plugin) => ({
          ...plugin,
          contributions: plugin.contributions.map((entry) => ({
            ...entry,
            id: childContributionId(entry.id),
          })),
        }))
        this.#contributions = notification.contributions.map((entry) => ({
          ...entry,
          id: childContributionId(entry.id),
        }))
        this.#options.onSnapshot?.()
      } else {
        this.#crashes = 0 // A healthy event stream clears the backoff ladder.
        this.#options.onEvent?.(notification.event)
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
   * A child's request, answered from the parent's own engines.
   *
   * Each family checks for its own engine, not one guard for both: a host
   * with a browser but no editor plane must answer `browser/*` and refuse
   * `editor/*`, and the single up-front check this method used to open with
   * would have refused every editor call on a host that simply had no pane.
   */
  async #answer(request: ChildToHostRequest): Promise<void> {
    const reply = (message: HostToChildResponse): void => {
      this.#child?.stdin?.write(`${JSON.stringify(message)}\n`)
    }
    const refuse = (message: string): void => {
      reply({ response: request.request, error: { message } })
    }
    try {
      if (request.method.startsWith('editor/')) {
        const plane = this.#options.editorEngine
        if (!plane) {
          refuse('The host has no editor plane.')
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
        switch (request.method) {
          case 'forge/identity': {
            reply({ response: request.request, result: await plane.identity(scope) })
            return
          }
          case 'forge/seat': {
            reply({ response: request.request, result: await plane.seat(scope) })
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
            await plane.publish(reference, scope)
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
        const scope = (params['scope'] ?? {}) as TeamScope
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
        if (!this.#armedFor(scope, 'team')) {
          refuse(
            'Refused: this team call does not ride a live invocation the host dispatched to this plugin for that conversation, so it cannot be attributed. Team verbs work only while a tool call, context resolution, or command for that conversation — dispatched to this plugin, which must be granted `team` — is in flight.',
          )
          return
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
          case 'team/conflicts': {
            const paths = (params['paths'] ?? []) as readonly string[]
            reply({ response: request.request, result: await plane.conflicts(paths, scope) })
            return
          }
          case 'team/complete': {
            const { note, handoff, outcome } = params as {
              note?: string
              handoff?: string
              outcome?: string
            }
            reply({
              response: request.request,
              result: await plane.complete(
                Number(params['intent']),
                {
                  ...(note !== undefined ? { note } : {}),
                  ...(handoff !== undefined ? { handoff } : {}),
                  ...(outcome !== undefined ? { outcome } : {}),
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
          default:
            refuse(`Unknown request ${String(request.method)}.`)
            return
        }
      }

      const engine = this.#options.browserEngine
      if (!engine) {
        refuse('The host has no browser of its own.')
        return
      }
      switch (request.method) {
        case 'browser/ensure':
          await engine.ensure()
          reply({ response: request.request, result: null })
          return
        case 'browser/send': {
          const { method, params } = request.params as { method: string; params?: Record<string, unknown> }
          const sender = await engine.ensure()
          reply({ response: request.request, result: (await sender.send(method, params)) ?? null })
          return
        }
        case 'browser/events': {
          const sender = await engine.ensure()
          reply({ response: request.request, result: (await sender.drain?.()) ?? [] })
          return
        }
        case 'browser/close':
          await engine.close()
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
   * One request. If it overruns the deadline the child's event loop is wedged
   * — a plugin spinning — and the only recovery is on this side: kill it. The
   * exit handler fails everything else in flight and schedules the restart.
   */
  async call<M extends PluginHostMethodName>(
    method: M,
    params: PluginHostMethods[M]['params'],
  ): Promise<PluginHostMethods[M]['result']> {
    const armKeys = this.#armedScopesFor(method, params)
    if (armKeys.length === 0) return this.#dispatch(method, params)
    for (const key of armKeys) this.#teamScopes.set(key, (this.#teamScopes.get(key) ?? 0) + 1)
    try {
      return await this.#dispatch(method, params)
    } finally {
      for (const key of armKeys) {
        const count = (this.#teamScopes.get(key) ?? 1) - 1
        if (count <= 0) this.#teamScopes.delete(key)
        else this.#teamScopes.set(key, count)
      }
    }
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
    const namespaced = childContributionId(strippedId as ContributionId)
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
  #armedFor(scope: { readonly runtime?: unknown; readonly sessionId?: unknown; readonly plugin?: unknown }, plane: 'team' | 'forge'): boolean {
    if (typeof scope.runtime !== 'string' || typeof scope.sessionId !== 'string' || typeof scope.plugin !== 'string') {
      return false
    }
    if ((this.#teamScopes.get(teamScopeKey(scope.runtime, scope.sessionId, scope.plugin)) ?? 0) <= 0) return false
    const plugin = this.#plugins.find((entry) => String(entry.instanceId) === scope.plugin)
    return plugin !== undefined && plugin.enabled && plugin.permissions[plane] === true
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
  ): Promise<PluginHostMethods[M]['result']> {
    await this.ensure()
    const child = this.#child
    if (!child?.stdin?.writable) throw new Error('The plugin host is not running.')
    const id = ++this.#nextId
    const timeoutMs = this.#options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new Error(
            `The plugin host did not answer within ${Math.round(timeoutMs / 1000) || 1}s ` +
              'and was restarted. A plugin is monopolising it.',
          ),
        )
        this.#logger.warn?.('plugin host wedged; killing', { method })
        child.kill('SIGKILL')
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
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
  readonly env?: Readonly<Record<string, string>>
  /** The parent's own browser page for child plugins' `ctx.browser`; see `PluginHostOptions`. */
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
}

/**
 * The one extension surface the host consumes.
 *
 * Trusted built-ins run in-process — they are this repository's own code and
 * review gates them, not a process boundary. Everything installed from disk
 * or npm runs in the child. Routing is by contribution ownership, decided
 * from the merged snapshots, so callers never say which side they mean.
 *
 * Failure posture, deliberately asymmetric:
 * - a tool call into a dead child fails with a clear error (the turn
 *   continues; the agent is told the tool is unavailable);
 * - a *hook* that lives in a dead child denies (a security review that
 *   cannot run must not silently allow);
 * - context from a dead child is simply absent (context is additive).
 */
export class SupervisedExtensionHost {
  readonly #kernel: ExtensionKernel
  readonly #child: PluginHostProcess
  readonly #listeners = new Set<(event: ExtensionEvent) => void>()
  readonly #logger: KernelLogger
  #workspace: { root: string | null; branch: string | null } = { root: null, branch: null }

  constructor(kernel: ExtensionKernel, options: SupervisedExtensionHostOptions = {}) {
    this.#kernel = kernel
    this.#logger = options.logger ?? {}
    this.#child = new PluginHostProcess({
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.invokeTimeoutMs ? { invokeTimeoutMs: options.invokeTimeoutMs } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.browserEngine ? { browserEngine: options.browserEngine } : {}),
      ...(options.editorEngine ? { editorEngine: options.editorEngine } : {}),
      ...(options.teamEngine ? { teamEngine: options.teamEngine } : {}),
      ...(options.forgeEngine ? { forgeEngine: options.forgeEngine } : {}),
      onEvent: (event) => this.#emit(event),
      onSnapshot: () => {
        // The child (re)announced itself; replay what it cannot know.
        if (this.#workspace.root !== null && this.#child.alive) {
          void this.#child.call('workspace/set', this.#workspace).catch(() => {})
        }
      },
    })
    kernel.subscribe((event) => this.#emit(event))
    // The constructor option must reach *both* halves — the child (spread
    // above) and the in-process kernel's module state — exactly as the
    // setter does; an option accepted but half-honoured is a builtin plugin
    // whose `ctx.team` quietly points at nothing.
    if (options.teamEngine !== undefined) setTeamEngine(options.teamEngine)
    if (options.forgeEngine !== undefined) setForgeEngine(options.forgeEngine)
  }

  /** Loads one of the repository's own plugins, in-process. Not for third-party code. */
  async loadBuiltin(plugin: HarnessPlugin): Promise<void> {
    await this.#kernel.load(plugin)
  }

  /** Brings up the child and loads everything installed on disk into it. */
  async loadInstalledPlugins(): Promise<void> {
    await this.#child.loadInstalled()
    await this.#retireShadowed()
  }

  /**
   * An installed plugin does not stand in for a built-in of the same id.
   *
   * This happens for one reason, and it is a good one: a plugin that shipped
   * as an example, and was installed from there, later becomes part of the
   * app. Leaving both loaded hands an agent two `browser_open` tools that
   * differ only by a namespace it never sees. The installed copy is switched
   * off and the reason is logged — nothing is deleted, because uninstalling is
   * the user's to do and their copy may be one they have since edited.
   */
  async #retireShadowed(): Promise<void> {
    const builtin = this.#kernelPluginIds()
    for (const plugin of this.#child.plugins) {
      const id = plugin.identity.id
      if (!builtin.has(id) || !plugin.enabled) continue
      await this.#child.call('plugin/setEnabled', { pluginId: id, enabled: false }).catch(() => {})
      this.#logger.warn?.('an installed plugin shadows a built-in of the same id and was switched off', {
        plugin: id,
      })
    }
  }

  stats(): Promise<PluginHostStats> {
    return this.#child.call('host/stats', {})
  }

  // ---------------------------------------------------- CapabilityRegistry

  list<K extends ContributionKind>(
    kind: K,
    query?: ScopeQuery,
  ): readonly Extract<CapabilityContribution, { kind: K }>[] {
    const applies = (contribution: CapabilityContribution): boolean =>
      contribution.kind === kind && (!query || scopeApplies(contribution.scope, query))
    return [
      ...this.#kernel.list(kind, query),
      ...(this.#child.contributions.filter(applies) as unknown as readonly Extract<
        CapabilityContribution,
        { kind: K }
      >[]),
    ]
  }

  plugins(): readonly PluginInstance[] {
    return [...this.#kernel.plugins(), ...this.#child.plugins]
  }

  async invokeTool(id: ContributionId, args: unknown, scope: ScopeQuery): Promise<ToolResult> {
    if (this.#ownsInProcess(id)) return this.#kernel.invokeTool(id, args, scope)
    if (!isChildContributionId(id)) {
      return { ok: false, error: `No tool is registered with id ${String(id)}` }
    }
    try {
      return await this.#child.call('tool/invoke', { id: stripChildContributionId(id), args, scope })
    } catch (error) {
      // The failure is the answer: the turn goes on, told plainly why.
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async runHooks(invocation: HookInvocation): Promise<HookVerdict> {
    const own = await this.#kernel.runHooks(invocation)
    if (own.decision !== 'allow') return own
    const childHasHooks = this.#child.contributions.some((entry) => entry.kind === 'hook')
    if (!childHasHooks && !this.#child.alive) return own
    try {
      return await this.#child.call('hooks/run', { invocation })
    } catch (error) {
      if (!childHasHooks) return own
      // Fail closed: a review that could not run must not read as approval.
      return {
        decision: 'deny',
        reason: `A plugin hook could not run: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async resolveContext(query: ScopeQuery): Promise<readonly { label: string; text: string }[]> {
    const own = await this.#kernel.resolveContext(query)
    if (!this.#child.alive && this.#child.contributions.every((entry) => entry.kind !== 'context')) {
      return own
    }
    try {
      return [...own, ...(await this.#child.call('context/resolve', { query }))]
    } catch {
      return own
    }
  }

  async resolveOne(
    id: ContributionId,
    ref: string | undefined,
    scope: ScopeQuery,
  ): Promise<{ label: string; text: string; image?: ContextImage } | null> {
    if (this.#ownsInProcess(id)) return this.#kernel.resolveOne(id, ref, scope)
    if (!isChildContributionId(id)) return null
    return this.#child.call('context/resolveOne', { id: stripChildContributionId(id), ...(ref === undefined ? {} : { ref }), scope })
  }

  subscribe(listener: (event: ExtensionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  // -------------------------------------------------------- ExtensionHost

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (this.#kernelPluginIds().has(pluginId)) return this.#kernel.setEnabled(pluginId, enabled)
    await this.#child.call('plugin/setEnabled', { pluginId, enabled })
  }

  async reconfigure(pluginId: string, config: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#kernelPluginIds().has(pluginId)) return this.#kernel.reconfigure(pluginId, config)
    await this.#child.call('plugin/reconfigure', { pluginId, config })
  }

  async runCommand(
    name: string,
    argument: string,
    scope: { sessionId?: SessionId },
  ): Promise<boolean> {
    if (await this.#kernel.runCommand(name, argument, scope)) return true
    const childHasIt = this.#child.contributions.some(
      (entry) => entry.kind === 'command' && entry.name === name,
    )
    if (!this.#child.alive && !childHasIt) return false
    try {
      const { handled } = await this.#child.call('command/run', { name, argument, scope })
      return handled
    } catch (error) {
      // The command exists over there and failed — that is an answer, not an
      // absence. Only an unknown name reads as unhandled.
      if (childHasIt) throw error
      return false
    }
  }

  /**
   * Where an agent's pages open. Both sides are told: built-ins run here,
   * installed plugins run in the child, and the two must not disagree about
   * which browser they are driving.
   */
  setBrowserSettings(settings: BrowserSettings): void {
    this.#kernel.setBrowserSettings(settings)
    this.#child.setBrowserSettings({
      placement: settings.placement,
      ...(settings.binary === undefined ? {} : { binary: settings.binary }),
      ...(settings.keepProfile === undefined ? {} : { keepProfile: settings.keepProfile }),
      ...(settings.profileDir === undefined ? {} : { profileDir: settings.profileDir }),
    })
  }

  /**
   * The editor plane, to both halves.
   *
   * Built-ins run in this process and reach it through the module-level
   * engine; installed plugins run in the child and reach it by forwarding.
   * Told separately for the same reason browser settings are: the two must
   * not disagree about which plane they are driving.
   */
  setEditorEngine(engine: EditorEngine | null): void {
    setEditorEngine(engine)
    this.#child.setEditorEngine(engine)
  }

  /** The team plane, to both halves — the editor plane's reasoning, verbatim. */
  setTeamEngine(engine: TeamEngine | null): void {
    setTeamEngine(engine)
    this.#child.setTeamEngine(engine)
  }

  /** The forge plane, to both halves, for the same reason. */
  setForgeEngine(engine: ForgeEngine | null): void {
    setForgeEngine(engine)
    this.#child.setForgeEngine(engine)
  }

  setWorkspace(state: { root: string | null; branch: string | null }): void {
    this.#workspace = state
    this.#kernel.setWorkspace(state)
    if (this.#child.alive) void this.#child.call('workspace/set', state).catch(() => {})
  }

  inspectPlugin(specifier: string): Promise<InspectedPlugin> {
    return this.#child.call('plugin/inspect', { specifier })
  }

  /** Installation and the import() it implies happen in the child, never here. */
  async installPlugin(specifier: string): Promise<string> {
    const { id } = await this.#child.call('plugin/install', { specifier })
    return id
  }

  /**
   * Removes an installed plugin's copy from disk.
   *
   * The check is "is there a copy on disk", not "is this id also a built-in".
   * They come apart in exactly the case `#retireShadowed` exists for: a plugin
   * installed from the examples before it shipped as part of the app leaves a
   * copy behind under the same id, and refusing to remove it because a
   * built-in now answers to that id left the only thing that resolves the
   * situation permanently disabled.
   */
  async uninstallPlugin(pluginId: string): Promise<void> {
    const installed = this.#child.plugins.some((plugin) => plugin.identity.id === pluginId)
    if (!installed) {
      throw new Error('Built-in plugins are part of HarnessDesk and cannot be uninstalled.')
    }
    await this.#child.call('plugin/uninstall', { pluginId })
  }

  async dispose(): Promise<void> {
    await this.#child.dispose()
    await this.#kernel.dispose()
  }

  // ------------------------------------------------------------------ private

  #ownsInProcess(id: ContributionId): boolean {
    if (isChildContributionId(id)) return false
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

/**
 * The child's contribution ids, namespaced so they can never collide with
 * the in-process kernel's. The prefix is an addressing detail of this
 * supervisor; it is stripped again before anything crosses back to the child.
 */
/**
 * Unambiguous for any runtime/session/plugin triple, and plain ASCII in the
 * source. The plugin is part of the key because a grant that arms the whole
 * child process is not attribution: every plugin in there shares one stdout.
 */
const teamScopeKey = (runtime: string, sessionId: string, plugin: string): string =>
  JSON.stringify([runtime, sessionId, plugin])

const CHILD_ID_PREFIX = 'child:'
const childContributionId = (id: ContributionId): ContributionId =>
  `${CHILD_ID_PREFIX}${String(id)}` as ContributionId
const isChildContributionId = (id: ContributionId): boolean =>
  String(id).startsWith(CHILD_ID_PREFIX)
const stripChildContributionId = (id: ContributionId): string =>
  String(id).slice(CHILD_ID_PREFIX.length)
