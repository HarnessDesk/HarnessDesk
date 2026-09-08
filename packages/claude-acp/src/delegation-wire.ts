/**
 * The delegation extension to ACP, agent side.
 *
 * ACP has a vocabulary for one agent talking to one client. It has none for
 * an agent that hands part of the work to another agent — no update kind, no
 * field on a session, nothing on a tool call that says "this one has its own
 * transcript and its own bill". So a delegation arrives at a client as one
 * more tool row, and the three things that make it not a tool row — its own
 * model, its own lifetime, its own spend — are lost on the way.
 *
 * That mattered less when delegation was a curiosity. It stopped being one:
 * Codex 0.151 counts nested sub-agent usage toward the root goal's budget,
 * DeepSeek Harness 0.1.2 lets the caller choose a provider, model, reasoning
 * effort and maximum output length per child, and Claude Code streams a
 * foreground sub-agent's tool activity to its remote clients. Delegation is
 * now the unit all three bill.
 *
 * This rides ACP's extension channel exactly as the background-task
 * extension does — see `tasks-wire.ts` for the shape and the reasoning.
 * `extNotification` pushes the whole list whenever it moves; `extMethod`
 * answers the one thing a client can ask. A client that has never heard of
 * either simply never calls, and an unknown notification is ignored by every
 * conforming client.
 *
 * These strings are duplicated in `@harnessdesk/transport-acp`, the client
 * half. They are copied rather than shared on purpose: this bridge carries no
 * HarnessDesk dependency and is meant to keep it that way, so any ACP client
 * can drive it. Change one, change the other.
 */

/** Agent → client: the whole list, whenever it changes. */
export const DELEGATION_NOTIFICATION = '_harnessdesk/delegation/changed'
/** Client → agent: the whole list, for a pane that just opened. */
export const DELEGATION_LIST = '_harnessdesk/delegation/list'

/** What the agent declares in `initialize`'s `_meta` when it serves both. */
export const DELEGATION_CAPABILITY = 'delegation'

/**
 * One delegation's token counts.
 *
 * Deliberately the same four names ACP's own unstable `Usage` uses, so a
 * client that already reads one reads the other without a translation table.
 *
 * `cachedWriteTokens` is here because a hit count on its own says nothing
 * about cache health: a child that re-cached 100K tokens at a premium and a
 * child whose input was simply small both report no hits. Both halves, or the
 * number is a decoration.
 */
export interface DelegationUsage {
  /** Every input token, cache reads and cache writes included. */
  readonly inputTokens: number
  readonly outputTokens: number
  /** Of `inputTokens`, the part served from cache — the hit. */
  readonly cachedReadTokens: number
  /** Of `inputTokens`, the part written into cache — the miss. */
  readonly cachedWriteTokens: number
  readonly totalTokens: number
  /**
   * False when at least one call contributed a placeholder output count.
   *
   * Claude Code's streamed `assistant` messages carry `message_start` usage:
   * the input side is final, the output side is whatever had been emitted
   * when the stream opened — 1, usually. A top-level turn gets its true
   * output back from the `result` message; a child never does, because
   * `result` is per turn and does not attribute. So the input side of a
   * delegation is exact and the output side may be a floor, and a client that
   * cannot tell the difference will draw a sub-agent that wrote a thousand
   * lines as having produced four tokens.
   */
  readonly outputExact: boolean
}

/** What the agent pushes: one delegation the parent made, and how it is doing. */
export interface BridgeDelegation {
  /** The parent's own handle for it — the tool call that spawned it. */
  readonly id: string
  /** The kind of agent asked for: `Explore`, `general-purpose`, a team name. */
  readonly label: string
  readonly state: 'running' | 'completed' | 'failed' | 'stopped'
  /** What the parent asked it to do. */
  readonly prompt?: string
  /** The model the parent named, when it named one. */
  readonly requestedModel?: string
  /**
   * The models actually observed running under it, first seen first.
   *
   * Not the same as `requestedModel` and not always one: a child may fall
   * back, and a helper model may run inside it. What ran is a fact; what was
   * asked for is an intention.
   */
  readonly models: readonly string[]
  /** Epoch milliseconds. */
  readonly startedAt: number
  readonly endedAt?: number
  /** How many API calls ran under it. Zero is a delegation that never started. */
  readonly calls: number
  /** Absent until the first call under it reports anything. */
  readonly usage?: DelegationUsage
}
