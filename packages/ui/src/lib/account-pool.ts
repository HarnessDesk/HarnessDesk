import {
  DEFAULT_CARRY_ON,
  pacedOrder,
  whenOutForChoice,
  WHEN_OUT,
  WHEN_OUT_LABEL,
  type CarryOnPolicy,
  type RuntimeId,
  type RuntimeInfo,
  type UsageReport,
  type WhenOut,
} from '@harnessdesk/protocol'

import { isBlocked } from './usage'

/**
 * The order an agent's accounts are used in, and what happens when one of
 * them is out of quota.
 *
 * An agent with several accounts used to have exactly one answer: the banner
 * over the conversation offered the roomiest agent of any kind, and nothing
 * remembered which of your own accounts should be next. The pool is that
 * memory. It is per agent (`agentKey`), and it names runtimes because every
 * extra account is a runtime of its own.
 *
 * `whenOut` is the agent's own answer to the desk's carry-on rule
 * (`carryOn` in the host's preferences, Settings › Approvals): it applies to a
 * conversation that is running as well as to the pick for new sessions, and
 * absent means "follow the desk". The vocabulary is the protocol's, so the
 * host reads the same words:
 *
 * - `next`: carry on on the next account in the order that still has room,
 *   and say so.
 * - `ask`: say that it is out and ask what to do.
 * - `wait`: retry once when the account resets; with no reset known, stop.
 * - `stop`: say that it is out and do nothing more.
 *
 * `pace: 'soonest'` replaces the person's own order with the one the usage
 * reports give: the account whose window refills soonest, and still has room,
 * goes first, so allowance about to expire is spent before the one that keeps.
 * The person's order stays stored and comes back when the setting is cleared.
 */
export { WHEN_OUT, WHEN_OUT_LABEL, type WhenOut }

export interface AccountPool {
  /** Runtime ids, first used first. Siblings it does not name follow, in the catalogue's order. */
  readonly order?: readonly RuntimeId[]
  /** The agent's own rule; absent follows the desk's. */
  readonly whenOut?: WhenOut
  readonly pace?: 'soonest'
}

/** Keyed by `agentKey`. */
export type AccountPoolMap = Readonly<Record<string, AccountPool>>

/** The rule in force for one agent: its own, or the desk's in the agent's spelling. */
export const whenOutOf = (pool: AccountPool | undefined, desk: CarryOnPolicy = DEFAULT_CARRY_ON): WhenOut =>
  pool?.whenOut ?? whenOutForChoice(desk.onLimit)

/** What the host kept, with anything it cannot be dropped rather than trusted. */
export const readAccountPools = (raw: unknown): AccountPoolMap => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const pools: Record<string, AccountPool> = {}
  for (const [agent, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const { order, whenOut, pace } = value as { order?: unknown; whenOut?: unknown; pace?: unknown }
    const ids = Array.isArray(order) ? order.filter((id): id is RuntimeId => typeof id === 'string') : []
    const rule = WHEN_OUT.find((entry) => entry === whenOut)
    const paced = pace === 'soonest'
    if (ids.length === 0 && !rule && !paced) continue
    pools[agent] = { ...(ids.length > 0 ? { order: ids } : {}), ...(rule ? { whenOut: rule } : {}), ...(paced ? { pace: 'soonest' as const } : {}) }
  }
  return pools
}

/**
 * An agent's accounts in the order they are used. The catalogue's order is
 * the fallback for any account the pool has not heard of — one added since —
 * so a new account lands last rather than jumping the queue.
 */
export const inPoolOrder = <T extends { readonly id: RuntimeId }>(
  siblings: readonly T[],
  pool: AccountPool | undefined,
  pacing?: Pacing,
): T[] => {
  const order = pool?.order ?? []
  const rank = (entry: T): number => {
    const at = order.indexOf(entry.id)
    return at === -1 ? order.length + siblings.indexOf(entry) : at
  }
  const own = [...siblings].sort((a, b) => rank(a) - rank(b))
  // Ties and unknowns inside the paced order keep the person's own.
  return pool?.pace === 'soonest' && pacing
    ? pacedOrder(own, (id) => pacing.reports.filter((report) => report.runtime === id), pacing.now)
    : own
}

/** What the soonest-reset order reads: the usage reports the desk holds, and the clock. */
export interface Pacing {
  readonly reports: readonly UsageReport[]
  readonly now: number
}

/** Whether the person's own order is in force, so its moves mean something. */
export const isPaced = (pool: AccountPool | undefined): boolean => pool?.pace === 'soonest'

/** The order with one account moved by `delta` places, clamped at the ends. */
export const movedInPool = (ordered: readonly RuntimeId[], runtime: RuntimeId, delta: number): RuntimeId[] => {
  const from = ordered.indexOf(runtime)
  if (from === -1) return [...ordered]
  const to = Math.max(0, Math.min(ordered.length - 1, from + delta))
  const next = ordered.filter((id) => id !== runtime)
  next.splice(to, 0, runtime)
  return next
}

/**
 * Whether a runtime is out: every report it has is spent. One with no report
 * at all is not out — it may simply not be metered — and one with a spent
 * account beside a usable one still has somewhere to run.
 */
export const runtimeOut = (runtime: RuntimeId, reports: readonly UsageReport[]): boolean => {
  const own = reports.filter((report) => report.runtime === runtime)
  return own.length > 0 && own.every(isBlocked)
}

/**
 * Whether an account could take a session at all, quota aside: started, and
 * signed in, a gateway, which brings its own key and so has no vendor account
 * to show, or an agent that has no accounts at all. The pool moves to, and the banner offers, only
 * these — a signed-out sibling is not somewhere to go, and nor is one still
 * starting, which may yet fail; its ready or idle health brings the pool back
 * to it.
 */
export const canTakeTurn = (
  entry: RuntimeInfo,
  view: {
    readonly healthByRuntime: Readonly<Record<string, { readonly state: string } | null | undefined>>
    readonly accountsByRuntime: Readonly<Record<string, { readonly accounts: readonly unknown[] } | null | undefined>>
  },
): boolean =>
  view.healthByRuntime[entry.id]?.state !== 'unavailable' &&
  view.healthByRuntime[entry.id]?.state !== 'starting' &&
  // An agent with no account surface runs without one, as `readinessOf` says.
  (!entry.capabilities.account || Boolean(entry.slot?.gateway) || (view.accountsByRuntime[entry.id]?.accounts.length ?? 0) > 0)

/**
 * Where "use this agent" puts new sessions: the first account in the pool's
 * order that could take a turn and is not out — the order the Accounts list
 * shows — else the first in that order, else `fallback`.
 */
export const firstInPool = (
  ordered: readonly RuntimeInfo[],
  view: Parameters<typeof canTakeTurn>[1] & { readonly usage: readonly UsageReport[] },
  fallback: RuntimeId,
): RuntimeId =>
  (ordered.find((entry) => canTakeTurn(entry, view) && !runtimeOut(entry.id, view.usage)) ?? ordered[0])?.id ?? fallback

/**
 * The account after `from` in the pool that could take a session now:
 * signed in, started, and not out. Wraps around, so the first account comes
 * back once a later one runs out in its turn.
 */
export const nextInPool = (
  ordered: readonly RuntimeInfo[],
  from: RuntimeId,
  usable: (runtime: RuntimeId) => boolean,
): RuntimeInfo | null => {
  const at = ordered.findIndex((entry) => entry.id === from)
  if (at === -1) return null
  for (let step = 1; step < ordered.length; step += 1) {
    const candidate = ordered[(at + step) % ordered.length]!
    if (usable(candidate.id)) return candidate
  }
  return null
}
