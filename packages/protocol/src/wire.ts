import type { ApprovalDecision } from './approval.js'
import type {
  CapabilityContribution,
  ContextImage,
  ContributionKind,
  ExtensionEvent,
  PluginInstance,
  PluginSource,
  ScopeQuery,
} from './capability.js'
import type { EditorDocument, EditorEvent } from './editor.js'
import type {
  Library,
  LibraryDefinition,
  LibraryKind,
  LibraryIntent,
  LibraryOpResult,
  LibraryPlan,
  LibraryPlannedOp,
  LibraryUsage,
} from './library.js'
import type { AgentEvent } from './events.js'
import type { BackgroundTask } from './tasks.js'
import type { ApprovalId, RuntimeId, SessionId } from './ids.js'
import type { UserContent } from './items.js'
import type { ConfigOption, OptionValue } from './options.js'
import type {
  AccountStatus,
  FileMetadata,
  HookInfo,
  ListSessionsQuery,
  LoginStart,
  ImportableConfig,
  McpServer,
  ModelInfo,
  Page,
  ReviewRequest,
  RuntimeCatalog,
  RuntimePlugin,
  RuntimeHealth,
  RuntimeInfo,
  InstallationCheck,
  SecretReload,
  SessionDeletion,
  SkillInfo,
  TerminalSize,
  InstallInfo,
} from './runtime.js'
import type {
  RateLimits,
  RepoInfo,
  Session,
  SessionOptions,
  SessionQueue,
  SessionSettings,
  SessionSummary,
} from './session.js'
import type { Intent, Plan, TeamInbound, TeamPeerInfo, TeamState } from './team.js'
import type {
  LedgerQuery,
  LedgerReport,
  ScanProgress,
  UsageReport,
} from './usage.js'

/**
 * The browser ⇄ host protocol.
 *
 * JSON-RPC shaped, carried over a single WebSocket. Requests are client-initiated
 * only; the host pushes state exclusively as notifications, which keeps the
 * renderer free of any obligation to answer.
 */

export const PROTOCOL_VERSION = 1

// ------------------------------------------------------------------- requests

export interface FileMatch {
  readonly path: string
  readonly relativePath: string
  readonly score: number
  readonly kind?: 'file' | 'directory'
  /** Character positions in `relativePath` that matched, for highlighting. */
  readonly indices?: readonly number[]
}

/**
 * One conversation whose transcript contains the words searched for, from the
 * host's own store — which is why, unlike `session/search`, this covers every
 * agent the same way. `line` is the matching line, already trimmed and
 * clipped; `start`/`end` bound the match within it, for highlighting.
 */
export interface TranscriptHit {
  readonly summary: SessionSummary
  readonly line: string
  readonly start: number
  readonly end: number
}

/**
 * Everything HarnessDesk keeps for itself, as one restorable file: the agent
 * registry, the preferences, and the host's transcripts. Deliberately not in
 * it: credentials, which live in the OS keystore and would not decrypt on
 * another machine anyway — a restore is followed by signing in again — and
 * the agents' own history, which belongs to each agent and never left it.
 */
export interface BackupFile {
  readonly kind: 'harnessdesk-backup'
  readonly version: 1
  readonly exportedAt: number
  readonly hostVersion: string
  readonly agents: readonly Readonly<Record<string, unknown>>[]
  readonly preferences: Readonly<Record<string, unknown>>
  readonly transcripts: readonly {
    readonly runtime: string
    readonly id: string
    readonly data: unknown
  }[]
}

/**
 * What a restore actually did, counted after re-reading what was written —
 * a number here is a verified write, not an attempted one. `skipped` is the
 * merge policy speaking: an agent already registered, or a transcript the
 * local store holds a newer copy of, is left alone.
 */
export interface BackupReport {
  readonly agents: { readonly restored: number; readonly skipped: number }
  readonly preferences: number
  readonly transcripts: { readonly restored: number; readonly skipped: number }
}

export interface GitFileStatus {
  readonly path: string
  readonly status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
  readonly staged: boolean
}

export interface GitStatus {
  readonly root: string
  readonly branch?: string | null
  readonly ahead: number
  readonly behind: number
  readonly files: readonly GitFileStatus[]
}

/** One commit as the history table shows it. Times are epoch milliseconds. */
export interface GitLogCommit {
  readonly sha: string
  readonly parents: readonly string[]
  readonly subject: string
  readonly author: string
  readonly authorEmail: string
  readonly authoredAt: number
  readonly committedAt: number
  /** Decorations exactly as git words them: `HEAD -> main`, `origin/main`, `tag: v1.0`. */
  readonly refs: readonly string[]
}

export interface GitLogPage {
  readonly commits: readonly GitLogCommit[]
  /** History continues beyond this page's `skip + limit`. */
  readonly hasMore: boolean
}

/** Which commits the log walks: every ref, or just what HEAD can reach. */
export type GitLogScope = 'all' | 'head'

/** What a history search matches the query against. */
export type GitLogSearch = 'message' | 'author' | 'sha' | 'file'

export interface GitBranchRef {
  readonly name: string
  readonly sha: string
  readonly current: boolean
  readonly committedAt: number
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
  /**
   * The upstream it tracks no longer exists: deleted on its remote and pruned
   * here — for-each-ref's `[gone]`. `ahead` and `behind` are 0 then, and say
   * nothing about it.
   */
  readonly gone: boolean
}

export interface GitRemoteRef {
  readonly remote: string
  /** The branch's name on that remote, without the remote prefix. */
  readonly name: string
  readonly sha: string
  readonly committedAt: number
}

export interface GitTagRef {
  readonly name: string
  /** The commit the tag points at — peeled, for an annotated tag. */
  readonly sha: string
  readonly at: number
}

export interface GitStashRef {
  /** The reflog name, `stash@{0}`, which is how git addresses it. */
  readonly ref: string
  readonly sha: string
  readonly message: string
  readonly at: number
}

/**
 * What a merge-like verb reports: done, or done-up-to-these-conflicts. The
 * conflicted paths are left in the working tree — the Changes surface shows
 * them, and a commit concludes the operation.
 */
export interface GitMergeOutcome {
  readonly summary: string
  readonly conflicts: readonly string[]
}

/** How far `git/reset` unwinds: keep the work staged, keep it, or erase it. */
export type GitResetMode = 'soft' | 'mixed' | 'hard'

/**
 * One checkout of the repository, as the history pane's worktree surface
 * lists it. This is git's own view — every worktree the repository has,
 * whoever made it — where `Worktree` above is the session plane's narrower
 * one. `managed` is where the two meet: true for the disposable checkouts
 * HarnessDesk cuts for "new session in a worktree", so removing one can say
 * what it is about to take.
 */
export interface GitWorktree {
  readonly path: string
  /** The branch checked out here; null when detached or bare. */
  readonly branch: string | null
  readonly head: string | null
  readonly isMain: boolean
  /** The worktree the pane is reading the repository from. */
  readonly isCurrent: boolean
  readonly bare: boolean
  readonly detached: boolean
  /** Locked against pruning, with git's stated reason — empty when none was given. */
  readonly locked: { readonly reason: string } | null
  /** Git would drop this entry on a prune, and why — a deleted directory, usually. */
  readonly prunable: { readonly reason: string } | null
  readonly managed: boolean
  /**
   * Files with uncommitted changes, untracked included. Null when the
   * working tree could not be read at all — a prunable entry whose folder
   * is gone — which is not the same fact as a clean tree.
   */
  readonly dirty: number | null
}

/**
 * Everything removing a worktree would delete, and a digest of it.
 *
 * Ignored files are here because `git worktree remove` deletes them without
 * being forced: a checkout holding `.env.local` reads as clean from status
 * alone, and would be emptied without anyone being told. Directories are
 * collapsed — `node_modules/` is one line — which is both the readable
 * answer and the affordable one.
 *
 * `stateId` covers the whole inventory, not the shown slice. A removal
 * echoes it back, so work that appeared between the looking and the clicking
 * cannot be discarded on the strength of a count that is no longer true.
 */
export interface GitWorktreeInventory {
  /** Uncommitted changes, capped for the wire; `changeCount` is the truth. */
  readonly changes: readonly { readonly path: string; readonly status: string }[]
  /** Ignored files and folders, capped the same way. */
  readonly ignored: readonly string[]
  readonly changeCount: number
  readonly ignoredCount: number
  readonly stateId: string
}

/** What a new worktree checks out: a fresh branch, an existing one, or a commit. */
export type GitWorktreeCheckout =
  | { readonly kind: 'new'; readonly branch: string; readonly base?: string }
  | { readonly kind: 'existing'; readonly branch: string }
  | { readonly kind: 'detach'; readonly at: string }

/** Every ref in the repository, for the history pane's rail. */
export interface GitRefsSummary {
  readonly headSha: string | null
  /** The branch HEAD is on; null when detached, or before the first commit. */
  readonly branch: string | null
  readonly branches: readonly GitBranchRef[]
  readonly remotes: readonly GitRemoteRef[]
  readonly tags: readonly GitTagRef[]
  readonly stashes: readonly GitStashRef[]
}

export interface GitCommitFile {
  readonly path: string
  /** Where a renamed file came from. */
  readonly oldPath?: string
  readonly status: GitFileStatus['status']
  /** Lines added and removed, or null for a binary file. */
  readonly added: number | null
  readonly removed: number | null
}

/** One commit opened: full message, both identities, and what it touched. */
export interface GitCommitDetail {
  readonly sha: string
  readonly parents: readonly string[]
  readonly author: string
  readonly authorEmail: string
  readonly authoredAt: number
  readonly committer: string
  readonly committedAt: number
  readonly refs: readonly string[]
  /** Subject and body, exactly as written. */
  readonly message: string
  readonly files: readonly GitCommitFile[]
}

/** One checkout of a repository. `managed` ones were created by HarnessDesk and may be removed by it. */
export interface Worktree {
  readonly path: string
  readonly branch: string | null
  readonly head: string | null
  readonly isMain: boolean
  readonly managed: boolean
}

/** What removing a worktree would lose. */
export interface WorktreeChanges {
  readonly modified: number
  readonly untracked: number
  /** Commits on the branch no upstream has. The branch is kept, so these are a note, not a loss. */
  readonly unpushedCommits: number
  readonly files: readonly string[]
}

export interface WorkspaceEntry {
  readonly path: string
  readonly name: string
  readonly lastOpenedAt: number
  readonly git?: { readonly branch?: string | null } | null
  /**
   * The repository the folder belongs to, when the host has read it. A
   * worktree opened as a workspace is still the project its main checkout
   * is, and the session list groups it there.
   */
  readonly repo?: RepoInfo | null
}

/**
 * One agent the host knows how to register without the user writing JSON.
 *
 * The catalogue is the host's: it knows which bridges shipped with this build
 * and which agent CLIs are on this machine. The renderer renders what it is
 * given — names and taglines included — so no runtime is ever named in UI
 * code, which is the same bargain `RuntimePresentation` makes.
 */
export interface AgentTemplateInfo {
  /** Stable template key; also the runtime id a registration will get. */
  readonly key: string
  readonly name: string
  readonly brand?: string
  readonly tagline?: string
  /**
   * Whether registering this template right now would produce a working
   * agent. False comes with `reason` — a missing bridge, a CLI not on this
   * machine — because a greyed row with no sentence is a dead end.
   */
  readonly available: boolean
  readonly reason?: string
  /** Already in the registry, or the id is taken by a live runtime. */
  readonly registered: boolean
  /** The agent CLI this template drives, and whether it was found here. */
  readonly requires?: {
    readonly command: string
    readonly found: boolean
    readonly installCommand?: string
    /** The copy that would answer, when one was found. */
    readonly version?: string | null
    readonly path?: string
    readonly channelLabel?: string
  }
}

/**
 * One agent from the public ACP registry, as this machine sees it.
 *
 * The registry is the protocol's own list of agents that speak ACP —
 * everything in it is addable in principle, so what the renderer needs from
 * the host is the part only the host knows: whether *this machine* can run
 * the entry, and how. `run` is the channel the host would use; `available`
 * folds in what that channel needs (a package runner on PATH, a build for
 * this platform), and false always comes with `reason`.
 */
export interface AcpRegistryAgentInfo {
  /** The registry's own id; also the runtime id a registration will get. */
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
  /** Where to read more — the entry's website, or its repository. */
  readonly website?: string
  readonly license?: string
  /**
   * How this machine would run it: a package runner fetches `npx`/`uvx`
   * entries on first start, `binary` means the host downloads the entry's
   * build for this platform when it is added.
   */
  readonly run: 'npx' | 'uvx' | 'binary'
  readonly available: boolean
  readonly reason?: string
  /** Already in the agent registry, or the id is taken by a live runtime. */
  readonly registered: boolean
  /**
   * A copy of this agent already on the machine, when the host knows how to
   * look for one. Adding the entry then points at that copy and downloads
   * nothing; the registry's own build stays one click away as a fallback.
   */
  readonly installed?: {
    readonly path: string
    readonly version: string | null
    /** Completes "installed via …". */
    readonly channelLabel: string
  }
}

/** The registry as a whole: its agents, and how fresh the reading is. */
export interface AcpRegistryCatalogInfo {
  readonly agents: readonly AcpRegistryAgentInfo[]
  /** When the document was last fetched; null when it never has been. */
  readonly fetchedAt: number | null
  /** Why `agents` is empty, when it is for a reason worth telling. */
  readonly unavailable?: string
}

/**
 * What `agents/register` accepts: a known template, an entry from the public
 * ACP registry, or a command of the user's own.
 */
export interface AgentRegisterRequest {
  readonly template?: string
  /** An agent from the public ACP registry, by its registry id. */
  readonly registry?: { readonly id: string }
  readonly custom?: {
    readonly name: string
    readonly command: string
    readonly args?: readonly string[]
    readonly env?: Readonly<Record<string, string>>
    /** Derived from `name` when absent. */
    readonly id?: string
  }
}

/**
 * Every callable method with its params and result.
 *
 * Adding a method means adding one entry here; the client and server helpers are
 * both generic over this map, so a mismatch is a compile error rather than a
 * runtime 'unknown method'.
 */
export interface HostMethods {
  'host/hello': {
    params: { readonly clientVersion: string }
    result: {
      readonly protocolVersion: number
      readonly hostVersion: string
      readonly runtimes: readonly RuntimeInfo[]
      /**
       * How this host protects a secret it is given, in words a person can
       * read: `macOS Keychain` in the desktop app, `file permissions only`
       * for a standalone host with no OS keystore behind it. The sign-in
       * page prints it rather than promising a keychain that may not be
       * there.
       */
      readonly credentialProtection: string
      /**
       * The host's home directory, so the renderer can write `~` where a path
       * would otherwise carry the machine's username.
       *
       * It arrives at the handshake because it is a fact about the process,
       * fixed for its whole life — the same class of thing as
       * `credentialProtection` above. It used to reach the window only on
       * `Library.home`, which meant a screen with no reason to scan the
       * library had no home to shorten against and printed
       * `/Users/<name>/…` in full.
       */
      readonly home: string
    }
  }

  'runtime/health': { params: { readonly runtime: RuntimeId }; result: RuntimeHealth }
  /**
   * Everything support needs and nothing they should not have: versions,
   * health, plugin state, and the recent log with secrets and home paths
   * scrubbed. The renderer offers it as a file to attach to a report.
   */
  'diagnostics/bundle': {
    params: Record<string, never>
    result: {
      readonly generatedAt: number
      readonly hostVersion: string
      readonly platform: string
      readonly runtimes: readonly {
        readonly id: RuntimeId
        readonly name: string
        readonly version: string | null
        readonly health: RuntimeHealth
      }[]
      readonly plugins: readonly {
        readonly id: string
        readonly version: string | null
        readonly state: string
      }[]
      /** Last log lines, redacted. */
      readonly log: readonly string[]
    }
  }
  'runtime/models': { params: { readonly runtime: RuntimeId }; result: readonly ModelInfo[] }
  'runtime/account': { params: { readonly runtime: RuntimeId }; result: AccountStatus }
  'runtime/limits': { params: { readonly runtime: RuntimeId }; result: RateLimits | null }
  /**
   * Every metered account's standing, across every agent — the Usage screen's
   * one read. Cached host-side; `usage/refresh` is what forces a source to be
   * asked again.
   */
  'usage/reports': { params: Record<string, never>; result: readonly UsageReport[] }
  'usage/refresh': {
    params: { readonly runtime?: RuntimeId }
    result: readonly UsageReport[]
  }
  /** Token and cost history from the agents' own transcripts. */
  'usage/ledger': { params: LedgerQuery; result: LedgerReport }
  /** Starts a ledger scan if one is not already running; progress arrives as an event. */
  'usage/scan': { params: { readonly full?: boolean }; result: ScanProgress }
  'runtime/options': { params: { readonly runtime: RuntimeId }; result: readonly ConfigOption[] }
  /**
   * Re-asks a runtime what it offers, now — see `AgentRuntime.refreshCatalog`
   * — after first checking whether its binary changed. The new draft options
   * arrive through `catalog/changed`, not in this result.
   */
  'runtime/refreshCatalog': {
    params: { readonly runtime: RuntimeId }
    result: {
      readonly checkedAt: number
      readonly installation: InstallationCheck | null
      /**
       * Whether the runtime actually re-read. False is an ordinary answer,
       * not an error: an agent that refreshes by restarting declines while a
       * turn is in flight. The result used to carry only `checkedAt`, so a
       * caller could not tell a refresh from a polite refusal — and the
       * library's own "have it look again" reported the refusal as success.
       */
      readonly refreshed: boolean
      /** Why it did not, when it did not. A sentence to show a person. */
      readonly reason?: string
    }
  }
  /**
   * What a new session in `cwd` would start with. `[]` when the runtime cannot
   * say — the composer then has no pre-session controls, which is the truthful
   * rendering of a backend that only declares options once a session exists.
   */
  'runtime/sessionDefaults': {
    params: {
      readonly runtime: RuntimeId
      readonly cwd?: string
      /**
       * Values the user has already picked for the next session. The runtime
       * re-declares the whole list with these applied — the same constraint
       * model live sessions use, so a choice that narrows another option
       * (a model narrowing its reasoning levels) narrows it here too.
       */
      readonly values?: Readonly<Record<string, OptionValue>>
    }
    result: readonly ConfigOption[]
  }
  'runtime/options/set': {
    params: { readonly runtime: RuntimeId; readonly optionId: string; readonly value: OptionValue }
    result: null
  }
  'runtime/skills': {
    params: { readonly runtime: RuntimeId; readonly cwd?: string }
    result: readonly SkillInfo[]
  }
  'runtime/skills/setEnabled': {
    params: {
      readonly runtime: RuntimeId
      readonly name: string
      readonly path?: string | null
      readonly enabled: boolean
    }
    result: null
  }
  /**
   * The library: every skill and MCP server on this machine, and which agents
   * can see each one. Assembled per call rather than cached — it reads the
   * disk and asks each running runtime what it loaded, and both change under
   * the app without telling it.
   */
  'library/read': {
    params: { readonly cwd?: string }
    result: Library
  }
  /**
   * One entry's definition, read from one of its copies: the `SKILL.md` text
   * and the files beside it in the bundle. What makes the library a page
   * about skills rather than a page about paths — nothing else on this wire
   * can tell you what a skill actually says.
   *
   * Read-only, and confined host-side to the same roots the write path is
   * confined to. `path` arrives from the renderer, which read it out of a
   * `LibraryEntry.copies`, but it crossed a socket to get here and is
   * re-checked rather than trusted. Answers null when the path is outside
   * those roots or holds no definition.
   */
  'library/definition': {
    params: { readonly kind: LibraryKind; readonly name: string; readonly path: string; readonly cwd?: string }
    result: LibraryDefinition | null
  }
  /**
   * How often each skill actually fired, counted from the conversations this
   * desk stores. The first call walks every transcript and is slow in
   * proportion; every call after reads a cache and re-parses only what
   * changed on disk.
   */
  'library/usage': {
    params: Record<string, never>
    result: LibraryUsage
  }
  /**
   * The write path's first half: intents in, previewed operations out, and
   * nothing on disk touched. Every operation carries the exact content it
   * would write, a unified diff, and a digest of the target as the plan saw
   * it — the evidence a person confirms before anything is allowed to act.
   */
  'library/plan': {
    params: { readonly cwd?: string; readonly intents: readonly LibraryIntent[] }
    result: LibraryPlan
  }
  /**
   * The second half: the planned operations back verbatim, performed one by
   * one with a per-op result — one failure never aborts the rest. The host
   * re-checks every target (inside a known root, not read-only, unchanged
   * since the plan's digest) before writing, and every write lands in the
   * audit log.
   */
  'library/apply': {
    params: { readonly cwd?: string; readonly ops: readonly LibraryPlannedOp[] }
    result: readonly LibraryOpResult[]
  }
  'runtime/hooks': {
    params: { readonly runtime: RuntimeId; readonly cwd?: string }
    result: readonly HookInfo[]
  }
  'session/goal': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId; readonly objective: string | null }
    result: null
  }
  /**
   * Starts one of the `signInMethods` the account status declared. The renderer
   * opens whatever comes back; completion arrives as an `account/loginCompleted`
   * event rather than a result, because the flow finishes in another application.
   */
  /**
   * The credential broker. Values travel exactly one way: in. `list` returns
   * references and names; nothing on this wire ever returns a stored value,
   * which is what keeps the renderer unable to read a secret even if it is
   * compromised. Resolution happens host-side, feeding the loopback gateway.
   */
  /**
   * The cross-agent audit log. One question it answers: what did the
   * agents do in this repository this week, whichever vendor made them.
   */
  'audit/query': {
    params: { readonly root?: string; readonly sinceDays?: number }
    result: readonly {
      readonly at: number
      readonly runtime: RuntimeId
      readonly sessionId: string
      readonly cwd?: string
      readonly kind: string
      readonly status?: string
      readonly steps?: number
      readonly durationMs?: number
      readonly approvalType?: string
      readonly decision?: string
      readonly rule?: string
      /** library/write entries: what was done, to what, and where. */
      readonly op?: string
      readonly name?: string
      readonly path?: string
      readonly backupPath?: string
      readonly detail?: string
    }[]
  }

  'credentials/list': {
    params: Record<string, never>
    result: readonly {
      readonly ref: string
      readonly name: string
      readonly createdAt: number
      /**
       * What this key belongs to, when it belongs to something with a door of
       * its own — an agent's sign-in, or a gateway account's endpoint. `null`
       * is a key a custom endpoint refers to, which is the only kind Settings
       * offers to remove.
       *
       * Asked as "who owns it" rather than "is it an agent's", because the
       * second question has been answered wrongly twice: an agent's key drew
       * as an orphan, and then so did a gateway account's. Every owner class
       * has to name itself here or it reads as nobody's.
       */
      readonly owner: { readonly kind: 'agent' | 'gateway'; readonly of: string } | null
    }[]
  }
  'credentials/store': {
    params: { readonly name: string; readonly value: string }
    result: { readonly ref: string }
  }
  'credentials/delete': { params: { readonly ref: string }; result: null }
  /**
   * An agent that authenticates with a pasted secret. The value goes straight
   * to the broker and into the agent's environment at spawn; it is never
   * returned, never logged, and never reaches the renderer again.
   */
  /**
   * Store, replace, or remove the secret an `apiKey` sign-in method names.
   * The value goes to the credential broker and is never returned.
   *
   * `applied` is what the agent knows now: `restarted` means it is running
   * with the new value, `busy` that a turn was in flight and it will pick the
   * value up on its next start. The shell says which, because "saved" alone
   * let a user store a key and watch the next turn fail for the lack of it.
   */
  'runtime/apiKey/store': {
    params: { readonly runtime: RuntimeId; readonly methodId: string; readonly value: string }
    result: { readonly applied: SecretReload }
  }
  'runtime/apiKey/clear': {
    params: { readonly runtime: RuntimeId; readonly methodId: string }
    result: { readonly applied: SecretReload }
  }

  /**
   * Model routes: run a backend's conversations against another endpoint.
   * A route names a credential by reference; whether a backend can use it is
   * answered per runtime (`usable` with a reason when not), so the UI greys
   * rather than hides.
   */
  'routes/list': {
    params: { readonly runtime?: RuntimeId }
    result: readonly {
      readonly id: string
      readonly name: string
      readonly endpoint: string
      readonly wireProtocol: string
      readonly credentialRef: string
      readonly model?: string
      /** Present when a runtime was named: can that backend speak this route? */
      readonly usable?: boolean
      readonly reason?: string
    }[]
  }
  'routes/save': {
    params: {
      readonly id?: string
      readonly name: string
      readonly endpoint: string
      readonly wireProtocol: string
      readonly credentialRef: string
      readonly model?: string
    }
    result: { readonly id: string }
  }
  'routes/delete': { params: { readonly id: string }; result: null }

  'runtime/login': {
    params: { readonly runtime: RuntimeId; readonly method: string }
    result: LoginStart
  }
  'runtime/login/cancel': {
    params: { readonly runtime: RuntimeId; readonly loginId: string }
    result: null
  }
  'runtime/logout': { params: { readonly runtime: RuntimeId }; result: null }
  /**
   * One more account of the same agent.
   *
   * Adding is separate from signing in because the two can fail differently:
   * this makes the credential home and registers the runtime that will own it,
   * and `runtime/login` on the id it returns is what puts an identity in it. A
   * slot nobody finished signing into is a visible empty row, which is a
   * better answer than a sign-in that silently replaced the last one.
   */
  'runtime/account/add': {
    params: {
      readonly runtime: RuntimeId
      /**
       * Makes the new account a **gateway account**: same agent, same models,
       * billed to this endpoint's key instead of the vendor plan the primary
       * signs into. `runtime/login` is then not needed and not offered — the
       * key *is* the sign-in, and it goes to the credential broker on the way
       * past, never to the agent's environment or its home.
       */
      readonly gateway?: {
        readonly name: string
        readonly endpoint: string
        readonly apiKey: string
      }
    }
    result: { readonly runtime: RuntimeId; readonly info: RuntimeInfo }
  }
  /** Signs the account out, stops it, and forgets its credential home. */
  'runtime/account/remove': { params: { readonly runtime: RuntimeId }; result: null }

  'session/list': {
    params: { readonly runtime: RuntimeId } & ListSessionsQuery
    result: Page<SessionSummary>
  }
  'session/search': {
    params: { readonly runtime: RuntimeId; readonly query: string }
    result: Page<SessionSummary>
  }
  /**
   * Content search across every agent's stored transcripts at once — the
   * host's record of what it watched, not any runtime's own history search.
   * A session never opened in HarnessDesk has no transcript here and cannot
   * match; `session/search` on a runtime that searches its own history is the
   * complement, and the palette runs both.
   */
  'transcripts/search': {
    params: { readonly query: string }
    result: readonly TranscriptHit[]
  }
  /** The backup file, assembled host-side. See `BackupFile` for what is in it. */
  'backup/export': {
    params: Record<string, never>
    result: BackupFile
  }
  /**
   * Restores a backup additively: nothing local is deleted, existing agents
   * and newer transcripts are skipped, preferences take the file's values.
   * The report counts only writes that were read back and matched.
   */
  'backup/import': {
    params: { readonly backup: unknown }
    result: BackupReport
  }
  'session/read': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }
    result: Session
  }
  'session/create': {
    params: { readonly runtime: RuntimeId; readonly options: SessionOptions }
    result: Session
  }
  'session/resume': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly options?: Partial<SessionOptions>
    }
    result: Session
  }
  'session/fork': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly options?: Partial<SessionOptions>
    }
    result: Session
  }
  'session/archive': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId; readonly archived: boolean }
    result: null
  }
  'session/delete': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }
    result: SessionDeletion
  }
  'session/close': { params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }; result: null }
  'session/setTitle': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId; readonly title: string }
    result: null
  }
  'session/settings': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly patch: Partial<SessionSettings>
    }
    result: null
  }
  /**
   * Sets one option. The result is null on purpose: the new option list
   * arrives as a `session/options` event, so every connected client — not
   * only the one that asked — sees the same truth.
   */
  'session/options/set': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly optionId: string
      readonly value: OptionValue
    }
    result: null
  }
  /** Drops the last N turns. Does not revert files — the caller warns of that. */
  'session/rollback': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId; readonly turns: number }
    result: null
  }
  /**
   * Puts back the files one turn changed — that turn's diff reversed, nothing
   * else — or, with `direction: 'redo'`, writes the same diff forward again
   * after an undo. Refuses, with nothing half-done, when a file was edited
   * since.
   */
  'session/revertTurn': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly turnId: string
      /** Default `'undo'`, which is what the method is named for. */
      readonly direction?: 'undo' | 'redo'
    }
    result: { readonly files: readonly string[] }
  }
  'session/compact': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }
    result: null
  }
  'session/memory': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId; readonly enabled: boolean }
    result: null
  }
  'session/review': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId; readonly target: ReviewRequest }
    result: null
  }

  'turn/send': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly input: readonly UserContent[]
    }
    result: { readonly turnId: string }
  }
  'turn/steer': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly input: readonly UserContent[]
    }
    result: null
  }
  'turn/interrupt': { params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }; result: null }

  /**
   * Holds a message until the running turn ends, then sends it.
   *
   * Queueing is the host's, because no backend has the concept and every one
   * of them refuses input mid-turn in its own way — one of them by throwing.
   * A session that is *not* busy sends immediately instead of queueing: a
   * queue waiting on a turn that will never start would never drain.
   *
   * The result says which happened, so the caller does not have to guess from
   * the events.
   */
  'turn/queue': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly input: readonly UserContent[]
    }
    result: { readonly queuedId: string | null; readonly sent: boolean }
  }
  /** Drops one waiting message. An id that has already gone is not an error. */
  'turn/queue/cancel': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId; readonly id: string }
    result: null
  }
  /** Moves one waiting message to `to`, a zero-based position, clamped. */
  'turn/queue/move': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly id: string
      readonly to: number
    }
    result: null
  }
  /**
   * Sends the head of the queue now — the way out of a paused queue, and the
   * way to skip the wait. Refuses while a turn is running, because that is
   * what `turn/steer` and `turn/interrupt` are for.
   */
  'turn/queue/flush': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }
    result: null
  }
  /** Throws the whole queue away. */
  'turn/queue/clear': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }
    result: null
  }

  /**
   * What the agent has running in the background for this conversation.
   *
   * A read, not a subscription: the list arrives unasked as `session/tasks`
   * whenever it changes, and this is for the moment a pane is opened on a
   * conversation whose runtime has not had reason to say anything yet.
   * Empty for a runtime without the concept, which is most of them.
   */
  'tasks/list': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }
    result: readonly BackgroundTask[]
  }
  /**
   * Ends one background task. `stopped` is false when the runtime did not
   * know the id — which is what two windows racing on the same button looks
   * like, and is not an error.
   */
  'tasks/stop': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId; readonly taskId: string }
    result: { readonly stopped: boolean }
  }
  /**
   * Forgets the tasks that have finished. Running ones are untouched: this is
   * the panel's "Clear", not a kill switch, and a button that quietly ended
   * live work would be the worst kind of surprise.
   */
  'tasks/clear': {
    params: { readonly runtime: RuntimeId; readonly sessionId: SessionId }
    result: null
  }

  'approval/respond': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly approvalId: ApprovalId
      readonly decision: ApprovalDecision
    }
    result: null
  }

  /**
   * The agents this build can register from the interface. Asked, not pushed:
   * availability depends on what is installed on the machine right now, and
   * the answer is only worth computing while the add-agent surface is open.
   */
  'agents/catalog': { params: Record<string, never>; result: readonly AgentTemplateInfo[] }
  /** The public ACP registry, read through the host's cache. */
  'agents/registry': { params: Record<string, never>; result: AcpRegistryCatalogInfo }
  /**
   * Registers an ACP agent — a known template, or a custom command — writes it
   * to the registry, and brings it up. The new row arrives as `runtime/added`
   * before this resolves; failing to *start* is the runtime's own health to
   * report, exactly as it is for an account that was just added.
   */
  'agents/register': {
    params: AgentRegisterRequest
    result: { readonly runtime: RuntimeId; readonly info: RuntimeInfo }
  }
  /**
   * Unregisters an agent that `agents/register` (or a hand-edited registry)
   * added. The agent's own software, configuration and history are untouched
   * — the registry points at a command, it does not manage software. Refused
   * for runtimes the registry does not own: Codex, and account slots.
   */
  'agents/remove': { params: { readonly runtime: RuntimeId }; result: null }
  /**
   * Every copy of the agent on this machine, looked for afresh, and which
   * one answers. The same answer rides on `RuntimeInfo.install`; this is the
   * way to ask again after installing or removing something.
   */
  'agents/installs': { params: { readonly runtime: RuntimeId }; result: InstallInfo }
  /**
   * Pins one copy as the one that answers, or `null` to go back to the
   * newest-wins rule. Takes effect on the next start; a runtime with no turn
   * in flight is restarted onto it at once.
   */
  'agents/installs/use': {
    params: { readonly runtime: RuntimeId; readonly path: string | null }
    result: InstallInfo
  }
  /**
   * Replaces a download the desk made with the registry's current build of
   * the same agent. Refused for anything the desk did not download — those
   * belong to the person's package manager, and the interface names the
   * command instead of offering a button.
   */
  'agents/update': {
    params: { readonly runtime: RuntimeId }
    result: { readonly runtime: RuntimeId; readonly info: RuntimeInfo }
  }

  'workspace/recent': { params: Record<string, never>; result: readonly WorkspaceEntry[] }
  'workspace/open': { params: { readonly path: string }; result: WorkspaceEntry }
  'workspace/pick': { params: Record<string, never>; result: WorkspaceEntry | null }
  /** Removes a folder from the opened-workspaces list. The folder itself is untouched. */
  'workspace/forget': { params: { readonly path: string }; result: null }
  /**
   * Shows a folder in the OS file browser — Finder, on the Mac. Only folders
   * the user has opened qualify; the desktop shell supplies the hand-off and
   * a build without one says so.
   */
  'workspace/reveal': { params: { readonly path: string }; result: null }
  /**
   * File search, read and browse go through the selected runtime's own
   * filesystem view when it offers one (`runtime`), and HarnessDesk's local
   * reader otherwise. Either way the host confines reads and searches to the
   * workspaces the user has opened.
   */
  'workspace/files': {
    params: {
      readonly root: string
      readonly query: string
      readonly limit?: number
      readonly runtime?: RuntimeId
    }
    result: readonly FileMatch[]
  }
  'workspace/browse': {
    params: { readonly path?: string; readonly runtime?: RuntimeId }
    result: {
      readonly path: string
      readonly parent: string | null
      readonly entries: readonly { readonly name: string; readonly path: string }[]
    }
  }
  'workspace/readFile': {
    params: {
      readonly path: string
      readonly maxBytes?: number
      readonly runtime?: RuntimeId
      /** `base64` for binary content — a PDF for the preview. Text otherwise. */
      readonly encoding?: 'utf8' | 'base64'
    }
    result: {
      readonly content: string
      readonly truncated: boolean
      /** SHA-256 of the bytes read, for `file/save` to detect a write that raced. */
      readonly hash: string
    }
  }
  /**
   * A single-use, short-lived ticket for `GET /preview-frame`. The preview
   * iframe cannot carry the launch token — a previewed document can read its
   * own URL, and the token opens the whole wire — so each render gets a
   * ticket that grants exactly one read of exactly one confined file.
   */
  'preview/ticket': {
    params: { readonly path: string; readonly runtime?: RuntimeId }
    result: { readonly ticket: string }
  }
  'workspace/stat': {
    params: { readonly path: string; readonly runtime?: RuntimeId }
    result: FileMetadata
  }
  /**
   * Writes a file only if it is still what the editor loaded: `expectedHash`
   * is compared with the file's current content first, and a mismatch is
   * refused with the current content so the editor can show the conflict
   * rather than overwrite someone's change.
   */
  'file/save': {
    params: {
      readonly path: string
      readonly content: string
      readonly expectedHash: string
      readonly runtime?: RuntimeId
    }
    result:
      | { readonly saved: true; readonly hash: string }
      | { readonly saved: false; readonly conflict: { readonly content: string; readonly hash: string } }
  }

  /**
   * What the person did in an editor, on its way to whichever plugin drains
   * it. The renderer is the only thing that can know — the plane is host-owned
   * and pushed down, so this is the one direction that has to come back up.
   *
   * A report is not a request for anything: the host buffers it and answers
   * immediately, because a window must never wait on a plugin to finish
   * reading before the next keystroke lands.
   */
  'editor/report': { params: { readonly event: EditorEvent }; result: null }

  // -- terminals: host-owned, sandboxed by the runtime, survive a renderer reload
  'terminal/open': {
    params: {
      readonly runtime: RuntimeId
      readonly cwd: string
      readonly size: TerminalSize
      /** Run under this conversation's permissions. */
      readonly sessionId?: SessionId
      /** A one-off command instead of a shell; the terminal ends when it exits. */
      readonly command?: readonly string[]
    }
    /** `runtime` is who actually hosts the process — the requested runtime,
     *  or the one the host fell back to when the requested one runs nothing. */
    result: { readonly terminalId: string; readonly runtime: RuntimeId }
  }
  /** Re-joins a terminal after a reload: what it has printed so far, and whether it is still running. */
  'terminal/attach': {
    params: { readonly terminalId: string }
    result: {
      readonly scrollback: string
      readonly exitCode: number | null
      readonly size: TerminalSize
      readonly cwd: string
    }
  }
  'terminal/write': { params: { readonly terminalId: string; readonly data: string }; result: null }
  'terminal/resize': { params: { readonly terminalId: string; readonly size: TerminalSize }; result: null }
  'terminal/close': { params: { readonly terminalId: string }; result: null }

  // -- worktrees: one checkout per conversation that asks for one
  'worktree/list': { params: { readonly root: string }; result: readonly Worktree[] }
  'worktree/create': {
    /** `base` is the commit-ish the new branch starts from; HEAD when absent. */
    params: { readonly root: string; readonly name: string; readonly base?: string }
    result: Worktree
  }
  'worktree/changes': { params: { readonly path: string }; result: WorktreeChanges }
  /**
   * Refused with the list of what would be lost unless `force` is set. The
   * interface shows that list and asks before it ever sends `force`.
   */
  'worktree/remove': {
    params: { readonly path: string; readonly force?: boolean }
    result: { readonly branch: string | null }
  }

  // -- the team: one board and one channel per workspace, host-owned.
  // Agents reach the same state through plugin tools; these methods are the
  // person's half. Every change is pushed whole as a `team/changed`
  // notification, so reads outside a fresh connection are rare.
  'team/state': { params: { readonly room: string }; result: TeamState }
  /** The user adds work to the board. Agents use the `add_intent` tool instead. */
  'team/add': {
    params: {
      readonly room: string
      readonly title: string
      readonly detail?: string
      readonly files?: readonly string[]
      readonly dependsOn?: readonly number[]
      /** The goal this belongs to, when it came from one. */
      readonly plan?: number
    }
    result: Intent
  }
  /**
   * Name a goal. Creates nothing but the heading — the jobs are added to it
   * afterwards, so there is a moment in between where a person can look at
   * what is about to happen.
   */
  'team/plan': {
    params: { readonly room: string; readonly goal: string }
    result: Plan
  }
  /**
   * Put a finished goal away. Refused while anything on it is still live, and
   * the refusal names what — the jobs stay either way, as the record.
   */
  'team/wrap': {
    params: { readonly room: string; readonly plan: number }
    result: string
  }
  /**
   * The user's verbs over an intent: reopen it, abandon it, mark it done, stop
   * it, or take a claim away from an agent that stopped. The host is the
   * referee, so the person always outranks a claim.
   *
   * `block` is the newest and the one that needed a second field. Stopping
   * work was an agent-only verb — `release(blocked)`, which takes a reason —
   * so a person who knew a job should not be worked could only abandon it,
   * which says something different and permanent. The reason is not optional
   * in spirit: a card in Blocked that does not say what stopped it sends every
   * reader to the channel to find out. It is optional in the type only because
   * the wire cannot make a caller mean it.
   */
  'team/intent': {
    params: {
      readonly room: string
      readonly id: number
      readonly action: 'reopen' | 'abandon' | 'done' | 'release' | 'block'
      /** Why it is stopped. Read on `block`, ignored by the others. */
      readonly reason?: string
    }
    result: null
  }
  /**
   * The user posts into the channel — to one conversation, or to everyone
   * live on the board when `to` is absent. A post from the user carries
   * authority an agent's message never does, and the envelope says so.
   */
  'team/post': {
    params: {
      readonly room: string
      readonly text: string
      readonly to?: { readonly runtime: RuntimeId; readonly sessionId: SessionId }
    }
    result: null
  }
  /**
   * One message to many members, each with its own values: the template's
   * `{{name}}` slots are filled per recipient by the host, every rendering
   * is delivered at once, and the board is committed once. A room of a
   * hundred handed a page each is one action here where it was a hundred
   * posts, a hundred board writes and a hundred rows in the channel.
   */
  'team/handout': {
    params: {
      readonly room: string
      readonly template: string
      readonly recipients: readonly {
        readonly runtime: RuntimeId
        readonly sessionId: SessionId
        readonly vars?: Readonly<Record<string, string>>
      }[]
    }
    result: {
      readonly batch: string
      readonly delivered: number
      readonly queued: number
      readonly refused: number
    }
  }
  /** Board-only mode: false stops agents messaging; claims and signals continue. */
  'team/messaging': { params: { readonly room: string; readonly enabled: boolean }; result: null }
  /** Releases one held message to its receiver now. */
  'team/deliver': { params: { readonly room: string; readonly entryId: string }; result: null }
  /** Per-conversation inbound control: accept · hold · refuse. */
  'team/inbound': {
    params: {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly mode: TeamInbound
    }
    result: null
  }
  /**
   * Who a post can reach on this board, attested by the host. The renderer
   * must not guess this from folder prefixes: a worktree's conversation
   * belongs to the workspace its checkout hangs off, which only the host's
   * resolution knows.
   */
  /**
   * The rooms in one project. A project holds as many as the work wants, the
   * way it holds sessions, and each has a board of its own.
   */
  'team/rooms': { params: { readonly root: string }; result: readonly TeamState[] }
  'team/room/create': {
    params: { readonly root: string; readonly name: string }
    result: TeamState
  }
  'team/room/rename': { params: { readonly room: string; readonly name: string }; result: null }
  /**
   * Puts a room away for good. Never refused — the person is the referee on
   * this plane — and the result says what went, so the surface can report it.
   * The conversations that were in it are untouched and carry on.
   */
  'team/room/delete': {
    params: { readonly room: string }
    result: {
      readonly name: string
      readonly intents: number
      readonly members: number
      readonly messages: number
    }
  }
  /** Puts a conversation in a room; it leaves whichever room it was in. */
  'team/room/join': {
    params: { readonly room: string; readonly runtime: RuntimeId; readonly sessionId: string }
    result: null
  }
  'team/room/leave': {
    params: { readonly room: string; readonly runtime: RuntimeId; readonly sessionId: string }
    result: null
  }
  'team/peers': { params: { readonly room: string }; result: readonly TeamPeerInfo[] }

  'git/status': { params: { readonly root: string }; result: GitStatus | null }
  'git/branches': {
    params: { readonly root: string }
    result: readonly { readonly name: string; readonly current: boolean; readonly committedAt: number }[]
  }
  /** Checks a branch out (creating it when `create`); refuses on a dirty tree. */
  'git/checkout': {
    params: { readonly root: string; readonly branch: string; readonly create?: boolean }
    result: { readonly branch: string }
  }
  'git/diff': {
    params: { readonly root: string; readonly path?: string; readonly staged?: boolean }
    result: { readonly diff: string }
  }
  /**
   * A page of history. Tolerant on purpose: a folder that is not a
   * repository, or a repository before its first commit, is an empty page
   * rather than an error — `git/refs` is where "not a repository" is stated.
   */
  'git/log': {
    params: {
      readonly root: string
      readonly scope?: GitLogScope
      readonly skip?: number
      readonly limit?: number
      readonly query?: string
      readonly search?: GitLogSearch
    }
    result: GitLogPage
  }
  /** Null when `root` is not inside a repository. */
  'git/refs': { params: { readonly root: string }; result: GitRefsSummary | null }
  'git/commit': {
    params: { readonly root: string; readonly sha: string }
    result: GitCommitDetail
  }
  /** One file's patch at one commit; a merge is shown against its first parent. */
  'git/commitDiff': {
    params: { readonly root: string; readonly sha: string; readonly path: string }
    result: { readonly diff: string }
  }
  /** Creates a branch at a commit; with `checkout`, switches to it (refusing on a dirty tree). */
  'git/createBranch': {
    params: {
      readonly root: string
      readonly name: string
      readonly at: string
      readonly checkout?: boolean
    }
    result: { readonly branch: string }
  }
  /**
   * Stages and commits: the named files exactly (untracked ones included,
   * a staged rename widened to carry its origin), or, without `paths`,
   * everything — which is also how a conflicted merge or revert is
   * concluded. An explicitly empty list refuses rather than widening.
   */
  'git/commitAll': {
    params: { readonly root: string; readonly message: string; readonly paths?: readonly string[] }
    result: { readonly sha: string }
  }
  /**
   * Pulls the current branch from what it tracks. A conflicted merge stays
   * in the working tree with its files named; resolve and commit concludes
   * it — the same posture `git/merge` takes.
   */
  'git/pull': { params: { readonly root: string }; result: GitMergeOutcome }
  /** Pushes the current branch; a first push sets upstream on origin itself. */
  'git/push': { params: { readonly root: string }; result: { readonly summary: string } }
  /** Fetches every remote, pruning remote-tracking refs their remote dropped. */
  'git/fetch': { params: { readonly root: string }; result: { readonly summary: string } }
  /** Merges a revision into the current branch; conflicts stay, named. */
  'git/merge': {
    params: { readonly root: string; readonly ref: string }
    result: GitMergeOutcome
  }
  /** Rebases the current branch onto a revision; a conflict aborts it whole. */
  'git/rebase': {
    params: { readonly root: string; readonly onto: string }
    result: { readonly summary: string }
  }
  /** Checks a commit out detached; refuses on a dirty tree. */
  'git/checkoutCommit': { params: { readonly root: string; readonly sha: string }; result: null }
  'git/renameBranch': {
    params: { readonly root: string; readonly from: string; readonly to: string }
    result: null
  }
  /** Deletes a branch; unmerged work refuses unless `force`, the current branch always. */
  'git/deleteBranch': {
    params: { readonly root: string; readonly name: string; readonly force?: boolean }
    result: null
  }
  /** A tag at a commit — annotated when it carries a message. */
  'git/createTag': {
    params: { readonly root: string; readonly name: string; readonly at: string; readonly message?: string }
    result: null
  }
  'git/deleteTag': { params: { readonly root: string; readonly name: string }; result: null }
  /**
   * Moves the current branch to a commit. `hard` erases uncommitted work;
   * the dialog that sends it says so in red and asks again.
   */
  'git/reset': {
    params: { readonly root: string; readonly to: string; readonly mode: GitResetMode }
    result: null
  }
  /** Reverts one commit (a merge against its first parent); conflicts stay, named. */
  'git/revert': { params: { readonly root: string; readonly sha: string }; result: GitMergeOutcome }
  /** Cherry-picks one commit onto the current branch; merge commits refuse. */
  'git/cherryPick': { params: { readonly root: string; readonly sha: string }; result: GitMergeOutcome }
  /** Sets the working tree aside, untracked files included. */
  'git/stashSave': { params: { readonly root: string; readonly message?: string }; result: null }
  /** Applies a stash (`pop` drops it too); on conflict the entry is kept. */
  'git/stashApply': {
    params: { readonly root: string; readonly ref: string; readonly pop?: boolean }
    result: GitMergeOutcome
  }
  'git/stashDrop': { params: { readonly root: string; readonly ref: string }; result: null }
  /** One commit as a mail-format patch, the text `git am` takes. */
  'git/patch': {
    params: { readonly root: string; readonly sha: string }
    result: { readonly patch: string }
  }
  /** The plain difference between two revisions' trees. */
  'git/diffRange': {
    params: { readonly root: string; readonly from: string; readonly to: string }
    result: { readonly diff: string }
  }
  /**
   * Where "open a pull request for this branch" goes on the branch's forge.
   * Null when the remote is not a forge whose compare page is well-known.
   */
  'git/pullRequestUrl': {
    params: { readonly root: string; readonly branch: string }
    result: { readonly url: string | null }
  }

  // -- worktrees, as a git client manages them
  //
  // The `worktree/*` methods above are the session plane's: HarnessDesk cuts
  // a disposable checkout for a conversation and only ever removes its own.
  // These are the repository's, listed and managed whoever made them — the
  // person is at the wheel here, so the refusals are git's plus one of ours:
  // the main checkout is never removable, and a new worktree is made beside
  // the repository rather than at any path the socket names.
  /** Every checkout of the repository, with what each one is holding. */
  'git/worktrees': { params: { readonly root: string }; result: readonly GitWorktree[] }
  /**
   * Adds a worktree at `path` — relative to the repository's parent, which
   * is also the only place one may land. Refuses a path that already exists.
   */
  'git/worktreeAdd': {
    params: {
      readonly root: string
      readonly path: string
      readonly checkout: GitWorktreeCheckout
    }
    result: { readonly path: string; readonly branch: string | null }
  }
  /** Everything removing this worktree would delete, with the digest to confirm against. */
  'git/worktreeInventory': {
    params: { readonly root: string; readonly path: string }
    result: GitWorktreeInventory
  }
  /**
   * Removes a worktree. Refuses the main checkout always, and one holding
   * uncommitted work unless `force` — the dialog names the files first. The
   * branch is kept either way; a branch is cheap to keep, expensive to lose.
   *
   * A worktree with anything to lose — uncommitted *or* ignored, since git
   * deletes both — must carry `expect`, the `stateId` of the inventory the
   * caller was shown. A stale one is refused rather than obeyed: `force` is
   * authority over work someone saw, not over whatever is there by the time
   * the call lands.
   */
  'git/worktreeRemove': {
    params: {
      readonly root: string
      readonly path: string
      readonly force?: boolean
      readonly expect?: string
    }
    result: { readonly branch: string | null }
  }
  /** Drops the administrative records of worktrees whose directories are gone. */
  'git/worktreePrune': {
    params: { readonly root: string }
    result: { readonly summary: string; readonly removed: readonly string[] }
  }
  /** Locks a worktree against pruning, or unlocks it. */
  'git/worktreeLock': {
    params: {
      readonly root: string
      readonly path: string
      readonly locked: boolean
      readonly reason?: string
    }
    result: null
  }
  /** Moves a worktree's directory, keeping git's record of it correct. */
  'git/worktreeMove': {
    params: { readonly root: string; readonly from: string; readonly to: string }
    result: { readonly path: string }
  }

  // -- extension plane
  'plugin/list': { params: Record<string, never>; result: readonly PluginInstance[] }
  'plugin/setEnabled': {
    params: { readonly pluginId: string; readonly enabled: boolean }
    result: null
  }
  'plugin/configure': {
    params: { readonly pluginId: string; readonly config: Readonly<Record<string, unknown>> }
    result: null
  }
  /** Reads a plugin's manifest without installing or importing anything. */
  'plugin/inspect': {
    params: { readonly specifier: string }
    result: {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly version?: string
      readonly source: PluginSource
      /** Plain-language lines describing what it is asking for. */
      readonly permissions: readonly string[]
      readonly alreadyInstalled: boolean
    }
  }
  'plugin/install': {
    params: { readonly specifier: string }
    result: { readonly pluginId: string }
  }
  'plugin/uninstall': { params: { readonly pluginId: string }; result: null }

  'capability/list': {
    params: { readonly kind: ContributionKind } & ScopeQuery
    result: readonly CapabilityContribution[]
  }
  'command/run': {
    params: {
      readonly name: string
      readonly argument: string
      readonly runtime?: RuntimeId
      readonly sessionId?: SessionId
    }
    result: { readonly handled: boolean }
  }
  /** A context chip's text, produced by its plugin when the message is sent. */
  'context/resolve': {
    params: {
      readonly id: string
      readonly ref?: string
      readonly runtime?: RuntimeId
      /* Which conversation is asking. A provider that remembers anything
         remembers it per conversation, so a chip resolved without this is
         asking a question about nobody: `Last test run` looked up a session
         that had never run anything and refused the send. */
      readonly sessionId?: SessionId
      readonly workspaceRoot?: string
    }
    /** `image` when the provider took a picture — a screenshot chip. */
    result: { readonly label: string; readonly text: string; readonly image?: ContextImage }
  }

  // -- the backend's own extension plane, surfaced not replaced
  'runtime/catalog': {
    params: { readonly runtime: RuntimeId; readonly cwd?: string }
    result: RuntimeCatalog
  }
  'runtime/apps/search': {
    params: { readonly runtime: RuntimeId; readonly query: string; readonly cursor?: string | null }
    result: { readonly apps: readonly RuntimePlugin[]; readonly nextCursor?: string | null }
  }
  'runtime/plugin/install': {
    params: { readonly runtime: RuntimeId; readonly marketplace: string; readonly pluginName: string }
    result: null
  }
  'runtime/plugin/uninstall': {
    params: { readonly runtime: RuntimeId; readonly pluginId: string }
    result: null
  }
  'runtime/mcp/list': {
    params: { readonly runtime: RuntimeId; readonly cwd?: string }
    result: readonly McpServer[]
  }
  'runtime/mcp/login': {
    params: { readonly runtime: RuntimeId; readonly name: string }
    result: { readonly url: string }
  }
  'runtime/mcp/reload': { params: { readonly runtime: RuntimeId }; result: null }
  'runtime/imports/detect': {
    params: { readonly runtime: RuntimeId; readonly cwd?: string }
    result: readonly ImportableConfig[]
  }
  'runtime/imports/apply': {
    params: { readonly runtime: RuntimeId; readonly items: readonly ImportableConfig[] }
    result: null
  }

  'app/state/get': { params: Record<string, never>; result: Readonly<Record<string, unknown>> }
  'app/state/set': {
    params: { readonly patch: Readonly<Record<string, unknown>> }
    result: null
  }

  /**
   * The Chrome-like browsers installed on this machine, for the setting that
   * picks which one an agent's pages open in. Asked, not stored: somebody
   * installs Brave the week after they chose Chrome.
   */
  'app/browsers': { params: Record<string, never>; result: readonly InstalledBrowser[] }
}

/** One browser HarnessDesk found, and can start with remote debugging. */
export interface InstalledBrowser {
  readonly name: string
  readonly path: string
}

export type HostMethodName = keyof HostMethods
export type HostParams<M extends HostMethodName> = HostMethods[M]['params']
export type HostResult<M extends HostMethodName> = HostMethods[M]['result']

// ------------------------------------------------------------------ envelopes

export interface WireRequest<M extends HostMethodName = HostMethodName> {
  readonly id: number
  readonly method: M
  readonly params: HostParams<M>
}

export interface WireError {
  readonly code: string
  readonly message: string
  readonly details?: string | null
}

export type WireResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: WireError }

/**
 * Host-pushed state. `event` carries the agent stream; `sync` is sent to a
 * freshly connected client so it can render without replaying from zero.
 */
export type WireNotification =
  | {
      /**
       * One agent event, tagged with the runtime that produced it. Events
       * name sessions by the runtime's own id, so the tag is what lets a
       * client keep two runtimes' conversations apart.
       */
      readonly method: 'event'
      readonly params: { readonly runtime: RuntimeId; readonly event: AgentEvent }
    }
  | {
      /** Extension-plane state, streamed the same way agent events are. */
      readonly method: 'extension'
      readonly params: { readonly event: ExtensionEvent }
    }
  | {
      readonly method: 'sync'
      readonly params: {
        readonly sessions: readonly Session[]
        /**
         * What each conversation has waiting, for the conversations that have
         * anything. The queue is host state a reloading client must get back:
         * losing it on ⌘R is the bug queueing exists to fix.
         */
        readonly queues: readonly {
          readonly runtime: RuntimeId
          readonly sessionId: SessionId
          readonly queue: SessionQueue
        }[]
        /**
         * What each conversation has running in the background. Host state
         * for the same reason the queues are: a reload must not lose sight of
         * a job that is still going, and the runtime has no reason to
         * re-announce a list that has not changed.
         */
        readonly tasks: readonly {
          readonly runtime: RuntimeId
          readonly sessionId: SessionId
          readonly tasks: readonly BackgroundTask[]
        }[]
        readonly runtimes: readonly RuntimeInfo[]
        /**
         * Every runtime's health, so a freshly connected client can draw the
         * broken ones broken without a request per agent. Kept current by
         * `runtime/healthChanged`; this is only the starting point.
         */
        readonly health?: readonly {
          readonly runtime: RuntimeId
          readonly health: RuntimeHealth
        }[]
        readonly plugins: readonly PluginInstance[]
        readonly contributions: readonly CapabilityContribution[]
      }
    }
  | {
      /**
       * A runtime's description changed after the client last read it — its
       * version was discovered late, or an update was found to be available.
       * Carries the whole `RuntimeInfo`, so the client replaces rather than
       * merges.
       */
      readonly method: 'runtime/infoChanged'
      readonly params: { readonly runtime: RuntimeId; readonly info: RuntimeInfo }
    }
  | {
      readonly method: 'runtime/healthChanged'
      readonly params: { readonly runtime: RuntimeId; readonly health: RuntimeHealth }
    }
  | {
      /**
       * A runtime joined the set after the client synced — a second account of
       * an agent that already had one. The list arrives whole in `sync` and
       * `host/hello`, so without this a new account would stay invisible until
       * the window was reloaded.
       */
      readonly method: 'runtime/added'
      readonly params: { readonly info: RuntimeInfo }
    }
  | {
      readonly method: 'runtime/removed'
      readonly params: { readonly runtime: RuntimeId }
    }
  | {
      /** Base64 output from a terminal. Every client receives it; a pane shows its own. */
      readonly method: 'terminal/output'
      readonly params: { readonly terminalId: string; readonly stream: 'stdout' | 'stderr'; readonly data: string }
    }
  | {
      readonly method: 'terminal/exited'
      readonly params: { readonly terminalId: string; readonly exitCode: number }
    }
  | {
      /**
       * One account's usage was re-read. Sent per report rather than as a whole
       * list, so a slow source never delays a fast one.
       */
      readonly method: 'usage/updated'
      readonly params: { readonly report: UsageReport }
    }
  | { readonly method: 'usage/scanProgress'; readonly params: { readonly progress: ScanProgress } }
  | {
      /**
       * The editor plane, whole.
       *
       * Sent complete rather than as a delta, for the reason the extension
       * host sends its snapshot complete: the plane is small, a client that
       * connected late must be able to render it without replaying, and a
       * merge of partial updates is a second implementation of the same
       * state that can drift from the first.
       */
      readonly method: 'editor/plane'
      readonly params: { readonly documents: readonly EditorDocument[] }
    }
  | {
      /**
       * One workspace's team surface, whole — the board and the channel —
       * sent complete for the reason the editor plane is, and replayed to a
       * client that has just connected for every workspace with a board.
       */
      readonly method: 'team/changed'
      readonly params: { readonly state: TeamState }
    }
  | {
      /**
       * A room that no longer exists. `team/changed` can only ever say what a
       * room *is*, so without this a deleted one stayed in the sidebar until
       * the next launch — present, openable, and backed by nothing.
       */
      readonly method: 'team/removed'
      readonly params: { readonly room: string }
    }
  | { readonly method: 'host/shutdown'; readonly params: { readonly reason: string } }

export type ClientToHost = WireRequest
export type HostToClient = WireResponse | WireNotification

export const isNotification = (message: HostToClient): message is WireNotification =>
  typeof (message as WireNotification).method === 'string'

export const isResponse = (message: HostToClient): message is WireResponse =>
  typeof (message as WireResponse).id === 'number' &&
  typeof (message as WireNotification).method !== 'string'
