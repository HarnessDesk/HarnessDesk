import type {
  CapabilityContribution,
  EditorEdit,
  EditorEvent,
  ExtensionEvent,
  HookInvocation,
  HookVerdict,
  PluginInstance,
  PluginSource,
  ScopeQuery,
  ToolResult,
  UiDecoration,
  ForgeReference,
} from '@harnessdesk/protocol'

/**
 * The contract between HarnessDesk and its plugin host process.
 *
 * Third-party plugin code never runs in the process that holds the window,
 * the wire server, or a credential. It runs in a child process that speaks
 * exactly this protocol over NDJSON on stdio — one JSON object per line,
 * JSON-RPC shaped. This file is the whole surface: if a capability is not
 * expressible here, the plugin host does not have it.
 *
 * Versioned so a host and a child from different builds refuse each other
 * loudly at `host/hello` instead of misbehaving quietly later.
 *
 * Design notes, for review:
 * - The child pushes a full `snapshot` after every change instead of the
 *   parent querying, because `CapabilityRegistry.list()` is synchronous in
 *   the host: the parent answers from its cache, and a stale one-frame view
 *   of *contributions* is harmless where a blocking IPC read would not be.
 * - `tool/invoke` carries a deadline in the parent, not here: a child whose
 *   event loop is wedged cannot honour a timeout, so enforcement has to live
 *   on the healthy side of the boundary.
 * - There is deliberately no message for reading credentials, opening
 *   windows, or reaching the wire server. Absence is the security boundary.
 */

// 3 adds the editor plane's `editor/*` child requests. A new child against an
// old host would get "Unknown request" from calls it has every reason to
// expect to work, which is exactly the quiet misbehaviour this number exists
// to turn into a refusal at `host/hello`.
// 4 adds the team plane's `team/*` child requests — the shared board and
// inter-agent messages.
// 5 adds the forge plane's `forge/*` child requests — the calling
// conversation's seat, the desk's forge identity, and the record of a
// publication.
export const EXTENSION_PROTOCOL_VERSION = 5

/** What `plugin/inspect` reports, for the consent dialog; nothing is imported. */
export interface InspectedPlugin {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly source: PluginSource
  readonly permissions: readonly string[]
  readonly alreadyInstalled: boolean
}

/** Resource accounting the child reports about itself. */
export interface PluginHostStats {
  readonly pid: number
  readonly rssBytes: number
  readonly activeHandles: number
  /** Tool invocations served per plugin instance since the child started. */
  readonly invocations: Readonly<Record<string, number>>
}

/**
 * Requests the parent may send. Adding a method means adding one entry here;
 * both ends are generic over this map, so drift is a compile error.
 */
/**
 * The browser settings, as they cross the process boundary. Kept structural
 * rather than imported from `cordis-host` so the protocol package stays a
 * description of the wire and depends on nothing.
 */
export interface BrowserSettingsWire {
  readonly placement: 'pane' | 'window' | 'system'
  readonly binary?: string | undefined
  readonly keepProfile?: boolean
  /** Where a kept profile lives — inside the host's state directory. */
  readonly profileDir?: string | undefined
}

export interface PluginHostMethods {
  /** First message, both directions. A version mismatch is a refusal, not a warning. */
  'host/hello': {
    params: {
      readonly protocolVersion: number
      /**
       * True when the parent has a browser page of its own to drive — the
       * desktop shell's pane. The child's `ctx.browser` then forwards to it
       * through `ChildToHostRequest`s instead of starting Chrome.
       */
      readonly inlineBrowser?: boolean
      /** Where pages open, as the user has set it. See `browser/settings`. */
      readonly browser?: BrowserSettingsWire
    }
    result: { readonly protocolVersion: number; readonly pid: number }
  }
  /**
   * The user changed where pages should open. Sent on every change, and
   * again with `host/hello` after a restart — a fresh child that had not
   * been told would quietly open pages somewhere the user did not choose.
   */
  'browser/settings': { params: { readonly settings: BrowserSettingsWire }; result: null }
  /** Loads every plugin in the on-disk store. Failures are per-plugin, reported as events. */
  'plugins/loadInstalled': { params: Record<string, never>; result: null }
  'plugin/inspect': { params: { readonly specifier: string }; result: InspectedPlugin }
  'plugin/install': { params: { readonly specifier: string }; result: { readonly id: string } }
  'plugin/uninstall': { params: { readonly pluginId: string }; result: null }
  'plugin/setEnabled': {
    params: { readonly pluginId: string; readonly enabled: boolean }
    result: null
  }
  'plugin/reconfigure': {
    params: { readonly pluginId: string; readonly config: Readonly<Record<string, unknown>> }
    result: null
  }
  'command/run': {
    params: { readonly name: string; readonly argument: string; readonly scope: ScopeQuery }
    result: { readonly handled: boolean }
  }
  'tool/invoke': {
    params: { readonly id: string; readonly args: unknown; readonly scope: ScopeQuery }
    result: ToolResult
  }
  'hooks/run': { params: { readonly invocation: HookInvocation }; result: HookVerdict }
  'context/resolve': {
    params: { readonly query: ScopeQuery }
    result: readonly { readonly label: string; readonly text: string }[]
  }
  /** One provider, because the user attached its chip. */
  'context/resolveOne': {
    params: { readonly id: string; readonly ref?: string; readonly scope: ScopeQuery }
    result: { readonly label: string; readonly text: string } | null
  }
  'workspace/set': {
    params: { readonly root: string | null; readonly branch: string | null }
    result: null
  }
  'host/stats': { params: Record<string, never>; result: PluginHostStats }
}

export type PluginHostMethodName = keyof PluginHostMethods

/**
 * Notifications the child pushes. `snapshot` is the complete truth about
 * plugins and contributions and replaces the previous one wholesale.
 */
export type PluginHostNotification =
  | {
      readonly kind: 'snapshot'
      readonly plugins: readonly PluginInstance[]
      readonly contributions: readonly CapabilityContribution[]
    }
  | { readonly kind: 'event'; readonly event: ExtensionEvent }

// -------------------------------------------------------------------- wire

export interface HostToChildRequest {
  readonly id: number
  readonly method: PluginHostMethodName
  readonly params: unknown
}

/** One DevTools event, carried whole so the child derives its own views. */
export interface CdpEventWire {
  readonly method: string
  readonly params: Record<string, unknown>
}

/**
 * What the child may ask the parent for: the parent's browser page, when it
 * has one, spoken to in DevTools Protocol — so a browser tool running in the
 * isolated host drives the pane in the window rather than a Chrome of its own.
 *
 * `browser/events` is a **pull**, and deliberately so. CDP pushes console and
 * network events, and the obvious design is a reverse notification lane. That
 * would mean a second direction on the wire, a buffer at each end, and a
 * child that pays for events no plugin ever reads. Draining on demand keeps
 * one direction and one buffer, and a turn that never asks costs nothing.
 */
export interface ChildToHostMethods {
  'browser/ensure': { params: Record<string, never>; result: null }
  'browser/send': {
    params: { readonly method: string; readonly params?: Record<string, unknown> }
    result: unknown
  }
  /** Everything the page has said since the last drain; the reading empties it. */
  'browser/events': { params: Record<string, never>; result: readonly CdpEventWire[] }
  'browser/close': { params: Record<string, never>; result: null }

  /**
   * The editor plane — the same four shapes as the browser above, for the
   * same reason: the thing being driven is in another process.
   *
   * The asymmetry worth knowing is that these do not reach a window. The
   * host owns the plane and pushes it to whatever windows exist, so `open`
   * on a headless host is not an error and not a no-op: it records a
   * document that a window opening later will render. A plugin therefore
   * never has to ask whether anybody is looking, which is the question it
   * has no way to answer.
   *
   * `pluginId` rides on `open` and `decorate` so the interface can attribute
   * a mark to whoever made it. The child fills it in from the calling
   * plugin's own context — it is not a plugin's to choose.
   */
  'editor/open': { params: { readonly path: string; readonly pluginId: string }; result: null }
  /** Writes. Refused unless the plugin also holds `workspace.write`. */
  'editor/applyEdits': {
    params: { readonly path: string; readonly edits: readonly EditorEdit[]; readonly pluginId: string }
    result: { readonly hash: string }
  }
  'editor/decorate': {
    params: {
      readonly path: string
      readonly decorations: readonly UiDecoration[]
      readonly pluginId: string
    }
    result: null
  }
  'editor/close': { params: { readonly path: string }; result: null }
  /**
   * Everything the person has done since *this plugin* last drained — per
   * caller, unlike `browser/events`, so two plugins watching the editor do
   * not starve each other. The reasoning is on `EditorEngine.drain`.
   */
  'editor/events': { params: { readonly pluginId: string }; result: readonly EditorEvent[] }

  /**
   * The team plane — the shared board and inter-agent messages, host-owned
   * for the reason the editor plane is: claiming has to be a transaction in
   * the one process that owns every session, and message routing has to
   * apply one set of guards whichever vendor's agent is calling.
   *
   * `scope` is which conversation is calling, carried from the tool
   * invocation — Codex's dynamic-tool path and the MCP bridge's correlation
   * token both fill it in. The host refuses an unscoped write rather than
   * guessing: an unattributed claim is worse than none.
   *
   * Results are prose for the calling model, composed host-side so the
   * board reads identically to every agent. Expected outcomes — a claim
   * someone else got first, a conflict — come back as sentences; only
   * transport and programming errors throw.
   */
  'forge/seat': { params: { readonly scope: TeamCallScope }; result: ForgeSeatInfo | null }
  'forge/identity': { params: { readonly scope: TeamCallScope }; result: ForgeIdentityInfo }
  'forge/publish': {
    params: { readonly scope: TeamCallScope; readonly reference: ForgeReference }
    result: null
  }
  'team/board': { params: { readonly scope: TeamCallScope }; result: string }
  'team/addIntent': {
    params: {
      readonly scope: TeamCallScope
      readonly title: string
      readonly detail?: string
      readonly files?: readonly string[]
      readonly dependsOn?: readonly number[]
    }
    result: string
  }
  'team/claim': {
    params: {
      readonly scope: TeamCallScope
      readonly intent: number
      /** The paths this claim will touch, added to whatever the intent owned. */
      readonly files?: readonly string[]
    }
    result: string
  }
  /** The next open, unblocked, unconflicted card, whichever it is, taken atomically. */
  'team/claimNext': {
    params: {
      readonly scope: TeamCallScope
      readonly files?: readonly string[]
    }
    result: string
  }
  'team/conflicts': {
    params: { readonly scope: TeamCallScope; readonly paths: readonly string[] }
    result: string
  }
  'team/complete': {
    params: {
      readonly scope: TeamCallScope
      readonly intent: number
      readonly note?: string
      readonly handoff?: string
    }
    result: string
  }
  'team/release': {
    params: {
      readonly scope: TeamCallScope
      readonly intent: number
      readonly reason?: string
      readonly blocked?: boolean
    }
    result: string
  }
  'team/handoff': { params: { readonly scope: TeamCallScope; readonly intent: number }; result: string }
  'team/status': { params: { readonly scope: TeamCallScope }; result: string }
  'team/send': {
    params: {
      readonly scope: TeamCallScope
      readonly to: string
      readonly text: string
      readonly wake?: boolean
    }
    result: string
  }
}

/**
 * Which conversation a team call is on behalf of. Both halves optional
 * because a tool can be invoked unscoped — the host is the one that decides
 * what an unscoped call may still do (today: nothing).
 */
export interface TeamCallScope {
  readonly runtime?: string
  readonly sessionId?: string
}

/** The forge plane's answers, as they cross the child boundary. */
export interface ForgeSeatInfo {
  readonly agent: string
  readonly version: string | null
  readonly model: string | null
  readonly effort: string | null
  readonly thinking: boolean
  readonly label: string
}

export interface ForgeIdentityInfo {
  readonly via: 'gh' | 'app'
  readonly login: string | null
  readonly available: boolean
  readonly reason: string | null
}

export type ChildToHostMethodName = keyof ChildToHostMethods

export interface ChildToHostRequest {
  /** Its own id space; never confused with a reply to a parent request. */
  readonly request: number
  readonly method: ChildToHostMethodName
  readonly params: unknown
}

export type HostToChildResponse =
  | { readonly response: number; readonly result: unknown }
  | { readonly response: number; readonly error: { readonly message: string } }

export type ChildToHostMessage =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: { readonly message: string } }
  | { readonly notification: PluginHostNotification }
  | ChildToHostRequest

/** True when a parsed line is structurally a message from the child. */
export const isChildMessage = (value: unknown): value is ChildToHostMessage => {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  if (typeof message['id'] === 'number') {
    return 'result' in message || typeof message['error'] === 'object'
  }
  if (typeof message['request'] === 'number') return typeof message['method'] === 'string'
  return typeof message['notification'] === 'object' && message['notification'] !== null
}

/** True when a parsed line is the parent answering a child's request. */
export const isHostResponse = (value: unknown): value is HostToChildResponse => {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return typeof message['response'] === 'number' && ('result' in message || typeof message['error'] === 'object')
}

/** True when a parsed line is structurally a request from the parent. */
export const isHostRequest = (value: unknown): value is HostToChildRequest => {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return typeof message['id'] === 'number' && typeof message['method'] === 'string'
}
