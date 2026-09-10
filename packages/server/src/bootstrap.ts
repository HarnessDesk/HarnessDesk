import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { existsSync } from 'node:fs'

import { AcpRuntime, type AcpAgentConfig } from '@harnessdesk/adapter-acp'
import { runtimeId, sessionId, type RuntimeInfo } from '@harnessdesk/protocol'
import { CodexRuntime, CODEX_RUNTIME_ID } from '@harnessdesk/adapter-codex'
import { ExtensionKernel, setBrowserEngine, type BrowserEngine } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '@harnessdesk/extension-host'
import { ToolGateway } from './tool-gateway.js'
import { builtinPlugins } from '@harnessdesk/plugins'

import { AccountSlots, accountIdentity, codexPrimaryHome, writeGatewayConfig } from './accounts.js'
import { AcpRegistry } from './acp-registry.js'
import { applyLoginShellPath } from './installs/shell-path.js'
import { identityReaderFor } from './installs/identity.js'
import { currentNameOf } from './installs/known-agents.js'
import { InstallService } from './installs/service.js'
import { AgentDirectory, AgentRegistryStore, packagedPath, templateBrandFor } from './agent-registry.js'
import { CredentialBroker } from './credentials.js'
import { Host, type AccountFactory, type HostOptions } from './host.js'
import { usageRecordFor } from './usage/antigravity-store.js'
import { ClaudeFileMeter } from './usage/claude-file.js'
import { CopilotMeter } from './usage/copilot.js'
import { CursorMeter } from './usage/cursor.js'
import { GeminiMeter } from './usage/gemini.js'
import type { UsageMeter } from './usage/meter.js'
import { Logger } from './log.js'
import { StateStore, defaultStateDir } from './state.js'
import { UpdateChecker } from './updates.js'

/**
 * The standard wiring: a host with the Codex runtime registered.
 *
 * Kept separate from `Host` so tests can register a fake runtime instead, and so
 * a future ACP runtime is one more `register` call rather than a change here.
 */

/**
 * A unix socket path is capped by the kernel — 104 bytes on macOS, 108 on
 * Linux — and a state directory deep in a temp tree (a test's, a sandbox's)
 * can already be longer than that. The socket then lives in the system temp
 * directory under a name derived from the state directory, so two hosts with
 * different homes still get different sockets.
 */
const SOCKET_PATH_LIMIT = 100
export const toolSocketPath = (stateDir: string): string => {
  const preferred = join(stateDir, 'run', 'tools.sock')
  if (Buffer.byteLength(preferred) <= SOCKET_PATH_LIMIT) return preferred
  const digest = createHash('sha256').update(stateDir).digest('hex').slice(0, 12)
  return join(tmpdir(), `harnessdesk-${digest}.sock`)
}

/**
 * The plugin-tool bridge: one more program, spawned by the *agent*.
 *
 * That is the whole reason this is not a plain relative path. The MCP server
 * rides to the agent in `session/new` and the agent starts it, so every
 * assumption the path makes has to hold for a process we do not control.
 * Electron reading its own archive is one such assumption — true today,
 * because the command is this process's `execPath`, but it is the agent's MCP
 * client that opens the path, and a client that checks a file exists before
 * spawning it would be right to fail on one inside an asar. The file is
 * therefore unpacked beside the archive and named where it landed.
 *
 * A bridge that is not there at all is a fact to state once, not a broken MCP
 * server handed to every agent for the life of the app.
 */
export const defaultToolBridgeEntry = (): string =>
  fileURLToPath(new URL('../../../mcp-tools/dist/src/main.js', import.meta.url))

export { packagedPath } from './agent-registry.js'

export const toolBridgeEntry = (entry = defaultToolBridgeEntry()): string | null => {
  const unpacked = packagedPath(entry)
  return existsSync(unpacked) ? unpacked : null
}

/**
 * The environment an ACP agent process starts with. The gateway's socket is
 * named in the agent's own environment, not only in the MCP server's: an
 * agent that composes its tool clients itself (DeepSeek Harness, whose
 * `dsh-mcp-client` composition entry spawns the mcp-tools bridge) can only
 * hand the path down through ambient env, because its composition file
 * cannot know which host is launching it. Filesystem permissions are the
 * auth, so the path is not a secret; an entry that sets its own value wins.
 */
export const agentEnvironment = (
  socketPath: string,
  agentEnv: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> => ({ HD_TOOLS_SOCKET: socketPath, ...agentEnv })

export interface BootstrapOptions {
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error'
  /** How stored credentials are protected at rest; the desktop shell passes safeStorage. */
  readonly credentialCipher?: HostOptions['credentialCipher']
  readonly stateDir?: string
  readonly codexBinaryPath?: string | null
  readonly codexHome?: string | null
  readonly version?: string
  readonly pickDirectory?: HostOptions['pickDirectory']
  readonly revealPath?: HostOptions['revealPath']
  readonly console?: boolean
  /**
   * Where browser tools find their page. Absent, the plugin host starts the
   * user's Chrome; the desktop shell passes its own pane. See
   * `BrowserEngine` in `@harnessdesk/cordis-host`.
   */
  readonly browserEngine?: BrowserEngine
}

export const createDefaultHost = (
  options: BootstrapOptions = {},
): {
  host: Host
  logger: Logger
  extensions: SupervisedExtensionHost
  /** The login shell's PATH, once it has answered. Nobody has to await it. */
  pathReady: Promise<unknown>
} => {
  const stateDir = options.stateDir ?? defaultStateDir()
  setBrowserEngine(options.browserEngine ?? null)
  const logger = new Logger('harnessdesk', {
    level: options.logLevel ?? 'info',
    file: join(stateDir, 'logs', 'host.ndjson'),
    console: options.console ?? true,
  })

  // Before any runtime exists: the app opened from the Dock has launchd's
  // PATH, which names nothing the person installed, and a runtime built
  // against that PATH has already looked for its agent and found nothing.
  // See `installs/shell-path.ts` for what is asked and in which order.
  const pathReady = applyLoginShellPath({
    stateDir,
    log: (message, details) => logger.child('path').info(message, details),
  }).settled

  // The extension surface comes up first: runtimes are handed the registry at
  // construction, and a session started before plugins exist would carry an
  // empty tool set for its whole life.
  // Built-in plugins are deliberately *not* trusted. They declare manifests and
  // are held to them exactly like third-party plugins, which is the only way the
  // permission model gets exercised often enough to stay correct. What *is*
  // different about them is the process: built-ins run in this one, everything
  // installed runs in the supervised plugin host child — third-party code never
  // shares a process with the window, the wire server, or a credential.
  const extensions = new SupervisedExtensionHost(
    new ExtensionKernel({ logger: logger.child('extensions') }),
    {
      logger: logger.child('plugin-host'),
      // Installed plugins' browser tools reach the same page the built-ins do.
      ...(options.browserEngine ? { browserEngine: options.browserEngine } : {}),
    },
  )

  // Whether a newer build of an agent is published: one registry read a day
  // per package, cached here, and off entirely with HARNESSDESK_NO_UPDATE_CHECK.
  // Advisory — see docs/agents.md for why it exists at all.
  const updates =
    process.env['HARNESSDESK_NO_UPDATE_CHECK'] === '1'
      ? undefined
      : new UpdateChecker({
          cachePath: join(stateDir, 'update-checks.json'),
          log: (message, details) => logger.child('updates').debug(message, details),
        })

  // More than one account of one agent. Codex holds a single credential in
  // its home, so a second account is a second process over a credential home
  // of its own — a symlink farm that keeps the sessions, the config and the
  // state database shared and only `auth.json` apart. See `accounts.ts`; the
  // host knows none of this, which is why the factory is built out here.
  const slots = new AccountSlots(join(stateDir, 'accounts.json'), (message, details) =>
    logger.child('accounts').info(message, details),
  )
  const codexHome = codexPrimaryHome(options.codexHome)
  slots.pruneEmpty(CODEX_RUNTIME_ID)
  // Then the ones that were finished, but as somebody the user is already
  // signed in as. A second sign-in cannot be refused at the door in every
  // case — one may have been made by an older build, or by signing the same
  // account in again outside a flow we drive — so the roster is swept here
  // too, before any of it becomes a runtime with a row of its own.
  slots.pruneDuplicates(CODEX_RUNTIME_ID, codexHome)
  slots.relink(CODEX_RUNTIME_ID, codexHome)

  const codexAccount = (id: ReturnType<typeof runtimeId>, home: string): CodexRuntime =>
    new CodexRuntime({
      id,
      sharesHistory: true,
      clientName: 'harnessdesk',
      clientVersion: options.version ?? '0.1.0',
      binaryPath: options.codexBinaryPath ?? process.env['HARNESSDESK_CODEX_BINARY'] ?? null,
      codexHome: home,
      logger: logger.child(id),
      capabilities: extensions,
    })

  const accounts: AccountFactory = {
    canAdd: (info) => isCodex(info),
    slotOf: (info) => {
      if (!isCodex(info)) return null
      const slot = slots.find(info.id)
      return slot
        ? {
            agent: slot.agent,
            home: slot.home,
            removable: true,
            ...(slot.gateway ? { gateway: { ...slot.gateway } } : {}),
          }
        : { agent: CODEX_RUNTIME_ID, home: codexHome, removable: false }
    },
    add: async (info, gateway) => {
      const agent = slots.find(info.id)?.agent ?? info.id
      const slot = slots.add(agent, codexHome, stateDir, gateway)
      return codexAccount(slot.id, slot.home)
    },
    remove: async (id) => {
      slots.remove(id)
    },
    // Read off the credential rather than asked of Codex: `account/read`
    // answers an email and a plan, and one email can hold two ChatGPT
    // workspaces — which are two accounts, with two limits, and must keep two
    // rows. The identity is the person *and* the workspace, and only
    // `auth.json` carries both.
    identityOf: (info) => {
      if (!isCodex(info)) return null
      const slot = slots.find(info.id)
      if (slot?.gateway) return null // Its key is the broker's, not a home's.
      return accountIdentity(slot?.home ?? codexHome)
    },
    // The host has resolved the credential and started the loopback gateway;
    // all that is left is telling this account's Codex to use it, which is a
    // file in a home only this module knows the shape of.
    prepare: async (id, resolved) => {
      const slot = slots.find(id)
      if (!slot?.gateway) return
      writeGatewayConfig(slot.home, resolved.name, resolved.endpoint)
    },
  }
  const isCodex = (info: RuntimeInfo): boolean =>
    info.id === CODEX_RUNTIME_ID || slots.find(info.id) !== null

  // The tool gateway: plugin tools for out-of-process projections (the MCP
  // bridge ACP agents receive). Unix socket; filesystem permissions are the
  // auth. Resolution is by name against the registry as it is now.
  //
  // `callers` is the other half of the correlation token the adapter mints
  // into each bridge's environment: token → the session whose `session/new`
  // spawned that bridge. It is what lets a tool called over MCP say which
  // conversation called it — the same scope Codex's dynamic-tool path has
  // always carried. Bounded because sessions end and tokens do not: past the
  // cap the oldest mapping goes, and a call with a forgotten token is simply
  // unscoped, which is exactly what it was before the token existed.
  const callers = new Map<string, { runtime: string; sessionId: string }>()
  const claimCaller = (runtime: string) => (token: string, sessionId: string) => {
    callers.set(token, { runtime, sessionId })
    if (callers.size > 2000) {
      const oldest = callers.keys().next().value
      if (oldest !== undefined) callers.delete(oldest)
    }
  }
  const socketPath = toolSocketPath(stateDir)
  const gateway = new ToolGateway(socketPath, {
    listTools: () => extensions.list('tool', {}),
    invokeByName: async (namespace, name, args, caller) => {
      const tools = extensions.list('tool', {})
      const tool =
        tools.find((entry) => entry.namespace === namespace && entry.name === name) ??
        tools.find((entry) => entry.name === name)
      if (!tool) return { ok: false, error: `No tool named ${namespace}/${name} is registered.` }
      const scope = caller !== undefined ? callers.get(caller) : undefined
      // The scope in the log is the audit trail 25.3 was missing: which
      // conversation ran which tool, from the host's own record.
      if (scope) {
        logger.debug('tool call scoped to its session', {
          tool: `${namespace}/${name}`,
          runtime: scope.runtime,
          session: scope.sessionId,
        })
      }
      return extensions.invokeTool(
        tool.id,
        args,
        scope
          ? { runtime: runtimeId(scope.runtime), sessionId: sessionId(scope.sessionId) }
          : {},
      )
    },
  })
  gateway.start()
  const bridgeEntry = toolBridgeEntry()
  if (bridgeEntry === null) {
    logger.warn('the plugin tool bridge is missing; ACP agents will run without HarnessDesk tools', {
      expected: packagedPath(defaultToolBridgeEntry()),
    })
  }
  const toolServer = bridgeEntry
    ? {
        name: 'harnessdesk',
        command: process.execPath,
        args: [bridgeEntry],
        env: {
          HD_TOOLS_SOCKET: socketPath,
          // In the packaged app `process.execPath` is Electron, and Electron
          // is a Node only when it is told to be. Ignored by a real Node.
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
      }
    : null

  // The agent registry. `agents.json` in the state directory names ACP
  // agents; each becomes one more runtime in the picker, through the same
  // interface as everything else. Installation and versions belong to the
  // user's package manager — the registry points at a command, it does not
  // manage software. `AgentDirectory` is the same file writable from the
  // interface: the templates it can register are the bridges this build
  // carries and the CLIs that speak ACP themselves.
  const agentRegistry = new AgentRegistryStore(join(stateDir, 'agents.json'), (message, details) =>
    logger.child('agents').warn(message, details),
  )
  // Secrets an agent declares are read from the broker when its process
  // starts, so a key stored from the sign-in screen reaches the next run
  // without a restart and never sits in `agents.json`.
  // The public ACP registry: the document is cached beside `agents.json`,
  // and a binary entry's download lands under the same state directory.
  // The env override is for tests and for anyone running a registry of
  // their own.
  const acpRegistry = new AcpRegistry({
    stateDir,
    ...(process.env['HARNESSDESK_ACP_REGISTRY_URL']
      ? { url: process.env['HARNESSDESK_ACP_REGISTRY_URL'] }
      : {}),
    warn: (message, details) => logger.child('acp-registry').warn(message, details),
  })
  // Which copy of each agent answers: the newest on the machine that is new
  // enough, or the pinned one, with the row's own command as the fallback.
  // See `installs/service.ts` for why the row is not trusted to know.
  const installs = new InstallService({
    stateDir,
    store: agentRegistry,
    registryVersion: (id) => acpRegistry.currentVersion(id),
    log: (message, details) => logger.child('installs').info(message, details),
  })
  const buildAcpRuntime = (agent: AcpAgentConfig): AcpRuntime => {
    const executable = installs.executableSpecFor(agent)
    const known = installs.knowledgeFor(agent)
    const env = { ...process.env, ...agent.env }
    // Who the agent is signed in as, from its own files, for the agents that
    // write it down and cannot be asked. See `installs/identity.ts`.
    const resolveIdentity = identityReaderFor(known, { ...(agent.args ? { args: agent.args } : {}), env })
    // Usage an agent counts in its own store and puts none of on the wire.
    // See `usage/antigravity-store.ts`.
    const usageRecord = usageRecordFor(known, { env })
    return new AcpRuntime({
      ...agent,
      // A row written under a name the desk has since retired is shown under
      // today's; a name someone chose stays. See `KnownAgent.formerNames`.
      name: currentNameOf(known, agent.name),
      // Entries written before templates carried brands have none; the
      // template's is what they would say today. See `templateBrandFor`.
      ...(agent.brand ? {} : templateBrandFor(agent.id) ? { brand: templateBrandFor(agent.id) } : {}),
      ...(executable ? { executable } : {}),
      env: agentEnvironment(socketPath, agent.env),
      ...(toolServer ? { toolServer: { ...toolServer, onSession: claimCaller(agent.id) } } : {}),
      logger: logger.child(agent.id),
      resolveSecret: (env) => host.credentials.peek(CredentialBroker.secretName(agent.id, env)),
      resolveLaunch: (occasion) => installs.launchFor(agent, occasion),
      resolveExecutable: (spec) => installs.executableFor(agent, spec),
      ...(resolveIdentity ? { resolveIdentity } : {}),
      ...(usageRecord ? { usageRecord } : {}),
    })
  }
  const agents = new AgentDirectory({
    store: agentRegistry,
    build: buildAcpRuntime,
    usageFor: (agent) => localUsageFor(agent),
    registry: acpRegistry,
    installs,
  })

  const host = new Host({
    logger,
    accounts,
    agents,
    installs,
    state: new StateStore(join(stateDir, 'state.json')),
    version: options.version ?? '0.1.0',
    extensions,
    ...(updates ? { updates } : {}),
    // Minutes between re-asking each agent what it offers; 0 turns the timer
    // off. Cursor adds models server-side; this is how a long-open window
    // hears about them. See docs/agents.md.
    ...(process.env['HARNESSDESK_CATALOG_REFRESH_MINUTES'] !== undefined
      ? { catalogRefreshMs: Math.max(0, Number(process.env['HARNESSDESK_CATALOG_REFRESH_MINUTES']) || 0) * 60_000 }
      : {}),
    ...(options.credentialCipher ? { credentialCipher: options.credentialCipher } : {}),
    ...(options.pickDirectory ? { pickDirectory: options.pickDirectory } : {}),
    ...(options.revealPath ? { revealPath: options.revealPath } : {}),
  })

  // The editor plane exists only now, because it needs the host's own roots
  // and broadcasters — and the extension surface had to be built first, so a
  // session started early is not born with an empty tool set. Both halves are
  // told: built-ins run in this process, installed plugins run in the child.
  extensions.setEditorEngine(host.editorPlane)
  // The team plane rides the same wiring: built-ins reach it through the
  // module-level engine, installed plugins by forwarding from the child.
  extensions.setTeamEngine(host.teamPlane)

  // Codex writes its rollouts where the ledger can read them, and meters
  // itself over its own API — so it needs a corpus and no meter.
  host.bindUsage(runtimeId('codex'), { corpus: 'codex' })

  host.register(
    new CodexRuntime({
      clientName: 'harnessdesk',
      clientVersion: options.version ?? '0.1.0',
      // An explicit path beats discovery; the env form is for shells that
      // start the host for you, the desktop app included.
      binaryPath: options.codexBinaryPath ?? process.env['HARNESSDESK_CODEX_BINARY'] ?? null,
      codexHome: options.codexHome ?? null,
      logger: logger.child('codex'),
      capabilities: extensions,
    }),
  )

  // Every other account of the same Codex. Deliberately no usage corpus: the
  // rollouts under a slot's home ARE the primary's rollouts, one symlink away,
  // and binding the same files twice would bill every session to two accounts.
  // What is genuinely per-account — the rate limits — comes over each
  // process's own `account/rateLimits/read`.
  for (const slot of slots.of(CODEX_RUNTIME_ID)) {
    host.register(codexAccount(slot.id, slot.home))
  }

  void host.credentials.warm()
  for (const agent of agentRegistry.configs()) {
    const local = localUsageFor(agent)
    if (local) host.bindUsage(runtimeId(agent.id), local)
    host.register(buildAcpRuntime(agent))
  }

  // Nothing waits on this; it is returned so a test can, and so the shape of
  // the promise is visible to whoever reads the wiring. See `shell-path.ts`.
  return { host, logger, extensions, pathReady }
}

/**
 * Where a registered agent's own numbers sit on this machine.
 *
 * Bound to the CLI the entry actually drives rather than to its id, because
 * the id is the user's to choose — someone who calls their entry `anthropic`
 * still gets a meter, and someone who names an unrelated agent `claude-code`
 * does not get the wrong one.
 */
const localUsageFor = (
  agent: AcpAgentConfig,
): { meter?: UsageMeter; corpus?: 'codex' | 'claude' } | null => {
  const cli = agent.executable?.command ?? agent.account?.status?.command ?? null
  switch (cli) {
    case 'claude':
      return { meter: new ClaudeFileMeter(), corpus: 'claude' }
    case 'cursor-agent':
      return { meter: new CursorMeter() }
    case 'gemini':
      return { meter: new GeminiMeter() }
    case 'copilot':
      return { meter: new CopilotMeter() }
    default:
      return null
  }
}

/**
 * Loads the built-in plugins, then anything the user installed.
 *
 * Separate from construction so tests can skip it, and ordered so a built-in id
 * cannot be shadowed by an installed plugin claiming the same name.
 */
export const loadBuiltinPlugins = async (extensions: SupervisedExtensionHost): Promise<void> => {
  for (const plugin of builtinPlugins) {
    await extensions.loadBuiltin(plugin)
  }
  await extensions.loadInstalledPlugins()
}
