import { isBlocked, pacedOrder, type UsageReport } from '@harnessdesk/protocol'
import { scrub } from '../phone-redact.js'

export interface PacingRuntime {
  readonly id: string
  /** The agent this account belongs to (`slot.agent`, else its own id). */
  readonly agent: string
  /** The presentation name, the only name the Lead sees. */
  readonly name: string
}

/**
 * Which of an agent's accounts a Lead chat starts on, when the person turned on "Prefer the account that resets
 * soonest" for it. That setting is the person allowing account choice: with it off, or with one account only, this
 * answers null and the desk starts on its default as before. Reads cached usage; never refreshes a vendor.
 *
 * The first entry of `startable` is the desk's default. The label follows `usage_summary`'s (name, plan, account
 * ordinal when the agent has several), so the Lead can say which account in the words it was already given.
 */
export const choosePacedAccount = (input: {
  readonly startable: readonly PacingRuntime[]
  readonly pools: unknown
  readonly reportOf: (runtime: string) => UsageReport | null
  readonly now: number
}): { readonly agent: string; readonly label: string } | null => {
  const { startable, now } = input
  const fallback = startable[0]
  if (!fallback) return null
  const pool = (input.pools && typeof input.pools === 'object' && !Array.isArray(input.pools)
    ? (input.pools as Record<string, unknown>)[fallback.agent] : undefined) as { pace?: unknown; order?: unknown } | undefined
  if (pool?.pace !== 'soonest') return null
  const siblings = startable.filter(one => one.agent === fallback.agent)
  if (siblings.length < 2) return null
  const own = Array.isArray(pool.order) ? pool.order.filter((id): id is string => typeof id === 'string') : []
  const rank = (one: PacingRuntime): number => { const at = own.indexOf(one.id); return at === -1 ? own.length + siblings.indexOf(one) : at }
  const ordered = [...siblings].sort((a, b) => rank(a) - rank(b))
  const reportsFor = (id: string): readonly UsageReport[] => { const report = input.reportOf(id); return report ? [report] : [] }
  const chosen = pacedOrder(ordered, reportsFor, now).find(one => { const report = input.reportOf(one.id); return !report || !isBlocked(report) })
  if (!chosen) return null
  const report = input.reportOf(chosen.id)
  const plan = report ? report.planLabel ?? report.plan : null
  return { agent: chosen.id, label: `${scrub(chosen.name, 80)}${plan ? ` · ${scrub(plan, 40)}` : ''} · account ${siblings.indexOf(chosen) + 1}` }
}
