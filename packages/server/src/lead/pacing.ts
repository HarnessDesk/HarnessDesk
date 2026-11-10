import { bindingLane, isBlocked, pacedOrder, paceRankOf, remainingOf, type UsageReport } from '@harnessdesk/protocol'
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
 * `defaultRuntime` is the desk's default, and the pool read is the one of its agent. The label follows `usage_summary`'s (name, plan, account
 * ordinal when the agent has several), so the Lead can say which account in the words it was already given.
 */
export const choosePacedAccount = (input: {
  readonly startable: readonly PacingRuntime[]
  /** The runtime a start without a named agent lands on today. */
  readonly defaultRuntime: string | null
  readonly pools: unknown
  readonly reportOf: (runtime: string) => UsageReport | null
  readonly now: number
}): { readonly agent: string; readonly label: string } | null => {
  const { startable, now } = input
  // The default is named, never guessed from the list: a default that cannot start leaves nothing to pace.
  const fallback = startable.find(one => one.id === input.defaultRuntime)
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
  // A reading that is stale, failed or past its reset proves nothing, so `pacedOrder` keeps such an account in play;
  // only a fresh, still-standing "out" is dropped here.
  const chosen = pacedOrder(ordered, reportsFor, now).find(one => {
    const report = input.reportOf(one.id)
    return !report || !isBlocked(report) || paceRankOf([report], now).tier !== 3
  })
  if (!chosen) return null
  const report = input.reportOf(chosen.id)
  const plan = report ? report.planLabel ?? report.plan : null
  return { agent: chosen.id, label: `${scrub(chosen.name, 80)}${plan ? ` · ${scrub(plan, 40)}` : ''} · account ${siblings.indexOf(chosen) + 1}` }
}

/** What the host knows, read at the moment of a start. The host wires these; nothing here reaches into it. */
export interface PacingSources {
  readonly startableAgents: () => readonly string[]
  readonly infoOf: (runtime: string) => { readonly slot?: { readonly agent?: string } | null; readonly presentation: { readonly name: string } } | undefined
  readonly defaultRuntime: () => string | null
  readonly preferences: () => Readonly<Record<string, unknown>>
  readonly usage: (runtime: string) => UsageReport | null
  readonly now: () => number
}

/** How much of its window an account has left, 0 to 100: 0 when it is blocked, null when its reading says nothing. */
export const headroomOf = (report: UsageReport | null): number | null => {
  if (!report || report.error) return null
  if (isBlocked(report)) return 0
  const lane = bindingLane(report.lanes)
  return lane ? remainingOf(lane) : null
}

/** The port `LeadChats` asks: the pool of the default runtime's agent, read from preferences, over what can start. */
export interface PacingPort {
  readonly choose: () => Promise<{ readonly agent: string; readonly label: string } | null>
  /** What is left of the window on the account a start without a named agent would land on; null when nobody can say. */
  readonly headroom: () => Promise<number | null>
}
export const pacingPort = (sources: PacingSources): PacingPort => {
  const input = () => ({
    startable: sources.startableAgents().flatMap(id => {
      const info = sources.infoOf(id); if (!info) return []
      return [{ id, agent: String(info.slot?.agent ?? id), name: info.presentation.name }]
    }),
    defaultRuntime: sources.defaultRuntime(),
    pools: sources.preferences()['accountPools'],
    reportOf: sources.usage,
    now: sources.now(),
  })
  return {
    choose: async () => choosePacedAccount(input()),
    headroom: async () => {
      const ask = input(), chosen = choosePacedAccount(ask)
      const runtime = chosen?.agent ?? ask.defaultRuntime
      return runtime ? headroomOf(sources.usage(runtime)) : null
    },
  }
}
