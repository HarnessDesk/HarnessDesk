/** Fictional busy-desk readings. No account or usage is copied from a live desk. */
import { runtimeId, type LedgerDay, type LedgerHour, type LedgerQuery, type LedgerReport, type LedgerRow, type RuntimeInfo, type UsageLane, type UsageReport } from '@harnessdesk/protocol'
import { addDays, localMidnight } from '../src/lib/heat'

export const SCENE_NOW = new Date('2026-10-08T13:30:00').getTime()
const DAY = 86_400_000
const presentations = [
  { id: 'claude', name: 'Claude Code', brand: 'claudecode' },
  { id: 'cursor', name: 'Cursor', brand: 'cursor' },
  { id: 'codex', name: 'Codex', brand: 'codex' },
  { id: 'gemini', name: 'Gemini CLI', brand: 'geminicli' },
  { id: 'cline', name: 'Cline', brand: 'cline' },
  { id: 'opencode', name: 'OpenCode', brand: 'opencode' },
  { id: 'antigravity', name: 'Antigravity CLI', brand: 'antigravity' },
  { id: 'deepseek', name: 'DeepSeek', brand: 'deepseek' },
] as const

export const sceneRuntimes = (template: RuntimeInfo): RuntimeInfo[] => presentations.map(({ id, name, brand }) => ({
  ...template, id: runtimeId(id), name, presentation: { ...template.presentation, name, brand },
}))

const lane = (id: string, label: string, usedPercent: number, windowMinutes: number | null, resetsAt: number): UsageLane =>
  ({ id, label, usedPercent, windowMinutes, resetsAt })
const reading = (runtime: string, account: string | null, plan: string | null, now: number): UsageReport => ({
  runtime: runtimeId(runtime), account, plan, lanes: [], credits: null, spend: null, reached: null,
  source: { kind: 'runtime', label: 'from its own API' }, fetchedAt: now - 60_000, staleAfterMs: 600_000, error: null,
})
export const sceneUsage = (now: number): UsageReport[] => [
  { ...reading('codex', 'shane@harnessdesk.app', 'Pro', now),
    lanes: [lane('weekly', 'Weekly', 78, 10_080, now + 5 * DAY)],
    spend: { currency: 'USD', todayCost: 16.8, todayTokens: 14_500_000, windowCost: 3148, windowTokens: 2_930_000_000, windowDays: 30, provenance: 'listPrice', coverage: null },
    billing: { kinds: ['windows'], fee: { amount: 200, currency: 'USD', period: 'month', source: 'user' } } },
  { ...reading('cursor', 'olivia@harnessdesk.app', 'Pro', now),
    lanes: [lane('plan', 'Plan', 36, null, now + 25 * DAY)],
    billing: { kinds: ['allowance'] } },
  { ...reading('codex', 'review@example.com', 'Pro', now),
    lanes: [lane('session', '5-hour', 7, 300, now + 135 * 60_000)], billing: { kinds: ['windows'] } },
  { ...reading('claude', 'studio@example.com', 'Max', now),
    lanes: [lane('session', 'Session', 12, 300, now + 4 * 60 * 60_000)], billing: { kinds: ['windows'] } },
  { ...reading('antigravity', null, 'Pro', now),
    lanes: [lane('weekly', 'Weekly Gemini models', 0, 10_080, now + 6 * DAY)], billing: { kinds: ['windows'] } },
  { ...reading('deepseek', 'api@example.com', null, now), credits: { remaining: 2.47, unit: 'USD' }, billing: { kinds: ['balance'] } },
]

const modelGroups = [
  { key: 'claude-opus-5', runtime: 'claude', share: 0.270 },
  { key: 'claude-opus-5-5', runtime: 'claude', share: 0.232 },
  { key: 'claude-sonnet-5', runtime: 'claude', share: 0.157 },
  { key: 'gpt-5.3-codex-xhigh', runtime: 'codex', share: 0.052 },
  { key: 'claude-sonnet-5-5', runtime: 'claude', share: 0.054 },
  { key: 'gpt-5.6-sol', runtime: 'codex', share: 0.046 },
  ...Array.from({ length: 34 }, (_, index) => ({ key: `demo-model-${index + 1}`, runtime: ['cursor', 'gemini', 'cline', 'opencode', 'claude', 'codex'][index % 6]!,
    share: 0.189 * [0.64, 0.16, 0.08, 0.04, 0.04, 0.04][index % 6]! / (index % 6 < 4 ? 6 : 5) })),
]
const projects = [
  { key: 'storefront', share: 0.41 }, { key: 'harnessdesk', share: 0.26 },
  { key: 'docs-site', share: 0.16 }, { key: 'mobile', share: 0.1 }, { key: 'api', share: 0.07 },
]
const runtimeShares = presentations.slice(0, 6).map(info => ({ ...info,
  share: modelGroups.filter(model => model.runtime === info.id).reduce((sum, model) => sum + model.share, 0),
}))
const sum = (numbers: readonly number[]) => numbers.reduce((total, value) => total + value, 0)
const scaled = (numbers: readonly number[], total: number) => numbers.map(value => value / sum(numbers) * total)
// Irregular workdays, quiet days and spikes; no weekend rule.
const completedWeek = 6_925.4
const earlierWeek = completedWeek / 1.134
const currentCosts = [
  ...scaled([410, 890, 1750, 36, 680, 1300, 370, 1940, 3080, 530, 80, 1470, 800, 640, 1630], 27_418 - completedWeek - earlierWeek - 138.4),
  ...scaled([45, 900, 1350, 210, 1690, 75, 1220], earlierWeek),
  845, 3050, 690, 1170, 515, 348, 307.4, 138.4,
]
const previousCosts = [
  ...scaled([2500, 60, 920, 1400, 640, 1450, 85, 490, 1780, 400, 40, 2300, 720, 1600, 400, 3100, 350, 40, 900, 1150, 680, 1380, 55], 27_418 / 1.052 - 6_925.4 / 1.134),
  ...scaled([440, 1550, 40, 3210, 220, 130, 820], 6_925.4 / 1.134),
]

/** One compact source year; every pivot and hour grid aggregates these same days. */
const history = (() => {
  const today = localMidnight(SCENE_NOW)
  const entries = Array.from({ length: 365 }, (_, index) => {
    const day = addDays(today, index - 364)
    // A quiet day every 29 days rotates through the weekdays instead of
    // aliasing with the seven-row calendar. The last 61 days stay active.
    const active = index >= 304 || index % 29 !== 13
    const weekend = [0, 6].includes(new Date(day).getDay())
    const weight = active ? (0.8 + index / 230) * (0.7 + ((index * 29) % 37) / 37) * (weekend ? 0.65 : 1) : 0
    const peak = new Date(day).getMonth() === 8 && new Date(day).getDate() === 20
    const cost = index >= 335 ? currentCosts[index - 335]! : index >= 305 ? previousCosts[index - 305]!
      : active ? weight * (110 + ((index * 31) % 330)) : 0
    return { day, cost, weight, peak }
  })
  const normalWeight = sum(entries.filter(entry => !entry.peak).map(entry => entry.weight))
  return entries.map(entry => ({ ...entry, tokens: entry.peak ? 10_300_000_000 : entry.weight / normalWeight * 131_300_000_000 }))
})()

const sourceLedgers = new Map<string, LedgerReport>()
export const siteSceneLedger = (days: number, groupBy: LedgerQuery['groupBy']): LedgerReport => {
  const key = `${days}:${groupBy}`
  const cached = sourceLedgers.get(key)
  if (cached) return cached
  const selected = history.slice(-days)
  const totalCost = sum(selected.map(day => day.cost))
  const totalTokens = sum(selected.map(day => day.tokens))
  const daily: LedgerDay[] = selected.flatMap(day => runtimeShares.map(info => {
    const tokens = day.tokens * info.share
    const requests = Math.round(tokens / 75_000)
    return { day: day.day, runtime: runtimeId(info.id), cost: day.cost * info.share, tokens,
      input: tokens * 0.2, output: tokens * 0.15, cacheRead: tokens * 0.6, cacheWrite: tokens * 0.05, requests, turns: Math.round(requests / 6) }
  }))
  const hourWeights = [3, 2, 1, 1, 1, 2, 4, 7, 12, 16, 21, 24, 18, 23, 27, 26, 20, 15, 12, 10, 8, 7, 5, 4]
  const hourly: LedgerHour[] = runtimeShares.flatMap(info => Array.from({ length: 168 }, (_, index) => {
    const weekday = Math.floor(index / 24), hour = index % 24
    const entries = daily.filter(day => day.runtime === info.id && new Date(day.day).getDay() === weekday)
    const weight = hourWeights[hour]! / sum(hourWeights)
    return { runtime: runtimeId(info.id), weekday, hour, tokens: sum(entries.map(day => day.tokens)) * weight, requests: Math.round(sum(entries.map(day => day.requests!)) * weight) }
  }))
  const rows: LedgerRow[] = groupBy === 'runtime' ? runtimeShares.map(info => ({ key: info.id, label: info.name, runtime: runtimeId(info.id), cost: totalCost * info.share, tokens: totalTokens * info.share, hasUnpriced: false }))
    : (groupBy === 'model' ? modelGroups : projects).map(group => ({ key: group.key, label: group.key,
      runtime: 'runtime' in group && typeof group.runtime === 'string' ? runtimeId(group.runtime) : null, cost: totalCost * group.share, tokens: totalTokens * group.share, hasUnpriced: false }))
  const report: LedgerReport = { days, currency: 'USD', provenance: 'mixed', daily, hourly, rows, totalCost, totalTokens, scannedAt: SCENE_NOW - 120_000,
    coverage: { priced: sum(daily.map(day => day.requests!)), unpriced: 0, unmetered: 0, estimated: 0,
      daysCovered: selected.length, daysRequested: days, earliestDay: selected[0]!.day,
      turnsKnownFor: runtimeShares.map(info => runtimeId(info.id)), hoursKnownFor: runtimeShares.map(info => runtimeId(info.id)) },
    totals: { input: totalTokens * 0.2, output: totalTokens * 0.15, cacheRead: totalTokens * 0.6, cacheWrite: totalTokens * 0.05,
      reasoning: 0, requests: sum(daily.map(day => day.requests!)), turns: sum(daily.map(day => day.turns!)) },
  }
  sourceLedgers.set(key, report)
  return report
}
