import { createInterface } from 'node:readline'

import {
  ExtensionKernel,
  setBrowserEngine,
  setBrowserSettings,
  setEditorEngine,
  setTeamEngine,
  setForgeEngine,
  type BrowserEngine,
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

/**
 * The plugin host process.
 *
 * This is the only place third-party plugin code ever runs. It owns a real
 * `ExtensionKernel`, serves the extension protocol over stdio, and holds
 * nothing else: no window, no wire server, no credential, no path to one.
 * A plugin that calls `process.exit` takes this process down and nothing
 * more — the parent notices the exit and restarts.
 *
 * stdout carries protocol lines only; the kernel's own logging goes to
 * stderr, where the parent forwards it to the diagnostics log.
 */

const log = (level: string, message: string, details?: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({ level, message, ...(details === undefined ? {} : { details }) })}\n`,
  )
}

const kernel = new ExtensionKernel({
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

const askHost = <M extends keyof ChildToHostMethods>(
  method: M,
  params: ChildToHostMethods[M]['params'],
): Promise<ChildToHostMethods[M]['result']> =>
  new Promise((resolve, reject) => {
    const id = ++nextHostRequest
    const timer = setTimeout(() => {
      hostPending.delete(id)
      reject(new Error(`The host did not answer ${method} in time.`))
    }, HOST_REQUEST_TIMEOUT_MS)
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
 * `ctx.browser` for plugins in this process, when the parent has a page of
 * its own: every DevTools call is forwarded, so the tool drives the pane in
 * the window. Installed only when `host/hello` says the parent can.
 */
const remoteBrowserEngine: BrowserEngine = {
  async ensure() {
    await askHost('browser/ensure', {})
    return {
      send: (method, params) => askHost('browser/send', { method, ...(params ? { params } : {}) }),
      // Console and network are events, and events are pulled across this
      // boundary rather than pushed — see `ChildToHostMethods`.
      drain: () => askHost('browser/events', {}),
    }
  },
  async close() {
    await askHost('browser/close', {})
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
  conflicts: (paths, scope) => askHost('team/conflicts', { scope, paths }),
  complete: (intent, args, scope) => askHost('team/complete', { scope, intent, ...args }),
  release: (intent, args, scope) => askHost('team/release', { scope, intent, ...args }),
  handoff: (intent, scope) => askHost('team/handoff', { scope, intent }),
  status: (scope) => askHost('team/status', { scope }),
  send: (args, scope) => askHost('team/send', { scope, ...args }),
}

setTeamEngine(remoteTeamEngine)

/** `ctx.forge` for plugins in this process: the seat and the record live with the host, so every verb crosses. */
const remoteForgeEngine: ForgeEngine = {
  seat: (scope) => askHost('forge/seat', { scope }),
  identity: (scope) => askHost('forge/identity', { scope }),
  publish: async (reference, scope) => void (await askHost('forge/publish', { scope, reference })),
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
    if (params.inlineBrowser) setBrowserEngine(remoteBrowserEngine)
    // A restarted child is told again, because it starts on the defaults.
    if (params.browser) setBrowserSettings(params.browser)
    return { protocolVersion: EXTENSION_PROTOCOL_VERSION, pid: process.pid }
  },
  'browser/settings': (params) => {
    setBrowserSettings(params.settings)
    return null
  },
  'plugins/loadInstalled': async () => {
    await kernel.loadInstalledPlugins()
    snapshot()
    return null
  },
  'plugin/inspect': (params) => kernel.inspectPlugin(params.specifier),
  'plugin/install': async (params) => ({ id: await kernel.installPlugin(params.specifier) }),
  'plugin/uninstall': async (params) => {
    await kernel.uninstallPlugin(params.pluginId)
    return null
  },
  'plugin/setEnabled': async (params) => {
    await kernel.setEnabled(params.pluginId, params.enabled)
    return null
  },
  'plugin/reconfigure': async (params) => {
    await kernel.reconfigure(params.pluginId, params.config)
    return null
  },
  'command/run': async (params) => ({
    handled: await kernel.runCommand(params.name, params.argument, params.scope),
  }),
  'tool/invoke': (params) => kernel.invokeTool(params.id as never, params.args, params.scope),
  'hooks/run': (params) => kernel.runHooks(params.invocation),
  'context/resolve': (params) => kernel.resolveContext(params.query),
  'context/resolveOne': (params) => kernel.resolveOne(params.id as never, params.ref, params.scope),
  'workspace/set': (params) => {
    kernel.setWorkspace({ root: params.root, branch: params.branch })
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
