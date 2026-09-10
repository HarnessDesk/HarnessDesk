import { randomBytes } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type { BrowserSettings } from '@harnessdesk/cordis-host'
import { GatewaySupervisor } from '@harnessdesk/responses-gateway'

import {
  holderOf,
  isBusy,
  isSessionBusy,
  isSessionGone,
  reopenRefusedByAgent,
  SessionGoneError,
  SessionBusyError,
  sessionId as makeSessionId,
  sessionKey,
  type AgentEvent,
  type AgentRuntime,
  type ArchiveFilter,
  type AgentSession,
  type ConfigOption,
  type TurnId,
  type CapabilityRegistry,
  type ContextImage,
  type BackupFile,
  type BackupReport,
  type ExtensionEvent,
  type Page,
  type HostMethodName,
  type HostParams,
  type HostResult,
  type RuntimeHealth,
  type RuntimeInfo,
  type RuntimeUpdate,
  type PluginSource,
  type RuntimeFiles,
  type RuntimeId,
  type Session,
  type SessionId,
  type RepoInfo,
  type SessionSummary,
  type Turn,
  type UserContent,
  type Unsubscribe,
  type WireNotification,
  type ResolvedModelRoute,
  type Approval,
  type ContributionId,
  type ScopeQuery,
  type SecretReload,
  type PublicationItem,
  runtimeId,
} from '@harnessdesk/protocol'

import type { AgentDirectory } from './agent-registry.js'
import type { InstallService } from './installs/service.js'
import { AuditLog } from './audit.js'
import { CatalogRefresher } from './catalog-refresher.js'
import { Ledger, defaultCorpora, type CorpusSpec } from './ledger/index.js'
import type { UsageMeter } from './usage/meter.js'
import { UsageService } from './usage/service.js'
import { CredentialBroker, plainCipher, type CredentialCipher } from './credentials.js'
import * as gitService from './git.js'
import * as gitOps from './git-ops.js'
import { Worktrees, repositoryOf } from './worktree.js'
import type { InventoryAgent } from '@harnessdesk/agent-inventory'
import { LibraryUsageReader } from './library-usage.js'
import type { Logger } from './log.js'
import { SessionRegistry, type SessionRecord } from './registry.js'
import { StateStore } from './state.js'
import { EditorPlane } from './editor-plane.js'
import { Terminals } from './terminals.js'
import { SessionArchive } from './archive.js'
import { ForgePlane, type ForgePlaneOptions } from './forge.js'
import { publicationsIn, withPublications } from './publications.js'
import { SessionNames } from './names.js'
import { redactorFor } from './diagnostics.js'
import { Team, type TeamPeer, type TeamTurnFailure } from './team.js'
import { TranscriptStore } from './transcripts.js'
import { LocalFiles, confine, describeWorkspace } from './workspace.js'
import { dispatch, TERMINAL_CHIP, type HostContext } from './methods/index.js'

/**
 * The host.
 *
 * Owns every runtime, holds authoritative session state, and answers the wire
 * protocol. It is also the trust boundary: credentials, process handles, and
 * filesystem access all stop here, and the renderer only ever sees the results.
 */

/**
 * The extension side of the host.
 *
 * Deliberately narrower than the kernel's own API: the host only needs to read
 * contributions and drive plugin lifecycle, and keeping the surface small is
 * what lets a different extension kernel back it.
 */
export interface ExtensionHost extends CapabilityRegistry {
  setEnabled(pluginId: string, enabled: boolean): Promise<void>
  reconfigure(pluginId: string, config: Readonly<Record<string, unknown>>): Promise<void>
  runCommand(name: string, argument: string, scope: { sessionId?: SessionId }): Promise<boolean>
  resolveOne(
    id: ContributionId,
    ref: string | undefined,
    scope: ScopeQuery,
  ): Promise<{ label: string; text: string; image?: ContextImage } | null>
  setWorkspace(state: { root: string | null; branch: string | null }): void
  /** Where an agent's `browser_open` puts the page. See `BrowserSettings`. */
  setBrowserSettings(settings: BrowserSettings): void
  /** Reads a manifest for the consent dialog; imports nothing. */
  inspectPlugin(specifier: string): Promise<{
    id: string
    name: string
    description?: string
    version?: string
    source: PluginSource
    permissions: readonly string[]
    alreadyInstalled: boolean
  }>
  installPlugin(specifier: string): Promise<string>
  uninstallPlugin(pluginId: string): Promise<void>
}

/** One permission-policy rule, as stored in preferences. */
interface PolicyRule {
  readonly id: string
  readonly name: string
  readonly match: { readonly type?: string; readonly pattern?: string }
  readonly action: 'approve' | 'deny'
}

/** A stored model route: where to send traffic, and which credential pays for it. */
export interface ModelRouteRecord {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly wireProtocol: string
  readonly credentialRef: string
  readonly model?: string
}

/**
 * How long a runtime gets to start before the rest of the app stops waiting.
 *
 * Not a failure, and not a cancellation: `start()` is left running, and an
 * agent that comes up late still announces itself to a window that is by then
 * open to hear it. What this bounds is how long every other agent — and the
 * window itself — can be held shut by one of them.
 *
 * The case that made it necessary is not a slow agent but a silent one: a
 * command that exists and speaks a protocol we do not, so `initialize` is
 * never answered and the promise neither resolves nor rejects. A registry
 * pointing at the wrong binary is an ordinary mistake, and before this it
 * cost the whole app — no window, no error, nothing to read.
 */
const START_TIMEOUT_MS = 15_000
/**
 * How long a send may count as busy without the agent having accepted it.
 * The mark exists to keep two messages typed in the same breath from both
 * going out; it must not let an agent that never answers hold every later
 * message behind it. After this long the mark comes off and the conversation
 * is judged by its session again, exactly as it was before the mark existed.
 */
const SEND_ACCEPT_DEADLINE_MS = 30_000

/**
 * The "Last terminal output" composer chip. Terminals are the host's own
 * workbench tool — they never became a plugin — so this contribution lives
 * here: `capability/list` appends it and `context/resolve` answers it from
 * `Terminals.lastOutput()`. See docs/extending.md.
 */
export interface HostOptions {
  /** How the forge plane reaches `gh`, and how long it trusts an answer. Tests substitute a forge. */
  readonly forge?: ForgePlaneOptions
  readonly logger: Logger
  /**
   * How stored credentials are protected at rest. The desktop shell passes a
   * safeStorage-backed cipher (OS keychain material); absent, storage is
   * plain bytes behind file permissions, and the UI says so.
   */
  readonly credentialCipher?: CredentialCipher
  /** Optional: HarnessDesk runs fine with no extension kernel at all. */
  readonly extensions?: ExtensionHost
  readonly state?: StateStore
  /** Opens a native directory picker. Supplied by the desktop shell. */
  readonly pickDirectory?: () => Promise<string | null>
  /** Shows a folder in the OS file browser. Supplied by the desktop shell. */
  readonly revealPath?: (path: string) => Promise<void>
  readonly version?: string
  /**
   * Tells a runtime when a newer build of it is published. Optional: without
   * one, `RuntimeInfo.update` is never set and nothing else changes.
   */
  readonly updates?: { updateFor(info: RuntimeInfo): Promise<RuntimeUpdate | null> }
  /**
   * How often to re-ask runtimes what they offer — see `CatalogRefresher`.
   * Zero disables the timer; "Refresh models" still works.
   */
  readonly catalogRefreshMs?: number
  /**
   * How long one runtime may take to start before the rest of the app stops
   * waiting for it. See `START_TIMEOUT_MS`.
   */
  readonly startTimeoutMs?: number
  /**
   * How long a direct send counts the conversation as busy while the agent
   * has not yet accepted it. See `SEND_ACCEPT_DEADLINE_MS`.
   */
  readonly sendAcceptDeadlineMs?: number
  /**
   * How to give an agent one more account. Supplied by the wiring, because
   * only the wiring knows that a second Codex means a second process over a
   * second credential home — the host stays free of any one backend's idea of
   * what an account is, exactly as the sign-in flows already are.
   */
  readonly accounts?: AccountFactory
  /**
   * The writable agent registry — how the interface adds and removes ACP
   * agents. Supplied by the wiring, which is the only place that knows how a
   * registry entry becomes a runtime; without one, `agents/register` says so.
   */
  readonly agents?: AgentDirectory
  /**
   * Every copy of an agent on this machine, and which one answers. Attached
   * to `RuntimeInfo.install` and asked again through `agents/installs`.
   */
  readonly installs?: InstallService
}

/**
 * The wiring's answer to "another account, please".
 *
 * `add` returns a runtime that is not yet registered and not yet started; the
 * host does both, so that a factory cannot half-join a runtime to the session
 * registry. `remove` undoes whatever `add` created on disk.
 */
export interface AccountFactory {
  /** Whether one more account of this runtime is possible at all. */
  canAdd(info: RuntimeInfo): boolean
  /** The primary this runtime is an account of, and where its credential sits. */
  slotOf(info: RuntimeInfo): {
    agent: RuntimeId
    home: string | null
    removable: boolean
    /** Present when this account pays through an endpoint of the user's own. */
    gateway?: { name: string; endpoint: string; credentialRef: string }
  } | null
  add(info: RuntimeInfo, gateway?: NewGatewayAccount): Promise<AgentRuntime>
  remove(runtime: RuntimeId): Promise<void>
  /**
   * Who this account is signed in as, as a string the host only ever compares
   * with another of its own. Opaque on purpose: what makes two credentials the
   * same identity is the backend's question — one email can hold two
   * workspaces, and those are two accounts — so the wiring answers it and the
   * host acts on the answer. Null means the wiring cannot tell, which is never
   * treated as a match.
   */
  identityOf?(info: RuntimeInfo): string | null
  /**
   * Points a gateway account at the loopback address its traffic must use,
   * before it starts and again on every restart — the port is not stable
   * across either. The host resolves the credential and runs the gateway; the
   * factory owns whatever writing that takes, because only it knows the shape
   * of an account's home.
   */
  prepare?(runtime: RuntimeId, gateway: ResolvedModelRoute): Promise<void>
}

/** A gateway account as it arrives from the wire, before the key is brokered. */
export interface NewGatewayAccount {
  readonly name: string
  readonly endpoint: string
  readonly credentialRef: string
}

export type Broadcast = (notification: WireNotification) => void

/**
 * How many reopen refusals in a row, from an agent that is up and did not say
 * "gone", let a room member go. Two: one is a timeout or an overload that the
 * next delivery may well get past; a second in a row on the same conversation
 * is the pattern of a session that is not coming back, and every one of them
 * costs a person a refused post. See `Host#teamLive`.
 */
const REOPEN_REFUSALS_TO_LET_GO = 2

export class Host {
  readonly registry = new SessionRegistry()
  readonly #runtimes = new Map<string, AgentRuntime>()
  readonly #subscriptions: Unsubscribe[] = []
  /** Kept apart from `#subscriptions` so one runtime can be dropped alone. */
  readonly #runtimeSubscriptions = new Map<string, Unsubscribe[]>()
  /** Accounts a fold is in flight for; see `#foldDuplicateAccount`. */
  readonly #folding = new Set<string>()
  readonly #broadcasters = new Set<Broadcast>()
  readonly #state: StateStore
  readonly #logger: Logger

  readonly #extensions: ExtensionHost | null
  readonly #worktrees: Worktrees
  readonly #credentials: CredentialBroker
  readonly #gateways: GatewaySupervisor
  readonly #audit: AuditLog
  /** The transcript as the host watched it, for reads the backend returns thin. */
  readonly #transcripts: TranscriptStore
  #libraryUsage: LibraryUsageReader | null = null
  /** The archive for runtimes with none of their own. See `SessionArchive`. */
  readonly #archive: SessionArchive
  readonly #names: SessionNames
  /**
   * The team plane: the shared board and inter-agent messages. Held here for
   * the reason the editor plane is — it is the host that owns every session,
   * so a claim can be a transaction and a message can be routed with one set
   * of guards. The extension host only needs something that answers the
   * verbs, and gets it through `teamPlane`.
   */
  readonly #team: Team
  /**
   * The forge plane: the seat a publication is signed as, and the record of
   * it in the transcript. Held here for the reason the team plane is. The
   * extension host only needs something that answers the three verbs, and
   * gets it through `forgePlane`.
   */
  readonly #forge: ForgePlane
  /** Which board a folder belongs to, cached; cleared when workspaces change. */
  readonly #boardRoots = new Map<string, string | null>()
  /**
   * Which repository each folder belongs to, cached for the life of the host.
   * A folder does not change repository, so this is asked once per folder
   * however many conversations the history lists in it.
   */
  readonly #repos = new Map<string, Promise<RepoInfo | null>>()
  readonly #terminals = new Terminals((notification) => this.#push(notification))
  /**
   * The editor plane. Held here, and not in the extension host, because it is
   * the host that knows which roots are open and which clients are listening —
   * the extension host only needs something that answers the five verbs.
   */
  readonly #editor = new EditorPlane({
    files: () => this.#localFiles,
    roots: () => this.#openRoots(),
    push: (notification) => this.#push(notification),
  })
  /** Update advisories found so far, overlaid on each runtime's own `info`. */
  readonly #updates = new Map<string, RuntimeUpdate>()
  readonly #catalogs: CatalogRefresher
  /** Local sources bound to a runtime by the wiring; see `bindUsage`. */
  readonly #meters = new Map<RuntimeId, UsageMeter>()
  readonly #corpora: CorpusSpec[] = []
  #usage: UsageService | null = null
  #ledger: Ledger | null = null
  /** What the wire methods may reach; see `HostContext`. Built once the fields above exist. */
  readonly #context: HostContext

  /** Tells every client this runtime's sign-in state moved. */
  /**
   * Gets a changed secret into the agent that needs it. A runtime that holds
   * no host-side secret has nothing to do; one that does restarts, unless a
   * turn is running, and the answer is passed to the caller so the interface
   * can say which happened rather than a hopeful "saved".
   */
  async #reloadSecrets(runtime: RuntimeId): Promise<SecretReload> {
    const target = this.#runtimes.get(runtime)
    if (!target?.reloadSecrets) return 'unsupported'
    try {
      return await target.reloadSecrets()
    } catch (error) {
      this.#logger.warn('the agent could not be restarted for a changed secret', {
        runtime,
        error: error instanceof Error ? error.message : String(error),
      })
      return 'busy'
    }
  }

  async #announceAccount(runtime: RuntimeId): Promise<void> {
    this.#push({ method: 'event', params: { runtime, event: { type: 'account/changed', runtime } } })
  }

  /** Host-side only: the shell reads names, never values, over the wire. */
  get credentials(): CredentialBroker {
    return this.#credentials
  }

  constructor(private readonly options: HostOptions) {
    this.#logger = options.logger.child('host')
    this.#state = options.state ?? new StateStore()
    this.#worktrees = new Worktrees(this.#state.directory)
    this.#credentials = new CredentialBroker(
      join(this.#state.directory, 'credentials.json'),
      options.credentialCipher ?? plainCipher,
    )
    // The same file is read by the desktop shell and by a standalone host,
    // which protect secrets differently. One cannot read the other's, and the
    // shell shows that agent as signed out — so say why, once, rather than
    // leaving a key that looks stored and behaves absent.
    this.#credentials.onUnreadable((name, wrote, reader) => {
      this.#logger.warn(
        'a stored secret cannot be read here and counts as absent; enter it again to re-store it',
        { secret: name, storedWith: wrote, readingWith: reader },
      )
    })
    this.#gateways = new GatewaySupervisor(this.#logger.child('gateway'))
    this.#audit = new AuditLog(join(this.#state.directory, 'audit.ndjson'))
    this.#transcripts = new TranscriptStore(join(this.#state.directory, 'transcripts'), (message, details) =>
      this.#logger.warn(message, details),
    )
    this.#archive = new SessionArchive(join(this.#state.directory, 'archive.json'))
    this.#names = new SessionNames(join(this.#state.directory, 'names.json'))
    this.#forge = new ForgePlane(
      {
        agentOf: (runtime) => {
          const info = this.#runtimes.get(runtime)?.info
          return info ? { name: info.presentation.name, version: info.version ?? null } : null
        },
        optionsOf: (runtime, sessionId) => {
          const record = this.registry.get(runtimeId(runtime), makeSessionId(sessionId))
          if (!record) return null
          try {
            return record.live?.options() ?? record.session.options ?? []
          } catch {
            /* an adapter with nothing to declare signs with the agent's name alone */
            return record.session.options ?? []
          }
        },
        record: (runtime, sessionId, item) => this.#recordPublication(runtime, sessionId, item),
        toolsOffered: () =>
          this.options.extensions?.list('tool', {}).some((tool) => tool.name === 'pr_create') ?? false,
      },
      options.forge ?? {},
    )
    this.#team = new Team(join(this.#state.directory, 'team'), {
      peers: () => this.#teamPeers(),
      rootOf: (cwd) => this.#boardRootOf(cwd),
      // Through `#liveFor`, not the record's handle: a member whose agent
      // restarted underneath it has no handle until something uses it, and
      // the room's post is such a use. This used to throw "not attached" for
      // exactly the conversations the user's own composer reopens without a
      // word, which made a room's members vanish on every catalogue refresh.
      send: async (runtime, id, text) => {
        const live = await this.#teamLive(runtime, id)
        await live.send([{ type: 'text', text }])
      },
      steer: async (runtime, id, text) => {
        const live = await this.#teamLive(runtime, id)
        await live.steer([{ type: 'text', text }])
      },
      changed: (state) => this.#push({ method: 'team/changed', params: { state } }),
      removed: (room) => this.#push({ method: 'team/removed', params: { room } }),
      /* Membership moved, so whatever this host was counting about reaching
         that conversation no longer applies. See `TeamPort.membershipChanged`
         and `#teamRefusals`. */
      membershipChanged: (runtime, sessionId) => {
        this.#teamRefusals.delete(sessionKey(runtime, makeSessionId(sessionId)))
        const record = this.registry.get(runtime, makeSessionId(sessionId))
        if (record) record.reopenRefusals = 0
      },
      audit: (entry) => this.#audit.append({ at: Date.now(), ...entry }),
    })
    this.#catalogs = new CatalogRefresher({
      ...(options.catalogRefreshMs !== undefined ? { intervalMs: options.catalogRefreshMs } : {}),
      log: (message, details) => this.#logger.warn(message, details),
      onChecked: (runtime, result) => {
        if (result.installation?.changed) {
          this.#logger.info('runtime build changed on disk', { runtime, ...result.installation })
        }
        const live = this.#runtimes.get(runtime)
        if (live) this.#push({ method: 'runtime/infoChanged', params: { runtime, info: this.#infoOf(live) } })
      },
    })
    this.#extensions = options.extensions ?? null
    if (this.#extensions) {
      this.#subscriptions.push(
        this.#extensions.subscribe((event) => this.#onExtensionEvent(event)),
      )
      // Before any session exists, so the first `browser_open` of the run
      // already lands where the user last said it should.
      this.#applyBrowserSettings()
      // The team's rules are applied from stored preferences rather than
      // from the plugin, and not here: this constructor runs before any
      // plugin is loaded, and plugin configuration is memory-only, so a
      // `hold` default restarted as `accept`. See `#applyTeamSettings`.
      this.#applyTeamSettings()
    }
    this.#context = this.#buildContext()
  }

  /**
   * The stored "Working together" configuration, into the engine that
   * enforces it.
   *
   * Read from preferences, which survive the process, rather than from the
   * plugin instance, whose config does not: `kernel.reconfigure` sets it in
   * memory only. Applied here on boot and again on every change, so a board
   * set to hold inbound messages is still holding them tomorrow. A restart
   * that quietly downgrades a safety setting to `accept` is the kind of
   * failure nobody notices until it has already let something through.
   */
  #applyTeamSettings(): void {
    const stored = this.#state.state.preferences['teamSettings']
    if (stored && typeof stored === 'object') this.#team.configure(stored as never)
  }

  /**
   * Registers a runtime. Starting it is separate and allowed to fail: a machine
   * without Codex installed should still open the app and explain itself.
   */
  register(runtime: AgentRuntime): void {
    this.#runtimes.set(runtime.info.id, runtime)
    this.#catalogs.watch(runtime)
    this.#runtimeSubscriptions.set(runtime.info.id, [
      runtime.subscribe((event) => this.#onEvent(runtime.info.id, event)),
      runtime.onHealthChange((health) => this.#onHealthChange(runtime.info.id, health)),
      // A capability the agent only reveals by refusing it. Optional, so a
      // runtime whose description is settled at construction says nothing.
      ...(runtime.onInfoChange
        ? [
            runtime.onInfoChange(() => {
              this.#push({
                method: 'runtime/infoChanged',
                params: { runtime: runtime.info.id, info: this.#infoOf(runtime) },
              })
            }),
          ]
        : []),
    ])
  }

  /**
   * Drops a runtime registered earlier — an account that was removed.
   *
   * Its sessions are detached first: a pane still holding one would otherwise
   * keep sending turns to a runtime nothing can resolve.
   */
  async unregister(id: RuntimeId): Promise<void> {
    const runtime = this.#runtimes.get(id)
    if (!runtime) return
    this.registry.detachAll(id)
    this.#terminals.detachAll(id)
    // Whatever was waiting on that agent's conversations can never arrive.
    this.#team.onRuntimeDetached(id, 'The agent was removed before the message was read.')
    for (const unsubscribe of this.#runtimeSubscriptions.get(id) ?? []) unsubscribe()
    this.#runtimeSubscriptions.delete(id)
    this.#catalogs.forget(id)
    this.#runtimes.delete(id)
    this.#updates.delete(id)
    this.#meters.delete(id)
    try {
      await runtime.dispose()
    } catch (error) {
      this.#logger.warn('a removed runtime did not shut down cleanly', { runtime: id, error: String(error) })
    }
    this.#push({ method: 'runtime/removed', params: { runtime: id } })
  }

  /**
   * Tells the host where one agent's usage can be read from locally: a meter
   * for what it has left, a transcript corpus for what it cost. Both are
   * optional, and an agent with neither simply has less to show.
   *
   * Called by the wiring, which is the only place that knows which agent is
   * which; nothing above the host ever names one.
   */
  bindUsage(
    runtime: RuntimeId,
    binding: { meter?: UsageMeter; corpus?: CorpusSpec['kind'] },
  ): void {
    if (binding.meter) this.#meters.set(runtime, binding.meter)
    if (binding.corpus) {
      const [spec] = defaultCorpora([{ id: runtime, kind: binding.corpus }])
      if (spec) this.#corpora.push(spec)
    }
  }

  get #ledgerService(): Ledger {
    this.#ledger ??= new Ledger({
      stateDir: this.#state.directory,
      corpora: this.#corpora,
      log: (message, details) => this.#logger.warn(message, details),
      onProgress: (progress) => {
        this.#push({ method: 'usage/scanProgress', params: { progress } })
        // The first scan of a machine finishes long after the cards are on
        // screen. Their money arrives with it, restated rather than re-asked.
        if (!progress.running && progress.finishedAt !== null) {
          void this.#usageService.settleSpend().catch(() => undefined)
        }
      },
    })
    return this.#ledger
  }

  /**
   * The agents this desk is asked to keep track of.
   *
   * Turning one off is not a filter over the answer — it is a decision not to
   * ask the question, so a switched-off agent costs no request, no token and
   * no file read. Read on every call, so the switch needs no restart.
   */
  #meteredRuntimes(): readonly AgentRuntime[] {
    const off = this.#state.state.preferences['usageOff']
    const ignored = new Set(Array.isArray(off) ? off.filter((id) => typeof id === 'string') : [])
    return [...this.#runtimes.values()].filter((runtime) => !ignored.has(runtime.info.id))
  }

  get #usageService(): UsageService {
    this.#usage ??= new UsageService({
      runtimes: () => this.#meteredRuntimes(),
      meters: this.#meters,
      spend: { spendFor: (runtime) => this.#ledgerService.spendFor(runtime) },
      onReport: (report) => this.#push({ method: 'usage/updated', params: { report } }),
      log: (message, details) => this.#logger.warn(message, details),
    })
    return this.#usage
  }

  async start(): Promise<void> {
    await this.#state.load()
    await this.#team.load()
    // Read before anything can be listed: `nameOf` answers synchronously, so
    // a room built before the file was read would show every conversation
    // wearing its agent's name and settle only on the next refresh.
    await this.#names.load()
    await Promise.all([...this.#runtimes.values()].map((runtime) => this.#startOne(runtime)))
    if ((this.options.catalogRefreshMs ?? 1) > 0) this.#catalogs.start()
  }

  /**
   * Start one runtime, and give up *waiting* on it after a while.
   *
   * Giving up waiting is not giving up: the attempt runs on, so the only
   * thing the deadline changes is whether one agent can keep the app shut.
   */
  async #startOne(runtime: AgentRuntime, prepared = false): Promise<void> {
    const limit = this.options.startTimeoutMs ?? START_TIMEOUT_MS
    // A gateway account's loopback port is new on every start, so this has to
    // happen before the process reads its config, not once at creation.
    //
    // `prepared` is for the one caller that had to do it earlier than this:
    // adding an account points the gateway *before* the row is registered, so
    // that a turn can never reach a Codex which has not been told where to
    // send it. Doing it twice was harmless — `ensure` returns the running
    // child — but four reviewers stopped on it, and a caller saying "already
    // done" reads better than a comment explaining why a repeat is free.
    if (!prepared) await this.#prepareGateway(runtime)
    const attempt = runtime.start().then(
      () => true,
      (error: unknown) => {
        // Health carries the reason; the UI renders it as first-run guidance.
        this.#logger.warn('runtime failed to start', {
          runtime: runtime.info.id,
          error: String(error),
        })
        return false
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      // Not unref'd: a runtime that never settles is the case this deadline is
      // for, and an unref'd timer cannot fire once that hung start is the only
      // work left. The `clearTimeout` below is what keeps a runtime that did
      // start from holding the process open.
      timer = setTimeout(() => resolve('timeout'), limit)
    })
    const outcome = await Promise.race([attempt, deadline])
    clearTimeout(timer)
    if (outcome === 'timeout') {
      this.#logger.warn('runtime is still starting; carrying on without it', {
        runtime: runtime.info.id,
        afterMs: limit,
      })
      void attempt.then((ready) => {
        if (ready) this.#announceReady(runtime)
      })
      return
    }
    if (outcome) this.#announceReady(runtime)
  }

  #announceReady(runtime: AgentRuntime): void {
    this.#logger.info('runtime ready', { runtime: runtime.info.id, version: runtime.info.version })
    void this.#checkForUpdate(runtime)
  }

  async dispose(): Promise<void> {
    this.#catalogs.stop()
    /*
      Every runtime is told the quit has begun before anything below can yield.

      The runtimes refuse to spawn once disposed, and that refusal is only as
      early as the `dispose()` that arms it. Awaited in place, three lines down,
      it was not early enough: the teardown yields at the terminals, the
      transcripts and the gateways first, and a catalogue re-read parked
      mid-restart — or a crash-recovery restart on its own backoff — could wake
      in any of those gaps to a runtime that had not been disposed yet, pass
      both its gates, and put an agent, the CLI it drives and that CLI's MCP
      servers into a host that is halfway out. The later `dispose()` did still
      reap that family, so this was waste and a race rather than an orphan, but
      "dispose is terminal" is the property this whole change exists to give,
      and it was not true for the first three awaits of the quit.

      `map` runs every `dispose()` up to its first yield before any of them
      continues, so by the end of this statement every runtime has its flag
      set. The work carries on where it did; only the announcement moved.

      Each is caught on its own for two reasons. A rejection here would sit
      unhandled across the awaits below — fatal in this process — and a single
      `Promise.all` rejection used to abandon the rest of the quit: the clear
      and the team flush after it never ran.
    */
    const runtimesGone = Promise.all(
      [...this.#runtimes.values()].map((runtime) =>
        runtime.dispose().catch((error) => {
          this.#logger.warn('a runtime did not shut down cleanly', {
            runtime: runtime.info.id,
            error: String(error),
          })
        }),
      ),
    )
    for (const unsubscribe of this.#subscriptions) unsubscribe()
    this.#subscriptions.length = 0
    for (const list of this.#runtimeSubscriptions.values()) for (const off of list) off()
    this.#runtimeSubscriptions.clear()
    await this.#terminals.dispose()
    await this.#transcripts.flush()
    await this.#gateways.dispose()
    this.#usage?.dispose()
    this.#ledger?.close()
    await runtimesGone
    this.#runtimes.clear()
    await this.#team.flush()
    /* Last, because everything above it can still record. `append` is called
       from the event fan-out and returns before its write lands, so a quit
       that did not wait here was only the *request* to stop writing: the last
       approval of a session was still appending to `audit.ndjson` after
       `dispose()` had resolved. */
    await this.#audit.flush()
  }

  addBroadcaster(broadcast: Broadcast): Unsubscribe {
    this.#broadcasters.add(broadcast)
    return () => this.#broadcasters.delete(broadcast)
  }

  /** The payload a freshly connected client needs before it can render. */
  syncPayload(): Extract<WireNotification, { method: 'sync' }> {
    return {
      method: 'sync',
      params: {
        sessions: this.registry.snapshot(),
        // What each conversation has waiting. A reloading client must get this
        // back: a queue that vanished on ⌘R would be the very bug queueing
        // exists to fix.
        queues: this.registry.queues(),
        // And what each has running in the background. Same reason: a job
        // that outlives a turn certainly outlives a window reload, and a
        // panel that forgot it would be a panel that lost the job.
        tasks: this.registry.tasks(),
        runtimes: [...this.#runtimes.values()].map((runtime) => this.#infoOf(runtime)),
        // Health for every runtime, not only the one selected somewhere: a
        // client that only ever learned the active runtime's health drew
        // every other broken agent as if nothing were wrong with it.
        health: [...this.#runtimes.values()].map((runtime) => ({
          runtime: runtime.info.id,
          health: runtime.health(),
        })),
        plugins: this.#extensions?.plugins() ?? [],
        // Every contribution, not a chosen subset: `contributions/changed`
        // carries a plugin's whole set, so a filtered sync would make the count
        // jump the first time any plugin reloaded. The terminal chip is the
        // host's own and rides along even when no plugin host is attached.
        contributions: [
          ...(this.#extensions?.plugins().flatMap((plugin) => plugin.contributions) ?? []),
          TERMINAL_CHIP,
        ],
      },
    }
  }

  /**
   * The editor plane, for the extension host to hand to `ctx.editor`.
   *
   * Exposed rather than passed in because the plane needs the host's own
   * roots and broadcasters, and the extension host is constructed first — it
   * only needs something that answers the five verbs, and gets it here.
   */
  get editorPlane(): EditorPlane {
    return this.#editor
  }

  /**
   * The plane, replayed to a client that has just connected.
   *
   * Not folded into `syncPayload`: the plane is pushed on every change as its
   * own notification, and a client that receives the same shape on connect
   * and on change has one code path instead of two.
   */
  editorPlaneNotification(): WireNotification {
    return this.#editor.notification()
  }

  /**
   * Every workspace's team surface, replayed to a client that has just
   * connected — one notification per board, the shape every later change
   * arrives in, for the reason the editor plane replays this way.
   */
  teamNotifications(): WireNotification[] {
    return this.#team
      .states()
      .map((state): WireNotification => ({ method: 'team/changed', params: { state } }))
  }

  /**
   * The team plane, for the extension host to hand to `ctx.team`. Exposed
   * rather than passed in for the reason the editor plane is: it needs the
   * host's own registry and broadcasters, and the extension host is
   * constructed first.
   */
  get teamPlane(): Team {
    return this.#team
  }

  /** Approvals still waiting, replayed so a reloaded client does not lose them. */
  pendingApprovalEvents(): WireNotification[] {
    return this.registry.all().flatMap((record) =>
      [...record.approvals.values()].map(
        (approval): WireNotification => ({
          method: 'event',
          params: { runtime: record.runtime, event: { type: 'approval/requested', approval } },
        }),
      ),
    )
  }

  // ------------------------------------------------------------------ methods

  async call<M extends HostMethodName>(method: M, params: HostParams<M>): Promise<HostResult<M>> {
    // Validated by the wire layer against the same table the handler's type
    // reads from; see `methods/index.ts` for what the table guarantees.
    return dispatch(this.#context, method, params)
  }


  // ------------------------------------------------------------------ private

  /**
   * The seam the wire methods are written against. Each member is a closure
   * over this host's own state, so a method module never sees the class —
   * only what it was given — and can be run against a hand-built context.
   */
  #buildContext(): HostContext {
    return {
      options: this.options,
      registry: this.registry,
      state: this.#state,
      logger: this.#logger,
      credentials: this.#credentials,
      audit: this.#audit,
      transcripts: this.#transcripts,
      archive: this.#archive,
      names: this.#names,
      terminals: this.#terminals,
      worktrees: this.#worktrees,
      team: this.#team,
      editor: this.#editor,
      gateways: this.#gateways,
      catalogs: this.#catalogs,
      usage: () => this.#usageService,
      ledger: () => this.#ledgerService,
      libraryUsage: () => {
        // Lazy: the reader is only built when the page first asks, and the
        // first read pays for the transcripts it walks. Every read after is
        // the cache plus whatever changed.
        this.#libraryUsage ??= new LibraryUsageReader(
          join(this.#state.directory, 'transcripts'),
          join(this.#state.directory, 'cache', 'library-usage.json'),
        )
        return this.#libraryUsage
      },
      extensions: () => this.#requireExtensions(),
      push: (notification) => this.#push(notification),
      runtimes: {
        resolve: (params) => this.#runtime(params),
        get: (id) => this.#runtimes.get(id),
        all: () => [...this.#runtimes.values()],
        ids: () => new Set(this.#runtimes.keys()),
        infoOf: (runtime) => this.#infoOf(runtime),
        metered: () => this.#meteredRuntimes(),
        extensionsOf: (params) => this.#extensionsOf(params),
        files: (runtime) => this.#files(runtime),
        inventory: () => this.#inventoryAgents(),
        register: (runtime) => this.register(runtime),
        unregister: (id) => this.unregister(id),
        start: (runtime) => this.#startOne(runtime),
        bindUsage: (runtime, binding) => this.bindUsage(runtime, binding),
      },
      sessions: {
        live: (params) => this.#live(params),
        record: (params) => this.#record(params),
        read: (runtime, id) => this.#read(runtime, id),
        attach: (runtime, id, live) => this.#attach(runtime, id, live),
        withRepos: (page) => this.#withRepos(page),
        routeToHolders: (runtime, page) => this.#routeToHolders(runtime, page),
        applyArchive: (runtime, page, filter) => this.#applyArchive(runtime, page, filter),
        busyElsewhere: (runtime, id, error) => this.#busyElsewhere(runtime, id, error),
        cannotReopen: (runtime, error) => this.#cannotReopen(runtime, error),
      },
      queue: {
        push: (record) => this.#pushQueue(record),
        drain: (record) => this.#drain(record),
        nextId: () => this.#nextQueuedId(),
        busy: (record) => this.#queueBusy(record),
        sendNow: (record, input) => this.#sendNow(record, input),
      },
      accounts: {
        add: (runtime, gateway) => this.#addAccount(runtime, gateway),
        remove: (runtime) => this.#removeAccount(runtime),
        reloadSecrets: (runtime) => this.#reloadSecrets(runtime),
        announce: (runtime) => this.#announceAccount(runtime),
        /* Asked of each registered runtime rather than of a slot list, because
           `AccountFactory` answers per runtime — `slotOf` is the only door to
           a slot's gateway, and every gateway account is a registered
           runtime. */
        gatewayCredentials: () =>
          [...this.#runtimes.values()].flatMap((runtime) => {
            const gateway = this.options.accounts?.slotOf(runtime.info)?.gateway
            return gateway ? [{ ref: gateway.credentialRef, name: gateway.name }] : []
          }),
      },
      routes: {
        list: () => this.#routes(),
        usable: (runtime, route) => this.#routeUsable(runtime, route),
        resolve: (runtime, routeId) => this.#resolveRoute(runtime, routeId),
      },
      workspaces: {
        openRoots: () => this.#openRoots(),
        confineGitRoot: (root) => this.#confineGitRoot(root),
        open: (path) => this.#openWorkspace(path),
        repoOf: (cwd) => this.#repoOf(cwd),
        boardRootOf: (cwd) => this.#boardRootOf(cwd),
        forgetBoardRoots: () => this.#boardRoots.clear(),
        issuePreviewTicket: (path, runtime) => {
          const ticket = randomBytes(24).toString('hex')
          this.#previewTickets.set(ticket, {
            path,
            ...(runtime ? { runtime } : {}),
            expiresAt: Date.now() + 30_000,
          })
          return ticket
        },
      },
      backup: {
        export: () => this.#backupExport(),
        import: (raw) => this.#backupImport(raw),
      },
      diagnostics: () => this.#diagnostics(),
      settings: {
        applyTeam: () => this.#applyTeamSettings(),
        applyBrowser: () => this.#applyBrowserSettings(),
      },
    }
  }

  /**
   * Tells the extension host where an agent's pages should open.
   *
   * The renderer owns the preference and the plugins act on it, and they are
   * in different processes — so it is pushed on every write and once at
   * startup, rather than read on demand from a place the child cannot see.
   */
  #applyBrowserSettings(): void {
    const stored = this.#state.state.preferences['browserPrefs']
    const prefs = (stored ?? {}) as {
      placement?: unknown
      externalBinary?: unknown
      keepExternalProfile?: unknown
    }
    const placement =
      prefs.placement === 'window' || prefs.placement === 'system' ? prefs.placement : 'pane'
    this.#extensions?.setBrowserSettings({
      placement,
      ...(typeof prefs.externalBinary === 'string' && prefs.externalBinary.trim()
        ? { binary: prefs.externalBinary.trim() }
        : {}),
      keepProfile: prefs.keepExternalProfile !== false,
      // The agent's standing Chrome profile belongs to this desk, beside its
      // other state — not to whatever `~/.harnessdesk` happens to be.
      profileDir: join(this.#state.directory, 'browser-profile'),
    })
  }

  readonly #localFiles = new LocalFiles()

  /**
   * The reader for a request: the runtime's own view when it declares one,
   * HarnessDesk's otherwise. Chosen by declaration, not by catching a failed
   * call, so a runtime that is merely slow is not silently swapped for a
   * different filesystem.
   */
  #files(runtime: RuntimeId | undefined): RuntimeFiles {
    const found = runtime ? this.#runtimes.get(runtime) : undefined
    return found?.files ?? this.#localFiles
  }

  /**
   * Where the renderer may read: the workspaces the user opened and the
   * working directories of sessions it is looking at. Everything else is
   * refused before any reader is asked.
   */
  #openRoots(): string[] {
    return [
      ...this.#state.state.workspaces.map((entry) => entry.path),
      ...this.registry.snapshot().map((session) => session.cwd),
    ]
  }

  /**
   * Where a git RPC may point: inside an open root, like every other read —
   * or at the top level of the repository an open root sits in, because the
   * history pane keys itself by `git/status`'s answer and a workspace is
   * often a folder inside its repository. The top level is asked of git for
   * each open root rather than trusted from the wire, so this never widens
   * past repositories the user has actually opened part of.
   */
  async #confineGitRoot(root: string): Promise<string> {
    const roots = this.#openRoots()
    // Real paths on both sides. `confine` collapses `..` but cannot see a
    // symlink, so `opened/elsewhere -> /other/repo` passed a lexical test and
    // `git -C` then dutifully followed it into a repository the user never
    // opened. Resolving the roots too keeps the legitimate case working: on
    // macOS a workspace is routinely reached through /tmp or /var.
    const real = await this.#realPath(root)
    const opened = await Promise.all(roots.map((entry) => this.#realPath(entry)))
    try {
      return confine(real, opened)
    } catch (refusal) {
      for (const open of roots) {
        const top = await gitOps.topLevel(open)
        if (top !== null && (await this.#realPath(top)) === real) return real
      }
      throw refusal
    }
  }

  /** The path with its links resolved, or the path itself when it is not there. */
  async #realPath(path: string): Promise<string> {
    try {
      return await realpath(path)
    } catch {
      return resolve(path)
    }
  }

  /**
   * The backup file: everything HarnessDesk keeps for itself. Credentials are
   * deliberately absent — they live in the OS keystore, would not decrypt on
   * another machine, and a restore is followed by signing in again.
   */
  async #backupExport(): Promise<BackupFile> {
    return {
      kind: 'harnessdesk-backup',
      version: 1,
      exportedAt: Date.now(),
      hostVersion: this.options.version ?? '0.1.0',
      agents: this.options.agents?.entries() ?? [],
      preferences: this.#state.state.preferences,
      transcripts: await this.#transcripts.exportAll(),
    }
  }

  /**
   * Restores a backup additively, and counts only what was read back and
   * matched. Agents already present and transcripts the local store holds a
   * newer copy of are skipped — a restore adds what is missing, it never
   * rolls anything local backwards. A restored agent that this build can run
   * comes up immediately, the same way a registration from the interface
   * does.
   */
  async #backupImport(raw: unknown): Promise<BackupReport> {
    const file = raw as Partial<BackupFile>
    if (
      typeof file !== 'object' ||
      file === null ||
      file.kind !== 'harnessdesk-backup' ||
      file.version !== 1
    ) {
      throw new Error('That file is not a HarnessDesk backup.')
    }

    const agents = { restored: 0, skipped: 0 }
    const directory = this.options.agents
    for (const entry of Array.isArray(file.agents) ? file.agents : []) {
      const id = (entry as Record<string, unknown>)['id']
      if (!directory || typeof id !== 'string' || this.#runtimes.has(id as RuntimeId) || directory.owns(id)) {
        agents.skipped += 1
        continue
      }
      try {
        const adopted = directory.adopt(entry as Record<string, unknown>)
        if (!directory.owns(id)) {
          agents.skipped += 1
          continue
        }
        agents.restored += 1
        if (adopted) {
          if (adopted.usage) this.bindUsage(adopted.runtime.info.id, adopted.usage)
          this.register(adopted.runtime)
          this.#push({ method: 'runtime/added', params: { info: this.#infoOf(adopted.runtime) } })
          void this.#startOne(adopted.runtime)
        }
      } catch {
        agents.skipped += 1
      }
    }

    let preferences = 0
    const patch =
      typeof file.preferences === 'object' && file.preferences !== null ? file.preferences : {}
    if (Object.keys(patch).length > 0) {
      await this.#state.setPreferences(patch)
      if ('browserPrefs' in patch) this.#applyBrowserSettings()
      const applied = this.#state.state.preferences
      preferences = Object.entries(patch).filter(
        ([key, value]) => JSON.stringify(applied[key]) === JSON.stringify(value),
      ).length
    }

    const transcripts = { restored: 0, skipped: 0 }
    for (const entry of Array.isArray(file.transcripts) ? file.transcripts : []) {
      if (typeof entry?.runtime !== 'string' || typeof entry?.id !== 'string') {
        transcripts.skipped += 1
        continue
      }
      const outcome = await this.#transcripts.importOne(entry.runtime, entry.id, entry.data)
      if (outcome === 'restored') transcripts.restored += 1
      else transcripts.skipped += 1
    }

    this.#logger.info('backup restored', { agents, preferences, transcripts })
    return { agents, preferences, transcripts }
  }

  /**
   * The diagnostics bundle: what a bug report needs, assembled here so what
   * leaves the machine is decided in one reviewable place. Everything
   * string-shaped goes through one redactor (`diagnostics.ts`): the log tail,
   * and the health sentences, which are spawn errors and so love to quote
   * full command paths. Support needs the shape of the failure, not the
   * person's secrets or where they keep their work.
   */
  async #diagnostics(): Promise<{
    generatedAt: number
    hostVersion: string
    platform: string
    runtimes: { id: RuntimeId; name: string; version: string | null; health: RuntimeHealth }[]
    plugins: { id: string; version: string | null; state: string }[]
    log: string[]
  }> {
    const redact = redactorFor({ home: homedir(), roots: this.#openRoots() })
    const runtimes = [...this.#runtimes.values()].map((runtime) => {
      const health = runtime.health()
      return {
        id: runtime.info.id,
        name: runtime.info.name,
        version: runtime.info.version ?? null,
        health:
          health.state === 'unavailable'
            ? {
                ...health,
                message: redact(health.message),
                ...(health.remediation ? { remediation: redact(health.remediation) } : {}),
              }
            : health,
      }
    })
    const plugins = (this.#extensions?.plugins() ?? []).map((plugin) => ({
      id: plugin.identity.id,
      version: plugin.identity.version ?? null,
      state: String(plugin.state),
    }))
    let log: string[] = []
    const file = this.#logger.file
    if (file) {
      try {
        const raw = await readFile(file, 'utf8')
        log = raw.split('\n').filter(Boolean).slice(-500).map(redact)
      } catch {
        // A missing log is a fact worth shipping as-is.
      }
    }
    return {
      generatedAt: Date.now(),
      hostVersion: this.options.version ?? '0.1.0',
      platform: `${process.platform} ${process.arch} node/${process.versions.node}`,
      runtimes,
      plugins,
      log,
    }
  }

  readonly #previewTickets = new Map<
    string,
    { path: string; runtime?: RuntimeId; expiresAt: number }
  >()

  /**
   * Redeems a preview ticket: one read of one confined file, then the ticket
   * is gone. Serves `GET /preview-frame` — see `preview/ticket` on the wire
   * for why the launch token must never appear in a preview URL.
   */
  async redeemPreviewTicket(
    ticket: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const entry = this.#previewTickets.get(ticket)
    this.#previewTickets.delete(ticket)
    if (!entry || entry.expiresAt < Date.now()) return null
    const path = confine(entry.path, this.#openRoots())
    const bytes = await this.#files(entry.runtime).read(path)
    const extension = path.split('.').pop()?.toLowerCase()
    const contentType =
      extension === 'pdf'
        ? 'application/pdf'
        : extension === 'html' || extension === 'htm'
          ? 'text/html; charset=utf-8'
          : 'text/plain; charset=utf-8'
    return { bytes, contentType }
  }

  #routes(): readonly ModelRouteRecord[] {
    const raw = this.#state.state.preferences['modelRoutes']
    return Array.isArray(raw) ? (raw as ModelRouteRecord[]) : []
  }

  /**
   * A route is offered greyed with a reason, never hidden. The check is
   * against what the backend says it can speak; the sentence is the useful
   * artefact.
   */
  #routeUsable(
    runtime: AgentRuntime,
    route: ModelRouteRecord,
  ): { usable: boolean; reason?: string } {
    const spoken = runtime.info.supportedWireProtocols ?? []
    if (spoken.length === 0) {
      return {
        usable: false,
        reason: `${runtime.info.presentation.name} does not support model routes.`,
      }
    }
    if (!spoken.includes(route.wireProtocol)) {
      return {
        usable: false,
        reason: `${runtime.info.presentation.name} speaks ${spoken.join(', ')}; this endpoint is ${route.wireProtocol}.`,
      }
    }
    return { usable: true }
  }

  /**
   * Brings up the gateway a gateway account runs on, and tells it where.
   *
   * A no-op for every ordinary account, which is most of them. Failure is
   * logged rather than thrown: one endpoint that cannot be reached should
   * leave that account explaining itself on its own row, not stop the app —
   * the same bargain `#startOne` makes for an agent that will not launch.
   */
  async #prepareGateway(runtime: AgentRuntime): Promise<void> {
    const slot = this.options.accounts?.slotOf(runtime.info)
    if (!slot?.gateway) return
    const { name, endpoint, credentialRef } = slot.gateway
    try {
      const gateway = await this.#gateways.ensure(runtime.info.id, {
        upstream: endpoint,
        resolveKey: () => this.#credentials.resolve(credentialRef),
      })
      await this.options.accounts?.prepare?.(runtime.info.id, {
        id: runtime.info.id,
        name,
        endpoint: gateway.endpoint,
        wireProtocol: 'responses',
        token: gateway.token,
      })
    } catch (error) {
      this.#logger.warn('a gateway account could not be pointed at its endpoint', {
        runtime: runtime.info.id,
        error: String(error),
      })
    }
  }

  /** Exchanges a stored route for a running gateway. The only resolve() caller. */
  async #resolveRoute(runtime: AgentRuntime, routeId: string): Promise<ResolvedModelRoute> {
    const route = this.#routes().find((entry) => entry.id === routeId)
    if (!route) throw new Error('That model route no longer exists.')
    const check = this.#routeUsable(runtime, route)
    if (!check.usable) throw new Error(check.reason ?? 'This route cannot be used here.')
    const gateway = await this.#gateways.ensure(route.id, {
      upstream: route.endpoint,
      ...(route.model ? { model: route.model } : {}),
      resolveKey: () => this.#credentials.resolve(route.credentialRef),
    })
    return {
      id: route.id,
      name: route.name,
      endpoint: gateway.endpoint,
      wireProtocol: route.wireProtocol,
      token: gateway.token,
      ...(route.model ? { model: route.model } : {}),
    }
  }

  #extensionsOf(params: unknown): NonNullable<AgentRuntime['extensions']> {
    const runtime = this.#runtime(params)
    if (!runtime.extensions) {
      throw new Error(`${runtime.info.presentation.name} has no extension plane to manage.`)
    }
    return runtime.extensions
  }

  #requireExtensions(): ExtensionHost {
    if (!this.#extensions) {
      throw new Error('No extension kernel is running in this build.')
    }
    return this.#extensions
  }

  #onExtensionEvent(event: ExtensionEvent): void {
    this.#push({ method: 'extension', params: { event } })
    // The plugin has just appeared, carrying whatever config the kernel has
    // — which after a restart is nothing. Hand it what the engine is
    // actually enforcing, so the settings page shows the rules in force
    // rather than an empty form beside a board that is holding messages.
    if (event.type === 'plugin/added' && event.plugin.identity.id === 'team') {
      const stored = this.#state.state.preferences['teamSettings']
      if (stored && typeof stored === 'object' && Object.keys(stored).length > 0) {
        void this.#extensions
          ?.reconfigure('team', stored as Record<string, unknown>)
          .catch(() => undefined)
      }
    }
  }

  async #openWorkspace(path: string) {
    const described = await describeWorkspace(path)
    const record = { ...described, lastOpenedAt: Date.now() }
    await this.#state.touchWorkspace(record)
    // Here, not at one call site: `workspace/pick` opens a workspace too, and
    // only `workspace/open` was clearing this. A folder that resolved to no
    // board — or to a parent of the one just opened — must resolve again.
    this.#boardRoots.clear()
    const git = await gitService.status(described.path)
    // Plugins scope their filesystem access to the open workspace, so the
    // kernel has to learn about the change at the same moment the host does.
    this.#extensions?.setWorkspace({ root: described.path, branch: git?.branch ?? null })
    return {
      ...record,
      name: described.name || basename(described.path),
      git: git ? { branch: git.branch } : null,
      // Which project this folder is, so the session list can put a worktree
      // opened as a workspace under the project it is a checkout of.
      repo: await this.#repoOf(described.path),
    }
  }

  /** What the host knows about a runtime, by id — null for one it does not hold. */
  runtimeInfo(id: string): RuntimeInfo | null {
    const runtime = this.#runtimes.get(id)
    return runtime ? this.#infoOf(runtime) : null
  }

  /**
   * The forge plane, for the extension host to hand to `ctx.forge`. Exposed
   * for the reason the team plane is: the seat is read off the host's own
   * runtimes and records, and a publication lands in a transcript only the
   * host holds.
   */
  get forgePlane(): ForgePlane {
    return this.#forge
  }

  /**
   * A publication, into the turn that is running — or, when the tool call
   * outlived its turn by a beat, the last one. The event goes through the
   * host's own door so the audit log, the registry, the transcript store and
   * every window all learn of it the way they learn of the agent's items.
   */
  #recordPublication(runtime: string, sessionId: string, item: PublicationItem): boolean {
    const record = this.registry.get(runtimeId(runtime), makeSessionId(sessionId))
    if (!record) return false
    const running = [...record.running].at(-1)
    const turnId = running ?? record.session.turns.at(-1)?.id
    if (turnId === undefined) return false
    this.#onEvent(record.runtime, { type: 'item/completed', sessionId: record.session.id, turnId, item })
    return true
  }

  /** The live handle a `(runtime, sessionId)` pair names, reconnecting if it must. */
  async #live(params: {
    readonly runtime: RuntimeId
    readonly sessionId: SessionId
  }): Promise<AgentSession> {
    return this.#liveFor(params.runtime, makeSessionId(params.sessionId))
  }

  /**
   * The live handle for a conversation, re-opening it when the agent restarted
   * underneath it.
   *
   * An ACP agent is restarted for ordinary reasons — a catalogue refresh when
   * the window comes back into focus, a stored key changing — and every open
   * conversation loses its handle when that happens (`detachAll`). Until this,
   * the next message was refused with "Resume it first", which named something
   * the interface does not offer: the conversation was on screen, with its
   * turns, and nothing would speak to it again.
   *
   * So the first call that needs the handle resumes the conversation itself.
   * Resuming is free of tokens — it replays what the agent already stored —
   * and the agents that cannot do it say so, which is the one case where the
   * refusal is real and has to name what is actually lost.
   */
  async #liveFor(runtime: RuntimeId, id: SessionId): Promise<AgentSession> {
    const held = this.registry.get(runtime, id)
    if (held?.live) return held.live
    const key = `${runtime}\u0000${id}`
    // Two calls arriving together — a send and the option write beside it —
    // must resume once between them, not once each.
    const already = this.#reattaching.get(key)
    if (already) return already
    const attempt = this.#reattach(this.#runtime({ runtime }), id)
    this.#reattaching.set(key, attempt)
    try {
      return await attempt
    } finally {
      this.#reattaching.delete(key)
    }
  }

  /** Conversations being re-opened right now, so concurrent callers share one. */
  readonly #reattaching = new Map<string, Promise<AgentSession>>()

  /**
   * The team plane's handle for a member — reopened when the agent restarted
   * underneath it, and let go when reopening is never going to work.
   *
   * A detached member is listed on the rail because the next delivery can
   * remake its handle. When that is never going to happen, a member that is
   * listed but can never be reached is a roster that lies while every post to
   * it is refused — so the member is let go: `detached` is cleared, the
   * refusal stays on the post in the agent's words, and the next roster read
   * drops the row.
   *
   * "Never" is decided by what the agent said, not by the fact of a failure.
   * The agent's own answer that the conversation is gone (`SessionGoneError`,
   * which `#reattach` mints for a disowned id and an agent that cannot resume)
   * settles it at once. Anything else an agent that is up may say — a
   * timeout, an internal error, an overload — may pass, so it is counted,
   * and the member goes only once it has refused `REOPEN_REFUSALS_TO_LET_GO`
   * deliveries in a row; one that reopens in between starts the count again.
   * An agent that is merely down, or a conversation merely held open
   * elsewhere, is not counted at all: both come back, and the member with
   * them.
   */
  async #teamLive(runtime: RuntimeId, sessionId: string): Promise<AgentSession> {
    const id = makeSessionId(sessionId)
    const key = sessionKey(runtime, id)
    try {
      const live = await this.#liveFor(runtime, id)
      this.#teamRefusals.delete(key)
      return live
    } catch (error) {
      const record = this.registry.get(runtime, id)
      const agent = this.#runtimes.get(runtime)
      /* No record is the ordinary case now, not an odd one: after a relaunch
         a room's members are conversations nobody has opened yet, so the
         count has nowhere on a record to live. It is kept beside the registry
         for exactly those, and on the record when there is one — where a
         fresh attach and a runtime restart already clear it, which is the
         behaviour wanted. */
      if (agent?.health().state === 'ready' && !isSessionBusy(error)) {
        const gone = isSessionGone(error)
        const refusals =
          (record ? record.reopenRefusals : (this.#teamRefusals.get(key) ?? 0)) +
          (gone ? REOPEN_REFUSALS_TO_LET_GO : 1)
        if (record) record.reopenRefusals = refusals
        else this.#teamRefusals.set(key, refusals)
        if (refusals >= REOPEN_REFUSALS_TO_LET_GO) {
          if (record) {
            record.detached = false
            record.reopenRefusals = 0
          }
          this.#teamRefusals.delete(key)
          /* Off the boards, not merely off the peer list. A room draws its
             membership now, so a member the desk has given up on has to stop
             being a member — otherwise the rail lists, forever, a name every
             post to it is refused by. */
          this.#team.forget(
            runtime,
            sessionId,
            gone
              ? `is no longer in ${agent.info.presentation.name}'s history, so it has been taken out of this room.`
              : `could not be reopened — ${describeError(error)} — so it has been taken out of this room.`,
          )
          this.#logger.info('a room member could not be reopened and is no longer in the room', {
            runtime,
            session: sessionId,
            reason: describeError(error),
            settled: gone ? 'the agent said the conversation is gone' : `${refusals} refusals in a row`,
          })
        }
      }
      throw error
    }
  }

  /**
   * Reopen attempts the team plane has made on a member with no record here,
   * counted so it can be let go the same way one with a record is. Cleared
   * the moment a reopen succeeds. See `#teamLive`.
   */
  readonly #teamRefusals = new Map<string, number>()

  /** Why a conversation would not come back, in the agent's name and its own words. */
  #cannotReopen(runtime: AgentRuntime, error: unknown): string {
    // JSON-RPC's `message` is often a code word — "Invalid params", "Internal
    // error" — and the sentence a person can act on is the one the agent put
    // in `error.data`, which `AcpError` carries as `details`.
    const details = error instanceof Error ? (error as { details?: unknown })['details'] : null
    const said = typeof details === 'string' && details.trim() ? details.trim() : describeError(error)
    return `${runtime.info.presentation.name} could not reopen this conversation: ${said}`
  }

  /**
   * The refusal a busy conversation deserves, with the holder named.
   *
   * The adapter knows the conversation is held and can often name the
   * application holding it; what it cannot know is whether that application is
   * one of ours. This does — a peer account with a live handle is a name the
   * user chose — and prefers it, because "your Shane-OL account" is a place
   * they can go and "the ChatGPT app" is not something they would have
   * guessed from a lock file.
   *
   * Rethrown rather than reworded in place so the `sessionBusy` code survives:
   * it is what lets the interface offer a copy instead of a dead end.
   */
  async #busyElsewhere(
    runtime: AgentRuntime,
    id: SessionId,
    error: unknown,
  ): Promise<SessionBusyError> {
    const holder = this.#holderOf(this.#peersOf(runtime), id)
    if (holder) {
      const name = await this.#accountName(holder)
      return new SessionBusyError(
        `This conversation is already open in your ${name} account, which is the only one that can continue it.`,
        name,
      )
    }
    return error instanceof SessionBusyError
      ? error
      : new SessionBusyError(describeError(error), holderOf(error))
  }

  /**
   * What the user calls one of their accounts.
   *
   * Every account of one agent shares the agent's name — two Codex accounts
   * are both "Codex" — so the runtime name is no help in telling the person
   * which one to go to. The identity is, and only the account itself knows it.
   * Asked here rather than cached because this is the path of a failure the
   * user is already stopped by, and a name from a stale cache would send them
   * to the wrong window.
   *
   * On a leash for the same reason it is asked at all: the person is already
   * stopped, and the account being asked is by definition busy with a
   * conversation. An app-server that never answers must cost them a better
   * sentence, not the sentence.
   */
  async #accountName(runtime: RuntimeId): Promise<string> {
    const target = this.#runtimes.get(runtime)
    if (!target) return runtime
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const asked = target.getAccount()
      // Not unref'd: see `#startOne` — an unref'd timer cannot fire when the
      // hung call is the only work left, which is the case this is for.
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ACCOUNT_NAME_DEADLINE_MS)
      })
      const status = await Promise.race([asked, deadline])
      const label = status?.accounts[0]?.label?.trim()
      if (label) return label
    } catch {
      // An account that cannot answer still has a name on it.
    } finally {
      clearTimeout(timer)
    }
    return target.info.name
  }

  async #reattach(runtime: AgentRuntime, id: SessionId): Promise<AgentSession> {
    const name = runtime.info.presentation.name
    const health = runtime.health()
    if (health.state !== 'ready') {
      // Not a restart this can heal: the agent is not running at all, and
      // saying why beats offering to reopen something into nothing.
      throw new Error(
        `${name} is not running${health.state === 'unavailable' && health.message ? `: ${health.message}` : '.'}`,
      )
    }
    if (!runtime.info.capabilities.resume) {
      throw new SessionGoneError(
        `${name} cannot reopen a conversation after it restarts, so this one has ended. Start a new one — what you typed is still in the box.`,
      )
    }
    let live: AgentSession
    try {
      live = await runtime.resumeSession(id, {})
    } catch (error) {
      if (isSessionBusy(error)) throw await this.#busyElsewhere(runtime, id, error)
      // The sentence is the same either way; what differs is whether asking
      // again could help. The adapter's own "gone", or the agent answering
      // that the id names nothing, settles it — and keeps its code, so a
      // caller can tell without reading English. Anything else is a reopen
      // that merely failed.
      const sentence = this.#cannotReopen(runtime, error)
      throw isSessionGone(error) || reopenRefusedByAgent(error)
        ? new SessionGoneError(sentence)
        : new Error(sentence)
    }
    // The same fold `session/resume` does: the transcript from the read, the
    // settings and options from the handle, which is the only place they are.
    const transcript = await this.#read(runtime, live.id)
    const session: Session = { ...transcript, settings: live.settings(), options: live.options() }
    const record = this.registry.upsert(session, live)
    this.#logger.info('reopened a conversation whose agent had restarted', {
      runtime: runtime.info.id,
      session: String(id),
    })
    // A restarted agent re-declares what it offers, and the composer is
    // drawing the old process's answer until it is told.
    this.#push({
      method: 'event',
      params: {
        runtime: runtime.info.id,
        event: { type: 'session/settings', sessionId: id, settings: live.settings() },
      },
    })
    this.#push({
      method: 'event',
      params: {
        runtime: runtime.info.id,
        event: { type: 'session/options', sessionId: id, options: live.options() },
      },
    })
    return record.live ?? live
  }

  /**
   * A session's transcript, for a client that is about to show it.
   *
   * A conversation this host is driving through a turn is better known here
   * than in the agent's own store: we watched every event of it, and the store
   * has not been told most of them yet. Asking the store then — which is what
   * every switch back to a working conversation does — used to answer with a
   * turn that had no items in it, or no turn at all. So while a turn is in
   * flight the held transcript *is* the read; the rest of the time the store is
   * asked, and what it says is folded in (`SessionRegistry.upsert`).
   */
  async #read(runtime: AgentRuntime, id: SessionId): Promise<Session> {
    const held = this.registry.get(runtime.info.id, id)
    if (held?.live && held.session.itemsLoaded && held.running.size > 0) return held.session
    try {
      return await this.#transcripts.enrich(await runtime.readSession(id))
    } catch (error) {
      // A conversation this host started and is still holding open was
      // watched item by item; what the registry has *is* the transcript.
      // Codex 0.153.0 answers a `thread/read` with turns on a thread it is
      // holding live with "list_turns is not supported yet" — every switch
      // back to an idle conversation then raised that sentence as a notice
      // over a pane that already had every turn on it.
      if (held?.live && held.session.itemsLoaded) {
        this.#logger.warn(`session/read fell back to the held transcript for ${id}`, {
          runtime: runtime.info.id,
          error: error instanceof Error ? error.message : String(error),
        })
        // A copy, as every other path returns: the ordinary read hands back a
        // freshly mapped session, and returning the registry's own object
        // here would let a caller that edits what it was given edit the
        // record the host is holding.
        return { ...held.session }
      }
      // The backend cannot serve it — but the host may have watched it
      // happen. A read-only copy beats an unopenable conversation.
      const recovered = await this.#transcripts.recover(runtime.info.id, id)
      if (!recovered) throw error
      this.#logger.warn(`session/read fell back to the stored transcript for ${id}`, {
        runtime: runtime.info.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return recovered
    }
  }

  #record(params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }): SessionRecord {
    const record = this.registry.get(params.runtime, makeSessionId(params.sessionId))
    if (!record) throw new Error(`No conversation ${params.sessionId} is open.`)
    return record
  }

  #queuedCounter = 0
  #nextQueuedId(): string {
    this.#queuedCounter += 1
    return `q-${Date.now().toString(36)}-${this.#queuedCounter}`
  }

  /** The whole queue, to every window — the `session/options` convention. */
  #pushQueue(record: SessionRecord): void {
    this.#push({
      method: 'event',
      params: {
        runtime: record.runtime,
        event: { type: 'session/queue', sessionId: record.session.id, queue: record.queue },
      },
    })
  }

  /**
   * Conversations whose queue is being handed to a runtime right now.
   *
   * `send` resolves on acceptance, and the accepted turn's own `turn/started`
   * and `turn/completed` come back through `#onEvent` — so without this a
   * second drain could start before the first had a turn to wait for, and the
   * whole queue would go out at once.
   */
  readonly #draining = new Set<string>()

  /**
   * Conversations a direct send is on its way to. `send` resolves when the
   * agent accepts, and the turn's own `turn/started` comes back through
   * `#onEvent` — so for the length of that round trip the session still reads
   * idle, and a second message typed in the same breath would go straight out
   * too and be refused by the agent. Held beside `#draining`, and for the same
   * reason: it is this host's doing, not a fact about the conversation.
   */
  readonly #sendingNow = new Map<string, symbol>()

  #queueBusy(record: SessionRecord): boolean {
    return isBusy(record.session) || this.#sendingNow.has(recordKey(record))
  }

  async #sendNow(record: SessionRecord, input: readonly UserContent[]): Promise<void> {
    const key = recordKey(record)
    // The mark is owned: only the send that set it may take it off. A send
    // whose deadline passed, and whose agent then answered after a later send
    // had marked the same conversation, must not clear the later one's mark.
    const mark = Symbol('sending')
    this.#sendingNow.set(key, mark)
    const release = () => {
      if (this.#sendingNow.get(key) === mark) this.#sendingNow.delete(key)
    }
    const deadline = setTimeout(release, this.options.sendAcceptDeadlineMs ?? SEND_ACCEPT_DEADLINE_MS)
    try {
      const live = await this.#live({ runtime: record.runtime, sessionId: record.session.id })
      await live.send(input)
    } finally {
      clearTimeout(deadline)
      release()
    }
  }

  /**
   * Sends the head of the queue, if there is one and nothing is in the way.
   *
   * One message, one turn: merging two of the user's messages into a single
   * turn would put words in their mouth, and each queued message was written
   * as its own instruction.
   */
  async #drain(record: SessionRecord): Promise<void> {
    const key = recordKey(record)
    if (this.#draining.has(key)) return
    if (record.queue.status === 'paused') return
    if (record.queue.messages.length === 0) return
    // The lock goes on before the first await, or two drains triggered in
    // the same breath — a flush and a turn ending, say — both pass the check
    // above while the first is still waiting for a live conversation, and
    // the same message goes out twice.
    this.#draining.add(key)
    try {
      // "Send this when it is back" is a promise, so the queue reopens the
      // conversation itself rather than waiting to be told the agent returned.
      let live = record.live
      if (!live) {
        try {
          live = await this.#liveFor(record.runtime, record.session.id)
        } catch (error) {
          this.registry.pauseQueue(record, describeError(error))
          this.#pushQueue(record)
          return
        }
      }
      // Reopening awaited, so the world may have moved: read the queue again
      // under the lock before anything is marked as going. A fresh binding,
      // because the compiler otherwise carries the check from the top of the
      // function across the await.
      const queue: SessionRecord['queue'] = record.queue
      if (queue.status === 'paused') return
      const sending = this.registry.markSending(record)
      if (!sending) return
      this.#pushQueue(record)
      try {
        await live.send(sending.input)
        this.registry.cancelQueued(record, sending.id)
        this.#pushQueue(record)
      } catch (error) {
        // Put it back exactly where it was and stop: the message is the thing
        // worth keeping, and a queue that kept firing into a broken agent would
        // burn the rest of it the same way.
        this.registry.moveQueued(record, sending.id, 0)
        record.queue = {
          ...record.queue,
          messages: record.queue.messages.map((message) =>
            message.id === sending.id ? { ...message, state: 'queued' } : message,
          ),
        }
        this.registry.pauseQueue(record, describeError(error))
        this.#pushQueue(record)
        this.#push({
          method: 'event',
          params: {
            runtime: record.runtime,
            event: {
              type: 'notice',
              sessionId: record.session.id,
              level: 'warning',
              message: `The queued message was not sent: ${describeError(error)}`,
            },
          },
        })
      }
    } finally {
      this.#draining.delete(key)
    }
  }

  #attach(runtime: AgentRuntime, id: Session['id'], live: Awaited<ReturnType<AgentRuntime['createSession']>>) {
    const existing = this.registry.get(runtime.info.id, id)
    if (existing) {
      existing.live = live
      return existing.session
    }
    // `session/started` normally arrives first and seeds the registry; this is
    // the fallback if a runtime attaches without announcing.
    const seeded: Session = {
      id,
      runtime: runtime.info.id,
      cwd: live.settings().cwd,
      status: { type: 'idle' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: live.settings(),
      options: live.options(),
      turns: [],
      itemsLoaded: true,
    }
    return this.registry.upsert(seeded, live).session
  }

  #runtime(params: unknown): AgentRuntime {
    const id = (params as { runtime?: string }).runtime
    const runtime = id ? this.#runtimes.get(id) : undefined
    if (!runtime) throw new Error(`No runtime is registered with id ${JSON.stringify(id)}`)
    return runtime
  }

  /**
   * The roster the library reads and writes against: every runtime, not the
   * selected one — the whole point is the comparison between them. The
   * scanner takes `InventoryAgent`, not `AgentRuntime`; the narrowing here is
   * what lets it live in a package with no HarnessDesk in it. The brand
   * fallback is ours too: the guess belongs beside the runtimes it guesses
   * about.
   *
   * One entry per *agent*, never per account. Two accounts of one harness
   * share a home where only the credential is private (`accounts.ts` builds
   * exactly that), so their columns could not disagree — and a person asking
   * "does this skill reach Codex?" is not asking it once per sign-in. Prefer
   * the runtime that can be asked what it loaded; measured beats mapped,
   * whoever is signed in.
   */
  #inventoryAgents(): InventoryAgent[] {
    const byBrand = new Map<string, InventoryAgent>()
    for (const runtime of this.#runtimes.values()) {
      const brand =
        runtime.info.presentation.brand ??
        runtime.info.presentation.name.toLowerCase().replace(/\s+/g, '')
      const kept = byBrand.get(brand)
      if (kept && (kept.listSkills || !runtime.listSkills)) continue
      byBrand.set(brand, {
        id: runtime.info.id,
        brand,
        ...(runtime.listSkills ? { listSkills: runtime.listSkills.bind(runtime) } : {}),
        // The rejections too, where the runtime reports them: without this
        // the scanner cannot tell a definition an agent refuses from one it
        // has not re-read, and calls both "not loaded yet" for ever.
        ...(runtime.listSkillProblems
          ? { listSkillProblems: runtime.listSkillProblems.bind(runtime) }
          : {}),
      })
    }
    return [...byBrand.values()]
  }

  #onEvent(runtime: RuntimeId, event: AgentEvent): void {
    // The host's permission policy runs before the backend's own
    // question reaches a human. A matched approval never renders: it is
    // answered here, audited here, and reported as a notice.
    if (event.type === 'approval/requested') {
      const verdict = this.#applyPolicy(runtime, event.approval)
      if (verdict) return
    }
    // A denial, noticed while the original approval is still in the
    // registry (`registry.apply` below deletes it). The team plane holds
    // the denied conversation's outbound messages for the rest of the turn
    // — an agent refused an action must not quietly ask a teammate.
    if (event.type === 'approval/resolved' && event.resolution.outcome === 'decided') {
      const decision = event.resolution.decision
      const approval = this.registry
        .get(runtime, event.sessionId)
        ?.approvals.get(String(event.approvalId))
      const denied =
        decision.type === 'cancel' ||
        (decision.type === 'option' &&
          approval !== undefined &&
          approval.type !== 'userInput' &&
          approval.type !== 'elicitation' &&
          approval.options.find((option) => option.id === decision.optionId)?.intent === 'deny')
      if (denied) this.#team.noteDenial(runtime, String(event.sessionId))
    }
    // One audit log, whichever agent. Recorded before fan-out so the
    // log holds what happened even if no window was open to see it.
    this.#audit.record(runtime, event, (sessionId) =>
      this.registry.get(runtime, makeSessionId(sessionId))?.session.cwd,
    )
    // What the host itself put in the turn, before the runtime's own account
    // of it replaces the list: a runtime that streamed less than it stored
    // hands back a longer list that has never heard of a publication, and
    // `reduceSession` rightly prefers the longer one. Put back where they
    // stood — and sent onward in the event the windows get, whose own
    // `reduceSession` would otherwise make the same replacement and lose
    // the row the host had just kept.
    const published =
      event.type === 'turn/completed'
        ? publicationsIn(
            this.registry.get(runtime, event.sessionId)?.session.turns.find((turn) => turn.id === event.turn.id)
              ?.items ?? [],
          )
        : []
    const record = this.registry.apply(runtime, event)
    let outgoing: AgentEvent = event
    if (record && event.type === 'turn/completed' && published.length > 0) {
      const kept = record.session.turns.find((turn) => turn.id === event.turn.id)
      const items = withPublications(kept?.items ?? [], published)
      record.session = {
        ...record.session,
        turns: record.session.turns.map((turn) => (turn.id === event.turn.id ? { ...turn, items } : turn)),
      }
      outgoing = { ...event, turn: { ...event.turn, items } }
    }
    // The runtime's own list, held so a reloading client gets it back. Kept
    // here and not folded into the session: the runtime owns it, and a second
    // registry would only give the two a way to disagree.
    if (record && event.type === 'session/tasks') record.tasks = event.tasks
    // What the host just folded in is what a read tomorrow will be missing.
    if (record && event.type !== 'approval/requested' && event.type !== 'approval/resolved') {
      this.#transcripts.record(record.session, { now: event.type === 'turn/completed' })
    }
    // The numbers moved because a turn just spent some: re-read that agent
    // only, and only when someone could be looking. Cheaper and fresher than
    // any interval.
    if (event.type === 'turn/completed') {
      void this.#usageService.refresh(runtime).catch(() => undefined)
    }
    this.#push({ method: 'event', params: { runtime, event: outgoing } })
    // A sign-in that landed on an identity another account already holds did
    // not add an account. Checked after the event has gone out, so the screen
    // that started the flow sees it succeed — which it did — before the row it
    // made is taken away with a sentence saying why.
    if (event.type === 'account/loginCompleted' && event.success) {
      void this.#foldDuplicateAccount(runtime).catch((error: unknown) => {
        this.#logger.warn('a duplicate account could not be folded', { runtime, error: String(error) })
      })
    }
    // The turn the queue was waiting for has ended. A clean finish
    // sends the next message; anything else holds the queue and says why,
    // because delivering into a rate limit, a crash, or a turn the user just
    // stopped spends a turn on a guess about what they meant.
    if (event.type === 'turn/completed' && record && record.queue.messages.length > 0) {
      if (event.turn.status === 'completed') {
        void this.#drain(record)
      } else {
        this.registry.pauseQueue(record, pauseReason(event.turn))
        this.#pushQueue(record)
      }
    }
    // Messages other agents left for this conversation go after the user's
    // own queue — the team module re-checks busyness and the queue itself,
    // so the host only has to say "this conversation may have settled". Both
    // signals matter: at `turn/completed` the status is often still
    // `active` (the status event trails the turn), so the idle transition
    // is the nudge that actually lands most deliveries.
    if (
      event.type === 'turn/completed' ||
      (event.type === 'session/status' && event.status.type === 'idle')
    ) {
      // The turn's own last word goes with the signal: if this turn was
      // started by a teammate's message, the room shows that answer. It is
      // never sent back — see `'shown'` in the protocol.
      const answer =
        event.type === 'turn/completed'
          ? event.turn.items
              .filter((item) => item.type === 'assistantMessage')
              .map((item) => (item as { text?: string }).text ?? '')
              .filter((text) => text.trim() !== '')
              .pop()
          : undefined
      // And how it ended, when it ended badly. A room that was owed an answer
      // is told; without this the member simply goes quiet, which reads
      // exactly like one still thinking.
      const failure = event.type === 'turn/completed' ? failureOf(event.turn) : null
      void this.#team.onTurnEnded(
        runtime,
        String(event.sessionId),
        event.type === 'turn/completed'
          ? { ...(answer ? { answer } : {}), ...(failure ? { failure } : {}) }
          : undefined,
      )
    }
    if (event.type === 'session/closed') {
      this.#team.onSessionClosed(runtime, String(event.sessionId))
    }
  }

  /**
   * The conversations the team plane can reach, described for it.
   *
   * Live ones, and the ones whose agent restarted underneath them: a member
   * detached by a catalogue refresh is still a member, still idle, and takes
   * the room's next post through `#liveFor` exactly as it takes the user's.
   * Reading only `live` here emptied every room the first time the window
   * came back into focus after launch. A conversation the user closed has no
   * handle either and is not detached, so it stays out.
   */
  #teamPeers(): TeamPeer[] {
    const out: TeamPeer[] = []
    for (const record of this.registry.all()) {
      if ((!record.live && !record.detached) || record.session.archived) continue
      const runtime = this.#runtimes.get(record.runtime)
      if (!runtime) continue
      out.push({
        runtime: record.runtime,
        sessionId: String(record.session.id),
        // The name the user gave it wins over the one the agent chose: for an
        // agent that cannot be told a name, ours is the only one there is.
        title: this.#names.nameOf(record.runtime, record.session.id) ?? record.session.title ?? null,
        cwd: record.session.cwd,
        agent: runtime.info.presentation.name,
        busy: isBusy(record.session),
        canSteer: runtime.info.capabilities.steer,
        queuedByUser: record.queue.messages.length,
        /* The room names a new member after what it runs, so three
           conversations on one agent and one account are told apart by the one
           thing that actually differs between them. */
        model: record.session.settings?.model ?? null,
        /* Everything the host holds a record for is open, by construction —
           that is what having a record means. The rooms mint the other kind
           themselves, for their members that nobody has opened this run. */
        here: true,
      })
    }
    return out
  }

  /**
   * The project a folder belongs to: the repository it is a checkout of, or —
   * for a folder in no repository at all — the open workspace that contains
   * it. Cached per folder; the cache clears when the workspace set changes,
   * because that is the only input to the second half that can change the
   * answer.
   *
   * The repository half is `repositoryOf`'s answer, and it has to be the same
   * string, not merely the same folder. A room is keyed by what this returns;
   * the session tree groups conversations by what `repositoryOf` returns. Two
   * spellings of one folder is not a near miss — it draws the project twice,
   * the room under one path and its own conversations under the other, and
   * `joinRoom` compares the two strings and refuses.
   *
   * So this asks that function rather than doing arithmetic of its own on
   * `--git-common-dir`, which parted company with it in two measurable ways.
   * A submodule's common dir is `<super>/.git/modules/<path>` and a
   * `--separate-git-dir` checkout's is wherever it was put; neither ends in
   * `/.git`, so both fell through the suffix test and were resolved as if
   * they were in no repository at all — landing on the open workspace, which
   * for a submodule is usually the superproject. And where the test did pass,
   * an open workspace *containing* the repository was still allowed to stand
   * in for it, keying a room by a parent folder none of its conversations
   * resolve to. Canonicalisation comes along for free: `repositoryOf` puts
   * every answer through `canonical()`, including the `worktree list`
   * fallback git does not canonicalise itself.
   */
  async #boardRootOf(cwd: string): Promise<string | null> {
    const cached = this.#boardRoots.get(cwd)
    if (cached !== undefined) return cached
    /*
     * Git first, and the open workspaces second — and the workspaces only
     * where git had nothing to say at all.
     *
     * This used to take `containing(cwd)` and only ask git when nothing
     * matched — which is right for a subfolder and wrong for the one case the
     * git call exists to serve. A linked worktree that the person has *opened*
     * is itself in `roots`, so it contained its own conversations and resolved
     * to itself: the room created under the main checkout could not be joined
     * by anything working in the worktree, because every peer came back with a
     * root the room did not have. The failure needed both halves — a real
     * worktree and it being open — so a resolver stubbed in a unit test could
     * never show it.
     *
     * `repositoryOf` folds every checkout of a repository onto the main one,
     * so it is the project. Asking first costs a `rev-parse` per distinct
     * folder, cached below, and makes the answer independent of which folders
     * somebody happens to have open.
     */
    /* Through `#repoOf`, not `repositoryOf` directly: it caches the promise
       per folder, so the session list's probe and this one are the same
       `rev-parse` rather than two. One question, one cache — which is the
       whole point here. `#boardRoots` still caches on top, because the
       workspace half below does depend on what is open and the git half does
       not, so clearing it re-runs only the part that can have changed. */
    const project = (await this.#repoOf(cwd))?.root ?? null
    if (project !== null) {
      this.#boardRoots.set(cwd, project)
      return project
    }
    /* No repository, so the open workspaces answer — as the person spelled
       them, deliberately not canonicalised. A folder git knows nothing about
       has no `repo` on its sessions either, and the tree keys those by the
       folder each conversation reported. Resolving `/tmp/demo` to
       `/private/tmp/demo` here would put the room in a folder none of its own
       sessions is grouped under, which is the very split this is closing.

       Longest match, not first match. `roots` is in most-recently-opened
       order, so `find` made membership depend on which workspace the person
       happened to open last: with `/repo` and `/repo/nested` both open, a
       conversation inside the nested checkout landed on whichever came
       first — putting its claims and its messages on an unrelated board.
       Trailing slashes are trimmed so `/repo` and `/repo/` are one root. */
    const roots = [
      ...new Set(this.#state.state.workspaces.map((entry) => entry.path.replace(/\/+$/, ''))),
    ]
    const target = cwd.replace(/\/+$/, '')
    let found: string | null = null
    for (const root of roots) {
      if (target !== root && !target.startsWith(`${root}/`)) continue
      if (found === null || root.length > found.length) found = root
    }
    this.#boardRoots.set(cwd, found)
    return found
  }

  /**
   * Applies the first matching policy rule; returns true when the approval
   * was consumed. Rules live in preferences as
   * `{ id, name, match: { type?, pattern? }, action: 'approve' | 'deny' }`
   * and match on the approval's type and its human-readable subject — the
   * command line, the change summary — the same text the dialog would show.
   */
  #applyPolicy(runtime: RuntimeId, approval: Approval): boolean {
    // Input typed into a running program is not the command that started
    // it. A rule written to allow `npm test` must not answer "y" to whatever
    // that test run is now asking, so stdin approvals always reach a person.
    if (approval.type === 'command' && approval.kind === 'stdin') return false
    const raw = this.#state.state.preferences['permissionPolicy']
    const rules = Array.isArray(raw) ? (raw as PolicyRule[]) : []
    const subject =
      approval.type === 'command'
        ? approval.command
        : approval.type === 'fileChange'
          ? approval.changes.map((change) => change.path).join(' ')
          : approval.type === 'permission'
            ? approval.summary
            : ''
    for (const rule of rules) {
      if (rule.match.type && rule.match.type !== approval.type) continue
      if (rule.match.pattern) {
        let matched = false
        try {
          matched = new RegExp(rule.match.pattern).test(subject)
        } catch {
          continue // A broken pattern matches nothing rather than everything.
        }
        if (!matched) continue
      }
      // userInput and elicitation carry questions, not yes/no options — a
      // policy cannot answer a question, so those always reach the human.
      if (approval.type === 'userInput' || approval.type === 'elicitation') continue
      const wanted = rule.action === 'approve' ? 'approve' : 'deny'
      const option = approval.options.find((entry) => entry.intent === wanted)
      if (!option) continue // The backend offers no such answer; ask the human.
      const live = this.registry.get(runtime, approval.sessionId)?.live
      if (!live) return false
      // Armed here, not on `approval/resolved`. A policy denial answers the
      // agent directly and returns before `registry.apply` ever stores the
      // approval, so the lookup that recovers the deny option finds nothing
      // and the relay guard was never armed at all — an agent the *policy*
      // refused could turn straight round and ask a more permissive
      // teammate to do it. Safety rule 2 does not care who said no.
      if (wanted === 'deny') this.#team.noteDenial(runtime, String(approval.sessionId))
      void live.respondToApproval(approval.id, { type: 'option', optionId: option.id })
      this.#audit.append({
        at: Date.now(),
        runtime,
        sessionId: String(approval.sessionId),
        ...(this.registry.get(runtime, approval.sessionId)?.session.cwd
          ? { cwd: this.registry.get(runtime, approval.sessionId)!.session.cwd }
          : {}),
        kind: 'approval/autoDecided',
        approvalType: approval.type,
        decision: rule.action,
        rule: rule.name,
      })
      this.#push({
        method: 'event',
        params: {
          runtime,
          event: {
            type: 'notice',
            sessionId: approval.sessionId,
            level: 'info',
            message: `${rule.action === 'approve' ? 'Approved' : 'Denied'} by your policy rule “${rule.name}”.`,
          },
        },
      })
      this.#logger.info('approval auto-decided by policy', {
        runtime,
        rule: rule.name,
        action: rule.action,
        type: approval.type,
      })
      return true
    }
    return false
  }

  /** The runtime's own description, plus whatever the host has learned about it since. */
  /**
   * Makes one more account of an agent and brings it up.
   *
   * Started here rather than left to the caller: the runtime has to be running
   * before it can be signed into, and a slot that exists on disk but answers
   * nothing would look exactly like the bug this feature fixes.
   */
  async #addAccount(
    id: RuntimeId,
    gateway?: { readonly name: string; readonly endpoint: string; readonly apiKey: string },
  ): Promise<{ runtime: RuntimeId; info: RuntimeInfo }> {
    const accounts = this.options.accounts
    const of = this.#runtime({ runtime: id })
    if (!accounts || !accounts.canAdd(of.info)) {
      throw new Error(`${of.info.name} cannot hold more than one account here.`)
    }
    // The key goes to the broker on the way past and is never held here: what
    // the slot records, and all anything else can ask for, is the reference.
    const spec = gateway
      ? {
          name: gateway.name,
          endpoint: gateway.endpoint,
          credentialRef: await this.#credentials.store(`${gateway.name} key`, gateway.apiKey),
        }
      : undefined
    const runtime = await accounts.add(of.info, spec)
    // Before `register`, so the row never exists in a state where a turn could
    // reach a Codex that has not been told where to send it.
    await this.#prepareGateway(runtime)
    this.register(runtime)
    const info = this.#infoOf(runtime)
    this.#push({ method: 'runtime/added', params: { info } })
    // Waited for, not left running behind the answer: the caller's very next
    // act is to sign this account in, and every part of that — which ways in
    // it offers, the login itself — is a question only a started agent can
    // answer. Codex refuses both while its app-server is coming up
    // ("Cannot call account/read: app-server is starting"), so answering
    // early made "Add another account" a button that produced a row and
    // nothing else: `runtime/account` failed, the interface saw an agent with
    // no way to sign in, and the sign-in it tried to start never began.
    //
    // Failing to start is still not a failed add — `#startOne` never rejects,
    // and gives up *waiting* after `START_TIMEOUT_MS` while the attempt runs
    // on. The row is already on screen either way, and its health says why it
    // is not ready. The gateway is already pointed, above.
    await this.#startOne(runtime, true)
    this.#logger.info('account added', { agent: id, runtime: runtime.info.id })
    return { runtime: runtime.info.id, info }
  }

  /**
   * Undoes an account that turned out to be one the user already had.
   *
   * The second sign-in works — the browser comes back, Codex writes the
   * credential, the row is live — and only then is it visible that both rows
   * are one person. Nothing downstream can cope with that: the two accounts
   * meter one quota, and their two app-servers hold one thread store, so the
   * conversation opened in one is refused in the other.
   *
   * The row that just signed in is the newest fact, so it is the one that
   * goes: the other is the account the user has already named, tinted, and
   * been running turns as. The exception is the agent's own account, which
   * cannot be removed at all — sign *that* back in as somebody a second
   * account already is and the duplicate is the second account, so it is the
   * one folded away instead.
   *
   * Nothing is signed out on the way — see `pruneDuplicates`. The credential
   * being dropped names the identity the surviving account is using, and
   * revoking it would sign the user out of the account they kept.
   */
  async #foldDuplicateAccount(id: RuntimeId): Promise<void> {
    const accounts = this.options.accounts
    const runtime = this.#runtimes.get(id)
    if (!accounts?.identityOf || !runtime) return
    // Two sign-ins completing together would otherwise both fold the same
    // account: the second finds it already unregistered, warns about a failure
    // that did not happen, and says the same sentence to the user twice.
    if (this.#folding.has(id)) return
    this.#folding.add(id)
    try {
      const identity = accounts.identityOf(runtime.info)
      if (identity === null) return
      const peers = this.#peerAccounts(runtime, identity)
      if (peers.length === 0) return
      const mine = accounts.slotOf(runtime.info)?.removable === true
      // Whichever row survives, the notice has to name it — so the agent's own
      // account is preferred over another slot, because that is the row the
      // user will still be looking at.
      const kept = mine
        ? (peers.find((peer) => accounts.slotOf(peer.info)?.removable !== true) ?? (peers[0] as AgentRuntime))
        : runtime
      const folded = (mine ? [runtime] : peers).filter(
        (peer) => peer !== kept && accounts.slotOf(peer.info)?.removable === true,
      )
      const dropped: RuntimeId[] = []
      for (const account of folded) {
        // Defence in depth, and deliberately not covered by a test: the
        // in-flight guard above stops a second fold of the same row, and
        // folding a row detaches it so it can report nothing further. What is
        // left is a removal arriving from somewhere else — Settings, say —
        // between this list being taken and this element being reached. Then
        // the row is already gone, which is work done rather than a failure,
        // and saying otherwise would put a phantom fold in the log.
        if (!this.#runtimes.has(account.info.id)) continue
        try {
          await this.unregister(account.info.id)
          await accounts.remove(account.info.id)
        } catch (error) {
          this.#logger.warn('a duplicate account could not be folded', {
            runtime: account.info.id,
            error: String(error),
          })
          continue
        }
        dropped.push(account.info.id)
        this.#logger.info('a duplicate account was folded into the one it copied', {
          runtime: account.info.id,
          into: kept.info.id,
        })
      }
      if (dropped.length === 0) return
      // One sentence per fold, not per row: two duplicates removed together
      // are one thing that happened, and saying it twice reads like two.
      const name = await this.#accountLabel(kept)
      const brand = kept.info.presentation.name
      this.#push({
        method: 'event',
        params: {
          runtime: kept.info.id,
          event: {
            type: 'notice',
            level: 'warning',
            // Where the choice actually is: the sign-in page used whichever
            // account the browser was already in, which is the whole reason
            // this happens at all. Saying "sign in as somebody else" without
            // saying where leaves the person to repeat it and get this same
            // sentence back.
            message: `You are already signed in to ${brand}${name === null ? '' : ` as ${name}`}, so the account just added was dropped. The sign-in page uses whichever account your browser is in — choose a different one there to add a second.`,
          },
        },
      })
    } finally {
      this.#folding.delete(id)
    }
  }

  /** Every other account of the same agent signed in as the same identity. */
  #peerAccounts(runtime: AgentRuntime, identity: string): readonly AgentRuntime[] {
    const accounts = this.options.accounts
    if (!accounts?.identityOf) return []
    const agent = accounts.slotOf(runtime.info)?.agent
    if (agent === undefined) return []
    const peers: AgentRuntime[] = []
    for (const other of this.#runtimes.values()) {
      if (other.info.id === runtime.info.id) continue
      if (accounts.slotOf(other.info)?.agent !== agent) continue
      if (accounts.identityOf(other.info) === identity) peers.push(other)
    }
    return peers
  }

  /**
   * What to call an account on screen, or null when nothing can name it.
   *
   * Null rather than the agent's own name: a caller that falls back to that
   * gets "signed in to Codex as Codex", which reads like a bug. A sentence
   * with the identity left out is the honest shorter one.
   */
  async #accountLabel(runtime: AgentRuntime): Promise<string | null> {
    try {
      const status = await runtime.getAccount?.()
      const account = status?.accounts[0]
      return account?.email ?? account?.label ?? null
    } catch {
      return null
    }
  }

  async #removeAccount(id: RuntimeId): Promise<void> {
    const accounts = this.options.accounts
    const runtime = this.#runtime({ runtime: id })
    const slot = accounts?.slotOf(runtime.info) ?? null
    if (!accounts || !slot?.removable) {
      throw new Error(`${runtime.info.name} is this agent's original account and cannot be removed.`)
    }
    // A gateway account has no vendor session to end — its credential is ours
    // to destroy. The gateway process goes first, so nothing is left holding
    // the key in memory once the reference it came from is gone.
    if (slot.gateway) {
      this.#gateways.stop(id)
      try {
        await this.#credentials.delete(slot.gateway.credentialRef)
      } catch (error) {
        this.#logger.warn('a gateway account was removed but its key remains', {
          runtime: id,
          error: String(error),
        })
      }
    } else {
      // Signing out first so the credential is revoked, not merely unlinked —
      // unless another account of this agent is signed in as the same person.
      // Then the credential is a copy, revoking it would take the account the
      // user is keeping down with it, and dropping the copy is the whole job.
      const identity = accounts.identityOf?.(runtime.info) ?? null
      const twin = identity === null ? null : (this.#peerAccounts(runtime, identity)[0] ?? null)
      if (twin) {
        this.#logger.info('a duplicate account was removed without signing out', {
          runtime: id,
          shares: twin.info.id,
        })
      } else {
        try {
          await runtime.logout?.()
        } catch (error) {
          this.#logger.warn('an account was removed without signing out', { runtime: id, error: String(error) })
        }
      }
    }
    await this.unregister(id)
    await accounts.remove(id)
    this.#logger.info('account removed', { runtime: id, gateway: slot.gateway !== undefined })
  }

  /**
   * Stamps every row with the account that is actually holding it.
   *
   * Two accounts of one agent share a conversation store, and only one of them
   * lists it — the other declares `listHistory: false` so the shared history is
   * shown once rather than once per account. But listing is not holding: the
   * agent underneath allows one live writer per conversation, so a row this
   * account listed may be one the *other* account has open, and opening it
   * here would be refused by a sentence naming neither of them.
   *
   * The lister does not know who holds what — the accounts are separate
   * processes with separate stores of live handles. This host does, because it
   * runs both. So the row is re-addressed to whoever holds it, which turns a
   * refusal into the conversation opening where it already is.
   *
   * Nothing happens for the common case: one account, no peers, no rewrite.
   */
  /**
   * The repository a folder belongs to, asked of git once per folder.
   *
   * The promise itself is cached, not its result, so a page listing twenty
   * conversations in one folder starts one `rev-parse` rather than twenty.
   */
  #repoOf(cwd: string): Promise<RepoInfo | null> {
    const held = this.#repos.get(cwd)
    if (held) return held
    const asked = repositoryOf(cwd).catch(() => null)
    this.#repos.set(cwd, asked)
    return asked
  }

  /**
   * Stamps every row with the repository its folder belongs to.
   *
   * Grouping the session list needs this and the agents cannot supply it:
   * one of them reports a git remote and the rest report nothing, so a
   * conversation an ACP agent had in a worktree had no way to say which
   * project it was about and became a project of its own. The host is the one
   * party that can ask git, so it does — once per folder, cached.
   */
  async #withRepos(page: Page<SessionSummary>): Promise<Page<SessionSummary>> {
    const folders = [...new Set(page.data.map((row) => row.cwd))]
    const repos = new Map(
      await Promise.all(folders.map(async (cwd) => [cwd, await this.#repoOf(cwd)] as const)),
    )
    return { ...page, data: page.data.map((row) => ({ ...row, repo: repos.get(row.cwd) ?? null })) }
  }

  #routeToHolders(runtime: AgentRuntime, page: Page<SessionSummary>): Page<SessionSummary> {
    const peers = this.#peersOf(runtime)
    if (peers.length === 0) return page
    return {
      ...page,
      data: page.data.map((row) => {
        const holder = this.#holderOf(peers, row.id)
        return holder && holder !== row.runtime ? { ...row, runtime: holder } : row
      }),
    }
  }

  /**
   * The other runtimes reading and writing the same conversations as this one.
   *
   * Identity is the store the runtime declares, never the account wiring: two
   * runtimes are peers because they are looking at the same files, which is a
   * fact about the agent and not about how the accounts were made.
   */
  #peersOf(runtime: AgentRuntime): readonly AgentRuntime[] {
    const store = runtime.sessionStore
    if (!store) return []
    return [...this.#runtimes.values()].filter(
      (peer) => peer.info.id !== runtime.info.id && peer.sessionStore === store,
    )
  }

  /** Which of `peers` has this conversation open right now, if any. */
  #holderOf(peers: readonly AgentRuntime[], id: SessionId): RuntimeId | null {
    for (const peer of peers) {
      if (this.registry.get(peer.info.id, id)?.live) return peer.info.id
    }
    return null
  }

  /**
   * The host's archive and its names laid over a runtime's listing.
   *
   * A runtime with an archive of its own answered the question already, and
   * this is a no-op for it. For the rest — every ACP agent — the runtime has
   * listed everything it knows, and the marks decide which half the caller
   * asked for. Rows that survive an `only` are stamped `archived`, because a
   * screen that shows an archive should not have to infer it from the fact
   * that it asked.
   */
  async #applyArchive(
    runtime: AgentRuntime,
    page: Page<SessionSummary>,
    filter: ArchiveFilter,
  ): Promise<Page<SessionSummary>> {
    await this.#names.load()
    if (runtime.info.capabilities.archiveHistory) {
      // Codex answers `only` with archived threads and says nothing about it;
      // the field is the interface's, so the host fills it in. The names still
      // apply: an agent can keep an archive and no name, and hanging one off
      // the other made a runtime with its own archive silently unnameable.
      const marked =
        filter === 'only' ? page.data.map((row) => ({ ...row, archived: true })) : page.data
      return { ...page, data: marked.map((row) => this.#named(runtime, row)) }
    }
    await this.#archive.load()
    const data: SessionSummary[] = []
    for (const row of page.data) {
      const archived = this.#archive.has(runtime.info.id, row.id)
      if (archived !== (filter === 'only')) continue
      data.push(archived ? { ...row, archived: true } : row)
    }
    return { ...page, data: data.map((row) => this.#named(runtime, row)) }
  }

  /**
   * A summary wearing the name the user gave it.
   *
   * Only for runtimes that keep no name of their own — `SessionNames` is never
   * written for one that does, so this never shadows an agent's own title.
   */
  #named(runtime: AgentRuntime, row: SessionSummary): SessionSummary {
    if (runtime.info.capabilities.nameHistory) return row
    const name = this.#names.nameOf(runtime.info.id, row.id)
    return name === null ? row : { ...row, title: name }
  }

  #infoOf(runtime: AgentRuntime): RuntimeInfo {
    const update = this.#updates.get(runtime.info.id)
    const catalogCheckedAt = this.#catalogs.lastChecked(runtime.info.id)
    const accounts = this.options.accounts
    const slot = accounts?.slotOf(runtime.info) ?? null
    return {
      ...runtime.info,
      ...(update ? { update } : {}),
      ...(catalogCheckedAt !== null ? { catalogCheckedAt } : {}),
      // What the install service last found for this agent: every copy on
      // the machine and the one that answers. Only for agents it knows.
      ...(this.options.installs?.last(String(runtime.info.id))
        ? { install: this.options.installs.last(String(runtime.info.id)) }
        : {}),
      // Registry-born runtimes are the interface's to remove; the flag is
      // attached here because the runtime has no idea where it came from.
      ...(this.options.agents?.owns(runtime.info.id) ? { origin: 'registry' as const } : {}),
      // The slot's `gateway` is rebuilt rather than spread: it carries a
      // `credentialRef`, and nothing off the wire has any business holding
      // one — `credentials/delete` takes exactly that.
      ...(slot
        ? {
            slot: {
              agent: slot.agent,
              home: slot.home,
              removable: slot.removable,
              canAdd: accounts?.canAdd(runtime.info) ?? false,
              ...(slot.gateway
                ? { gateway: { name: slot.gateway.name, endpoint: slot.gateway.endpoint } }
                : {}),
            },
          }
        : {}),
    }
  }

  /**
   * Asks the update source about a runtime that has just come up, and tells
   * connected clients when the answer changes what they should show. Runs
   * after `start()` resolves, never on its critical path: an offline machine
   * must not wait on a registry to open a window.
   */
  async #checkForUpdate(runtime: AgentRuntime): Promise<void> {
    if (!this.options.updates) return
    const id = runtime.info.id
    try {
      const update = await this.options.updates.updateFor(runtime.info)
      const before = this.#updates.get(id)
      if (update) this.#updates.set(id, update)
      else this.#updates.delete(id)
      if (before?.version !== update?.version) {
        this.#logger.info('runtime update available', { runtime: id, running: runtime.info.version, latest: update?.version ?? null })
        this.#push({ method: 'runtime/infoChanged', params: { runtime: id, info: this.#infoOf(runtime) } })
      }
    } catch (error) {
      this.#logger.debug('update check failed', { runtime: id, error: String(error) })
    }
  }

  #onHealthChange(runtime: RuntimeId, health: RuntimeHealth): void {
    if (health.state !== 'ready') {
      for (const record of this.registry.detachAll(runtime)) this.#pushQueue(record)
      this.#terminals.detachAll(runtime)
      // Same reason as `unregister`: these sessions went down without a
      // `session/closed` each, and a message marked queued against a
      // conversation that no longer exists is a message dropped in silence.
      this.#team.onRuntimeDetached(runtime, 'The agent stopped before the message was read.')
    }
    this.#push({ method: 'runtime/healthChanged', params: { runtime, health } })
  }

  #push(notification: WireNotification): void {
    for (const broadcast of this.#broadcasters) {
      try {
        broadcast(notification)
      } catch {
        // A broken socket must not stop the others from being served.
      }
    }
  }
}

/**
 * How long a busy conversation's refusal will wait to name the account holding
 * it. Short on purpose: the name is an improvement to a sentence the person
 * gets either way.
 */
const ACCOUNT_NAME_DEADLINE_MS = 2_000

/**
 * One conversation, as a key — the protocol's own `sessionKey`, which is what
 * the registry and the renderer use for the same pair, so the host has one
 * spelling of "this conversation" and the separator question is answered once.
 */
const recordKey = (record: SessionRecord): string => sessionKey(record.runtime, record.session.id)

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Why a queue stopped, in the turn's own words where it has any. A person
 * reading this has to be able to tell "I pressed Stop" from "the agent fell
 * over", because the two want different next moves.
 */
const pauseReason = (turn: Turn): string => {
  if (turn.status === 'interrupted') return 'The turn was stopped.'
  return turn.error?.message ?? 'The turn did not finish.'
}

/**
 * How a turn ended, in the terms a room reports.
 *
 * A turn the runtime is about to retry has not stopped, and a turn that
 * answered before it failed has already said its piece — neither is news.
 * The classification is the adapters' own (`AgentError['code']`), so the
 * host never sniffs an error's text to decide what it was.
 */
const failureOf = (turn: Turn): TeamTurnFailure | null => {
  if (turn.status !== 'failed' && turn.status !== 'interrupted') return null
  if (turn.error?.retrying) return null
  const cause: TeamTurnFailure['cause'] =
    turn.error?.code === 'credits' || turn.error?.code === 'rateLimit'
      ? 'limit'
      : turn.error?.code === 'auth'
        ? 'auth'
        : 'stopped'
  return { cause, message: pauseReason(turn) }
}

/**
 * Worded from the runtime's own presentation, so the message is true for
 * whichever runtime was asked and never names one the host has not met.
 */
