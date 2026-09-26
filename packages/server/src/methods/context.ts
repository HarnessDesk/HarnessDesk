import type { GatewaySupervisor } from '@harnessdesk/responses-gateway'
import type {
  AgentEntry,
  AgentRuntime,
  AgentSession,
  ApprovalDecision,
  AttachmentReview,
  CeilingLevel,
  ArchiveFilter,
  BackupFile,
  BackupReport,
  CarryFindingsInput,
  FindingDecisionAction,
  FindingDetailPage,
  FindingId,
  FindingPage,
  FindingRunView,
  FindingPublicationsView,
  FindingPublishAction,
  FindingView,
  FlowSeat,
  GitStatus,
  GoalId,
  GoalView,
  HostMethodName,
  HostParams,
  HostResult,
  Page,
  RepoInfo,
  ResolvedModelRoute,
  RuntimeFiles,
  RuntimeId,
  RuntimeInfo,
  SeatAttachmentsRecord,
  SeatId,
  SeatLeft,
  SeatRecord,
  SecretReload,
  Session,
  SessionAttachmentReceipt,
  SessionAttachments,
  SessionBusyError,
  SessionId,
  SessionSummary,
  TurnId,
  UserContent,
  WireNotification,
} from '@harnessdesk/protocol'
import type { InventoryAgent } from '@harnessdesk/agent-inventory'

import type { MachineSeatingFile } from '../agent-seating-file.js'
import type { Agents } from '../agents.js'
import type { SeatHold } from '../ceilings/hold.js'
import type { SessionArchive } from '../archive.js'
import type { AuditLog } from '../audit.js'
import type { CatalogRefresher } from '../catalog-refresher.js'
import type { CredentialBroker } from '../credentials.js'
import type { EditorPlane } from '../editor-plane.js'
import type { EvidencePlane } from '../evidence/plane.js'
import type { ProvenancePlane } from '../provenance/plane.js'
import type { ExtensionHost, HostOptions, ModelRouteRecord, OpenedSeat } from '../host.js'
import type { CorpusSpec, Ledger } from '../ledger/index.js'
import type { LibraryUsageReader } from '../library-usage.js'
import type { Logger } from '../log.js'
import type { SessionNames } from '../names.js'
import type { SeatedAs, SessionRecord, SessionRegistry } from '../registry.js'
import type { StateStore } from '../state.js'
import type { AuthoringPlane } from '../authoring/plane.js'
import type { FlowPreviews } from '../flow-preview.js'
import type { FlowUpdates } from '../flow-update.js'
import type { Flows } from '../flows.js'
import type { GoalPlane } from '../goals/plane.js'
import type { Team } from '../team.js'
import type { Terminals } from '../terminals.js'
import type { TranscriptStore } from '../transcripts.js'
import type { UsageMeter } from '../usage/meter.js'
import type { UsageService } from '../usage/service.js'
import type { Worktrees } from '../worktree.js'
import type { InsightPlane } from '../insight/plane.js'
import type { IntakePlane } from '../intake/plane.js'
import type { AttachmentSubject, PreparedAttachments } from '../attachments/plane.js'
import type { AttachmentResolution, ResolvedAttachment } from '../attachments/catalog.js'

/**
 * What a wire method may reach.
 *
 * The host owns every runtime, every session and every secret; the methods
 * that answer the renderer are the only code that acts on all of them at
 * once. This interface is the seam between the two: the host builds one from
 * closures over its own state, and each `methods/*.ts` module is written
 * against it rather than against the host class. Two things follow. A method
 * can be exercised with a hand-built context and nothing else running — no
 * socket, no runtime, no state directory — and the list of what methods may
 * touch is one readable file rather than "whatever is private on `Host`".
 *
 * Grouped by what it is about, not by which file happens to implement it.
 * When a method needs something that is not here, add it here first, named
 * for what it does, and only then use it; a handler reaching around the seam
 * is a handler nobody can test alone.
 */
export interface HostContext {
  readonly options: HostOptions
  readonly registry: SessionRegistry
  readonly state: StateStore
  readonly logger: Logger
  readonly credentials: CredentialBroker
  readonly audit: AuditLog
  readonly transcripts: TranscriptStore
  readonly archive: SessionArchive
  readonly names: SessionNames
  readonly terminals: Terminals
  readonly worktrees: Worktrees
  readonly team: Team
  readonly flows: Flows
  /** Previews a flow, non-executing, and mints the one token `flow/start-goal` redeems. */
  readonly flowPreviews: FlowPreviews
  /** Previewed, journaled conversion of a legacy flow to the Agent format, or a customization into the project. */
  readonly flowUpdates: FlowUpdates
  /**
   * Authoring saves: an Agent, a flow or a project's triggers, previewed
   * whole and written in one journaled transaction on the queue flow updates
   * share. Narrowed to the verbs the wire has.
   */
  readonly authoring: Pick<
    AuthoringPlane,
    'read' | 'patch' | 'preview' | 'apply' | 'pending' | 'resume' | 'discard' | 'renderShape' | 'triggerDraft' | 'renderTriggers' | 'rewriteAgent'
  >
  /** A front-door start's dry run: its context resolved on the host, its token strict and bound to that target. */
  readonly frontDoor: {
    preview(input: import('@harnessdesk/protocol').FrontDoorPreviewInput): Promise<import('@harnessdesk/protocol').FrontDoorPreview>
  }
  readonly goals: GoalPlane
  readonly lanes: import('../goals/lanes.js').LaneAllocator
  readonly laneSettings: {
    read(): import('@harnessdesk/protocol').LanePreferences
    set(value: import('@harnessdesk/protocol').LanePreferences): Promise<import('@harnessdesk/protocol').LanePreferences>
  }
  readonly laneEnvironment: {
    /** The lane's six values for a checkout, whatever runtime asks; pass them through `laneEnvironmentFor`. */
    forCheckout(cwd: string): Readonly<Record<string, string>> | undefined
    /** A durable Seat's lane values, already narrowed to what its runtime can take per session. */
    forSession(runtime: string, sessionId: string): Promise<Readonly<Record<string, string>> | undefined>
  }
  /**
   * The Agent roster: who can be seated, and what each one is for.
   *
   * Not `options.agents`, which is the ACP registry — the runtimes this desk
   * can start. An Agent is who does the work; a runtime is what it runs on.
   */
  readonly agents: Agents
  /** This machine's seats for its Agents: `seating.json`, which replaces an Agent's `prefer` here. */
  readonly seating: MachineSeatingFile
  /**
   * The evidence plane: every Seat this desk kept, what it observed, and the
   * project checks it runs once a person has seen them. Its own store, never
   * the usage ledger (`ledger()`).
   */
  readonly evidence: EvidencePlane
  /**
   * Phase 12's attachment freeze — optional so a build that has not wired it
   * yet keeps today's behavior exactly: `seatAgent` skips every attachment
   * step entirely when this is absent, the same as it does when an Agent
   * declares nothing. When present, `prepare` must be called before a
   * runtime session is created and `record` once (and only once) after it
   * answers back; neither is ever called for an Agent with no declarations.
   */
  readonly attachments?: {
    prepare(subject: AttachmentSubject): Promise<PreparedAttachments>
    record(seat: SeatRecord, prepared: PreparedAttachments, receipt: SessionAttachmentReceipt): Promise<SeatAttachmentsRecord>
    /** Task 5's own two person-facing verbs on Task 1's trust store — a preview names exact bytes, an approval names exactly the token that preview minted. */
    readonly trust: {
      preview(subject: AttachmentSubject, entries: readonly ResolvedAttachment[], options?: { readonly runtimeName?: string }): Promise<AttachmentReview>
      approve(token: string, options?: { readonly acknowledgeHidden?: boolean }): Promise<void>
    }
    /** A Seat's frozen attachment history, by immutable Seat id — Task 3's own durable receipts, read back for the Agent page and the Library. */
    seatRecord(seat: SeatId): Promise<SeatAttachmentsRecord | null>
    /**
     * Task 1's catalog for one Agent, against this desk's own Library home —
     * the one read every attachment surface shares, so the Agent page, a
     * review and a Seat's preparation never resolve a name two ways.
     */
    declarations(entry: AgentEntry, root: string): Promise<AttachmentResolution>
    /**
     * Whether this conversation's Seat carries — or should carry — a filter
     * (a frozen one, one that was lost, or an Agent that now declares
     * attachments): such a conversation is reopened only through the host's
     * shared reopen (`sessions.live`), which applies it or refuses.
     */
    carriesFilter(runtime: RuntimeId, sessionId: SessionId): Promise<boolean>
    /** Why forking this conversation is refused — a fork would run with no filter — or null. */
    forkRefusal(runtime: RuntimeId, sessionId: SessionId): Promise<string | null>
  }
  /**
   * The findings ledger, read and decided by a person. Narrower than the
   * findings plane itself: a Seat's own scoped read and its raise/repair/
   * verdict tools stay behind the Team capability (`Team.attachFindings`),
   * never reachable through a wire method.
   */
  readonly findings: {
    list(input: { readonly goal: GoalId; readonly cursor?: string; readonly filter?: 'all' | 'open' | 'blocking' }): Promise<FindingPage>
    read(input: { readonly goal: GoalId; readonly finding: FindingId; readonly cursor?: string }): Promise<FindingDetailPage>
    carry(input: CarryFindingsInput): Promise<readonly FindingView[]>
    setPublication(goal: GoalId, revision: number, enabled: boolean): Promise<GoalView>
    run(input: { readonly goal: GoalId; readonly run: string }): Promise<FindingRunView>
    decide(input: {
      readonly goal: GoalId
      readonly run: string
      readonly round: number
      readonly stamp: string
      readonly action: FindingDecisionAction
      readonly reason: string
    }): Promise<FindingRunView>
    /** A run's postings a person has to look at, and what a backfill would post now. */
    publications(input: { readonly goal: GoalId; readonly run: string }): Promise<FindingPublicationsView>
    /** Post again, skip or backfill, on a run of this Goal. */
    publish(input: { readonly goal: GoalId; readonly run: string; readonly action: FindingPublishAction }): Promise<FindingPublicationsView>
  }
  readonly provenance: Pick<ProvenancePlane, 'read' | 'status' | 'setCapture' | 'retry' | 'seat'>
  readonly editor: EditorPlane
  readonly gateways: GatewaySupervisor
  readonly catalogs: CatalogRefresher

  /** Built the first time something asks, so boot pays for neither. */
  usage(): UsageService
  ledger(): Ledger
  libraryUsage(): LibraryUsageReader
  /** Read-only Insight reports plus the explicitly reviewed local seating action. */
  readonly insight: Pick<InsightPlane, 'goal' | 'usage' | 'agent' | 'compare' | 'previewOrder' | 'applyOrder'>
  /**
   * Intake: a project's committed triggers as this machine stands on them,
   * and the person's own controls. The only way a handler reaches triggers;
   * every mutation here is a person's, and none is ever an Agent's tool.
   */
  readonly intake: Pick<IntakePlane, 'list' | 'preview' | 'arm' | 'disarm' | 'rebaseline' | 'preferences' | 'setPreferences' | 'history' | 'goal'>

  /** The extension kernel, or a refusal that names the build. */
  extensions(): ExtensionHost

  /** Fans a notification out to every connected client. */
  push(notification: WireNotification): void

  readonly runtimes: {
    /** The runtime a request names, or a refusal that quotes the id it named. */
    resolve(params: unknown): AgentRuntime
    get(id: string): AgentRuntime | undefined
    all(): readonly AgentRuntime[]
    ids(): Set<string>
    /** The runtime's own `info` overlaid with what the host knows about it. */
    infoOf(runtime: AgentRuntime): RuntimeInfo
    /** Runtimes whose usage the person has not switched off. */
    metered(): readonly AgentRuntime[]
    /** The runtime's extension plane, or a refusal that names the runtime. */
    extensionsOf(params: unknown): NonNullable<AgentRuntime['extensions']>
    /** The runtime's filesystem view, or the host's own when it has none. */
    files(runtime: RuntimeId | undefined): RuntimeFiles
    /** Brand-deduped, for the library engine. */
    inventory(): InventoryAgent[]
    register(runtime: AgentRuntime): void
    unregister(id: RuntimeId): Promise<void>
    start(runtime: AgentRuntime): Promise<void>
    bindUsage(runtime: RuntimeId, binding: { meter?: UsageMeter; corpus?: CorpusSpec['kind']; root?: string }): void
  }

  readonly sessions: {
    /** The live handle for a conversation, reopening it when the agent restarted underneath. */
    live(params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }): Promise<AgentSession>
    /** The host's record of a conversation, or a refusal. */
    record(params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }): SessionRecord
    /** A full read, enriched from the host's own transcript where the backend's is thin. */
    read(runtime: AgentRuntime, id: SessionId): Promise<Session>
    /** Joins a live handle to the registry and announces it. */
    attach(runtime: AgentRuntime, id: SessionId, live: AgentSession): Session
    withRepos(page: Page<SessionSummary>): Promise<Page<SessionSummary>>
    routeToHolders(runtime: AgentRuntime, page: Page<SessionSummary>): Page<SessionSummary>
    applyArchive(runtime: AgentRuntime, page: Page<SessionSummary>, filter: ArchiveFilter): Promise<Page<SessionSummary>>
    /** The busy refusal with its holder named, when the holder can be found. */
    busyElsewhere(runtime: AgentRuntime, id: SessionId, error: unknown): Promise<SessionBusyError>
    /** Why a conversation could not be reopened, in a sentence that names the agent. */
    cannotReopen(runtime: AgentRuntime, error: unknown): string
  }

  /**
   * Conversations the desk opens for a seat rather than for a person at a
   * composer: a flow's roles, and an Agent.
   *
   * The same three verbs the flow engine's port is built from, so there is
   * one way to open a seat — one set of picks applied, one set of switches
   * nobody asked for turned off, one read-back of what is running — and what
   * a flow and an Agent are seated on cannot drift apart.
   */
  readonly seats: {
    /**
     * Opens a conversation on the seat, in `cwd`, named `title`, puts it on
     * the seat's picks, and answers with what it is actually running, read
     * back once the picks are in. A pick the runtime declines is not an
     * error here: the caller compares, and decides. A failure leaves nothing
     * open: a conversation that opened and then failed is discarded first
     * (`discard`), the failure is thrown as it came, and what the discard
     * left is noted beside it (`leftOnFailure` in `agent-seating.ts`). A
     * runtime that answers with a conversation the desk already holds fails
     * it at once, noted `alreadyHeld`, with nothing done to that conversation.
     *
     * The conversation is held for the seating until it is kept
     * (`recordAgent`), retired, or discarded; only while it is held can it be
     * discarded.
     */
    open(
      seat: FlowSeat,
      where: {
        readonly cwd: string
        readonly title: string
        readonly environment?: Readonly<Record<string, string>>
        /** Phase 12's frozen, isolated skill/server filter, prepared before this call — never computed from the session it opens. */
        readonly attachments?: SessionAttachments
      },
    ): Promise<OpenedSeat>
    /** Hands a seated conversation its standing order: one message, one turn. */
    order(runtime: string, sessionId: string, text: string): Promise<void>
    /** Set the runtime's controls and read them back before the standing order runs. */
    hold(runtime: string, sessionId: string, level: CeilingLevel): Promise<SeatHold>
    /**
     * Closes a conversation a seating opened and will not use, and lets the
     * host's handle on it go. Resolves once it is gone, so the next seat can
     * be opened without two ever being open at once.
     */
    retire(runtime: string, sessionId: string): Promise<void>
    /**
     * Takes a seat a seating opened and passed over out of the world: closed,
     * let go, deleted where its runtime keeps it, forgotten by the desk, and
     * dropped from every window. Answers what it was left as, or null when
     * nothing is left.
     *
     * Only ever the conversation the seating itself opened, untouched: one a
     * window read, reopened or wrote to while it was open, or one a turn
     * started on, is left as it is (`inUse`) — its handle not even closed when
     * somebody is already in it. One its runtime cannot or will not delete is
     * archived and keeps its name (`kept`, `undeleted`).
     */
    discard(runtime: string, sessionId: string): Promise<SeatLeft | null>
    /**
     * Records which Agent a conversation was seated as, the digest of the
     * brief it was handed and the permission it was told it holds, tells every
     * window, and answers the conversation as the host now holds it. Kept by
     * the host from then on, over whatever the runtime re-announces
     * (`SessionRecord.seatedAs`).
     */
    recordAgent(runtime: string, sessionId: string, seated: SeatedAs): Session
  }

  readonly ceilings: {
    answerHeld(approvalId: string, decision: ApprovalDecision): boolean
  }

  readonly questions: {
    /**
     * Hears a person's answer to a question whose turn is already over — an
     * unattended Seat's, stopped by its deadline — by handing it to the Seat
     * in a turn of its own and letting its run go on. False when the question
     * is not one of those, so the answer goes to the live turn as usual.
     * Throws a sentence, the question kept, when it is and cannot be heard now.
     */
    answerStopped(runtime: string, sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<boolean>
  }

  readonly queue: {
    /** Announces a conversation's queue as it now stands. */
    push(record: SessionRecord): void
    /** Sends the next queued message, if the conversation is idle and the queue is not held. */
    drain(record: SessionRecord): Promise<void>
    nextId(): string
    /**
     * Whether the conversation can take a message right now: a turn is running,
     * or a direct send is still on its way to the agent. The second half is
     * what the session alone cannot say — `send` resolves on acceptance and
     * the turn's own `turn/started` arrives afterwards, so for that round trip
     * the session still reads idle.
     */
    busy(record: SessionRecord): boolean
    /** Sends straight to the live conversation, counting it busy until the agent has answered. */
    sendNow(record: SessionRecord, input: readonly UserContent[]): Promise<void>
  }

  readonly accounts: {
    /** One more account of an agent; a gateway account carries its own endpoint and key. */
    add(
      runtime: RuntimeId,
      gateway?: HostParams<'runtime/account/add'>['gateway'],
    ): Promise<{ runtime: RuntimeId; info: RuntimeInfo }>
    remove(runtime: RuntimeId): Promise<void>
    /** Gets a changed secret into the agent that needs it; says which way it went. */
    reloadSecrets(runtime: RuntimeId): Promise<SecretReload>
    /** Tells every client this runtime's sign-in state moved. */
    announce(runtime: RuntimeId): Promise<void>
    /**
     * The credentials gateway accounts hold, by reference.
     *
     * Narrower than the slot list on purpose: the one caller is
     * `credentials/list`, which needs to say that a key has an owner — and a
     * key whose owner nothing names reads as an orphan with a Remove beside
     * it, which is how this came to be asked.
     */
    gatewayCredentials(): readonly { readonly ref: string; readonly name: string }[]
  }

  readonly routes: {
    list(): readonly ModelRouteRecord[]
    usable(runtime: AgentRuntime, route: ModelRouteRecord): { usable: boolean; reason?: string }
    /** Exchanges a stored credential for a loopback gateway address. */
    resolve(runtime: AgentRuntime, routeId: string): Promise<ResolvedModelRoute>
  }

  readonly workspaces: {
    /** Every folder a path may be confined to: open workspaces and live conversations' cwds. Absolute paths only. */
    openRoots(): string[]
    /** Where a file may be read or written by path: the open roots and the roster's own folders (`#fileRoots`). */
    fileRoots(mode: 'read' | 'write'): string[]
    /** A repository root the renderer named, confined and made real. A relative one is refused. */
    confineGitRoot(root: string): Promise<string>
    /** The canonical project of an open linked checkout, confined for provenance controls. */
    confineProvenanceRoot(root: string): Promise<string>
    /**
     * The top of the checkout a folder is in — a linked worktree's own — or
     * null outside git. `signal`, when given, kills the underlying `git`
     * process the moment it fires, rather than leaving it running for its own
     * full timeout after a caller has already stopped waiting on it
     * (`workspace/recent`'s bound, #948).
     */
    topLevel(path: string, signal?: AbortSignal): Promise<string | null>
    /**
     * `path`, with every symlink in it resolved — the same comparison key
     * `#openWorkspace` (host.ts) puts on `WorkspaceEntry.realPath` (#907), and
     * on the persisted `WorkspaceRecord` it stores (#943, `state.ts`) so a
     * non-git folder opened through an alias still has something to compare
     * its own sessions against once the open workspace it was opened with is
     * replaced by a remembered entry — after a reload or a relaunch. A
     * comparison key only: never a launch path, never an input to anything
     * that reads or writes. `workspace/recent` calls this live only for the
     * one entry that also carries fresh git facts; every other entry reads
     * the key it was given when it was last opened, never resolving it again
     * here.
     */
    realPath(path: string): Promise<string>
    /**
     * Refuses a folder for a room, where it works and where its flows are read
     * from, unless it is in a folder or a repository opened here, links
     * resolved. A relative one is refused.
     */
    confineRoom(folder: string): Promise<void>
    /** Opens a folder, which becomes one of the open roots. A relative path is refused. */
    open(path: string): Promise<HostResult<'workspace/open'>>
    /**
     * A folder's git status, shelling out to `git` itself. `signal`, when
     * given, kills that process the moment it fires, rather than leaving it
     * running for its own full timeout after `workspace/recent` — this
     * method's only caller — has already stopped waiting on it (#948).
     */
    gitStatus(path: string, signal?: AbortSignal): Promise<GitStatus | null>
    repoOf(cwd: string): Promise<RepoInfo | null>
    boardRootOf(cwd: string): Promise<string | null>
    /** Drops the folder→board cache and re-points the Agent roster's watch; call when the set of workspaces changed. */
    forgetBoardRoots(): void
    /** Mints a short-lived ticket the preview route redeems for one file. */
    issuePreviewTicket(path: string, runtime: RuntimeId | undefined): string
  }

  readonly backup: {
    export(): Promise<BackupFile>
    import(raw: unknown): Promise<BackupReport>
  }

  diagnostics(): Promise<HostResult<'diagnostics/bundle'>>

  readonly settings: {
    /** Stored "Working together" preferences into the team engine. */
    applyTeam(): void
    /** Stored browser preferences into the extension host. */
    applyBrowser(): void
  }
}

/**
 * One wire method's implementation. Params arrive already validated by the
 * wire layer against the same table the type reads from, so a handler is
 * typed exactly and casts nothing.
 */
export type MethodHandler<M extends HostMethodName> = (
  ctx: HostContext,
  params: HostParams<M>,
) => HostResult<M> | Promise<HostResult<M>>

/**
 * Every method the wire declares, each with exactly the handler its
 * declaration calls for. Assigning the assembled table to this type is what
 * makes a method declared in `wire.ts` but not handled here a compile error,
 * and a handler whose result disagrees with its declaration another.
 */
export type HostMethodTable = { readonly [M in HostMethodName]: MethodHandler<M> }

/**
 * The methods under one or more prefixes, less any named exception — what one
 * domain module must answer, exactly. A module that `satisfies` this fails to
 * compile the day a method is declared under its prefix and not handled, and
 * fails *in that file*, which is where the fix belongs; the assembled table in
 * `index.ts` is the second check, over the whole. Prefixes are matched as
 * written, so `'runtime/account/'` takes the two account verbs and leaves
 * `runtime/account` itself where it was.
 */
export type MethodsUnder<Prefix extends string, Except extends string = never> = {
  readonly [M in HostMethodName as M extends `${Prefix}${string}`
    ? M extends `${Except}${string}`
      ? never
      : M
    : never]: MethodHandler<M>
}
