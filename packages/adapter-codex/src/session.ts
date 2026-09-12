import type { CodexAppServer, CodexProtocol } from '@harnessdesk/codex'
import {
  findOption,
  refuseOptionValue,
  sessionId as makeSessionId,
  turnId as makeTurnId,
  type AgentEvent,
  type AgentSession,
  type ApprovalDecision,
  type ApprovalId,
  type ConfigOption,
  type OptionValue,
  type RuntimeId,
  type SessionId,
  type CapabilityRegistry,
  type SessionSettings,
  type SessionSummary,
  type SessionUsage,
  type TurnId,
  type UserContent,
  openingOf,
} from '@harnessdesk/protocol'

import { automaticContext, contextPreamble, type ToolProjection } from './capabilities.js'
import type { ApprovalRouter } from './approvals.js'
import {
  sessionOptions,
  settingsFromState,
  settingsUpdateFor,
  stateFromThreadSettings,
  type Catalog,
  type ThreadState,
} from './mapping/options.js'
import { CODEX_RUNTIME_ID, mapSummary, mapUsage, nameFromMessage, stripContext } from './mapping/session.js'

/**
 * One live Codex thread.
 *
 * The thread's settings are held in Codex's own vocabulary (`ThreadState`) and
 * projected into options on demand. Changes go through
 * `thread/settings/update`, and Codex answers every one with a
 * `thread/settings/updated` notification carrying the whole settings record —
 * that notification, not the request, is what the state is replaced from, so
 * the interface always shows what Codex believes rather than what was asked.
 */

export interface CodexSessionDeps {
  /** Which Codex account owns this thread — the runtime it was started on. */
  readonly runtime?: RuntimeId
  readonly server: CodexAppServer
  readonly approvals: ApprovalRouter
  readonly thread: CodexProtocol.v2.Thread
  readonly state: ThreadState
  readonly catalog: Catalog
  /** Maps Codex's tool callbacks back to the contributions that produced them. */
  readonly projection: ToolProjection
  readonly capabilities?: CapabilityRegistry
  readonly onClosed: (id: string) => void
  readonly emit: (event: AgentEvent) => void
  /**
   * True when this thread was opened here rather than resumed from Codex's
   * own store. Only a thread HarnessDesk started is a thread HarnessDesk may
   * name; anything Codex made is Codex's to name, and it does.
   */
  readonly created?: boolean
}

export class CodexSession implements AgentSession {
  readonly id: SessionId
  readonly runtime: RuntimeId
  #state: ThreadState
  #catalog: Catalog
  /** Overrides to attach to the next turn, then clear. */
  #pendingOverrides: Record<string, unknown> = {}
  /**
   * File-change diffs seen on items, so a later approval request for the same
   * item can show what it is approving — Codex does not repeat the diff.
   */
  readonly #fileChanges = new Map<string, readonly CodexProtocol.v2.FileUpdateChange[]>()
  /** Command items by id, for the stdin approvals that only name the item. */
  readonly #commands = new Map<string, string>()
  /**
   * Codex requires the active turn id on `turn/steer` (as a precondition) and on
   * `turn/interrupt`, so the session has to know which turn is live.
   */
  #currentTurnId: string | null = null
  /** Tool count Codex was told about at thread/start, for staleness detection. */
  readonly #projectedTools: number
  /**
   * Whether this thread is still a candidate for the name below. False once
   * it has been named, or from the start for a thread that arrived with a
   * name or was not opened here.
   */
  #nameable: boolean
  /** What this thread is called, as of the last thing either side said. */
  #name: string | null
  /**
   * The message this thread opened with, kept because Codex has not written
   * one to its store yet: a thread is absent from `thread/list` until its
   * first turn is stored, so the only account of a working conversation is
   * this one. Envelope stripped — the list shows the ask, not the plumbing.
   */
  #opening: string | null = null
  /** When the thread last did something here, so a working row sorts first. */
  #touchedAt: number
  /**
   * The last token figures Codex reported for this thread.
   *
   * Codex sends these as a passing notification and `thread/read` answers with
   * no token fields at all, so unless the session keeps them, re-opening a
   * conversation puts the context ring out until the next turn. Held here for
   * the same reason, and in the same place, `AcpSession` holds its own.
   */
  #usage: SessionUsage | null = null

  constructor(private readonly deps: CodexSessionDeps) {
    this.runtime = deps.runtime ?? CODEX_RUNTIME_ID
    this.id = makeSessionId(deps.thread.id)
    this.#state = deps.state
    this.#catalog = deps.catalog
    this.#nameable = Boolean(deps.created) && (deps.thread.name ?? null) === null
    this.#name = deps.thread.name ?? null
    this.#touchedAt = Date.now()
    this.#projectedTools = deps.projection.size
  }

  /**
   * This thread as a row for the session list, from what is known here.
   *
   * Codex's own listing only knows a thread once a turn of it has been
   * stored, which leaves a conversation that is *working* — the one moment
   * someone is most likely to look for it — missing from the sidebar
   * entirely. The runtime merges this over the stored page so the row exists
   * from the first turn, under the name the conversation is already shown by.
   */
  summary(): SessionSummary {
    // One predicate for the row. It is read here rather than kept, because a
    // plugin can be enabled or disabled while this session is open — but the
    // preview `mapSummary` computes is overridden on the very next line, so
    // building a second predicate only to throw the first one's answer away
    // was work for nothing (#274).
    const skip = automaticContext(this.deps.capabilities)
    return {
      ...mapSummary(this.deps.thread, this.runtime, skip),
      title: this.#name === null ? null : stripContext(this.#name) || null,
      preview: openingOf(this.deps.thread.preview ?? '', { skip }).slice(0, 120) || this.#opening,
      cwd: this.#state.cwd,
      status: this.#currentTurnId === null ? { type: 'idle' } : { type: 'active' },
      updatedAt: this.#touchedAt,
    }
  }

  /** Called by the runtime on `thread/name/updated` — Codex's word on the name. */
  noteName(name: string | null): void {
    this.#name = name
  }

  /** Called by the runtime on `thread/tokenUsage/updated` — Codex's word on the tokens. */
  noteUsage(usage: CodexProtocol.v2.ThreadTokenUsage): void {
    this.#usage = mapUsage(usage)
  }

  /**
   * The last usage Codex reported, for a read that would otherwise carry none.
   * Null until the first turn of this session reports any: an unopened thread
   * has nothing to say, and saying nothing is what the ring is absent for.
   */
  get usage(): SessionUsage | null {
    return this.#usage
  }

  settings(): SessionSettings {
    return settingsFromState(this.#state)
  }

  /** The profile this thread runs under, so a terminal opened for it matches. */
  permissionProfile(): string {
    return this.#state.permissions
  }

  options(): readonly ConfigOption[] {
    return sessionOptions(this.#state, this.#catalog)
  }

  /**
   * Applies a change through `thread/settings/update`. The value is checked
   * against the declared choices first: Codex accepts an unknown model id
   * without complaint and only fails later, at the first turn.
   */
  async setOption(id: string, value: OptionValue): Promise<void> {
    const option = findOption(this.options(), id)
    if (!option) throw new Error(`This session has no option named ${JSON.stringify(id)}.`)
    const refusal = refuseOptionValue(option, value)
    if (refusal) throw new Error(refusal)
    const update = settingsUpdateFor(id, value, this.#state, this.#catalog)
    await this.deps.server.request('thread/settings/update', { threadId: this.id, ...update })
    // Codex also sends `thread/settings/updated`, which replaces this
    // wholesale; applying the known effect now means the interface does not
    // show the old value during the gap.
    this.#replaceState(applyUpdate(this.#state, update))
  }

  /** Called by the runtime on `thread/settings/updated` — Codex's word on the matter. */
  noteSettings(settings: CodexProtocol.v2.ThreadSettings): void {
    this.#replaceState(stateFromThreadSettings(settings, this.#state))
  }

  /** Called by the runtime when the catalogue was refetched, e.g. after sign-in. */
  noteCatalog(catalog: Catalog): void {
    this.#catalog = catalog
    this.deps.emit({ type: 'session/options', sessionId: this.id, options: this.options() })
  }

  #replaceState(next: ThreadState): void {
    const previous = this.#state
    this.#state = next
    if (settingsChanged(previous, next)) {
      this.deps.emit({ type: 'session/settings', sessionId: this.id, settings: this.settings() })
    }
    this.deps.emit({ type: 'session/options', sessionId: this.id, options: this.options() })
  }

  get projection(): ToolProjection {
    return this.deps.projection
  }

  /**
   * Whether the plugin set has changed since this thread was created.
   *
   * Codex accepts `dynamicTools` only on `thread/start`, so a plugin loaded
   * mid-session is genuinely unavailable to this thread. Saying so is better
   * than silently offering tools the model cannot call.
   */
  toolsAreStale(): boolean {
    const registry = this.deps.capabilities
    if (!registry) return false
    const current = registry.list('tool', {
      sessionId: this.id,
      runtime: this.runtime,
      workspaceRoot: this.#state.cwd,
    }).length
    return current !== this.#projectedTools
  }

  /** Called by the runtime when a `fileChange` item is seen for this thread. */
  recordFileChanges(
    itemId: string,
    changes: readonly CodexProtocol.v2.FileUpdateChange[],
  ): void {
    this.#fileChanges.set(itemId, changes)
  }

  pendingFileChanges(itemId: string): readonly CodexProtocol.v2.FileUpdateChange[] | undefined {
    return this.#fileChanges.get(itemId)
  }

  /**
   * Called by the runtime when a `commandExecution` item is seen for this
   * thread. A later stdin approval names only the item, so the command it
   * started has to be remembered here for the dialog to say where the input
   * is going.
   */
  recordCommand(itemId: string, command: string): void {
    this.#commands.set(itemId, command)
  }

  commandOf(itemId: string): string | undefined {
    return this.#commands.get(itemId)
  }

  /** Called by the runtime as turns open and close on this thread. */
  noteTurnStarted(turnId: string): void {
    this.#currentTurnId = turnId
  }

  noteTurnEnded(turnId: string): void {
    if (this.#currentTurnId === turnId) this.#currentTurnId = null
  }

  get activeTurnId(): TurnId | null {
    return this.#currentTurnId ? makeTurnId(this.#currentTurnId) : null
  }

  async send(input: readonly UserContent[]): Promise<TurnId> {
    const overrides = this.#pendingOverrides
    this.#pendingOverrides = {}
    const enriched = await this.#withContext(input)
    const response = await this.deps.server.request('turn/start', {
      threadId: this.id,
      input: enriched.map(toCodexInput),
      ...overrides,
    })
    this.#currentTurnId = response.turn.id
    // What the person sent, not what the adapter put in front of it: a hand-off to Codex was called "Git" (review of #231).
    this.#noteOpening(input)
    void this.#nameFromOpeningMessage(enriched)
    return makeTurnId(response.turn.id)
  }

  /**
   * Remembers how the conversation opened, for the row above. Only the first
   * ask: what a list shows is where a conversation started, and a follow-up
   * that renamed the row every turn would be a moving target.
   */
  #noteOpening(input: readonly UserContent[]): void {
    this.#touchedAt = Date.now()
    // Only where the first message sent here really is the first message:
    // on a resumed thread it is a follow-up, and Codex's stored preview is
    // the opening.
    if (!this.deps.created || this.#opening !== null) return
    const text = openingOf(input.map((part) => (part.type === 'text' ? part.text : '')).join('\n').trim())
    this.#opening = text.slice(0, 120) || null
  }

  /**
   * Names a thread Codex will not name itself — but only when the message
   * that opened it was not the person's words alone.
   *
   * Codex shows a thread's `name`, and falls back to the first message when
   * there is none. That fallback reads fine until HarnessDesk prepends its
   * own `<context source=…>` block for a chip or a hand-off packet: Codex's
   * window then shows the envelope, while this one shows the ask, and one
   * conversation has two names. So where HarnessDesk caused the problem,
   * HarnessDesk cleans up after itself, through Codex's own naming call.
   *
   * Never otherwise: a plain first message already reads the same in both
   * windows, and leaving those unnamed keeps whatever Codex Desktop would
   * name them if the thread is opened there. Once only, and never over a
   * name — a rename in either window is the last word.
   */
  async #nameFromOpeningMessage(input: readonly UserContent[]): Promise<void> {
    if (!this.#nameable) return
    this.#nameable = false
    const text = input
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
      .trim()
    // No envelope, no problem to fix.
    if (stripContext(text) === text) return
    const name = nameFromMessage(text)
    if (!name) return
    try {
      await this.setTitle(name)
    } catch {
      // A name is a courtesy. A thread that would not take one still runs,
      // and shows the message it opened with — the state it was already in.
    }
  }

  async steer(input: readonly UserContent[]): Promise<void> {
    const turnId = this.#requireActiveTurn('steer')
    await this.deps.server.request('turn/steer', {
      threadId: this.id,
      input: input.map(toCodexInput),
      // Codex treats this as a precondition and rejects the call if the turn
      // moved on, which is the behaviour we want: steering the wrong turn is
      // worse than failing.
      expectedTurnId: turnId,
    })
  }

  async interrupt(): Promise<void> {
    const turnId = this.#requireActiveTurn('interrupt')
    await this.deps.server.request('turn/interrupt', { threadId: this.id, turnId })
  }

  /**
   * Prepends plugin-contributed context to the turn.
   *
   * Context is not a tool on purpose: the agent should not have to decide to
   * call something in order to learn the conventions of the repository it is
   * already working in.
   */
  async #withContext(input: readonly UserContent[]): Promise<readonly UserContent[]> {
    const registry = this.deps.capabilities
    if (!registry) return input
    try {
      const entries = await registry.resolveContext({
        sessionId: this.id,
        runtime: this.runtime,
        workspaceRoot: this.#state.cwd,
      })
      const preamble = contextPreamble(entries)
      if (!preamble) return input
      return [{ type: 'text', text: preamble }, ...input]
    } catch {
      // Context is an enhancement; failing to resolve it must not block a turn.
      return input
    }
  }

  #requireActiveTurn(action: string): string {
    if (!this.#currentTurnId) {
      throw new Error(`Cannot ${action}: no turn is currently running in this session.`)
    }
    return this.#currentTurnId
  }

  async respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void> {
    this.deps.approvals.respond(id, decision)
  }

  /**
   * The settings that are not options. `cwd` goes through
   * `thread/settings/update` like everything else; workspace roots are only
   * accepted on `turn/start`, so they ride along with the next turn.
   */
  async updateSettings(patch: Partial<SessionSettings>): Promise<void> {
    if (patch.model !== undefined) await this.setOption('model', patch.model)
    if (patch.cwd !== undefined) {
      await this.deps.server.request('thread/settings/update', { threadId: this.id, cwd: patch.cwd })
      this.#replaceState({ ...this.#state, cwd: patch.cwd })
    }
    if (patch.workspaceRoots !== undefined) {
      this.#pendingOverrides['runtimeWorkspaceRoots'] = [...patch.workspaceRoots]
      this.#replaceState({ ...this.#state, workspaceRoots: [...patch.workspaceRoots] })
    }
  }

  /**
   * Drops the last `turns` turns. Codex changes the thread; the files it
   * wrote stay on disk, which the interface warns about before calling.
   */
  async rollback(turns: number): Promise<void> {
    await this.deps.server.request('thread/rollback', { threadId: this.id, numTurns: turns })
  }

  async compact(): Promise<void> {
    await this.deps.server.request('thread/compact/start', { threadId: this.id })
  }

  async setMemoryMode(enabled: boolean): Promise<void> {
    await this.deps.server.request('thread/memoryMode/set', {
      threadId: this.id,
      mode: enabled ? 'enabled' : 'disabled',
    })
    // Codex sends no notification for this, so the change is announced here;
    // the fold keeps `session.memory` current for the menu's checkmark.
    this.deps.emit({ type: 'session/memory', sessionId: this.id, enabled })
  }

  async review(target: import('@harnessdesk/protocol').ReviewRequest): Promise<void> {
    await this.deps.server.request('review/start', {
      threadId: this.id,
      target: toCodexReviewTarget(target),
      ...(target.delivery ? { delivery: target.delivery } : {}),
    })
  }

  /** Sets or clears the session's standing objective. */
  async setGoal(objective: string | null): Promise<void> {
    if (objective === null) {
      await this.deps.server.request('thread/goal/clear', { threadId: this.id })
      return
    }
    await this.deps.server.request('thread/goal/set', { threadId: this.id, objective })
  }

  async setTitle(title: string): Promise<void> {
    await this.deps.server.request('thread/name/set', { threadId: this.id, name: title })
    this.#name = title
  }

  async close(): Promise<void> {
    this.deps.onClosed(this.id)
    try {
      await this.deps.server.request('thread/unsubscribe', { threadId: this.id })
    } catch {
      // Unsubscribing is best-effort — the thread is already detached on our
      // side, and a dead app-server has nothing to unsubscribe from.
    }
  }
}

const settingsChanged = (a: ThreadState, b: ThreadState): boolean =>
  a.cwd !== b.cwd ||
  a.model !== b.model ||
  a.modelProvider !== b.modelProvider ||
  a.workspaceRoots.join('\0') !== b.workspaceRoots.join('\0')

/** The state a successful `thread/settings/update` with these fields leaves behind. */
const applyUpdate = (
  state: ThreadState,
  update: Omit<CodexProtocol.v2.ThreadSettingsUpdateParams, 'threadId'>,
): ThreadState => ({
  ...state,
  ...(update.model != null ? { model: update.model } : {}),
  ...(update.effort !== undefined ? { effort: update.effort } : {}),
  ...(update.approvalPolicy != null ? { approvalPolicy: update.approvalPolicy } : {}),
  ...(update.approvalsReviewer != null ? { approvalsReviewer: update.approvalsReviewer } : {}),
  ...(update.permissions != null ? { permissions: update.permissions } : {}),
  ...(update.serviceTier !== undefined ? { serviceTier: update.serviceTier } : {}),
  ...(update.collaborationMode
    ? {
        mode: update.collaborationMode.mode,
        effort: update.collaborationMode.settings.reasoning_effort,
      }
    : {}),
})

const toCodexInput = (content: UserContent): CodexProtocol.v2.UserInput => {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text, text_elements: [] }
    case 'image':
      return { type: 'image', url: content.url }
    case 'localImage':
      return { type: 'localImage', path: content.path }
    case 'skill':
      return { type: 'skill', name: content.name, path: content.path }
    case 'mention':
      return { type: 'mention', name: content.name, path: content.path }
  }
}

const toCodexReviewTarget = (
  target: import('@harnessdesk/protocol').ReviewRequest,
): CodexProtocol.v2.ReviewTarget => {
  switch (target.type) {
    case 'uncommitted':
      return { type: 'uncommittedChanges' }
    case 'baseBranch':
      return { type: 'baseBranch', branch: target.branch }
    case 'commit':
      return { type: 'commit', sha: target.sha, title: null }
    case 'custom':
      return { type: 'custom', instructions: target.instructions }
  }
}
