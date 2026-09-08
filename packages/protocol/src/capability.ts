import type { RuntimeId, SessionId, TurnId } from './ids.js'

/**
 * The extension vocabulary.
 *
 * This is to the extension plane what `AgentEvent` is to the agent plane: the
 * neutral shape that lets an extension kernel and an agent runtime cooperate
 * without either learning about the other. A Cordis plugin produces
 * contributions; an adapter projects them into whatever its runtime understands.
 *
 * Everything here is **serialisable**. Executors live beside contributions in
 * the host registry, keyed by id, so the same descriptor can be shown in the UI,
 * sent over the wire, and handed to an adapter without carrying a closure.
 */

declare const brand: unique symbol
type Branded<T, B extends string> = T & { readonly [brand]: B }

/** One loaded plugin. Distinct from its identity: the same plugin can load twice. */
export type PluginInstanceId = Branded<string, 'PluginInstanceId'>
export type ContributionId = Branded<string, 'ContributionId'>

export const pluginInstanceId = (value: string): PluginInstanceId =>
  value as PluginInstanceId
export const contributionId = (value: string): ContributionId => value as ContributionId

// ------------------------------------------------------------------- scoping

/**
 * Where a contribution applies.
 *
 * Narrower than global on purpose: a plugin should be able to expose a tool only
 * inside one repository, only to one agent, or only for the turn that is running
 * — without the host having to special-case any of those.
 */
export type CapabilityScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'workspace'; readonly root: string }
  | { readonly kind: 'agent'; readonly runtime: RuntimeId }
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'turn'; readonly sessionId: SessionId; readonly turnId: TurnId }

export const GLOBAL_SCOPE: CapabilityScope = { kind: 'global' }

/** Context a scope is tested against when deciding what is currently in force. */
export interface ScopeQuery {
  readonly workspaceRoot?: string
  readonly runtime?: RuntimeId
  readonly sessionId?: SessionId
  readonly turnId?: TurnId
}

export const scopeApplies = (scope: CapabilityScope, query: ScopeQuery): boolean => {
  switch (scope.kind) {
    case 'global':
      return true
    case 'workspace':
      return query.workspaceRoot === scope.root
    case 'agent':
      return query.runtime === scope.runtime
    case 'session':
      return query.sessionId === scope.sessionId
    case 'turn':
      return query.sessionId === scope.sessionId && query.turnId === scope.turnId
  }
}

// -------------------------------------------------------------- contributions

export interface ContributionBase {
  readonly id: ContributionId
  /** The plugin instance that registered this, and whose disposal withdraws it. */
  readonly owner: PluginInstanceId
  /**
   * Bumped whenever the owner's contribution set is rebuilt. Adapters swap a
   * whole revision at once, so a reloading plugin is never half-exposed.
   */
  readonly revision: number
  readonly scope: CapabilityScope
}

/** JSON Schema, kept opaque: runtimes validate it, HarnessDesk only forwards it. */
export type JsonSchema = Readonly<Record<string, unknown>>

export interface ToolContribution extends ContributionBase {
  readonly kind: 'tool'
  /** Namespaced so two plugins can both offer `search` without colliding. */
  readonly namespace: string
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  /** Ask the user before every call, regardless of the plugin's granted permissions. */
  readonly requiresApproval?: boolean
}

/** Points in the agent's loop a plugin can observe or veto. */
export type HookEvent = 'preToolUse' | 'postToolUse' | 'preTurn' | 'postTurn'

export interface HookContribution extends ContributionBase {
  readonly kind: 'hook'
  readonly event: HookEvent
  /** Restricts the hook to matching tool names; absent means every tool. */
  readonly match?: readonly string[]
  /** Lower runs first. Hooks at the same priority run in registration order. */
  readonly priority: number
  /** Hard deadline in ms. A hook that overruns is skipped, never allowed to hang a turn. */
  readonly timeoutMs: number
}

/**
 * Makes a context provider pickable from the composer. A provider with a
 * chip is resolved only when the user attaches it — never folded into every
 * turn — and a pasted text matching `match` becomes the chip outright.
 */
export interface ContextChip {
  readonly description?: string
  /** Set when the provider needs a reference (a URL, a number); shown as the placeholder. */
  readonly prompt?: string
  /** A regular-expression source matched against pasted text. */
  readonly match?: string
}

/**
 * A picture a context chip resolved to — a screenshot, mostly. Text remains
 * the lingua franca: the image travels beside `text`, and only to agents
 * that declare `imageInput`; everyone else gets the text alone.
 */
export interface ContextImage {
  /** A data: URL, self-contained — the same form the composer's own image tiles take. */
  readonly dataUrl: string
  readonly name?: string
}

/** Instructions or reference material folded into a turn. Not a tool call. */
export interface ContextContribution extends ContributionBase {
  readonly kind: 'context'
  readonly label: string
  /** `instructions` prepends to the system prompt; `resource` is referenceable material. */
  readonly form: 'instructions' | 'resource'
  readonly mimeType?: string
  readonly chip?: ContextChip
}

export interface CommandContribution extends ContributionBase {
  readonly kind: 'command'
  /** Without the leading slash. */
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
}

/**
 * The panel areas a contributed view may be docked into.
 *
 * A `UiSlot` is a fixed place inside a screen — a row in the composer, a
 * section in Settings — and a contribution that names one is drawn there and
 * nowhere else. An area is different in kind: it is a *panel*, which the person
 * can move between areas, expand, collapse and close. A contribution declares
 * the areas it supports and the renderer holds it to that list, so a plugin can
 * say "my panel belongs on an edge, never in the editor grid" and be believed.
 *
 * The first entry is where it opens when nothing says otherwise.
 */
export type UiArea = 'sidebar' | 'main' | 'right' | 'bottom'

/**
 * The areas a *contribution* may ask for: every area except `main`.
 *
 * `UiArea` stays the renderer's full vocabulary because the workbench has to
 * name main to lay it out. What narrows is the request: main holds a
 * conversation or a room and nothing else, so a plugin that could ask for it
 * would be asking for the one answer that is always no — and every shape of
 * that no (a refusal, a silent downgrade to the right edge, a menu item that
 * does nothing) is worse for the author than the request being unrepresentable.
 * A rule that cannot be written cannot be broken, and cannot rot into a check
 * somebody forgets to run.
 */
export type UiDock = Exclude<UiArea, 'main'>

/** Named mount points the renderer exposes. Extending this extends the UI surface. */
export type UiSlot =
  | 'sidebar.panel'
  | 'sidebar.header'
  | 'composer.row'
  | 'composer.action'
  | 'conversation.hero'
  | 'conversation.item'
  | 'session.header'
  | 'details.tab'
  | 'settings.section'
  | 'status.bar'

/**
 * Where a person can be sent, and what runs when they get there.
 *
 * Every interactive part of a block is one of these: never a callback, never
 * a handler, because neither survives JSON. A `command` is the name of a
 * command *contribution*, so it runs in the plugin host under the plugin's
 * permissions and not in the window.
 */
export interface UiAction {
  readonly label: string
  readonly command: string
  readonly argument?: string
}

/** One node of a `tree` block. Recursive, so it is named rather than inlined. */
export interface UiTreeNode {
  readonly label: string
  readonly hint?: string
  /** Renders open. Absent means closed; the person's own toggling wins after. */
  readonly expanded?: boolean
  readonly children?: readonly UiTreeNode[]
  /** Clicking the row runs this. A node without one is a label. */
  readonly action?: UiAction
}

/**
 * A range a plugin wants marked in a `code` block, and what to say about it.
 *
 * Lines are 1-based and inclusive, which is how every compiler, linter and
 * stack trace a plugin will be reading from already counts them. Converting
 * at the boundary is one subtraction; converting in every plugin is a bug
 * per plugin.
 */
export interface UiDecoration {
  readonly fromLine: number
  readonly toLine?: number
  readonly severity: 'error' | 'warning' | 'info' | 'hint'
  readonly message?: string
}

/**
 * The component vocabulary plugins compose from.
 *
 * A plugin never hands the renderer code — it hands *data* shaped as blocks,
 * and the renderer's own components draw them. The first four cover what a
 * panel is for: prose, facts, rows, and actions.
 *
 * The five below cover what a panel could not say at all. A plugin that has
 * read a file, computed a table, walked a directory or produced a patch had
 * one way to show it — `markdown`, with a fence — which meant no
 * highlighting, no columns that align, no folding, and no way to point at
 * line 41. Each of these is a shape the renderer already draws somewhere
 * else in the app; the vocabulary is how a plugin reaches it.
 *
 * The rule they are all built to is the old one, unchanged: **data in, and
 * every interaction is a named command**. Nothing here carries a function,
 * and an editable `code` block is not an exception — it reports what was
 * typed by running a command with the text, exactly as a button does.
 */
export type UiBlock =
  | { readonly type: 'markdown'; readonly text: string }
  | {
      readonly type: 'keyValue'
      readonly entries: readonly { readonly label: string; readonly value: string }[]
    }
  | {
      readonly type: 'list'
      readonly items: readonly {
        readonly label: string
        readonly hint?: string
        /** Renders a completion tick, for todo-shaped lists. */
        readonly done?: boolean
      }[]
    }
  | {
      readonly type: 'actions'
      readonly actions: readonly {
        readonly label: string
        /** The name of a command contribution; runs in the plugin host. */
        readonly command: string
        readonly argument?: string
      }[]
    }
  /**
   * Source, highlighted by the same editor the file panes use.
   *
   * `language` names the grammar; without one the extension of `path` picks
   * it, which is what a plugin showing a real file already has to hand.
   * `editable` lets the person type, and `onSave` is how what they typed
   * comes back — Cmd+S runs that command with the whole text as its
   * argument. An `editable` block with no `onSave` is read-only in fact, so
   * the renderer treats it as read-only rather than letting someone type
   * into a void.
   */
  | {
      readonly type: 'code'
      readonly text: string
      readonly language?: string
      readonly path?: string
      readonly editable?: boolean
      readonly onSave?: UiAction
      readonly decorations?: readonly UiDecoration[]
      /** Caps the height; the block scrolls past it. Default 24. */
      readonly maxLines?: number
    }
  /**
   * Long prose with headings — a report, a brief, a summary of a run.
   *
   * Distinct from `markdown`, which is a paragraph: this one is navigable.
   * Sections fold, and a section marked `collapsed` starts folded, so a
   * plugin can put the conclusion first and the evidence underneath.
   */
  | {
      readonly type: 'document'
      readonly title?: string
      readonly sections: readonly {
        readonly heading: string
        /** Markdown. */
        readonly text: string
        readonly collapsed?: boolean
      }[]
    }
  /**
   * Columns that line up.
   *
   * Rows are keyed by column, not positional, so adding a column cannot
   * silently shift every row's meaning by one. A cell a row does not carry
   * renders empty rather than throwing.
   */
  | {
      readonly type: 'table'
      readonly columns: readonly {
        readonly key: string
        readonly label: string
        /** `end` for numbers, so decimal points stack. */
        readonly align?: 'start' | 'end'
      }[]
      readonly rows: readonly Readonly<Record<string, string>>[]
      readonly caption?: string
    }
  /** Nesting: a directory, a dependency graph, a plan with sub-tasks. */
  | { readonly type: 'tree'; readonly nodes: readonly UiTreeNode[] }
  /**
   * A patch, drawn by the same view that draws a turn's diff.
   *
   * `wholeFile` says the payload is a file's content rather than a unified
   * diff, and every line reads as an addition — the shape a plugin has when
   * it has generated a file rather than edited one.
   */
  | {
      readonly type: 'diff'
      readonly patch: string
      readonly path?: string
      readonly wholeFile?: boolean
    }

/** What a `hd.panel` component renders, carried on the contribution as data. */
export interface UiPanelData {
  readonly title?: string
  readonly blocks: readonly UiBlock[]
}

export interface UiContribution extends ContributionBase {
  readonly kind: 'ui'
  readonly slot: UiSlot
  readonly label: string
  readonly icon?: string
  /** Lower sorts earlier within the slot. */
  readonly order: number
  /**
   * Component identifier resolved by the renderer's registry. Built-in features
   * and plugin-provided components resolve through the same table, which is what
   * keeps the extension path first-class rather than bolted on.
   */
  readonly component: string
  /**
   * What the component renders. JSON only: the plugin updates its
   * panel by re-registering the contribution with new data, which travels the
   * same revision-atomic path every other contribution change does. The
   * render tree is never handed over.
   */
  readonly data?: unknown
  /**
   * Where this may be docked, making it a panel rather than a slot occupant.
   *
   * When present the renderer mounts the contribution as a view in the panel
   * system: it gets a tab, the person can move it between the areas listed
   * here, expand it and close it, and its place is remembered per project.
   * `slot` is then only the fallback for a build that does not know about
   * panels. Absent means the old behaviour — drawn inline in `slot`.
   */
  readonly mounts?: readonly UiDock[]
}

export interface AgentContribution extends ContributionBase {
  readonly kind: 'agent'
  readonly runtimeId: string
  readonly displayName: string
}

export interface ResourceContribution extends ContributionBase {
  readonly kind: 'resource'
  readonly uri: string
  readonly label: string
  readonly mimeType?: string
}

export type CapabilityContribution =
  | ToolContribution
  | HookContribution
  | ContextContribution
  | CommandContribution
  | UiContribution
  | AgentContribution
  | ResourceContribution

export type ContributionKind = CapabilityContribution['kind']

// ------------------------------------------------------------------- plugins

/**
 * Plugin lifecycle, mirroring Cordis fiber states so the UI can show what the
 * kernel actually believes rather than an approximation of it.
 */
export type PluginState =
  | { readonly type: 'pending'; readonly waitingFor: readonly string[] }
  | { readonly type: 'loading' }
  | { readonly type: 'active' }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'unloading' }
  | { readonly type: 'disposed' }

export type PluginSource =
  /** Ships with HarnessDesk. */
  | { readonly kind: 'builtin' }
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'npm'; readonly specifier: string }
  /** A DeepSeek Harness plugin running under the compatibility layer. */

export interface PluginIdentity {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly source: PluginSource
}

/**
 * What a plugin is allowed to do. Anything not declared is denied — a plugin
 * cannot widen its own reach at runtime.
 */
export interface PluginPermissions {
  readonly workspace: { readonly read: boolean; readonly write: boolean }
  readonly shell: boolean
  readonly network: { readonly hosts: readonly string[] }
  readonly agents: { readonly invoke: boolean }
  readonly ui: { readonly contribute: boolean }
  /** Open and drive a visible browser on this machine, via `ctx.browser`. */
  readonly browser: boolean
  /** Control the iOS Simulator on this machine, via `ctx.ios`. */
  readonly ios: boolean
  /** Control Android devices and emulators through adb, via `ctx.android`. */
  readonly android: boolean
  /**
   * Show a file, annotate it and edit it, via `ctx.editor`.
   *
   * Separate from `workspace.write` and not a substitute for it: this grants
   * the *surface* — putting a file in front of someone and marking it up.
   * Changing what is on disk still needs `workspace.write` as well, so a
   * plugin cannot reach a file through the editor that it could not have
   * written directly.
   */
  readonly editor: boolean
  /**
   * Work with the other conversations, via `ctx.team`: the shared board,
   * and messages routed to them by the host. The grant covers reaching the
   * surface; every routing guard — attribution, rate limits, inbound policy
   * — is the host's and applies regardless.
   */
  readonly team: boolean
  readonly secrets: readonly string[]
}

export const NO_PERMISSIONS: PluginPermissions = {
  workspace: { read: false, write: false },
  shell: false,
  network: { hosts: [] },
  agents: { invoke: false },
  ui: { contribute: false },
  browser: false,
  ios: false,
  android: false,
  editor: false,
  team: false,
  secrets: [],
}

export interface PluginInstance {
  readonly instanceId: PluginInstanceId
  readonly identity: PluginIdentity
  readonly state: PluginState
  readonly revision: number
  readonly permissions: PluginPermissions
  /** Service names this plugin injects, for rendering the dependency graph. */
  readonly injects: readonly string[]
  /** Service names this plugin provides. */
  readonly provides: readonly string[]
  readonly contributions: readonly CapabilityContribution[]
  readonly enabled: boolean
  /** Schema for the plugin's own configuration, rendered as a settings form. */
  readonly configSchema?: JsonSchema
  readonly config?: Readonly<Record<string, unknown>>
}

// -------------------------------------------------------------------- events

/** Kernel state changes, streamed to the UI the same way agent events are. */
export type ExtensionEvent =
  | { readonly type: 'plugin/added'; readonly plugin: PluginInstance }
  | { readonly type: 'plugin/updated'; readonly plugin: PluginInstance }
  | { readonly type: 'plugin/removed'; readonly instanceId: PluginInstanceId }
  | {
      /**
       * A whole revision of one plugin's contributions, replacing whatever it
       * had before. Emitted as a set rather than per-item so consumers swap
       * atomically.
       */
      readonly type: 'contributions/changed'
      readonly owner: PluginInstanceId
      readonly revision: number
      readonly contributions: readonly CapabilityContribution[]
    }
  | {
      readonly type: 'extension/log'
      readonly owner: PluginInstanceId
      readonly level: 'debug' | 'info' | 'warn' | 'error'
      readonly message: string
    }

// ------------------------------------------------------------------ invoking

export type ToolResult =
  | { readonly ok: true; readonly content: readonly ToolResultPart[] }
  | { readonly ok: false; readonly error: string }

export type ToolResultPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly url: string; readonly mimeType?: string }

/** Verdict from a `preToolUse` hook. */
export type HookVerdict =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string }
  /** Ask the user, even though policy would otherwise have allowed it. */
  | { readonly decision: 'ask'; readonly reason: string }

export interface HookInvocation {
  readonly event: HookEvent
  readonly toolName?: string
  readonly arguments?: unknown
  readonly result?: ToolResult
  readonly scope: ScopeQuery
}

/**
 * The host-side view of everything plugins currently offer.
 *
 * Adapters read from it; the Cordis host writes to it. Nothing in this interface
 * mentions Cordis, so a second extension kernel could back it.
 */
export interface CapabilityRegistry {
  /** Contributions of one kind that apply in the given context. */
  list<K extends ContributionKind>(
    kind: K,
    query?: ScopeQuery,
  ): readonly Extract<CapabilityContribution, { kind: K }>[]

  plugins(): readonly PluginInstance[]

  invokeTool(id: ContributionId, args: unknown, scope: ScopeQuery): Promise<ToolResult>

  /** Runs matching hooks in priority order; the first non-allow verdict wins. */
  runHooks(invocation: HookInvocation): Promise<HookVerdict>

  /** Resolves context contributions into text to fold into a turn. */
  resolveContext(query: ScopeQuery): Promise<readonly { label: string; text: string }[]>

  subscribe(listener: (event: ExtensionEvent) => void): () => void
}
