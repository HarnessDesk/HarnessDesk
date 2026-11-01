import type { RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { isBlocked } from './usage'

/**
 * The order an agent's accounts are used in, and what happens when the one
 * new sessions run as is out of quota.
 *
 * An agent with several accounts used to have exactly one answer: the banner
 * over the conversation offered the roomiest agent of any kind, and nothing
 * remembered which of your own accounts should be next. The pool is that
 * memory. It is per agent (`agentKey`), it names runtimes because every extra
 * account is a runtime of its own, and it only ever moves *new* sessions —
 * a conversation already running stays on the account it started with,
 * because its thread lives in that account's history.
 *
 * - `next`: move new sessions to the next account in the order that still has
 *   room, and say so once.
 * - `ask`: say that it is out and offer the next account (the default, and
 *   what the desk did before there was an order).
 * - `stop`: say that it is out and offer nothing.
 */
export type WhenOut = 'next' | 'ask' | 'stop'

export interface AccountPool {
  /** Runtime ids, first used first. Siblings it does not name follow, in the catalogue's order. */
  readonly order?: readonly RuntimeId[]
  readonly whenOut?: WhenOut
}

/** Keyed by `agentKey`. */
export type AccountPoolMap = Readonly<Record<string, AccountPool>>

export const WHEN_OUT: readonly WhenOut[] = ['next', 'ask', 'stop']

export const WHEN_OUT_LABEL: Readonly<Record<WhenOut, string>> = {
  next: 'Use the next account',
  ask: 'Ask me',
  stop: 'Stop',
}

export const whenOutOf = (pool: AccountPool | undefined): WhenOut => pool?.whenOut ?? 'ask'

/** What the host kept, with anything it cannot be dropped rather than trusted. */
export const readAccountPools = (raw: unknown): AccountPoolMap => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const pools: Record<string, AccountPool> = {}
  for (const [agent, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const { order, whenOut } = value as { order?: unknown; whenOut?: unknown }
    const ids = Array.isArray(order) ? order.filter((id): id is RuntimeId => typeof id === 'string') : []
    const rule = WHEN_OUT.find((entry) => entry === whenOut)
    if (ids.length === 0 && !rule) continue
    pools[agent] = { ...(ids.length > 0 ? { order: ids } : {}), ...(rule ? { whenOut: rule } : {}) }
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
): T[] => {
  const order = pool?.order ?? []
  const rank = (entry: T): number => {
    const at = order.indexOf(entry.id)
    return at === -1 ? order.length + siblings.indexOf(entry) : at
  }
  return [...siblings].sort((a, b) => rank(a) - rank(b))
}

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
 * either signed in or a gateway, which brings its own key and so has no
 * vendor account to show. The pool moves to, and the banner offers, only
 * these — a signed-out sibling is not somewhere to go.
 */
export const canTakeTurn = (
  entry: RuntimeInfo,
  view: {
    readonly healthByRuntime: Readonly<Record<string, { readonly state: string } | null | undefined>>
    readonly accountsByRuntime: Readonly<Record<string, { readonly accounts: readonly unknown[] } | null | undefined>>
  },
): boolean =>
  view.healthByRuntime[entry.id]?.state !== 'unavailable' &&
  (Boolean(entry.slot?.gateway) || (view.accountsByRuntime[entry.id]?.accounts.length ?? 0) > 0)

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
