import type {
  AccountStatus,
  CapabilityContribution,
  PluginInstance,
  AgentError,
  BackgroundTask,
  Approval,
  ConfigOption,
  EditorDocument,
  ModelInfo,
  NoticeLevel,
  OptionValue,
  RateLimits,
  ScanProgress,
  UsageReport,
  RuntimeHealth,
  RuntimeId,
  RuntimeInfo,
  Session,
  SessionQueue,
  SkillInfo,
  SessionId,
  SessionKey,
  SessionSummary,
  TeamState,
  Worktree,
  WorkspaceEntry,
} from '@harnessdesk/protocol'

import type { AccountPrefsMap } from '../lib/accounts'

import type { Profile } from '../lib/profile'

import { DEFAULT_EDITOR_PREFS } from '../lib/editor-prefs'

import type { GitColumnWidths } from '../lib/git-columns'

import type { Carry } from '../lib/handoff'

import { emptyNoticePolicy, type NoticePolicy } from '../lib/notice-policy'

import type { PlanEdit } from '../lib/plan-edits'

import type { ConnectionStatus } from '../lib/transport'

import { emptyLayout, panes, type Layout } from './layout'

import { emptyWorkbench, type Workbench } from './workbench'

import type { LoginState } from './login'

import type { AgentPreset } from './presets'

/**
 * The renderer's state, as one immutable value.
 *
 * `AppSnapshot` is what every component reads and what `AppStore` replaces
 * whole on each change — the host is the source of truth and this is its
 * projection, plus the little the window keeps for itself (layout, drafts,
 * preferences). It lives apart from the store so the shape of the state can
 * be read without the four thousand lines that mutate it. The store
 * re-exports everything here, so importing from `./store` still works.
 */

/** One permission-policy rule: matched before any backend's own question renders. */
export interface PolicyRule {
  readonly id: string
  readonly name: string
  readonly match: { readonly type?: string; readonly pattern?: string }
  readonly action: 'approve' | 'deny'
}

/** One audit entry, as `audit/query` returns it. */
export interface AuditRow {
  readonly at: number
  readonly runtime: string
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
  readonly detail?: string
  readonly backupPath?: string
}

/**
 * One row of `credentials/list`. The value is never among the fields: the
 * broker returns references, and the renderer has only ever been able to
 * name a secret, not read one.
 */
export interface StoredCredential {
  readonly ref: string
  readonly name: string
  readonly createdAt: number
  /**
   * What this key belongs to. `endpoint` is a key the endpoint dialog stored,
   * the only kind Settings lists; `null` is one nothing here can name, and is
   * listed nowhere.
   *
   * The store holds several unrelated kinds and only the host can tell them
   * apart. An agent's key is cleared from that agent's sign-in page, through
   * `runtime/apiKey/clear`, which also reloads the runtime's secrets; a
   * gateway account's key is held by the account and goes when the account
   * does. Deleting either as a route's leftover takes a credential away from
   * something still using it.
   */
  readonly owner:
    | { readonly kind: 'agent' | 'gateway'; readonly of: string }
    | { readonly kind: 'endpoint' }
    | null
}

/** One row of `routes/list`, as the wire returns it. */
export interface RouteInfo {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly wireProtocol: string
  readonly credentialRef: string
  readonly model?: string
  readonly usable?: boolean
  readonly reason?: string
}

export interface Notice {
  readonly id: string
  readonly level: NoticeLevel
  readonly message: string
  readonly at: number
  /**
   * One thing to do about it, shown as a button on the toast.
   *
   * What makes archiving safe enough to do with one click: the row leaves the
   * list, the toast says so, and taking it back is right there for as long as
   * the toast is. Not a general affordance — a toast with two buttons is a
   * dialog that moves — and never the only way to undo something, because a
   * toast expires.
   */
  readonly action?: NoticeAction
}

export interface NoticeAction {
  readonly label: string
  readonly run: () => void
}

/** An approval still waiting, with the conversation it belongs to. */
export interface PendingApproval {
  readonly key: SessionKey
  readonly approval: Approval
}

/** A conversation handed to the open draft: shown as a chip, resolved at send. */
export interface DraftHandoff {
  readonly runtime: RuntimeId
  readonly sessionId: SessionId
  readonly carry: Carry
  readonly agentName: string
  readonly title: string
  /**
   * The source conversation's working folder. The session this draft becomes
   * starts there, not in whatever workspace happens to be selected — the
   * packet names the folder as ground truth, and an agent dropped into a
   * different one either wastes a trip finding it or, worse, answers about
   * the folder it is actually in.
   */
  readonly cwd: string | null
}

/**
 * Where the next conversation will run, while that is still a decision.
 *
 * `null` is the open folder as it is — the answer nine times in ten, and the
 * one a fresh draft starts from. The other two are held on the draft and
 * become a fact about a session on its first message:
 *
 * - `worktree` is a checkout that does not exist yet. The host cuts it on
 *   send, so a draft abandoned with a worktree chosen leaves no branch and no
 *   folder behind — the bargain `newDraft` already keeps with the agent's
 *   history. `root` is the repository it comes off, named here rather than
 *   read from the workspace at send time, because the two can part. Once
 *   the host has cut it, the draft points at it as `existing`: an agent that
 *   fails to start leaves it so, and a draft abandoned after that leaves the
 *   worktree behind, listed with the others.
 * - `existing` is a managed worktree already on disk.
 */
export type DraftPlace =
  | { readonly kind: 'worktree'; readonly root: string; readonly name: string; readonly base?: string }
  | { readonly kind: 'existing'; readonly path: string; readonly branch: string | null }

export interface AppSnapshot {
  readonly status: ConnectionStatus
  readonly runtimes: readonly RuntimeInfo[]
  readonly activeRuntime: RuntimeId | null
  readonly health: RuntimeHealth | null
  /**
   * Every runtime's health, not only the active one's. This is what lets a
   * picker draw a dead agent dead instead of letting it sit there looking
   * normal — the active-only `health` above answers a different question
   * (whether the composer in front of you would work).
   */
  readonly healthByRuntime: Readonly<Record<string, RuntimeHealth>>
  /** True while "Refresh models" is in flight, so the row can say so. */
  readonly catalogRefreshing: boolean
  readonly account: AccountStatus | null
  /**
   * How this host protects a secret at rest, in the host's own words. The
   * sign-in page prints it instead of promising a keychain: a standalone host
   * with no OS keystore has only file permissions, and saying so is the
   * difference between a claim and a fact.
   */
  readonly credentialProtection: string
  /**
   * The host's home directory, for `shortPath`.
   *
   * Home is a fact about the process, so it arrives at the handshake and sits
   * here. It used to be carried only on `Library.home` — where it belongs, as
   * the thing that report's `~/…` rows were resolved against, but which left
   * every screen with no reason to scan the library printing the machine's
   * username in full.
   */
  readonly home: string
  /** Who each runtime is signed in as — the sign-in page and the Agents card read this. */
  readonly accountsByRuntime: Readonly<Partial<Record<RuntimeId, AccountStatus>>>
  /**
   * What you call each account, and the ring that tells two of one agent
   * apart. Keyed by `accountKey`; an account with nothing set here still has
   * a name and a colour, both derived — this only records the overrides.
   */
  readonly accountPrefs: AccountPrefsMap
  /**
   * Who you are on this desk — the name and face the seat, its menu, the top
   * of the settings rail and your messages in a room all draw. Only what
   * differs from the default is here; `{}` is "HarnessDesk" and the house
   * mark. Read it through `profileName` and `ProfileFace`, never the fields,
   * so a signed-in account can supply it later in one place. `lib/profile.ts`.
   */
  readonly profile: Profile
  /**
   * Sign-ins in flight, by runtime. Keyed rather than singular because the
   * sign-in page shows every agent at once, and a browser flow keeps running
   * while the user starts a second one somewhere else.
   */
  readonly logins: Readonly<Partial<Record<RuntimeId, LoginState>>>
  readonly limits: RateLimits | null
  readonly models: readonly ModelInfo[]
  /** Runtime-wide options — feature flags and the like — for the selected runtime. */
  readonly runtimeOptions: readonly ConfigOption[]
  /**
   * The options the *next* session would start with, so the composer has a
   * model picker before any session exists. Null when the runtime cannot say.
   */
  readonly draftOptions: readonly ConfigOption[] | null
  /** The user's picks for the next session; sent as start options on create. */
  readonly draftValues: Readonly<Record<string, OptionValue>>
  /**
   * Models kept out of the composer's picker, by agent. An account can offer
   * two hundred of them — Cursor's does — and a list that long is a scroll
   * hunt rather than a choice. Hiding is HarnessDesk's own preference and
   * never reaches the agent: a hidden model is still perfectly usable, and a
   * session already running on one keeps its row.
   */
  readonly hiddenModels: Readonly<Record<string, readonly string[]>>
  /** Model routes usable (or greyed) for the selected runtime. */
  readonly routes: readonly RouteInfo[]
  /** The route the next session should run on; null is the backend's own provider. */
  readonly draftRouteId: string | null

  /** Every conversation the host told us about, keyed by `(runtime, id)`. */
  readonly sessions: ReadonlyMap<SessionKey, Session>
  readonly history: readonly SessionSummary[]
  readonly historyLoading: boolean
  readonly historyCursor: string | null
  /**
   * Where everything is: the sidebar's stack, the split tree, the right and
   * bottom panels, and which area has been given the room. One model for every
   * place a feature can be shown — see `state/workbench.ts`.
   */
  readonly workbench: Workbench
  /**
   * The split tree, which is `workbench.main` and nothing else.
   *
   * Kept as its own field because most of the app asks about panes and not
   * about areas, and `snapshot.layout` is the shorter sentence. It is written
   * in exactly one place, beside the workbench it comes from, so the two cannot
   * drift — read it, never assign it.
   */
  readonly layout: Layout
  /**
   * The focused pane's conversation, derived from `layout` on every change so
   * components read one field. `activeSessionId` is its id within
   * `activeRuntime`, for the sidebar and for commands.
   */
  readonly activeSessionKey: SessionKey | null
  readonly activeSessionId: SessionId | null
  /** Conversations whose transcript is being fetched. */
  readonly loadingSessions: ReadonlySet<SessionKey>
  /**
   * What is waiting to be sent to each conversation, keyed like the sessions.
   * Host state, mirrored here: the composer reads it, it survives a reload,
   * and a conversation with nothing waiting has no entry.
   */
  readonly queues: ReadonlyMap<SessionKey, SessionQueue>
  /**
   * What each conversation has running in the background, keyed like the
   * sessions. The runtime's own list, relayed by the host; a conversation
   * with nothing in either state has no entry, so a reader can ask and get
   * nothing rather than an empty array that has to be length-checked.
   */
  readonly tasks: ReadonlyMap<SessionKey, readonly BackgroundTask[]>

  readonly approvals: readonly PendingApproval[]
  readonly notices: readonly Notice[]
  /**
   * Folders an agent has refused to reopen a conversation in because they are
   * no longer there, each with the refusal in the agent's own words.
   *
   * Keyed on the **folder**, not on the conversation and not on the sentence,
   * because that is the shape of the fact: a deleted worktree takes every
   * conversation that ran in it, and a review room's three members in one
   * worktree are one piece of news three times over. One entry answers the
   * pane's note, the row's mark and the card's caution for all of them.
   *
   * A state, so it is drawn where it applies rather than announced: this is
   * not something that *happened*, it is how this conversation now is, and it
   * will be just as true at the next launch. Cleared the moment a conversation
   * in that folder reopens, which is the only evidence the folder is back.
   */
  readonly foldersGone: ReadonlyMap<string, string>
  /** Worktrees of the open workspace's repository, refreshed with git status. */
  readonly worktrees: readonly Worktree[]
  /**
   * Each room's team surface — the board and the channel — keyed by the
   * **room's own id**, not by the workspace root. It was keyed by root while a
   * board belonged to a folder and being open in it was membership; a project
   * holds as many rooms as the work wants now, so the folder cannot identify
   * one. Pushed whole by the host on every change and replayed on connect, so
   * this map is only ever assigned, never merged.
   */
  readonly teams: ReadonlyMap<string, TeamState>
  /**
   * The repository a new worktree is being set up for, or null.
   *
   * Dialog state in the store, because three places raise this one dialog —
   * the sidebar's worktree menu, a project's context menu, and ⌘K — and the
   * row that raised it is usually gone by the time it is answered.
   */
  readonly newWorktreeFor: string | null
  /**
   * A settings page something asked for by name, until the shell opens it.
   * The composer's model menu ends in "Manage models", and the page it means
   * is two components away from the state that opens windows.
   */
  readonly settingsFor: string | null

  readonly workspaces: readonly WorkspaceEntry[]
  readonly workspace: WorkspaceEntry | null

  readonly skills: readonly SkillInfo[]
  /** User-defined agent presets, persisted in app state. */
  readonly customPresets: readonly AgentPreset[]
  readonly plugins: readonly PluginInstance[]
  readonly contributions: readonly CapabilityContribution[]

  /**
   * What every metered account has left, across every agent. One entry per
   * account, ordered by the host; the screen sorts by urgency itself.
   */
  readonly usage: readonly UsageReport[]
  /** Progress of the transcript scan behind the money figures. */
  readonly scan: ScanProgress | null

  /**
   * The inspector on screen, wherever it is docked — right panel, bottom
   * panel, or a pane of its own. Derived from the workbench, so a control that
   * lights up while Changes is open keeps working after Changes is dragged
   * somewhere else.
   */
  readonly detailsTab: 'changes' | 'trajectory' | 'agents' | 'activity' | 'tasks' | null
  /** Whether back/forward session navigation has anywhere to go. */
  readonly navCanBack: boolean
  readonly navCanForward: boolean
  /** The conversation handed to the open draft, if any. */
  readonly draftHandoff: DraftHandoff | null
  /**
   * Where the draft will start — see `DraftPlace`. Cleared the moment a
   * conversation is in front, and when the workspace changes under it: a
   * worktree chosen for one repository is not a choice about the next.
   */
  readonly draftPlace: DraftPlace | null
  /** The sidebar's column is put away — a wide window's choice. See `sidebarPlacement`. */
  readonly sidebarCollapsed: boolean
  /**
   * The window is narrower than `NARROW_WINDOW`, too narrow to give the
   * sidebar a column. A fact about the window rather than a choice, kept here
   * because `toggleSidebar` has to know which of the two sidebar states it is
   * flipping.
   */
  readonly narrowWindow: boolean
  /** In a narrow window, the sidebar is open over the conversation. */
  readonly sidebarFloating: boolean
  readonly theme: 'light' | 'dark' | 'system'
  /**
   * Which token palette dresses the window. `harnessdesk` is the shipped
   * look, presented in Settings as "Blueprint"; `editorial` ("Editorial") is
   * the website's warm paper-and-clay system, carried into the app as a
   * second set of foundation values. The values are wire ids — the persisted
   * preference and the body attribute — and stay put when a display name
   * changes. Orthogonal to `theme`: each palette has a light and a dark face.
   */
  readonly palette: 'harnessdesk' | 'editorial' | 'shadcn'
  /**
   * The brand hue alone, over whichever palette is dressed — the second dial
   * of shadcn's own theme customizer, carried across the whole desk.
   * `default` means the palette's own accent stands (cobalt for Blueprint,
   * clay for Editorial, ink for Shadcn).
   */
  readonly accent: 'default' | 'violet' | 'green' | 'rose' | 'orange' | 'mono'
  /** The radius scale alone — the customizer's third dial. */
  readonly corners: 'default' | 'square' | 'round'
  /**
   * Which of the two interfaces the app wears.
   *
   * Not a palette and not a density: it is how the interface *marks* things.
   * `desk` is the app's own — selection as a grey wash, cards as white sheets
   * with a hairline, one control height everywhere. `studio` is the
   * shadcn-dashboard idiom — selection filled with the brand, cards as a
   * tinted block with no line, and settings-like pages standing a step
   * taller. Both are entirely token values; see the STUDIO block in
   * design/tokens.css.
   */
  /*
   * Spelled `look`, not `interface`, and the reason is a language one:
   * `interface` is a future reserved word and this codebase is ES modules, so
   * `const { interface } = useSnapshot()` — the form every sibling dial is
   * read with — is a SyntaxError rather than a mistake anyone would spot.
   * The setting is still called Interface everywhere a person sees it, and
   * the body attribute is still `data-hd-interface`.
   */
  readonly look: 'desk' | 'studio'
  /** How the session list draws itself; persisted like the theme. */
  /**
   * Tasks the person reworded, by session key. The Tasks panel is a read of
   * the conversation, so an edit is the one thing in it the transcript does
   * not say — it is kept here, shown over the read, and told to the agent on
   * the next turn, which is what stops it becoming a second source of truth.
   * See `lib/plan-edits.ts`.
   */
  readonly planEdits: Readonly<Record<string, readonly PlanEdit[]>>
  readonly listPrefs: {
    readonly density: 'comfortable' | 'compact'
    /**
     * Whether the density above is the user's choice. The list opened
     * comfortable for its first months and wrote that into everyone's
     * preferences, so a stored 'comfortable' without this flag is the old
     * default rather than a decision, and compact wins.
     */
    readonly densityPicked?: boolean
    /** Show only this agent's sessions; null is everyone. */
    readonly agent: RuntimeId | null
    readonly sort: 'recency' | 'name'
    /** Project roots kept at the top of the list, in the order they were pinned. */
    readonly pinned: readonly string[]
    /** Session keys kept at the top of their group, in the order they were pinned. */
    readonly pinnedSessions: readonly string[]
    /**
     * Column widths in the history table, in pixels, for the ones a person
     * has dragged. Absent keys keep the default — so a column nobody touched
     * still follows the graph's own idea of how wide it needs to be.
     */
    readonly gitColumns?: GitColumnWidths
    /**
     * Project roots folded shut. Persisted rather than held in the tree,
     * because a list you have arranged is arrangement work, and losing it to
     * a restart makes the arranging not worth doing.
     */
    readonly collapsed: readonly string[]
    /**
     * Sidebar panels folded shut, by panel id. Same reasoning as `collapsed`
     * above, one column lower: the Tasks panel is a long list a person may
     * want out of the way, and putting it away has to survive a restart or
     * they will simply stop doing it.
     */
    readonly panelsCollapsed: readonly string[]
    /** Whether the "Other projects" fold is open. */
    readonly othersOpen: boolean
  }
  /**
   * Agents the desk has been told not to keep track of.
   *
   * A switch, not a filter: the host stops asking these accounts anything, so
   * they cost nothing and appear nowhere usage is shown. What they already
   * spent stays in the ledger, because that is history, not a reading.
   */
  readonly usageOff: readonly RuntimeId[]
  /**
   * Which standing messages have been put away, and which kinds the user has
   * asked never to see again.
   *
   * Host state rather than `localStorage` because a mute is an answer, not a
   * rendering detail: it has to hold across windows, survive a cleared web
   * profile, and be readable by the settings page that offers the way back.
   */
  readonly noticePolicy: NoticePolicy
  /**
   * The macOS notification switches — a master and one per kind, all
   * defaulting on. Host state for the same reason `noticePolicy` is, plus
   * one more: the desktop shell reads the same preference when it decides
   * whether to draw a notification at all.
   */
  readonly systemNotifications: Readonly<Record<string, boolean>>
  /**
   * Whether the answers above have arrived from the host yet.
   *
   * Banners read it before they draw. A message the user has silenced must not
   * flash on the way to being hidden — that is the launch this whole mechanism
   * exists to stop, and half a second of it is still it.
   */
  readonly preferencesLoaded: boolean
  /**
   * How the code editor draws itself.
   *
   * Beside the theme rather than inside the file pane's own state because it
   * is a standing answer: a person who sets 14px and no line numbers means it
   * for every file they ever open, not for the one that happened to be in
   * front of them. `fontFamily` is empty for "follow the app's code face",
   * which is what keeps a palette change reaching the editor — a family
   * copied out of the token at pick time would freeze it.
   */
  readonly editorPrefs: {
    readonly fontFamily: string
    readonly fontSize: number
    readonly lineHeight: number
    readonly lineNumbers: boolean
    readonly wrap: boolean
    readonly tabSize: number
  }
  /**
   * The editor plane: files a plugin has asked to show, and the marks it put
   * on them.
   *
   * Host state, not this window's — it survives a reload and is the same in
   * two windows, which is why it arrives whole on every change rather than
   * being merged here. A window projects it: opening a pane for a document it
   * has not seen, and handing each pane the marks for its own path.
   */
  readonly editorPlane: readonly EditorDocument[]
  /**
   * How the browser pane behaves. Which pages are open belongs to a
   * workspace's layout; whether this app keeps cookies is a standing
   * answer, so it lives here beside the theme.
   */
  readonly browserPrefs: {
    /** Guests use a persistent partition, so logins survive a restart. */
    readonly persistSession: boolean
    /** A page's `target=_blank` opens a tab here rather than leaving for the OS browser. */
    readonly linksInPane: boolean
    /**
     * Where an agent's `browser_open` puts the page: this window's Browser
     * pane, a separate Chrome of HarnessDesk's own, or the machine's default
     * browser — which can be opened but never seen into or clicked.
     */
    readonly placement: 'pane' | 'window' | 'system'
    /** Which browser to start for `window`. Empty: the first one found. */
    readonly externalBinary: string
    /** Whether that browser's profile — its logins — survives a restart. */
    readonly keepExternalProfile: boolean
  }
  readonly fatal: AgentError | null
}

/**
 * One blank workbench, made once.
 *
 * `emptyLayout()` mints pane ids, so calling it per snapshot would give two
 * "empty" states different identities — which is exactly the thing a test that
 * compares against `emptySnapshot()` would then chase.
 */
const EMPTY_WORKBENCH = emptyWorkbench()

/**
 * Module-private on purpose. Its Maps and Sets are mutable, so a caller that
 * held it and forgot would be sharing state with every other holder. The one
 * way out is `emptySnapshot()`, which copies those fields fresh.
 */
const EMPTY: AppSnapshot = {
  status: 'connecting',
  runtimes: [],
  catalogRefreshing: false,
  activeRuntime: null,
  health: null,
  healthByRuntime: {},
  account: null,
  credentialProtection: 'file permissions only',
  // No tilde until the host says what to shorten against; `shortPath` leaves
  // a path whole rather than guess, which is the right way round.
  home: '',
  accountsByRuntime: {},
  accountPrefs: {},
  profile: {},
  logins: {},
  limits: null,
  models: [],
  runtimeOptions: [],
  draftOptions: null,
  draftValues: {},
  hiddenModels: {},
  routes: [],
  draftRouteId: null,
  sessions: new Map(),
  queues: new Map(),
  tasks: new Map(),
  history: [],
  historyLoading: false,
  historyCursor: null,
  usage: [],
  scan: null,
  workbench: EMPTY_WORKBENCH,
  layout: EMPTY_WORKBENCH.main,
  activeSessionKey: null,
  activeSessionId: null,
  loadingSessions: new Set(),
  approvals: [],
  notices: [],
  foldersGone: new Map(),
  worktrees: [],
  teams: new Map(),
  newWorktreeFor: null,
  settingsFor: null,
  workspaces: [],
  workspace: null,
  skills: [],
  customPresets: [],
  plugins: [],
  contributions: [],
  detailsTab: null,
  navCanBack: false,
  navCanForward: false,
  draftHandoff: null,
  draftPlace: null,
  sidebarCollapsed: false,
  narrowWindow: false,
  sidebarFloating: false,
  theme: 'system',
  palette: 'harnessdesk',
  accent: 'default',
  corners: 'default',
  look: 'desk',
  planEdits: {},
  listPrefs: { density: 'compact', agent: null, sort: 'recency', pinned: [], pinnedSessions: [], collapsed: [], panelsCollapsed: [], othersOpen: false },
  editorPrefs: DEFAULT_EDITOR_PREFS,
  editorPlane: [],
  usageOff: [],
  noticePolicy: emptyNoticePolicy(),
  systemNotifications: {},
  preferencesLoaded: false,
  // Cookies kept and links staying in the pane are what a person expects of
  // a browser; both are one row away in the pane's own menu.
  browserPrefs: {
    persistSession: true,
    linksInPane: true,
    placement: 'pane',
    externalBinary: '',
    keepExternalProfile: true,
  },
  fatal: null,
}

/** A blank snapshot, for tests that render a component against a made-up state. */
export const emptySnapshot = (): AppSnapshot => ({
  ...EMPTY,
  sessions: new Map(),
  queues: new Map(),
  tasks: new Map(),
  foldersGone: new Map(),
  loadingSessions: new Set(),
})
