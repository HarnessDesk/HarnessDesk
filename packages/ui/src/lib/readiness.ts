import type { AccountStatus, RuntimeHealth } from '@harnessdesk/protocol'
import type { UsageReport } from '@harnessdesk/protocol'

import { isBlocked, workingAccount } from './usage'

/**
 * One readiness vocabulary, carried by every surface.
 *
 * Before this, each surface answered a different question about the same
 * agent: settings said who you were signed in as, the dashboard said what you
 * had spent, the header said what was left — and none of them said whether a
 * turn sent right now would start. These six states say exactly that, and
 * they are the only states any surface may draw.
 *
 * `unknown` is not a guess at any of the other five: an agent that has not
 * yet answered who is signed in — still loading, or a read that failed and
 * left no account behind — is not the same fact as one that answered "nobody
 * is signed in", and drawing it as `signin` before this claimed a sign-in was
 * needed for however long the read took. A surface draws `unknown` neutrally,
 * with no claim about sign-in one way or the other.
 *
 * The order below is the order of urgency, and `worst` relies on it: an agent
 * that is both signed in and out of credit is out of credit. `unknown` sits
 * last — the state that asserts nothing outranks nothing.
 */
export type Readiness = 'ready' | 'signin' | 'limit' | 'broken' | 'available' | 'unknown'

/** Rank for `worst`: a smaller number outranks a larger one. */
const RANK: Readonly<Record<Readiness, number>> = {
  broken: 0,
  signin: 1,
  limit: 2,
  available: 3,
  ready: 4,
  unknown: 5,
}

/** What each state is called, everywhere it is named rather than drawn. */
export const READINESS_LABEL: Readonly<Record<Readiness, string>> = {
  ready: 'Ready',
  signin: 'Needs sign-in',
  limit: 'Limit reached',
  broken: 'Unavailable',
  available: 'Not added',
  unknown: 'Not answered yet',
}

/**
 * The one thing to do about it, in the imperative. Empty for `ready`, which is
 * the state that asks nothing of anyone — and for `unknown`, which has
 * nothing to ask until it becomes one of the other five.
 */
export const READINESS_ACTION: Readonly<Record<Readiness, string>> = {
  ready: '',
  signin: 'Sign in',
  limit: 'Wait, or use another agent',
  broken: 'Fix, with the command',
  available: 'Add',
  unknown: '',
}

export interface ReadinessInput {
  /** Absent when the agent is in the registry but not registered here. */
  readonly registered: boolean
  readonly health: RuntimeHealth | null | undefined
  readonly account: AccountStatus | null | undefined
  /**
   * Whether the agent does accounts through HarnessDesk at all —
   * `capabilities.account`. `false` means a sign-in is never the answer: the
   * agent keeps its own credential where the desk cannot see it, so an empty
   * account list is "not ours to know", not "nobody has signed in". Absent
   * means yes, which is what every caller assumed before the flag existed.
   *
   * Before this, the first-run screen answered the question for itself and
   * the seat, the header strip, the menu bar and the dashboard did not, so
   * one agent (Cline, which declares no account) read "Needs sign-in" in the
   * seat while the screen beside it offered "Use this agent".
   */
  readonly accounts?: boolean
  /**
   * Every usage report for this agent — one per account. Which of them
   * decides is `workingAccount`'s question, not the caller's.
   */
  readonly usage?: readonly UsageReport[]
}

/**
 * Whether a turn sent to this agent right now would start.
 *
 * The order of the checks is the order of what stops a session: an agent the
 * host cannot launch is broken whatever its credential says, an agent with no
 * credential cannot sign a request, and a spent plan window is the last thing
 * between a request and a reply. Nothing here is inferred from a failed
 * request — `limit` is the agent's own report, because a 429 from a proxy is
 * not the same fact as a plan window that is over.
 *
 * The credential check itself has two outcomes, not one: `input.account` null
 * or undefined is *no answer yet* — `unknown` — while an account that has
 * answered with an empty list is the answer "nobody is signed in" —
 * `signin`. Both used to read the same, because a caller who had not heard
 * back yet passed the same `null` a definite empty answer would, and every
 * surface guessed `signin` for as long as the read took (or forever, if it
 * had failed silently).
 *
 * `limit` is an *account-wide* fact, so it is `isBlocked` that decides it and
 * never `reached` on its own: a spent model-scoped window is a limit you can
 * step around, and an agent whose Fable weekly is empty still answers on every
 * other model. And it is asked of the account that would run the turn, because
 * signed in to two, either one will do it.
 */
export const readinessOf = (input: ReadinessInput): Readiness => {
  if (!input.registered) return 'available'
  if (input.health?.state === 'unavailable') return 'broken'
  if (input.accounts !== false) {
    if (!input.account) return 'unknown'
    if (input.account.accounts.length === 0) return 'signin'
  }
  const decided = workingAccount(input.usage ?? [])
  if (decided !== null && isBlocked(decided)) return 'limit'
  return 'ready'
}

/**
 * The most urgent of several — what a summary row for a whole agent shows.
 *
 * Seeded from the first state, not from `'ready'`: `unknown` outranks
 * nothing, including the seed, so seeding from `'ready'` turned a lone
 * `unknown` into `'ready'` — the one state `unknown` promises never to
 * assert. An empty list still answers `'ready'`, as it always has: nothing
 * to report is nothing standing in the way.
 */
export const worstReadiness = (states: readonly Readiness[]): Readiness => {
  if (states.length === 0) return 'ready'
  let worst: Readiness = states[0]!
  for (const state of states) if (RANK[state] < RANK[worst]) worst = state
  return worst
}

/**
 * Whether this state should pull the eye. `available` is a fact about the
 * registry rather than a problem with your setup, so it stays quiet —
 * and `unknown` has not said there is a problem at all.
 */
export const isBlocking = (state: Readiness): boolean =>
  state === 'signin' || state === 'limit' || state === 'broken'
