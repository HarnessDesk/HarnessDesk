import type { CarryOnCause, CarryOnChoice, CarryOnMode, CarryOnScope, CarryOnTargetState, ModelInfo } from '@harnessdesk/protocol'

/**
 * What to do when a conversation reaches its usage limit — the pure half.
 *
 * No I/O: the service gathers the candidates, their pacing tier and the reset,
 * and this answers. The order is the owner's rule: another account of the
 * same agent first, then another agent, every switch announced. A same-agent
 * account keeps the model, the tools and — for agents whose accounts share
 * their conversations — the very thread. A reset retry beats another agent
 * only when it is soon, because a handoff loses the agent's working context.
 * And the choice is made before any timer is set, so a conversation never
 * waits for a reset while a usable account sits idle.
 */

/** One Codex five-hour window: a reset closer than this is worth waiting for rather than handing off. */
export const SOON_MS = 5 * 60 * 60 * 1000
/** Moves one incident may make before it gives up. */
export const CARRY_ON_HOPS = 3
/** What a continued conversation is sent: the words the Lead's retry already uses. */
export const CONTINUE_TEXT = 'Continue from where you stopped.'

/** Somewhere the conversation could go on. */
export interface CarryOnCandidate {
  readonly runtime: string
  /** The agent this account belongs to (`slot.agent`, else its own id). */
  readonly agent: string
  readonly name: string
  readonly account?: string
  /** The pacing tier: 0 room with a known reset, 1 room with it unknown, 2 nearly spent, 3 out. */
  readonly tier: 0 | 1 | 2 | 3
  readonly resetsAt: number | null
  /** Shares the stuck conversation's store, so the thread itself can move. */
  readonly sameThread: boolean
  /** Pays through an API key or a gateway: offered on the card, never taken automatically. */
  readonly gateway: boolean
  readonly signedIn: boolean
  /** `capabilities.resume`: an agent that cannot reopen a conversation cannot carry one. */
  readonly resume: boolean
  /** Why this candidate may not take the conversation at all (a seat's independence rule). */
  readonly refused?: string
}

export interface DecideInput {
  /** The rule that applies, already resolved by `carryOnFor`, or the person's own answer. */
  readonly choice: CarryOnChoice
  readonly from: CarryOnScope
  readonly otherAgents: boolean
  readonly stuck: { readonly runtime: string; readonly agent: string }
  /** When the stuck account resets, when known. */
  readonly resetsAt: number | null
  /** In the person's pool order; ranked here by tier. */
  readonly candidates: readonly CarryOnCandidate[]
  readonly tried: readonly string[]
  readonly hops: number
  /** A seat whose run is at or over its budget never moves. */
  readonly overBudget?: boolean
  /** The person picked this runtime on the card. */
  readonly target?: string
}

export type CarryOnAction =
  | {
      readonly kind: 'ask'
      readonly target: CarryOnCandidate | null
      readonly mode: CarryOnMode | null
      readonly others: readonly CarryOnCandidate[]
      readonly wait: boolean
      readonly scope: CarryOnScope
    }
  | { readonly kind: 'move'; readonly target: CarryOnCandidate; readonly mode: CarryOnMode }
  | { readonly kind: 'wait'; readonly resetsAt: number }
  | { readonly kind: 'stop'; readonly phase: 'stopped' | 'exhausted'; readonly note: string }

const NO_ROOM = 'no other account or agent has room'

/** Stable, by tier; within tier 0 the soonest reset first, so allowance about to expire is spent first. */
const ranked = (candidates: readonly CarryOnCandidate[]): CarryOnCandidate[] =>
  candidates.map((entry, at) => ({ entry, at })).sort((a, b) =>
    a.entry.tier - b.entry.tier ||
    (a.entry.tier === 0 && b.entry.tier === 0 ? (a.entry.resetsAt ?? Infinity) - (b.entry.resetsAt ?? Infinity) : 0) ||
    a.at - b.at).map(({ entry }) => entry)

/** Whether this candidate may be taken without asking: signed in, able to resume, on a plan, with room. */
export const automatic = (candidate: CarryOnCandidate, tried: readonly string[]): boolean =>
  candidate.signedIn && candidate.resume && !candidate.gateway && candidate.tier <= 1 && !candidate.refused && !tried.includes(candidate.runtime)

const modeOf = (candidate: CarryOnCandidate, stuckAgent: string): CarryOnMode =>
  candidate.agent === stuckAgent && candidate.sameThread ? 'sameThread' : 'handoff'

/** What the card shows a candidate as, when it is not simply available. */
export const targetStateOf = (candidate: CarryOnCandidate): CarryOnTargetState | undefined =>
  !candidate.signedIn ? 'signedOut' : candidate.gateway ? 'apiKey' : candidate.tier >= 2 ? 'nearlyOut' : undefined

/** The best automatic candidate, by the owner's order: same agent, then (if allowed) the best of each other agent. */
const best = (input: DecideInput): { readonly same: CarryOnCandidate | null; readonly other: CarryOnCandidate | null } => {
  const usable = ranked(input.candidates.filter(candidate => candidate.runtime !== input.stuck.runtime && automatic(candidate, input.tried)))
  const same = usable.find(candidate => candidate.agent === input.stuck.agent) ?? null
  const other = input.otherAgents ? usable.find(candidate => candidate.agent !== input.stuck.agent) ?? null : null
  return { same, other }
}

export const decide = (input: DecideInput, now: number): CarryOnAction => {
  const resetKnown = input.resetsAt !== null && input.resetsAt > now
  if (input.overBudget) return { kind: 'stop', phase: 'stopped', note: 'Run budget reached' }
  switch (input.choice) {
    case 'stop':
      return { kind: 'stop', phase: 'stopped', note: input.from === 'agent' ? 'set to stop for this agent' : 'set to stop at a usage limit' }
    case 'wait':
      return resetKnown ? { kind: 'wait', resetsAt: input.resetsAt! } : { kind: 'stop', phase: 'stopped', note: 'no reset time known' }
    case 'ask': {
      const { same, other } = best(input)
      const target = same ?? other
      // One this incident already went to is never offered: a switch refuses it, so the card would offer a dead end.
      // A restart that left a send to it unconfirmed says so in the incident's note instead.
      const others = ranked(input.candidates.filter(candidate => candidate.runtime !== input.stuck.runtime && candidate !== target &&
        candidate.resume && candidate.tier < 3 && !candidate.refused && !input.tried.includes(candidate.runtime) && (input.otherAgents || candidate.agent === input.stuck.agent)))
      return { kind: 'ask', target, mode: target ? modeOf(target, input.stuck.agent) : null, others, wait: resetKnown, scope: input.from }
    }
    case 'switch': {
      if (input.hops >= CARRY_ON_HOPS) return { kind: 'stop', phase: 'exhausted', note: NO_ROOM }
      if (input.target !== undefined) {
        const picked = input.candidates.find(candidate => candidate.runtime === input.target)
        // The person chose it on the card: a nearly spent or API-key account is theirs to spend; signed out or
        // run out since the card was drawn is not.
        if (picked && picked.signedIn && picked.resume && picked.tier < 3 && !picked.refused && !input.tried.includes(picked.runtime))
          return { kind: 'move', target: picked, mode: modeOf(picked, input.stuck.agent) }
        return { kind: 'stop', phase: 'exhausted', note: NO_ROOM }
      }
      const { same, other } = best(input)
      if (same) return { kind: 'move', target: same, mode: modeOf(same, input.stuck.agent) }
      // A reset that is soon beats a handoff: waiting loses nothing, a handoff loses the agent's working context.
      if (resetKnown && input.resetsAt! - now <= SOON_MS) return { kind: 'wait', resetsAt: input.resetsAt! }
      if (other) return { kind: 'move', target: other, mode: 'handoff' }
      if (resetKnown) return { kind: 'wait', resetsAt: input.resetsAt! }
      return { kind: 'stop', phase: 'exhausted', note: NO_ROOM }
    }
  }
}

/**
 * The model a move continues on: the same id when the target lists it, else
 * the target's default. Never one the target hides. Across agents model ids do
 * not carry, so a handoff to another agent always takes the default.
 */
export const chooseModel = (
  current: string | undefined,
  models: readonly ModelInfo[],
  sameAgent: boolean,
): { readonly model: string | undefined; readonly note?: string } => {
  const visible = models.filter(model => !model.hidden)
  const fallback = (visible.find(model => model.isDefault) ?? visible[0])?.id
  if (!sameAgent) return { model: fallback }
  if (current && visible.some(model => model.id === current)) return { model: current }
  if (!current) return { model: fallback }
  return { model: fallback, ...(fallback ? { note: `${current} is not on this account; using ${fallback}` } : {}) }
}

/** What a meter says about the stuck account, read fresh after the failure. */
export interface MeterReading {
  /** A limit is reported reached. */
  readonly reached: boolean
  /** The account-wide binding lane is spent (`isBlocked`). */
  readonly blocked: boolean
}

/**
 * Whether a failed turn is a usage limit, and of which kind — by the adapters'
 * own codes and the meter, never by the error's words.
 *
 * - `retrying`: the backend is handling it; nothing.
 * - `credits`: exhausted.
 * - `rateLimit`: exhausted when the meter says reached or blocked; otherwise a
 *   throttle, which backs off on the same account before it becomes a limit.
 * - no code: a limit only when a fresh meter reads blocked.
 */
export const limitCauseOf = (
  error: { readonly code?: string; readonly retrying?: boolean } | null | undefined,
  meter: MeterReading | null,
): CarryOnCause | 'throttle' | null => {
  if (!error || error.retrying) return null
  if (error.code === 'credits') return 'credits'
  if (error.code === 'rateLimit') return meter && (meter.reached || meter.blocked) ? 'rateLimit' : 'throttle'
  if (error.code === undefined || error.code === null || error.code === '' || error.code === 'unknown') return meter?.blocked ? 'blocked' : null
  return null
}
