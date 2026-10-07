import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

import { AcpRuntime, geminiTrustsFolder, geminiTrustsFolderStatus, type AcpAgentConfig } from '@harnessdesk/adapter-acp'
import { runtimeId, sessionId, type RuntimeInfo } from '@harnessdesk/protocol'
import { CodexRuntime, CODEX_RUNTIME_ID } from '@harnessdesk/adapter-codex'
import { ExtensionKernel, setBrowserEngine, type BrowserEngine } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '@harnessdesk/extension-host'
import { invokeForBridge, ToolGateway, type BridgeCaller } from './tool-gateway.js'
import { GatedRegistry } from './ceilings/gate.js'
import { attachmentGateway } from './attachments/wiring.js'
import { builtinPlugins } from '@harnessdesk/plugins'

import { AccountSlots, accountIdentity, codexPrimaryHome, writeGatewayConfig } from './accounts.js'
import { AcpRegistry } from './acp-registry.js'
import { applyLoginShellPath } from './installs/shell-path.js'
import { developerToolsEnvironment, type DeveloperToolsOptions } from './installs/developer-tools.js'
import { knowledgeOverlay } from './installs/overlay.js'
import type { KnownAgent } from './installs/known-agents.js'
import { commandName, InstallService } from './installs/service.js'
import { AgentDirectory, AgentRegistryStore, packagedPath, templateBrandFor } from './agent-registry.js'
import { CredentialBroker } from './credentials.js'
import { Host, type AccountFactory, type HostOptions } from './host.js'
import { ClaudeFileMeter } from './usage/claude-file.js'
import { corpusRoot, type CorpusKind, type RemoteEventsSource } from './ledger/index.js'
import { AgyMeter } from './usage/agy.js'
import { AmpMeter } from './usage/amp.js'
import { ClineMeter } from './usage/cline.js'
import { clineDataDirOverride } from './installs/identity.js'
import { CopilotMeter } from './usage/copilot.js'
import { CursorMeter } from './usage/cursor.js'
import { CursorEventsSource } from './usage/cursor-events.js'
import { DeepSeekMeter } from './usage/deepseek.js'
import { GeminiMeter } from './usage/gemini.js'
import { OpenRouterMeter } from './usage/openrouter.js'
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

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/**
 * Agent MCP clients may filter ELECTRON_RUN_AS_NODE (the Gemini CLI drops
 * it), so the launcher sets it itself before executing Electron as Node.
 * Without it the bridge runs as an Electron app, with a Dock icon (#1155).
 * It lives in this desk's own `run/` directory, never beside the socket:
 * the socket can fall back to the shared temporary directory when its path
 * is too long, and a fixed launcher name there would be one desk's
 * overwriting another's.
 */
export const writeToolLauncher = (directory: string, execPath: string, entry: string): string => {
  const launcher = join(directory, 'hd-mcp-tools')
  const temporary = join(directory, `.hd-mcp-tools.${process.pid}.${randomUUID()}.tmp`)
  mkdirSync(directory, { recursive: true })
  try {
    writeFileSync(
      temporary,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(entry)} "$@"\n`,
      { mode: 0o755 },
    )
    chmodSync(temporary, 0o755)
    renameSync(temporary, launcher)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The write may have failed before a temp file existed.
    }
    throw error
  }
  return launcher
}

/** A bridge reads only the checkout the host assigned, never the peer's cwd. */
export const bridgeCallerFor = (host: Pick<Host, 'registry'>, runtime: string, id: string): BridgeCaller => ({
  runtime, sessionId: id,
  get workspaceRoot() { return host.registry.get(runtimeId(runtime), sessionId(id))?.shellCheckout?.cwd },
})

export interface ToolServerOptions {
  readonly electron?: boolean
  readonly execPath?: string
  readonly log?: (message: string) => void
}

export const createToolServer = (
  socketPath: string,
  bridgeEntry: string,
  /** This desk's own `run/` directory: see `writeToolLauncher`. */
  launcherDir: string,
  options: ToolServerOptions = {},
): { name: string; command: string; args: string[]; env: Record<string, string> } => {
  const electron = options.electron ?? Boolean(process.versions.electron)
  const execPath = options.execPath ?? process.execPath
  const env = {
    HD_TOOLS_SOCKET: socketPath,
    ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }

  // Windows has no sh launcher, and the Dock issue this handles is macOS-only.
  if (!electron || process.platform === 'win32') {
    return { name: 'harnessdesk', command: execPath, args: [bridgeEntry], env }
  }

  try {
    return {
      name: 'harnessdesk',
      command: writeToolLauncher(launcherDir, execPath, bridgeEntry),
      args: [],
      env,
    }
  } catch {
    options.log?.('could not write the MCP tool launcher; using the direct Electron command')
    return { name: 'harnessdesk', command: execPath, args: [bridgeEntry], env }
  }
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
  agent?: string,
  developerEnv: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> => ({
  ...developerEnv,
  HD_TOOLS_SOCKET: socketPath,
  // Which agent a composition-spawned bridge came from. It is said only by a
  // bridge no conversation offered — one with no caller token — so the desk
  // can point at the agent whose configuration still carries it.
  ...(agent ? { HD_TOOLS_AGENT: agent } : {}),
  ...agentEnv,
})

/** What the desk says, once per agent, about a tool server its own configuration composed. */
export const TOKENLESS_BRIDGE_NOTICE =
  "This agent's own configuration starts a HarnessDesk tool server of its own. Each conversation " +
  'already brings one, so remove that entry: its calls cannot say which conversation made them, ' +
  'and the board refuses them.'

export interface BootstrapOptions {
  /** Injectable selection and filesystem probes for the opt-in macOS workaround. */
  readonly developerTools?: DeveloperToolsOptions
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error'
  /** How stored credentials are protected at rest; the desktop shell passes safeStorage. */
  readonly credentialCipher?: HostOptions['credentialCipher']
  readonly stateDir?: string
  readonly codexBinaryPath?: string | null
  readonly codexHome?: string | null
  readonly version?: string
  readonly pickDirectory?: HostOptions['pickDirectory']
  readonly revealPath?: HostOptions['revealPath']
  readonly trashPath?: HostOptions['trashPath']
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
  const developerEnv = developerToolsEnvironment({
    ...options.developerTools,
    log: (message) => logger.child('developer-tools').info(message),
  })

  // Before any runtime exists: the app opened from the Dock has launchd's
  // PATH, which names nothing the person installed, and a runtime built
  // against that PATH has already looked for its agent and found nothing.
  // See `installs/shell-path.ts` for what is asked and in which order.
  const pathReady = applyLoginShellPath({
    stateDir,
    log: (message, details) => logger.child('path').info(message, details),
  }).settled
  // What the process has now, before any runtime has been asked anything: if the
  // shell's answer changes it, the runtimes asked in the meantime looked at a
  // different machine. See where `pathReady` is used at the end.
  const pathAtStart = process.env['PATH']

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
  // Every runtime sees the same capability surface; the gate consults the
  // host only when a tool is invoked, after the host below exists.
  const gated = new GatedRegistry(extensions, () => host.ceilingGate)

  // Whether a newer build of an agent is published: one registry read a day
  // per package, cached here, and off entirely with HARNESSDESK_NO_UPDATE_CHECK.
  // Advisory — see docs/runtimes.md for why it exists at all.
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
      env: developerEnv,
      logger: logger.child(id),
      capabilities: gated,
      instructions: () => host.forgePlane.instructions(),
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
  const callers = new Map<string, BridgeCaller>()
  const bounded = <V>(map: Map<string, V>): void => {
    if (map.size > 2000) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
  }
  const claimCaller = (runtime: string) => (token: string, id: string) => {
    callers.set(token, bridgeCallerFor(host, runtime, id))
    bounded(callers)
  }
  // Which runtime a bridge's token belongs to, known from the moment the
  // open is sent — before the session has an id. The agent spawns the bridge
  // while `session/new` is still in flight, and the bridge asks the gateway
  // for its instructions at its own handshake, so the session-level claim
  // above arrives too late for that question.
  const callerRuntimes = new Map<string, string>()
  const claimOpen = (runtime: string) => (token: string) => {
    callerRuntimes.set(token, runtime)
    bounded(callerRuntimes)
  }
  // Phase 12's own gateway: a Seat's approved external MCP servers, reached
  // through the very same socket and the very same correlation token as the
  // desk's own plugin tools — but gated by `host.ceilingGate`, the identical
  // gate every other tool call answers to, and resolved to a Seat through
  // the registry alone, never inferred from anything a call itself says.
  const mcpBackend = attachmentGateway(() => host, (token) => callers.get(token))
  const socketPath = toolSocketPath(stateDir)
  const gateway = new ToolGateway(socketPath, {
    listTools: () => extensions.list('tool', {}),
    // Read at each bridge's handshake rather than fixed at start: whether
    // the sentence applies depends on which plugins are enabled right now.
    // Nothing for a bridge whose agent's runtime carries the sentence in an
    // instruction layer of its own — Claude Code heard it twice otherwise,
    // once appended to its system prompt and once as the server's own.
    instructions: (caller) => {
      const runtime = caller !== undefined ? (callers.get(caller)?.runtime ?? callerRuntimes.get(caller)) : undefined
      if (runtime !== undefined && host.runtimeInfo(runtime)?.capabilities.instructions) return ''
      return host.forgePlane.instructions()
    },
    // Said once per agent per launch: the entry stays until the person removes it.
    tokenless: (agent) => {
      if (agent === undefined || tokenlessWarned.has(agent)) return
      const runtime = acpRuntimes.get(agent)
      if (!runtime) return
      tokenlessWarned.add(agent)
      logger.warn('a tool bridge started from an agent configuration, not a conversation', { agent })
      runtime.emit({ type: 'notice', class: 'info', kind: 'runtime:warning', level: 'warning', message: TOKENLESS_BRIDGE_NOTICE })
    },
    invokeByName: (namespace, name, args, caller) =>
      invokeForBridge(gated, callers, { namespace, name, args, caller }, (message, details) =>
        logger.debug(message, details),
      ),
    ...mcpBackend,
  })
  gateway.start()
  const bridgeEntry = toolBridgeEntry()
  if (bridgeEntry === null) {
    logger.warn('the plugin tool bridge is missing; ACP agents will run without HarnessDesk tools', {
      expected: packagedPath(defaultToolBridgeEntry()),
    })
  }
  const toolServer = bridgeEntry
    ? createToolServer(socketPath, bridgeEntry, join(stateDir, 'run'), {
        log: (message) => logger.warn(message),
      })
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
  // The latest runtime built for each agent, so a notice about one of them —
  // a tool server its own configuration composed — reaches its window.
  const acpRuntimes = new Map<string, AcpRuntime>()
  const tokenlessWarned = new Set<string>()
  const buildAcpRuntime = (agent: AcpAgentConfig): AcpRuntime => {
    const executable = installs.executableSpecFor(agent)
    const log = logger.child(agent.id)
    const built = new AcpRuntime({
      ...agent,
      probeSessionsFile: join(stateDir, 'option-probes', `${encodeURIComponent(agent.id)}.jsonl`),
      // Today's name for a row still carrying a retired one, who the agent is
      // signed in as, and where it keeps usage it puts none of on the wire.
      // See `installs/overlay.ts`.
      ...knowledgeOverlay(agent, installs.knowledgeFor(agent), {
        warn: (message, details) => log.warn(message, details),
      }),
      // Entries written before templates carried brands have none; the
      // template's is what they would say today. See `templateBrandFor`.
      ...(agent.brand ? {} : templateBrandFor(agent.id) ? { brand: templateBrandFor(agent.id) } : {}),
      ...(agent.id === 'gemini'
        ? {
            pluginToolsAvailableAt: (cwd: string) => geminiTrustsFolder(cwd, { env: { ...process.env, ...agent.env } }),
            pluginToolsProblemAt: (cwd: string) => geminiTrustsFolderStatus(cwd, { env: { ...process.env, ...agent.env } }).unavailable
              ? "Gemini can't read its trusted-folders file, so it can't use board tools. Fix that file and start again."
              : null,
            pluginToolsUnavailable: "Gemini doesn't trust this folder, so it can't use the board. Open Gemini here, run /permissions trust, and start again.",
          }
        : {}),
      ...(executable ? { executable } : {}),
      env: agentEnvironment(socketPath, agent.env, agent.id, developerEnv),
      ...(toolServer
        ? { toolServer: { ...toolServer, onOpen: claimOpen(agent.id), onSession: claimCaller(agent.id) } }
        : {}),
      instructions: () => host.forgePlane.instructions(),
      logger: log,
      resolveSecret: (env) => host.credentials.peek(CredentialBroker.secretName(agent.id, env)),
      resolveLaunch: (occasion) => installs.launchFor(agent, occasion),
      resolveExecutable: (spec) => installs.executableFor(agent, spec),
    })
    acpRuntimes.set(agent.id, built)
    return built
  }
  const agents = new AgentDirectory({
    store: agentRegistry,
    build: buildAcpRuntime,
    usageFor: (agent) =>
      localUsageFor(agent, installs.knowledgeFor(agent), (agentId, envName) =>
        host.credentials.peek(CredentialBroker.secretName(agentId, envName)),
      ),
    registry: acpRegistry,
    installs,
  })

  const host: Host = new Host({
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
    // hears about them. See docs/runtimes.md.
    ...(process.env['HARNESSDESK_CATALOG_REFRESH_MINUTES'] !== undefined
      ? { catalogRefreshMs: Math.max(0, Number(process.env['HARNESSDESK_CATALOG_REFRESH_MINUTES']) || 0) * 60_000 }
      : {}),
    ...(options.credentialCipher ? { credentialCipher: options.credentialCipher } : {}),
    ...(options.pickDirectory ? { pickDirectory: options.pickDirectory } : {}),
    ...(options.revealPath ? { revealPath: options.revealPath } : {}),
    ...(options.trashPath ? { trashPath: options.trashPath } : {}),
  })

  // The editor plane exists only now, because it needs the host's own roots
  // and broadcasters — and the extension surface had to be built first, so a
  // session started early is not born with an empty tool set. Both halves are
  // told: built-ins run in this process, installed plugins run in the child.
  extensions.setEditorEngine(host.editorPlane)
  // The team plane rides the same wiring: built-ins reach it through the
  // module-level engine, installed plugins by forwarding from the child.
  extensions.setTeamEngine(host.teamPlane)
  // And the forge plane: the seat a publication is signed as, the record of
  // it in the transcript, and the one sentence that tells an agent so.
  extensions.setForgeEngine(host.forgePlane)

  // Codex writes its rollouts where the ledger can read them, and meters
  // itself over its own API — so it needs a corpus and no meter.
  // Closed when the desk quits, like everything else it owns: no bridge
  // reaches a Seat's server through a socket the desk has left behind.
  host.onDispose(() => gateway.stop())
  host.bindUsage(runtimeId('codex'), { corpus: 'codex' })

  host.register(
    new CodexRuntime({
      clientName: 'harnessdesk',
      clientVersion: options.version ?? '0.1.0',
      // An explicit path beats discovery; the env form is for shells that
      // start the host for you, the desktop app included.
      binaryPath: options.codexBinaryPath ?? process.env['HARNESSDESK_CODEX_BINARY'] ?? null,
      codexHome: options.codexHome ?? null,
      env: developerEnv,
      logger: logger.child('codex'),
      capabilities: gated,
      instructions: () => host.forgePlane.instructions(),
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
    const local = localUsageFor(agent, installs.knowledgeFor(agent), (agentId, envName) =>
      host.credentials.peek(CredentialBroker.secretName(agentId, envName)),
    )
    if (local) host.bindUsage(runtimeId(agent.id), local)
    host.register(buildAcpRuntime(agent))
  }

  // The shell's PATH lands after the first ask, and an agent installed where
  // only that PATH looks would stay "not installed" until the app restarted. So
  // when it changes anything, the runtimes that could not find their program, or
  // found it and could not run it, are asked once more. Nothing awaits this;
  // `retryProgramLookup` says why it is safe to run whenever the PATH lands.
  void pathReady.then(() => {
    if (process.env['PATH'] !== pathAtStart) void host.retryProgramLookup().catch((error: unknown) => {
      logger.child('path').warn('asking the missing agents again failed', { error: String(error) })
    })
  })

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
 *
 * Three fields can say which CLI that is, and only the first two were read
 * here until now: a bridge row names it (`executable`), a row with a sign-in
 * names it (`account.status`), and a row for a CLI that speaks ACP itself
 * names *neither* — its `command` is the CLI, and which agent that is, is
 * the knowledge table's question. So a Gemini registered from a template and
 * a Copilot registered from the registry both came up with a meter case
 * written for them that nothing ever reached, and reported as unmetered with
 * nothing to say why. The knowledge is the same lookup the launch decision
 * makes, so a row cannot be metered as one agent and started as another;
 * `commandName` because the row may spell any of them absolutely, or with
 * Windows's `.exe`.
 *
 * And a row the table has no entry for — Amp's registry adapter, Qwen Code
 * through `npx` — is named by the program it runs (`ownCli`), last, so the
 * table still decides wherever it has something to say.
 */
/**
 * The env var every OpenRouter integration reads its key from. What decides
 * a row gets the OpenRouter meter is that row's *own* configuration — the
 * desk's broker, then the row's own declared environment — never
 * HarnessDesk's own shell: a key exported where the desk itself launched
 * from is not this row's, and treating it as one would attribute one
 * account's spend to every agent that carries no key of its own
 * (docs/usage-dashboard.md, "Where the numbers come from"). Bound to every
 * row that has no stronger meter of its own (Cline's own balance is
 * Cline's, whatever key it also holds), whether or not it has a key yet:
 * the key itself is asked fresh on every read, so a key stored in the
 * broker after this bound — or cleared from it — is honoured on the next
 * read without a rebind, and a row with none makes no request at all.
 */
const OPENROUTER_SECRET_ENV = 'OPENROUTER_API_KEY'

export const localUsageFor = (
  agent: AcpAgentConfig,
  known?: Pick<KnownAgent, 'cli'> | undefined,
  /**
   * The desk's own stored copy of a row's secret, when it has one — the
   * broker `resolveSecret` on the runtime hands the process at launch,
   * asked here the same way so a meter reads exactly what the agent itself
   * would start with, never a value this function invents or asks the
   * person for.
   */
  resolveSecret?: (agentId: string, envName: string) => string | undefined,
): { meter?: UsageMeter; corpus?: CorpusKind; root?: string; remote?: RemoteEventsSource; deskTurns?: boolean } | null => {
  const named = agent.executable?.command ?? agent.account?.status?.command ?? known?.cli.commands[0] ?? ownCli(agent)
  // Where the agent keeps its records is decided by its own environment — a
  // row can move an agent's home to hold a second account — so paths are
  // resolved against what the row adds to the desk's.
  const env = { ...process.env, ...agent.env }
  // A row that isolates an agent with a bare `HOME` — the ordinary way, ahead
  // of any bespoke variable — moves every one of these fallbacks with it: it
  // is what the row's own process resolves `homedir()` to, so it is what
  // reading the row's files by hand has to match (review round 5).
  const home = env['HOME']?.trim() || homedir()
  const records = (corpus: CorpusKind) => ({ corpus, root: corpusRoot(corpus, env, home) })
  const base = ((): { meter?: UsageMeter; corpus?: CorpusKind; root?: string; remote?: RemoteEventsSource; deskTurns?: boolean } => {
  switch (named ? commandName(named) : null) {
    case 'claude':
      return { meter: new ClaudeFileMeter(), corpus: 'claude' }
    case 'cursor-agent':
      // Cursor keeps no local transcript (rule 3): its tokens, requests and
      // Value come from its own account-wide usage events, not a corpus. Its
      // events carry no turn boundary at all — a request is not a turn — so
      // turns are the desk's own transcript instead (`deskTurns`).
      return { meter: new CursorMeter(), remote: new CursorEventsSource(agent.id), deskTurns: true }
    case 'gemini':
      // A Code Assist sign-in has a quota to read; an API key has none, and
      // what its calls cost is in the chat logs either way.
      return { meter: new GeminiMeter({ env, home }), ...records('gemini') }
    case 'copilot':
      // No corpus reads Copilot's own history; its turns are the desk's own transcript.
      return { meter: new CopilotMeter(), deskTurns: true }
    // The ACP server reports no quota, but the `agy` CLI beside it does. It is
    // the CLI's own sign-in, so its figures are shown and never gate the
    // agent — see `usage/agy.ts`. Its own turns are unreadable the same way;
    // the desk's transcript stands in.
    case 'agy_acp_server':
      return { meter: new AgyMeter(), deskTurns: true }
    case 'cline': {
      // `--data-dir` moves Cline's folder; there is no environment variable
      // for it, so a row that runs `cline --data-dir <dir> --acp` is read
      // from there — sign-in and spend together — rather than from whatever
      // `CLINE_DATA_DIR` or the process home holds. `CLINE_DB_DATA_DIR` still
      // wins for the database alone, exactly as `corpusRoot` gives it
      // precedence when there is no override: the two flags name different
      // things, and a row can set one without the other (review round 4).
      const override = clineDataDirOverride({ args: agent.args, cwd: agent.cwd, home })
      if (override === null) return { meter: new ClineMeter({ env }), ...records('cline') }
      const dbDataDir = env['CLINE_DB_DATA_DIR']?.trim()
      return {
        meter: new ClineMeter({ env, settingsPath: join(override, 'settings', 'providers.json') }),
        corpus: 'cline',
        root: join(dbDataDir || join(override, 'db'), 'sessions.db'),
      }
    }
    case 'opencode':
      // Zen's balance has no endpoint an API key can read (asked upstream,
      // anomalyco/opencode#10448). Go's limits do — `GET /zen/go/v1/usage`
      // with the Go key — and are not read here yet: that needs a Go
      // subscription to measure against. What OpenCode priced each session
      // at is in its own database either way.
      return records('opencode')
    case 'qwen':
    case 'qwen-code':
      return records('qwen')
    // The registry's `amp-acp` wraps the `amp` CLI, whose own `amp usage`
    // answers for the account both of them are signed in as.
    case 'amp':
    case 'amp-acp':
      return { meter: new AmpMeter({ env }), deskTurns: true }
    // DeepSeek Harness authenticates with a provider key, never a browser
    // sign-in (`agent-registry.ts`'s `dsh` entry); its prepaid balance is
    // DeepSeek's own API, kept a separate meter from any local records
    // because none exist here yet for it. Bound by runtime, not by a base
    // URL check — DSH is DeepSeek's harness by definition, the same way
    // `agy_acp_server` above is bound to Antigravity's CLI outright.
    case 'dsh':
      return {
        meter: new DeepSeekMeter({
          env,
          key: () => resolveSecret?.(agent.id, 'DEEPSEEK_API_KEY'),
          alsoAt: agent.secrets?.find((secret) => secret.env === 'DEEPSEEK_API_KEY')?.alsoAt ?? [],
        }),
        deskTurns: true,
      }
    default:
      // No meter, no corpus — this agent has nothing else here at all. Its
      // turns are still worth knowing, and the desk's own transcript is the
      // one source that never needed to know which CLI this was.
      return { deskTurns: true }
  }
  })()
  // OpenRouter is never a CLI of its own — any agent above can be pointed at
  // it — so this is decided after the switch, and only fills in where
  // nothing above already found a stronger, agent-specific source: a row
  // whose own meter is Cline's or Amp's balance keeps that meter even when
  // the same row also carries an OpenRouter key for its model calls, because
  // that balance is a different account's money than the key's.
  if (!base.meter) {
    return {
      ...base,
      meter: new OpenRouterMeter({
        key: () => (resolveSecret?.(agent.id, OPENROUTER_SECRET_ENV) ?? agent.env?.[OPENROUTER_SECRET_ENV])?.trim(),
      }),
    }
  }
  return base
}

/**
 * The CLI a row runs when nothing else names it: the program itself, or — for
 * a registry row that runs its agent through a package runner — the package.
 * `npx -y @qwen-code/qwen-code@0.24.0 --acp` runs `qwen-code`. The knowledge
 * table is asked first; this is for the agents it has no entry for, whose
 * meter would otherwise be written and never reached.
 */
export const ownCli = (agent: Pick<AcpAgentConfig, 'command' | 'args'>): string | null => {
  const program = commandName(agent.command)
  if (!RUNNERS.has(program)) return program || null
  const args = agent.args ?? []
  const spec = args.find((arg, index) => !arg.startsWith('-') && !(index === 0 && (arg === 'dlx' || arg === 'exec')))
  if (!spec) return null
  // `@scope/name@1.2.3` and `name@1.2.3` both name the package before the version.
  const unversioned = spec.startsWith('@') ? spec.replace(/^(@[^/]+\/[^@]+)@.*$/, '$1') : spec.replace(/@.*$/, '')
  return unversioned.split('/').pop() || null
}

const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'bun'])

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
