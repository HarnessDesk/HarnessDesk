import type { ApprovalDecision } from './approval.js'
import type { AgentEvent } from './events.js'
import type { ApprovalId, RuntimeId, SessionId, TurnId } from './ids.js'
import type { UserContent } from './items.js'
import type { ConfigOption, OptionValue } from './options.js'
import type { BackgroundTask } from './tasks.js'
import type { FileMatch } from './wire.js'
import type {
  RateLimits,
  Session,
  SessionOptions,
  SessionSettings,
  SessionSummary,
} from './session.js'

/**
 * The contract every backend implements. Adding a runtime means implementing
 * this and nothing else — the host, the wire protocol, and the UI are already
 * written against it.
 */

/**
 * A model the runtime can run, for display in the catalogue. Choosing one is
 * done through the session's `model` option, which is where the runtime says
 * what is selectable *right now*; this is the descriptive view.
 */
export interface ModelInfo {
  readonly id: string
  readonly displayName: string
  readonly description?: string
  /** The runtime's own names for its reasoning levels, if the model has any. */
  readonly reasoningLevels: readonly { readonly id: string; readonly label: string }[]
  readonly supportsImages: boolean
  /**
   * Whether the model reasons before it answers, when that is a property of
   * the model rather than a level of effort.
   *
   * `optional` means there is a switch: Cursor's Claude families ship a
   * thinking and a non-thinking variant of each effort. `always` means it
   * thinks and cannot be told not to. Absent means the model has no such
   * control — which is not the same as "does not think", only that nothing
   * about it is ours to set.
   */
  readonly thinking?: 'optional' | 'always'
  readonly isDefault?: boolean
  readonly hidden?: boolean
}

/**
 * One identity the runtime is signed in as.
 *
 * A list of these replaces a single nullable email because runtimes model
 * identity in more than one way at once — Codex alone distinguishes an API
 * key, a ChatGPT subscription carrying an email and a plan, and an AWS Bedrock
 * identity carrying neither — and a runtime with no account at all is the
 * empty list rather than a third enum value.
 */
export interface Account {
  /**
   * The runtime's own name for this kind of identity. Opaque to the shell,
   * which uses it only as a stable key; `label` is what gets rendered.
   */
  readonly kind: string
  /** What to show for this identity — an email, "API key", a workspace name. */
  readonly label: string
  readonly email?: string | null
  /** Subscription tier, where the runtime has the concept. */
  readonly planType?: string | null
  /**
   * The runtime saw that it is signed in but cannot say as whom — an ACP
   * agent whose session opened, with no status command to name the person.
   * `label` is then a state ("Signed in") rather than an identity, and a
   * surface that names accounts uses the agent's own name instead.
   */
  readonly anonymous?: boolean
}

/**
 * A way of signing in that the runtime can drive on the interface's behalf.
 *
 * Declared by the runtime rather than assumed by the shell: a managed Codex
 * configuration can force one method, a local model has none, and an ACP agent
 * names its own. `flow` says what the shell will have to render once the
 * method is started, and nothing else.
 */
export interface AuthMethod {
  readonly id: string
  readonly label: string
  readonly description?: string
  /**
   * `browser`: starting it returns a URL to open, and the runtime finishes the
   * flow on its own. `deviceCode`: it returns a URL plus a one-time code to
   * show. `external`: the runtime cannot drive it from here; `description`
   * says what to do instead. `apiKey`: the agent authenticates with a secret
   * the user pastes — the shell collects it, the credential broker keeps it,
   * and the value never reaches the renderer again.
   */
  readonly flow: 'browser' | 'deviceCode' | 'external' | 'apiKey'
  /** `apiKey` only: where the user gets one. */
  readonly helpUrl?: string
  /** `apiKey` only: what the field is called, e.g. "DeepSeek API key". */
  readonly keyLabel?: string
}

export interface AccountStatus {
  readonly accounts: readonly Account[]
  /** How to sign in from here. Empty when the runtime has nothing it can drive. */
  readonly signInMethods: readonly AuthMethod[]
}

/**
 * What to review. The kinds are the ones a code agent has in common — the
 * working tree, a branch, a commit, or free-form instructions — so the shape
 * is shared rather than Codex's.
 */
export type ReviewRequest =
  | { readonly type: 'uncommitted'; readonly delivery?: 'inline' | 'detached' }
  | { readonly type: 'baseBranch'; readonly branch: string; readonly delivery?: 'inline' | 'detached' }
  | { readonly type: 'commit'; readonly sha: string; readonly delivery?: 'inline' | 'detached' }
  | { readonly type: 'custom'; readonly instructions: string; readonly delivery?: 'inline' | 'detached' }

/** What starting a sign-in produced, and therefore what the shell has to show. */
export type LoginStart =
  | { readonly type: 'browser'; readonly loginId: string; readonly url: string }
  | {
      readonly type: 'deviceCode'
      readonly loginId: string
      readonly url: string
      readonly code: string
    }

/** What a runtime can do, so the UI can hide controls rather than fail calls. */
export interface RuntimeCapabilities {
  readonly resume: boolean
  readonly fork: boolean
  readonly steer: boolean
  readonly interrupt: boolean
  readonly listHistory: boolean
  readonly searchHistory: boolean
  readonly imageInput: boolean
  readonly mcp: boolean
  readonly skills: boolean
  readonly plans: boolean
  readonly reasoning: boolean
  /** Reports quota or credit balance. Runtimes on a local model do not. */
  readonly metered: boolean
  /** Has an account to sign in to at all. */
  readonly account: boolean
  /** Supports a standing objective per session. */
  readonly goals: boolean
  /** Can drop the last N turns from a conversation — `AgentSession.rollback`. */
  readonly undo: boolean
  /** Can compact a conversation on demand — `AgentSession.compact`. */
  readonly compaction: boolean
  /** Has a per-conversation memory that can be turned on and off — `AgentSession.setMemoryMode`. */
  readonly memory: boolean
  /** Can review a set of changes on a side thread — `AgentSession.review`. */
  readonly review: boolean
  /**
   * The runtime keeps an archive of its own, and `archiveSession` reaches it.
   *
   * False is the common answer: ACP has no archive method, so Claude Code and
   * Cursor have nowhere to put one. It does not mean the user cannot archive
   * — the host keeps the mark for those runtimes and applies it to their
   * listings — only that the agent's own window will not agree, which is the
   * truth and the reason the flag exists.
   */
  readonly archiveHistory: boolean
  /**
   * The runtime keeps the conversation's name, and `setTitle` reaches it.
   *
   * False is the common answer, and for the same reason as the archive: ACP's
   * session surface has no way to name anything, so Claude Code, Cursor and
   * every other agent behind the bridge had nowhere to put a name and
   * renaming one failed outright. It does not mean the user cannot name a
   * conversation — the host keeps the name for those runtimes and serves it
   * everywhere a title is read — only that the agent's own window will go on
   * calling it whatever it called it, which is the truth and the reason the
   * flag exists.
   */
  readonly nameHistory: boolean
  /**
   * The runtime can remove a stored conversation for good — `deleteSession`.
   *
   * The one capability the interface must not guess at. An agent that cannot
   * delete gets a disabled row with the reason, never a Delete that throws
   * after the confirmation has already promised the conversation is gone.
   */
  readonly deleteHistory: boolean
  /** Surfaces a plugin catalogue — `RuntimeExtensions.catalog`. */
  readonly extensionStore: boolean
  /** Exposes configured hooks — `AgentRuntime.listHooks`. */
  readonly hooks: boolean
  /** HarnessDesk's plugin tools reach this runtime's sessions. */
  readonly pluginTools: boolean
  /**
   * A standing instruction the desk hands the agent reaches it through the
   * agent's own instruction layer — Codex's developer instructions, a
   * bridge's system-prompt append — and never through the conversation. An
   * agent without this hears it only through the tool server it accepts, or
   * not at all; the desk never puts the sentence in the person's message.
   */
  readonly instructions: boolean
  /**
   * The runtime keeps a registry of work that outlives a turn, and will
   * answer for it. See `RuntimeTasks`.
   *
   * False is the honest answer for most agents rather than a gap: an agent
   * whose commands all end with the turn has no background tasks to show, and
   * an empty panel would suggest it lost some.
   */
  readonly backgroundTasks: boolean
}

/**
 * What a runtime may claim before it has observed anything: nothing.
 *
 * Capabilities are observations, not defaults. An adapter that has not
 * completed a handshake with its agent has observed nothing, and an agent
 * that cannot start can do nothing — so this is the honest starting point,
 * with each true arriving only once the runtime has seen the evidence for
 * it. Spread it and override the facts that genuinely hold without a live
 * process (an account answered by a CLI, say).
 */
export const NO_CAPABILITIES: RuntimeCapabilities = {
  resume: false,
  fork: false,
  steer: false,
  interrupt: false,
  listHistory: false,
  searchHistory: false,
  imageInput: false,
  mcp: false,
  skills: false,
  plans: false,
  reasoning: false,
  metered: false,
  account: false,
  goals: false,
  undo: false,
  compaction: false,
  memory: false,
  review: false,
  archiveHistory: false,
  nameHistory: false,
  deleteHistory: false,
  extensionStore: false,
  hooks: false,
  pluginTools: false,
  instructions: false,
  backgroundTasks: false,
}

/**
 * The runtime's own words for the few things a shell has to say *about* it.
 *
 * Without this, the interface ends up asserting things only one runtime makes
 * true — "run `codex login`", "sessions from the VS Code extension appear here",
 * "out of credits" — and every one of those becomes a lie the moment a second
 * runtime is selected. A runtime that wants to be described accurately describes
 * itself; the shell renders what it is given and invents nothing.
 */
export interface RuntimePresentation {
  /** What to call it in the interface. */
  readonly name: string
  /**
   * Whose mark to draw beside the name: a lobe-icons key such as `codex`,
   * `claudecode`, `cursor`, `geminicli`, `githubcopilot`. Optional — the
   * interface infers the common ones from the name — but a runtime that knows
   * what it is should say so rather than be guessed at.
   */
  readonly brand?: string
  /** One line on what it is, for the runtime picker. */
  readonly tagline?: string
  /**
   * Where sessions in the sidebar come from, phrased to complete
   * "Sessions you start in … appear here too". Omit when history is local only.
   */
  readonly historySource?: string
  /** How a person signs in and out, when there is an account. */
  readonly signIn?: { readonly command?: string; readonly url?: string }
  readonly signOut?: { readonly command?: string }
  /** Where the runtime keeps its own configuration, e.g. `~/.codex`. */
  readonly configLocation?: string
  /** What this runtime calls reusable instruction bundles, if it has them. */
  readonly skillsLabel?: string
  /**
   * How to install it, shown when it is missing. `package` is its npm name,
   * when it is published there, so the host can tell when a newer one exists
   * — see `RuntimeInfo.update`.
   */
  readonly install?: { readonly command?: string; readonly url?: string; readonly package?: string }
}

/**
 * A newer build of the runtime than the one running, when the host can tell.
 *
 * Advisory only: nothing is blocked and nothing is installed. It exists so
 * that a model list which has stopped growing — an agent too old to read its
 * own vendor's catalogue — is explained next to the list, rather than left as
 * a mystery the user has to take to a terminal.
 */
export interface RuntimeUpdate {
  readonly version: string
  /** What to run to get it, when the runtime's presentation knows. */
  readonly command?: string
  readonly url?: string
}

/**
 * The road a copy of an agent took onto this machine, read off its path.
 * `harnessdesk` is the desk's own download; everything else is the person's,
 * which the desk names an update command for and never runs itself.
 */
export type InstallChannel =
  | 'harnessdesk'
  | 'homebrew'
  | 'npm-global'
  | 'bun'
  | 'uv-tool'
  | 'pipx'
  | 'cargo'
  | 'app-bundle'
  | 'installer'
  | 'path'

/**
 * Where one copy stands: `chosen` runs, `pinned` runs because the person
 * said so, `older` is a fine copy outranked by a newer one, `too-old`
 * cannot do the job, `unreadable` never answered for its version.
 */
export type InstallStanding = 'chosen' | 'pinned' | 'older' | 'too-old' | 'unreadable'

/** One copy of the agent found on this machine. */
export interface InstallCopy {
  readonly path: string
  readonly version: string | null
  readonly channel: InstallChannel
  /** The channel as a word, completing "installed via …". */
  readonly channelLabel: string
  readonly standing: InstallStanding
  /** True for the desk's own download, which the desk may replace. */
  readonly managed: boolean
  /** What to run to update this copy, when its road has a verb; null for the desk's own. */
  readonly updateCommand: string | null
}

/**
 * Every copy of an agent on this machine and which one answers — attached
 * by the host for runtimes whose agent it knows how to look for. The rule
 * is Codex's: the newest copy that is new enough runs, unless one is
 * pinned; the row's own command (a registry download, a package runner) is
 * the fallback when nothing installed qualifies.
 */
export interface InstallInfo {
  readonly copies: readonly InstallCopy[]
  /** The installed copy that answers; null when the fallback does. */
  readonly chosen: InstallCopy | null
  readonly policy: 'newest' | 'pinned'
  /** What the row itself runs when no installed copy is chosen. */
  readonly fallback: {
    readonly command: string
    readonly version: string | null
    /** True when the fallback is a download the desk made and can replace. */
    readonly managed: boolean
  } | null
  /** The oldest version that can do the job, and why, when there is a floor. */
  readonly minVersion?: string
  readonly minVersionReason?: string
  /** A newer build the desk itself can install, for a managed fallback. */
  readonly registryUpdate?: { readonly version: string } | null
  /** Where the agent keeps its own world, and the variable that moves it. */
  readonly home?: { readonly path: string; readonly env?: string; readonly note?: string }
  /** How a person signs in, when the desk cannot drive it: the terminal command, and why. */
  readonly signIn?: { readonly terminal?: string; readonly note: string }
  /** The one-line install for a machine with no copy at all. */
  readonly installCommand?: string
  readonly checkedAt: number
}

export interface RuntimeInfo {
  readonly id: RuntimeId
  readonly name: string
  /** Version of the underlying agent binary, once discovered. */
  readonly version?: string | null
  /** Attached by the host when a newer version is published. See `RuntimeUpdate`. */
  readonly update?: RuntimeUpdate | null
  /**
   * When the host last re-asked this runtime what it offers (models, modes,
   * levels) — see `AgentRuntime.refreshCatalog`. Attached by the host; null
   * until the first refresh after start.
   */
  readonly catalogCheckedAt?: number | null
  /**
   * Set when the runtime is a bridge driving a separate agent CLI — an ACP
   * shim that wraps Claude Code, say. `version` above is then the bridge's,
   * and this is the agent's, which is the one that decides what models
   * exist. Null when the bridge is running its own embedded copy.
   */
  readonly drives?: { readonly command: string; readonly version: string | null } | null
  /**
   * Every copy of the agent on this machine and which one answers. Attached
   * by the host, which is the only layer that knows where to look; absent
   * for a runtime whose agent the host has no table for.
   */
  readonly install?: InstallInfo | null
  readonly capabilities: RuntimeCapabilities
  readonly presentation: RuntimePresentation
  /**
   * `registry` when this runtime exists because the user's agent registry
   * names it — which is what makes it removable from the interface. Attached
   * by the host; absent for built-in discovery (Codex) and account slots,
   * which have removal stories of their own.
   */
  readonly origin?: 'registry'
  /**
   * The wire protocols this backend can speak to a model endpoint, e.g.
   * `['responses']`. What decides whether a model route can be offered: a
   * route whose protocol the backend cannot speak is shown greyed with the
   * reason, never hidden. Empty or absent means routes are not applicable.
   */
  readonly supportedWireProtocols?: readonly string[]
  /**
   * Which agent this runtime is *one account of*, when the machine holds more
   * than one. Attached by the host, never declared by the runtime: an agent
   * that keeps a single credential — Codex keeps one `auth.json` — is given
   * several accounts by running it several times over separate credential
   * homes, and only the wiring knows it did that.
   *
   * Absent for an agent with one account, which is every agent until someone
   * adds a second.
   */
  readonly slot?: {
    /** The primary runtime's id; every account of one agent shares it. */
    readonly agent: RuntimeId
    /** Where this account's credential lives, for the settings page to name. */
    readonly home: string | null
    /** False for the agent's original account, which owns the real home. */
    readonly removable: boolean
    /** Whether the host can make one more account of this agent. */
    readonly canAdd: boolean
    /**
     * Set when this account reaches the model through an endpoint of the
     * user's own — an API key or a gateway — rather than the vendor plan the
     * primary signs into. The agent and its models are unchanged; only who
     * pays is. Absent on a plan account, which is the common case.
     *
     * The credential is not here and never travels: what the renderer gets is
     * the name the user gave it and where it points.
     */
    readonly gateway?: {
      readonly name: string
      readonly endpoint: string
    }
  }
}

/**
 * Whether the runtime can be used right now, and if not, what the user should
 * do about it. The UI renders this directly on the first-run screen.
 */
export type RuntimeHealth =
  | { readonly state: 'ready' }
  | { readonly state: 'starting' }
  | {
      readonly state: 'unavailable'
      readonly reason: 'notInstalled' | 'versionTooOld' | 'crashed' | 'unknown'
      readonly message: string
      readonly remediation?: string
    }

/**
 * A definition an agent read and would not load, in the agent's own words.
 *
 * The distinction this exists for: from disk, a bundle whose `SKILL.md` an
 * agent *rejects* and one it has simply not re-read yet are the same bundle.
 * The library could not tell them apart and called both "not loaded yet",
 * which is right about the second and permanently wrong about the first —
 * restarting the agent repeats the rejection for ever.
 *
 * Measured on Codex 0.149.0 (2026-09-06): `skills/list` answers with an
 * `errors` array beside the skills, one entry per file it refused, naming the
 * file and the reason — "missing YAML frontmatter delimited by ---", "missing
 * field `description`". The agent already knows; nothing here has to guess.
 *
 * `path` is the agent's own spelling, which is the definition file rather
 * than the bundle directory — the same difference `LibraryReach.reportedPath`
 * documents.
 */
export interface SkillProblem {
  readonly path: string
  readonly message: string
}

/** A reusable instruction bundle the runtime exposes to the agent. */
export interface SkillInfo {
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  readonly path?: string | null
  /**
   * Where it came from. Runtimes that distinguish report one of `user`
   * (the person's own), `repo` (the open project's), `system` (shipped with
   * the runtime) or `admin` (managed); anything else is shown as-is.
   */
  readonly scope?: string
  /**
   * Whether this client may turn it off. Absent means yes. False is for a
   * runtime that can only *say* what it has — an ACP agent declares its
   * commands and offers no way to disable one — so the interface shows the
   * list without a switch that would always fail.
   */
  readonly toggleable?: boolean
  /** The name as a sentence — "Add Admin Task" for `add-admin-task`. */
  readonly displayName?: string
  /** A one-line summary for lists; `description` keeps the full text. */
  readonly shortDescription?: string | null
  /**
   * An icon the runtime supplied, as a `data:` URI. Never a remote URL: the
   * renderer is single-origin and its CSP allows `img-src 'self' data: blob:`,
   * so an adapter inlines the installed skill's own icon file or sends null.
   */
  readonly iconUrl?: string | null
  /** The skill's own accent, for a tile when there is no icon. */
  readonly brandColor?: string | null
}

/**
 * A hook the runtime runs around the agent's work, shown so a user can see
 * what is wired in and whether the runtime trusts it. Read-only here — hooks
 * are configured on disk, and editing them is the runtime's job.
 */
export interface HookInfo {
  readonly id: string
  readonly event: string
  readonly source: string
  /** The runtime's own trust verdict — trusted, untrusted, managed, or modified. */
  readonly trust: string
  readonly enabled: boolean
  /** True when a managed policy installed it; such a hook cannot be turned off locally. */
  readonly managed: boolean
}

export interface Page<T> {
  readonly data: readonly T[]
  readonly nextCursor?: string | null
}

export interface ListSessionsQuery {
  readonly cursor?: string | null
  readonly pageSize?: number
  /** Restrict to sessions rooted at this directory. */
  readonly cwd?: string
  /**
   * Which side of the archive to answer with. Two values rather than a
   * boolean because no backend offers a third: Codex's `thread/list` takes
   * `archived`, where true returns *only* archived threads, and the host's
   * own archive — the one every agent that keeps none is given — can filter
   * either way but has no use for a mixed list. A screen showing the archive
   * asks for `only`; everything else takes the default.
   */
  readonly archived?: ArchiveFilter
}

/** `exclude` is the default everywhere: the archive is somewhere you go. */
export type ArchiveFilter = 'exclude' | 'only'

/**
 * What a delete actually did, for the interface to report afterwards.
 *
 * The difference matters to the person who clicked. `trash` means the
 * conversation is sitting in the OS trash and can be dragged back out;
 * `removed` means it is gone. Saying "moved to the Trash" about an erasure
 * would be the worst kind of reassuring.
 */
export interface SessionDeletion {
  readonly disposition: 'trash' | 'removed'
  /** How many files or folders moved, when the runtime counted them. */
  readonly removed?: number
}

export type Unsubscribe = () => void

export interface FileEntry {
  readonly name: string
  readonly kind: 'file' | 'directory' | 'other'
}

export interface FileMetadata {
  readonly kind: 'file' | 'directory' | 'other'
  readonly isSymlink: boolean
  readonly modifiedAt: number | null
}

/**
 * Files as the runtime sees them.
 *
 * Offered by a runtime that has its own view of the filesystem — Codex's
 * `fs/*` and `fuzzyFileSearch` — so that what the person browses and what the
 * agent reads are the same thing, and so `@` mentions rank the way the
 * runtime's other clients rank them. A runtime without one gets HarnessDesk's
 * local reader instead, chosen by this member's absence rather than by a
 * failed call.
 *
 * This is a view, not a sandbox. Codex's `fs/*` reads and writes anywhere the
 * process can (observed on 0.135.0: `/etc/hosts` under a read-only thread),
 * so confinement to the open workspace is the host's job, whichever reader
 * serves the call.
 */
export interface RuntimeFiles {
  /** Ranked by the runtime's own matcher. An empty query may return nothing. */
  search(roots: readonly string[], query: string, limit: number): Promise<readonly FileMatch[]>
  read(path: string): Promise<Uint8Array>
  /** Absent for a runtime whose view is read-only. */
  write?(path: string, data: Uint8Array): Promise<void>
  list(path: string): Promise<readonly FileEntry[]>
  stat(path: string): Promise<FileMetadata>
  /**
   * Reports changes under `path`. Codex's watch is not recursive: a change in
   * a subdirectory is not reported, so a caller showing a tree watches each
   * directory it shows.
   */
  watch(path: string, listener: (changedPaths: readonly string[]) => void): Promise<Unsubscribe>
}

export interface TerminalSize {
  readonly rows: number
  readonly cols: number
}

/** A process the runtime is running on the interface's behalf, inside its sandbox. */
export interface RuntimeProcess {
  write(data: Uint8Array): Promise<void>
  /** Only meaningful for a process spawned with a PTY. */
  resize(size: TerminalSize): Promise<void>
  kill(): Promise<void>
  onOutput(listener: (stream: 'stdout' | 'stderr', data: Uint8Array) => void): Unsubscribe
  /** Fires once. `exitCode` is -1 when the runtime could not say. */
  onExit(listener: (exitCode: number) => void): Unsubscribe
}

/**
 * Commands run by the runtime, in its sandbox, for the person rather than
 * for the agent — the integrated terminal and one-off palette actions.
 *
 * The point is the sandbox: a terminal HarnessDesk spawned itself would run
 * outside whatever the agent is confined to, and a person typing `rm -rf` in
 * it would be doing what the agent cannot. With `session`, the process runs
 * under that conversation's permissions; without, under the runtime's
 * defaults. Codex's `process/spawn` is deliberately not used here — it is
 * documented, and was observed, to run without a sandbox.
 */
/**
 * Work the *agent* started that outlives the turn — see `BackgroundTask`.
 *
 * The mirror image of `RuntimeProcesses`: there, the person asks and the
 * runtime runs it; here, the agent asked, the runtime is already running it,
 * and this is the window onto what it has going. The runtime owns the
 * processes either way — HarnessDesk asks, it never spawns.
 *
 * Offered only by a runtime with a real registry behind it. An adapter that
 * would have to infer the list from its own transcript should leave this out:
 * a task's whole point is that it outlives the turn its row sits in, so a
 * reconstruction is wrong exactly when it matters.
 */
export interface RuntimeTasks {
  /**
   * Everything the runtime knows about for this conversation, running and
   * finished, in no particular order — `orderTasks` decides that.
   */
  list(session: SessionId): Promise<readonly BackgroundTask[]>
  /**
   * Ends one. `false` when the runtime does not know the id, or would not —
   * an already-finished task is `false`, not an error, because two windows
   * can press the same button.
   */
  stop(session: SessionId, taskId: string): Promise<boolean>
  /**
   * Lets the runtime forget the tasks that have finished. Optional: a runtime
   * whose list is the *live* set has nothing to forget, and the host drops its
   * own memory of them either way.
   */
  clear?(session: SessionId): Promise<void>
}

export interface RuntimeProcesses {
  spawn(options: {
    readonly cwd: string
    readonly command: readonly string[]
    readonly tty: boolean
    readonly size?: TerminalSize
    readonly session?: SessionId
  }): Promise<RuntimeProcess>
}

/**
 * A plugin in a backend's own catalogue, flattened for a store view: what to
 * show (name, description, category, logo, screenshots, reviews), where it
 * came from (marketplace), and what can be done with it (install, enable).
 * Codex's `plugin/list` and `app/list` both normalise onto this.
 */
export interface RuntimePlugin {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly category?: string
  readonly developer?: string
  /**
   * The listing's logo, as a `data:` URI. Never a remote URL — see the note on
   * `SkillInfo.iconUrl`. In practice only installed entries carry one, because
   * a catalogue's logo lives on the catalogue's own host.
   */
  readonly logoUrl?: string | null
  /** The listing's accent colour, for a tile when there is no logo. */
  readonly brandColor?: string | null
  readonly screenshotUrls?: readonly string[]
  readonly keywords?: readonly string[]
  /** The marketplace it belongs to, for install and for grouping. */
  readonly marketplace?: string
  readonly installed: boolean
  /**
   * Whether the runtime will actually run it.
   *
   * Not the other half of a switch — nothing here can set it. Codex reports
   * an installed plugin as disabled when an administrator, the account's
   * plan, or a missing dependency has taken it away, and a row that drew
   * only `installed` said "Installed" over a plugin that would never run.
   */
  readonly enabled: boolean
  /** Why it is off, in the runtime's own words, when it says. */
  readonly disabledReason?: string | null
  /** True for an app-store listing that is authenticated/linked rather than installed on disk. */
  readonly external?: boolean
  /** Where to go to install or link it, when that happens outside HarnessDesk. */
  readonly installUrl?: string | null
}

export interface RuntimeCatalog {
  readonly plugins: readonly RuntimePlugin[]
  readonly marketplaces: readonly string[]
  /** A marketplace that failed to load, so a silently broken one is a message, not a gap. */
  readonly loadErrors: readonly { readonly source: string; readonly message: string }[]
  readonly featured: readonly string[]
}

export type McpAuth = 'none' | 'oauth' | 'token' | 'needsLogin'

/** One MCP server the backend has configured, and what it is offering right now. */
export interface McpServer {
  readonly name: string
  readonly tools: readonly string[]
  readonly resources: number
  readonly auth: McpAuth
}

/**
 * A backend's own extension plane, surfaced rather than replaced. HarnessDesk
 * runs no registry of its own here: it renders what the backend reports and
 * drives the backend's install, enable, and MCP-login flows. Optional, and
 * gated by `RuntimeCapabilities.extensions` / `.mcp` — a backend without one
 * simply has no store or servers view.
 */
/**
 * A configuration the runtime found from another agent that it can import —
 * skills, MCP servers, sessions, and so on from Claude Code or elsewhere. The
 * `token` is opaque: the shell shows `label` and passes the token back to
 * import, without knowing what is inside.
 */
export interface ImportableConfig {
  readonly kind: string
  readonly label: string
  readonly token: unknown
}

export interface RuntimeExtensions {
  catalog(cwd?: string): Promise<RuntimeCatalog>
  /** What could be imported from other agents on this machine. Empty when nothing, or unsupported. */
  detectImports(cwd?: string): Promise<readonly ImportableConfig[]>
  /** Imports the chosen configurations. */
  importConfigs(items: readonly ImportableConfig[]): Promise<void>
  /**
   * Searches the backend's app/connector directory, which is far larger than
   * the plugin catalogue — thousands of entries on Codex — so it is queried,
   * not listed. An empty query returns the first page.
   */
  searchApps(query: string, cursor?: string | null): Promise<{ readonly apps: readonly RuntimePlugin[]; readonly nextCursor?: string | null }>
  install(marketplace: string, pluginName: string): Promise<void>
  uninstall(pluginId: string): Promise<void>
  mcpServers(cwd?: string): Promise<readonly McpServer[]>
  /** Starts a server's OAuth flow; the URL is opened in the browser. */
  mcpLogin(name: string): Promise<string>
  /** Re-reads MCP configuration from disk. */
  reloadMcp(): Promise<void>
}

/**
 * What `AgentRuntime.checkInstallation` found: the same build as before, or a
 * different one — and whether the runtime moved onto it. It moves only when
 * idle; a runtime with a turn in flight reports the change and waits to be
 * asked again.
 */
export type InstallationCheck =
  | { readonly changed: false }
  | {
      readonly changed: true
      readonly from: string | null
      readonly to: string | null
      readonly restarted: boolean
    }

/**
 * What a catalogue refresh actually did.
 *
 * `reason` is a sentence for a person, not a code: the two ways a refresh
 * declines are "a turn is in flight" and "this agent keeps no sessions and
 * some are open", and both are things somebody can wait out or act on. It is
 * absent when the refresh happened.
 */
export interface CatalogRefresh {
  readonly refreshed: boolean
  readonly reason?: string
}

/** What telling a runtime its secret changed actually achieved. */
export type SecretReload = 'restarted' | 'busy' | 'unsupported'

export interface AgentRuntime {
  readonly info: RuntimeInfo

  /**
   * Where this runtime's conversations are stored, when the store is one it
   * can be sharing with another runtime. Two runtimes answering with the same
   * string are looking at the same conversations, and a session id means the
   * same thing to both.
   *
   * Two accounts of one agent share a store — a Codex account slot's home is
   * the agent's own home in symlinks — and the agent underneath usually
   * permits exactly one live writer per conversation. So the host has to know
   * that a conversation listed by one account may already be *held* by
   * another: resuming it again would be refused, and the refusal would name
   * neither account.
   *
   * Absent when the runtime's conversations are its own, which is every agent
   * until someone adds a second account.
   */
  readonly sessionStore?: string | null

  /** Bring the runtime up. Safe to call more than once. */
  start(): Promise<void>
  dispose(): Promise<void>
  /**
   * Re-asks the agent what it offers — models, modes, reasoning levels —
   * without a restart, and re-declares options for the draft and every live
   * session, ending with a `catalog/changed` event. The list a picker shows
   * is only ever the agent's last answer; this is how that answer stays
   * current while the app is open, for a vendor that adds models server-side
   * between one start and the next. Optional: a runtime that can only
   * declare once per process restarts itself here when idle, or leaves the
   * method out.
   *
   * **Answering is not doing.** A runtime that refreshes by restarting can
   * only do it when nothing is in flight, and one whose process is not up
   * cannot do it at all — so this returns what actually happened rather than
   * resolving either way. It used to resolve `void`, every caller read that
   * as success, and the library's "have it look again" button reported a
   * re-read that never occurred: the same cached list came back, the skill
   * stayed unread, and nothing on screen said why.
   */
  refreshCatalog?(): Promise<CatalogRefresh>
  /**
   * Definitions this agent read and refused, with its reason for each.
   *
   * Optional, and separate from `listSkills` because these have no skill to
   * attach to — the whole point is that the agent produced no entry. A
   * runtime that does not report rejections leaves the method out, and a
   * caller then knows only that the agent did not name the skill, which is
   * where the library was before this existed.
   */
  listSkillProblems?(cwd?: string): Promise<readonly SkillProblem[]>
  /**
   * Looks for a different build of the agent than the one running — the
   * user upgraded it while HarnessDesk was open — and, when no turn is in
   * flight, restarts onto it. Optional. The host calls it on the same
   * schedule as `refreshCatalog`, before it.
   */
  checkInstallation?(): Promise<InstallationCheck>
  /**
   * A secret this runtime declared was stored, replaced, or removed.
   *
   * An agent reads its environment when it starts, so the new value reaches
   * the *next* process and never the running one — which is why storing a key
   * and then sending a turn used to fail with the agent still saying it has
   * none. Implement this to get the value in: restart, and say what happened.
   *
   * `busy` when a turn is in flight — work is never killed for this; the host
   * tells the user the key applies once that finishes.
   */
  reloadSecrets?(): Promise<SecretReload>
  health(): RuntimeHealth
  /** Fires whenever `health()` would return something new. */
  onHealthChange(listener: (health: RuntimeHealth) => void): Unsubscribe

  /**
   * Fires when `info` would describe the runtime differently — a capability
   * learned rather than declared.
   *
   * Optional, because most of `info` is fixed the moment a runtime is
   * constructed. What is not fixed is anything the *agent* gets a say in: an
   * ACP agent only reveals whether it will take our tool server by refusing
   * it, and it refuses on the first session, long after the window has drawn
   * a badge saying the tools reach it. A runtime that can learn something
   * about itself implements this; the host re-broadcasts `info` when it does.
   */
  onInfoChange?(listener: () => void): Unsubscribe

  /**
   * Every event from every session this runtime owns. The host demultiplexes by
   * session id; adapters do not need to track subscribers.
   */
  subscribe(listener: (event: AgentEvent) => void): Unsubscribe

  /** The runtime's own filesystem view, when it has one. See `RuntimeFiles`. */
  readonly files?: RuntimeFiles
  /** Sandboxed processes for the person, when the runtime offers them. See `RuntimeProcesses`. */
  readonly processes?: RuntimeProcesses
  /** The agent's own long-running work, when the runtime keeps a registry. See `RuntimeTasks`. */
  readonly tasks?: RuntimeTasks
  /** The backend's own plugin catalogue and MCP servers. See `RuntimeExtensions`. */
  readonly extensions?: RuntimeExtensions

  listModels(): Promise<readonly ModelInfo[]>
  /**
   * Runtime-wide controls — feature flags, anything that is not per
   * conversation. Optional: most runtimes have none, and saying so by not
   * implementing it beats an empty list that looks like a failed call.
   */
  listOptions?(): Promise<readonly ConfigOption[]>
  setOption?(id: string, value: OptionValue): Promise<void>
  /**
   * The options a session started in `cwd` would begin with — the same list
   * `AgentSession.options()` would declare, before any session exists. This is
   * what lets a composer show a model picker for the *next* conversation: the
   * choices come from here, the user's picks travel as `SessionOptions.options`
   * when the session is created. Optional; a runtime without it simply has no
   * pre-session controls.
   */
  defaultSessionOptions?(
    cwd?: string,
    values?: Readonly<Record<string, OptionValue>>,
  ): Promise<readonly ConfigOption[]>
  getAccount(): Promise<AccountStatus>
  /**
   * Starts one of the methods `getAccount` declared. The outcome arrives as an
   * `account/loginCompleted` event, never as the return value: a browser flow
   * finishes in another application, and polling for it is what this avoids.
   */
  login?(method: string): Promise<LoginStart>
  /** Abandons a sign-in in progress. Unknown ids are not an error. */
  cancelLogin?(loginId: string): Promise<void>
  logout?(): Promise<void>
  getRateLimits(): Promise<RateLimits | null>

  listSessions(query?: ListSessionsQuery): Promise<Page<SessionSummary>>
  searchSessions(query: string): Promise<Page<SessionSummary>>
  /** Load a transcript without making the session live. */
  readSession(id: SessionId): Promise<Session>
  /**
   * Move a conversation into or out of the runtime's own archive.
   *
   * Only called when `capabilities.archiveHistory` says there is one; a
   * runtime that declares none may throw, and the host keeps the mark
   * instead.
   */
  archiveSession(id: SessionId, archived: boolean): Promise<void>
  /**
   * Remove a stored conversation where the agent keeps it.
   *
   * Only called when `capabilities.deleteHistory` says it can be done. The
   * host clears what *it* holds about the session — its transcript, its
   * archive mark — whether or not the runtime had anything to remove.
   *
   * What it answers with is what the interface then tells the user, so a
   * runtime that moved files to the Trash should say so and one that erased
   * them should not claim otherwise. Answering nothing reads as `removed`.
   */
  deleteSession(id: SessionId): Promise<SessionDeletion | void>

  /** Reusable instruction bundles. Empty for runtimes without the concept. */
  listSkills?(cwd?: string): Promise<readonly SkillInfo[]>
  /** Turns a skill on or off, where the runtime lets a client. Identified by path, or name. */
  setSkillEnabled?(skill: { readonly path?: string | null; readonly name: string }, enabled: boolean): Promise<void>
  /** The runtime's configured hooks, with their trust state. Read-only. */
  listHooks?(cwd?: string): Promise<readonly HookInfo[]>

  createSession(options: SessionOptions): Promise<AgentSession>
  /** Bring an existing session back into memory so it can take turns again. */
  resumeSession(id: SessionId, options?: Partial<SessionOptions>): Promise<AgentSession>
  forkSession(id: SessionId, options?: Partial<SessionOptions>): Promise<AgentSession>
}

export interface AgentSession {
  readonly id: SessionId
  readonly runtime: RuntimeId
  settings(): SessionSettings

  /** Start a turn. Resolves once the runtime has accepted the input. */
  send(input: readonly UserContent[]): Promise<TurnId>
  /** Add to the turn already in flight without interrupting it. */
  steer(input: readonly UserContent[]): Promise<void>
  interrupt(): Promise<void>

  respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void>

  /** Sets or clears the session's standing objective. */
  setGoal?(objective: string | null): Promise<void>
  /**
   * Drops the last `turns` turns from the conversation. The backend's own
   * history changes; **files on disk do not** — undoing a turn that wrote a
   * file leaves the file. The caller is expected to say so.
   */
  rollback?(turns: number): Promise<void>
  /** Compacts the conversation now, rather than waiting for the backend to. */
  compact?(): Promise<void>
  /** Turns this conversation's memory on or off, where the backend has one. */
  setMemoryMode?(enabled: boolean): Promise<void>
  /**
   * Reviews a set of changes. `inline` runs it in this conversation; `detached`
   * on a side thread. What can be reviewed is the backend's to define; the
   * shell passes a target through unread.
   */
  review?(target: ReviewRequest): Promise<void>
  updateSettings(patch: Partial<SessionSettings>): Promise<void>
  /**
   * The runtime's controls for this session, as of now. Changes arrive as a
   * `session/options` event carrying the whole list, because one change can
   * alter what the others offer.
   */
  options(): readonly ConfigOption[]
  /** Rejects a value the option does not offer; the host checks first, this is the backstop. */
  setOption(id: string, value: OptionValue): Promise<void>
  setTitle(title: string): Promise<void>

  /** Detach from the live session. The transcript stays on disk. */
  close(): Promise<void>
}
