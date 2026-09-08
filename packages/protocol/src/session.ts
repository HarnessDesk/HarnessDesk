import type { RuntimeId, SessionId, TurnId } from './ids.js'
import type { AgentItem, UserContent } from './items.js'
import type { ConfigOption, OptionValue } from './options.js'
import type { UsageLane, UsageSource } from './usage.js'

/**
 * Session, turn, and settings — the container model around items.
 */

/**
 * The few facts about a session that every runtime has and the interface
 * needs by name: where it runs and what it runs on.
 *
 * Everything a user *controls* — approvals, sandboxing, reasoning effort, a
 * service tier, a collaboration mode — is a `ConfigOption` the runtime
 * declares, not a field here. Those used to be fields, and each one was a
 * Codex concept the rest of the stack had to know about.
 */
export interface SessionSettings {
  readonly cwd: string
  /** Extra roots the agent may read or write beyond `cwd`. */
  readonly workspaceRoots?: readonly string[]
  /** What the session is currently on, for display. Changed through the `model` option. */
  readonly model: string
  readonly modelProvider?: string
}

/** Options accepted when opening a session. All are advisory; runtimes may clamp. */
/**
 * A model endpoint resolved by the host for one conversation. The credential
 * has already been exchanged for a loopback gateway: `endpoint` points at the
 * gateway and `token` authorises exactly this conversation's backend against
 * it. The provider's real key never appears here — the renderer, the wire and
 * the backend's environment only ever see the gateway token.
 */
export interface ResolvedModelRoute {
  readonly id: string
  readonly name: string
  /** The loopback gateway URL the backend should call. */
  readonly endpoint: string
  /** The wire protocol the endpoint speaks, e.g. `responses`. */
  readonly wireProtocol: string
  /** Bearer token for the gateway; useless anywhere else. */
  readonly token: string
  /** Model id to request from the endpoint, when the route pins one. */
  readonly model?: string
}

export type SessionOptions = Partial<SessionSettings> & {
  readonly cwd: string
  /**
   * Run this conversation against another model endpoint. Resolved by the
   * host from its route catalogue; adapters inject it per conversation and
   * never write it into the user's own configuration.
   */
  readonly route?: ResolvedModelRoute
  /** Do not persist this session to the runtime's history. */
  readonly ephemeral?: boolean
  /**
   * Initial values for the runtime's options, by option id. A runtime refuses
   * ids it does not declare rather than ignoring them: a preset that silently
   * half-applies is worse than one that fails.
   */
  readonly options?: Readonly<Record<string, OptionValue>>
}

/**
 * A message the user wrote while the agent was busy, waiting for its turn.
 *
 * The queue is the host's, not the runtime's: no backend has the concept, and
 * a queue in the renderer would die on a reload and could not fire for a
 * window that is not open. See `SessionQueue`.
 */
export interface QueuedMessage {
  /** Host-minted and unique within the session; the only handle the UI has on it. */
  readonly id: string
  readonly input: readonly UserContent[]
  readonly queuedAt: number
  /** `sending` while the host is handing it to the runtime, so the row can say so. */
  readonly state: 'queued' | 'sending'
}

/**
 * What is waiting to be said next, and whether it will be.
 *
 * `paused` is the state after a turn that did not finish cleanly — the user
 * pressed Stop, or the backend failed. Delivering into that would spend a turn
 * on a guess, so the queue stops and says why, and the user resumes it.
 */
export type QueueStatus = 'waiting' | 'paused'

export interface SessionQueue {
  readonly messages: readonly QueuedMessage[]
  readonly status: QueueStatus
  /** Why it paused, in words a person can read. Null while waiting. */
  readonly reason?: string | null
}

/** An empty queue — what every session starts with, and returns to. */
export const emptyQueue = (): SessionQueue => ({ messages: [], status: 'waiting', reason: null })

export type SessionStatus =
  /** Known to exist but not loaded into memory — the usual state for history rows. */
  | { readonly type: 'notLoaded' }
  | { readonly type: 'idle' }
  | { readonly type: 'active' }
  | { readonly type: 'error'; readonly message?: string }

export interface GitInfo {
  readonly sha?: string
  readonly branch?: string
  readonly originUrl?: string
}

/**
 * The repository a folder belongs to, as the host reads it from git.
 *
 * Two checkouts of one repository are one project. `root` is the main
 * checkout every worktree of it hangs off — the folder git calls the common
 * dir's parent — so a conversation cut into a worktree, or started in a
 * subfolder, still says which project it is about. `worktree` is true only
 * for a linked checkout, which is the distinction the interface marks: a
 * subfolder of the main tree is the same working copy, a worktree is not.
 *
 * Read here rather than taken from the agent because only one of them
 * reports git at all. Grouping on a remote left every conversation an ACP
 * agent had in a worktree as a project of its own.
 */
export interface RepoInfo {
  /** The main checkout: absolute, canonical. */
  readonly root: string
  /** The folder is a linked worktree rather than the main checkout. */
  readonly worktree: boolean
}

export interface TokenUsage {
  readonly totalTokens: number
  readonly inputTokens: number
  /** The part of `inputTokens` that was served from cache — a cache *hit*. */
  readonly cachedInputTokens: number
  /**
   * The part of `inputTokens` written *into* cache — a cache *miss*, billed at
   * a premium over ordinary input.
   *
   * Optional, and deliberately not defaulted to zero. A hit count on its own
   * cannot be read as cache health: a turn that re-cached 100K tokens and a
   * turn whose input was simply small both have no hits. Absent means "this
   * runtime does not report misses", which is a different fact from "there
   * were none", and `lib/cache-health.ts` keeps them apart.
   */
  readonly cacheWriteTokens?: number
  readonly outputTokens: number
  /**
   * False when `outputTokens` is a floor rather than a total.
   *
   * A runtime that reports usage while a response is still streaming has a
   * real input count and a placeholder output count — Claude Code's
   * `message_start` says 1. A top-level turn gets the true figure back when
   * it ends; a delegated child never does, because the correction is per
   * turn and does not attribute. Absent means exact, which is the ordinary
   * case; `false` is a claim the interface has to soften ("≥ 1"), never one
   * it may round away.
   */
  readonly outputExact?: boolean
  readonly reasoningOutputTokens: number
}

/** What a session has spent, and how much of the model's context it fills. */
export interface SessionUsage {
  /** Every token the session has consumed, across all turns. */
  readonly total: TokenUsage
  /** The most recent turn's tokens. */
  readonly last: TokenUsage
  /**
   * Tokens in the model's context right now, as the runtime reports them.
   * Each runtime has its own arithmetic for this (Codex drops prior
   * reasoning, Claude counts the latest call's input); it is done in the
   * adapter so that the renderer only ever divides `contextUsed` by
   * `contextWindow`. Null when the runtime does not say.
   */
  readonly contextUsed?: number | null
  /** The model's context window in tokens. Null when the runtime does not say. */
  readonly contextWindow?: number | null
  /** Cumulative cost of the session, for runtimes that price it. */
  readonly cost?: SessionCost | null
  /**
   * Of `total`, the part spent by agents this session delegated to.
   *
   * A share of `total`, never an addition to it: the runtimes that report
   * sub-agent spend already fold it into the session's own counts (Codex
   * 0.151 counts nested usage toward the root goal's budget; Claude Code's
   * `modelUsage` is cumulative over the process, helper models included).
   * Carrying it separately lets the window *split* a total it must not
   * re-sum. Absent for every runtime that cannot attribute it.
   */
  readonly delegated?: TokenUsage | null
  /**
   * What the context is made of, for the runtimes that can say. Null for
   * every other one — see `ContextBreakdown` for why this is not derived.
   */
  readonly breakdown?: ContextBreakdown | null
}

/**
 * The composition of a session's context: how the tokens in the window are
 * divided between the parts the agent assembled the prompt from.
 *
 * Only the process that *builds* the request can answer this. The model
 * returns aggregates; the wire carries a total. So this is reported, never
 * computed — a client that counted characters and divided would produce a
 * number for every agent, and the number would be wrong exactly where it
 * matters. An agent that does not report a composition has none, and the
 * interface says so instead of inventing one.
 */
export interface ContextBreakdown {
  /** Named parts, in the order the runtime sent them. */
  readonly segments: readonly ContextSegment[]
  /**
   * True when any segment was priced by an estimator rather than by the
   * provider. Load-bearing: an approximate breakdown sits beside an exact
   * `contextUsed` in a different unit of truth, so the two do not reconcile
   * and the interface must not draw the segments as slices of the ring or
   * complete them with a "free space" remainder.
   */
  readonly approximate: boolean
  /** Who priced it, so the interface can name the source rather than guess. */
  readonly source: string
}

export interface ContextSegment {
  /** Stable across runtimes where the meaning matches; free-form otherwise. */
  readonly id: string
  readonly label: string
  readonly tokens: number
  /** How many things the segment is — tool schemas, memory files. Exact. */
  readonly count?: number | null
}

export interface SessionCost {
  readonly amount: number
  /** ISO 4217: "USD". */
  readonly currency: string
}

/** One rolling usage allowance — a plan's 5-hour or weekly window. */
export interface UsageWindow {
  /** Named from the window length: "5-hour", "Weekly". */
  readonly label: string
  /** 0–100. */
  readonly usedPercent: number
  readonly windowMinutes: number | null
  /** Epoch milliseconds when the window refills, when the backend says. */
  readonly resetsAt: number | null
}

/**
 * Remaining quota, as reported by the runtime's backend. Absent for runtimes
 * that do not meter usage.
 *
 * Three separate facts travel here and they must not be conflated: the plan's
 * rolling usage `windows` (what the vendor's own app shows as "usage
 * remaining"), the prepaid `credits` balance (`hasCredits` is simply false
 * for a plan user who never bought any — it says nothing about whether turns
 * will run), and `reached`, the one signal that a limit has actually been
 * hit and turns will fail.
 */
export interface RateLimits {
  readonly hasCredits?: boolean
  readonly unlimited?: boolean
  readonly balance?: number | null
  readonly planType?: string | null
  readonly windows?: readonly UsageWindow[]
  /**
   * The same allowances with everything a `UsageWindow` cannot carry — the
   * scope a lane is narrowed to, the source's own severity, and whether a
   * figure was reported at all. Additive: `windows` stays authoritative for
   * every reader that only knows about it.
   */
  readonly lanes?: readonly UsageLane[]
  /** How these numbers were obtained, for a surface that shows their provenance. */
  readonly source?: UsageSource
  /** Set when a limit has actually been hit, naming which one. */
  readonly reached?: string | null
}

/**
 * A standing objective for a session, with its own budget.
 *
 * Distinct from a turn: a goal outlives the turns that work toward it, which is
 * what makes a budget meaningful.
 */
export interface SessionGoal {
  readonly objective: string
  readonly status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'
  readonly tokenBudget?: number | null
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
}

export type TurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed'

export interface TurnError {
  readonly message: string
  readonly code?: string
  readonly retrying?: boolean
}

export type PlanStepStatus = 'pending' | 'inProgress' | 'completed'

export interface PlanStep {
  readonly step: string
  readonly status: PlanStepStatus
}

export interface Turn {
  readonly id: TurnId
  readonly items: readonly AgentItem[]
  readonly status: TurnStatus
  readonly error?: TurnError | null
  readonly startedAt?: number | null
  readonly completedAt?: number | null
  readonly durationMs?: number | null
  /** Aggregated unified diff across every file the turn touched. */
  readonly diff?: string | null
  readonly plan?: readonly PlanStep[]
}

/**
 * A conversation. `turns` may be empty for history rows that have not been
 * loaded — check `itemsLoaded` before treating an empty transcript as genuinely empty.
 */
export interface Session {
  readonly id: SessionId
  readonly runtime: RuntimeId
  readonly title?: string | null
  /** First line of the opening user message, for list rendering. */
  readonly preview?: string | null
  readonly cwd: string
  readonly status: SessionStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly settings?: SessionSettings
  /** The runtime's controls for this session, with their current values. */
  readonly options?: readonly ConfigOption[]
  /** Whether this conversation's memory is on, for runtimes that have one. */
  readonly memory?: boolean
  readonly git?: GitInfo | null
  readonly usage?: SessionUsage | null
  readonly goal?: SessionGoal | null
  readonly turns: readonly Turn[]
  readonly itemsLoaded: boolean
  /** Set when this session was forked from another. */
  readonly forkedFrom?: SessionId | null
  readonly archived?: boolean
}

/** The lightweight row shown in the sidebar; never carries a transcript. */
export interface SessionSummary {
  readonly id: SessionId
  readonly runtime: RuntimeId
  readonly title?: string | null
  readonly preview?: string | null
  readonly cwd: string
  readonly status: SessionStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly git?: GitInfo | null
  /** The repository this session's folder belongs to; null outside one. */
  readonly repo?: RepoInfo | null
  readonly archived?: boolean
}
