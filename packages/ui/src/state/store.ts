import {
  mergeRead,
  orderTasks,
  reduceSession,
  sessionKey,
  splitSessionKey,
  type AccountStatus,
  type ExtensionEvent,
  type PluginInstance,
  type BackgroundTask,
  type AgentEvent,
  type AgentItem,
  type ApprovalDecision,
  type ApprovalId,
  type CapabilityContribution,
  type ConfigOption,
  type ContributionKind,
  findOption,
  type EditorDocument,
  type EditorEvent,
  type ModelInfo,
  type NoticeLevel,
  type McpServer,
  type OptionValue,
  type ReviewRequest,
  type ScopeQuery,
  type RuntimeCatalog,
  type RuntimePlugin,
  type LedgerQuery,
  type LedgerReport,
  type RateLimits,
  type UsageReport,
  type RuntimeHealth,
  type AgentRegisterRequest,
  type AcpRegistryCatalogInfo,
  type AgentTemplateInfo,
  type InstallInfo,
  type InstallationCheck,
  type RuntimeId,
  type Session,
  type SessionQueue,
  type SessionId,
  type SessionKey,
  type SessionSettings,
  type SessionDeletion,
  type SessionSummary,
  type TeamInbound,
  type TeamPeerInfo,
  type TeamState,
  type TerminalSize,
  type UiDecoration,
  type UserContent,
  type WireNotification,
  type Worktree,
} from '@harnessdesk/protocol'

import type { AccountPrefs, AccountPrefsMap } from '../lib/accounts'
import { applyProfile, readProfile, sameProfile, type ProfilePatch } from '../lib/profile'
import { coalesce } from '../lib/coalesce'
import { openExternal } from '../lib/desktop'
import { splitContext, wrapContext } from '../lib/context-envelope'
import { readEditorPrefs } from '../lib/editor-prefs'
import { readColumnWidths } from '../lib/git-columns'
import { readSystemNotifications } from '../lib/system-notifications'
import { sessionLabel, shortLabel } from '../lib/sessions'
import { isStale } from '../lib/versions'
import { buildHandoff, type Carry } from '../lib/handoff'
import { livePlanEdits, withPlanEdit, type PlanEdit } from '../lib/plan-edits'
import type { Todo } from '../lib/todos'
import { crossings } from '../lib/usage-alerts'
import {
  afterDismiss,
  readNoticePolicy,
  withMuted,
  type NoticeIdentity,
  type NoticePolicy,
} from '../lib/notice-policy'

import {
  close as closePaneIn,
  collapse as collapseIn,
  conversationPane,
  expand as expandIn,
  settleExpansion,
  strayPanels,
  strayTerminals,
  show as showIn,
  findPane,
  focus as focusPaneIn,
  focusedPane,
  emptyView,
  openView as openViewIn,
  panes,
  only as onlyIn,
  sameView,
  addBrowserTab,
  browserView,
  duplicateBrowserTab,
  keepBrowserTabs,
  moveBrowserTab,
  drivenBrowserTab,
  patchBrowserTab,
  removeBrowserTab,
  BLANK,
  type BrowserDevice,
  type BrowserTab,
  type BrowserView,
  prune,
  resize as resizeIn,
  sessionOf,
  singleConversation,
  split as splitIn,
  type Layout,
  type PaneId,
  type PaneView,
  type Split,
} from './layout'
import {
  DOCKS,
  activate as activateIn,
  activeTerminal,
  areaOfMount,
  dockViews,
  resizeDockSplit as resizeDockSplitIn,
  splitDock as splitDockIn,
  areaVisible as areaVisibleIn,
  focusView as focusViewIn,
  findView as findViewIn,
  mountedViews as mountedViewsIn,
  removeAt as removeAtIn,
  viewAt,
  collapseDock as collapseDockIn,
  dock as dockIn,
  emptyWorkbench,
  mountOfTerminal,
  moveView as moveViewIn,
  readWorkbench,
  replaceView as replaceViewIn,
  resizeDock as resizeDockIn,
  settle as settleWorkbench,
  terminals as terminalsIn,
  toggleDock as toggleDockIn,
  undock as undockIn,
  unzoom as unzoomIn,
  visibleInspector,
  zoomArea as zoomAreaIn,
  type AreaId,
  type DockId,
  type MountedId,
  type StackId,
  type Workbench,
  type Zoom,
} from './workbench'
import { defaultArea, permits } from '../panels/views'
import { applyLoginCompleted, startedLogin, type LoginState } from './login'
import { readCustomPresets, type AgentPreset } from './presets'
import { Transport, transportUrl } from '../lib/transport'

/**
 * Renderer state.
 *
 * A plain observable store rather than a state library: the host is already the
 * source of truth, so this is a projection with a small amount of view-local
 * state on top. `useSyncExternalStore` reads it, which keeps React 18 concurrent
 * rendering correct without a dependency.
 */

import {
  emptySnapshot,
  type AppSnapshot,
  type AuditRow,
  type DraftHandoff,
  type Notice,
  type NoticeAction,
  type PendingApproval,
  type PolicyRule,
  type RouteInfo,
  type StoredCredential,
} from './snapshot'

export type {
  AppSnapshot,
  AuditRow,
  DraftHandoff,
  Notice,
  NoticeAction,
  PendingApproval,
  PolicyRule,
  RouteInfo,
  StoredCredential,
} from './snapshot'
export { emptySnapshot } from './snapshot'

export class AppStore {
  #snapshot: AppSnapshot = emptySnapshot()
  #listeners = new Set<() => void>()
  readonly transport: Transport

  constructor(url = transportUrl()) {
    this.transport = new Transport(url, {
      onEvent: (runtime, event) => this.#onEvent(runtime, event),
      onNotification: (notification) => {
        if (notification.method === 'sync') {
          const sessions = new Map(this.#snapshot.sessions)
          for (const session of notification.params.sessions) {
            sessions.set(sessionKey(session.runtime, session.id), session)
          }
          // Replaced, not merged: the host sends every queue that has anything
          // in it, so one that is missing is one that has drained.
          const queues = new Map<SessionKey, SessionQueue>()
          for (const entry of notification.params.queues ?? []) {
            queues.set(sessionKey(entry.runtime, entry.sessionId), entry.queue)
          }
          // Same rule for background tasks: the host sends every conversation
          // that has any, so one that is missing has none left.
          const tasks = new Map<SessionKey, readonly BackgroundTask[]>()
          for (const entry of notification.params.tasks ?? []) {
            tasks.set(sessionKey(entry.runtime, entry.sessionId), entry.tasks)
          }
          // Every runtime's health arrives with the sync, so the broken ones
          // are drawn broken from the first frame, not once each is selected.
          const healthByRuntime: Record<string, RuntimeHealth> = {}
          for (const entry of notification.params.health ?? []) {
            healthByRuntime[entry.runtime] = entry.health
          }
          this.#patch({
            sessions,
            queues,
            tasks,
            runtimes: notification.params.runtimes,
            healthByRuntime,
            plugins: notification.params.plugins,
            contributions: notification.params.contributions,
            activeRuntime:
              this.#snapshot.activeRuntime ?? notification.params.runtimes[0]?.id ?? null,
          })
          void this.refreshRuntime()
        }
        if (notification.method === 'extension') {
          this.#onExtensionEvent(notification.params.event)
        }
        if (notification.method === 'runtime/healthChanged') {
          // Every runtime's health is kept, so pickers and settings can draw
          // a dead agent dead wherever it appears.
          this.#patch({
            healthByRuntime: {
              ...this.#snapshot.healthByRuntime,
              [notification.params.runtime]: notification.params.health,
            },
          })
          // `health` stays the *active* runtime's; taking any runtime's would
          // let a second account still starting up report the one you are
          // using as unavailable.
          if (notification.params.runtime === this.#snapshot.activeRuntime) {
            this.#patch({ health: notification.params.health })
            if (notification.params.health.state === 'ready') void this.refreshRuntime()
          } else if (notification.params.health.state === 'ready') {
            // An account that has just come up can finally say how to sign in.
            void this.loadAccounts()
          }
        }
        if (notification.method === 'runtime/infoChanged') {
          // Replace, never merge: the host sends the whole description, and
          // a field that went away (an update that was installed) must go.
          const { runtime, info } = notification.params
          this.#patch({
            runtimes: this.#snapshot.runtimes.map((entry) => (entry.id === runtime ? info : entry)),
          })
        }
        if (notification.method === 'runtime/added') {
          // A second account of an agent already in the list. Appended rather
          // than re-synced: a full sync would drop the panes' scroll and the
          // history page the user is halfway down.
          const { info } = notification.params
          if (!this.#snapshot.runtimes.some((entry) => entry.id === info.id)) {
            this.#patch({ runtimes: [...this.#snapshot.runtimes, info] })
          }
          void this.loadAccounts()
        }
        if (notification.method === 'runtime/removed') {
          const { runtime } = notification.params
          const runtimes = this.#snapshot.runtimes.filter((entry) => entry.id !== runtime)
          const accountsByRuntime = { ...this.#snapshot.accountsByRuntime }
          delete accountsByRuntime[runtime]
          const healthByRuntime = { ...this.#snapshot.healthByRuntime }
          delete healthByRuntime[runtime]
          // Nothing may stay pointed at a runtime that no longer resolves —
          // the list's paging anchor and its cursor included.
          const anchored = this.#historyAnchor === runtime
          if (anchored) this.#historyAnchor = null
          this.#patch({
            runtimes,
            accountsByRuntime,
            healthByRuntime,
            activeRuntime:
              this.#snapshot.activeRuntime === runtime
                ? (runtimes[0]?.id ?? null)
                : this.#snapshot.activeRuntime,
            history: this.#snapshot.history.filter((entry) => entry.runtime !== runtime),
            historyCursor: anchored ? null : this.#snapshot.historyCursor,
          })
        }
        if (notification.method === 'usage/updated') {
          // One account at a time, so a slow source never holds up a fast one.
          const { report } = notification.params
          const before = this.#snapshot.usage
          const rest = before.filter(
            (entry) => entry.runtime !== report.runtime || entry.account !== report.account,
          )
          const usage = [...rest, report]
          this.#patch({ usage })
          this.#announceUsage(before, usage)
        }
        if (notification.method === 'usage/scanProgress') {
          this.#patch({ scan: notification.params.progress })
        }
        if (notification.method === 'team/changed') {
          const { state } = notification.params
          const teams = new Map(this.#snapshot.teams)
          teams.set(state.id, state)
          this.#patch({ teams })
        }
        if (notification.method === 'team/removed') {
          const { room } = notification.params
          const teams = new Map(this.#snapshot.teams)
          teams.delete(room)
          this.#patch({ teams })
          /* A pane pointed at a room that no longer exists is a surface backed
             by nothing — it would draw the empty board rather than say why. It
             goes with the room, and whatever the pane was replacing comes
             back, which is what Back would have done. */
          this.#closeViewsOf(room)
        }
        if (notification.method === 'editor/plane') {
          // Whole, never merged — the host sends the complete plane on every
          // change, so a document that is missing is one that was closed.
          const editorPlane = notification.params.documents
          this.#patch({ editorPlane })
          this.#showEditorPlane(editorPlane)
        }
        if (notification.method === 'terminal/output' || notification.method === 'terminal/exited') {
          // Terminal bytes bypass the snapshot: they go straight to the pane
          // that draws them, and re-rendering the window per chunk would be
          // the worst possible use of a frame.
          for (const listener of this.#terminalListeners.get(notification.params.terminalId) ?? []) {
            listener(notification)
          }
        }
      },
      onStatus: (status) => this.#patch({ status }),
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): AppSnapshot => this.#snapshot

  // ------------------------------------------------------------------ startup

  async connect(): Promise<void> {
    this.transport.connect()
    await this.#waitForOpen()
    const hello = await this.transport.request('host/hello', { clientVersion: '0.1.0' })
    this.#patch({
      runtimes: hello.runtimes,
      activeRuntime: this.#snapshot.activeRuntime ?? hello.runtimes[0]?.id ?? null,
      credentialProtection: hello.credentialProtection,
      home: hello.home,
    })
    // Preferences first: they may restore the runtime the user last worked
    // with, and everything below loads for whichever runtime is active.
    await this.loadPreferences()
    await Promise.all([this.refreshRuntime(), this.loadWorkspaces(), this.loadPlugins(), this.loadAccounts()])
    // The header strip is up from the first frame, so what every plan has left
    // is loaded once here rather than on the first ⌘U. Cached readings answer
    // most of these without anyone being asked again.
    void this.loadUsage()
    // The editor plane is pushed the moment the socket opens, which is before
    // any of the above has run — so a plugin's file, marked while this window
    // was closed, arrived with no runtime to open it into. Projected again
    // now that there is one; a plane that was already shown is a no-op.
    this.#showEditorPlane(this.#snapshot.editorPlane)
  }

  async #waitForOpen(): Promise<void> {
    if (this.transport.status === 'open') return
    await new Promise<void>((resolve) => {
      const off = this.subscribe(() => {
        if (this.#snapshot.status === 'open') {
          off()
          resolve()
        }
      })
    })
  }

  /**
   * Chooses the agent new sessions run as.
   *
   * A preference, not a navigation. The conversation on screen belongs to its
   * own agent and stays exactly where it is; the session list is every
   * agent's and stays where it was scrolled to; only a draft — which has no
   * agent of its own — takes on the new one, through `useRuntime()`. This
   * used to blank the list and replace the focused conversation with an
   * empty draft, and the whole window blinked for a pick that changes what
   * ⌘N does next.
   *
   * What the window already knows about the agent is swapped in the same
   * frame — its drafts, its health, its accounts — so nothing waits on the
   * wire that does not have to. What only the agent can answer (its models,
   * options, routes, skills, limits) is cleared and asked for, because a
   * Codex model list under a Claude label would be a lie for as long as the
   * request took.
   */
  async selectRuntime(runtime: RuntimeId): Promise<void> {
    // An agent that crashed says "select the runtime again to restart it",
    // and this is the selecting. The catalogue refresh is the verb that
    // restarts it — and only a crash is restartable that way: an agent that
    // is still starting, or that its launch check blocked, is refused by the
    // refresher and would only cost a round trip. Picking the agent already
    // picked is otherwise a no-op.
    const health = this.#snapshot.healthByRuntime[runtime]
    const crashed = health?.state === 'unavailable' && health.reason === 'crashed'
    if (runtime === this.#snapshot.activeRuntime) {
      if (crashed) await this.refreshCatalog()
      return
    }
    this.#patch({
      activeRuntime: runtime,
      health: this.#snapshot.healthByRuntime[runtime] ?? null,
      account: this.#snapshot.accountsByRuntime[runtime] ?? null,
      // The drafts a runtime was left with come back when it is selected again.
      draftValues: this.#draftsByRuntime[runtime] ?? {},
      models: [],
      runtimeOptions: [],
      draftOptions: null,
      routes: [],
      draftRouteId: null,
      limits: null,
      skills: [],
    })
    // Remembered across launches; losing the user's runtime pick on every
    // restart made the shell feel like it had a favourite vendor.
    void this.transport.request('app/state/set', { patch: { activeRuntime: runtime } }).catch(() => {})
    // Choosing a crashed agent is also "selecting it again": it comes back
    // up, and its health change re-reads the surface once it is ready.
    if (crashed) void this.refreshCatalog()
    await this.refreshRuntime({ history: false })
  }

  /**
   * Reloads everything that depends on which runtime is selected.
   *
   * `history: false` keeps the session list as it is. A switch of the default
   * agent asks for this — the list is every agent's and a re-page would drop
   * the reader back to the first page — while an agent coming up or signing
   * in does not, since its history just became readable.
   */
  async refreshRuntime(options: { readonly history?: boolean } = {}): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    const [health, account, limits, models, runtimeOptions] = await Promise.all([
      this.transport.request('runtime/health', { runtime }).catch(() => null),
      this.transport.request('runtime/account', { runtime }).catch(() => null),
      this.transport.request('runtime/limits', { runtime }).catch(() => null),
      this.transport.request('runtime/models', { runtime }).catch(() => [] as ModelInfo[]),
      this.transport.request('runtime/options', { runtime }).catch(() => [] as ConfigOption[]),
    ])
    // The user may have switched runtime while these were in flight; stale
    // results for the previous one must not stomp the current surface.
    if (this.#snapshot.activeRuntime !== runtime) return
    // The per-runtime maps are what every seat, card and pane reads; a
    // poll that answered only the singular slots left them one step behind,
    // and a crash seen here alone was one the seat could not restart.
    this.#patch({
      health,
      account,
      limits,
      models,
      runtimeOptions,
      ...(health ? { healthByRuntime: { ...this.#snapshot.healthByRuntime, [runtime]: health } } : {}),
      ...(account ? { accountsByRuntime: { ...this.#snapshot.accountsByRuntime, [runtime]: account } } : {}),
    })
    if (health?.state === 'ready') {
      if (options.history !== false) void this.loadHistory({ reset: true })
      void this.loadSkills()
      void this.loadDraftOptions()
    }
    void this.loadRoutes()
  }

  // ------------------------------------------------------------ model routes

  async loadRoutes(): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    try {
      const routes = await this.transport.request('routes/list', { runtime })
      if (this.#snapshot.activeRuntime !== runtime) return
      this.#patch({ routes })
      // A deleted route must not silently ride into the next session.
      if (
        this.#snapshot.draftRouteId &&
        !routes.some((route) => route.id === this.#snapshot.draftRouteId)
      ) {
        this.#patch({ draftRouteId: null })
      }
    } catch {
      if (this.#snapshot.activeRuntime !== runtime) return
      this.#patch({ routes: [] })
    }
  }

  setDraftRoute(routeId: string | null): void {
    this.#patch({ draftRouteId: routeId })
  }

  async saveRoute(route: {
    id?: string
    name: string
    endpoint: string
    wireProtocol: string
    credentialRef: string
    model?: string
  }): Promise<void> {
    try {
      await this.transport.request('routes/save', route)
      await this.loadRoutes()
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  async deleteRoute(id: string): Promise<void> {
    try {
      await this.transport.request('routes/delete', { id })
      await this.loadRoutes()
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /** What every agent did here, whichever vendor made it. */
  async loadAudit(sinceDays = 7): Promise<readonly AuditRow[]> {
    const root = this.#snapshot.workspace?.path
    return this.transport
      .request('audit/query', { ...(root ? { root } : {}), sinceDays })
      .then((rows) => [...rows])
      .catch(() => [])
  }

  /** The host-level permission rules, stored in preferences. */
  async loadPolicyRules(): Promise<readonly PolicyRule[]> {
    try {
      const preferences = await this.transport.request('app/state/get', {})
      const raw = preferences['permissionPolicy']
      return Array.isArray(raw) ? (raw as PolicyRule[]) : []
    } catch {
      return []
    }
  }

  async savePolicyRules(rules: readonly PolicyRule[]): Promise<void> {
    try {
      await this.transport.request('app/state/set', { patch: { permissionPolicy: rules } })
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  async listCredentials(): Promise<readonly StoredCredential[]> {
    return this.transport
      .request('credentials/list', {})
      .then((list) => [...list])
      .catch(() => [])
  }

  /**
   * What a plugin contributes **where you are** — the host's answer, not a
   * filter over the pushed list.
   *
   * The renderer is sent every contribution on connect and again whenever a
   * plugin's set changes, which is the right shape for drawing them and the
   * wrong one for this question: a contribution carries a scope — this
   * workspace, this agent, this conversation, this turn — and only the host
   * evaluates it (`scopeApplies`). Everything the renderer filters by hand
   * filters by *kind* alone, so a scoped contribution reads as global here.
   * Asking is the only way to get the real answer.
   *
   * `kind` is required by the wire, so a caller wanting several asks for
   * several; the calls are local and this is a settings surface, not a
   * per-keystroke path.
   */
  async listCapabilities(
    kind: ContributionKind,
    scope: ScopeQuery,
  ): Promise<readonly CapabilityContribution[]> {
    return this.transport.request('capability/list', { kind, ...scope }).catch((error) => {
      this.notice('error', describe(error))
      return [] as readonly CapabilityContribution[]
    })
  }

  /** The value goes host-ward once and is never readable back. */
  async storeCredential(name: string, value: string): Promise<string | null> {
    try {
      const { ref } = await this.transport.request('credentials/store', { name, value })
      return ref
    } catch (error) {
      this.notice('error', describe(error))
      return null
    }
  }

  /**
   * Forgets a stored secret.
   *
   * A key outlives the thing that made it: `routes/delete` drops the
   * credential its route was the last owner of, but a route that never
   * finished saving leaves one behind with no owner and — until this — no
   * way to reach it. The value was never readable from here, so this is the
   * only verb the renderer has ever had over one.
   */
  async deleteCredential(ref: string): Promise<boolean> {
    try {
      await this.transport.request('credentials/delete', { ref })
      return true
    } catch (error) {
      this.notice('error', describe(error))
      return false
    }
  }

  /**
   * Refreshes what the next session would start with. Draft picks the user
   * already made ride along so the runtime re-declares the list with them
   * applied; picks the runtime now refuses (a model that vanished with an
   * account change) are dropped rather than fought over.
   */
  async loadDraftOptions(): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    const params = {
      runtime,
      ...(this.#snapshot.workspace?.path ? { cwd: this.#snapshot.workspace.path } : {}),
    }
    try {
      const asked = this.#snapshot.draftValues
      const options = await this.transport.request('runtime/sessionDefaults', {
        ...params,
        ...(Object.keys(asked).length > 0 ? { values: asked } : {}),
      })
      // Picks the runtime no longer honours are forgotten here rather than
      // re-sent on every refresh; the list itself is the record of what the
      // next session starts with.
      const values = kept(asked, options)
      this.#draftsByRuntime[runtime] = values
      // A switch is cheap now, so two can happen inside one slow answer: the
      // first agent's defaults must not land on the second agent's draft.
      if (this.#snapshot.activeRuntime !== runtime) return
      this.#patch({ draftValues: values, draftOptions: options.length > 0 ? options : null })
    } catch {
      try {
        const options = await this.transport.request('runtime/sessionDefaults', params)
        if (this.#snapshot.activeRuntime !== runtime) return
        this.#patch({ draftOptions: options.length > 0 ? options : null, draftValues: {} })
      } catch {
        if (this.#snapshot.activeRuntime !== runtime) return
        this.#patch({ draftOptions: null })
      }
    }
  }

  // ------------------------------------------------------------------ sign-in

  /**
   * Starts a sign-in the runtime drives. What comes back is what to show; the
   * outcome arrives later as an `account/loginCompleted` event and is folded
   * into `snapshot.logins[runtime]`, so the view reads state rather than
   * awaiting — the flow finishes in another application, often after the
   * window that started it has been closed and reopened.
   */
  async startLogin(runtime: RuntimeId, method: string): Promise<void> {
    try {
      const start = await this.transport.request('runtime/login', { runtime, method })
      this.#setLogin(runtime, startedLogin(method, start))
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  #setLogin(runtime: RuntimeId, login: LoginState | null): void {
    const logins = { ...this.#snapshot.logins }
    if (login) logins[runtime] = login
    else delete logins[runtime]
    this.#patch({ logins })
  }

  // ------------------------------------------------------------ navigation

  /**
   * What the middle showed, so ← and → can retrace it.
   *
   * `PaneView`, not `SessionKey`. It held session keys while a room lived
   * *beside* the conversation — you never navigated away from one, so there was
   * nothing to come back to. Making main a slot changed that and I shipped it
   * without changing this: opening a session replaced the room, and the only
   * way back was to find it in the tree again. Back is what turns a slot from a
   * thing that loses your place into a jump.
   */
  #visitedBack: PaneView[] = []
  /** The other half of the same stack; see `#visitedBack`. */
  #visitedForward: PaneView[] = []
  #navigating = false

  /** Reopens the previously focused conversation, like a browser's back. */
  async navigateBack(): Promise<void> {
    const target = this.#visitedBack.pop()
    if (!target) return
    const current = this.#mainView()
    if (current) this.#visitedForward.push(current)
    await this.#navigateTo(target)
  }

  async navigateForward(): Promise<void> {
    const target = this.#visitedForward.pop()
    if (!target) return
    const current = this.#mainView()
    if (current) this.#visitedBack.push(current)
    await this.#navigateTo(target)
  }

  /** What the middle is showing, when it is showing one of the two things. */
  #mainView(): PaneView | null {
    const view = focusedPane(this.#snapshot.layout).view
    if (view.kind === 'room') return view
    return view.kind === 'conversation' && view.session ? view : null
  }

  async #navigateTo(target: PaneView): Promise<void> {
    this.#navigating = true
    try {
      if (target.kind === 'room') {
        // The stored view, not a fresh one built from its root. A room view
        // carries what it was watching, and `openTeamRoom` constructs a new
        // one from the root alone — so going back to a room you had arranged
        // returned an empty one, which is the same "lost your place" that Back
        // exists to prevent, one level further down.
        this.showViewIn('main', target)
      } else if (target.kind === 'conversation' && target.session) {
        const { runtime, id } = splitSessionKey(target.session)
        await this.openSession(id, { runtime })
      }
    } finally {
      this.#navigating = false
      this.#patch({})
    }
  }

  /** One click on a workspace group's +: that folder, a fresh draft. */
  async startSessionIn(path: string): Promise<void> {
    if (this.#snapshot.workspace?.path !== path) await this.openWorkspace(path)
    this.newDraft()
  }

  /** Pins a project to the top of the list, or unpins it. */
  togglePinned(root: string): void {
    const pinned = this.#snapshot.listPrefs.pinned
    this.setListPrefs({
      pinned: pinned.includes(root) ? pinned.filter((entry) => entry !== root) : [...pinned, root],
    })
  }

  /**
   * Folds a row in the tree shut, or opens it.
   *
   * The key is a project's root or a room's id — the list holds both now, and
   * the fold is the same fold. Kept in preferences rather than in component
   * state so a room you shut stays shut across a relaunch, which is the whole
   * reason to shut one.
   */
  toggleCollapsed(key: string): void {
    const collapsed = this.#snapshot.listPrefs.collapsed
    this.setListPrefs({
      collapsed: collapsed.includes(key)
        ? collapsed.filter((entry) => entry !== key)
        : [...collapsed, key],
    })
  }

  /**
   * Folds every project shut, or opens all of them. The roots are passed in
   * rather than derived here: the store keeps sessions, and which folders
   * those sessions group into is the list's answer, not the store's.
   */
  setProjectsCollapsed(roots: readonly string[], collapsed: boolean): void {
    const current = this.#snapshot.listPrefs.collapsed
    this.setListPrefs({
      collapsed: collapsed
        ? [...new Set([...current, ...roots])]
        : current.filter((entry) => !roots.includes(entry)),
    })
  }

  /**
   * Moves a project to a place in the list, by hand.
   *
   * There is one manual order in this app and it is `pinned`: an ordered list
   * of the projects the user has put somewhere on purpose. So dropping a
   * project into that run *is* pinning it at that index, and dropping one
   * past the end of the run — onto the automatic part of the list — unpins
   * it and gives it back to the sort. No second ordering, no "manual" sort
   * mode that has to explain what it does to the projects nobody dragged.
   */
  moveProject(root: string, toIndex: number): void {
    const pinned = this.#snapshot.listPrefs.pinned.filter((entry) => entry !== root)
    if (toIndex < 0 || toIndex > pinned.length) {
      this.setListPrefs({ pinned })
      return
    }
    this.setListPrefs({ pinned: [...pinned.slice(0, toIndex), root, ...pinned.slice(toIndex)] })
  }

  /** Whether the "Other projects" fold is open. */
  setOthersOpen(open: boolean): void {
    this.setListPrefs({ othersOpen: open })
  }

  /** Pins a session to the top of its group, or unpins it. */
  toggleSessionPinned(key: string): void {
    const pinned = this.#snapshot.listPrefs.pinnedSessions
    this.setListPrefs({
      pinnedSessions: pinned.includes(key) ? pinned.filter((entry) => entry !== key) : [...pinned, key],
    })
  }

  /** Shows a folder in the OS file browser. The desktop shell supplies the hand-off. */
  async revealWorkspace(path: string): Promise<void> {
    try {
      await this.transport.request('workspace/reveal', { path })
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /**
   * Archives every session in a project, each on the runtime that owns it,
   * and reloads the list once rather than once per session.
   */
  async archiveSessions(sessions: readonly SessionSummary[]): Promise<void> {
    let failed = 0
    for (const summary of sessions) {
      try {
        await this.transport.request('session/archive', {
          runtime: summary.runtime,
          sessionId: summary.id,
          archived: true,
        })
        const key = sessionKey(summary.runtime, summary.id)
        const pane = panes(this.#snapshot.layout.root).find((entry) => sessionOf(entry) === key)
        if (pane) this.closePane(pane.id)
      } catch {
        failed += 1
      }
    }
    if (failed > 0) {
      this.notice('error', `${failed} of ${sessions.length} sessions could not be archived.`)
    }
    await this.loadHistory({ reset: true })
  }

  /** Drops a folder from the opened list; the folder itself is untouched. */
  async forgetWorkspace(path: string): Promise<void> {
    try {
      await this.transport.request('workspace/forget', { path })
      await this.loadWorkspaces()
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  // ------------------------------------------------- accounts, per runtime

  /**
   * Who every runtime is signed in as, for the Agents settings section.
   *
   * Numbered, because this replaces the whole map and three of these fire
   * within a few hundred milliseconds of adding an account — on
   * `runtime/added`, on that account's health going ready, and after the add
   * resolves. Each is a `Promise.all` over *every* runtime, so the one that
   * **resolves** last wins rather than the one that started last: one slow
   * sibling is enough for the earliest pass — taken before the new account
   * could answer — to land after the others and delete its status again,
   * dropping the sign-in page back into the state this whole change exists to
   * remove, with nothing left to re-ask. A late answer is now discarded
   * instead.
   */
  #accountsGeneration = 0

  async loadAccounts(): Promise<void> {
    const generation = ++this.#accountsGeneration
    const entries = await Promise.all(
      this.#snapshot.runtimes.map(async (runtime) => {
        const status = await this.transport
          .request('runtime/account', { runtime: runtime.id })
          .catch(() => null)
        return [runtime.id, status] as const
      }),
    )
    if (generation !== this.#accountsGeneration) return
    const accountsByRuntime: Partial<Record<RuntimeId, AccountStatus>> = {}
    for (const [id, status] of entries) if (status) accountsByRuntime[id] = status
    this.#patch({ accountsByRuntime })
  }

  /**
   * Signs in to one agent without the user choosing how: the first method the
   * runtime can drive on its own. Key methods are skipped — they need a field
   * to paste into, which is the sign-in page's job, not a one-click button's.
   *
   * The ways in are asked for when the snapshot does not have them rather than
   * read as an empty list, because the caller this is written for is "add an
   * account, then sign into it": the account is seconds old, and a runtime
   * that has not answered `runtime/account` yet is one this used to treat as
   * an agent with no sign-in at all — returning silently, so the button that
   * made the account did nothing else. Nothing here is silent now.
   *
   * Three different endings, because they are three different facts and the
   * user's next move differs for each: the ask itself failed, the agent
   * answered and offers nothing this window can drive, or it offers only a
   * key — which the sign-in page *can* take, so sending someone to a terminal
   * for it would be false. Collapsing them into one sentence is the smaller
   * version of the silence this method exists to fix.
   */
  async signInAgent(runtime: RuntimeId): Promise<void> {
    const name =
      this.#snapshot.runtimes.find((entry) => entry.id === runtime)?.presentation.name ?? 'That agent'
    const known = this.#snapshot.accountsByRuntime[runtime]?.signInMethods
    let methods = known
    if (methods === undefined) {
      try {
        methods = (await this.transport.request('runtime/account', { runtime })).signInMethods
      } catch (error) {
        // "Could not ask" is not "has no way in". The old sentence sent people
        // to a terminal over a socket that had blinked.
        this.notice('error', `${name} could not be asked how to sign in: ${describe(error)}`)
        return
      }
    }
    const method = methods.find((entry) => entry.flow === 'browser' || entry.flow === 'deviceCode')
    if (!method) {
      const key = methods.find((entry) => entry.flow === 'apiKey')
      this.notice(
        'error',
        key
          ? `${name} signs in with a key. Open its sign-in page and paste one there.`
          : `${name} has no sign-in this window can start. Open its own tool to sign in.`,
      )
      return
    }
    await this.startLogin(runtime, method.id)
    const start = this.#snapshot.logins[runtime]?.start
    if (start) openExternal(start.url)
  }

  /**
   * An agent that authenticates with a pasted secret. The value goes to the
   * host and into the credential broker; it is never kept in the snapshot,
   * never logged, and cannot be read back — the account list only says that
   * one is stored.
   */
  async storeApiKey(runtime: RuntimeId, methodId: string, value: string): Promise<boolean> {
    const trimmed = value.trim()
    if (trimmed.length === 0) return false
    try {
      const { applied } = await this.transport.request('runtime/apiKey/store', {
        runtime,
        methodId,
        value: trimmed,
      })
      await this.loadAccounts()
      if (runtime === this.#snapshot.activeRuntime) await this.refreshRuntime()
      const name = this.#snapshot.runtimes.find((info) => info.id === runtime)?.presentation.name
      // An agent reads its environment at startup, so what the user needs to
      // know is not "saved" but whether the key is in the agent yet.
      this.notice(
        'info',
        applied === 'restarted'
          ? `Key stored. ${name ?? 'The agent'} restarted with it.`
          : applied === 'busy'
            ? `Key stored. ${name ?? 'The agent'} is mid-turn; it picks the key up on its next start.`
            : 'Key stored.',
      )
      return true
    } catch (error) {
      this.notice('error', describe(error))
      return false
    }
  }

  async clearApiKey(runtime: RuntimeId, methodId: string): Promise<void> {
    try {
      await this.transport.request('runtime/apiKey/clear', { runtime, methodId })
      await this.loadAccounts()
      if (runtime === this.#snapshot.activeRuntime) await this.refreshRuntime()
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /** Abandons a sign-in still in flight, and tells the runtime so. */
  async cancelLogin(runtime: RuntimeId): Promise<void> {
    const pending = this.#snapshot.logins[runtime]
    this.#setLogin(runtime, null)
    if (!pending || pending.outcome.type !== 'pending') return
    await this.transport
      .request('runtime/login/cancel', { runtime, loginId: pending.start.loginId })
      .catch(() => {})
  }

  /** Clears a settled sign-in from view. Use `cancelLogin` for one still pending. */
  dismissLogin(runtime: RuntimeId): void {
    if (this.#snapshot.logins[runtime]) this.#setLogin(runtime, null)
  }

  /**
   * One more account of the same agent, then straight into signing it in.
   *
   * Two calls rather than one because they fail differently: the slot is made
   * and registered first, so a sign-in the user abandons leaves a visible
   * empty account to retry — not a first account quietly overwritten, which is
   * what a single "sign in again" used to do.
   */
  async addAccount(runtime: RuntimeId): Promise<RuntimeId | null> {
    try {
      const { runtime: added } = await this.transport.request('runtime/account/add', { runtime })
      await this.loadAccounts()
      return added
    } catch (error) {
      this.notice('error', describe(error))
      return null
    }
  }

  /**
   * One more account of the same agent, paid for by the user's own endpoint.
   *
   * Unlike `addAccount` there is no sign-in to follow: the key is the whole
   * credential, it travels once, and it is a reference in the broker before
   * this resolves. Same agent, same models — only the bill moves.
   */
  async addGatewayAccount(
    runtime: RuntimeId,
    gateway: { name: string; endpoint: string; apiKey: string },
  ): Promise<RuntimeId | null> {
    try {
      const { runtime: added } = await this.transport.request('runtime/account/add', {
        runtime,
        gateway,
      })
      // No `refreshRuntimes` here: the host pushes `runtime/added` with the
      // new row's info, gateway and all, before this request resolves.
      await this.loadAccounts()
      return added
    } catch (error) {
      this.notice('error', describe(error))
      return null
    }
  }

  /**
   * The agents this build can register without the user writing JSON.
   * Asked when the add-agent surface opens, because availability is a fact
   * about the machine right now — a CLI installed since the last look counts.
   */
  async agentCatalog(): Promise<readonly AgentTemplateInfo[]> {
    return this.transport.request('agents/catalog', {}).catch(() => [])
  }

  /**
   * The public ACP registry, through the host's cache. Asked when a surface
   * that offers agents opens; a host that cannot reach the registry answers
   * with the sentence saying so rather than an error.
   */
  async acpRegistry(): Promise<AcpRegistryCatalogInfo> {
    return this.transport.request('agents/registry', {}).catch(() => ({
      agents: [],
      fetchedAt: null,
      unavailable: 'The ACP registry could not be read.',
    }))
  }

  /**
   * Registers an agent — a known template, a registry entry or a custom
   * command — and lets the host bring it up. The new row arrives as
   * `runtime/added`; failing to start is the runtime's own health to report,
   * on its own row.
   */
  async addAgent(request: AgentRegisterRequest): Promise<RuntimeId | null> {
    const outcome = await this.addAgentTelling(request)
    if ('error' in outcome) {
      this.notice('error', outcome.error)
      return null
    }
    return outcome.runtime
  }

  /**
   * The same registration, refusing in words instead of a notice — for a
   * surface that has room to say why in place, like the sign-in page's
   * registry pane, where a notice would land behind the dialog.
   */
  async addAgentTelling(
    request: AgentRegisterRequest,
  ): Promise<{ runtime: RuntimeId } | { error: string }> {
    try {
      const { runtime } = await this.transport.request('agents/register', request)
      return { runtime }
    } catch (error) {
      return { error: describe(error) }
    }
  }

  /** Unregisters an agent the registry owns. Its software and history stay. */
  /**
   * Every copy of an agent on this machine, looked for afresh — what the
   * agent's settings page shows under Install. Null when the host has no
   * knowledge of this agent, which is what the page says then.
   */
  async installsFor(runtime: RuntimeId): Promise<InstallInfo | null> {
    return this.transport.request('agents/installs', { runtime }).catch(() => null)
  }

  /** Pins one copy as the one that answers, or clears the pin with null. */
  async useInstall(runtime: RuntimeId, path: string | null): Promise<InstallInfo | null> {
    try {
      return await this.transport.request('agents/installs/use', { runtime, path })
    } catch (error) {
      this.notice('error', `The install could not be chosen: ${describe(error)}`)
      return null
    }
  }

  /** Replaces a download HarnessDesk made with the registry's current build. */
  async updateAgent(runtime: RuntimeId): Promise<boolean> {
    try {
      await this.transport.request('agents/update', { runtime })
      return true
    } catch (error) {
      this.notice('error', `The update did not go through: ${describe(error)}`)
      return false
    }
  }

  async removeAgent(runtime: RuntimeId): Promise<boolean> {
    try {
      await this.transport.request('agents/remove', { runtime })
      return true
    } catch (error) {
      this.notice('error', describe(error))
      return false
    }
  }

  /** Signs an account out and forgets its credential home. Shared sessions stay. */
  async removeAccount(runtime: RuntimeId): Promise<void> {
    try {
      await this.transport.request('runtime/account/remove', { runtime })
      await this.loadAccounts()
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  async signOutAgent(runtime: RuntimeId): Promise<void> {
    try {
      await this.transport.request('runtime/logout', { runtime })
      await this.loadAccounts()
      if (runtime === this.#snapshot.activeRuntime) await this.refreshRuntime()
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /** Runtime-wide options for any runtime's card, not only the active one. */
  async optionsFor(runtime: RuntimeId): Promise<readonly ConfigOption[]> {
    return this.transport.request('runtime/options', { runtime }).catch(() => [])
  }

  /** The models any runtime offers, for its settings page rather than the composer. */
  async modelsFor(runtime: RuntimeId): Promise<readonly ModelInfo[]> {
    return this.transport.request('runtime/models', { runtime }).catch(() => [])
  }

  /**
   * Re-asks the active runtime what it offers, now. The new list arrives by
   * `catalog/changed`; the returned check says whether the binary changed.
   */
  async refreshCatalog(): Promise<InstallationCheck | null> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return null
    this.#patch({ catalogRefreshing: true })
    try {
      const result = await this.transport.request('runtime/refreshCatalog', { runtime })
      return result.installation
    } catch {
      return null
    } finally {
      this.#patch({ catalogRefreshing: false })
    }
  }

  /** The focus-return version: only when the last answer is old enough to doubt. */
  async refreshCatalogIfStale(): Promise<void> {
    const runtime = this.#snapshot.runtimes.find((entry) => entry.id === this.#snapshot.activeRuntime)
    if (!runtime || !isStale(runtime)) return
    await this.refreshCatalog()
  }

  async healthFor(runtime: RuntimeId): Promise<RuntimeHealth | null> {
    return this.transport.request('runtime/health', { runtime }).catch(() => null)
  }

  async limitsFor(runtime: RuntimeId): Promise<RateLimits | null> {
    return this.transport.request('runtime/limits', { runtime }).catch(() => null)
  }

  // -------------------------------------------------------------------- usage

  /**
   * Every metered account's standing. Cheap and cached host-side, so the
   * screen can ask on open without thinking about it.
   */
  async loadUsage(): Promise<void> {
    try {
      this.#patch({ usage: await this.transport.request('usage/reports', {}) })
    } catch {
      // A host that cannot answer leaves the last reading in place; the cards
      // show their own age, which is the honest thing to show.
    }
  }

  /**
   * A toast when a plan crosses 80% and again at 95%.
   *
   * Only for a line the desk watched being crossed: `crossings` compares two
   * readings, so nothing fires on the first sight of a lane and a launch into
   * an already-spent account is silent. Being *out* is a condition rather than
   * an event and belongs to the banner, not here.
   */
  #announceUsage(before: readonly UsageReport[], after: readonly UsageReport[]): void {
    const nameFor = (runtime: RuntimeId): string =>
      this.#snapshot.runtimes.find((entry) => entry.id === runtime)?.presentation.name ?? String(runtime)
    for (const alert of crossings(before, after, nameFor, Date.now())) {
      this.notice('warning', alert.message)
    }
  }

  /** Asks the sources again — one agent, or all of them. */
  async refreshUsage(runtime?: RuntimeId): Promise<void> {
    try {
      const reports = await this.transport.request(
        'usage/refresh',
        runtime ? { runtime } : {},
      )
      const touched = new Set(reports.map((report) => `${report.runtime}:${report.account ?? ''}`))
      const before = this.#snapshot.usage
      const kept = before.filter((entry) => !touched.has(`${entry.runtime}:${entry.account ?? ''}`))
      const usage = [...kept, ...reports]
      this.#patch({ usage })
      this.#announceUsage(before, usage)
    } catch {
      // Same as above: keep what we have rather than blank the screen.
    }
  }

  /** Tokens and money from the agents' own transcripts. */
  async ledger(query: LedgerQuery): Promise<LedgerReport | null> {
    return this.transport.request('usage/ledger', query).catch(() => null)
  }

  /** Starts a transcript scan; progress arrives as a notification. */
  async scanUsage(full = false): Promise<void> {
    try {
      this.#patch({ scan: await this.transport.request('usage/scan', full ? { full: true } : {}) })
    } catch {
      // Nothing to do: the button stays available.
    }
  }

  async setOptionFor(runtime: RuntimeId, id: string, value: OptionValue): Promise<void> {
    try {
      await this.transport.request('runtime/options/set', { runtime, optionId: id, value })
      if (runtime === this.#snapshot.activeRuntime) await this.refreshRuntime()
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }


  async logout(): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    try {
      await this.transport.request('runtime/logout', { runtime })
      await this.refreshRuntime()
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  // ------------------------------------------------------------------ history

  /**
   * One history across every backend. The active runtime is paged as
   * before; the others contribute their first page, merged by recency. Every
   * row carries its runtime, so opening one opens it where it lives.
   */
  async loadHistory(options: { reset?: boolean } = {}): Promise<void> {
    // A page continues the list it is a page of. The list is paged around
    // one agent — the anchor — with a first page of every other; a reset
    // rebuilds it around the default agent, and every page after continues
    // along the same anchor even if the default has changed since, because a
    // cursor handed to a different agent names nothing.
    const runtime =
      options.reset || !this.#historyAnchor ? this.#snapshot.activeRuntime : this.#historyAnchor
    if (!runtime || this.#snapshot.historyLoading) return
    this.#historyAnchor = runtime
    this.#patch({ historyLoading: true })
    try {
      // Only agents that have their own history to give. An account sharing
      // another's session store declares `listHistory: false`, so the shared
      // list is listed once rather than once per account.
      const others = this.#snapshot.runtimes
        .filter((entry) => entry.capabilities.listHistory)
        .map((entry) => entry.id)
        .filter((id) => id !== runtime)
      const [page, ...extra] = await Promise.all([
        this.transport.request('session/list', {
          runtime,
          pageSize: 40,
          ...(options.reset ? {} : { cursor: this.#snapshot.historyCursor }),
        }),
        ...others.map((id) =>
          this.transport
            .request('session/list', { runtime: id, pageSize: 20 })
            .then((result) => result.data)
            .catch(() => [] as SessionSummary[]),
        ),
      ])
      const merged = [...page.data, ...extra.flat()].sort((a, b) => b.updatedAt - a.updatedAt)
      this.#patch({
        history: options.reset
          ? merged
          : [...this.#snapshot.history, ...merged.filter(
              (entry) => !this.#snapshot.history.some(
                (existing) => existing.id === entry.id && existing.runtime === entry.runtime,
              ),
            )],
        historyCursor: page.nextCursor ?? null,
      })
    } catch (error) {
      this.#backgroundNotice('warning', describe(error))
    } finally {
      this.#patch({ historyLoading: false })
    }
  }

  /** One search across every backend that can search. */
  async searchHistory(query: string): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    this.#historyQuery = query.trim()
    if (query.trim().length === 0) {
      await this.loadHistory({ reset: true })
      return
    }
    this.#patch({ historyLoading: true })
    try {
      const pages = await Promise.all(
        this.#snapshot.runtimes
          .filter((entry) => entry.capabilities.searchHistory)
          .map((entry) =>
            this.transport
              .request('session/search', { runtime: entry.id, query })
              .then((result) => result.data)
              .catch(() => [] as SessionSummary[]),
          ),
      )
      this.#patch({
        history: pages.flat().sort((a, b) => b.updatedAt - a.updatedAt),
        historyCursor: null,
      })
    } catch (error) {
      this.#backgroundNotice('warning', describe(error))
    } finally {
      this.#patch({ historyLoading: false })
    }
  }

  // ----------------------------------------------------------------- sessions

  /**
   * Opens a conversation: in the pane already showing it, else in the
   * conversation pane (`split` is honoured only when no pane converses, by
   * the layout's one-conversation rule). Reads first so the transcript
   * paints, then resumes so it can take turns.
   */
  async openSession(
    id: SessionId,
    options: {
      /**
       * Which agent holds it. Required, and deliberately never defaulted to
       * the active runtime: ACP agents number their sessions from one, so an
       * id on its own names a different conversation under each agent. Read
       * through the wrong one it is at best a refusal — Codex answers
       * `invalid thread id` to a `claude-code…` string — and at worst someone
       * else's transcript, opened silently under the right-looking title.
       */
      readonly runtime: RuntimeId
      readonly split?: Split['direction']
      /**
       * Which area to read it in. Absent means the main one, which is where a
       * click on a session row has always put it. `right` is how a second
       * transcript gets on screen beside the first — reading what another
       * harness is doing while you work with this one.
       */
      readonly area?: AreaId
      /** A layout restore rather than a person's click. */
      readonly restoring?: boolean
      /**
       * Whether opening it should also *go* to it. True unless said
       * otherwise, because opening a conversation is nearly always going to
       * one — the same exception `newSession` makes, for the same surface.
       *
       * A room draws a member's conversation in a column of its own, so the
       * pane already exists and revealing would replace the room around it.
       * What that column still needs is the half of this that is not
       * navigation: the read and the resume that put the conversation in the
       * snapshot at all. Without it the room's rail could list a member
       * nobody had opened this run — which it now does, deliberately — and
       * clicking it mounted a transcript with no session behind it.
       */
      readonly reveal?: boolean
    },
  ): Promise<void> {
    const { runtime } = options
    const key = sessionKey(runtime, id)
    // Reading the conversation a draft is carrying — the chip's own link —
    // is not abandoning the hand-off. It waits for the next empty draft.
    const carried = this.#snapshot.draftHandoff
    if (carried && carried.runtime === runtime && carried.sessionId === id) this.#parkedHandoff = carried
    if (options.reveal !== false) this.#showInPane(key, options.split, options.area)
    this.#setLoading(key, true)
    try {
      const session = await this.transport.request('session/read', { runtime, sessionId: id })
      this.#setSession(session)
      const live = await this.transport.request('session/resume', { runtime, sessionId: id })
      this.#setSession(live)
    } catch (error) {
      // A conversation another writer holds is a special kind of failure: the
      // read above already succeeded, so the transcript is on screen and whole
      // — what is missing is only the ability to add to it. The pane keeps
      // what it painted, and the way forward is a copy, which the agent will
      // make even while the original is held.
      if (isHeldElsewhere(error)) {
        this.notice('error', describe(error), {
          label: 'Open a copy',
          run: () => void this.forkSession(key),
        })
      } else if (options.restoring) {
        // The layout remembered a conversation the backend no longer holds
        // — an ended ephemeral session, an ACP agent that was restarted.
        // Toasting the same failure on every launch is nagging about
        // history; the honest rendering is an empty pane, or — for one that
        // was docked — no panel at all, since a panel cannot sit empty the
        // way a pane can.
        const pane = panes(this.#snapshot.layout.root).find(
          (candidate) => sessionOf(candidate) === key,
        )
        if (pane) {
          this.#setLayout(showIn(this.#snapshot.layout, pane.id, emptyView()))
        } else {
          const docked = mountedViewsIn(this.#snapshot.workbench).find(
            (entry) => entry.mounted.view.kind === 'conversation' && entry.mounted.view.session === key,
          )
          if (docked) this.#setWorkbench(undockIn(this.#snapshot.workbench, docked.mounted.id))
        }
      } else {
        this.#backgroundNotice('error', describe(error))
      }
    } finally {
      this.#setLoading(key, false)
    }
  }

  /**
   * Starts a conversation in the workspace, or in a fresh worktree of it when
   * `worktree` names one. A worktree session runs on its own branch in its
   * own checkout, so it can edit alongside another without either seeing the
   * other's half-finished work.
   */
  async newSession(
    options: {
      readonly cwd?: string
      readonly worktree?: string
      /** The branch the worktree starts from. HEAD when absent. */
      readonly base?: string
      readonly split?: Split['direction']
      /** Start on this runtime instead of the active one. */
      readonly runtime?: RuntimeId
      /** Which area to read it in; the main one when absent. */
      readonly area?: AreaId
      /**
       * Whether the new conversation takes the screen. True unless said
       * otherwise, because starting one is nearly always going to it.
       *
       * The exception is staffing a room: main is a slot, so revealing the
       * session replaced the very room the person was adding a member *to* —
       * they pressed "Add to room" and were put somewhere else, looking at an
       * empty draft, with no sign the member had joined.
       */
      readonly reveal?: boolean
    } = {},
  ): Promise<SessionKey | null> {
    const runtime = options.runtime ?? this.#snapshot.activeRuntime
    const workspace = options.cwd ?? this.#snapshot.workspace?.path
    if (!runtime || !workspace) {
      this.notice('warning', 'Choose a project folder before starting a session.')
      return null
    }
    try {
      let cwd = workspace
      if (options.worktree !== undefined) {
        const created = await this.transport.request('worktree/create', {
          root: workspace,
          name: options.worktree,
          ...(options.base ? { base: options.base } : {}),
        })
        cwd = created.path
        void this.loadWorktrees()
      }
      // The picks that ride along belong to the runtime the session starts
      // on. The snapshot's draftValues follow the *active* runtime, and a
      // session started elsewhere — a race, a hand-off — must not inherit
      // another agent's model: the target refuses the value and the session
      // never opens.
      const values = this.#draftsByRuntime[runtime] ?? {}
      const session = await this.transport.request('session/create', {
        runtime,
        options: {
          cwd,
          ...(Object.keys(values).length > 0 ? { options: values } : {}),
          ...(this.#snapshot.draftRouteId ? { routeId: this.#snapshot.draftRouteId } : {}),
        } as never,
      })
      this.#setSession(session)
      const key = sessionKey(runtime, session.id)
      if (options.reveal !== false) this.#showInPane(key, options.split, options.area)
      void this.loadHistory({ reset: true })
      return key
    } catch (error) {
      this.notice('error', describe(error))
      return null
    }
  }

  /**
   * One task, two agents, each in its own worktree so neither sees
   * the other's half-finished work. The task goes to the active runtime and
   * the first other ready runtime; the second conversation takes the screen
   * (one conversation at a time) and the first waits in the sidebar, and
   * each worktree's diff is the result to compare.
   */
  async raceAgents(text: string): Promise<void> {
    const active = this.#snapshot.activeRuntime
    const rival = this.#snapshot.runtimes.find((entry) => entry.id !== active)?.id
    if (!active || !rival) {
      this.notice('warning', 'Racing needs a second runtime. Add one in ~/.harnessdesk/agents.json.')
      return
    }
    if (!this.#snapshot.workspace?.git?.branch) {
      this.notice('warning', 'Racing needs a git repository, so each agent gets its own worktree.')
      return
    }
    const stamp = Date.now().toString(36)
    const input: UserContent[] = [{ type: 'text', text }]
    const first = await this.newSession({ worktree: `race-${stamp}-a`, runtime: active })
    if (!first) return
    await this.send(input, first)
    const second = await this.newSession({
      worktree: `race-${stamp}-b`,
      runtime: rival,
      split: 'row',
    })
    if (!second) return
    await this.send(input, second)
  }

  /**
   * Carry a conversation to another agent. No vendor can adopt
   * another's thread, so what travels is the hand-off packet — goal, state,
   * files changed, open plan, commit. It rides as a chip on a fresh draft in
   * the target agent: the chip is the lineage, the textarea stays free for
   * the instruction, and the packet is built when the draft is sent.
   */
  async handOff(target: RuntimeId, carry: Carry = 'summary', key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) {
      // Nothing open to carry — the usage banner offers this over an empty
      // pane and labels it "Switch to …". Doing nothing made it a dead button.
      this.#parkedHandoff = null
      await this.selectRuntime(target)
      return
    }
    const { runtime, id } = splitSessionKey(key)
    const agentName = this.#snapshot.runtimes.find((entry) => entry.id === runtime)?.presentation.name ?? runtime
    const summary = this.#snapshot.history.find((entry) => entry.runtime === runtime && entry.id === id)
    const open = this.#snapshot.sessions.get(key)
    // Some agents never title a conversation; its first ask names it then.
    const firstAsk = open?.turns
      .flatMap((turn) => turn.items)
      .filter((item): item is Extract<AgentItem, { type: 'userMessage' }> => item.type === 'userMessage')
      .flatMap((item) => item.content)
      .map((part) => (part.type === 'text' ? splitContext(part.text).text.trim() : ''))
      .find((text) => text.length > 0)
    const title = shortLabel(sessionLabel(summary?.title ?? open?.title, summary?.preview || firstAsk), 120)
    this.#parkedHandoff = null
    await this.selectRuntime(target)
    // The switch leaves the conversation on screen — it is a preference, not
    // a navigation — and the chip needs an empty pane on the target to land
    // on, so the draft is opened here, by the one verb that means it.
    if (this.#snapshot.activeSessionKey) this.newDraft()
    this.#parkedHandoff = null
    this.#patch({
      draftHandoff: { runtime, sessionId: id as SessionId, carry, agentName, title, cwd: open?.cwd ?? null },
    })
  }

  clearDraftHandoff(): void {
    this.#parkedHandoff = null
    this.#patch({ draftHandoff: null })
  }

  /**
   * The hand-off set aside while its own source conversation is read.
   *
   * The chip offers to open the original, and opening a conversation is what
   * ends a draft — so without this, one click on "read what I am carrying"
   * threw the hand-off away and left the instruction typed under the *source*
   * agent, one Enter from going to the very agent being left.
   */
  #parkedHandoff: DraftHandoff | null = null

  /** The packet a hand-off chip becomes when the draft is sent. */
  async handoffPacket(handoff: DraftHandoff): Promise<string | null> {
    // What this window watched arrive. An ACP agent restarted by a catalogue
    // refresh no longer holds an idle session, and an agent that keeps no
    // store cannot serve one at all — but the conversation is still on
    // screen, and a packet built from nothing while the user looks at the
    // whole transcript is the worst answer available.
    const held = this.#snapshot.sessions.get(sessionKey(handoff.runtime, handoff.sessionId)) ?? null
    let read: Session | null = null
    try {
      read = await this.transport.request('session/read', {
        runtime: handoff.runtime,
        sessionId: handoff.sessionId,
      })
    } catch (error) {
      if (!held) {
        this.notice('warning', describe(error))
        return null
      }
    }
    const items = (session: Session | null): number =>
      session ? session.turns.reduce((total, turn) => total + turn.items.length, 0) : -1
    const session = items(held) > items(read) ? held : read
    if (!session) return null
    const edits = this.#snapshot.planEdits[sessionKey(handoff.runtime, handoff.sessionId)]
    return buildHandoff(
      { agentName: handoff.agentName, session, ...(edits ? { planEdits: edits } : {}) },
      handoff.carry,
    )
  }

  /** The conversation menu's entry; same hand-off, summary carried. */
  async continueElsewhere(target: RuntimeId, key = this.#snapshot.activeSessionKey): Promise<void> {
    await this.handOff(target, 'summary', key)
  }

  /**
   * Opens an empty pane for the next conversation instead of creating one:
   * the runtime's thread comes into being on the first message, so an
   * abandoned "new session" leaves nothing behind in the backend's history.
   */
  newDraft(options: { readonly split?: Split['direction'] } = {}): void {
    const layout = this.#snapshot.layout
    if (options.split) {
      this.#setLayout(splitIn(layout, layout.focused, options.split, emptyView()))
    } else {
      // Replace a conversation, never a tool: "new session" over a terminal
      // must not silently destroy the terminal.
      const focused = findPane(layout, layout.focused)
      const target =
        focused && focused.view.kind === 'conversation'
          ? focused
          : panes(layout.root).find((pane) => pane.view.kind === 'conversation')
      this.#setLayout(
        target
          ? focusPaneIn(showIn(layout, target.id, emptyView()), target.id)
          /* No conversation to replace — the middle is holding a room. It used
             to split beside it, which is how "New session" from a project's own
             menu opened a second pane to the right of the room rather than a
             session. Main is a slot; the draft takes it. */
          : onlyIn(layout, emptyView()),
      )
    }
    // A hand-off belongs to the draft it was handed to: "New session" must
    // not carry the last one into a conversation that was asked to be empty.
    // The exception is the one set aside to read its own source — that is
    // the way back to the draft it came from.
    const parked = this.#parkedHandoff
    this.#parkedHandoff = null
    this.#patch({ draftHandoff: parked })
    // Hand the keyboard to the composer, the only thing to do in an empty pane.
    window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: '' }))
  }

  /**
   * A draft carrying a hand-off becomes a session in the source
   * conversation's folder: the packet names that folder as ground truth, and
   * an agent dropped anywhere else either wastes a trip finding it or, worse,
   * answers about the folder it is actually in.
   */
  #draftCwd(): { readonly cwd: string } | Record<string, never> {
    const carried = this.#snapshot.draftHandoff?.cwd
    return carried ? { cwd: carried } : {}
  }

  async send(input: readonly UserContent[], key = this.#snapshot.activeSessionKey): Promise<void> {
    // Typing into an empty workspace is how a session starts: create it, then
    // send, so the first message is one gesture rather than two.
    key ??= await this.newSession(this.#draftCwd())
    if (!key) return
    try {
      await this.transport.request('turn/send', { ...address(key), input })
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  async forkSession(key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    const { runtime, id } = splitSessionKey(key)
    try {
      const session = await this.transport.request('session/fork', { runtime, sessionId: id })
      this.#setSession(session)
      this.#showInPane(sessionKey(runtime, session.id), 'row')
      void this.loadHistory({ reset: true })
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /** Sets or clears the session's standing objective. */
  async setGoal(objective: string | null, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('session/goal', { ...address(key), objective })
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  /**
   * Switch one skill on or off in one agent.
   *
   * `on` names the agent, defaulting to the focused one — which is all the
   * per-agent settings page ever needed, and not enough for the library,
   * whose whole subject is *other* agents. Toggling Cursor's copy from a
   * page opened while Codex is focused would silently switch the wrong
   * agent's skill, so the caller says which and this stops guessing.
   *
   * The refresh follows the same rule: `loadSkills` only ever reads the
   * focused agent, so it is skipped for anyone else and the caller re-reads
   * whatever view it owns. Calling it anyway would refresh a list the person
   * is not looking at and leave the one they are looking at stale.
   */
  async setSkillEnabled(
    skill: { name: string; path?: string | null },
    enabled: boolean,
    on?: RuntimeId,
  ): Promise<void> {
    const runtime = on ?? this.#snapshot.activeRuntime
    if (!runtime) return
    try {
      await this.transport.request('runtime/skills/setEnabled', {
        runtime,
        name: skill.name,
        ...(skill.path ? { path: skill.path } : {}),
        enabled,
      })
      if (runtime === this.#snapshot.activeRuntime) await this.loadSkills()
    } catch (error) {
      this.notice('error', describe(error))
      throw error
    }
  }

  async loadHooks(): Promise<import('@harnessdesk/protocol').HookInfo[]> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return []
    return this.transport.request('runtime/hooks', {
      runtime,
      ...(this.#snapshot.workspace?.path ? { cwd: this.#snapshot.workspace.path } : {}),
    }).then((hooks) => [...hooks]).catch(() => [])
  }

  /**
   * Re-reads the settings catalogue for the active runtime: its models, and
   * what it says it can be asked to run. Separate from `refreshRuntime` —
   * nothing about health, the account or the draft is in question here.
   */
  async loadCatalogue(): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    const models = await this.transport
      .request('runtime/models', { runtime })
      .catch(() => [] as ModelInfo[])
    if (this.#snapshot.activeRuntime !== runtime) return
    this.#patch({ models })
    await this.loadSkills()
  }

  async loadSkills(): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    try {
      const skills = await this.transport.request('runtime/skills', {
        runtime,
        ...(this.#snapshot.workspace?.path ? { cwd: this.#snapshot.workspace.path } : {}),
      })
      // The default may have moved on while this agent was answering; its
      // skills belong under its own name, not the next agent's.
      if (this.#snapshot.activeRuntime !== runtime) return
      this.#patch({ skills })
    } catch {
      // `runtime/skills` now *throws* when the agent cannot answer (a
      // restarting bridge, a runtime without the method) rather than
      // returning []. Keeping the previous list here would strand another
      // workspace's or runtime's skills on screen — and, after a toggle whose
      // reload failed, show a row in a state the disk does not hold. Clear it:
      // an unanswerable request is not evidence of any particular skill —
      // and a failure that arrives after the default moved on is not
      // evidence about the *next* agent's skills either.
      if (this.#snapshot.activeRuntime !== runtime) return
      this.#patch({ skills: [] })
    }
  }

  /**
   * Archives one conversation, and offers the way back in the same breath.
   *
   * The undo is the point. Archiving is one click from a menu on a row, with
   * no confirmation in front of it, which is only defensible because the row
   * comes straight back — so the toast carries "Undo" rather than reporting
   * what happened and leaving the user to find the archive screen.
   *
   * `owner` is not optional in practice: session ids are unique per agent,
   * not across them, so archiving by the *active* runtime would archive
   * whatever happened to share the id under the agent in front.
   */
  async archiveSession(id: SessionId, owner: RuntimeId, label?: string): Promise<void> {
    try {
      await this.transport.request('session/archive', { runtime: owner, sessionId: id, archived: true })
      const key = sessionKey(owner, id)
      const pane = panes(this.#snapshot.layout.root).find((entry) => sessionOf(entry) === key)
      if (pane) this.closePane(pane.id)
      await this.loadHistory({ reset: true })
      this.notice('info', label ? `Archived "${label}".` : 'Archived.', {
        label: 'Undo',
        run: () => void this.unarchiveSession(id, owner),
      })
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /** Puts one back in the list. Reloads it, so the row reappears at once. */
  async unarchiveSession(id: SessionId, owner: RuntimeId): Promise<void> {
    try {
      await this.transport.request('session/archive', { runtime: owner, sessionId: id, archived: false })
      await this.loadHistory({ reset: true })
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /**
   * Deletes one conversation where its agent keeps it. Throws on refusal
   * rather than swallowing it: the caller has already shown a confirmation
   * promising the conversation is gone, and must be able to say it is not.
   */
  async deleteSession(id: SessionId, owner: RuntimeId): Promise<SessionDeletion> {
    const outcome = await this.transport.request('session/delete', { runtime: owner, sessionId: id })
    const key = sessionKey(owner, id)
    const pane = panes(this.#snapshot.layout.root).find((entry) => sessionOf(entry) === key)
    if (pane) this.closePane(pane.id)
    // A deleted conversation's reworded tasks go with it. They are keyed by
    // session and nothing else ever reads them again, so left behind they are
    // a preference that only grows and is sent on every state sync.
    this.forgetPlanEdits(key)
    await this.loadHistory({ reset: true })
    return outcome
  }

  async renameSession(title: string, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('session/setTitle', { ...address(key), title })
      /*
       * The open conversation takes the name now, rather than waiting for the
       * history reload to bring it back. An agent that keeps no name of its
       * own — every ACP one — reports whatever it always reported, so the
       * reload is not what tells this window the new name; the host is, and it
       * has already agreed.
       */
      const open = this.#snapshot.sessions.get(key)
      if (open) {
        const sessions = new Map(this.#snapshot.sessions)
        sessions.set(key, { ...open, title: title.trim() === '' ? null : title.trim() })
        this.#patch({ sessions })
      }
      void this.loadHistory({ reset: true })
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  // -------------------------------------------------------------------- panes

  /** Makes a pane the target of the composer, the shortcuts and the commands. */
  focusPane(paneId: PaneId): void {
    // Working in the split tree is working in the main area: a docked panel
    // that still claimed the focus would keep the sidebar pointed at its own
    // conversation while you typed into a different one.
    const workbench = this.#snapshot.workbench
    this.#setWorkbench(focusViewIn({ ...workbench, main: focusPaneIn(workbench.main, paneId) }, null))
  }

  /** Gives one tool pane the whole pane area; `collapsePane` hands it back. */
  expandPane(paneId: PaneId): void {
    this.#setLayout(expandIn(this.#snapshot.layout, paneId))
  }

  collapsePane(): void {
    this.#setLayout(collapseIn(this.#snapshot.layout))
  }

  /**
   * Closes a pane. A conversation is detached from the runtime but its
   * transcript stays on disk and in the sidebar; a terminal's process is
   * killed, because nothing else would ever see its output again.
   */
  closePane(paneId: PaneId): void {
    const pane = findPane(this.#snapshot.layout, paneId)
    if (pane) this.#release(pane.view)
    this.#setLayout(closePaneIn(this.#snapshot.layout, paneId))
  }

  #release(view: PaneView): void {
    if (view.kind === 'conversation' && view.session) {
      void this.transport.request('session/close', address(view.session)).catch(() => {})
    }
    if (view.kind === 'terminal') {
      void this.transport.request('terminal/close', { terminalId: view.terminalId }).catch(() => {})
    }
    // Closing the panel is "I need the room", not "throw these pages away":
    // the tabs are kept and the next open brings them back. Only a tab's own
    // × discards a page, which is the one gesture that says so.
    if (view.kind === 'browser') this.#closedBrowser = view
  }

  /** The tabs the browser had when its pane last closed; see `#release`. */
  #closedBrowser: BrowserView | null = null

  // -------------------------------------------------------------------- tools

  /**
   * Opens a file where its definition says a file goes — the right-hand edge.
   *
   * It used to be a pane in the middle, which is where every tool lived before
   * the panel system. The registry says `mounts: ['right', 'bottom']` and the
   * middle is a two-valued slot; the two disagreeing was not a harmless
   * difference of opinion, because `readWorkbench` believes the registry: a
   * file opened into the middle came back on the next launch as a tab in the
   * right panel, having moved itself overnight with nobody's hand on it.
   *
   * `split` is still honoured, because `/open --split` and the pane menu are
   * a person saying "the middle" out loud, and a person may.
   */
  openFile(path: string, options: { readonly split?: Split['direction'] | null } = {}): void {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    const view: PaneView = { kind: 'file', path, runtime }
    if (options.split) this.#showView(view, options.split)
    else this.openDefaultView(view)
  }

  /**
   * The plane, made visible.
   *
   * A plugin that opened a file expects to see it, and the plane arrives
   * whole on every change — including on connect, and again every time any
   * mark moves. So this opens a pane only for documents this window has not
   * already opened: without that, a linter re-decorating on each keystroke
   * would fight the person for the focused pane several times a second.
   *
   * Documents leaving the plane are deliberately *not* closed. A plugin
   * clearing its marks has finished with a file; the person reading it has
   * not, and a pane that vanished under them would be the app taking
   * something away that they, not the plugin, had been given.
   */
  #shownFromPlane = new Set<string>()

  #showEditorPlane(documents: readonly EditorDocument[]): void {
    // A pane is keyed by `(runtime, path)`, so with no runtime yet there is
    // nothing to open *into*. This is the ordinary case on connect — the
    // plane and the sync arrive in the same breath and the plane can win —
    // so it returns without marking anything, and `connect` projects again
    // once the runtimes are known. Marking first was the bug: a document
    // recorded as shown before the open succeeded was never shown at all.
    if (!this.#snapshot.activeRuntime) return
    const live = new Set(documents.map((document) => document.path))
    // Forget the ones that closed, so a later re-open shows again.
    for (const path of [...this.#shownFromPlane]) {
      if (!live.has(path)) this.#shownFromPlane.delete(path)
    }
    for (const document of documents) {
      if (this.#shownFromPlane.has(document.path)) continue
      this.#shownFromPlane.add(document.path)
      /* Already on screen from the person's own navigation: mark it seen and
         leave the layout alone.
         Both places, because a file is docked now and not a pane — a read of
         `layout.root` alone could never be true, so every plane push counted an
         open file as unseen and re-opened it, taking the panel's active tab
         from whatever the person had moved to. `#roomToShow` and
         `#closeViewsOf` ask the same question the same way. */
      const open = [
        ...panes(this.#snapshot.layout.root).map((pane) => pane.view),
        ...mountedViewsIn(this.#snapshot.workbench).map((entry) => entry.mounted.view),
      ].some((view) => view.kind === 'file' && view.path === document.path)
      if (!open) this.openFile(document.path)
    }
  }

  /** What a plugin marked on one file, for the pane that draws it. */
  decorationsFor(path: string): readonly UiDecoration[] {
    return this.#snapshot.editorPlane.find((document) => document.path === path)?.decorations ?? []
  }

  /**
   * What the person did in an editor, on its way to whichever plugin drains it.
   *
   * Fire-and-forget: a keystroke must not wait on the host, and there is
   * nothing here to recover from if the report is lost — the next one carries
   * the same news.
   */
  reportEditor(event: EditorEvent): void {
    void this.transport.request('editor/report', { event }).catch(() => {})
  }

  /** And a preview, for the same reasons — see `openFile`. */
  openPreview(path: string, options: { readonly split?: Split['direction'] | null } = {}): void {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    const view: PaneView = { kind: 'preview', path, runtime }
    if (options.split) this.#showView(view, options.split)
    else this.openDefaultView(view)
  }

  /**
   * The repository's history, beside the conversation. Keyed by the
   * repository's top level, asked of the host first — a conversation in a
   * subfolder and one at the root are the same project, and should land in
   * the same pane. A folder outside git still opens: the pane is where
   * "not a repository" is said.
   */
  /** The latest history the person asked for; older round trips stand down. */
  #gitHistoryIntent = 0

  /**
   * One room's board, as a pane.
   *
   * No round trip: every room's state is already in the snapshot the host
   * pushes, so unlike `openGitHistory` there is nothing to resolve and no race
   * to guard.
   */
  openTeamBoard(room?: string): void {
    const base = this.#roomToShow(room)
    if (!base) return
    /* The board declares the edges and not the middle, and the middle enforces
       that on the way back in — so opening it as a pane put a board beside the
       room it belongs to and then dropped it at the next launch. */
    this.openDefaultView({ kind: 'board', room: base })
  }

  /**
   * Which room a "show me the board" with no argument means.
   *
   * The room being read, then the one the active conversation is a member of,
   * and otherwise nothing. It deliberately does *not* fall back to a folder
   * the way this used to: a project can hold several rooms, so a folder no
   * longer names one, and inventing a room to satisfy a menu item would open
   * a board nobody made. When there is no room to mean, the command does
   * nothing and the sidebar is where one gets started.
   */
  #roomToShow(room?: string): string | undefined {
    if (room) return room
    /* Both places a room can be on screen, not one.
       A room takes the middle and a board takes an edge — since the board
       stopped opening as a pane, reading only `layout.root` made the one
       surface that names a room invisible to the question "which room do you
       mean". A person with that board open, in a conversation belonging to no
       room, asked for the room and got silence with the answer beside them.
       `#closeViewsOf` reads both; so does this. */
    const held = [
      ...panes(this.#snapshot.layout.root).map((pane) => pane.view),
      ...mountedViewsIn(this.#snapshot.workbench).map((entry) => entry.mounted.view),
    ].find((view) => view.kind === 'room' || view.kind === 'board')
    if (held) return (held as { room: string }).room
    const mine = this.#snapshot.activeSessionKey
    if (!mine) return undefined
    for (const state of this.#snapshot.teams.values()) {
      if (state.members.includes(mine)) return state.id
    }
    return undefined
  }

  /**
   * The team room, as a pane. Same keying and the same absence of a round
   * trip as `openTeamBoard` — the channel is already in the snapshot.
   */
  openTeamRoom(room?: string): void {
    const base = this.#roomToShow(room)
    if (!base) return
    // Before the conversation, not after it: sessions on the left, the room in
    // the middle, the thread you are reading on the right.
    this.openDefaultView({ kind: 'room', room: base })
  }

  openGitHistory(root?: string): void {
    const base =
      root ??
      (this.#snapshot.activeSessionKey
        ? this.#snapshot.sessions.get(this.#snapshot.activeSessionKey)?.cwd
        : undefined) ??
      this.#snapshot.workspace?.path
    if (!base) return
    // Two opens in quick succession race their `git/status` round trips;
    // only the latest may place the pane, or the slower answer re-points it
    // at the repository the person already left.
    const intent = ++this.#gitHistoryIntent
    void this.transport
      .request('git/status', { root: base })
      .then((status) => {
        if (intent !== this.#gitHistoryIntent) return
        this.openDefaultView({ kind: 'git', root: status?.root ?? base })
      })
      .catch(() => {
        if (intent !== this.#gitHistoryIntent) return
        this.openDefaultView({ kind: 'git', root: base })
      })
  }

  /** The browser pane, if one is open. There is at most one per layout. */
  /**
   * The browser, wherever it is docked.
   *
   * It used to look only in the split tree, which is what made the browser
   * main-only: every tab verb below is addressed by id, and an id from a panel
   * strip is not a pane id. Both are strings and both are found here, so the
   * verbs stopped caring — which is what let the browser take the right-hand
   * edge, where a page being *referred to* belongs.
   */
  #browserPane(): { readonly id: string; readonly view: BrowserView } | null {
    const found = findViewIn(this.#snapshot.workbench, browserView(BLANK))
    if (!found) return null
    const id = found.area === 'main' ? found.pane : found.mounted.id
    const view = viewAt(this.#snapshot.workbench, id)
    return view?.kind === 'browser' ? { id, view } : null
  }

  /** Applies a change to the browser's view, wherever it is mounted. */
  #patchBrowser(id: string, change: (view: BrowserView) => BrowserView | null): void {
    const current = viewAt(this.#snapshot.workbench, id)
    if (current?.kind !== 'browser') return
    const next = change(current)
    if (next === null) {
      this.#setWorkbench(removeAtIn(this.#snapshot.workbench, id))
      return
    }
    if (next !== current) this.#setWorkbench(replaceViewIn(this.#snapshot.workbench, id, next))
  }

  /**
   * Remembers which members a room has up as columns.
   *
   * The room is in the middle, and the middle is a slot: opening anything else
   * replaces it and unmounts the pane. While this lived in the pane's own
   * state, an arrangement of two transcripts was thrown away by the next
   * click, and Back returned an empty room — which defeats the point of Back,
   * since the slot is exactly what Back exists to compensate for. On the view
   * it rides in the workbench, which is persisted per workspace.
   */
  setRoomWatching(id: string, watching: readonly SessionKey[]): void {
    const current = viewAt(this.#snapshot.workbench, id)
    if (current?.kind !== 'room') return
    const before = current.watching ?? []
    if (before.length === watching.length && before.every((key, at) => key === watching[at])) return
    this.#setWorkbench(
      replaceViewIn(this.#snapshot.workbench, id, { ...current, watching: [...watching] }),
    )
  }

  /**
   * Opens the browser pane, at `url` when given, else where it last was.
   * One browser per layout, several tabs inside it.
   *
   * A URL goes to the **driven** tab and brings it to the front — this is
   * what an agent's `browser_open` reaches from the desktop shell, and the
   * pane's contract is that the page the tools drive is a page on screen.
   * Chromium freezes a `<webview>` nobody is looking at, so a driven tab
   * hidden behind another would screenshot as a stale frame.
   */
  openBrowser(url?: string, options: { readonly split?: Split['direction'] | null } = {}): void {
    const existing = this.#browserPane()
    const sendDriven = (view: BrowserView): BrowserView => {
      if (!url) return view
      const driven = drivenBrowserTab(view)
      return { ...patchBrowserTab(view, driven.id, { url }), active: driven.id }
    }
    if (existing) {
      if (url) this.#patchBrowser(existing.id, sendDriven)
      this.revealView(existing.id)
      return
    }
    // A closed panel gets its pages back — including when it is an agent
    // reopening it, which then navigates the driven tab as usual rather
    // than landing on top of whatever the person was reading.
    const restored = this.#closedBrowser
    this.#closedBrowser = null
    const view = sendDriven(restored ?? browserView(BLANK))
    // An explicit split is still a split — `/browser --split` and the pane
    // menu both mean the middle. Otherwise it goes where its definition says,
    // which is the right-hand edge: a page you are working *from* belongs
    // beside the conversation, not in place of it.
    if (options.split) {
      this.#showView(view, options.split)
      return
    }
    this.openDefaultView(view)
  }

  /**
   * Opens a view where its definition says it belongs.
   *
   * `mounts[0]` is the default area, so "where does this go" is answered once,
   * in `panels/builtins.tsx`, rather than at each of the dozen call sites that
   * open something.
   */
  openDefaultView(view: PaneView): void {
    const area = defaultArea(view)
    if (area) {
      this.showViewIn(area, view)
      return
    }
    /* A kind the registry has not been told about — which in practice means
       the built-ins were never imported. It used to fall through to a split,
       so a registry that had not loaded produced the one arrangement the rules
       forbid rather than a visible failure. Main is a slot either way. */
    this.#showOnly(view)
  }

  /** Brings the driven tab to the front, before the tools act on it. */
  focusDrivenBrowserTab(): void {
    const pane = this.#browserPane()
    if (!pane) return
    // A browser hidden behind another pane's expansion cannot paint, and a
    // frozen webview screenshots as a stale frame — the tools are about to
    // look, so the expansion ends first.
    const { expanded } = this.#snapshot.layout
    if (expanded !== null && expanded !== pane.id) this.#setLayout(collapseIn(this.#snapshot.layout))
    // A zoom on some other area hides this one just as completely as an
    // expanded pane did, and for the tools' purposes the effect is the same:
    // a hidden webview stops painting and screenshots as a stale frame.
    const zoom = this.#snapshot.workbench.zoom
    if (zoom && !areaVisibleIn(this.#snapshot.workbench, areaOfMount(this.#snapshot.workbench, pane.id))) {
      this.unzoomPanel()
    }
    this.#patchBrowser(pane.id, (view) => (view.active === view.driven ? view : { ...view, active: view.driven }))
  }

  /** Records where a tab is now, so the layout restores there. */
  noteBrowserUrl(paneId: PaneId, tabId: string, url: string): void {
    this.#patchBrowser(paneId, (view) =>
      view.tabs.find((tab) => tab.id === tabId)?.url === url ? view : patchBrowserTab(view, tabId, { url }),
    )
  }

  /** Records what a page calls itself, which is what the tab strip shows. */
  noteBrowserTitle(paneId: PaneId, tabId: string, title: string): void {
    this.#patchBrowser(paneId, (view) =>
      view.tabs.find((tab) => tab.id === tabId)?.title === title ? view : patchBrowserTab(view, tabId, { title }),
    )
  }

  newBrowserTab(paneId: PaneId, url?: string): void {
    this.#patchBrowser(paneId, (view) => addBrowserTab(view, url ?? BLANK))
  }

  selectBrowserTab(paneId: PaneId, tabId: string): void {
    this.#patchBrowser(paneId, (view) => (view.active === tabId ? view : { ...view, active: tabId }))
  }

  /**
   * Pages closed by their own ×, newest first — what ⌘⇧T puts back. Bounded,
   * because this is an undo for a slip, not a second history.
   */
  #closedTabs: BrowserTab[] = []

  /** Puts back the last tab closed by its ×, on the page it was on. */
  reopenClosedBrowserTab(paneId: PaneId): void {
    const last = this.#closedTabs.pop()
    if (!last) return
    this.#patchBrowser(paneId, (view) => addBrowserTab(view, last.url))
  }

  get hasClosedBrowserTabs(): boolean {
    return this.#closedTabs.length > 0
  }

  /** Closing the last tab closes the pane, the way closing a window's last tab does. */
  closeBrowserTab(paneId: PaneId, tabId: string): void {
    // Wherever the browser is mounted. Looked up in the split tree alone,
    // this found nothing once the browser lived on the right, and ⌘⇧T had
    // nothing to put back for as long as that lasted.
    const closing = viewAt(this.#snapshot.workbench, paneId)
    if (closing?.kind === 'browser') {
      const tab = closing.tabs.find((entry) => entry.id === tabId)
      if (tab && tab.url !== BLANK) this.#closedTabs = [...this.#closedTabs.slice(-9), tab]
    }
    this.#patchBrowser(paneId, (view) => removeBrowserTab(view, tabId))
    // That last tab was closed on purpose, so unlike closing the panel there
    // is nothing to bring back — `#release` will have kept it otherwise.
    if (!this.#browserPane()) this.#closedBrowser = null
  }

  /** Drags a tab along the strip, as every browser lets you. */
  moveBrowserTab(paneId: PaneId, tabId: string, to: number): void {
    this.#patchBrowser(paneId, (view) => moveBrowserTab(view, tabId, to))
  }

  duplicateBrowserTab(paneId: PaneId, tabId: string): void {
    this.#patchBrowser(paneId, (view) => duplicateBrowserTab(view, tabId))
  }

  /** "Close other tabs" and "Close tabs to the right", from a tab's own menu. */
  closeOtherBrowserTabs(paneId: PaneId, tabId: string, options: { readonly toTheRight?: boolean } = {}): void {
    this.#patchBrowser(paneId, (view) => {
      const index = view.tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) return view
      return keepBrowserTabs(view, (tab, at) => (options.toTheRight ? at <= index : tab.id === tabId))
    })
  }

  /** Hands the tools a different tab. Exactly one tab carries the mark. */
  setBrowserDriven(paneId: PaneId, tabId: string): void {
    this.#patchBrowser(paneId, (view) =>
      view.driven === tabId || !view.tabs.some((tab) => tab.id === tabId) ? view : { ...view, driven: tabId },
    )
  }

  setBrowserDevice(paneId: PaneId, tabId: string, device: BrowserDevice): void {
    this.#patchBrowser(paneId, (view) => patchBrowserTab(view, tabId, { device }))
  }

  closeBrowser(): void {
    const existing = this.#browserPane()
    if (!existing) return
    // A pane in the middle or a view in a dock: `closePane` knows only the
    // split tree, and the browser has opened on the right since the panel
    // system — so `browser_close` asked the pane to go and nothing went, and
    // the next `browser_open` waited on a guest the shell had already let go.
    if (findPane(this.#snapshot.layout, existing.id)) this.closePane(existing.id)
    else this.closeView(existing.id)
  }

  /**
   * Closing the dock bumps this. An open still in flight then belongs to a
   * dock the user has since dismissed — the second click of the double click
   * that closed it — and hands its process back instead of re-opening the
   * dock behind them.
   */
  #dockEpoch = 0

  /**
   * Opens a sandboxed terminal in the dock below the composer, in the
   * focused conversation's directory and under its permissions when there is
   * one, else in the workspace. Each terminal is a tab in the dock; the new
   * one takes the screen. The process is the runtime's; the dock only draws
   * it.
   */
  async openTerminal(
    options: {
      readonly cwd?: string
      readonly command?: readonly string[]
      readonly size?: TerminalSize
    } = {},
  ): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    const sessionKeyNow = this.#snapshot.activeSessionKey
    const session = sessionKeyNow ? this.#snapshot.sessions.get(sessionKeyNow) : undefined
    const cwd = options.cwd ?? session?.cwd ?? this.#snapshot.workspace?.path
    if (!runtime || !cwd) {
      this.notice('warning', 'Choose a project folder before opening a terminal.')
      return
    }
    const epoch = this.#dockEpoch
    try {
      const { terminalId, runtime: provider } = await this.transport.request('terminal/open', {
        runtime,
        cwd,
        size: options.size ?? { rows: 24, cols: 80 },
        ...(session ? { sessionId: session.id } : {}),
        ...(options.command ? { command: options.command } : {}),
      })
      if (epoch !== this.#dockEpoch) {
        void this.transport.request('terminal/close', { terminalId }).catch(() => {})
        return
      }
      this.#setWorkbench(
        dockIn(this.#snapshot.workbench, 'bottom', {
          kind: 'terminal',
          terminalId,
          // The panel names whoever actually hosts the process, so its
          // "runs inside …'s sandbox" hint cannot lie.
          runtime: provider ?? runtime,
          cwd,
          ...(sessionKeyNow && session ? { session: sessionKeyNow } : {}),
          ...(options.command ? { command: options.command } : {}),
        }),
      )
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /** Replaces a tab's exited process with a fresh one of the same shape. */
  async restartTerminal(terminalId = activeTerminal(this.#snapshot.workbench)?.terminalId): Promise<void> {
    const view = terminalsIn(this.#snapshot.workbench).find((entry) => entry.terminalId === terminalId)
    if (!view) return
    try {
      const { terminalId, runtime: provider } = await this.transport.request('terminal/open', {
        runtime: view.runtime,
        cwd: view.cwd,
        size: { rows: 24, cols: 80 },
        ...(view.session ? { sessionId: splitSessionKey(view.session).id } : {}),
        ...(view.command ? { command: view.command } : {}),
      })
      void this.transport.request('terminal/close', { terminalId: view.terminalId }).catch(() => {})
      const mount = mountOfTerminal(this.#snapshot.workbench, view.terminalId)
      // The tab keeps its place in the strip: the process is new, the tab is
      // not, and re-docking would send it to the end and take the screen from
      // whatever the person had moved to.
      if (mount) {
        this.#setWorkbench(
          replaceViewIn(this.#snapshot.workbench, mount, {
            ...view,
            terminalId,
            runtime: provider ?? view.runtime,
          }),
        )
      }
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /** Brings one tab to the screen. */
  selectTerminal(terminalId: string): void {
    const mount = mountOfTerminal(this.#snapshot.workbench, terminalId)
    if (mount) this.activateView('bottom', mount)
  }

  /** Closes one tab and the process in it. */
  closeTerminal(terminalId: string): void {
    const mount = mountOfTerminal(this.#snapshot.workbench, terminalId)
    if (mount) this.closeView(mount)
  }

  /** Closes every terminal, and the processes in them. */
  closeTerminalDock(): void {
    this.#dockEpoch += 1
    let workbench = this.#snapshot.workbench
    for (const view of terminalsIn(workbench)) {
      this.#release(view)
      const mount = mountOfTerminal(workbench, view.terminalId)
      if (mount) workbench = undockIn(workbench, mount)
    }
    this.#setWorkbench(workbench)
  }

  /** Collapses the bottom panel to its tab strip, or brings it back. */
  toggleTerminalDock(): void {
    this.togglePanel('bottom')
  }

  resizeTerminalDock(height: number): void {
    this.resizePanel('bottom', height)
  }

  /**
   * Watches the docked dev server's output for the first localhost port it
   * announces and opens the app in the user's browser — the tail of `/dev`.
   * One shot, with a deadline: a server that never says its port just keeps
   * running in the dock, and nothing hangs waiting on it.
   */
  watchDevServerPort(): void {
    const view = activeTerminal(this.#snapshot.workbench)
    if (!view) return
    let buffer = ''
    const off = this.onTerminal(view.terminalId, (notification) => {
      if (notification.method !== 'terminal/output') return
      buffer += atob(notification.params.data)
      const match = /(?:localhost|127\.0\.0\.1):(\d{2,5})/.exec(buffer)
      if (!match) return
      cleanup()
      const url = `http://localhost:${match[1]}`
      this.notice('info', `Dev server is up — opening ${url}`)
      openExternal(url)
    })
    const timer = setTimeout(() => cleanup(), 60_000)
    const cleanup = (): void => {
      clearTimeout(timer)
      off()
    }
  }

  readonly #terminalListeners = new Map<string, Set<(notification: TerminalNotification) => void>>()

  /** Live bytes and the exit of one terminal, for the pane drawing it. */
  onTerminal(terminalId: string, listener: (notification: TerminalNotification) => void): () => void {
    let listeners = this.#terminalListeners.get(terminalId)
    if (!listeners) {
      listeners = new Set()
      this.#terminalListeners.set(terminalId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#terminalListeners.delete(terminalId)
    }
  }

  /**
   * Shows a tool view. One tool pane *per kind*: a second file replaces the
   * file pane, a second preview the preview — repeated opens must not slice
   * the window into ever-narrower columns. Different kinds coexist, because
   * the workflows need them together: a game's dev server in the terminal
   * while its page sits in the preview is the whole loop. A replaced
   * terminal's process is closed; nothing would ever see its output again.
   */
  #showView(
    view: PaneView,
    split: Split['direction'] | null,
    place: 'before' | 'after' = 'after',
  ): void {
    const layout = this.#snapshot.layout
    const already = panes(layout.root).find((pane) => sameView(pane.view, view))
    const sameKind = panes(layout.root).find((pane) => pane.view.kind === view.kind)
    if (!already && sameKind) {
      this.#release(sameKind.view)
      this.#setLayout(focusPaneIn(showIn(layout, sameKind.id, view), sameKind.id))
      return
    }
    this.#setLayout(openViewIn(layout, view, split ?? undefined, place))
  }

  resizeSplit(splitId: string, ratio: number): void {
    this.#setLayout(resizeIn(this.#snapshot.layout, splitId, ratio))
  }

  #showInPane(key: SessionKey, _split?: Split['direction'], area?: AreaId): void {
    if (area && area !== 'main') {
      // Nothing declares an edge for a conversation any more, so `showViewIn`
      // refuses this — kept as the one place that would have to change if a
      // conversation ever became dockable again.
      this.showViewIn(area, { kind: 'conversation', session: key })
      return
    }
    // A session replaces whatever the middle held, including a room. Splitting
    // is gone: the direction argument survives only so callers need not change.
    this.#showOnly({ kind: 'conversation', session: key })
  }

  /**
   * Applies a layout and persists it for the workspace, so reopening the
   * project brings back the same panes — whose conversations the host still
   * holds if it stayed up, and which resume from history if it did not.
   */
  #setLayout(next: Layout): void {
    // The one place every layout passes through: whatever asked for it, the
    // screen never shows two conversations, and an expansion never outlives
    // its pane or hides what the focus was just moved to.
    this.#setWorkbench({ ...this.#snapshot.workbench, main: settleExpansion(singleConversation(next)) })
  }

  /**
   * The one write path for where anything is on screen.
   *
   * Every verb in this class that moves, docks, resizes, collapses or zooms
   * ends here, so the workbench's invariants are checked once rather than at
   * each of thirty call sites, `snapshot.layout` is written beside the
   * workbench it mirrors, and the whole arrangement is persisted for the
   * project it belongs to.
   */
  #setWorkbench(next: Workbench): void {
    const workbench = settleWorkbench(next)
    this.#patch({ workbench, layout: workbench.main, detailsTab: visibleInspector(workbench) })
    const workspace = this.#snapshot.workspace?.path
    if (!workspace) return
    const layouts = { ...(this.#layouts ?? {}), [workspace]: workbench }
    this.#layouts = layouts
    this.#persistLayouts()
  }

  /**
   * Saved under `layouts` still, and read by `readWorkbench`, which takes both
   * shapes: the key is old, the document inside it is new, and a person
   * upgrading finds their panes rather than an empty window.
   */
  #layouts: Record<string, Workbench> | null = null
  #persistLayouts = coalesce(() => {
    void this.transport.request('app/state/set', { patch: { layouts: this.#layouts ?? {} } }).catch(() => {})
  })

  /** Brings back the panels saved for this workspace, or starts with one empty pane. */
  #restoreLayout(workspace: string | null): void {
    const raw = workspace ? this.#layouts?.[workspace] : null
    const saved = readWorkbench(raw)
    // Pages belong to the project they were opened for: a browser closed in
    // one workspace must not reappear in the next one.
    this.#closedBrowser = null
    // The terminals of a document written before the bottom panel existed. The
    // processes are still running on the host, so they are re-docked rather
    // than dropped — see `strayTerminals`.
    /* Where a displaced tool lands: the area the registry says it opens in,
       and the right edge only if it names none. `defaultArea` can answer
       `main`, which is the one place these cannot go — the pair that belongs
       there is never displaced in the first place, so this is a guard rather
       than a case. */
    const dockFor = (view: PaneView): DockId => {
      const home = defaultArea(view)
      return home && home !== 'main' ? home : 'right'
    }
    // And the tools a document written before that could have kept in main —
    // git, a browser, a file. They are re-docked where they are allowed rather
    // than dropped, so an upgrade moves a panel instead of losing one.
    const rehomed = saved
      ? strayPanels(raw).reduce(
          (acc, view) => dockIn(acc, dockFor(view), view),
          strayTerminals(raw).reduce((acc, view) => dockIn(acc, 'bottom', view), saved),
        )
      : null
    const workbench = rehomed ?? emptyWorkbench()
    // Persisting what was just read back would be a no-op write; set directly.
    this.#patch({
      workbench,
      layout: workbench.main,
      detailsTab: visibleInspector(workbench),
    })
    void this.#resumeVisible()
  }

  // ------------------------------------------------------------- panels

  /**
   * The panel verbs.
   *
   * Each is one line over `state/workbench.ts`, which is the point: the rules
   * about what may be docked where, what a close does to the tab beside it and
   * when a zoom has to end live in a pure module with tests, and this class
   * only says which of them a click meant.
   */

  /** Mounts a view in an area, bringing it forward if it is already somewhere. */
  showViewIn(area: AreaId, view: PaneView): void {
    if (!permits(view, area)) return
    if (area === 'main') {
      // Main is a slot: whatever was there is replaced, never split beside.
      this.#showOnly(view)
      return
    }
    this.#setWorkbench(dockIn(this.#snapshot.workbench, area, view))
  }

  /**
   * Put one thing in the middle. What it displaced is not closed.
   *
   * This used to release the outgoing view, on the reasoning that main can
   * only hold a conversation or a room and neither holds anything disposable.
   * A conversation holds the one thing that matters most: its attachment to
   * the agent. Releasing it sends `session/close`, so opening a second agent
   * detached the first — it left the Room, its queued messages were pushed
   * back, and a room of three agents could not be assembled from the UI at all,
   * because only the last one opened was ever live.
   *
   * Replacing what is in the middle is navigation, not closing. The displaced
   * conversation is still in the sidebar, still on the board, and still one
   * Back away. Closing is its own gesture — `closePane` and `closeView` — and
   * that is where releasing belongs.
   */
  #showOnly(view: PaneView): void {
    this.#setLayout(onlyIn(this.#snapshot.layout, view))
  }

  /** Closes a docked view, releasing whatever it was holding open. */
  closeView(id: MountedId): void {
    const mounted = this.#snapshot.workbench
    const found = DOCKS.flatMap((area) => dockViews(mounted[area])).find((entry) => entry.id === id)
    if (found) this.#release(found.view)
    this.#setWorkbench(undockIn(mounted, id))
  }

  /**
   * Docking: the same view, a different area — or, with `into`, the other half
   * of the split it is already in, which is how two halves are put back
   * together.
   */
  moveView(id: string, to: AreaId, into?: StackId): void {
    this.#setWorkbench(moveViewIn(this.#snapshot.workbench, id, to, permits, into))
  }

  activateView(area: DockId, id: MountedId): void {
    this.#setWorkbench(activateIn(this.#snapshot.workbench, area, id))
  }

  /**
   * Brings whatever is at an id to the front, wherever it is: ends a zoom
   * hiding it, opens the panel holding it, puts its tab on top, and gives it
   * the focus.
   *
   * Every "open the X" verb needs this for the case where X is already open,
   * and each of the four steps has been the reason a button appeared to do
   * nothing at least once.
   */
  revealView(id: string): void {
    const area = areaOfMount(this.#snapshot.workbench, id)
    if (area === 'main') {
      this.focusPane(id)
      return
    }
    this.#setWorkbench(focusViewIn(activateIn(this.#snapshot.workbench, area, id), id))
  }

  /**
   * Summons a view by kind — the one place that answers "show me X".
   *
   * ⌘K and the conversation header's View group both come here, so the two
   * cannot disagree about what a name does. Kinds that need a subject resolve
   * it the way they always have: the board and the room from the project, the
   * repository from the conversation's folder.
   */
  showView(kind: PaneView['kind']): void {
    switch (kind) {
      case 'git':
        this.openGitHistory()
        return
      case 'board':
        this.openTeamBoard()
        return
      case 'room':
        this.openTeamRoom()
        return
      case 'browser':
        this.openBrowser()
        return
      case 'terminal':
        void this.openTerminal()
        return
      case 'changes':
      case 'trajectory':
      case 'agents':
      case 'activity':
      case 'tasks':
        this.setDetailsTab(kind)
        return
      default:
        return
    }
  }

  /**
   * Marks a docked panel as the one being worked in — the dock's answer to
   * `focusPane`. Passing null hands focus back to the main area, which is what
   * a click anywhere in the split tree does.
   */
  focusView(id: MountedId | null): void {
    if ((this.#snapshot.workbench.focus ?? null) === (id ?? null)) return
    this.#setWorkbench(focusViewIn(this.#snapshot.workbench, id))
  }

  resizePanel(area: DockId, size: number): void {
    this.#setWorkbench(resizeDockIn(this.#snapshot.workbench, area, size))
  }

  /**
   * Shows two of a panel's views at once, side by side or one above the other.
   *
   * The direction is the split's, not the area's — which is why this takes it
   * as an argument rather than reading a setting. An area-level orientation
   * flag cannot say "a row inside the top half of a column", and that is the
   * second thing anybody wants.
   */
  splitPanel(id: MountedId, direction: 'row' | 'column', place: 'before' | 'after' = 'after'): void {
    this.#setWorkbench(splitDockIn(this.#snapshot.workbench, id, direction, place))
  }

  /** Drags the seam between two halves of one panel. */
  resizePanelSplit(area: DockId, branchId: string, ratio: number): void {
    this.#setWorkbench(resizeDockSplitIn(this.#snapshot.workbench, area, branchId, ratio))
  }

  /** Collapses a panel to its tab strip, or brings it back. */
  togglePanel(area: DockId): void {
    this.#setWorkbench(toggleDockIn(this.#snapshot.workbench, area))
  }

  /** Gives an area the main content area, or the whole window. Again to leave. */
  zoomPanel(area: AreaId, scope: Zoom['scope']): void {
    this.#setWorkbench(zoomAreaIn(this.#snapshot.workbench, area, scope))
  }

  /**
   * The same, for a pane in the middle — where it is two facts, not one.
   *
   * A zoom names an *area*; inside `main` it is `expanded` that names the
   * pane, so one press means "this thing, alone" only if both move. They were
   * two calls, and two calls are two renders' worth of intermediate state: a
   * moment where the expansion is cleared and the zoom is not, or the reverse.
   * React batches them in one handler and `collapse()` reads nothing about the
   * zoom, so nothing was visibly wrong — but "nothing is wrong as long as the
   * caller happens to be inside an event handler and neither function grows a
   * dependency on the other" is a promise this class should not be making to
   * itself. It is one write now, so there is no order to get right.
   *
   * The expansion goes through the same settling `#setLayout` applies, because
   * bypassing it is how an expansion outlives its pane.
   */
  zoomMainPane(paneId: PaneId, scope: Zoom['scope']): void {
    const workbench = this.#snapshot.workbench
    const held = workbench.zoom
    // A second press of the same scope is a request to leave — the rule
    // `zoomArea` applies below, asked here as well because the expansion has
    // to leave with it.
    const leaving = held?.area === 'main' && held.scope === scope
    const main = leaving ? collapseIn(workbench.main) : expandIn(workbench.main, paneId)
    this.#setWorkbench(
      zoomAreaIn(
        { ...workbench, main: settleExpansion(singleConversation(main)) },
        'main',
        scope,
      ),
    )
  }

  unzoomPanel(): void {
    this.#setWorkbench(unzoomIn(this.#snapshot.workbench))
  }

  /**
   * Every conversation on screen whose transcript the host no longer holds
   * live is resumed from history — in a pane *or* in a panel.
   *
   * Walking only the split tree left a docked transcript blank until somebody
   * clicked it, which is a conversation that restored as an empty box.
   */
  async #resumeVisible(): Promise<void> {
    const docked = mountedViewsIn(this.#snapshot.workbench).map((entry) => entry.mounted.view)
    const onScreen = [...panes(this.#snapshot.layout.root).map((pane) => pane.view), ...docked]
    for (const view of onScreen) {
      const session = view.kind === 'conversation' ? view.session : null
      if (!session) continue
      const known = this.#snapshot.sessions.get(session)
      if (known?.status.type === 'active' || known?.status.type === 'idle') continue
      const { runtime, id } = splitSessionKey(session)
      await this.openSession(id, { runtime, restoring: true })
    }
  }

  #setLoading(key: SessionKey, loading: boolean): void {
    const next = new Set(this.#snapshot.loadingSessions)
    if (loading) next.add(key)
    else next.delete(key)
    this.#patch({ loadingSessions: next })
  }

  // ---------------------------------------------------------------- worktrees

  /** Raises the new-worktree dialog for a repository, or puts it away. */
  askNewWorktree(root: string | null): void {
    this.#patch({ newWorktreeFor: root })
  }

  // ---------------------------------------------------------------- the team

  /** The user adds work to one room's board. */
  async teamAdd(
    room: string,
    args: {
      title: string
      detail?: string
      files?: readonly string[]
      dependsOn?: readonly number[]
      plan?: number
    },
  ): Promise<void> {
    await this.transport.request('team/add', { room, ...args })
  }

  /** Names a goal. Creates the heading and nothing else — the work follows. */
  async teamPlan(room: string, goal: string): Promise<void> {
    await this.transport.request('team/plan', { room, goal })
  }

  /**
   * Puts a finished goal away. The host refuses while anything on it is live
   * and says what — returned rather than thrown, because it is an answer the
   * person needs to read, not a failure.
   */
  async teamWrap(room: string, plan: number): Promise<string> {
    return (await this.transport.request('team/wrap', { room, plan })) as string
  }

  /**
   * The user's verbs over an intent; the host referees, so these always win.
   *
   * `reason` is read on `block` and ignored by the rest. Stopping a job used to
   * be something only the agent holding it could do, so a person who knew a job
   * should not be worked could only abandon it — which says something else, and
   * says it permanently.
   */
  async teamIntent(
    room: string,
    id: number,
    action: 'reopen' | 'abandon' | 'done' | 'release' | 'block',
    reason?: string,
  ): Promise<void> {
    await this.transport.request('team/intent', { room, id, action, ...(reason ? { reason } : {}) })
  }

  /** Posts into the channel — to one member, or to everyone in the room. */
  async teamPost(
    room: string,
    text: string,
    to?: { runtime: RuntimeId; sessionId: SessionId },
  ): Promise<void> {
    await this.transport.request('team/post', { room, text, ...(to ? { to } : {}) })
  }

  /**
   * One message to many members, each with its own values, as one action:
   * the host fills the template per recipient, delivers them together and
   * commits the board once.
   */
  async teamHandout(
    room: string,
    template: string,
    recipients: readonly {
      readonly runtime: RuntimeId
      readonly sessionId: SessionId
      readonly vars?: Readonly<Record<string, string>>
    }[],
  ): Promise<{ batch: string; delivered: number; queued: number; refused: number }> {
    return this.transport.request('team/handout', { room, template, recipients })
  }

  /** Board-only mode: off stops agents messaging; claims and signals continue. */
  async teamMessaging(room: string, enabled: boolean): Promise<void> {
    await this.transport.request('team/messaging', { room, enabled })
  }

  /**
   * What one member does with a message addressed to it.
   *
   * The narrow form of board-only: that switch governs every message in the
   * room, this one governs the conversation you point at. `hold` is the
   * interesting mode — nothing is lost, the messages pile up and the chat's
   * "held" count releases them — and it is what a member mid-refactor wants
   * rather than being cut off.
   */
  async setTeamInbound(runtime: RuntimeId, sessionId: SessionId, mode: TeamInbound): Promise<void> {
    await this.transport.request('team/inbound', { runtime, sessionId, mode })
  }

  /** Releases one held message to its receiver. */
  async teamDeliver(room: string, entryId: string): Promise<void> {
    await this.transport.request('team/deliver', { room, entryId })
  }

  /**
   * Who a post can reach in this room, attested by the host. The panel must
   * not derive this from the folder — membership is explicit, and a worktree's
   * conversation belongs to the workspace its checkout hangs off, which only
   * the host resolves.
   */
  async teamPeers(room: string): Promise<readonly TeamPeerInfo[]> {
    return await this.transport.request('team/peers', { room })
  }

  /**
   * Starts a room in a project, and shows it.
   *
   * Nothing makes a room implicitly. Being open in a folder used to be enough
   * to share a board, which is why "New session → A room" opened a surface
   * that had never been created and could not be listed anywhere: there was
   * no object to list. A room exists because somebody made one and named it.
   */
  async createRoom(root: string, name: string): Promise<string> {
    const state = (await this.transport.request('team/room/create', {
      root,
      name,
    })) as TeamState
    const teams = new Map(this.#snapshot.teams)
    teams.set(state.id, state)
    this.#patch({ teams })
    this.openTeamRoom(state.id)
    return state.id
  }

  async renameRoom(room: string, name: string): Promise<void> {
    await this.transport.request('team/room/rename', { room, name })
  }

  /**
   * Puts a room away for good, and returns what went with it so the surface
   * can say so. The conversations that were in it are untouched.
   */
  async deleteRoom(room: string): Promise<{
    name: string
    intents: number
    members: number
    messages: number
  }> {
    return (await this.transport.request('team/room/delete', { room })) as {
      name: string
      intents: number
      members: number
      messages: number
    }
  }

  /** Closes every pane and panel showing one room, wherever they are docked. */
  #closeViewsOf(room: string): void {
    const showing = (view: PaneView): boolean =>
      (view.kind === 'room' || view.kind === 'board') && view.room === room
    for (const pane of panes(this.#snapshot.layout.root)) {
      if (showing(pane.view)) this.#setLayout(showIn(this.#snapshot.layout, pane.id, emptyView()))
    }
    for (const entry of mountedViewsIn(this.#snapshot.workbench)) {
      if (showing(entry.mounted.view)) this.closeView(entry.mounted.id)
    }
  }

  /** Puts a conversation in a room. The host refuses one from another project. */
  async joinRoom(room: string, runtime: RuntimeId, sessionId: SessionId): Promise<void> {
    await this.transport.request('team/room/join', { room, runtime, sessionId })
  }

  /** Takes a conversation out of a room; it keeps running, on its own. */
  async leaveRoom(room: string, runtime: RuntimeId, sessionId: SessionId): Promise<void> {
    await this.transport.request('team/room/leave', { room, runtime, sessionId })
  }

  /** Asks the shell to open a settings page, or clears the request once it has. */
  askSettings(section: string | null): void {
    this.#patch({ settingsFor: section })
  }

  async loadWorktrees(): Promise<void> {
    const root = this.#snapshot.workspace?.path
    if (!root) {
      this.#patch({ worktrees: [] })
      return
    }
    try {
      this.#patch({ worktrees: await this.transport.request('worktree/list', { root }) })
    } catch {
      this.#patch({ worktrees: [] })
    }
  }

  /**
   * Removes a worktree. Without `force` the host refuses when work would be
   * lost; the caller shows what would be lost and asks before sending force.
   */
  async removeWorktree(path: string, force = false): Promise<boolean> {
    try {
      const { branch } = await this.transport.request('worktree/remove', {
        path,
        ...(force ? { force: true } : {}),
      })
      this.notice('info', branch ? `Worktree removed. Branch ${branch} was kept.` : 'Worktree removed.')
      // Panes living in the removed checkout point at a directory that no
      // longer exists; leaving them open invites edits into the void.
      for (const pane of panes(this.#snapshot.layout.root)) {
        const key = sessionOf(pane)
        const session = key ? this.#snapshot.sessions.get(key) : undefined
        if (session && (session.cwd === path || session.cwd.startsWith(`${path}/`))) {
          this.closePane(pane.id)
        }
      }
      await this.loadWorktrees()
      return true
    } catch (error) {
      this.notice('warning', describe(error))
      return false
    }
  }

  /**
   * Sets one of the session's declared options. The new option list arrives
   * as a `session/options` event and folds into the session, so nothing is
   * patched here — what the runtime believes is the only state worth showing.
   */
  async setOption(id: string, value: OptionValue, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key || !this.#snapshot.sessions.has(key)) {
      await this.#setDraftOption(id, value)
      return
    }
    try {
      await this.transport.request('session/options/set', { ...address(key), optionId: id, value })
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  /**
   * A pick for the next session, before it exists. The runtime re-declares
   * the draft list with the pick applied — the same constraint model live
   * sessions use — and a refused pick reverts rather than half-applying.
   * Picks persist per runtime, so the next session starts like the last one.
   */
  async #setDraftOption(id: string, value: OptionValue): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    await this.setNewSessionDefault(runtime, id, value)
  }

  /**
   * What a new session on this agent would start with, the stored picks
   * applied. The same question the composer asks for its pre-session
   * controls — Settings and the composer read one answer.
   */
  async newSessionDefaultsFor(runtime: RuntimeId): Promise<readonly ConfigOption[]> {
    const values = this.#draftsByRuntime[runtime] ?? {}
    try {
      return await this.transport.request('runtime/sessionDefaults', {
        runtime,
        ...(this.#snapshot.workspace?.path ? { cwd: this.#snapshot.workspace.path } : {}),
        ...(Object.keys(values).length > 0 ? { values } : {}),
      })
    } catch {
      return []
    }
  }

  /**
   * One default for one agent's next sessions, persisted host-side under the
   * same key the composer's picks use — there is exactly one set of picks per
   * agent, whichever surface wrote it. When the agent is the active one the
   * open draft follows immediately.
   */
  async setNewSessionDefault(
    runtime: RuntimeId,
    id: string,
    value: OptionValue,
  ): Promise<readonly ConfigOption[]> {
    const asked = { ...(this.#draftsByRuntime[runtime] ?? {}), [id]: value }
    try {
      const options = await this.transport.request('runtime/sessionDefaults', {
        runtime,
        ...(this.#snapshot.workspace?.path ? { cwd: this.#snapshot.workspace.path } : {}),
        values: asked,
      })
      const values = kept(asked, options)
      // What the runtime did with a pick is read off the list it answered
      // with, not assumed from the call returning. A model with no thinking
      // mode leaves the switch off and says why; keeping `thinking: true`
      // stored anyway would send it again on the next question, and again
      // after that.
      for (const dropped of Object.keys(asked)) {
        if (dropped in values || dropped === id || options.length === 0) continue
        const option = findOption(options, dropped)
        this.notice(
          'info',
          option?.disabled ?? `This model has no ${option?.label ?? dropped} setting, so it was left alone.`,
        )
      }
      const refused = findOption(options, id)
      if (refused?.disabled && !(id in values)) this.notice('info', refused.disabled)
      this.#draftsByRuntime[runtime] = values
      if (this.#snapshot.activeRuntime === runtime) {
        this.#patch({ draftValues: values, draftOptions: options.length > 0 ? options : null })
      }
      void this.transport
        .request('app/state/set', { patch: { draftValues: this.#draftsByRuntime } })
        .catch(() => {})
      return options
    } catch (error) {
      this.notice('warning', describe(error))
      return this.newSessionDefaultsFor(runtime)
    }
  }

  /**
   * Shows or hides one of an agent's models in the composer's picker.
   *
   * Nothing is told to the agent: the model stays available to anything that
   * names it, including a conversation already running on it and a preset
   * that picks it. This only decides what the list offers, which is the
   * difference between a picker and a catalogue.
   */
  setModelHidden(runtime: RuntimeId, modelId: string, hidden: boolean): void {
    const current = this.#snapshot.hiddenModels[runtime] ?? []
    const next = hidden
      ? current.includes(modelId)
        ? current
        : [...current, modelId]
      : current.filter((id) => id !== modelId)
    if (next === current) return
    const hiddenModels = { ...this.#snapshot.hiddenModels, [runtime]: next }
    this.#patch({ hiddenModels })
    void this.transport.request('app/state/set', { patch: { hiddenModels } }).catch(() => {})
  }

  /**
   * Shows or hides an agent's whole catalogue at once — the two ends of a
   * long list, so narrowing it to three models is "hide all, switch on the
   * three" rather than a hundred and one clicks.
   *
   * Hiding everything is allowed and is not a trap: the picker always keeps
   * the model the draft or session is actually on, so it is never empty, and
   * this page is where they come back from.
   */
  setAllModelsHidden(runtime: RuntimeId, hidden: boolean): void {
    const current = this.#snapshot.hiddenModels[runtime] ?? []
    const next = hidden ? this.#snapshot.models.map((model) => model.id) : []
    if (next.length === current.length && next.every((id) => current.includes(id))) return
    const hiddenModels = { ...this.#snapshot.hiddenModels, [runtime]: next }
    this.#patch({ hiddenModels })
    void this.transport.request('app/state/set', { patch: { hiddenModels } }).catch(() => {})
  }

  #draftsByRuntime: Record<string, Readonly<Record<string, OptionValue>>> = {}

  /**
   * Applies a saved preset, one option at a time, stopping at the first
   * refusal so a preset that no longer fits the runtime fails visibly rather
   * than leaving the session half-changed.
   */
  async applyPreset(preset: AgentPreset, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key || !this.#snapshot.sessions.has(key)) {
      for (const [id, value] of Object.entries(preset.values)) {
        await this.#setDraftOption(id, value)
      }
      return
    }
    try {
      for (const [id, value] of Object.entries(preset.values)) {
        await this.transport.request('session/options/set', { ...address(key), optionId: id, value })
      }
    } catch (error) {
      this.notice('warning', `${preset.name}: ${describe(error)}`)
    }
  }

  /**
   * Undo the last turns. Files stay — the runtime changes its own history,
   * not the working tree — so the caller has warned the user before this.
   */
  async rollback(turns: number, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('session/rollback', { ...address(key), turns })
      this.notice('info', turns === 1 ? 'Dropped the last turn.' : `Dropped the last ${turns} turns.`)
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /**
   * Puts back the files one turn changed. The host reverses that turn's diff
   * and refuses whole when a file was edited since, so there is nothing to
   * warn about beforehand — the refusal is the warning.
   */
  revertTurn(turnId: string, key = this.#snapshot.activeSessionKey): Promise<boolean> {
    return this.#applyTurn(turnId, 'undo', key)
  }

  /**
   * Writes those files again after an undo — the same diff, forward. An undo
   * the user did not mean is otherwise unrecoverable: the agent's edits are
   * not in git, and nothing else on the machine remembers them.
   */
  redoTurn(turnId: string, key = this.#snapshot.activeSessionKey): Promise<boolean> {
    return this.#applyTurn(turnId, 'redo', key)
  }

  async #applyTurn(
    turnId: string,
    direction: 'undo' | 'redo',
    key = this.#snapshot.activeSessionKey,
  ): Promise<boolean> {
    if (!key) return false
    try {
      const { files } = await this.transport.request('session/revertTurn', { ...address(key), turnId, direction })
      const one = files.length === 1
      this.notice(
        'info',
        direction === 'undo'
          ? one
            ? `Put ${files[0]} back.`
            : `Put ${files.length} files back.`
          : one
            ? `Wrote the turn's change to ${files[0]} again.`
            : `Wrote the turn's changes to ${files.length} files again.`,
      )
      return true
    } catch (error) {
      this.notice('error', describe(error))
      return false
    }
  }

  async compact(key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('session/compact', address(key))
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  async setMemoryMode(enabled: boolean, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('session/memory', { ...address(key), enabled })
      this.notice('info', enabled ? 'Memory on for this conversation.' : 'Memory off for this conversation.')
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  async review(target: ReviewRequest, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('session/review', { ...address(key), target })
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  // ------------------------------------------------------------ extensions

  async detectImports(): Promise<readonly import('@harnessdesk/protocol').ImportableConfig[]> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return []
    return this.transport
      .request('runtime/imports/detect', { runtime, ...(this.#snapshot.workspace?.path ? { cwd: this.#snapshot.workspace.path } : {}) })
      .catch(() => [])
  }

  async applyImports(items: readonly import('@harnessdesk/protocol').ImportableConfig[]): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    try {
      await this.transport.request('runtime/imports/apply', { runtime, items })
      this.notice('info', 'Imported. Restart the runtime if changes do not appear.')
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /** The selected runtime's plugin catalogue, or an empty one. */
  async loadCatalog(): Promise<RuntimeCatalog> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return { plugins: [], marketplaces: [], loadErrors: [], featured: [] }
    return this.transport
      .request('runtime/catalog', { runtime, ...(this.#snapshot.workspace?.path ? { cwd: this.#snapshot.workspace.path } : {}) })
      .catch((error: unknown) => {
        this.notice('warning', describe(error))
        return { plugins: [], marketplaces: [], loadErrors: [], featured: [] }
      })
  }

  /** Searches the runtime's app/connector directory — thousands of entries, so paged. */
  async searchApps(query: string, cursor?: string | null): Promise<{ apps: readonly RuntimePlugin[]; nextCursor?: string | null }> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return { apps: [] }
    return this.transport
      .request('runtime/apps/search', { runtime, query, ...(cursor ? { cursor } : {}) })
      .catch(() => ({ apps: [] as readonly RuntimePlugin[] }))
  }

  /**
   * Adds a plugin from the runtime's catalogue, or takes it off disk.
   *
   * It was called `setRuntimePluginEnabled`, which is a different thing and
   * the more dangerous of the two: `false` uninstalls. There is no
   * enable/disable to be had here — `RuntimePlugin.enabled` is the runtime's
   * own report and none of the agents this app drives offers a verb to
   * change it — so the name that matched the behaviour was the one to keep.
   */
  async setRuntimePluginInstalled(
    marketplace: string,
    pluginName: string,
    id: string,
    installed: boolean,
  ): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    try {
      if (installed) await this.transport.request('runtime/plugin/install', { runtime, marketplace, pluginName })
      else await this.transport.request('runtime/plugin/uninstall', { runtime, pluginId: id })
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  async loadMcpServers(): Promise<readonly McpServer[]> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return []
    return this.transport
      .request('runtime/mcp/list', { runtime, ...(this.#snapshot.workspace?.path ? { cwd: this.#snapshot.workspace.path } : {}) })
      .catch(() => [])
  }

  async mcpLogin(name: string): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    try {
      const { url } = await this.transport.request('runtime/mcp/login', { runtime, name })
      openExternal(url)
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  async reloadMcp(): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    try {
      await this.transport.request('runtime/mcp/reload', { runtime })
      this.notice('info', 'MCP configuration reloaded.')
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  async setRuntimeOption(id: string, value: OptionValue): Promise<void> {
    const runtime = this.#snapshot.activeRuntime
    if (!runtime) return
    try {
      await this.transport.request('runtime/options/set', { runtime, optionId: id, value })
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  async steer(input: readonly UserContent[], key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('turn/steer', { ...address(key), input })
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  async interrupt(key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('turn/interrupt', address(key))
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  // ---------------------------------------------------------------- the queue

  /**
   * Holds a message until the running turn ends. The host decides whether it
   * actually waits: a conversation with nothing running sends at once, which
   * is why this is what the composer calls in both states.
   *
   * Returns false when the message did not get anywhere, so the composer can
   * put the draft back rather than losing what was typed — the whole reason
   * the queue exists.
   */
  async queue(input: readonly UserContent[], key = this.#snapshot.activeSessionKey): Promise<boolean> {
    key ??= await this.newSession(this.#draftCwd())
    if (!key) return false
    try {
      await this.transport.request('turn/queue', { ...address(key), input })
      return true
    } catch (error) {
      this.notice('error', describe(error))
      return false
    }
  }

  async unqueue(id: string, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('turn/queue/cancel', { ...address(key), id })
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  async moveQueued(id: string, to: number, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('turn/queue/move', { ...address(key), id, to })
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  /** Sends the head of the queue now — how a paused queue is restarted. */
  async flushQueue(key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('turn/queue/flush', address(key))
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  async clearQueue(key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('turn/queue/clear', address(key))
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  /**
   * Reads the agent's background tasks for one conversation.
   *
   * Called when a conversation is opened, because the list arrives unasked
   * only when it *changes* — a job that has been running since before this
   * window opened would otherwise be invisible until it ended.
   */
  async refreshTasks(key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    const runtime = this.#snapshot.runtimes.find((entry) => entry.id === address(key).runtime)
    if (runtime && !runtime.capabilities.backgroundTasks) return
    try {
      const tasks = await this.transport.request('tasks/list', address(key))
      const next = new Map(this.#snapshot.tasks)
      if (tasks.length === 0) next.delete(key)
      else next.set(key, orderTasks(tasks))
      this.#patch({ tasks: next })
    } catch {
      // A runtime that cannot answer has nothing to show; leaving the last
      // known list alone beats blanking a panel because one read failed.
    }
  }

  /** Ends one background task. The row redraws from the event that answers. */
  async stopTask(taskId: string, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      const { stopped } = await this.transport.request('tasks/stop', { ...address(key), taskId })
      // A task the agent no longer knows about is one that ended on its own
      // between the list being drawn and the button being pressed. Say so,
      // and re-read rather than leaving a row that cannot be stopped again.
      if (!stopped) {
        this.notice('info', 'That task had already finished.')
        void this.refreshTasks(key)
      }
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  /** Drops the finished rows. Running work is untouched. */
  async clearTasks(key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('tasks/clear', address(key))
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  async updateSettings(patch: Partial<SessionSettings>, key = this.#snapshot.activeSessionKey): Promise<void> {
    if (!key) return
    try {
      await this.transport.request('session/settings', { ...address(key), patch })
      const session = this.#snapshot.sessions.get(key)
      if (session?.settings) {
        this.#setSession({ ...session, settings: { ...session.settings, ...patch } })
      }
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  async respondToApproval(key: SessionKey, id: ApprovalId, decision: ApprovalDecision): Promise<void> {
    const pending = this.#snapshot.approvals.find(
      (entry) => entry.key === key && entry.approval.id === id,
    )
    if (!pending) return
    // Drop it from the queue optimistically; the host confirms with
    // `approval/resolved`, and leaving a dead dialog up is worse than a flicker.
    this.#patch({ approvals: this.#snapshot.approvals.filter((entry) => entry !== pending) })
    try {
      await this.transport.request('approval/respond', {
        ...address(key),
        approvalId: id,
        decision,
      })
    } catch (error) {
      this.notice('error', describe(error))
      this.#patch({ approvals: [...this.#snapshot.approvals, pending] })
    }
  }

  // --------------------------------------------------------------- workspaces

  async loadPreferences(): Promise<void> {
    try {
      const preferences = await this.transport.request('app/state/get', {})
      // The runtime the user last selected comes back, provided it still
      // exists — a registry edit must not strand the shell on a ghost.
      const savedRuntime = preferences['activeRuntime']
      const restored = this.#snapshot.runtimes.find((runtime) => runtime.id === savedRuntime)
      if (restored && restored.id !== this.#snapshot.activeRuntime) {
        this.#patch({ activeRuntime: restored.id })
      }
      const layouts = preferences['layouts']
      this.#layouts =
        typeof layouts === 'object' && layouts !== null && !Array.isArray(layouts)
          ? (layouts as Record<string, Workbench>)
          : {}
      if (this.#snapshot.workspace) this.#restoreLayout(this.#snapshot.workspace.path)
      const drafts = preferences['draftValues']
      if (typeof drafts === 'object' && drafts !== null && !Array.isArray(drafts)) {
        this.#draftsByRuntime = drafts as Record<string, Readonly<Record<string, OptionValue>>>
        const mine = this.#snapshot.activeRuntime
          ? this.#draftsByRuntime[this.#snapshot.activeRuntime]
          : undefined
        if (mine && Object.keys(mine).length > 0) {
          this.#patch({ draftValues: mine })
          void this.loadDraftOptions()
        }
      }
      const rawHidden = preferences['hiddenModels']
      if (typeof rawHidden === 'object' && rawHidden !== null && !Array.isArray(rawHidden)) {
        const hiddenModels: Record<string, readonly string[]> = {}
        for (const [runtime, ids] of Object.entries(rawHidden as Record<string, unknown>)) {
          if (Array.isArray(ids)) hiddenModels[runtime] = ids.filter((id): id is string => typeof id === 'string')
        }
        this.#patch({ hiddenModels })
      }
      const rawAccounts = preferences['accountPrefs']
      const accountPrefs: AccountPrefsMap =
        rawAccounts && typeof rawAccounts === 'object' && !Array.isArray(rawAccounts)
          ? (rawAccounts as AccountPrefsMap)
          : {}
      const rawList = preferences['listPrefs'] as Partial<AppSnapshot['listPrefs']> | undefined
      const listPrefs: AppSnapshot['listPrefs'] = {
        // Compact unless the user has said otherwise: one line per
        // conversation is what both Codex and Claude Code open with.
        density: rawList?.densityPicked && rawList.density === 'comfortable' ? 'comfortable' : 'compact',
        ...(rawList?.densityPicked ? { densityPicked: true } : {}),
        // A filter naming a runtime that no longer exists would show an
        // empty list that looks like data loss; drop it instead.
        agent:
          rawList?.agent && this.#snapshot.runtimes.some((entry) => entry.id === rawList.agent)
            ? rawList.agent
            : null,
        sort: rawList?.sort === 'name' ? 'name' : 'recency',
        pinned: Array.isArray(rawList?.pinned)
          ? rawList.pinned.filter((entry): entry is string => typeof entry === 'string')
          : [],
        pinnedSessions: Array.isArray(rawList?.pinnedSessions)
          ? rawList.pinnedSessions.filter((entry): entry is string => typeof entry === 'string')
          : [],
        gitColumns: readColumnWidths(rawList?.gitColumns),
        collapsed: Array.isArray(rawList?.collapsed)
          ? rawList.collapsed.filter((entry): entry is string => typeof entry === 'string')
          : [],
        panelsCollapsed: Array.isArray(rawList?.panelsCollapsed)
          ? rawList.panelsCollapsed.filter((entry): entry is string => typeof entry === 'string')
          : [],
        othersOpen: rawList?.othersOpen === true,
      }
      const rawPlanEdits = preferences['planEdits']
      const planEdits: Record<string, readonly PlanEdit[]> = {}
      if (rawPlanEdits && typeof rawPlanEdits === 'object' && !Array.isArray(rawPlanEdits)) {
        for (const [key, value] of Object.entries(rawPlanEdits as Record<string, unknown>)) {
          if (!Array.isArray(value)) continue
          const edits = value.filter(
            (entry): entry is PlanEdit =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as PlanEdit).from === 'string' &&
              typeof (entry as PlanEdit).to === 'string',
          )
          if (edits.length > 0) planEdits[key] = edits
        }
      }
      const rawOff = preferences['usageOff']
      const usageOff = Array.isArray(rawOff)
        ? rawOff.filter((entry): entry is RuntimeId => typeof entry === 'string')
        : []
      const noticePolicy = readNoticePolicy(preferences['noticePolicy'])
      const editorPrefs = readEditorPrefs(preferences['editorPrefs'])
      const rawBrowser = preferences['browserPrefs'] as Partial<AppSnapshot['browserPrefs']> | undefined
      const browserPrefs: AppSnapshot['browserPrefs'] = {
        persistSession: rawBrowser?.persistSession !== false,
        linksInPane: rawBrowser?.linksInPane !== false,
        placement:
          rawBrowser?.placement === 'window' || rawBrowser?.placement === 'system'
            ? rawBrowser.placement
            : 'pane',
        externalBinary: typeof rawBrowser?.externalBinary === 'string' ? rawBrowser.externalBinary : '',
        keepExternalProfile: rawBrowser?.keepExternalProfile !== false,
      }
      this.#patch({
        accountPrefs,
        profile: readProfile(preferences['profile']),
        customPresets: readCustomPresets(preferences['customPresets']),
        planEdits,
        listPrefs,
        editorPrefs,
        browserPrefs,
        usageOff,
        noticePolicy,
        systemNotifications: readSystemNotifications(preferences['systemNotifications']),
        preferencesLoaded: true,
        ...(preferences['theme'] === 'light' ||
        preferences['theme'] === 'dark' ||
        preferences['theme'] === 'system'
          ? { theme: preferences['theme'] }
          : {}),
        ...(preferences['palette'] === 'harnessdesk' ||
        preferences['palette'] === 'editorial' ||
        preferences['palette'] === 'shadcn'
          ? { palette: preferences['palette'] }
          : {}),
        ...(preferences['accent'] === 'default' ||
        preferences['accent'] === 'violet' ||
        preferences['accent'] === 'green' ||
        preferences['accent'] === 'rose' ||
        preferences['accent'] === 'orange' ||
        preferences['accent'] === 'mono'
          ? { accent: preferences['accent'] }
          : {}),
        ...(preferences['corners'] === 'default' ||
        preferences['corners'] === 'square' ||
        preferences['corners'] === 'round'
          ? { corners: preferences['corners'] }
          : {}),
        ...(preferences['look'] === 'desk' || preferences['look'] === 'studio'
          ? { look: preferences['look'] }
          : {}),
      })
    } catch {
      // Preferences are a convenience; their absence must not block startup —
      // including for the banners that wait on them, which would otherwise be
      // held off the screen for the life of a host that cannot answer.
      this.#patch({ preferencesLoaded: true })
    }
  }

  async saveCustomPresets(presets: readonly AgentPreset[]): Promise<void> {
    this.#patch({ customPresets: presets })
    try {
      await this.transport.request('app/state/set', { patch: { customPresets: presets } })
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  async loadWorkspaces(): Promise<void> {
    try {
      const workspaces = await this.transport.request('workspace/recent', {})
      const current = this.#snapshot.workspace
      // The list carries fresh git facts for the folder at its head; the
      // open workspace takes them, or a branch switch would never show.
      const workspace = (current && workspaces.find((entry) => entry.path === current.path)) ?? current ?? workspaces[0] ?? null
      const changed = workspace?.path !== this.#snapshot.workspace?.path
      this.#patch({ workspaces, workspace })
      // Preferences and workspaces load in parallel at startup; whichever
      // lands second restores the layout, so neither can miss the other.
      if (changed && this.#layouts) this.#restoreLayout(workspace?.path ?? null)
      void this.loadWorktrees()
    } catch (error) {
      this.notice('warning', describe(error))
    }
  }

  // -------------------------------------------------------------- branches

  async listBranches(root: string): Promise<readonly { name: string; current: boolean; committedAt: number }[]> {
    try {
      return await this.transport.request('git/branches', { root })
    } catch (error) {
      this.notice('error', describe(error))
      return []
    }
  }

  /**
   * Checks a branch out in a folder. The host refuses on a dirty tree and
   * says so; nothing is stashed on the user's behalf.
   */
  async checkoutBranch(root: string, branch: string, options: { readonly create?: boolean } = {}): Promise<boolean> {
    try {
      await this.transport.request('git/checkout', { root, branch, ...(options.create ? { create: true } : {}) })
      this.notice('info', options.create ? `Created and switched to ${branch}.` : `Switched to ${branch}.`)
      await this.loadWorkspaces()
      return true
    } catch (error) {
      this.notice('error', describe(error))
      return false
    }
  }

  /**
   * Switches workspace. The panes belong to a workspace, so the previous
   * layout is put away and this one's comes back.
   */
  async openWorkspace(path: string): Promise<void> {
    try {
      const workspace = await this.transport.request('workspace/open', { path })
      this.#patch({ workspace })
      if (this.#layouts) this.#restoreLayout(workspace.path)
      await this.loadWorkspaces()
      void this.loadDraftOptions()
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /**
   * Asks the app shell to open the folder browser.
   *
   * The store cannot mount a dialog, so this is an event the App listens for —
   * which keeps commands able to trigger UI without the store importing React.
   */
  /**
   * Renders another session as context.
   *
   * Reads the transcript rather than the summary line, because "what did we
   * decide over there" needs the decision, not the title. Trimmed hard: this is
   * background for a new question, not a replay.
   */
  async summariseSession(id: string, runtime: RuntimeId): Promise<string | null> {
    // Required for the same reason `openSession`'s is: summarising the wrong
    // agent's session of the same id would put another conversation's
    // decisions into this one's prompt, and nothing on screen would say so.
    try {
      const session = await this.transport.request('session/read', {
        runtime,
        sessionId: id as SessionId,
      })
      const lines: string[] = []
      for (const turn of session.turns) {
        for (const item of turn.items) {
          if (item.type === 'userMessage') {
            const text = item.content
              .filter((part) => part.type === 'text')
              .map((part) => (part.type === 'text' ? part.text : ''))
              .join(' ')
            if (text.trim()) lines.push(`Asked: ${text.trim().slice(0, 400)}`)
          }
          if (item.type === 'assistantMessage' && item.phase !== 'commentary') {
            if (item.text.trim()) lines.push(`Answered: ${item.text.trim().slice(0, 800)}`)
          }
        }
      }
      if (lines.length === 0) return null
      const label = session.title?.trim() || session.preview?.trim() || 'another session'
      return wrapContext(`Session: ${label}`, lines.slice(-8).join('\n\n'))
    } catch (error) {
      this.notice('warning', describe(error))
      return null
    }
  }

  requestFolderPicker(): void {
    window.dispatchEvent(new CustomEvent('harnessdesk:browse-folders'))
  }

  /**
   * The native folder dialog. Resolves true when a folder was opened, false
   * when the user cancelled; rejects when this build has no native dialog,
   * which is the caller's cue to fall back to the in-app picker.
   */
  async pickWorkspace(): Promise<boolean> {
    const workspace = await this.transport.request('workspace/pick', {})
    if (!workspace) return false
    this.#patch({ workspace })
    if (this.#layouts) this.#restoreLayout(workspace.path)
    await this.loadWorkspaces()
    return true
  }

  // ---------------------------------------------------------------- view-only

  /** Clicking the open tab closes the panel; clicking another switches to it. */
  /**
   * The control every "show me the changes" button presses.
   *
   * It still reads as a tab because that is what it looks like, but what it
   * does now is dock a view: the inspector goes to whichever area it is already
   * in, or to the right panel if it is nowhere. Pressing the one already on
   * screen puts its panel away, which is the toggle every one of these call
   * sites has always meant.
   */
  setDetailsTab(tab: AppSnapshot['detailsTab']): void {
    const showing = tab === null ? this.#snapshot.detailsTab : tab
    if (tab === null || this.#snapshot.detailsTab === tab) {
      // Put away the area that is actually holding it. Collapsing `right`
      // unconditionally meant that with Changes dragged to the bottom, its
      // own toggle folded away an unrelated panel and left Changes on screen.
      const where = showing ? findViewIn(this.#snapshot.workbench, { kind: showing }) : null
      const area = where && where.area !== 'main' ? where.area : 'right'
      this.#setWorkbench(collapseDockIn(this.#snapshot.workbench, area, true))
      return
    }
    this.openDetailsTab(tab)
  }

  /** Opens a tab without the toggle behaviour, for callers that mean "show me". */
  openDetailsTab(tab: Exclude<AppSnapshot['detailsTab'], null>): void {
    this.showViewIn('right', { kind: tab })
  }

  toggleSidebar(): void {
    this.#patch({ sidebarCollapsed: !this.#snapshot.sidebarCollapsed })
  }

  setTheme(theme: AppSnapshot['theme']): void {
    this.#patch({ theme })
    void this.transport.request('app/state/set', { patch: { theme } }).catch(() => {})
  }

  setPalette(palette: AppSnapshot['palette']): void {
    this.#patch({ palette })
    void this.transport.request('app/state/set', { patch: { palette } }).catch(() => {})
  }

  setAccent(accent: AppSnapshot['accent']): void {
    this.#patch({ accent })
    void this.transport.request('app/state/set', { patch: { accent } }).catch(() => {})
  }

  setCorners(corners: AppSnapshot['corners']): void {
    this.#patch({ corners })
    void this.transport.request('app/state/set', { patch: { corners } }).catch(() => {})
  }

  setLook(next: AppSnapshot['look']): void {
    this.#patch({ look: next })
    void this.transport.request('app/state/set', { patch: { look: next } }).catch(() => {})
  }

  /**
   * Your name and face. `null` puts a field back to its default, so a patch
   * naming both as `null` is the page's "Reset".
   *
   * Applied locally first and written through, like every preference here.
   * The whole profile is sent rather than the field that changed, because the
   * host merges preferences one level deep: a name sent on its own would
   * become the whole stored profile, and the face would be forgotten.
   */
  setProfile(patch: ProfilePatch): void {
    const profile = applyProfile(this.#snapshot.profile, patch)
    if (sameProfile(profile, this.#snapshot.profile)) return
    this.#patch({ profile })
    void this.transport.request('app/state/set', { patch: { profile } }).catch(() => {})
  }

  /**
   * Names or re-colours one account.
   *
   * Written through to the host so a nickname survives a restart, and applied
   * locally first so the field the user is typing into does not stutter. An
   * empty nickname removes the override rather than storing a blank, which is
   * what makes "clear the name" put the identity back.
   */
  setAccountPrefs(key: string, patch: AccountPrefs): void {
    const merged: AccountPrefs = { ...this.#snapshot.accountPrefs[key], ...patch }
    const cleaned: AccountPrefs = {
      ...(merged.nickname?.trim() ? { nickname: merged.nickname.trim() } : {}),
      ...(merged.tint ? { tint: merged.tint } : {}),
    }
    const accountPrefs: Record<string, AccountPrefs> = { ...this.#snapshot.accountPrefs }
    if (cleaned.nickname === undefined && cleaned.tint === undefined) delete accountPrefs[key]
    else accountPrefs[key] = cleaned
    this.#patch({ accountPrefs })
    void this.transport.request('app/state/set', { patch: { accountPrefs } }).catch(() => {})
  }

  /**
   * How the code editor draws itself. Applied locally first so a font-size
   * change lands on the mounted view in the same frame as the press, then
   * written through so it survives a restart.
   */
  setEditorPrefs(patch: Partial<AppSnapshot['editorPrefs']>): void {
    const editorPrefs = { ...this.#snapshot.editorPrefs, ...patch }
    this.#patch({ editorPrefs })
    void this.transport.request('app/state/set', { patch: { editorPrefs } }).catch(() => {})
  }

  /**
   * Rewords one task of a conversation's plan.
   *
   * `from` is the label the *transcript* carries, never what the panel is
   * currently showing — editing an already-edited task replaces its edit
   * rather than stacking a second one keyed on a label nothing will match.
   *
   * The edit is the desk's, not the agent's: no runtime offers a way to set
   * its plan. What closes that gap is `planEditNote`, which rides into the
   * next message so the agent can adopt the wording — and the edit retires
   * itself the moment it does.
   */
  editPlanTask(
    from: string,
    to: string,
    at = 0,
    key = this.#snapshot.activeSessionKey,
  ): void {
    if (!key) return
    const edits = withPlanEdit(this.#snapshot.planEdits[key] ?? [], from, to.trim(), at)
    const planEdits = { ...this.#snapshot.planEdits }
    if (edits.length > 0) planEdits[key] = edits
    else delete planEdits[key]
    this.#patch({ planEdits })
    void this.transport.request('app/state/set', { patch: { planEdits } }).catch(() => {})
  }

  /** Drops one conversation's reworded tasks, when the conversation goes. */
  forgetPlanEdits(key: SessionKey): void {
    if (!this.#snapshot.planEdits[key]) return
    const planEdits = { ...this.#snapshot.planEdits }
    delete planEdits[key]
    this.#patch({ planEdits })
    void this.transport.request('app/state/set', { patch: { planEdits } }).catch(() => {})
  }

  /**
   * Drops the edits the agent has taken up, once its new plan is in. Called
   * where the plan is read for a message, because that is the moment both
   * halves are known — and leaving an adopted edit in place would let it
   * rewrite some later task that reused the old wording.
   */
  retirePlanEdits(todos: readonly Todo[], key = this.#snapshot.activeSessionKey): void {
    if (!key) return
    const held = this.#snapshot.planEdits[key]
    if (!held || held.length === 0) return
    const live = livePlanEdits(todos, held)
    if (live.length === held.length) return
    const planEdits = { ...this.#snapshot.planEdits }
    if (live.length > 0) planEdits[key] = live
    else delete planEdits[key]
    this.#patch({ planEdits })
    void this.transport.request('app/state/set', { patch: { planEdits } }).catch(() => {})
  }

  setListPrefs(patch: Partial<AppSnapshot['listPrefs']>): void {
    const listPrefs = { ...this.#snapshot.listPrefs, ...patch }
    this.#patch({ listPrefs })
    void this.transport.request('app/state/set', { patch: { listPrefs } }).catch(() => {})
  }

  /**
   * The Chrome-like browsers on this machine, for the setting that picks
   * one. Asked of the host each time the setting is shown rather than
   * cached: somebody installs Brave the week after they chose Chrome.
   */
  async listBrowsers(): Promise<readonly { name: string; path: string }[]> {
    try {
      return await this.transport.request('app/browsers', {})
    } catch {
      return []
    }
  }

  /**
   * Starts or stops keeping track of one agent.
   *
   * The host decides what a report exists for, so the screen is rebuilt from
   * its answer rather than from a local filter — that is what makes the switch
   * mean "stop asking" and not merely "stop showing".
   */
  setUsageTracked(runtime: RuntimeId, on: boolean): void {
    const rest = this.#snapshot.usageOff.filter((id) => id !== runtime)
    const usageOff = on ? rest : [...rest, runtime]
    this.#patch({ usageOff })
    void this.transport
      .request('app/state/set', { patch: { usageOff } })
      .then(() => this.loadUsage())
      .catch(() => {})
  }

  /**
   * Puts one standing message away for as long as its lifetime says.
   *
   * The count it keeps is what earns the message its "stop showing this"
   * offer later, so this is called even for a dismissal that changes nothing
   * else — an offer already answered, say.
   */
  dismissStanding(identity: NoticeIdentity): void {
    this.#setNoticePolicy(afterDismiss(this.#snapshot.noticePolicy, identity, Date.now()))
  }

  /** Silences, or restores, one kind of message. The settings page and the × share this. */
  setNoticeMuted(kind: string, muted: boolean): void {
    this.#setNoticePolicy(withMuted(this.#snapshot.noticePolicy, kind, muted))
  }

  /** One macOS notification switch — `enabled` is the master, the rest are kinds. */
  setSystemNotification(key: string, on: boolean): void {
    const systemNotifications = { ...this.#snapshot.systemNotifications, [key]: on }
    this.#patch({ systemNotifications })
    void this.transport.request('app/state/set', { patch: { systemNotifications } }).catch(() => {})
  }

  #setNoticePolicy(noticePolicy: NoticePolicy): void {
    this.#patch({ noticePolicy })
    void this.transport.request('app/state/set', { patch: { noticePolicy } }).catch(() => {})
  }

  setBrowserPrefs(patch: Partial<AppSnapshot['browserPrefs']>): void {
    const browserPrefs = { ...this.#snapshot.browserPrefs, ...patch }
    this.#patch({ browserPrefs })
    void this.transport.request('app/state/set', { patch: { browserPrefs } }).catch(() => {})
  }

  /**
   * Reports a background load's failure — unless the runtime is already
   * telling the user it is down, in which case the banner and the empty
   * state say it better than a toast full of transport jargon would.
   */
  #backgroundNotice(level: NoticeLevel, message: string): void {
    if (this.#snapshot.health && this.#snapshot.health.state !== 'ready') return
    this.notice(level, message)
  }

  notice(level: NoticeLevel, message: string, action?: NoticeAction): void {
    // The same failure often reaches us twice — once as the turn's error and
    // once as the runtime's error notification. One toast is information;
    // two identical toasts is a bug report about the toasts. A toast that
    // carries an action is exempt: archiving two conversations in a row must
    // leave two ways back, not one that undoes only the second.
    const last = this.#snapshot.notices[this.#snapshot.notices.length - 1]
    if (!action && last && last.level === level && last.message === message && Date.now() - last.at < 5000) {
      return
    }
    const notice: Notice = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      level,
      message,
      at: Date.now(),
      ...(action ? { action } : {}),
    }
    this.#patch({ notices: [...this.#snapshot.notices.slice(-4), notice] })
  }

  dismissNotice(id: string): void {
    this.#patch({ notices: this.#snapshot.notices.filter((entry) => entry.id !== id) })
  }

  // ----------------------------------------------------------------- plugins

  async loadPlugins(): Promise<void> {
    try {
      this.#patch({ plugins: await this.transport.request('plugin/list', {}) })
    } catch {
      // A build with no extension kernel is a valid configuration.
    }
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    try {
      await this.transport.request('plugin/setEnabled', { pluginId, enabled })
      await this.loadPlugins()
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /**
   * The developer loop: edit the plugin where it lives, press Update, get the
   * new code — a fresh install from the recorded source path, cache-busted.
   */
  async updatePluginFromSource(plugin: PluginInstance): Promise<void> {
    const source = plugin.identity.source
    if (source.kind !== 'local' || !source.path) return
    try {
      await this.transport.request('plugin/install', { specifier: source.path })
      await this.loadPlugins()
      this.notice('info', `${plugin.identity.name} updated from ${source.path}.`)
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    try {
      await this.transport.request('plugin/uninstall', { pluginId })
      await this.loadPlugins()
      this.notice('info', 'Plugin uninstalled.')
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  async configurePlugin(
    pluginId: string,
    config: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.transport.request('plugin/configure', { pluginId, config })
      await this.loadPlugins()
    } catch (error) {
      this.notice('error', describe(error))
    }
  }

  /**
   * Runs a plugin command. Returns false only when nothing claimed the name;
   * a command that ran and failed reports its own error here and reads as
   * handled, so the caller does not add a second, wronger message.
   */
  async runCommand(name: string, argument: string): Promise<boolean> {
    try {
      const key = this.#snapshot.activeSessionKey
      const result = await this.transport.request('command/run', {
        name,
        argument,
        ...(key ? address(key) : {}),
      })
      return result.handled
    } catch (error) {
      this.notice('error', describe(error))
      return true
    }
  }

  // ------------------------------------------------------------------ private

  #onExtensionEvent(event: ExtensionEvent): void {
    switch (event.type) {
      case 'plugin/added':
      case 'plugin/updated': {
        const others = this.#snapshot.plugins.filter(
          (entry) => entry.instanceId !== event.plugin.instanceId,
        )
        this.#patch({ plugins: [...others, event.plugin] })
        return
      }
      case 'plugin/removed':
        this.#patch({
          plugins: this.#snapshot.plugins.filter(
            (entry) => entry.instanceId !== event.instanceId,
          ),
          contributions: this.#snapshot.contributions.filter(
            (entry) => entry.owner !== event.instanceId,
          ),
        })
        return
      case 'contributions/changed': {
        // The kernel announces a whole revision at once, so the owner's previous
        // set is replaced rather than merged — a reloading plugin is never
        // half-rendered.
        const others = this.#snapshot.contributions.filter(
          (entry) => entry.owner !== event.owner,
        )
        this.#patch({ contributions: [...others, ...event.contributions] })
        return
      }
      case 'extension/log':
        if (event.level === 'error') this.notice('error', event.message)
        return
    }
  }

  #onEvent(runtime: RuntimeId, event: AgentEvent): void {
    if (event.type === 'approval/requested') {
      const key = sessionKey(runtime, event.approval.sessionId)
      if (this.#snapshot.approvals.some((entry) => entry.key === key && entry.approval.id === event.approval.id)) return
      this.#patch({ approvals: [...this.#snapshot.approvals, { key, approval: event.approval }] })
      // The approval dialog lives inside the conversation pane. If that pane
      // is hidden behind an expanded tool, an agent is now waiting on a
      // person who cannot see the question — the zoom ends, the reading does
      // not (the tool pane stays where it was).
      const layout = this.#snapshot.layout
      const shown = conversationPane(layout)
      if (layout.expanded !== null && shown && sessionOf(shown) === key) {
        this.#setLayout(collapseIn(layout))
      }
      return
    }
    if (event.type === 'approval/resolved') {
      const key = sessionKey(runtime, event.sessionId)
      this.#patch({
        approvals: this.#snapshot.approvals.filter(
          (entry) => !(entry.key === key && entry.approval.id === event.approvalId),
        ),
      })
      return
    }
    if (event.type === 'limits/updated') {
      this.#patch({ limits: event.limits })
      return
    }
    if (event.type === 'runtime/options') {
      if (event.runtime === this.#snapshot.activeRuntime) this.#patch({ runtimeOptions: event.options })
      return
    }
    if (event.type === 'account/loginCompleted') {
      const current = this.#snapshot.logins[event.runtime] ?? null
      const login = applyLoginCompleted(current, event)
      if (login !== current) this.#setLogin(event.runtime, login)
      // Signing in changes what the runtime can do — models, limits, history —
      // not just who it says you are, so the whole runtime view is re-read.
      if (event.success) {
        void this.loadAccounts()
        void this.refreshRuntime()
      }
      return
    }
    if (event.type === 'account/changed') {
      void this.loadAccounts()
      void this.refreshRuntime()
      return
    }
    if (event.type === 'catalog/changed') {
      // Live sessions re-declare through `session/options`; the draft is ours
      // to re-ask for, keeping whatever the user had picked where it still fits.
      // The settings catalogue is re-read too: an agent that declares its
      // models and commands only once a session exists fills those pages
      // after they were first opened, and they must not stay empty.
      if (event.runtime === this.#snapshot.activeRuntime) {
        void this.loadDraftOptions()
        void this.loadCatalogue()
      }
      return
    }
    if (event.type === 'notice') {
      this.notice(event.level, event.message)
      return
    }
    if (event.type === 'error') {
      if (event.sessionId) this.notice('error', event.error.message)
      else this.#patch({ fatal: event.error })
      // Credit and auth failures change what the whole app can do, so refresh
      // the runtime view rather than only showing a toast.
      if (event.error.code === 'credits' || event.error.code === 'auth') {
        void this.refreshRuntime()
      }
      return
    }
    if (event.type === 'session/started') {
      this.#setSession(event.session)
      return
    }
    if (event.type === 'session/tasks') {
      const key = sessionKey(runtime, event.sessionId)
      const tasks = new Map(this.#snapshot.tasks)
      if (event.tasks.length === 0) tasks.delete(key)
      else tasks.set(key, orderTasks(event.tasks))
      this.#patch({ tasks })
      return
    }
    if (event.type === 'session/queue') {
      const key = sessionKey(runtime, event.sessionId)
      const queues = new Map(this.#snapshot.queues)
      // An empty queue is no entry rather than an empty one, so every reader
      // can ask `queues.get(key)` and get nothing when there is nothing.
      if (event.queue.messages.length === 0) queues.delete(key)
      else queues.set(key, event.queue)
      this.#patch({ queues })
      return
    }

    const target = 'sessionId' in event ? event.sessionId : undefined
    if (!target) return
    const existing = this.#snapshot.sessions.get(sessionKey(runtime, target))
    if (!existing) return
    const next = reduceSession(existing, event)
    if (next !== existing) this.#setSession(next)
    // The sidebar reads the backend's list, which learns about a conversation
    // only once it has something to say about it: a brand-new session has no
    // ask to show until its first turn starts, and a title arrives later
    // still. Those are the moments to read the list again, not a timer —
    // `turn/started` among them, because that is when a row that was created
    // empty gains both its opening line and its place in the "Working" band.
    if (
      event.type === 'session/title' ||
      event.type === 'turn/started' ||
      event.type === 'turn/completed'
    ) {
      this.#scheduleHistoryRefresh()
    }
  }

  #historyRefresh: ReturnType<typeof setTimeout> | null = null
  /** The sidebar's live filter, so a re-read keeps showing what was searched. */
  #historyQuery = ''
  /** The agent the list is paged around; see `loadHistory`. */
  #historyAnchor: RuntimeId | null = null

  /**
   * One re-read per burst of events, a beat after the last of them.
   *
   * A read already in flight cannot be joined — `loadHistory` refuses a
   * second one — and dropping this one would lose the very change that asked
   * for it, so it waits its turn instead. That is how a name that arrives
   * while the list is being read still reaches the sidebar.
   */
  #scheduleHistoryRefresh(): void {
    if (this.#historyRefresh) clearTimeout(this.#historyRefresh)
    this.#historyRefresh = setTimeout(() => {
      if (this.#snapshot.historyLoading) {
        this.#scheduleHistoryRefresh()
        return
      }
      this.#historyRefresh = null
      void (this.#historyQuery ? this.searchHistory(this.#historyQuery) : this.loadHistory({ reset: true }))
    }, 600)
  }

  #setSession(session: Session): void {
    const sessions = new Map(this.#snapshot.sessions)
    const key = sessionKey(session.runtime, session.id)
    const existing = sessions.get(key)
    // A read is folded into what is on screen, never swapped for it: a resume
    // carries metadata but no transcript, and a read taken while a turn is
    // running knows less about that turn than this window does — it watched it
    // stream. Reopening a working conversation goes through here.
    sessions.set(key, existing ? mergeRead(existing, session) : session)
    this.#patch({ sessions })
  }

  /**
   * Applies a change and derives the focused conversation from the layout.
   * The snapshot is replaced at once — `getSnapshot` is always current — but
   * subscribers are woken once per frame, which is what keeps three streaming
   * conversations from re-rendering the window hundreds of times a second.
   */
  #patch(patch: Partial<AppSnapshot>): void {
    const next = { ...this.#snapshot, ...patch }
    // The focused conversation: the focused pane's, or — when a tool pane has
    // focus — the conversation it belongs to, so the composer's commands and
    // the details column stay on the work the tool was opened for.
    // A docked conversation wins while it holds the focus: clicking into a
    // transcript on the right edge has to move the sidebar's highlight, the
    // window title and what ⌘K acts on, or the panel is a transcript you can
    // read and nothing else.
    const docked = next.workbench.focus ? viewAt(next.workbench, next.workbench.focus) : null
    const pane = focusedPane(next.layout)
    const activeSessionKey =
      (docked?.kind === 'conversation' ? docked.session : null) ??
      sessionOf(pane) ??
      (pane.view.kind === 'terminal' ? (pane.view.session ?? null) : null) ??
      panes(next.layout.root).map(sessionOf).find((key) => key !== null) ??
      null
    /* Navigation history: every change of what the *middle* shows is a step
       ← and → can retrace — a conversation or a room, because those are the
       two things it can be and losing either one is losing your place. */
    const previousMain = this.#mainView()
    const nextMain =
      next.layout === this.#snapshot.layout ? previousMain : focusedPaneViewOf(next.layout)
    if (previousMain && nextMain && !sameView(previousMain, nextMain) && !this.#navigating) {
      this.#visitedBack.push(previousMain)
      if (this.#visitedBack.length > 50) this.#visitedBack.shift()
      this.#visitedForward = []
    }
    next.navCanBack = this.#visitedBack.length > 0
    next.navCanForward = this.#visitedForward.length > 0
    next.activeSessionKey = activeSessionKey
    // A hand-off belongs to the draft it was handed to; once a conversation
    // is in front — the draft sent, or another one opened — it has served.
    if (activeSessionKey && next.draftHandoff && !patch.draftHandoff) next.draftHandoff = null
    next.activeSessionId =
      activeSessionKey && splitSessionKey(activeSessionKey).runtime === next.activeRuntime
        ? splitSessionKey(activeSessionKey).id
        : null
    if (patch.sessions && this.#snapshot.layout === next.layout) {
      // A conversation that vanished from the host leaves its pane empty
      // rather than pointing at nothing.
      next.layout = prune(next.layout, (key) => next.sessions.has(key) || this.#snapshot.loadingSessions.has(key))
    }
    this.#snapshot = next
    this.#wake()
  }

  #wake = coalesce(() => {
    for (const listener of this.#listeners) listener()
  })
}

/** What a terminal pane is told about its process. */
export type TerminalNotification = Extract<
  WireNotification,
  { method: 'terminal/output' } | { method: 'terminal/exited' }
>

/**
 * The picks that actually landed: the ones the runtime's fresh list agrees
 * with. Anything else was refused or has no control on the model now chosen,
 * and keeping it stored only re-sends it on the next question.
 *
 * A runtime that declared nothing is not a runtime that refused everything.
 * Several only describe their controls once a session exists, and answer this
 * question with an empty list; the picks still travel with `session/create`
 * and are honoured there. Silence is read as silence.
 */
const kept = (
  asked: Readonly<Record<string, OptionValue>>,
  options: readonly ConfigOption[],
): Readonly<Record<string, OptionValue>> => {
  if (options.length === 0) return asked
  const landed: Record<string, OptionValue> = {}
  for (const [id, value] of Object.entries(asked)) {
    if (findOption(options, id)?.currentValue === value) landed[id] = value
  }
  return landed
}

/** The `(runtime, sessionId)` pair a session-scoped wire method takes. */
const address = (key: SessionKey): { runtime: RuntimeId; sessionId: SessionId } => {
  const { runtime, id } = splitSessionKey(key)
  return { runtime, sessionId: id }
}

/** What the middle of a layout is showing, when it is one of the two things. */
const focusedPaneViewOf = (layout: Layout): PaneView | null => {
  const view = focusedPane(layout).view
  if (view.kind === 'room') return view
  return view.kind === 'conversation' && view.session ? view : null
}

/**
 * A conversation that could not be opened because something else has it.
 *
 * The host names this failure on the wire precisely so the interface does not
 * have to recognise a sentence; see `rejectionFor`.
 */
const isHeldElsewhere = (error: unknown): boolean =>
  error instanceof Error && (error as { code?: unknown }).code === 'sessionBusy'

const describe = (error: unknown): string => {
  const said = error instanceof Error ? error.message : String(error)
  // The wire validator speaks in field paths — "message.params.decision.type:
  // expected string, got undefined" — which is a developer's sentence about a
  // HarnessDesk bug, not something the person can act on. They get told it
  // plainly; the field path goes to the console for whoever can fix it.
  if (/^message\.(params|result|error)\b/.test(said)) {
    console.error(`HarnessDesk internal error: ${said}`)
    return 'HarnessDesk hit an internal error; details are in the log.'
  }
  // Codex refusing its own stored thread — a rollout saved by a newer build
  // ("unknown variant …"). The person needs the consequence, not the parser's
  // complaint; the raw sentence goes to the console for whoever debugs it.
  if (/failed to deserialize stored thread/i.test(said)) {
    console.error(`Codex could not load a stored thread: ${said}`)
    return 'Codex could not load this conversation — it was saved by a newer Codex version. What could be recovered is shown read-only; start a new session to continue the work.'
  }
  return said
}
