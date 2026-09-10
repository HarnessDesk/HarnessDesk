import type { GatewaySupervisor } from '@harnessdesk/responses-gateway'
import type {
  AgentRuntime,
  AgentSession,
  ArchiveFilter,
  BackupFile,
  BackupReport,
  HostMethodName,
  HostParams,
  HostResult,
  Page,
  RepoInfo,
  ResolvedModelRoute,
  RuntimeFiles,
  RuntimeId,
  RuntimeInfo,
  SecretReload,
  Session,
  SessionBusyError,
  SessionId,
  SessionSummary,
  TurnId,
  UserContent,
  WireNotification,
} from '@harnessdesk/protocol'
import type { InventoryAgent } from '@harnessdesk/agent-inventory'

import type { SessionArchive } from '../archive.js'
import type { AuditLog } from '../audit.js'
import type { CatalogRefresher } from '../catalog-refresher.js'
import type { CredentialBroker } from '../credentials.js'
import type { EditorPlane } from '../editor-plane.js'
import type { ExtensionHost, HostOptions, ModelRouteRecord } from '../host.js'
import type { CorpusSpec, Ledger } from '../ledger/index.js'
import type { LibraryUsageReader } from '../library-usage.js'
import type { Logger } from '../log.js'
import type { SessionNames } from '../names.js'
import type { SessionRecord, SessionRegistry } from '../registry.js'
import type { StateStore } from '../state.js'
import type { Team } from '../team.js'
import type { Terminals } from '../terminals.js'
import type { TranscriptStore } from '../transcripts.js'
import type { UsageMeter } from '../usage/meter.js'
import type { UsageService } from '../usage/service.js'
import type { Worktrees } from '../worktree.js'

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
  readonly editor: EditorPlane
  readonly gateways: GatewaySupervisor
  readonly catalogs: CatalogRefresher

  /** Built the first time something asks, so boot pays for neither. */
  usage(): UsageService
  ledger(): Ledger
  libraryUsage(): LibraryUsageReader

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
    bindUsage(runtime: RuntimeId, binding: { meter?: UsageMeter; corpus?: CorpusSpec['kind'] }): void
  }

  readonly sessions: {
    /** The live handle for a conversation, reopening it when the agent restarted underneath. */
    live(params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }): Promise<AgentSession>
    /** Sends a turn with the desk's attribution beside it when it is on and this seat is new to the conversation; the seat is recorded once the agent accepts. */
    sendAttributed(
      params: { readonly runtime: RuntimeId; readonly sessionId: SessionId },
      live: AgentSession,
      input: readonly UserContent[],
    ): Promise<TurnId>
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
    /** Every folder a path may be confined to: open workspaces and live conversations' cwds. */
    openRoots(): string[]
    /** A repository root the renderer named, confined and made real. */
    confineGitRoot(root: string): Promise<string>
    open(path: string): Promise<HostResult<'workspace/open'>>
    repoOf(cwd: string): Promise<RepoInfo | null>
    boardRootOf(cwd: string): Promise<string | null>
    /** Drops the folder→board cache; call when the set of workspaces changed. */
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
