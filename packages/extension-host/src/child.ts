import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'

import {
  ExtensionKernel,
  install,
  uninstall,
  iosReplyTimeoutMs, currentIosInvocation, withIosInvocation, type IosCapability,
  setBrowserEngine,
  setBrowserSettings,
  setSystemHandOff,
  setBrowserFiles,
  currentBrowserIdentity,
  setEditorEngine,
  setTeamEngine,
  setForgeEngine,
  setCapabilityBroker,
  capabilityWorkMs,
  runBrowserInvocation,
  PermissionDenied,
  type BrowserEngine,
  type CapabilityRequest,
  type EditorEngine,
  type TeamEngine,
  type ForgeEngine,
} from '@harnessdesk/cordis-host'
import {
  EXTENSION_PROTOCOL_VERSION,
  isHostRequest,
  isHostResponse,
  type ChildToHostMessage,
  type ChildToHostMethods,
  type PluginHostMethods,
  type PluginHostNotification,
} from '@harnessdesk/extension-protocol'
import type { PluginPermissions } from '@harnessdesk/protocol'

/**
 * A plugin host process.
 *
 * This is the only place third-party plugin code ever runs, and each process
 * runs exactly one plugin: `host/hello` binds it, and it refuses to load
 * anything else. It owns a real `ExtensionKernel`, serves the extension
 * protocol over stdio, and holds nothing else: no window, no wire server, no
 * credential, no path to one. A plugin that calls `process.exit` takes this
 * process down and nothing more — the parent notices the exit and restarts.
 *
 * One process is never bound: the installer. It inspects, installs and
 * removes packages, which never imports their code, and it refuses to load a
 * plugin. See docs/plugin-isolation.md.
 *
 * stdout carries protocol lines only; the kernel's own logging goes to
 * stderr, where the parent forwards it to the diagnostics log.
 */

/**
 * Probe mode: the parent asking whether this runtime confines a plugin
 * (`probePluginRuntime` in confinement.ts). Everything above has loaded, so
 * the grants cover the whole module graph; what follows tries the three
 * things a confined process must be refused, answers in one line, and exits.
 */
const probeAt = process.argv.indexOf('--probe')
if (probeAt !== -1) {
  const errorCode = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? 'ERR')
  const report: Record<string, string> = { version: process.version }
  try {
    readFileSync(process.argv[probeAt + 2] ?? '')
    report['fs'] = 'read'
  } catch (error) {
    report['fs'] = errorCode(error)
  }
  try {
    execFileSync(process.execPath, ['--version'], { stdio: 'ignore' })
    report['spawn'] = 'ran'
  } catch (error) {
    report['spawn'] = errorCode(error)
  }
  report['net'] = await new Promise<string>((resolve) => {
    try {
      const socket = connect(Number(process.argv[probeAt + 1]), '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve('connected')
      })
      socket.once('error', (error) => resolve(errorCode(error)))
    } catch (error) {
      resolve(errorCode(error))
    }
  })
  process.stdout.write(`HARNESSDESK_PLUGIN_PROBE ${JSON.stringify(report)}\n`)
  process.exit(0)
}

/**
 * Signals are outside Node's permission model, so a confined process could
 * still stop or kill any other process of the same user. Before any plugin
 * code loads, a confined process may signal only itself; asking whether a
 * process exists (signal 0) stays allowed, since it changes nothing.
 * `process.kill` reaches the system through `process._kill`, so guarding that
 * one covers both, and it can be neither reassigned nor redefined. The
 * permission model already refuses `process.binding`, the other way in.
 */
if ((process as { permission?: unknown }).permission) {
  const signalling = process as unknown as { _kill: (pid: number, signal: number) => number }
  const raw = signalling._kill
  Object.defineProperty(process, '_kill', {
    value: (pid: number, signal: number): number => {
      if (Number(pid) !== process.pid && signal !== 0) {
        throw Object.assign(new Error('A plugin process cannot signal another process.'), { code: 'ERR_ACCESS_DENIED' })
      }
      return raw.call(process, pid, signal)
    },
    writable: false,
    configurable: false,
    enumerable: false,
  })
}

const log = (level: string, message: string, details?: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({ level, message, ...(details === undefined ? {} : { details }) })}\n`,
  )
}

const iosArguments = <T extends readonly unknown[]>(input: T): T => {
  const args = [...input]
  while (args.length && args.at(-1) === undefined) args.pop()
  return args as unknown as T
}
const remoteIos: IosCapability = {
  devices: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'devices', args: iosArguments(args) } }) as ReturnType<IosCapability['devices']>,
  diagnose: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'diagnose', args: iosArguments(args) } }) as ReturnType<IosCapability['diagnose']>,
  frame: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'frame', args: iosArguments(args) } }) as ReturnType<IosCapability['frame']>,
  getAppearance: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'getAppearance', args: iosArguments(args) } }) as ReturnType<IosCapability['getAppearance']>,
  setAppearance: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'setAppearance', args: iosArguments(args) } }) as ReturnType<IosCapability['setAppearance']>,
  booted: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'booted', args: iosArguments(args) } }) as ReturnType<IosCapability['booted']>,
  boot: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'boot', args: iosArguments(args) } }) as ReturnType<IosCapability['boot']>,
  install: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'install', args: iosArguments(args) } }) as ReturnType<IosCapability['install']>,
  launch: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'launch', args: iosArguments(args) } }) as ReturnType<IosCapability['launch']>,
  terminate: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'terminate', args: iosArguments(args) } }) as ReturnType<IosCapability['terminate']>,
  openUrl: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'openUrl', args: iosArguments(args) } }) as ReturnType<IosCapability['openUrl']>,
  screenshot: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'screenshot', args: iosArguments(args) } }) as ReturnType<IosCapability['screenshot']>,
  tap: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'tap', args: iosArguments(args) } }) as ReturnType<IosCapability['tap']>,
  interact: (...args) => askHost('ios/call', { invocation: currentIosInvocation(), call: { method: 'interact', args: iosArguments(args) } }) as ReturnType<IosCapability['interact']>,
}
const kernel = new ExtensionKernel({
  iosEngine: remoteIos,
  logger: {
    debug: (message, details) => log('debug', message, details),
    info: (message, details) => log('info', message, details),
    warn: (message, details) => log('warn', message, details),
    error: (message, details) => log('error', message, details),
  },
})

const send = (message: ChildToHostMessage): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const notify = (notification: PluginHostNotification): void => {
  send({ notification })
}

// ------------------------------------------------------- asking the parent

const hostPending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let nextHostRequest = 0
const HOST_REQUEST_TIMEOUT_MS = 30_000
let requestTimeoutScale = 1

const askHost = <M extends keyof ChildToHostMethods>(
  method: M,
  params: ChildToHostMethods[M]['params'],
): Promise<ChildToHostMethods[M]['result']> =>
  new Promise((resolve, reject) => {
    const id = ++nextHostRequest
    const ios = method === 'ios/call' ? params as ChildToHostMethods['ios/call']['params'] : undefined
    const capability = method === 'capability/call' ? (params as ChildToHostMethods['capability/call']['params']).call : undefined
    const timeoutMs = (ios ? iosReplyTimeoutMs(ios.call) : capability ? capabilityReplyTimeoutMs(capability) : HOST_REQUEST_TIMEOUT_MS) * requestTimeoutScale
    const timer = setTimeout(() => {
      hostPending.delete(id)
      reject(new Error(`The host did not answer ${method} in time.`))
    }, timeoutMs)
    hostPending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value as ChildToHostMethods[M]['result'])
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    send({ request: id, method, params })
  })

/**
 * How long a plugin's own reach may take before this process stops waiting.
 * The parent holds each operation to its own deadline; this one only has to
 * outlast it, so a command given a long timeout is not cut off here first.
 */
const capabilityReplyTimeoutMs = (call: CapabilityRequest): number =>
  call.kind === 'fs' ? HOST_REQUEST_TIMEOUT_MS : capabilityWorkMs(call) + 15_000

/**
 * A command or a context read runs with the browser identity the parent
 * minted for it, as a tool call does, so a page it opens goes through the
 * parent like any other. Without one it runs as before.
 */
const withBrowser = <T>(identity: { readonly invocation: string; readonly profile: string } | undefined, run: () => Promise<T>): Promise<T> =>
  identity ? runBrowserInvocation(identity, run) : run()

/**
 * The lease of the invocation a plugin's code is running for, minted by the
 * parent and handed in with the invocation. Background work carries none, or
 * one that has ended, and the parent serves it in the open workspace.
 */
const capabilityLease = new AsyncLocalStorage<string | undefined>()
const withCapabilityLease = <T>(lease: string | undefined, body: () => T): T => capabilityLease.run(lease, body)

const DENIED = /^Permission denied: ([^\n]+?) — ([\s\S]*)$/

/**
 * `ctx.fs`, `ctx.http`, `ctx.shell` and `ctx.android` for the plugin in this
 * process. This process has no disk, network or programs of its own: the
 * parent runs every call with the grants the person agreed to. A refusal
 * comes back as the same `PermissionDenied` the host would have thrown, so
 * a tool's caller reads it exactly as before.
 */
setCapabilityBroker({
  async call(call) {
    const lease = capabilityLease.getStore()
    try {
      return await askHost('capability/call', { ...(lease === undefined ? {} : { lease }), call })
    } catch (error) {
      const denied = error instanceof Error ? DENIED.exec(error.message) : null
      if (denied) throw new PermissionDenied(denied[1]!, denied[2]!)
      throw error
    }
  },
})

/**
 * `ctx.browser` for plugins in this process, when the parent has a page of
 * its own: every DevTools call is forwarded, so the tool drives the pane in
 * the window. Installed only when `host/hello` says the parent can.
 */
const remoteBrowserEngine: BrowserEngine = {
  async ensure(identity) {
    if (!identity) throw new Error('A browser request needs a live invocation.')
    const invocation = identity.invocation
    await askHost('browser/ensure', { invocation })
    return {
      send: (method, params) =>
        askHost('browser/send', { invocation, method, ...(params ? { params } : {}) }),
      // Console and network are events, and events are pulled across this
      // boundary rather than pushed — see `ChildToHostMethods`.
      drain: () => askHost('browser/events', { invocation }),
    }
  },
  async close(identity) {
    if (identity?.invocation === 'host-shutdown') return
    if (!identity) throw new Error('A browser request needs a live invocation.')
    await askHost('browser/close', { invocation: identity.invocation })
  },
}

/**
 * `ctx.editor` for plugins in this process: every verb forwarded to the
 * parent, which owns the plane and pushes it to whatever windows exist.
 *
 * Unlike the browser engine there is no local alternative to fall back to
 * and no `inlineBrowser`-style flag gating it. A plugin host always has a
 * parent — that is what it is — and a parent that cannot serve these answers
 * with an error the plugin can read, rather than this end pretending.
 */
const remoteEditorEngine: EditorEngine = {
  // The `null` these resolve to is the protocol's "nothing to say", not a
  // value: swallowed here so the engine's own signature stays `void`.
  open: async (path, pluginId) => void (await askHost('editor/open', { path, pluginId })),
  applyEdits: (path, edits, pluginId) => askHost('editor/applyEdits', { path, edits, pluginId }),
  decorate: async (path, decorations, pluginId) =>
    void (await askHost('editor/decorate', { path, decorations, pluginId })),
  close: async (path) => void (await askHost('editor/close', { path })),
  // Pulled across this boundary for the reason browser events are, and per
  // caller for the reason on `EditorEngine.drain`.
  drain: (pluginId) => askHost('editor/events', { pluginId }),
}

setEditorEngine(remoteEditorEngine)

/**
 * `ctx.team` for plugins in this process: every verb forwarded to the
 * parent, which owns the board and routes the messages. Like the editor
 * plane there is no local fallback and no flag — a claim decided in this
 * process would be exactly the lock-file race the host exists to prevent.
 */
const remoteTeamEngine: TeamEngine = {
  board: (scope) => askHost('team/board', { scope }),
  addIntent: (args, scope) => askHost('team/addIntent', { scope, ...args }),
  claim: (intent, scope, files) => askHost('team/claim', { scope, intent, ...(files ? { files } : {}) }),
  claimNext: (scope, files) => askHost('team/claimNext', { scope, ...(files ? { files } : {}) }),
  awaitWork: (scope, options) => askHost('team/awaitWork', { scope, ...options }),
  awaitMember: (scope, options) => askHost('team/awaitMember', { scope, ...options }),
  conflicts: (paths, scope) => askHost('team/conflicts', { scope, paths }),
  complete: (intent, args, scope) => askHost('team/complete', { scope, intent, ...args }),
  commitWork: (intent, message, scope) => askHost('team/commitWork', { scope, intent, message }),
  runCheck: (intent, args, scope) => askHost('team/runCheck', { scope, intent, ...args }),
  release: (intent, args, scope) => askHost('team/release', { scope, intent, ...args }),
  handoff: (intent, scope) => askHost('team/handoff', { scope, intent }),
  status: (scope) => askHost('team/status', { scope }),
  send: (args, scope) => askHost('team/send', { scope, ...args }),
  reviewCandidates: (intent, scope) => askHost('team/reviewCandidates', { scope, intent }),
  recordReview: (input, scope) => askHost('team/recordReview', { scope, ...input }),
  // The input crosses whole: the parent's engine is the one that refuses a key it may not carry.
  raiseFinding: (input, scope) => askHost('team/raiseFinding', { scope, input }),
  repairFinding: (input, scope) => askHost('team/repairFinding', { scope, input }),
  decideFinding: (input, scope) => askHost('team/decideFinding', { scope, input }),
  listFindings: (input, scope) => askHost('team/listFindings', { scope, input }),
  notify: (input, scope) => askHost('team/notify', { scope, ...input }),
}

setTeamEngine(remoteTeamEngine)

/** `ctx.forge` for plugins in this process: the seat and the record live with the host, so every verb crosses. */
const remoteForgeEngine: ForgeEngine = {
  push: (args, scope) => askHost('forge/push', { args, scope }),
  pullRequest: {
    create: (args, scope) => askHost('forge/create', { args, scope }),
    update: (args, scope) => askHost('forge/update', { args, scope }),
    merge: (args, scope) => askHost('forge/merge', { args, scope }),
  },
  review: (args, scope) => askHost('forge/review', { args, scope }),
  comment: (args, scope) => askHost('forge/comment', { args, scope }),
  repository: scope => askHost('forge/repository', { args: {}, scope }),
  associatedPullRequest: scope => askHost('forge/associatedPullRequest', { args: {}, scope }),
  record: (args, scope) => askHost('forge/record', { args, scope }),
  attribute: (args, scope) => askHost('forge/attribute', { args, scope }),
  reviewThreads: (args, scope) => askHost('forge/reviewThreads', { args, scope }),
  settleThread: (args, scope) => askHost('forge/settleThread', { args, scope }),
  seat: (scope) => askHost('forge/seat', { scope }),
  identity: (scope) => askHost('forge/identity', { scope }),
  publish: async (reference, scope) => void (await askHost('forge/publish', { scope, reference })),
  publicationAllowed: (scope) => askHost('forge/publicationAllowed', { scope }),
}

setForgeEngine(remoteForgeEngine)

const snapshot = (): void => {
  const plugins = kernel.plugins()
  notify({
    kind: 'snapshot',
    plugins,
    contributions: plugins.flatMap((plugin) => plugin.contributions),
  })
}

// Every kernel event travels up, followed by the new complete truth, so the
// parent's synchronous `list()` cache can never drift for more than a frame.
kernel.subscribe((event) => {
  notify({ kind: 'event', event })
  snapshot()
})

/** The plugin this process runs; null until `host/hello`, and for the installer. */
interface Bound {
  readonly id: string
  readonly directory: string
  readonly permissions?: PluginPermissions
}
let bound: Bound | null = null
let greeted = false

const onlyInstaller = (what: string): void => {
  if (bound) throw new Error(`This process runs ${bound.id}; it does not ${what}.`)
}
const onlyBound = (pluginId?: string): Bound => {
  if (!bound) throw new Error('The installer process runs no plugin.')
  if (pluginId !== undefined && pluginId !== bound.id) throw new Error(`This process runs ${bound.id}, not ${pluginId}.`)
  return bound
}

type Handlers = {
  [K in keyof PluginHostMethods]: (
    params: PluginHostMethods[K]['params'],
  ) => Promise<PluginHostMethods[K]['result']> | PluginHostMethods[K]['result']
}

const handlers: Handlers = {
  'host/hello': (params) => {
    if (params.protocolVersion !== EXTENSION_PROTOCOL_VERSION) {
      throw new Error(
        `This plugin host speaks extension protocol ${EXTENSION_PROTOCOL_VERSION}, ` +
          `not ${params.protocolVersion}. The build is inconsistent; reinstall.`,
      )
    }
    if (greeted) throw new Error('This plugin host has already been greeted.')
    greeted = true
    if (params.plugin) bound = params.plugin
    if (params.confined) {
      // Under the permission model this process can start no Chrome and
      // hand nothing to the OS: the parent does both, for every placement.
      setBrowserEngine(remoteBrowserEngine, { everyPlacement: true })
      setSystemHandOff(async (url) => {
        const identity = currentBrowserIdentity(true)!
        await askHost('browser/handoff', { invocation: identity.invocation, url })
      })
      setBrowserFiles({
        savePdf: (data, name) => askHost('browser/savePdf', { invocation: currentBrowserIdentity(true)!.invocation, data, name }),
        missing: (paths) => askHost('browser/missing', { invocation: currentBrowserIdentity(true)!.invocation, paths }),
      })
    } else if (params.inlineBrowser) {
      setBrowserEngine(remoteBrowserEngine)
    }
    requestTimeoutScale = params.requestTimeoutScale ?? 1
    // A restarted child is told again, because it starts on the defaults.
    if (params.browser) setBrowserSettings(params.browser)
    return { protocolVersion: EXTENSION_PROTOCOL_VERSION, pid: process.pid }
  },
  'browser/settings': (params) => {
    setBrowserSettings(params.settings)
    return null
  },
  'plugins/loadInstalled': async () => {
    const plugin = onlyBound()
    await kernel.loadInstalledPlugin(plugin.directory, plugin.id, plugin.permissions)
    snapshot()
    return null
  },
  'plugin/inspect': (params) => {
    onlyInstaller('inspect packages')
    return kernel.inspectPlugin(params.specifier)
  },
  // Copies the package into place and nothing more: the plugin's own process imports it.
  'plugin/install': async (params) => {
    onlyInstaller('install packages')
    return { id: (await install(params.specifier, params.manifestDigest)).id }
  },
  'plugin/uninstall': async (params) => {
    onlyInstaller('remove packages')
    await uninstall(params.pluginId)
    return null
  },
  'plugin/setEnabled': async (params) => {
    await kernel.setEnabled(onlyBound(params.pluginId).id, params.enabled)
    return null
  },
  'plugin/reconfigure': async (params) => {
    await kernel.reconfigure(onlyBound(params.pluginId).id, params.config)
    return null
  },
  'command/run': async (params) => ({
    handled: await withBrowser(params.browser, () => withCapabilityLease(params.capabilityLease, () =>
      withIosInvocation(params.iosInvocations, () => kernel.runCommand(params.name, params.argument, params.scope)))),
  }),
  'tool/invoke': (params) => withCapabilityLease(params.capabilityLease, () =>
    withIosInvocation(params.iosInvocations, () => kernel.invokeTool(params.id as never, params.args, params.scope, params.browser ?? null))),
  'hooks/run': (params) => withCapabilityLease(params.capabilityLease, () =>
    withIosInvocation(params.iosInvocations, () => kernel.runHooks(params.invocation))),
  'hooks/runOne': (params) => {
    // The host routes only hooks this process announced. One it no longer
    // has was lost with a reload, and the kernel would read it as `allow`:
    // refused here, the host fails the check closed instead.
    const known = kernel.plugins().some((plugin) =>
      plugin.contributions.some((entry) => entry.kind === 'hook' && entry.id === params.id))
    if (!known) throw new Error('This plugin no longer has that hook.')
    return withCapabilityLease(params.capabilityLease, () =>
      withIosInvocation(params.iosInvocations, () => kernel.runHook(params.id as never, params.invocation)))
  },
  'context/resolve': (params) => withBrowser(params.browser, () => withCapabilityLease(params.capabilityLease, () =>
    withIosInvocation(params.iosInvocations, () => kernel.resolveContext(params.query)))),
  'context/resolveOne': (params) => withBrowser(params.browser, () => withCapabilityLease(params.capabilityLease, () =>
    withIosInvocation(params.iosInvocations, () => kernel.resolveOne(params.id as never, params.ref, params.scope)))),
  'scopes/resolved': (params) => {
    kernel.resolveWorkspaceRoots(params.roots)
    return null
  },
  'workspace/set': (params) => {
    kernel.setWorkspace({ root: params.root, branch: params.branch, ...(params.admitted ? { admitted: params.admitted } : {}) })
    return null
  },
  'host/stats': () => ({
    pid: process.pid,
    rssBytes: process.memoryUsage().rss,
    // Timers, sockets, file handles — everything keeping this process busy.
    // A plugin that leaks shows up here as a count that only ever grows.
    activeHandles: process.getActiveResourcesInfo().length,
    invocations: kernel.invocationCounts(),
  }),
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line.trim().length === 0) return
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    log('warn', 'unparseable line from host', { line: line.slice(0, 200) })
    return
  }
  if (isHostResponse(parsed)) {
    const pending = hostPending.get(parsed.response)
    if (!pending) return
    hostPending.delete(parsed.response)
    if ('error' in parsed) pending.reject(new Error(parsed.error.message))
    else pending.resolve(parsed.result)
    return
  }
  if (!isHostRequest(parsed)) {
    log('warn', 'unrecognised message from host')
    return
  }
  const { id, method, params } = parsed
  const handler = handlers[method as keyof PluginHostMethods] as
    | ((value: unknown) => unknown)
    | undefined
  if (!handler) {
    send({ id, error: { message: `The plugin host has no method ${JSON.stringify(method)}.` } })
    return
  }
  void (async () => {
    try {
      const result = await handler(params)
      send({ id, result: result ?? null })
    } catch (error) {
      send({ id, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })()
})

// The parent closing stdin is the shutdown signal: no message to race with.
rl.on('close', () => {
  void kernel.dispose().finally(() => process.exit(0))
})
