import { createHash, randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BrowserSettings } from '@harnessdesk/cordis-host'
import { GatewaySupervisor } from '@harnessdesk/responses-gateway'

import {
  holderOf,
  DEFAULT_LANE_PREFERENCES,
  lanePreferences,
  isFolderGone,
  isBusy,
  isSessionBusy,
  isSessionGone,
  reopenRefusedByAgent,
  SessionGoneError,
  SessionBusyError,
  sessionId as makeSessionId,
  sessionKey,
  splitSessionKey,
  type AgentEvent,
  type AgentRuntime,
  type ArchiveFilter,
  type AgentSession,
  type ConfigOption,
  type FlowSeat,
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
  type TeamState,
  type Turn,
  type UserContent,
  type Unsubscribe,
  type WireNotification,
  type ResolvedModelRoute,
  type Approval,
  type ContributionId,
  type ScopeQuery,
  type GoalSeatRequest,
  type GoalReceipt,
  type SecretReload,
  type SeatId,
  type SeatRecord,
  type SeatArchived,
  type SeatLeft,
  type PublicationItem,
  runtimeId,
  sessionModel,
} from '@harnessdesk/protocol'

import { packagedPath, type AgentDirectory } from './agent-registry.js'
import { exportAgentFolders, importAgentFolder } from './agent-files.js'
import { MachineSeatingFile, SEATING_FILE, parseSeating } from './agent-seating-file.js'
import { noteLeftOnFailure, runningOf, type SeatRunning } from './agent-seating.js'
import { AgentWatch } from './agent-watch.js'
import { Agents } from './agents.js'
import type { InstallService } from './installs/service.js'
import { AuditLog } from './audit.js'
import { CatalogRefresher } from './catalog-refresher.js'
import { Ledger, defaultCorpora, type CorpusSpec } from './ledger/index.js'
import type { UsageMeter } from './usage/meter.js'
import { UsageService } from './usage/service.js'
import { CredentialBroker, plainCipher, type CredentialCipher } from './credentials.js'
import * as gitService from './git.js'
import * as gitOps from './git-ops.js'
import { canonicalDestination } from './git-worktree.js'
import { Worktrees, openRepositoryRoot, repositoryOf } from './worktree.js'
import type { InventoryAgent } from '@harnessdesk/agent-inventory'
import { LibraryUsageReader } from './library-usage.js'
import type { Logger } from './log.js'
import { SessionRegistry, seatedSession, seatedSettings, type SessionRecord } from './registry.js'
import { StateStore } from './state.js'
import { EditorPlane } from './editor-plane.js'
import { EvidencePlane } from './evidence/plane.js'
import type { GhInCheckout } from './evidence/forge.js'
import { revisionOf } from './evidence/revision.js'
import type { SeatOpening } from './evidence/records.js'
import { SEEN_FILE } from './evidence/seen.js'
import { Terminals } from './terminals.js'
import { SessionArchive } from './archive.js'
import { ForgePlane, type ForgePlaneOptions } from './forge.js'
import { publicationsIn, withPublications } from './publications.js'
import { SessionNames } from './names.js'
import { redactorFor, redactLog } from './diagnostics.js'
import { Flows, runCheck } from './flows.js'
import { dispatchAfter, Serial } from './goals/assignments.js'
import { goalMembers } from './goals/members.js'
import { GoalPlane, type GoalPlanePort } from './goals/plane.js'
import { availablePorts, LaneAllocator, LaneStore } from './goals/lanes.js'
import {
  environmentForCheckout,
  environmentForSession,
  laneStandingOrder,
  requireLaneSupport,
} from './goals/lane-environment.js'
import { importMigrationSeats, migrateDesk } from './goals/migration.js'
import { GoalStore, type GoalDocument } from './goals/store.js'
import type { GoalOperation } from './goals/operations.js'
import { acquireDeskWriter } from './goals/writer-lease.js'
import { Team, type TeamPeer, type TeamTurnFailure } from './team.js'
import { TranscriptStore } from './transcripts.js'
import { LocalFiles, assertAbsolute, confine, describeWorkspace } from './workspace.js'
import { dispatch, TERMINAL_CHIP, type HostContext } from './methods/index.js'
import { seatAgent } from './methods/agents.js'

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
  setBrowserResolver?(resolve: (scope: ScopeQuery) => string | undefined): void
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

/**
 * A conversation opened on a seat, and what it is actually running.
 *
 * Both halves are read from the conversation after its picks were applied —
 * what the runtime reports, never the request: `running` for a caller that
 * must compare it with what it asked for, `label` for one that only has to say
 * it. A runtime's report is only as good as what its agent says. Over ACP a
 * pick the agent answered without a word about is reported at what was asked,
 * as the agent's claim (`AcpSession.setOption`). Codex says where every change
 * lands, and one it took without saying so is refused at the pick rather than
 * reported (`CodexSession.setOption`).
 */
export interface OpenedSeat {
  readonly runtime: string
  readonly sessionId: string
  readonly running: SeatRunning
  /** How the desk describes it: "Cursor · Gemini 3.8 Flash · High · thinking". */
  readonly label: string
}

/**
 * A conversation a seating has opened and not yet kept or let go — what a
 * discard has to know to delete only what its seating opened and nobody else
 * touched (`Host#discardSeat`). Only ever a conversation the runtime opened
 * new: one it answered with an id the desk already held is refused before it
 * is held at all (`Host#openSeat`).
 *
 * Kept beside the registry, not on its record: a record is the conversation's,
 * and outlives the seating; this lives exactly as long as the seating's hold on
 * it.
 */
interface SeatInHand {
  /**
   * The handle the seating opened it on: the one a discard closes, when
   * nobody is in the conversation yet. A reopen since, which puts a
   * *different* handle on the record, counts as somebody being in it
   * (`#leaveAsItIs`) — so a discard that finds one closes nothing at all,
   * this handle included, rather than closing this one regardless of what
   * the record now holds.
   */
  readonly live: AgentSession
  /** A window asked something of it — read it, reopened it, wrote to it — while the seating held it. */
  reached: boolean
  /**
   * Past the point of no return: being deleted or archived. Nothing a window
   * asks may start on it now, because nothing that starts could be kept.
   */
  removing: boolean
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
 * Where the built-in Agents ship: `agents/` at the root of this package, beside
 * `src` and `dist`.
 *
 * Found from this module the way the bridges and the tool bridge are found —
 * relative to the compiled file, then through `packagedPath` — so it is the same
 * directory in a checkout, a standalone host and the app. The unpacked twin
 * matters here for a reason of its own: an entry's `path` is shown to a person
 * and handed to other programs to open, and a path inside `app.asar` is one only
 * this process can read. The Agents that ship with the app live there, one
 * folder each. The app carries the folder because the desktop build copies
 * this whole package and unpacks every `node_modules` entry (`asarUnpack`);
 * `files` lists it too, so the manifest says what the package holds. A
 * directory that is not there is still an empty tier rather than a failure.
 */
export const builtinAgentRoot = (): string =>
  packagedPath(fileURLToPath(new URL('../../agents', import.meta.url)))

/**
 * The "Last terminal output" composer chip. Terminals are the host's own
 * workbench tool — they never became a plugin — so this contribution lives
 * here: `capability/list` appends it and `context/resolve` answers it from
 * `Terminals.lastOutput()`. See docs/extending.md.
 */
export interface HostOptions {
  /** How the forge plane reaches `gh`, and how long it trusts an answer. Tests substitute a forge. */
  readonly forge?: ForgePlaneOptions
  /** How the evidence plane reads a branch's pull request with `gh`. Tests answer as the forge would. */
  readonly evidence?: { readonly gh?: GhInCheckout }
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
  /**
   * Moves a file or folder to the OS Trash, where it can be put back.
   * Supplied by the desktop shell; without it, removing an Agent says so.
   */
  readonly trashPath?: (path: string) => Promise<void>
  /**
   * Where the Agents that ship with the app are read from, watched and opened
   * for reading. The app never passes this: they are `builtinAgentRoot()`.
   * A test that counts `agent/changed` points it at a copy, because the real
   * folder is this checkout's `packages/server/agents`, which somebody may be
   * editing while the tests run — and to a host watching it, every edit there
   * is a notice to every window.
   */
  readonly builtinAgents?: string
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
   * How long each read a seating makes before it chooses may take — an
   * account, a model list, the usage. See `SEAT_READ_DEADLINE_MS`.
   */
  readonly seatReadDeadlineMs?: number
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
   * registry entry becomes a runtime; without one, `acp/register` says so.
   */
  readonly agents?: AgentDirectory
  /**
   * Every copy of an agent on this machine, and which one answers. Attached
   * to `RuntimeInfo.install` and asked again through `runtime/installs`.
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
  /** Desktop may restore only a persisted, unreleased lane's opaque profile. */
  browserProfileAllowed(profile: string): boolean {
    return this.#lanes
      .list()
      .some((lane) => lane.browserProfile === profile && lane.state !== 'released')
  }

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
  readonly #laneStore: LaneStore
  readonly #lanes: LaneAllocator
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
  /**
   * The flow engine. Holds the runs, opens the round a finished round earns,
   * and is the only thing on this plane that spends anything.
   */
  readonly #flows: Flows
  /**
   * The Agent roster: this machine's under the state directory, the built-in
   * ones beside this package, and a project's own under whichever open folder a
   * request names. Read afresh on every ask — an Agent is a file somebody edits.
   */
  readonly #agents: Agents
  /**
   * This machine's seats for its Agents: `seating.json`, beside `agents/` in
   * the state directory. Replaces an Agent's `prefer` here, never merges with
   * it — precedence is a seating's own `seats`, then this, then `prefer`.
   *
   * Named apart from `#seating` (below), which is a different thing: the
   * conversations a seating has opened and not yet kept or let go.
   */
  readonly #machineSeating: MachineSeatingFile
  /**
   * The evidence plane: every Seat this desk kept and what it observed, one
   * append-only store per project under `evidence/` in the state directory.
   */
  readonly #evidence: EvidencePlane
  readonly #goalStore: GoalStore
  readonly #goalSerial = new Serial()
  readonly #goals: GoalPlane
  #goalWriter: Awaited<ReturnType<typeof acquireDeskWriter>> | null = null
  #goalsReady = false
  /**
   * The roster, watched (`AgentWatch`). Made at start rather than in the
   * constructor, so a host that is built and never started watches nothing.
   */
  #agentWatch: AgentWatch | null = null
  /**
   * Bumped on every call to `#watchProjects`; a call applies its snapshot only
   * if it is still the latest by the time it has one, so a slower, older call
   * — `#openWorkspace` and `forgetBoardRoots` both fire it without waiting —
   * can never finish last and re-point the watch at a stale set of projects.
   */
  #watchGeneration = 0
  /**
   * Set at the top of `dispose()`, before anything in it can yield: a `start()`
   * still working through its own awaits reads this right before making the
   * roster's watch, so a quit that lands first leaves none to leak.
   */
  #disposed = false
  /** Which board a folder belongs to, cached; cleared when workspaces change. */
  readonly #boardRoots = new Map<string, string | null>()
  /**
   * Which repository each folder belongs to, cached for the life of the host.
   * A folder does not change repository, so this is asked once per folder
   * however many conversations the history lists in it.
   */
  readonly #repos = new Map<string, Promise<RepoInfo | null>>()
  /**
   * Each remembered folder's git top level, for the roster's watch, cached the
   * way `#repos` is: an open asks git about the folder it adds, not again
   * about every folder already remembered, and a folder on a stalled volume
   * holds the watch up until its first answer only, not on every open.
   * Cleared where the board roots are, when a folder is forgotten.
   */
  readonly #topLevels = new Map<string, Promise<string | null>>()
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
  /**
   * Update advisories found so far, each with the version it was measured
   * against, overlaid on each runtime's own `info` — but only beside that
   * version. See `#updateFor`.
   */
  readonly #updates = new Map<string, { readonly against: string | null; readonly update: RuntimeUpdate | null }>()
  /**
   * Runtimes whose advisory is being measured now, so a burst of reads measures
   * once. The runtime itself, not its id: one registered in its place is
   * another runtime, and its measurement is its own.
   */
  readonly #measuringUpdates = new WeakSet<AgentRuntime>()
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
    this.#goalStore = new GoalStore(this.#state.directory)
    this.#worktrees = new Worktrees(this.#state.directory)
    this.#laneStore = new LaneStore(this.#state.directory)
    this.#lanes = new LaneAllocator({
      list: () => this.#laneStore.list(),
      save: (lane) => this.#laneStore.save(lane),
      available: availablePorts,
      create: async (id, goal) => {
        const document = this.#goalStore.read(goal)
        const checkout = await this.#worktrees.create(document.goal.cwd, { name: `lane-${id}` })
        if (!checkout.branch) throw new Error('The lane checkout has no branch. Its reservation was kept.')
        return { cwd: checkout.path, branch: checkout.branch }
      },
      locate: async (lane) => {
        const document = this.#goalStore.read(lane.goal)
        const matches = (await this.#worktrees.list(document.goal.cwd)).filter((checkout) => checkout.branch === `harnessdesk/lane-${lane.id}`)
        if (matches.length !== 1 || !matches[0]?.branch) return null
        return { cwd: matches[0].path, branch: matches[0].branch }
      },
      active: (lane) => this.#evidence.seats.all().some((seat) => !seat.closed && !seat.restored && (seat.id === lane.seat || seat.board === lane.goal && lane.cwd !== '' && seat.checkout.cwd === lane.cwd)),
      busy: (lane) => this.registry.all().some((record) => record.session.cwd === lane.cwd && isBusy(record.session)),
    })
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
    // Beside `agents.json` and everything else the desk keeps, so a test rig or
    // a HARNESSDESK_HOME that moves the state directory moves these with it.
    this.#agents = new Agents({
      user: join(this.#state.directory, 'agents'),
      builtin: options.builtinAgents ?? builtinAgentRoot(),
    })
    // Beside everything else the desk keeps on this machine, so a rig's
    // HARNESSDESK_HOME that moves the state directory moves these with it.
    this.#machineSeating = new MachineSeatingFile(join(this.#state.directory, SEATING_FILE), {
      log: (message, details) => this.#logger.warn(message, details),
    })
    this.#evidence = new EvidencePlane(
      {
        dir: join(this.#state.directory, 'evidence'),
        seenFile: join(this.#state.directory, SEEN_FILE),
        ...(options.evidence?.gh ? { gh: options.evidence.gh } : {}),
        cipher: options.credentialCipher ?? plainCipher,
      },
      {
        board: (room) => {
          try {
            return this.#goalState(room)
          } catch {
            return this.#team.hasRoom(room) ? this.#team.stateFor(room) : null
          }
        },
        cwdOf: (runtime, sessionId) =>
          this.registry.get(runtimeId(runtime), makeSessionId(sessionId))?.session.cwd ?? null,
        push: (notification) => this.#push(notification),
        log: (message, details) => this.#logger.warn(message, details ?? {}),
        canMutateBoard: (goal) => {
          try {
            const document = this.#goalStore.read(goal)
            return document.goal.state === 'open' && document.operation === null
          } catch {
            return false
          }
        },
      },
    )
    // A conversation seen for the first time wears the Agent its Seat record names.
    this.registry.restoreSeatedAs((runtime, id) => this.#evidence.seatedAs(runtime, id))
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
      send: async (runtime, id, text, allowed) => {
        await dispatchAfter(
          allowed ?? (() => ({ ok: true })),
          () => this.#teamLive(runtime, id),
          async (live) => { await live.send([{ type: 'text', text }]) },
        )
      },
      steer: async (runtime, id, text, allowed) => {
        await dispatchAfter(
          allowed ?? (() => ({ ok: true })),
          () => this.#teamLive(runtime, id),
          (live) => live.steer([{ type: 'text', text }]),
        )
      },
      goalMembers: (goal) => {
        const document = this.#goalStore.read(goal)
        return {
          seats: goalMembers(document, this.#evidence.seats.all()),
          legacy: document.legacy?.nicknames,
          sentence: document.goal.sentence,
        }
      },
      memberStatus: (seat) => {
        const record = this.registry.get(seat.session.runtime as RuntimeId, makeSessionId(seat.session.sessionId))
        if (!record) return { exists: true, turn: null, stopped: null }
        const running = [...record.running]
        if (running.length > 1) {
          throw new Error('This member has more than one running turn; wait after one finishes.')
        }
        return {
          exists: true,
          turn: running[0] ? String(running[0]) : null,
          stopped: record.detached ? 'the agent stopped' : null,
        }
      },
      canDispatch: (goal) => this.#goals.canDispatch(goal),
      canMutateBoard: (goal) => {
        try {
          const document = this.#goalStore.read(goal)
          return !document.restored && document.goal.state === 'open' && document.operation === null
            ? { ok: true as const }
            : { ok: false as const, reason: 'This Goal is closing or wrapped. Start another Goal for new work.' }
        } catch {
          // A legacy room has no Goal document and retains the Team engine's
          // standalone behaviour until migration gives it one.
          return { ok: true as const }
        }
      },
      changed: (state) => this.#push({ method: 'team/changed', params: { state } }),
      mutate: (state) => this.#goalSerial.run(() => this.#saveTeamProjection(state)),
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
      log: (message, details) => this.#logger.warn(message, details ?? {}),
      settled: (room, intent) => this.#evidence.settled(room, intent),
    })
    this.#flows = new Flows(join(this.#state.directory, 'flows'), this.#team, {
      /* Opened with the seat's picks, then *read back*: a runtime drops a
         pick it declines rather than failing, so a seat that believes it is
         running at an effort it is not is a seat with an unchecked claim on
         it. Whatever it is really running is what the record and the room
         say it is — a flow says it in the label, and carries on. */
      openLegacySeat: async (input) => {
        await this.#ensureGoalFromTeam(input.goal)
        return this.#goals.openLegacySeat(input)
      },
      releaseGoalSeat: (goal, seat) => this.#goals.release(goal, seat),
      order: (runtime, sessionId, text) => this.#orderSeat(runtime, sessionId, text),
      reseat: async (runtime, sessionId, seat) => {
        const live = await this.#teamLive(runtime as RuntimeId, sessionId)
        await this.#applySeatPicks(live, seat)
        return this.#labelOf(seat.runtime, live.options())
      },
      turnFailure: (runtime, sessionId) => {
        const record = this.registry.get(runtime as RuntimeId, makeSessionId(sessionId))
        const last = record?.session.turns[record.session.turns.length - 1]
        return last?.status === 'failed' ? (last.error?.message ?? 'the turn failed') : null
      },
      retire: (runtime, sessionId) => this.#retireSeat(runtime, sessionId),
      confine: (folder) => this.#confineRoom(folder),
      canMutateBoard: (goal) => {
        try {
          const document = this.#goalStore.read(goal)
          return !document.restored && document.goal.state === 'open' && document.operation === null
            ? { ok: true as const }
            : { ok: false as const, reason: 'This Goal is closing or wrapped. Start another Goal for new work.' }
        } catch {
          return { ok: true as const }
        }
      },
      run: (command, where) => this.#evidence.flowCheck(command, where, runCheck),
      changed: (room, runs) => this.#push({ method: 'flow/changed', params: { room, runs } }),
      log: (message, details) => this.#logger.warn(message, details ?? {}),
    })
    this.#team.attachFlows(this.#flows)
    const goalPort = {
      seats: {
        all: () => this.#evidence.seats.all(),
        byId: (id: SeatId) => this.#evidence.seats.byId(id),
      },
      confine: async (input) => {
        const cwd = input.cwd ?? input.root
        await this.#confineRoom(cwd)
        const root = await this.#boardRootOf(cwd)
        if (!root) throw new Error(`${cwd} is outside every project opened here.`)
        return { root, cwd }
      },
      known: async (runtime: string, session: string) => {
        const agent = this.#runtimes.get(runtime)
        if (!agent) return null
        const id = makeSessionId(session)
        const held = this.registry.get(runtime as RuntimeId, id)?.session ?? await agent.readSession(id).catch(() => null)
        if (!held) return null
        const project = await this.#boardRootOf(held.cwd)
        return project ? { project, busy: isBusy(held) } : null
      },
      claimable: (goal: string, card: number, session) => this.#goalClaimable(goal, card, session.runtime, session.sessionId),
      opening: async (goal: string, session, id: SeatId): Promise<SeatOpening> => {
        const previous = this.#evidence.seats.latestKeptOf(session.runtime, session.sessionId)
        const known = this.registry.get(session.runtime as RuntimeId, makeSessionId(session.sessionId))?.session
        if (!known) throw new Error('Choose a conversation its runtime can still open.')
        const revision = await revisionOf(known.cwd)
        const document = this.#goalStore.read(goal)
        return {
          id,
          agent: previous?.agent ?? null,
          briefDigest: previous?.briefDigest ?? null,
          seat: previous?.seat ?? { runtime: session.runtime },
          seatLabel: previous?.seatLabel ?? session.runtime,
          passedOver: previous?.passedOver ?? [],
          standing: previous?.standing ?? { kind: 'unknown' },
          ceiling: previous?.ceiling ?? null,
          checkout: {
            cwd: known.cwd,
            project: document.goal.root,
            branch: revision?.branch ?? null,
            head: revision?.head ?? null,
          },
          session,
          board: goal,
          role: null,
          openedAt: Date.now(),
        }
      },
      board: (goal: string) => this.#goalState(goal),
      evidence: (goal: string) => this.#evidence.board(goal),
      evidenceIds: (goal: string, project: string) => this.#evidence.factIdsOfGoal(goal, project),
      flow: (goal: string) => this.#flows.runsFor(goal).find((run) => run.state === 'running' || run.state === 'stalled'),
      busy: (session) => {
        const record = this.registry.get(session.runtime as RuntimeId, makeSessionId(session.sessionId))
        return record ? isBusy(record.session) : false
      },
      waits: () => false,
      stranded: (goal: string, card: number) => this.#goalStranded(goal, card),
      held: (goal: string) => this.#goalState(goal).channel.some((entry) => entry.kind === 'message' && entry.state === 'held'),
      settledFor: (goal: string) => this.#evidence.settledFor(goal),
      answer: (seat: SeatRecord) => this.#goalAnswer(seat),
      revision: async (cwd: string) => {
        const revision = await revisionOf(cwd)
        return revision ? { head: revision.head, dirty: revision.dirty } : { head: null, dirty: null }
      },
      changed: (view) => {
        this.#team.installProjection(view.board, this.#goalStore.read(view.goal.id).legacy?.roster)
        this.#push({ method: 'goal/changed', params: { view } })
      },
      activity: (goal, previous, activity, sentence) => this.#push({
        method: 'goal/activity', params: { goal, previous, activity, sentence },
      }),
      ready: () => this.#goalsReady
        ? { ok: true as const }
        : { ok: false as const, reason: 'The Goal store is still starting. Wait for recovery to finish.' },
      seatAgent: async (input: GoalSeatRequest, goal) => {
        const asked = {
          id: input.agent,
          cwd: goal.cwd,
          project: goal.root,
          ...(input.seats === undefined ? {} : { seats: input.seats }),
          ...(input.grant?.kind === 'permission' ? { permission: input.grant.permission } : {}),
        }
        return (await seatAgent(this.#context, asked, {
          board: goal.id,
          role: null,
          ...(input.grant === undefined ? {} : { grant: input.grant }),
        })).record
      },
      openLegacySeat: async (input, goal) => {
        const cwd = goal.cwd
        const opened = await this.#openSeat(input.spec, { cwd, title: input.title })
        try {
          const record = await this.#evidence.seats.opened({
            agent: null,
            briefDigest: null,
            seat: input.spec,
            seatLabel: opened.label,
            passedOver: [],
            standing: { kind: 'permission', permission: input.permission },
            ceiling: null,
            cwd,
            session: { runtime: opened.runtime, sessionId: opened.sessionId },
            board: goal.id,
            role: input.role,
          })
          this.#seating.delete(sessionKey(opened.runtime, opened.sessionId))
          await this.#team.joinRoom(goal.id, opened.runtime as RuntimeId, opened.sessionId, {
            title: input.title,
            agent: this.#runtime({ runtime: opened.runtime }).info.presentation.name,
            cwd,
            model: null,
            at: Date.now(),
          })
          this.#team.setRole(goal.id, opened.runtime, opened.sessionId, input.role)
          return record
        } catch (error) {
          await this.#retireSeat(opened.runtime, opened.sessionId)
          throw error
        }
      },
      importOpening: async (project: string, opening: SeatOpening) => {
        await this.#evidence.seats.importOpening(project, opening)
      },
      closeId: async (id: SeatId, reason: string) => {
        await this.#evidence.seats.closeId(id, reason)
      },
      claim: async (goal: string, card: number, opening: SeatOpening) => {
        await this.#claimGoalCard(goal, card, opening)
      },
      releaseClaim: async (goal: string, seat: SeatId) => {
        await this.#releaseGoalCard(goal, seat)
      },
      refuseMail: async (goal: string, seat: SeatId) => {
        const record = this.#evidence.seats.byId(seat)
        if (record) this.#team.refuseSeatMail(goal, record.session.runtime, record.session.sessionId, String(seat))
      },
      retainLane: async (seat: SeatId) => {
        const lane = this.#lanes.forSeat(seat)
        if (lane) await this.#lanes.retain(lane.id)
      },
      wake: (goal: string) => this.#team.nudgeRoom(goal),
      finish: (goal: string, operation: string) => this.#finishGoalOperation(goal, operation),
      finishWrap: (operation) => this.#finishGoalWrap(operation),
    } satisfies GoalPlanePort
    this.#goals = new GoalPlane(this.#goalStore, goalPort, this.#goalSerial)
    this.#goals.attachLanes(this.#lanes, () => this.#lanePreferences())
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
    this.#extensions?.setBrowserResolver?.((scope) => {
      if (!scope.runtime || !scope.sessionId) return undefined
      const record = this.registry.get(scope.runtime, scope.sessionId)
      if (!record) return undefined
      const matches = this.#lanes
        .list()
        .filter((lane) => lane.cwd !== '' && lane.cwd === record.session.cwd)
      if (matches.length > 1) throw new Error('This checkout has conflicting browser lanes.')
      const lane = matches[0]
      if (lane?.state === 'released') {
        throw new Error('This lane was released. Open a new isolated Seat.')
      }
      return lane?.browserProfile ?? 'default'
    })
    if (this.#extensions) {
      this.#subscriptions.push(
        this.#extensions.subscribe((event) => this.#onExtensionEvent(event)),
      )
      // The defaults, so the kernel is never without a setting. What the
      // user actually stored is applied in `start()`, not here: `StateStore`
      // holds `{}` until `load()` has resolved, so every restore that ran in
      // this constructor was reading an empty object and quietly keeping the
      // defaults it was supposed to replace.
      this.#applyBrowserSettings()
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
    const stored = this.#storedPluginSettings('team')
    if (stored) this.#team.configure(stored as never)
  }

  /**
   * What was stored for one plugin, or null.
   *
   * Team's settings had a key of their own before every plugin's were kept,
   * so that key is still read for team — an install made before this keeps
   * the board rules it was left with.
   */
  #storedPluginSettings(id: string): Record<string, unknown> | null {
    const preferences = this.#state.state.preferences
    const all = preferences['pluginSettings']
    const mine =
      all && typeof all === 'object' && !Array.isArray(all)
        ? (all as Record<string, unknown>)[id]
        : undefined
    const stored = mine ?? (id === 'team' ? preferences['teamSettings'] : undefined)
    return stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : null
  }

  /**
   * Stored plugin settings, back into the plugins that are already loaded.
   *
   * The kernel keeps a plugin's configuration in memory only, so everything a
   * person set in Settings was gone at the next launch — the Workspace files
   * read limit among them, which meant a limit set to keep large files out of
   * the model's context was back at 64,000 bytes every morning (#258).
   * Preferences outlive the process, so they are the record and this puts it
   * back. A plugin that refuses its stored settings keeps the defaults rather
   * than taking the whole boot down with it.
   */
  async #applyPluginSettings(): Promise<void> {
    const extensions = this.#extensions
    if (!extensions) return
    for (const plugin of extensions.plugins()) {
      const stored = this.#storedPluginSettings(plugin.identity.id)
      if (!stored || Object.keys(stored).length === 0) continue
      try {
        await extensions.reconfigure(plugin.identity.id, stored)
      } catch (error) {
        this.#logger.warn('a plugin would not take its stored settings', {
          plugin: plugin.identity.id,
          error: String(error),
        })
      }
    }
  }

  /**
   * Registers a runtime. Starting it is separate and allowed to fail: a machine
   * without Codex installed should still open the app and explain itself.
   */
  register(runtime: AgentRuntime): void {
    const id = runtime.info.id
    if (this.#runtimes.has(id)) {
      this.#logger.warn('a runtime with this id was already registered; replacing it', {
        runtime: id,
      })
      for (const unsubscribe of this.#runtimeSubscriptions.get(id) ?? []) unsubscribe()
      this.#runtimeSubscriptions.delete(id)
      this.#catalogs.forget(id)
      this.#updates.delete(id)
    }
    this.#runtimes.set(id, runtime)
    this.#catalogs.watch(runtime)
    this.#runtimeSubscriptions.set(id, [
      runtime.subscribe((event) => this.#onEvent(id, event)),
      runtime.onHealthChange((health) => this.#onHealthChange(id, health)),
      // A capability the agent only reveals by refusing it. Optional, so a
      // runtime whose description is settled at construction says nothing.
      ...(runtime.onInfoChange
        ? [
            runtime.onInfoChange(() => {
              this.#push({
                method: 'runtime/infoChanged',
                params: { runtime: id, info: this.#infoOf(runtime) },
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
    binding: { meter?: UsageMeter; corpus?: CorpusSpec['kind']; root?: string },
  ): void {
    if (binding.meter) this.#meters.set(runtime, binding.meter)
    if (binding.corpus) {
      const [spec] = binding.root
        ? [{ runtime, kind: binding.corpus, root: binding.root }]
        : defaultCorpora([{ id: runtime, kind: binding.corpus }])
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
    this.#goalWriter = await acquireDeskWriter(this.#state.directory)
    await this.#state.load()
    await this.#laneStore.load()
    // Everything that restores a stored setting runs here, after the file has
    // been read, and never in the constructor. Until it did, a board left
    // holding inbound messages came back accepting them, and every plugin's
    // settings came back at their defaults (#258).
    this.#applyBrowserSettings()
    this.#applyTeamSettings()
    await this.#applyPluginSettings()
    await this.#evidence.load().catch((error: unknown) => {
      this.#logger.error('the Seat records this desk keeps could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    await migrateDesk(
      this.#state.directory,
      (seats) => importMigrationSeats(seats, this.#evidence.seats),
    ).catch((error: unknown) => {
      this.#logger.error('the rooms could not be loaded', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    })
    await this.#goalStore.load()
    await this.#recoverGoalMail()
    this.#goalsReady = true
    await this.#goals.recover()
    /* Let through, unlike the runs below: rooms that cannot be read refuse
       the launch. Degraded, this desk would come up with no rooms, and the
       rest of it would believe that — `Flows.load` stops every running run
       whose room it cannot find, on disk — while nothing on screen could say
       otherwise, because the team hangs its problems on a room. The shell
       answers a start that rejects with "could not start" and the sentence
       `Team.load` wrote: the folder, the reason, and what to do. Recorded
       first, so a diagnostics bundle carries it too. */
    await this.#team.load().catch((error: unknown) => {
      this.#logger.error('the rooms could not be loaded', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    })
    for (const view of await this.#goals.list()) {
      this.#team.installProjection(view.board, this.#goalStore.read(view.goal.id).legacy?.roster)
    }
    /* After the rooms, because a run reconciles against the board it left
       behind: a quit between the last card of a round finishing and the next
       round opening is a run that has to be asked, on this launch, whether
       its board moved on without it.

       And caught, not let through: a folder of runs that will not open costs
       flows, not the desk. Let through, it would cost every conversation and
       every room — the shell answers a start that rejects with "could not
       start" and quits — the way one silent runtime once held the whole app
       shut. The engine keeps the reason and refuses to start a flow with it,
       which is where somebody meets it; this line is the record. */
    await this.#flows.load().catch((error: unknown) => {
      this.#logger.error('the flow runs this desk keeps could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    // Read before anything can be listed: `nameOf` answers synchronously, so
    // a room built before the file was read would show every conversation
    // wearing its agent's name and settle only on the next refresh.
    await this.#names.load()
    /* Before any runtime starts, so the first conversation listed already
       wears the Agent its Seat record names. Caught like the flow runs above:
       records that cannot be read cost the restored names, not the desk. */
    /* From here on a file changed under any of the roster's roots is one
       notice to every window. Guarded on `#disposed`: everything above this
       point can yield, and a quit landing in one of those gaps must find no
       watch here to leak — `dispose()` cannot close what `start()` has not
       made yet, and does not run again once it has. */
    if (!this.#disposed) {
      this.#agentWatch = new AgentWatch({
        roots: [this.#agents.roots.user, this.#agents.roots.builtin],
        changed: (project) => this.#push({ method: 'agent/changed', params: { project } }),
        log: (message, details) => this.#logger.warn(message, details),
      })
      /* Not awaited: nothing below needs the watch pointed at open projects
         yet, and pointing it asks git once per remembered folder. Awaited
         here, a window's first listing on a stalled volume or a checkout with
         many linked worktrees would wait behind every one of those probes
         before any runtime could start. */
      void this.#watchProjects().catch((error: unknown) => {
        this.#logger.warn('could not point the roster watch at the open projects', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
    await Promise.all([...this.#runtimes.values()].map((runtime) => this.#startOne(runtime)))
    /* And only now wake what stopped while the desk was down. Reconciling a
       run's rounds is board work and belongs above; *sending* to a seat needs
       the agent that holds it to be running, and asking a moment too early
       answers "Cursor is not running" for every seat of every flow. */
    void this.#flows.resume()
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
    // Set before anything below can yield: see the guard where `start()` makes the roster's watch.
    this.#disposed = true
    this.#catalogs.stop()
    this.#agentWatch?.dispose()
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
    /* Every seat parked inside `await_work` is a tool call held open, and a
       held tool call across a quit is a turn that never ends. */
    this.#team.stopWaiting('the desk is closing')
    await this.#flows.flush()
    await this.#team.flush()
    await this.#evidence.close()
    await this.#goalStore.flush()
    await this.#goalWriter?.release()
    this.#goalWriter = null
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
    this.#noteReach(params)
    // Validated by the wire layer against the same table the handler's type
    // reads from; see `methods/index.ts` for what the table guarantees.
    return dispatch(this.#context, method, params)
  }

  /**
   * A window asked something of one conversation. When a seating holds it, the
   * seating may no longer delete it (`#discardSeat`) — and once the seating is
   * past the point of no return, the ask is refused rather than let start on a
   * conversation that is going.
   *
   * Here, at the one door every window's request comes through, and before the
   * request does anything: a read, a reopen or a message still on its way when
   * a discard decides is one the discard has already heard of. Everything that
   * names a conversation counts — a person who opened it is about to use it,
   * and an empty conversation kept is a smaller mistake than a used one
   * deleted.
   */
  #noteReach(params: unknown): void {
    if (this.#seating.size === 0 || typeof params !== 'object' || params === null) return
    const { runtime, sessionId } = params as { readonly runtime?: unknown; readonly sessionId?: unknown }
    if (typeof runtime !== 'string' || typeof sessionId !== 'string') return
    const inHand = this.#seating.get(sessionKey(runtime, sessionId))
    if (!inHand) return
    if (inHand.removing) {
      throw new SessionGoneError(
        'This conversation was opened for a seat that was passed over, and it is being removed.',
      )
    }
    inHand.reached = true
  }


  // ------------------------------------------------------------------ private

  #lanePreferences() {
    return lanePreferences(Object.hasOwn(this.#state.state.preferences, 'lanes')
      ? this.#state.state.preferences['lanes']
      : DEFAULT_LANE_PREFERENCES)
  }

  #goalState(id: string): TeamState {
    const document = this.#goalStore.read(id)
    return {
      id,
      name: document.goal.sentence,
      updatedAt: document.goal.updatedAt,
      root: document.goal.root,
      ...(document.goal.cwd === document.goal.root ? {} : { cwd: document.goal.cwd }),
      members: [],
      intents: document.board.intents,
      channel: document.board.channel,
      messaging: document.board.messaging,
      nicknames: document.legacy?.nicknames ?? {},
      roles: {},
      plans: document.legacy?.plans ?? [],
      problem: this.#goalStore.problem,
    }
  }

  /** A room created by an older live caller becomes a Goal before a legacy flow seats into it. */
  async #ensureGoalFromTeam(id: string): Promise<void> {
    try {
      this.#goalStore.read(id)
      return
    } catch {
      // Continue only when the compatibility Team really owns this id.
    }
    if (!this.#team.hasRoom(id)) throw new Error('That Goal is not on this desk.')
    const state = this.#team.stateFor(id)
    const at = state.updatedAt || Date.now()
    await this.#goalStore.save({
      version: 1,
      goal: {
        id,
        root: state.root,
        cwd: state.cwd ?? state.root,
        sentence: state.name || 'Imported work',
        state: 'open',
        revision: 0,
        checkout: 'shared',
        dependsOn: [],
        origin: { kind: 'legacy', source: 'live-room' },
        createdAt: at,
        updatedAt: at,
        receipt: null,
      },
      board: {
        nextIntent: Math.max(1, ...state.intents.map((intent) => intent.id + 1)),
        messaging: state.messaging,
        intents: state.intents,
        channel: state.channel,
      },
      citations: [],
      receipt: null,
      operation: null,
    }, null)
  }

  async #saveTeamProjection(state: TeamState): Promise<void> {
    await this.#syncProjectionSeats(state)
    const legacy = this.#team.legacyFor(state.id)
    let document: GoalDocument
    try {
      document = this.#goalStore.read(state.id)
    } catch {
      const at = state.updatedAt || Date.now()
      await this.#goalStore.save({
        version: 1,
        goal: {
          id: state.id,
          root: state.root,
          cwd: state.cwd ?? state.root,
          sentence: state.name || 'Imported work',
          state: 'open',
          revision: 0,
          checkout: 'shared',
          dependsOn: [],
          origin: { kind: 'legacy', source: 'live-room' },
          createdAt: at,
          updatedAt: at,
          receipt: null,
        },
        board: {
          nextIntent: Math.max(1, ...state.intents.map((intent) => intent.id + 1)),
          messaging: state.messaging,
          intents: state.intents,
          channel: state.channel,
        },
        legacy: {
          source: 'live-room',
          plans: legacy.plans,
          nicknames: legacy.nicknames,
          roster: legacy.roster,
          sourceSha256: createHash('sha256').update(state.id).digest('hex'),
          seatLocations: {},
        },
        citations: [],
        receipt: null,
        operation: null,
      }, null)
      return
    }
    if (document.restored || document.goal.state !== 'open' || document.operation) {
      throw new Error('This Goal is read-only or is finishing an operation. Start another Goal for new work.')
    }
    const at = state.updatedAt || Date.now()
    await this.#goalStore.save({
      ...document,
      goal: {
        ...document.goal,
        sentence: state.name || document.goal.sentence,
        revision: document.goal.revision + 1,
        updatedAt: at,
      },
      board: {
        nextIntent: Math.max(1, ...state.intents.map((intent) => intent.id + 1)),
        messaging: state.messaging,
        intents: state.intents,
        channel: state.channel,
      },
      ...(document.legacy ? {
        legacy: {
          ...document.legacy,
          plans: legacy.plans,
          nicknames: legacy.nicknames,
          roster: legacy.roster,
        },
      } : {}),
    }, document.goal.revision)
  }

  async #syncProjectionSeats(state: TeamState): Promise<void> {
    const wanted = new Set(state.members.map(String))
    for (const record of this.#evidence.seats.all()) {
      if (record.board !== state.id || record.closed || record.restored) continue
      const key = String(sessionKey(record.session.runtime, record.session.sessionId))
      if (!wanted.has(key)) await this.#evidence.seats.closeId(record.id, 'released')
    }
    for (const member of state.members) {
      const { runtime, id } = splitSessionKey(member)
      const existing = this.#evidence.seats.all().some((record) => !record.closed && !record.restored &&
        record.board === state.id && record.session.runtime === runtime && record.session.sessionId === String(id))
      if (existing) continue
      const known = this.registry.get(runtime, id)?.session
      const previous = this.#evidence.seats.latestKeptOf(runtime, String(id))
      const cwd = known?.cwd ?? state.cwd ?? state.root
      const revision = await revisionOf(cwd)
      const opening: SeatOpening = {
        id: `legacy-${createHash('sha256').update(JSON.stringify([state.id, member])).digest('hex')}`,
        agent: previous?.agent ?? null,
        briefDigest: previous?.briefDigest ?? null,
        seat: previous?.seat ?? { runtime },
        seatLabel: previous?.seatLabel ?? runtime,
        passedOver: previous?.passedOver ?? [],
        standing: previous?.standing ?? { kind: 'unknown' },
        ceiling: previous?.ceiling ?? null,
        checkout: {
          cwd,
          project: state.root,
          branch: revision?.branch ?? null,
          head: revision?.head ?? null,
        },
        session: { runtime, sessionId: String(id) },
        board: state.id,
        role: state.roles?.[String(member)] ?? null,
        openedAt: state.updatedAt || Date.now(),
      }
      await this.#evidence.seats.importOpening(state.root, opening)
    }
  }

  async #recoverGoalMail(): Promise<void> {
    for (const document of this.#goalStore.list()) {
      if (document.restored || document.goal.state === 'wrapped') continue
      let changed = false
      const channel = document.board.channel.map((entry) => {
        if (entry.kind !== 'message' || entry.state !== 'queued') return entry
        changed = true
        return {
          ...entry,
          state: 'refused' as const,
          reason: 'The desk restarted before the message was delivered.',
        }
      })
      if (!changed) continue
      await this.#goalStore.save({
        ...document,
        board: { ...document.board, channel },
        goal: { ...document.goal, revision: document.goal.revision + 1 },
      }, document.goal.revision)
    }
  }

  #goalClaimable(goal: string, card: number, runtime: string, sessionId: string): boolean {
    const board = this.#goalStore.read(goal).board
    const intent = board.intents.find((one) => one.id === card)
    if (!intent || intent.state === 'done' || intent.state === 'abandoned' ||
      intent.state === 'claimed' && !(intent.claim?.runtime === runtime && intent.claim.sessionId === sessionId) ||
      intent.state === 'blocked' && intent.blockedBy === 'hand') return false
    const waits = intent.dependsOn.some((id) => {
      const dependency = board.intents.find((one) => one.id === id)
      return dependency !== undefined && dependency.state !== 'done'
    })
    if (waits) return false
    return !board.intents.some((one) =>
      one.id !== card && one.state === 'claimed' && one.claim?.runtime === runtime && one.claim.sessionId === sessionId,
    )
  }

  #goalStranded(goal: string, card: number): boolean {
    const intent = this.#goalStore.read(goal).board.intents.find((one) => one.id === card)
    if (intent?.state !== 'claimed' || !intent.claim?.leaseUntil || Date.now() < intent.claim.leaseUntil) return false
    return this.registry.get(intent.claim.runtime, makeSessionId(intent.claim.sessionId)) === undefined
  }

  async #claimGoalCard(goal: string, card: number, opening: SeatOpening): Promise<void> {
    const document = this.#goalStore.read(goal)
    const current = document.board.intents.find((one) => one.id === card)
    if (!current) throw new Error('Choose an existing card.')
    if (current.state === 'claimed' && current.claim?.runtime === opening.session.runtime &&
      current.claim.sessionId === opening.session.sessionId) return
    if (!this.#goalClaimable(goal, card, opening.session.runtime, opening.session.sessionId)) {
      throw new Error('This card cannot be assigned now. Resolve its dependency, role or file conflict first.')
    }
    const at = Date.now()
    const intents = document.board.intents.map((intent) => intent.id === card ? {
      ...intent,
      state: 'claimed' as const,
      claim: { runtime: opening.session.runtime as RuntimeId, sessionId: opening.session.sessionId, at },
      updatedAt: at,
      blockedBy: null,
      blockedReason: null,
    } : intent)
    await this.#goalStore.save({
      ...document,
      board: { ...document.board, intents },
      goal: { ...document.goal, revision: document.goal.revision + 1, updatedAt: at },
    }, document.goal.revision)
  }

  async #releaseGoalCard(goal: string, seat: SeatId): Promise<void> {
    const record = this.#evidence.seats.byId(seat)
    if (!record) return
    const document = this.#goalStore.read(goal)
    const held = document.board.intents.find((intent) => intent.state === 'claimed' &&
      intent.claim?.runtime === record.session.runtime && intent.claim.sessionId === record.session.sessionId)
    if (!held) return
    const blocked = held.dependsOn.some((id) => {
      const dependency = document.board.intents.find((one) => one.id === id)
      return dependency !== undefined && dependency.state !== 'done'
    })
    const at = Date.now()
    const intents = document.board.intents.map((intent) => intent.id === held.id ? {
      ...intent,
      state: blocked ? 'blocked' as const : 'open' as const,
      claim: null,
      blockedBy: blocked ? 'graph' as const : null,
      blockedReason: null,
      updatedAt: at,
    } : intent)
    await this.#goalStore.save({
      ...document,
      board: { ...document.board, intents },
      goal: { ...document.goal, revision: document.goal.revision + 1, updatedAt: at },
    }, document.goal.revision)
  }

  async #finishGoalOperation(goal: string, operation: string): Promise<void> {
    const document = this.#goalStore.read(goal)
    if (document.operation === null) return
    if (document.operation.id !== operation) throw new Error('Another Goal operation replaced this one. Finish recovery first.')
    await this.#goalStore.save({
      ...document,
      operation: null,
      goal: { ...document.goal, revision: document.goal.revision + 1, updatedAt: Date.now() },
    }, document.goal.revision)
  }

  async #goalAnswer(seat: SeatRecord): Promise<{
    readonly answer: GoalReceipt['answers'][number] | null
    readonly gaps: readonly string[]
  }> {
    const runtime = this.#runtimes.get(seat.session.runtime)
    if (!runtime) return { answer: null, gaps: [`${seat.seatLabel}'s transcript is unavailable.`] }
    let session: Session
    try {
      session = await this.#read(runtime, makeSessionId(seat.session.sessionId))
    } catch {
      return { answer: null, gaps: [`${seat.seatLabel}'s transcript is unavailable.`] }
    }
    const turn = session.turns.at(-1)
    const raw = turn?.items.filter((item) => item.type === 'assistantMessage')
      .map((item) => (item as { readonly text?: string }).text ?? '')
      .filter((text) => text.trim() !== '').at(-1) ?? ''
    const clipped = raw.length <= 16_000 ? raw : `${raw.slice(0, 7_990)}\n… answer truncated …\n${raw.slice(-7_989)}`
    const partial = turn !== undefined && turn.status !== 'completed'
    const gaps = [
      ...(raw ? [] : [`${seat.seatLabel} has no recorded answer.`]),
      ...(raw.length > 16_000 ? [`${seat.seatLabel}'s answer was truncated to 16000 characters.`] : []),
      ...(partial ? [`${seat.seatLabel}'s last answer was partial (${turn.status}).`] : []),
      ...(session.usage === null || session.usage === undefined
        ? [`${seat.seatLabel}'s spend was not recorded.`]
        : session.usage.total.outputExact === false
          ? [`${seat.seatLabel}'s output spend is a lower bound.`]
          : []),
    ]
    return {
      answer: {
        seat: seat.id,
        session: seat.session,
        turn: turn ? String(turn.id) : null,
        text: clipped,
        partial,
        stopReason: !turn || turn.status === 'completed' ? null : (turn.error?.message ?? turn.status),
      },
      gaps,
    }
  }

  async #finishGoalWrap(operation: Extract<GoalOperation, { kind: 'wrap' }>): Promise<void> {
    const document = this.#goalStore.read(operation.goal)
    if (document.operation === null && document.receipt?.id === operation.receipt.id) return
    if (document.operation?.kind !== 'wrap' || document.operation.id !== operation.id ||
        document.operation.receipt.id !== operation.receipt.id) {
      throw new Error('Another Goal operation replaced this wrap. Finish recovery first.')
    }
    const resolutions = new Map(operation.receipt.cards.map((card) => [card.id, card]))
    const at = operation.receipt.wrappedAt
    const board = {
      ...document.board,
      intents: document.board.intents.map((intent) => {
        const resolution = resolutions.get(intent.id)
        if (!resolution) throw new Error(`Receipt ${operation.receipt.id} has no disposition for card ${intent.id}.`)
        return {
          ...intent,
          state: resolution.resolution === 'finished' ? 'done' as const : 'abandoned' as const,
          claim: null,
          blockedBy: null,
          blockedReason: null,
          ...(resolution.reason?.trim() ? { note: resolution.reason.trim() } : {}),
          updatedAt: at,
        }
      }),
    }
    await this.#goalStore.save({
      ...document,
      board,
      receipt: operation.receipt,
      operation: null,
      goal: {
        ...document.goal,
        state: 'wrapped',
        receipt: operation.receipt.id,
        revision: document.goal.revision + 1,
        updatedAt: at,
      },
    }, document.goal.revision)
    this.#team.closeGoalWaits(operation.goal)
    try {
      const view = await this.#goals.view(operation.goal)
      this.#team.installProjection(view.board, this.#goalStore.read(operation.goal).legacy?.roster)
      this.#push({ method: 'goal/changed', params: { view } })
    } catch (error) {
      this.#logger.warn('a wrapped Goal could not be announced after its receipt was stored', {
        goal: operation.goal,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

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
      flows: this.#flows,
      goals: this.#goals,
      lanes: this.#lanes,
      laneSettings: {
        read: () => this.#lanePreferences(),
        set: async (value) => {
          const checked = lanePreferences(value)
          await this.#state.setPreferences({ lanes: checked })
          return checked
        },
      },
      laneEnvironment: {
        forCheckout: (cwd) => environmentForCheckout(cwd, this.#lanes.list()),
        forSession: async (runtime, sessionId) => {
          const owner = this.#runtime({ runtime })
          const environment = environmentForSession(
            String(owner.info.id),
            sessionId,
            this.#lanes.list(),
            this.#evidence.seats.all(),
          )
          requireLaneSupport(owner.info, environment)
          return environment
        },
      },
      agents: this.#agents,
      seating: this.#machineSeating,
      evidence: this.#evidence,
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
          { log: (message, details) => this.#logger.warn(message, details) },
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
      seats: {
        open: (seat, where) => this.#openSeat(seat, where),
        order: (runtime, sessionId, text) => this.#orderSeat(runtime, sessionId, text),
        retire: (runtime, sessionId) => this.#retireSeat(runtime, sessionId),
        discard: (runtime, sessionId) => this.#discardSeat(runtime as RuntimeId, makeSessionId(sessionId)),
        recordAgent: (runtime, sessionId, seated) => {
          // Kept: the seating's hold ends, and the conversation is the Agent's (`#seating`).
          this.#seating.delete(sessionKey(runtime, sessionId))
          const record = this.registry.seatAs(runtime as RuntimeId, makeSessionId(sessionId), seated)
          // Every window holding this conversation learns it, not only the one that asked.
          if (record.session.settings) {
            this.#push({
              method: 'event',
              params: {
                runtime: record.runtime,
                event: { type: 'session/settings', sessionId: record.session.id, settings: record.session.settings },
              },
            })
          }
          return record.session
        },
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
        fileRoots: (mode) => this.#fileRoots(mode),
        confineGitRoot: (root) => this.#confineGitRoot(root),
        topLevel: (path) => gitOps.topLevel(path),
        confineRoom: (folder) => this.#confineRoom(folder),
        open: (path) => this.#openWorkspace(path),
        repoOf: (cwd) => this.#repoOf(cwd),
        boardRootOf: (cwd) => this.#boardRootOf(cwd),
        forgetBoardRoots: () => {
          this.#boardRoots.clear()
          this.#topLevels.clear()
          // The same moment the roster's watch lets go of a project that is no longer open.
          void this.#watchProjects()
        },
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

  readonly #localFiles = new LocalFiles({ log: (message, details) => this.#logger.warn(message, details) })

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
   *
   * Only those spelled absolutely. Every check that holds a path to these —
   * `confine`, `#confineGitRoot`, `openRepositoryRoot` — reads a relative one
   * against this process's working directory, which is no folder anybody
   * opened. The wire refuses one before it can become a root, but a
   * conversation's cwd is whatever its agent reports, and one read or reopened
   * from the agent's store carries the folder the agent wrote down; the
   * workspaces come back from the state file.
   */
  #openRoots(): string[] {
    return [
      ...this.#state.state.workspaces
        .map((entry) => entry?.path)
        .filter((path): path is string => typeof path === 'string' && isAbsolute(path)),
      ...this.registry.snapshot()
        .map((session) => session.cwd)
        .filter((cwd): cwd is string => typeof cwd === 'string' && isAbsolute(cwd)),
    ]
  }

  /**
   * Where the renderer may read or write a file by path: the open roots, and
   * the roster's own folders — this machine's for both, because a person
   * edits their own Agents in the desk's editor; the built-in one for reading
   * only, because nobody edits what ships (*Customize…* copies it first).
   * `confine` compares path text by design, so a user Agent folder linked to a
   * dotfiles checkout is read and saved through that link, just as the roster
   * reads it. The built-in root never joins the write list.
   */
  #fileRoots(mode: 'read' | 'write'): string[] {
    return [
      ...this.#openRoots(),
      join(this.#state.directory, 'agents'),
      ...(mode === 'read' ? [this.#agents.roots.builtin] : []),
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
    // Before anything resolves it. `realpath` reads a relative path against
    // this process's working directory, so `confine` below only ever saw an
    // absolute one and its own refusal could not fire: a relative root was
    // admitted whenever, read from wherever the app had been started, it led
    // into an open folder.
    assertAbsolute(root)
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

  /**
   * Where a room may work: in a folder opened here or in a repository opened
   * here, by the folder rule above or by the repository rule the worktree
   * verbs answer to, whichever admits it. A room's folder is where its flows
   * are read from, and where they seat agents and cut worktrees.
   *
   * The room dialog asks for both kinds. It names the project of the folder
   * open (`projectRootOf`), which for a linked worktree is its main checkout:
   * outside every open folder while only the worktree is open, so the folder
   * rule refuses it although its repository is open. And a room can be made in
   * a folder in no repository, which the repository rule has nothing to say
   * about. Neither rule admits a folder the desk does not already let the
   * renderer branch in or check out, and both see through links.
   */
  async #confineRoom(folder: string): Promise<void> {
    assertAbsolute(folder)
    if (await this.#confineGitRoot(folder).then(() => true, () => false)) return
    if ((await openRepositoryRoot(folder, this.#openRoots()).catch(() => null)) !== null) return
    // Where it leads, as the folder rule says it: a link in an open folder
    // otherwise reads as a folder inside it.
    throw new Error(
      `${await this.#realPath(folder)} is outside every folder and repository opened here. Open it first.`,
    )
  }

  /**
   * The path with its links resolved. One that is not there — yet, or any
   * more — is resolved through the deepest ancestor that is, the way a new
   * worktree's folder is. Left as it was spelled, it was compared against open
   * roots that had been resolved: a folder inside one reached through a link
   * (macOS keeps its temporary folders behind /var -> /private/var) was
   * refused as outside it, and one behind a link out of an open folder passed.
   */
  async #realPath(path: string): Promise<string> {
    try {
      return await realpath(path)
    } catch {
      return canonicalDestination(path)
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
      agentFolders: await exportAgentFolders(join(this.#state.directory, 'agents'), (message, details) =>
        this.#logger.warn(message, details),
      ),
      seating: await this.#machineSeating.raw(),
      evidence: await this.#evidence.backup(),
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

    const agentFolders = { restored: 0, skipped: 0 }
    for (const copy of Array.isArray(file.agentFolders) ? file.agentFolders : []) {
      try {
        const outcome = await importAgentFolder(join(this.#state.directory, 'agents'), copy)
        if (outcome.restored) {
          agentFolders.restored += 1
        } else {
          agentFolders.skipped += 1
          // `reason: null` is a plain collision with an Agent already here —
          // this machine's own, never a stranger's, so it stays quiet.
          if (outcome.reason !== null) {
            this.#logger.warn('an Agent folder from a backup was refused', {
              id: loggedId(backupCopyId(copy)),
              error: outcome.reason,
            })
          }
        }
      } catch (error) {
        agentFolders.skipped += 1
        this.#logger.warn('an Agent folder from a backup could not be restored', {
          id: loggedId(backupCopyId(copy)),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const seating = { restored: 0, skipped: 0 }
    let seatingRevision: number | undefined
    if (typeof file.seating === 'object' && file.seating !== null) {
      const saved = parseSeating(JSON.stringify(file.seating))
      for (const entry of saved.entries) {
        try {
          // `onlyIfAbsent` decides "is this Agent's id already taken" inside
          // `set()`'s own write queue, against the file it is about to write —
          // not from a read taken before this loop started, which a window's
          // own `agent/seating/set` landing in the gap between that read and
          // this call could otherwise have made stale.
          const outcome = await this.#machineSeating.set(entry.id, entry.seats, { onlyIfAbsent: true })
          if (outcome.wrote) {
            seating.restored += 1
            seatingRevision = outcome.seating.revision
          } else seating.skipped += 1
        } catch (error) {
          seating.skipped += 1
          this.#logger.warn('a seating entry from a backup could not be restored', {
            id: entry.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      seating.skipped += saved.problems.filter((one) => one.id !== null).length
    }
    if (agentFolders.restored > 0 || seating.restored > 0) {
      this.#push({
        method: 'agent/changed',
        params: { project: null, ...(seatingRevision === undefined ? {} : { revision: seatingRevision }) },
      })
    }
    // What the desk observed, and every Seat it kept: history, never over what this desk wrote.
    const evidence = await this.#evidence.restore(file.evidence)
    this.#logger.info('backup restored', { agents, preferences, transcripts, agentFolders, seating, evidence })
    return { agents, preferences, transcripts, agentFolders, seating, evidence }
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
        log = redactLog(raw, redact)
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
    const path = confine(entry.path, this.#fileRoots('read'))
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
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (entry): entry is ModelRouteRecord =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ModelRouteRecord).id === 'string' &&
        typeof (entry as ModelRouteRecord).name === 'string' &&
        typeof (entry as ModelRouteRecord).endpoint === 'string' &&
        typeof (entry as ModelRouteRecord).wireProtocol === 'string' &&
        typeof (entry as ModelRouteRecord).credentialRef === 'string',
    )
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
    // — which after a restart is nothing. Hand it what was stored, so the
    // settings page shows the rules in force rather than an empty form
    // beside a board that is holding messages. This covers a plugin that
    // arrives after boot; the ones loaded before `start()` — which is every
    // built-in — are caught by `#applyPluginSettings`.
    if (event.type === 'plugin/added') {
      const id = event.plugin.identity.id
      const stored = this.#storedPluginSettings(id)
      if (stored && Object.keys(stored).length > 0) {
        void this.#extensions?.reconfigure(id, stored).catch(() => undefined)
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
    // Fire-and-forget: opening a folder must not wait on re-pointing the
    // roster's watch, which walks every open project's ancestors afresh.
    void this.#watchProjects()
    return {
      ...record,
      name: described.name || basename(described.path),
      git: git ? { branch: git.branch } : null,
      // Which project this folder is, so the session list can put a worktree
      // opened as a workspace under the project it is a checkout of.
      repo: await this.#repoOf(described.path),
      // The top of *this* checkout — a linked worktree's own, where `repo`
      // above deliberately names the main one instead. `#topLevelOf` is the
      // same cached read `#watchProjects` makes for this same folder, so a
      // surface comparing against this never disagrees with what a change
      // notification names.
      checkoutRoot: await this.#topLevelOf(described.path),
    }
  }

  /**
   * Points the roster's watch at every open project: each open folder and its
   * own git top level — a project keeps its Agents at the top of its
   * repository, and a person often opens a folder inside it. `confineGitRoot`
   * admits the top level as a project for `agent/list` on the open folder's
   * account, and for a linked worktree it is that worktree's own top. The
   * main checkout `#repoOf` answers with for a linked worktree is not added:
   * `confineGitRoot` does not admit it on the worktree's account, so no Agent
   * read reaches it through the worktree. The top level is asked once per
   * folder (`#topLevelOf`).
   *
   * Called without being waited on from two places that can race each other —
   * opening a folder, and forgetting one — so every call reads its own
   * snapshot of `this.#state.state.workspaces` and asks git about it in
   * parallel (`Promise.all`, the way `#withRepos` does), and only applies what
   * it found if no later call has started since: a generation bumped on
   * entry, checked again once the asking is done. An older call finishing
   * last from a slower git probe can then only ever lose to a newer one,
   * never re-add a folder the newer call had already let go of.
   */
  async #watchProjects(): Promise<void> {
    const watch = this.#agentWatch
    if (!watch) return
    const generation = ++this.#watchGeneration
    const roots = new Set<string>()
    await Promise.all(
      this.#state.state.workspaces.map(async (entry) => {
        if (typeof entry?.path !== 'string' || entry.path === '') return
        roots.add(entry.path)
        const top = await this.#topLevelOf(entry.path)
        if (top) roots.add(top)
      }),
    )
    // Superseded while this was asking git: whatever it found is stale, and the call that made it stale already applied its own.
    if (generation !== this.#watchGeneration) return
    await watch.watchProjects([...roots])
  }

  /** A folder's git top level, asked of git once per folder until a folder is forgotten (`#topLevels`). */
  #topLevelOf(cwd: string): Promise<string | null> {
    const held = this.#topLevels.get(cwd)
    if (held) return held
    const asked = gitOps.topLevel(cwd).catch(() => null)
    this.#topLevels.set(cwd, asked)
    return asked
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
    /* A refusal that already names the agent and says what is wrong is not
       improved by being introduced. The folder-gone one is exactly that — the
       adapter writes "Cursor cannot open this conversation: its folder no
       longer exists (…)" — and wrapping it produced the sentence twice in one
       line: "Cursor could not reopen this conversation: Cursor cannot open
       this conversation: …". Passed through whole instead, which is also what
       lets a pane print the refusal in the adapter's own words. */
    if (isFolderGone(error)) return describeError(error)
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
    return target.info.presentation.name
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
      const environment = await this.#context.laneEnvironment.forSession(String(runtime.info.id), String(id))
      live = await runtime.resumeSession(id, environment ? { environment } : {})
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
        // As the registry now holds them, which is the handle's plus the Agent it was seated as.
        event: { type: 'session/settings', sessionId: id, settings: record.session.settings ?? live.settings() },
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
   *
   * Released when the sent turn's `turn/started` arrives in `#onEvent`, or when
   * `send` rejects, or when its deadline passes (#424).
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
    let released = false
    const release = () => {
      if (released) return
      released = true
      clearTimeout(deadline)
      if (this.#sendingNow.get(key) === mark) this.#sendingNow.delete(key)
    }
    const deadline = setTimeout(release, this.options.sendAcceptDeadlineMs ?? SEND_ACCEPT_DEADLINE_MS)
    try {
      const live = await this.#live({ runtime: record.runtime, sessionId: record.session.id })
      await live.send(input)
    } catch (error) {
      release()
      throw error
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

  /**
   * Conversations a seating has opened and not yet kept or let go, by session
   * key: the only conversations `#discardSeat` will ever delete, and only while
   * nobody else has had a hand in them. Entered as each is opened
   * (`#openSeat`); left when the seat is kept (a flow's `seat`, `recordAgent`),
   * retired, or discarded.
   */
  readonly #seating = new Map<string, SeatInHand>()

  /**
   * Opens a conversation on a seat, puts it on the seat's picks, and answers
   * with what it is actually running — the one way the desk opens a
   * conversation for a seat, whether a flow's role or an Agent asked for it.
   *
   * What it answers is read back from the conversation once the picks are in —
   * the runtime's report, never the request: a runtime drops a pick it has no
   * place for rather than failing (see `#applySeatPicks`), and an agent can
   * settle one on the nearest thing it has and answer without an error. What
   * to do about a difference is the caller's. A flow says it in the seat's
   * label and carries on; an Agent passes the seat over rather than keep
   * something it did not ask for.
   *
   * It answers with an open seat or with nothing open. A conversation that
   * opened and then failed on the way to being handed back is discarded here
   * (`#discardSeat`), because nothing else knows it is there to close it —
   * and a caller that goes on to open the next seat must not be leaving one
   * behind. The failure goes on exactly as it was thrown, and what the discard
   * left of the conversation is noted beside it (`leftOnFailure`).
   *
   * The seating holds what it opened until its caller keeps it or lets it go
   * (`#seating`), so that a discard can tell the conversation it opened, and
   * nobody else touched, from one it must leave alone.
   *
   * What the desk already holds on the runtime is looked at before the
   * conversation is asked for, because a runtime that answers with one of those
   * ids has handed back somebody's conversation, not a new one — with its own
   * record, name, handle and row. The seat stops there, before anything is done
   * to it: it is not attached, which would put the seating's handle over
   * theirs; not named, which would rename their conversation after the Agent;
   * and not closed, because a close is said by the conversation's id, and the
   * runtime would hear it as theirs. The failure is noted `alreadyHeld`, so the
   * seating passes the candidate over as that; a flow's seat fails in its words.
   */
  async #openSeat(
    seat: FlowSeat,
    where: {
      readonly cwd: string
      readonly title: string
      readonly environment?: Readonly<Record<string, string>>
    },
  ): Promise<OpenedSeat> {
    const runtime = this.#runtime({ runtime: seat.runtime })
    const environment = where.environment ?? environmentForCheckout(where.cwd, this.#lanes.list())
    requireLaneSupport(runtime.info, environment)
    if (environment && this.#extensions && !this.#extensions.setBrowserResolver) {
      throw new Error(
        'This extension host cannot isolate a lane browser. Choose a supported extension host or turn isolation off.',
      )
    }
    const held = new Set(
      this.registry
        .all()
        .filter((record) => record.runtime === runtime.info.id)
        .map((record) => String(record.session.id)),
    )
    let live: Awaited<ReturnType<typeof runtime.createSession>>
    try {
      live = await runtime.createSession({
        cwd: where.cwd,
        ...(environment ? { environment } : {}),
        ...(seat.model ? { model: seat.model } : {}),
        options: {
          ...(seat.effort ? { effort: seat.effort } : {}),
          ...(seat.thinking !== undefined ? { thinking: seat.thinking } : {}),
        },
      })
    } catch (error) {
      // Nothing opened, so nothing is left — said outright rather than left
      // unsaid, because an adapter that keeps one error object and throws it
      // again for the next seat would otherwise leave a stale note from
      // whatever an earlier seat's own discard left, read out here as this
      // seat's, though this seat never opened a conversation at all.
      noteLeftOnFailure(error, null)
      throw error
    }
    if (held.has(String(live.id))) {
      this.#logger.warn('a runtime answered a new seat with a conversation the desk already holds, so it was left as it is', {
        runtime: String(runtime.info.id),
        session: String(live.id),
      })
      const refused = new Error(
        `${runtime.info.presentation.name} answered with a conversation the desk already holds, not a new one`,
      )
      noteLeftOnFailure(refused, { kind: 'alreadyHeld' })
      throw refused
    }
    this.#seating.set(sessionKey(runtime.info.id, live.id), { live, reached: false, removing: false })
    try {
      const session = this.#attach(runtime, live.id, live)
      await live.setTitle(where.title).catch(() => {})
      await this.#names.set(runtime.info.id, live.id, where.title)
      await this.#applySeatPicks(live, seat)
      const ran = live.options()
      return {
        runtime: String(runtime.info.id),
        sessionId: String(session.id),
        running: runningOf(ran, live.settings()),
        label: this.#labelOf(seat.runtime, ran),
      }
    } catch (error) {
      // Passed over part-way through opening, so discarded like any other seat
      // passed over — and what that left is noted on the failure, not dropped.
      const left = await this.#discardSeat(runtime.info.id, live.id).catch((failure: unknown) => {
        this.#logger.warn('a seat lost part-way through opening could not be discarded', {
          runtime: String(runtime.info.id),
          session: String(live.id),
          error: describeError(failure),
        })
        return null
      })
      noteLeftOnFailure(error, left)
      throw error
    }
  }

  /** Hands a seated conversation its standing order: one message, and the whole job is inside its turn. */
  async #orderSeat(runtime: string, sessionId: string, text: string): Promise<void> {
    const live = await this.#teamLive(runtime as RuntimeId, sessionId)
    const environment = environmentForCheckout(live.settings().cwd, this.#lanes.list())
    await live.send([{ type: 'text', text: laneStandingOrder(text, environment) }])
  }

  /** Closes a conversation a seating opened and will not use, and lets it go — the seating's hold with it. */
  async #retireSeat(runtime: string, sessionId: string): Promise<void> {
    const id = makeSessionId(sessionId)
    this.#seating.delete(sessionKey(runtime, id))
    await this.#letGo(runtime as RuntimeId, id, this.registry.get(runtime as RuntimeId, id)?.live)
  }

  /**
   * Takes a seat a seating opened and passed over out of the world: closed,
   * let go, removed where its runtime keeps it, forgotten by the desk, and
   * dropped from every window — unless it is not the seating's alone to take.
   * Answers what it was left as, or null when nothing is left.
   *
   * Only a conversation the seating itself opened, and nobody else touched, is
   * ever deleted. It is a row in every window from its `session/started`,
   * titled with the Agent's name, for as long as the seating holds it — across
   * the title, the name, every pick and the read-back — and a person can open
   * that row and write in it. So it is looked at (`#leaveAsItIs`) before its
   * handle is touched, and once more after the seating's own handle is let go
   * and before anything that cannot be undone. One somebody had a hand in is
   * left as it is — its record, its name and its row — and so is the handle
   * they were using: one they are already in when it is passed over is not
   * closed at all, because a closed handle stops hearing its conversation
   * (Codex's close unsubscribes from the thread), and a turn running on it
   * would read as running for good, with every message after it queued behind
   * it. Only one somebody reached for while it was closing is left closed, as a
   * retired seat is. Nothing is awaited between the second look and the delete
   * being on its way, and from then on a window's request for it is refused
   * (`#noteReach`), so nothing can start on it in between.
   *
   * What "removed" means is the runtime's. One that can delete is asked to:
   * Codex erases the thread from its own history, and the Claude Code and
   * Cursor bridges move whatever their agent wrote to the Trash — for a
   * conversation that never took a message, nothing but the bridge's own
   * bookkeeping. One that cannot has no way in to its own store from here, and
   * the desk cannot tell whether it recorded a conversation nobody spoke in;
   * so it is archived — in the runtime's own archive when it has one, the
   * desk's otherwise — and keeps its name, so that if it was recorded it stays
   * out of the list and explained. One that is asked and refuses gets the same.
   *
   * The record and every window's row go before any file is touched, and each
   * file after that is a best effort of its own (`#forgetSeat`): a file that
   * will not write neither brings the rows back nor ends a seating that is
   * about to try its next candidate.
   */
  async #discardSeat(runtime: RuntimeId, id: SessionId): Promise<SeatLeft | null> {
    const key = sessionKey(runtime, id)
    const inHand = this.#seating.get(key)
    // Only a seating's own conversation is discarded; anything else is a caller's mistake, and said so.
    if (!inHand) throw new Error(`No seating holds conversation ${String(id)}, so there is none of it to discard.`)
    try {
      // Before its handle is touched: somebody already in it keeps the handle they are in it on.
      const before = this.#leaveAsItIs(inHand, runtime, id)
      if (!before) await this.#letGo(runtime, id, inHand.live)
      // And again once it is let go, for anything that reached it while it was closing. From
      // this look to the delete on its way nothing is awaited, so nothing can start on it in between.
      const leave = before ?? this.#leaveAsItIs(inHand, runtime, id)
      if (leave) {
        // Read fresh off the record rather than assumed from `before`: a
        // reopen since this seat was opened puts a *different* handle on the
        // record, which is one of `#leaveAsItIs`'s own reasons to leave
        // things as they are — and when that is why, this seating's own
        // handle was never "kept open" by anything done here, it was simply
        // superseded, which is a different fact from either "kept open" or
        // "closed".
        const record = this.registry.get(runtime, id)
        const handle = record?.live === inHand.live ? 'kept open' : record?.live ? 'replaced' : 'closed'
        this.#logger.info('a seat passed over was left as it is, not deleted', {
          runtime: String(runtime),
          session: String(id),
          why: leave.kind,
          handle,
        })
        return leave
      }
      inHand.removing = true
      const owner = this.#runtimes.get(runtime)
      if (!owner) {
        this.#logger.warn('a seat passed over could not be deleted: its runtime was gone', {
          runtime: String(runtime),
          session: String(id),
        })
      }
      // The runtime first, because whether it deleted decides what the desk keeps.
      const asked = owner ? await this.#askToDelete(owner, id) : null
      // Then out of the host's records and every window, before any file is touched.
      this.registry.delete(runtime, id)
      this.#push({ method: 'session/removed', params: { runtime, sessionId: id } })
      const left: SeatLeft | null = owner && asked ? await this.#leftAs(owner, id, asked) : { kind: 'unasked' }
      await this.#forgetSeat(runtime, id, left)
      return left
    } finally {
      this.#seating.delete(key)
    }
  }

  /**
   * Why a seat passed over must be left as it is, or null when it is the
   * seating's alone: opened by it — which `#openSeat` saw to — and touched by
   * nobody else.
   *
   * Touched is anything the desk can see: a window that asked anything of it
   * (`SeatInHand.reached`); a turn it watched start, or a message waiting for
   * it, on its record; a send, a queue or a reopen still on its way; a handle on
   * its record other than the one the seating opened. A turn that started some
   * other way than a window asking — a room's post, say — is on the record too.
   */
  #leaveAsItIs(inHand: SeatInHand, runtime: RuntimeId, id: SessionId): SeatLeft | null {
    const key = sessionKey(runtime, id)
    const record = this.registry.get(runtime, id)
    const touched =
      inHand.reached ||
      this.#sendingNow.has(key) ||
      this.#draining.has(key) ||
      this.#reattaching.has(key) ||
      (record !== undefined &&
        (record.session.turns.length > 0 ||
          record.watched.size > 0 ||
          record.queue.messages.length > 0 ||
          (record.live !== null && record.live !== inHand.live)))
    return touched ? { kind: 'inUse' } : null
  }

  /**
   * Asks a passed-over seat's runtime to delete it where it keeps it: deleted;
   * `cannot`, for a runtime with no delete to ask; or refused, in its words.
   * What the desk does about one still there is its caller's (`#archiveSeat`).
   */
  async #askToDelete(owner: AgentRuntime, id: SessionId): Promise<'deleted' | 'cannot' | { readonly refused: string }> {
    if (!owner.info.capabilities.deleteHistory) return 'cannot'
    try {
      await owner.deleteSession(id)
      return 'deleted'
    } catch (error) {
      this.#logger.warn('a seat passed over could not be deleted where its runtime keeps it, so it is archived instead', {
        runtime: String(owner.info.id),
        session: String(id),
        error: describeError(error),
      })
      return { refused: describeError(error) }
    }
  }

  /**
   * What a passed-over seat is left as, once its runtime has answered: nothing
   * when it deleted it; otherwise out of the list (`#archiveSeat`) and said to
   * be — `kept` by a runtime with no delete, `undeleted` by one that refused.
   */
  async #leftAs(
    owner: AgentRuntime,
    id: SessionId,
    asked: 'deleted' | 'cannot' | { readonly refused: string },
  ): Promise<SeatLeft | null> {
    if (asked === 'deleted') return null
    const archived = await this.#archiveSeat(owner, id)
    return asked === 'cannot' ? { kind: 'kept', archived } : { kind: 'undeleted', detail: asked.refused, archived }
  }

  /**
   * Puts a passed-over seat the desk could not delete out of the list, the way
   * `session/archive` does: in the runtime's own archive when it keeps one, the
   * desk's otherwise, never both. Answers where — or that it could not.
   */
  async #archiveSeat(owner: AgentRuntime, id: SessionId): Promise<SeatArchived> {
    try {
      if (owner.info.capabilities.archiveHistory) {
        await owner.archiveSession(id, true)
        return 'runtime'
      }
      await this.#archive.set(owner.info.id, id, true)
      return 'here'
    } catch (error) {
      this.#logger.warn('a seat passed over could not be archived', {
        runtime: String(owner.info.id),
        session: String(id),
        error: describeError(error),
      })
      return 'failed'
    }
  }

  /**
   * What the desk keeps about a passed-over seat, let go of once the seat is
   * out of the registry and every window: its transcript, always; its archive
   * mark and its name only once it is gone where its runtime keeps it — one
   * that may still be listed keeps both, so it stays hidden and explained. Each
   * is a best effort of its own, logged when it fails.
   */
  async #forgetSeat(runtime: RuntimeId, id: SessionId, left: SeatLeft | null): Promise<void> {
    const forgets: [string, () => Promise<void>][] = [['transcript', () => this.#transcripts.forget(runtime, id)]]
    if (left === null) {
      forgets.push(['archive mark', () => this.#archive.forget(runtime, id)], ['name', () => this.#names.forget(runtime, id)])
    }
    for (const [what, forget] of forgets) {
      try {
        await forget()
      } catch (error) {
        this.#logger.warn('a seat passed over could not be forgotten everywhere', {
          runtime: String(runtime),
          session: String(id),
          what,
          error: describeError(error),
        })
      }
    }
  }

  /**
   * Closes one handle, and lets the host's record of it go as `session/close`
   * does: nothing it was waiting to be asked, and no live handle kept on it.
   *
   * A handle is not gone because it was closed. Over ACP closing is no call at
   * all — dropping the handle is the whole gesture — so a record still holding
   * one is a conversation the desk would go on routing turns to, and a room
   * would go on counting. Only the handle that was closed is let go: one a
   * reopen put there in the meantime is somebody else's.
   */
  async #letGo(runtime: RuntimeId, id: SessionId, live: AgentSession | null | undefined): Promise<void> {
    await live?.close().catch(() => {})
    const record = this.registry.get(runtime, id)
    if (!record) return
    record.approvals.clear()
    if (live && record.live === live) {
      record.live = null
      record.detached = false
    }
  }

  /**
   * Puts one conversation on the model, effort and switches a seat asked for.
   * What it is *actually* running afterwards is read back by the caller, from
   * the conversation — `#openSeat`, and a flow's re-arm.
   *
   * Read back rather than assumed, because a runtime drops a pick it declines
   * rather than failing — a seat that believes it is running at an effort it
   * is not is a seat with an unchecked claim on it, and a review signed with
   * that claim is a review that lies about who wrote it. A pick that fails is
   * logged and the rest still go on: whether that is fatal is the caller's.
   *
   * Applied at seating **and before every re-arm**. A bridge that restarts
   * holds no session state, so a conversation it reopens comes back on the
   * agent's own default: measured after a desk restart, a re-armed Gemini
   * seat billed as `default` — Cursor's Auto.
   *
   * A switch nobody asked for is turned *off*, not inherited. Picks persist
   * per agent on a desk, so the last seat's thinking switch is the next one's
   * default: twice the price of every round trip, under a line nobody wrote.
   */
  async #applySeatPicks(
    live: Awaited<ReturnType<AgentRuntime['createSession']>>,
    seat: { runtime: string; model?: string | null; effort?: string | null; thinking?: boolean },
  ): Promise<void> {
    for (const [id, value] of Object.entries({
      ...(seat.model ? { model: seat.model } : {}),
      ...(seat.effort ? { effort: seat.effort } : {}),
      ...(seat.thinking !== undefined ? { thinking: seat.thinking } : {}),
    })) {
      const option = live.options().find((one) => one.id === id)
      if (!option || String(option.currentValue) === String(value)) continue
      await live.setOption(id, value as never).catch((error: unknown) => {
        this.#logger.warn('a flow seat could not take a pick', {
          runtime: seat.runtime,
          option: id,
          value: String(value),
          error: describeError(error),
        })
      })
    }
    for (const id of ['thinking', 'fast', 'max-mode']) {
      if (id === 'thinking' && seat.thinking !== undefined) continue
      const option = live.options().find((one) => one.id === id)
      if (!option || option.disabled || option.currentValue !== true) continue
      await live.setOption(id, false).catch((error: unknown) => {
        this.#logger.warn('a flow seat inherited a switch it could not turn off', {
          runtime: seat.runtime,
          option: id,
          error: describeError(error),
        })
      })
    }
  }

  /**
   * What a seat is running, as the desk says it: the runtime, the model and
   * the effort by the labels the runtime gives them, and `thinking` when it
   * is on — from the controls as they stand, not as they were asked for.
   */
  #labelOf(runtime: string, ran: readonly ConfigOption[]): string {
    return [
      this.#runtimes.get(runtime)?.info.presentation.name ?? runtime,
      ...['model', 'effort'].map((id) => {
        const option = ran.find((one) => one.id === id)
        if (!option) return null
        const choice =
          option.type === 'select'
            ? option.choices.find((one) => String(one.value) === String(option.currentValue))
            : undefined
        return choice?.label ?? (option.currentValue == null ? null : String(option.currentValue))
      }),
      ran.find((one) => one.id === 'thinking')?.currentValue === true ? 'thinking' : null,
    ]
      .filter((one): one is string => Boolean(one))
      .join(' · ')
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
    if (event.type === 'turn/started' && record) {
      this.#sendingNow.delete(recordKey(record))
    }
    let outgoing: AgentEvent = event
    /* Which Agent a conversation was seated as is the host's to say. A runtime
       re-announcing its settings, or its whole session, knows nothing of it —
       or echoes back what a renderer patched in — and a window folding that
       event would lose the record the host kept, or take one it never made.
       So it goes out as the host holds it (`seatedSettings`). */
    if (event.type === 'session/settings') {
      const settings = seatedSettings(event.settings, record?.seatedAs ?? null)
      if (settings !== event.settings) outgoing = { ...event, settings }
    }
    if (event.type === 'session/started') {
      const session = seatedSession(event.session, record?.seatedAs ?? null)
      if (session !== event.session) outgoing = { ...event, session }
    }
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
          ? { turn: String(event.turn.id), ...(answer ? { answer } : {}), ...(failure ? { failure } : {}) }
          : undefined,
      )
      /* A seat of a running flow has exactly one turn, and it is meant to
         outlive the run. When one ends anyway — the model decided it was
         finished, a usage window ran out, a harness refused the next call —
         the flow stalls silently: cards stay open, nobody is waiting on them,
         and the only sign is a room that stopped moving. So the seat is
         handed its order again. Budgeted, because a seat that cannot start is
         a seat that would otherwise be re-armed forever. */
      void this.#flows.reArm(runtime, String(event.sessionId))
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
        model: sessionModel(record.session),
        /* A conversation seated as an Agent is called that in a room. */
        ...(record.seatedAs ? { seatedAs: record.seatedAs.name } : {}),
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
    const rules = Array.isArray(raw)
      ? raw.filter(
          (entry): entry is PolicyRule =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as PolicyRule).id === 'string' &&
            typeof (entry as PolicyRule).name === 'string' &&
            typeof (entry as PolicyRule).match === 'object' &&
            (entry as PolicyRule).match !== null &&
            ((entry as PolicyRule).action === 'approve' || (entry as PolicyRule).action === 'deny'),
        )
      : []
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
      // Both async rejections and synchronous throws from the runtime responder
      // are caught and safely degrade to surfacing human approval.
      void Promise.resolve()
        .then(() => live.respondToApproval(approval.id, { type: 'option', optionId: option.id }))
        .catch((error: unknown) => {
          this.#logger.warn('failed to auto-decide approval by policy, falling back to human approval', {
            runtime,
            approvalId: approval.id,
            error: error instanceof Error ? error.message : String(error),
          })
          const approvalEvent: AgentEvent = { type: 'approval/requested', approval }
          this.registry.apply(runtime, approvalEvent)
          this.#audit.record(runtime, approvalEvent, (sessionId) =>
            this.registry.get(runtime, makeSessionId(sessionId))?.session.cwd,
          )
          this.#push({
            method: 'event',
            params: {
              runtime,
              event: approvalEvent,
            },
          })
        })
      // The policy auto-decision is recorded synchronously so that client queries
      // immediately observe the decision rule matching the action. In the degraded
      // edge case where the agent session/transport rejects or throws, the catch
      // block logs a warning, falls back to surfacing approval/requested to the
      // client, and places the approval back in the registry.
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
      throw new Error(`${of.info.presentation.name} cannot hold more than one account here.`)
    }
    // The key goes to the broker on the way past and is never held here: what
    // the slot records, and all anything else can ask for, is the reference.
    const spec = gateway
      ? {
          name: gateway.name,
          endpoint: gateway.endpoint,
          credentialRef: await this.#credentials.store(`${gateway.name} key`, gateway.apiKey, { kind: 'gateway' }),
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
      throw new Error(`${runtime.info.presentation.name} is this agent's original account and cannot be removed.`)
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
   * Stamps every row with the repository its folder belongs to and whether
   * its folder is gone from disk.
   *
   * Grouping the session list needs this and the agents cannot supply it:
   * one of them reports a git remote and the rest report nothing, so a
   * conversation an ACP agent had in a worktree had no way to say which
   * project it was about and became a project of its own. The host is the one
   * party that can ask git, so it does — once per folder, cached.
   *
   * The existence check marks conversations whose folder was deleted before
   * anything clicks them (#294). Fresh on every listing — 40 folders in
   * parallel take ~0.24ms, so no cache is kept.
   */
  async #withRepos(page: Page<SessionSummary>): Promise<Page<SessionSummary>> {
    const folders = [...new Set(page.data.map((row) => row.cwd))]
    const [repos, existence] = await Promise.all([
      Promise.all(folders.map(async (cwd) => [cwd, await this.#repoOf(cwd)] as const)),
      Promise.all(folders.map(async (cwd) => [cwd, await isDirectory(cwd)] as const)),
    ])
    const repoMap = new Map(repos)
    const existsMap = new Map(existence)
    return {
      ...page,
      data: page.data.map((row) => {
        const repo = repoMap.get(row.cwd) ?? null
        const gone = !existsMap.get(row.cwd)
        return {
          ...row,
          repo,
          ...(gone ? { folderGone: true } : {}),
        }
      }),
    }
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

  /**
   * The version a runtime is shown with: its own, or — for a direct agent
   * (no drives) whose self-reported version is missing or a placeholder —
   * the one the install service chose (#354). The update advisory is
   * measured against this same number, so the notice never argues with the
   * build line above it.
   */
  #versionOf(runtime: AgentRuntime): string | null | undefined {
    const info = runtime.info
    const placeholder =
      info.version === null ||
      info.version === undefined ||
      /^(?:0\.0\.0(?:-dev)?|dev|unknown)$/i.test(info.version.trim())
    if (info.drives || !placeholder) return info.version
    return this.options.installs?.last(String(info.id))?.chosen?.version ?? info.version
  }

  #infoOf(runtime: AgentRuntime): RuntimeInfo {
    const catalogCheckedAt = this.#catalogs.lastChecked(runtime.info.id)
    const accounts = this.options.accounts
    const slot = accounts?.slotOf(runtime.info) ?? null
    const install = this.options.installs?.last(String(runtime.info.id))
    const info = runtime.info
    const version = this.#versionOf(runtime)
    const update = this.#updateFor(runtime, version)

    return {
      ...info,
      ...(version !== info.version ? { version } : {}),
      ...(update ? { update } : {}),
      ...(catalogCheckedAt !== null ? { catalogCheckedAt } : {}),
      // What the install service last found for this agent: every copy on
      // the machine and the one that answers. Only for agents it knows.
      ...(install ? { install } : {}),
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
   * The advisory for the version a runtime is shown with, or null.
   *
   * Only ever one measured against that version. A runtime moves while the
   * app is open — "Refresh models" restarts an idle one onto a build it
   * finds on disk, and an app-server can come back up on a new binary — and
   * an advisory measured before the move is about a build that has gone: it
   * once put "Codex 0.155.0 is available" under "Codex 0.155.0". So a
   * version that has not been measured shows nothing, and is measured now;
   * `#checkForUpdate` tells open windows when the answer differs from what
   * they were shown.
   */
  #updateFor(runtime: AgentRuntime, version: string | null | undefined): RuntimeUpdate | null {
    if (!this.options.updates) return null
    const known = this.#updates.get(runtime.info.id)
    if (known?.against === (version ?? null)) return known.update
    void this.#checkForUpdate(runtime)
    return null
  }

  /**
   * Measures a runtime's advisory against the version it is shown with, and
   * tells connected clients when the answer changes what they were shown.
   * Runs after `start()` resolves and whenever that version moves, never on
   * a critical path: an offline machine must not wait on a registry to open
   * a window.
   */
  async #checkForUpdate(runtime: AgentRuntime): Promise<void> {
    const updates = this.options.updates
    const id = runtime.info.id
    if (!updates || this.#measuringUpdates.has(runtime)) return
    this.#measuringUpdates.add(runtime)
    try {
      // A runtime that moves while it is being measured is measured again, a
      // few times at most: the answer is only worth keeping for the build
      // it describes. One that is still moving after the last try keeps
      // nothing, so no notice can be about a build it has left; the version it
      // ended on is measured by the next read of its description, as any
      // version not yet measured is.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const against = this.#versionOf(runtime) ?? null
        const update = await updates.updateFor({ ...runtime.info, version: against })
        // Removed, or replaced under the same id, while the registry answered.
        if (this.#runtimes.get(id) !== runtime) return
        if ((this.#versionOf(runtime) ?? null) !== against) continue
        const before = this.#updates.get(id)
        this.#updates.set(id, { against, update })
        // What a window was shown for this version: the old answer only if it
        // was measured against it too — otherwise nothing, see `#updateFor`.
        const shown = before?.against === against ? before.update : null
        if (shown?.version !== update?.version) {
          this.#logger.info('runtime update available', { runtime: id, running: against, latest: update?.version ?? null })
          this.#push({ method: 'runtime/infoChanged', params: { runtime: id, info: this.#infoOf(runtime) } })
        }
        return
      }
    } catch (error) {
      this.#logger.debug('update check failed', { runtime: id, error: String(error) })
    } finally {
      this.#measuringUpdates.delete(runtime)
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

/** A backup's own `id` field, whatever shape it turns out to be — never trusted to be the string it claims. */
const backupCopyId = (copy: unknown): unknown =>
  typeof copy === 'object' && copy !== null && 'id' in copy ? (copy as { id: unknown }).id : null

/** The most a logged id is ever allowed to cost, quotes and all. */
const LOGGED_ID_LIMIT = 140

/**
 * A backup's own id, safe to put in a log: quoted like any other logged
 * value, and capped — nothing here says a stranger's string is short,
 * printable, or even a string at all.
 *
 * The *raw* text is capped first, not the quoted text: a control character or
 * anything else JSON expands to several characters (a NUL becomes six
 * characters, U+0000 spelled out) is exactly why a cap taken before quoting
 * could smuggle a short raw string past it — but a cap taken by slicing the
 * already-quoted text at a raw character position can itself land inside one
 * of those six characters, leaving `\u00` with nothing after it, or between
 * the two UTF-16 halves of an astral character's surrogate pair, which
 * `JSON.stringify` leaves unescaped and so gives no mark of where it is safe
 * to cut. Both are avoided the same way: find the longest prefix of the raw
 * text, whole code points only, whose own quoted form still fits the cap
 * once the ellipsis this appends is counted — then quote only that prefix.
 * An escape or a surrogate pair is then always either whole or entirely
 * behind the cut, never half of either.
 */
const loggedId = (id: unknown): string => {
  const text = typeof id === 'string' ? id : String(id)
  const whole = JSON.stringify(text)
  if (whole.length <= LOGGED_ID_LIMIT) return whole
  // The prefix's own quoted form may cost this much: its closing quote is
  // about to be swapped for `…"`, one character longer, so one is held back
  // here to leave room for that swap.
  const budget = LOGGED_ID_LIMIT - 1
  let prefix = ''
  for (const codePoint of text) {
    const next = prefix + codePoint
    if (JSON.stringify(next).length > budget) break
    prefix = next
  }
  // The quoted prefix's own closing quote is dropped and put back after the
  // ellipsis, exactly as the un-truncated form's is by `JSON.stringify` itself.
  return `${JSON.stringify(prefix).slice(0, -1)}…"`
}

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
 * Whether a path is still a directory an agent could be started in.
 *
 * Kept identical in semantics to `isDirectory` in
 * `packages/adapter-acp/src/runtime.ts` so the listing-sourced fact and the
 * refusal-sourced fact cannot drift.
 */
export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Worded from the runtime's own presentation, so the message is true for
 * whichever runtime was asked and never names one the host has not met.
 */
