import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * The Agent Client Protocol, from the client side.
 *
 * ACP is JSON-RPC 2.0 over stdio, one message per line — the same shape as
 * `codex app-server`, which is why this file reads like a distilled
 * `packages/codex`: spawn, frame, correlate, supervise. It is deliberately
 * schema-light. ACP is a young protocol implemented by ~40 agents with
 * varying fidelity; the adapter validates what it reads instead of trusting
 * a vendored schema to describe every implementation.
 *
 * Types cover the subset HarnessDesk drives, against protocol version 1
 * (https://agentclientprotocol.com). Two deliberate refusals:
 * the client capabilities advertise **no** `fs` and **no** `terminal`, so a
 * conforming agent never asks this client to touch the machine — the backend
 * owns execution, always.
 */

// ------------------------------------------------------------------- schema

export interface AcpAuthMethod {
  readonly id: string
  readonly name: string
  readonly description?: string | null
}

export interface AcpAgentCapabilities {
  readonly loadSession?: boolean
  readonly promptCapabilities?: {
    readonly image?: boolean
    readonly audio?: boolean
    readonly embeddedContext?: boolean
  }
  /** Observed live from Claude Code 0.16.2: presence of a key means support. */
  readonly sessionCapabilities?: {
    readonly list?: object
    readonly resume?: object
    readonly fork?: object
  }
}

/** One row of `session/list`, as Claude Code 0.16.2 serves it. */
export interface AcpSessionRow {
  readonly sessionId: string
  readonly cwd: string
  readonly title?: string | null
  /**
   * The opening ask, when the agent keeps one. Not every agent names a
   * conversation — Cursor names only what its own IDE has opened — and a
   * stored row with no name reads as nothing at all without this.
   */
  readonly preview?: string | null
  /** ISO 8601. */
  readonly updatedAt?: string
}

export interface AcpInitializeResult {
  readonly protocolVersion: number
  readonly agentCapabilities?: AcpAgentCapabilities
  readonly authMethods?: readonly AcpAuthMethod[]
  /** The agent's own name and version, when it says (most do). */
  readonly agentInfo?: { readonly name?: string; readonly title?: string; readonly version?: string }
  /** Where an agent declares extensions ACP itself has no field for. */
  readonly _meta?: Readonly<Record<string, unknown>>
}

/**
 * The background-task extension, client side.
 *
 * ACP has nothing to say about work that outlives a turn — no field on a
 * session, no update kind, no method — so an agent that has such work rides
 * the protocol's own extension channel. An agent declares it in
 * `initialize`'s `_meta` under `harnessdesk.backgroundTasks`, pushes the
 * whole list as `_harnessdesk/tasks/changed` whenever it moves, and answers
 * three requests.
 *
 * The names are duplicated in `@harnessdesk/claude-acp`, the agent half,
 * which has no HarnessDesk dependency by design. Change one, change the
 * other. Any ACP agent that implements these four gets the panel; an agent
 * that does not is never asked, and an agent that pushes the notification
 * without declaring the capability is still heard, because a list that
 * arrived is better evidence than a flag that did not.
 */
export const ACP_TASKS_NOTIFICATION = '_harnessdesk/tasks/changed'
export const ACP_TASKS_LIST = '_harnessdesk/tasks/list'
export const ACP_TASKS_STOP = '_harnessdesk/tasks/stop'
export const ACP_TASKS_CLEAR = '_harnessdesk/tasks/clear'
/** The `_meta.harnessdesk` key an agent sets to declare all four. */
export const ACP_TASKS_CAPABILITY = 'backgroundTasks'

/**
 * The session-delete extension, client side.
 *
 * ACP's session surface is `new`, `load`, `resume`, `fork`, `list`, `prompt`
 * and `cancel`. There is no delete, and no archive either — which is why the
 * host keeps the archive itself for these agents. Deleting cannot be faked
 * the same way: the conversation is a file in the agent's own store, and only
 * something that knows that store can remove it.
 *
 * A bridge that knows where its agent writes — `@harnessdesk/claude-acp` for
 * Claude Code's `~/.claude/projects`, `@harnessdesk/cursor-acp` for Cursor's
 * `~/.cursor/chats` — declares this in `initialize`'s `_meta` under
 * `harnessdesk.deleteSession` and answers the one request. An agent that does
 * not declare it is never asked, and the interface offers no Delete for it
 * rather than one that throws after the confirmation has already promised the
 * conversation is gone.
 *
 * The names are duplicated in the bridges, which carry no HarnessDesk
 * dependency by design — the same arrangement as the task extension above.
 * Change one, change the others.
 */
export const ACP_SESSION_DELETE = '_harnessdesk/session/delete'
/** The `_meta.harnessdesk` key an agent sets to declare it. */
export const ACP_SESSION_DELETE_CAPABILITY = 'deleteSession'

/**
 * Declared in `initialize`'s `_meta.harnessdesk` by a bridge that carries a
 * standing instruction — handed on `session/new` under the same key in
 * `_meta.harnessdesk` — into the agent's own instruction layer rather than
 * into the conversation. Duplicated in the bridges for the reason above.
 */
export const ACP_INSTRUCTIONS_CAPABILITY = 'instructions'

/**
 * What a bridge reports having removed, so the app can say so honestly.
 * `removed` is the paths that are now gone; an empty list with no error means
 * the agent had nothing stored for that session, which is not a failure.
 */
export interface AcpSessionDeleted {
  readonly removed?: readonly string[]
  /** Where they went, when they went somewhere recoverable — e.g. `trash`. */
  readonly disposition?: 'trash' | 'removed'
}

/** One task, as an agent reports it over the extension channel. */
export interface AcpBackgroundTask {
  readonly id: string
  readonly label: string
  readonly kind?: string
  readonly state?: string
  readonly command?: string
  readonly cwd?: string
  readonly startedAt?: number
  readonly endedAt?: number
  readonly summary?: string
  readonly outputFile?: string
  /** What it printed, when the agent carries it — whole, or a tail. */
  readonly output?: string
  readonly outputTruncated?: boolean
  /** The agent looked for the output and gave up: it was never there. */
  readonly outputMissing?: boolean
  readonly stoppable?: boolean
}

export interface AcpTasksChanged {
  readonly sessionId: string
  readonly tasks: readonly AcpBackgroundTask[]
}

/**
 * The delegation extension, client side.
 *
 * ACP describes one agent talking to one client. It has nothing to say about
 * an agent that hands part of the work to another agent, so a delegation
 * reaches a client as one more tool call and loses the three things that make
 * it not one: its own model, its own lifetime, its own bill. All three
 * runtimes this desk speaks to moved on that in the same week — Codex 0.151
 * counts nested sub-agent usage toward the root goal's budget, DeepSeek
 * Harness 0.1.2 gives the caller a provider, model, effort and output cap per
 * child, and Claude Code streams a foreground sub-agent's activity live.
 *
 * An agent declares it in `initialize`'s `_meta` under
 * `harnessdesk.delegation`, pushes the whole list as
 * `_harnessdesk/delegation/changed` whenever it moves, and answers one
 * request. The names are duplicated in the bridges, which carry no
 * HarnessDesk dependency by design — the same arrangement as the task
 * extension above. Change one, change the others.
 *
 * An agent that pushes without declaring is still heard, for the same reason
 * as the tasks: a list that arrived is better evidence than a flag that did
 * not.
 */
export const ACP_DELEGATION_NOTIFICATION = '_harnessdesk/delegation/changed'
export const ACP_DELEGATION_LIST = '_harnessdesk/delegation/list'
/** The `_meta.harnessdesk` key an agent sets to declare both. */
export const ACP_DELEGATION_CAPABILITY = 'delegation'

/**
 * One delegation's tokens, as an agent reports them.
 *
 * Both cache halves travel, because one on its own cannot be read as cache
 * health — see `cacheWriteTokens` on the protocol's `TokenUsage`. Every field
 * is optional in the reading, because this is an extension and an agent is
 * allowed to know less than the full shape.
 */
export interface AcpDelegationUsage {
  readonly inputTokens?: number | null
  readonly outputTokens?: number | null
  readonly cachedReadTokens?: number | null
  readonly cachedWriteTokens?: number | null
  readonly totalTokens?: number | null
  /** False when the output count is a floor rather than a total. */
  readonly outputExact?: boolean | null
}

/** One delegation, as an agent reports it over the extension channel. */
export interface AcpDelegation {
  readonly id: string
  readonly label?: string
  /**
   * The child's own conversation, where it has one.
   *
   * Absent for an agent that runs a child inside its own process — Claude
   * Code does, and `id` is then the tool call that spawned it and the only
   * handle either side has. An agent whose children are real sessions names
   * one here, and the row becomes a link into it.
   */
  readonly sessionId?: string
  readonly state?: string
  readonly prompt?: string | null
  readonly requestedModel?: string | null
  readonly models?: readonly string[]
  readonly startedAt?: number
  readonly endedAt?: number
  readonly calls?: number
  readonly usage?: AcpDelegationUsage | null
}

export interface AcpDelegationChanged {
  readonly sessionId: string
  readonly delegations: readonly AcpDelegation[]
  /** Every child's spend summed — a share of the session's total, never an addition. */
  readonly delegated?: AcpDelegationUsage | null
}

export interface AcpSessionMode {
  readonly id: string
  readonly name: string
  readonly description?: string | null
}

export interface AcpSessionModeState {
  readonly currentModeId: string
  readonly availableModes: readonly AcpSessionMode[]
}

/** ACP's own per-session option surface — what `ConfigOption` was shaped on. */
export interface AcpConfigOption {
  readonly id: string
  readonly name: string
  readonly description?: string | null
  /** ACP's placement hint: `mode`, `model`, `thought_level`, `other`, or the agent's own. */
  readonly category?: string | null
  readonly type: 'select' | 'toggle'
  readonly currentValue: string | boolean
  /**
   * Set when the agent would refuse a change to this control right now, with
   * the reason — a model family that has no thinking mode, a setting an
   * enterprise policy pins. HarnessDesk's own extension: a control it cannot
   * change is still worth drawing, greyed and explained, and an agent that
   * never sends this is read exactly as it always was.
   */
  readonly disabled?: string | null
  /**
   * What the agent wants read before this control is changed — a setting that
   * spends money, or widens what it may do. HarnessDesk's own extension.
   */
  readonly confirm?: {
    readonly title: string
    readonly body: string
    readonly action: string
    readonly learnMore?: string | null
  } | null
  readonly options?: readonly {
    readonly value: string
    readonly name: string
    readonly description?: string | null
    /** As above, for one choice rather than the whole control. */
    readonly disabled?: string | null
  }[]
}

/**
 * What a bridge can say about a model beyond ACP's own three fields, in the
 * protocol's extension slot. HarnessDesk's own bridges fill it; a conforming
 * agent that does not is read the way it always was.
 */
export interface AcpModelMeta {
  readonly harnessdesk?: {
    /**
     * The reasoning levels *this* model supports, when they differ per model
     * — Claude Code's Haiku has none while its Opus has five, and the
     * session's `thought_level` option can only ever describe the current
     * one. Ids are the agent's; the label is for display.
     */
    readonly effortLevels?: readonly { readonly id: string; readonly label?: string | null }[]
    /**
     * Whether *this* model thinks before answering, when the agent offers
     * that as a property of the model rather than a level of effort:
     * `optional` when it can be switched, `always` when it cannot be
     * switched off. Omitted when the agent has no such control.
     */
    readonly thinking?: 'optional' | 'always' | null
  } | null
}

export interface AcpModel {
  readonly modelId: string
  readonly name: string
  readonly description?: string | null
  readonly _meta?: AcpModelMeta | null
}

export interface AcpModelState {
  readonly currentModelId: string
  readonly availableModels: readonly AcpModel[]
}

export interface AcpNewSessionResult {
  readonly sessionId: string
  readonly modes?: AcpSessionModeState | null
  /** Observed live from Claude Code 0.16.2: the agent's model picker. */
  readonly models?: AcpModelState | null
  readonly configOptions?: readonly AcpConfigOption[] | null
}

export type AcpContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | {
      readonly type: 'resource_link'
      readonly uri: string
      readonly name: string
    }

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'

export interface AcpToolCallUpdate {
  readonly toolCallId: string
  readonly title?: string
  readonly kind?: string
  readonly status?: 'pending' | 'in_progress' | 'completed' | 'failed'
  readonly content?: readonly { readonly type: string; readonly [key: string]: unknown }[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
}

export type AcpSessionUpdate =
  | { readonly sessionUpdate: 'agent_message_chunk'; readonly content: AcpContentBlock }
  | { readonly sessionUpdate: 'agent_thought_chunk'; readonly content: AcpContentBlock }
  | {
      readonly sessionUpdate: 'user_message_chunk'
      readonly content: AcpContentBlock
      /**
       * ACP's extension slot. An agent that knows this chunk is not speech —
       * a command echo it ran, a background task reporting back — says so
       * under its own key here; `harnessdesk.notice` is the one this client
       * reads.
       */
      readonly _meta?: { readonly [key: string]: unknown } | null
    }
  | ({ readonly sessionUpdate: 'tool_call' } & AcpToolCallUpdate)
  | ({ readonly sessionUpdate: 'tool_call_update' } & AcpToolCallUpdate)
  | {
      readonly sessionUpdate: 'plan'
      readonly entries: readonly {
        readonly content: string
        readonly status: 'pending' | 'in_progress' | 'completed'
        readonly priority?: string
      }[]
    }
  | { readonly sessionUpdate: 'current_mode_update'; readonly currentModeId: string }
  | { readonly sessionUpdate: 'current_model_update'; readonly currentModelId: string }
  | {
      readonly sessionUpdate: 'config_option_update'
      readonly configOptions: readonly AcpConfigOption[]
    }
  | {
      readonly sessionUpdate: 'available_commands_update'
      readonly availableCommands: readonly AcpAvailableCommand[]
    }
  | ({ readonly sessionUpdate: 'usage_update' } & AcpUsageUpdate)

/**
 * One command the agent offers for this session — Claude Code's skills and
 * slash commands arrive here, Cursor's too. Read-only: ACP has no way to
 * turn one off, which is the agent's own configuration to keep.
 */
export interface AcpAvailableCommand {
  readonly name: string
  readonly description?: string | null
  readonly input?: { readonly hint?: string | null } | null
}

/**
 * ACP's unstable token-usage shapes (0.14: "not part of the spec yet, and
 * may be removed or changed at any point"). The adapter treats both as
 * optional: an agent that sends neither simply has no usage to show.
 */
export interface AcpUsage {
  readonly totalTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedReadTokens?: number | null
  readonly cachedWriteTokens?: number | null
  readonly thoughtTokens?: number | null
}

export interface AcpCost {
  readonly amount: number
  readonly currency: string
}

/** Context fill for the session: tokens in context, and the window they sit in. */
export interface AcpUsageUpdate {
  readonly used: number
  readonly size: number
  readonly cost?: AcpCost | null
  /**
   * ACP has no slot for the *composition* of the context, so an agent that
   * knows it puts it here. Optional in the strong sense: an agent that sends
   * nothing renders exactly as before.
   */
  readonly _meta?: AcpUpdateMeta | null
}

/**
 * The `_meta` HarnessDesk's own bridges attach to a `usage_update`.
 *
 * Namespaced under `harnessdesk` per ACP's convention for extension data, and
 * read structurally: a bridge on a different version, or a third-party agent
 * that adopts the same shape, is understood without a change here.
 */
export interface AcpUpdateMeta {
  readonly harnessdesk?: {
    readonly contextBreakdown?: AcpContextBreakdown | null
  } | null
}

/** See `ContextBreakdown` in the protocol: reported by the agent, never derived. */
export interface AcpContextBreakdown {
  readonly segments?: readonly AcpContextSegment[] | null
  readonly approximate?: boolean | null
  readonly source?: string | null
}

export interface AcpContextSegment {
  readonly id?: string | null
  readonly label?: string | null
  readonly tokens?: number | null
  readonly count?: number | null
}

export interface AcpPromptResponse {
  readonly stopReason: AcpStopReason
  /** This turn's tokens, when the agent counts them. */
  readonly usage?: AcpUsage | null
  /**
   * ACP's extension slot. Gemini CLI counts a turn's tokens here, under
   * `quota`, and not in `usage` — see `AcpQuota`.
   */
  readonly _meta?: AcpPromptMeta | null
}

/** The `_meta` a prompt response may carry, read structurally; the rest of it is ignored. */
export interface AcpPromptMeta {
  readonly quota?: AcpQuota | null
}

/**
 * A turn's tokens as Gemini CLI reports them — measured on 0.59.0, which
 * sends no `usage` and no `usage_update`: input and output summed over every
 * model call the turn made, then the same split per model. There is no cache
 * or thinking figure in it, and nothing about the context window.
 */
export interface AcpQuota {
  readonly token_count?: AcpQuotaCount | null
  readonly model_usage?: readonly {
    readonly model?: string | null
    readonly token_count?: AcpQuotaCount | null
  }[] | null
}

export interface AcpQuotaCount {
  readonly input_tokens?: number | null
  readonly output_tokens?: number | null
}

export interface AcpPermissionOption {
  readonly optionId: string
  readonly name: string
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface AcpPermissionRequest {
  readonly sessionId: string
  readonly toolCall: AcpToolCallUpdate
  readonly options: readonly AcpPermissionOption[]
  /**
   * ACP's extension slot. Our Claude bridge puts a question here —
   * `harnessdesk.question`, the `AskUserQuestion` the options answer — so
   * the client can draw a question as a question. Read defensively.
   */
  readonly _meta?: Readonly<Record<string, unknown>>
}

export type AcpPermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

// ---------------------------------------------------------------- transport

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    /**
     * The agent's own `error.data`, as one readable line.
     *
     * JSON-RPC puts the actionable half of a failure here: `-32603 Internal
     * error` names nothing, while its data says the query closed before it
     * answered. Dropping it left every caller — the log, the banner — with a
     * sentence nobody could act on.
     */
    readonly details?: string,
  ) {
    super(message)
    this.name = 'AcpError'
  }
}

/**
 * `error.data`, flattened to a line worth showing.
 *
 * Agents put a string here, or an object with `details` (Claude Code does);
 * anything else is kept as JSON rather than dropped, because a clue that
 * reads badly still beats no clue at all.
 */
const detailOf = (data: unknown): string | undefined => {
  if (data === null || data === undefined) return undefined
  if (typeof data === 'string') return data.trim() || undefined
  if (typeof data === 'object') {
    const details = (data as { details?: unknown })['details']
    if (typeof details === 'string' && details.trim()) return details.trim()
  }
  try {
    const json = JSON.stringify(data)
    return json && json !== '{}' && json !== 'null' ? json.slice(0, 400) : undefined
  } catch {
    return undefined
  }
}

export interface AcpConnectionOptions {
  readonly command: string
  readonly args?: readonly string[]
  /**
   * Extra environment for the agent. A function is read at every spawn, so a
   * secret stored after the app started reaches the next process; a plain
   * object is fixed at construction.
   */
  readonly env?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>)
  readonly cwd?: string
  readonly onNotification?: (method: string, params: unknown) => void
  /** Agent→client requests (`session/request_permission`). Return the result. */
  readonly onRequest?: (method: string, params: unknown) => Promise<unknown>
  readonly onExit?: (code: number | null) => void
  readonly onStderr?: (line: string) => void
  /**
   * The family outlived its own shutdown: `stop()` has returned, and something
   * it signalled is still running.
   *
   * Its own channel rather than `onStderr`, because this is the host talking
   * and not the agent — and because the host routes agent stderr to `debug`,
   * which a default run drops. `KILL_MS` is justified by this being *said*;
   * saying it somewhere nothing listens is not saying it.
   */
  readonly onShutdownIncomplete?: (detail: string) => void
}

/**
 * One agent process, one connection. Kept deliberately dumb: no restart
 * policy here — the adapter owns what a dead agent means for its sessions,
 * because "restart and pretend" is exactly the wrong answer mid-turn.
 */
/**
 * End a child and everything it started.
 *
 * Spawned `detached`, the child leads its own process group, and a negative
 * pid signals the whole group — the vendor CLI it launched and that CLI's own
 * MCP servers included. Falls back to signalling the child alone: the group
 * may already be gone (ESRCH), and Windows has no process groups to address.
 */
const endGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  const pid = child.pid
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Already gone, or never grouped. The direct signal below still applies.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Nothing left to end.
  }
}

/** How long the family is given to leave on its own before it is made to. */
const GRACE_MS = 2000

/**
 * How long the kernel is given to finish the job after SIGKILL.
 *
 * Not a politeness budget — SIGKILL cannot be caught, and a family that has
 * already spent the whole grace ignoring SIGTERM still leaves within a
 * millisecond of it. This covers the one case the kernel cannot answer
 * promptly: a process in uninterruptible sleep, wedged on a mount or a device
 * that never replies, which no signal moves until the I/O returns. Without a
 * ceiling one of those would hang the quit — and every restart after it — for
 * as long as the mount stayed down.
 *
 * A thousand times a real teardown, and the second half of what `stop()` can
 * cost: `GRACE_MS + KILL_MS`, three seconds, and only for a family that
 * ignored SIGTERM for two of them.
 *
 * Two properties keep this from being the invented number it looks like, and
 * they belong to it — change the constant and you owe both again:
 *
 *   - **Reaching it is reported**, through `onShutdownIncomplete` — its own
 *     channel, wired to `logger.warn`, and not `onStderr`, which the host
 *     files at `debug` under the agent's own output and a default run drops.
 *     At that point "stopped" is once again a claim and not a fact, and a
 *     workspace with something unaccounted for in it must say so. The kill
 *     still stands; the kernel finishes when the I/O does.
 *   - **Nothing asserts on it.** No test in the suite is pinned to this value,
 *     so it can be retuned on evidence without a test having to be edited to
 *     agree — which is the trap a budget standing in for an event sets.
 */
const KILL_MS = 1000

/**
 * How often the family is asked whether it has gone.
 *
 * It sets the resolution of both budgets above rather than a budget of its
 * own: a reap can overshoot either by up to one tick, which is noise beside
 * two thousand and one thousand. Tightening it buys a faster `stop()` on the
 * common path and costs a `kill(-pgid, 0)` per tick; it has never been worth
 * measuring, which is the whole argument for the number.
 */
const POLL_MS = 40

/**
 * Is anything still in this group?
 *
 * A process group outlives its leader while it has members, and its id is the
 * leader's pid — so signal 0 to the negative pid asks after the *family*, which
 * is the question that matters. Asking after the leader instead is what let a
 * descendant that traps SIGTERM outlive a shutdown the leader had already
 * finished.
 */
const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Wait for the leader itself, for the platforms that have nothing else.
 *
 * Windows has no process groups to poll, so the leader is all `endGroup`
 * reached and all there is to wait on. `exit` is a fact rather than a report
 * of a signal sent — Node emits it having already waited on the process — and
 * it is bounded by the same ceiling, so a leader that will not go cannot wedge
 * the quit either.
 */
const leaderGone = (child: ChildProcess, ceiling: number): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout
    const done = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    timer = setTimeout(() => {
      child.off('exit', done)
      resolve(false)
    }, ceiling)
    child.once('exit', done)
  })
}

/**
 * Ask the whole family to leave, insist once the deadline passes, and do not
 * come back until they have gone.
 *
 * Three mistakes are avoided here. Waiting on the leader alone let a
 * SIGTERM-ignoring descendant survive; killing the group the instant the
 * leader exited took the grace away from one that traps SIGTERM in order to
 * flush — the very behaviour the escalation exists to accommodate. So the
 * deadline belongs to the group: SIGTERM, then poll until it is empty, and
 * SIGKILL only when the time is actually up.
 *
 * The third was in what this promise *meant*. It used to resolve on **issuing**
 * the SIGKILL, so a caller awaiting it learned only that a signal had been
 * sent. That is what let `stop()` return with the previous generation still
 * dying while the next bridge was already spawning against the same workspace,
 * and it left a test nothing sharper to assert than a sleep. Resolving on the
 * group being *empty* is a fact the kernel owns: honest to await, and
 * deterministic to assert against — a port the family still holds cannot be
 * bound by anyone else, whatever the machine's load.
 *
 * The timers are never unref'd. With the processes gone quiet this poll can be
 * the promise's only resolver, and an awaited promise whose sole resolver does
 * not hold the event loop is one Node may abandon as "pending but the loop has
 * resolved".
 */
const reapGroup = (
  child: ChildProcess,
  grace = GRACE_MS,
  ceiling = KILL_MS,
): Promise<boolean> => {
  const pid = child.pid
  endGroup(child, 'SIGTERM')
  /* Never spawned — `spawn` failed and the `error` event is still on its way.
     There is no process and no group, so there is nothing to wait for, and
     waiting anyway would spend the whole ceiling and then report that a
     process group had ignored a SIGKILL that was never sent to anything. Not
     the same case as Windows below, which has a real process and merely no
     group to address; they shared a line once and it cost exactly this. */
  if (pid === undefined) return Promise.resolve(true)
  if (process.platform === 'win32') return leaderGone(child, ceiling)
  /* `performance.now()` and not `Date.now()`: both budgets below now gate app
     quit, and a wall clock can step *backwards* — an NTP correction is the
     everyday cause. A step back during the grace makes the deadline stop
     arriving, so the SIGKILL is never sent and the quit hangs for exactly as
     long as the ceiling exists to prevent. Monotonic time cannot do that.
     (Sleep is not an example: it steps the wall clock forward, which fires
     the kill early rather than never. What a monotonic clock does across a
     macOS sleep is not measured here, so nothing is claimed about it.) */
  const graceUntil = performance.now() + grace
  let killedAt: number | null = null
  return new Promise<boolean>((resolve) => {
    const tick = (): void => {
      if (!groupAlive(pid)) return resolve(true)
      if (killedAt === null && performance.now() >= graceUntil) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // It left between the check and the signal.
        }
        killedAt = performance.now()
      }
      // Past the grace the other budget applies, and it is a ceiling rather
      // than a deadline: what is left is not a process choosing to stay, it is
      // the kernel not yet finished. Giving up on the wait is not giving up on
      // the kill, so the answer is `false` and not a throw.
      if (killedAt !== null && performance.now() - killedAt >= ceiling) return resolve(false)
      setTimeout(tick, POLL_MS)
    }
    tick()
  })
}

export class AcpConnection {
  #child: ChildProcess | null = null
  #extraEnv: Readonly<Record<string, string>> = {}
  #nextId = 0
  readonly #pending = new Map<number, Pending>()
  readonly #options: AcpConnectionOptions
  #launch: { readonly command: string; readonly args: readonly string[] } | null = null
  /**
   * Shutdowns still in flight — the deliberate one and the one the exit
   * handler starts when the bridge falls over on its own.
   *
   * A crash empties `#child` while the family it left behind is still being
   * seen out, so the handle is no longer the answer to "is anything of the
   * last generation still running?". This is. Both doors that would put a
   * second generation on the same workspace — `stop()` and `start()` — go
   * through it, which is the whole of the rule: one generation at a time.
   */
  readonly #reaping = new Set<Promise<void>>()
  /**
   * How many times a stop has been asked for. Read by a `start()` that had to
   * wait, so that it can tell whether it is still the most recent intention —
   * see the abandonment there for what goes wrong without it.
   */
  #stopEpoch = 0

  constructor(options: AcpConnectionOptions) {
    this.#options = options
  }

  get alive(): boolean {
    return this.#child !== null && this.#child.exitCode === null
  }

  /**
   * Environment added at spawn, on top of the configured `env` — for values
   * only known after construction, such as the path of an agent CLI the
   * bridge should drive. Takes effect on the next `start()`.
   */
  withEnv(extra: Readonly<Record<string, string>>): void {
    this.#extraEnv = { ...this.#extraEnv, ...extra }
  }

  /**
   * Replaces what is spawned, for a host that decides which copy of an
   * agent answers only after looking at the machine — the newest of several
   * installs, or the one the person pinned. Takes effect on the next
   * `start()`, exactly like `withEnv`.
   */
  withCommand(command: string, args: readonly string[]): void {
    this.#launch = { command, args }
  }

  /**
   * Spawns the bridge, once whatever came before it is confirmed gone.
   *
   * Asynchronous for that one reason: a restart that begins while the last
   * family is still dying is two agent processes against one workspace, which
   * on this product is two agents editing the same files.
   *
   * With nothing in flight — every start but a restart — the spawn below is
   * still reached synchronously, as it was when this returned `void`. That is
   * the common path and callers may lean on it; what they must not lean on is
   * its being the *only* path, because a restart is exactly when it is not.
   *
   * **Answers whether a bridge is running because of this call**, which is not
   * the same as "no error". A start can be abandoned by a stop that overtakes
   * it, and a caller that cannot see the difference goes on to speak to a
   * process that was never spawned — and then reports whatever that failure
   * looks like from where it is standing, which in this app was a healthy,
   * installed agent described to its user as missing.
   *
   * `false` means *this call* did not spawn one, which is not the same as
   * "nothing is running": two starts queued behind one reap with a stop
   * between them leave the first answering `false` while the second goes on
   * to spawn. No caller in this repo can reach that — both restart paths
   * await their own `stop()` first, so the reaps are drained before they ask
   * — but a caller that treats `false` as "the agent is down" is reading more
   * into it than it says.
   */
  async start(): Promise<boolean> {
    if (this.alive) return true
    if (this.#reaping.size > 0) {
      const epoch = this.#stopEpoch
      await this.#settled()
      /* A stop landed while this was waiting, and it wins. Both callers queue
         behind the same reap and this one resumes first, having waited first —
         so without this it would spawn a bridge *into* a shutdown that then
         returns and reports itself finished. On the quit path nothing would
         ever reap what it spawned. The window is only open because `start()`
         is asynchronous: while it spawned synchronously, a `stop()` arriving
         after it always found a `#child` to take. */
      if (this.#stopEpoch !== epoch) return false
    }
    // And that wait yields, so another `start()` may have got there first.
    if (this.alive) return true
    const launch = this.#launch ?? { command: this.#options.command, args: this.#options.args ?? [] }
    const child = spawn(launch.command, [...launch.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      /* Its own process group, so it can be ended as a family.
         A bridge is rarely a leaf: it spawns the vendor's CLI, which spawns
         that CLI's own MCP servers. Killing the bridge alone left the CLI and
         every server it started running as orphans, reparented to init —
         quitting the app freed the window and none of the processes behind it.
         With a group of its own, one signal reaches all of them. */
      detached: process.platform !== 'win32',
      ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
      env: {
        ...process.env,
        ...(typeof this.#options.env === 'function' ? this.#options.env() : this.#options.env),
        ...this.#extraEnv,
      },
    })
    this.#child = child

    /*
      A bridge that dies between `alive` and the write: the pipe answers
      EPIPE as an `error` event on stdin, and a stream nobody listens to turns
      that into an uncaught exception in the host — in the desktop app, a
      modal error box over a frozen window, seen live. It is noted and left
      to `exit`, the event that actually knows what happened to the agent.
    */
    child.stdin?.on('error', (error) => this.#options.onStderr?.(`agent stdin: ${error.message}`))
    createInterface({ input: child.stdout! }).on('line', (line) => this.#onLine(line))
    createInterface({ input: child.stderr! }).on('line', (line) =>
      this.#options.onStderr?.(line),
    )
    child.on('error', (error) => this.#failAll(new AcpError(`agent failed to start: ${error.message}`)))
    child.on('exit', (code) => {
      if (this.#child !== child) return
      /* The bridge died on its own — a crash, a bad build, a CLI that refused
         to start — and everything it spawned is now an orphan. Clearing the
         handle without reaping left them running *and* left `stop()` a no-op,
         because the only handle to the group had just been thrown away. Not
         awaited: nobody is waiting on a crash, and the grace is the same —
         but it is *recorded*, so the next `stop()` or `start()` is. */
      this.#reap(child)
      this.#child = null
      this.#failAll(
        new AcpError(
          `The agent exited${code !== null ? ` (code ${code})` : ''} while requests were waiting.`,
        ),
      )
      this.#options.onExit?.(code)
    })
    return true
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.alive) throw new AcpError('The agent is not running.')
    const id = ++this.#nextId
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    })
    this.#child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return promise
  }

  notify(method: string, params: unknown): void {
    if (!this.alive) return
    this.#child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /**
   * Ends the agent the way a crash would: the exit is reported through
   * `onExit`, pending requests fail as "exited". For tests that need an
   * agent to die under the adapter; `stop()` is the deliberate version.
   *
   * It does **not** bump `#stopEpoch`. That reads like a decision and is
   * really a structural fact, which is worth stating because it cannot be
   * tested: a reap is only ever in flight with `#child` already null — both
   * `#reap` callers clear it first, and `start()` will not spawn until
   * `#settled()` — so whenever a `start()` is parked, this method finds
   * nothing to signal and does nothing at all. There is no reachable state in
   * which bumping the epoch here would cancel a queued restart. The intent
   * still holds for the exit handler, which reaps on the same terms: a crash
   * must not cancel the restart it prompted, since being restarted is what a
   * crashed agent is waiting for.
   */
  kill(): void {
    const child = this.#child
    if (child) endGroup(child, 'SIGKILL')
  }

  /**
   * Stops the agent on purpose. Detached first, so the exit that follows is
   * not reported through `onExit` as a crash — a deliberate stop is a state
   * the caller already knows about — and `start()` may be called again.
   *
   * Returns when the family is *gone*, not when it has been asked to go, which
   * is what makes calling `start()` next safe. Bounded, at `GRACE_MS +
   * KILL_MS`: an agent nothing can kill must not be able to hold the quit
   * open, and both halves of that budget say above what they are for.
   *
   * **Deliberately not `async`, and it must stay that way.** A `start()`
   * parked on `#settled()` re-reads `#stopEpoch` when it wakes, so everything
   * before the first yield here has to happen before that wake — and "do not
   * put an `await` above this line" is a convention a comment cannot hold. A
   * plain function *cannot contain* an `await`: adding one means first writing
   * `async` on this signature, which is a line in a diff and a reason to read
   * this paragraph. No test can stand in for that. The likeliest future edit —
   * hoisting the `#settled()` wait to the top — passes the test that covers
   * this, because the woken `start()` spawns a bridge and the resumed `stop()`
   * then finds that brand-new child and reaps it, so the assertion holds while
   * a generation really did enter the workspace.
   */
  stop(): Promise<void> {
    try {
      // Before anything can yield: a `start()` already waiting on a reap has
      // to see this, whether or not there is a child here to end.
      this.#stopEpoch += 1
      const child = this.#child
      if (child) {
        this.#child = null
        this.#failAll(new AcpError('The agent was stopped.'))
        // Closing stdin is how a well-behaved agent is asked to leave; the CLI
        // it spawned may not be listening, so the family is asked too, and
        // given the same deadline whether or not the leader is still in it.
        child.stdin?.end()
        this.#reap(child)
      }
    } catch (error) {
      /* Without `async` a throw up there would reach the caller *synchronously*
         rather than as a rejection, which a `.catch()` with no `try` around it
         would miss. Nothing above throws today — `#failAll` only rejects, an
         ended stdin does not, and `#reap`'s signalling is guarded inside
         `endGroup` — but an audit is what the signature above just stopped
         relying on, so this costs the change nothing. */
      return Promise.reject(error)
    }
    /* And whatever shutdown is already in flight is also what "stopped" means.
       There need not be a child at all: a crashed bridge clears the handle the
       moment it exits and leaves its family being reaped behind it, and this
       used to return on that missing handle — instantly, mid-escalation, so
       the caller's next `start()` raced a process group that was still on its
       way out. The same is true of a second `stop()` arriving while the first
       is still in the grace. */
    return this.#settled()
  }

  /** Start seeing a family out, and record it while it is happening. */
  #reap(child: ChildProcess): void {
    const reaping = reapGroup(child)
      .then((gone) => {
        /* The one path on which "stopped" is still a claim, and the whole of
           what makes `KILL_MS` a ceiling rather than an invented number. The
           alternative is a workspace with something unaccounted for in it and
           nothing anywhere saying so.

           Two nouns that are wrong on Windows if this is written once: there
           is no process group there, and `child.kill()` ignores the signal
           name and terminates outright, so nothing named SIGKILL was ever
           sent. Say what actually happened on the platform it happened on. */
        if (!gone) {
          this.#options.onShutdownIncomplete?.(
            process.platform === 'win32'
              ? `the agent did not exit within ${KILL_MS}ms of being terminated; it is left to the OS`
              : `the process group did not answer SIGKILL within ${KILL_MS}ms; it is left to the kernel`,
          )
        }
      })
      // Never rejects — every signal in `reapGroup` is already guarded — but a
      // tracked promise that could is one unhandled rejection away from taking
      // the host down, and `#settled` awaits all of them.
      .catch(() => undefined)
    this.#reaping.add(reaping)
    void reaping.finally(() => this.#reaping.delete(reaping))
  }

  /**
   * Resolves when no shutdown is in flight.
   *
   * The loop is for reaps that *start* during the wait, and only that. It is
   * not insurance against reading a stale set: `#reap` registers the deletion
   * on the same promise this then awaits, and it registers first, so the
   * delete has always run by the time `Promise.all` resolves — reactions on a
   * promise fire in registration order, and microtasks are FIFO.
   */
  async #settled(): Promise<void> {
    while (this.#reaping.size > 0) await Promise.all([...this.#reaping])
  }

  #onLine(line: string): void {
    if (line.trim().length === 0) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.#options.onStderr?.(`unparseable agent output: ${line.slice(0, 160)}`)
      return
    }
    const id = message['id']
    if (typeof id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.#pending.get(id)
      if (!pending) return
      this.#pending.delete(id)
      if ('error' in message && message['error']) {
        const error = message['error'] as { message?: string; code?: number; data?: unknown }
        pending.reject(new AcpError(error.message ?? 'agent error', error.code, detailOf(error['data'])))
      } else {
        pending.resolve(message['result'])
      }
      return
    }
    const method = message['method']
    if (typeof method !== 'string') return
    if (typeof id === 'number') {
      // Agent→client request. Answer or refuse; silence would hang the agent.
      const handler = this.#options.onRequest
      void (async () => {
        try {
          if (!handler) throw new AcpError(`this client does not serve ${method}`)
          const result = await handler(method, message['params'])
          this.#child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
        } catch (error) {
          this.#child?.stdin?.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: error instanceof Error ? error.message : String(error) },
            })}\n`,
          )
        }
      })()
      return
    }
    this.#options.onNotification?.(method, message['params'])
  }

  #failAll(error: AcpError): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}
