/**
 * A dashboard worth photographing.
 *
 * Usage is the one thing on the desk with no disk to seed. Every other surface
 * reads something real — conversations come from the agents' own stores, the
 * graph from real git objects, the workspace list from `state.json` — but a
 * usage report is assembled by the host from each vendor's cache, and twelve
 * invented vendors have none.
 *
 * So the rig stubs one method. `store.transport` is a public field, so
 * `usage/reports` can be answered from here and `loadUsage()` called for real;
 * nothing in the app is modified, and the renderer draws these the way it
 * draws any others. That is the whole of the "hardcoding" — a fixture handed
 * to the app from outside, not a branch inside it.
 *
 * The set is chosen so every state the dashboard can draw is on one page:
 * an account being outrun, one conserving, a model-scoped lane spent behind a
 * healthy account, a lane whose usage is unknown rather than zero, a balance
 * with no window at all, and one plain error. A dashboard of six identical
 * healthy bars photographs as a mock-up.
 */
import { CAST, rigRuntimeId } from './cast.mjs'

const MINUTE = 60_000
const ago = (minutes) => Date.now() - minutes * MINUTE
const soon = (minutes) => Date.now() + minutes * MINUTE

const lane = (id, label, usedPercent, windowMinutes, resetsInMinutes, extra = {}) => ({
  id,
  label,
  usedPercent,
  windowMinutes,
  resetsAt: soon(resetsInMinutes),
  ...extra,
})

const day = (n, cost, tokens) => ({ day: Date.now() - n * 24 * 60 * MINUTE, cost, tokens })

const accountActivityDays = () => Array.from({ length: 30 }, (_, index) => {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - (29 - index))
  return { day: date.getTime(), tokens: 70_000 + index * 2_500 }
})

/** A week of spend that rises toward today, so the sparkline has a shape. */
const week = (peak) =>
  [6, 5, 4, 3, 2, 1, 0].map((n, i) => day(n, Number((peak * (0.35 + i * 0.11)).toFixed(2)), Math.round(peak * (0.35 + i * 0.11) * 41_000)))

/**
 * Five agents, five distinct sign-ins, every one of them reporting.
 *
 * The dashboard's whole point is a full page, not a catalogue of edge cases:
 * every account signed in, every card current, a healthy mix of what is left
 * (mostly comfortable, one — Gemini — genuinely low, never zero), and no
 * "signed out" or "not reporting" card sitting in the middle of it looking
 * broken. Distinct placeholder identities (`docs/decisions.md`-adjacent
 * `AGENTS.md` rule 13: `example.com`/`acme.dev` addresses, never a repeated
 * `dev@example.com` standing in for four different people).
 */
export const REPORTS = [
  {
    runtime: 'claude-code',
    account: 'jane@example.com',
    plan: 'Max 20x',
    // Embedded directly on the report rather than set through `usage/plan/set`:
    // the rig's `usage/reports` stub answers this fixed array on every ask, so
    // a fee that verb wrote to the real `plans.json` would never be merged
    // back into it the way the real host merges a stored fee into a vendor's
    // own report before answering — the Overview's "Paid" cell would keep
    // reading "—" forever no matter what was set.
    billing: { kinds: ['windows'], fee: { amount: 200, currency: 'USD', period: 'month', source: 'vendor' } },
    lanes: [
      // 35% left, more than half the 5-hour window already gone: comfortable
      // but behind pace, so this becomes a second "What is left" card without
      // reading as low (`toneForRemaining`'s own floor is 20%).
      lane('session', 'Session', 65, 300, 135),
      lane('weekly', 'Weekly', 62, 10_080, 3_400),
      lane('weekly:opus', 'Weekly', 55, 10_080, 3_400, { scope: 'Opus' }),
    ],
    credits: null,
    spend: {
      currency: 'USD',
      todayCost: 18.4,
      windowCost: 96.2,
      windowDays: 30,
      todayTokens: 742_000,
      windowTokens: 3_940_000,
      provenance: 'listPrice',
      coverage: { priced: 61, unpriced: 2, unmetered: 0, estimated: 4, daysCovered: 7, daysRequested: 7 },
      daily: week(18.4),
    },
    reached: null,
    source: { kind: 'file', label: "from Claude Code's own cache" },
    fetchedAt: ago(4),
    staleAfterMs: 600_000,
    error: null,
  },
  {
    runtime: 'codex',
    account: 'dev@acme.dev',
    plan: 'Team',
    billing: { kinds: ['windows'], fee: { amount: 60, currency: 'USD', period: 'month', source: 'vendor' } },
    // 40% left, behind pace on the 5-hour window: the third "What is left"
    // card, comfortable rather than low.
    lanes: [lane('session', '5-hour', 60, 300, 135), lane('weekly', 'Weekly', 41, 10_080, 5_020)],
    // The account service sees work across machines, so this 30-day total
    // exceeds the local transcript ledger's 1.71M-token window below.
    accountActivity: {
      days: accountActivityDays(),
      lifetimeTokens: 68_400_000,
      peakDailyTokens: 221_000,
      currentStreakDays: 12,
      longestStreakDays: 31,
    },
    credits: null,
    spend: {
      currency: 'USD',
      todayCost: 6.1,
      windowCost: 41.7,
      windowDays: 30,
      todayTokens: 268_000,
      windowTokens: 1_710_000,
      provenance: 'listPrice',
      coverage: { priced: 44, unpriced: 0, unmetered: 0, estimated: 1, daysCovered: 7, daysRequested: 7 },
      daily: week(6.1),
    },
    reached: null,
    source: { kind: 'runtime', label: 'from its own API' },
    fetchedAt: ago(1),
    staleAfterMs: 600_000,
    error: null,
  },
  {
    runtime: 'cursor',
    account: 'ops@example.com',
    plan: 'Pro',
    billing: { kinds: ['windows'], fee: { amount: 20, currency: 'USD', period: 'month', source: 'vendor' } },
    lanes: [lane('session', 'Session', 48, 300, 96), lane('weekly', 'Weekly', 57, 10_080, 4_200)],
    credits: { remaining: 118.4, used: 81.6, unit: 'USD' },
    spend: null,
    reached: null,
    source: { kind: 'api', label: 'from its dashboard API' },
    fetchedAt: ago(9),
    staleAfterMs: 900_000,
    error: null,
  },
  {
    // The one low card — comfortably above zero, never the headline.
    runtime: 'gemini-cli',
    account: 'sam@acme.dev',
    plan: 'Pro',
    billing: { kinds: ['windows'], fee: { amount: 20, currency: 'USD', period: 'month', source: 'vendor' } },
    lanes: [lane('daily', 'Daily', 82, 1_440, 380)],
    credits: null,
    spend: {
      currency: 'USD',
      todayCost: 3.2,
      windowCost: 19.8,
      windowDays: 30,
      todayTokens: 96_000,
      windowTokens: 612_000,
      provenance: 'listPrice',
      coverage: { priced: 12, unpriced: 0, unmetered: 0, estimated: 1, daysCovered: 7, daysRequested: 7 },
      daily: week(3.2),
    },
    reached: null,
    source: { kind: 'runtime', label: 'from its own API' },
    fetchedAt: ago(6),
    staleAfterMs: 600_000,
    error: null,
  },
  {
    runtime: 'copilot',
    account: 'priya@example.com',
    plan: 'Business',
    billing: { kinds: ['windows'], fee: { amount: 19, currency: 'USD', period: 'month', source: 'vendor' } },
    lanes: [lane('monthly', 'Monthly', 27, 43_200, 21_000)],
    credits: null,
    spend: {
      currency: 'USD',
      todayCost: 2.4,
      windowCost: 15.1,
      windowDays: 30,
      todayTokens: 71_000,
      windowTokens: 468_000,
      provenance: 'listPrice',
      coverage: { priced: 9, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 7, daysRequested: 7 },
      daily: week(2.4),
    },
    reached: null,
    source: { kind: 'runtime', label: 'from its own API' },
    fetchedAt: ago(11),
    staleAfterMs: 600_000,
    error: null,
  },
  {
    // Figures for another sign-in, kept for the `dashboard-antigravity`
    // scene: Antigravity's quota is read through the `agy` CLI, which signs
    // in apart from the ACP server the desk runs, so the host files it under
    // `unverified` and never in `lanes`: the card draws it under that
    // sign-in's name, while the chip, the rail row and every readiness
    // surface read the agent's own, empty, lanes (#769). The shape is the one
    // measured on agy 1.2.6 — a weekly limit per group of models, the Gemini
    // one spent and the Claude and GPT one untouched, whose reset is no date
    // at all because an untouched window has not started. Not one of the
    // five cards `dashboard`'s own Overview leads with — this is a distinct,
    // deliberate state a separate scene exists to show.
    runtime: 'antigravity',
    account: 'Signed in',
    plan: null,
    // A fee, even though the plan itself is unverified: the Overview's Paid
    // total is prorated per account regardless of whether that account's own
    // lanes are known (`lib/paid.ts`), so a real desk with this account
    // signed in still has a fee on file for it — leaving this null is what
    // made the strip's "fee not set for N" caption count this row.
    billing: { kinds: ['windows'], fee: { amount: 20, currency: 'USD', period: 'month', source: 'vendor' } },
    lanes: [],
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'api', label: 'from the agy CLI' },
    fetchedAt: ago(3),
    staleAfterMs: 300_000,
    error: null,
    unverified: {
      whose: 'agy CLI sign-in',
      lanes: [
        lane('gemini-weekly', 'Weekly', 100, 10_080, 8_640, { scope: 'Gemini Models', usageKnown: true }),
        { ...lane('3p-weekly', 'Weekly', 0, 10_080, 0, { scope: 'Claude and GPT models', usageKnown: true }), resetsAt: null },
      ],
      reached: 'gemini-weekly',
      fetchedAt: ago(3),
      staleAfterMs: 300_000,
    },
  },
]

/** Only report on agents the desk actually has, so a rename cannot orphan a card. */
const known = new Set(CAST.map((one) => one.id))
export const USAGE = REPORTS.filter((one) => known.has(one.runtime)).map(one => ({ ...one, runtime: rigRuntimeId(one.runtime) }))

/**
 * The token ledger, fabricated — and this one is not optional.
 *
 * `usage/ledger` and `usage/scan` do not read HarnessDesk's home at all: they
 * scan each **agent's** own transcripts, under `~/.codex` and `~/.claude`, and
 * price them. Staging a HarnessDesk home does nothing to that, so a dashboard
 * photographed without this stub carries the real machine's real spend — the
 * first take of this scene showed "$806 spent in 30d, from its transcripts",
 * which was not invented. An earlier quarantined shot showed $21,313.
 *
 * A number leaks more quietly than a name: the username audit cannot see it,
 * and neither can a person glancing at the picture. So the ledger is answered
 * from here for every query, and the scan is reported already finished so that
 * nothing walks the real corpus while the camera is up.
 */
/*
 * A year of someone who runs several agents all day. A coding agent's turn
 * re-sends its whole context on every step, almost all of it from cache, so a
 * turn is ~150k tokens and a year of them is billions — the first rig's 87M
 * read as a light hobbyist's month, and its 9%-cached mix as no agent at all.
 */
const LEDGER_ROWS = [
  { key: 'claude-code', label: 'Claude', runtime: 'claude-code', tokens: 1_560_000_000, cost: 6_926.4, hasUnpriced: false, turns: 9_744 },
  { key: 'codex', label: 'Codex', runtime: 'codex', tokens: 677_000_000, cost: 3_002.4, hasUnpriced: false, turns: 4_272 },
  { key: 'cursor', label: 'Cursor', runtime: 'cursor', tokens: 325_000_000, cost: 1_324.8, hasUnpriced: false, turns: 2_280 },
  { key: 'gemini-cli', label: 'Gemini', runtime: 'gemini-cli', tokens: 162_000_000, cost: 0, hasUnpriced: true, turns: 1_056 },
  { key: 'copilot', label: 'Copilot', runtime: 'copilot', tokens: 121_000_000, cost: 555.6, hasUnpriced: false, turns: 812 },
  { key: 'amp', label: 'Amp', runtime: 'amp', tokens: 38_000_000, cost: 223.2, hasUnpriced: false, turns: 252 },
]

const TOTAL_COST = LEDGER_ROWS.reduce((sum, row) => sum + (row.cost ?? 0), 0)
const TOTAL_TOKENS = LEDGER_ROWS.reduce((sum, row) => sum + (row.tokens ?? 0), 0)
const TOTAL_TURNS = LEDGER_ROWS.reduce((sum, row) => sum + (row.turns ?? 0), 0)

/**
 * Six months of each agent's spend, keyed on local midnight as the Dashboard
 * buckets it (`stackDaily` matches `day` exactly). Each agent's days add up to
 * its row, so the chart's headline agrees with the strip's Value: a rig that
 * stamped `Date.now() - n days` matched no bucket and drew $0 beside $159.
 *
 * `DAYS` used to be 30, then 182 — the year heat grid (`buildYearGrid`,
 * `lib/heat.ts`) is 53 weeks (371 days) wide, and every day before the
 * ledger's earliest row draws hatched, not empty — an honest "before this
 * ledger started", but a grid mostly hatched reads as broken rather than as
 * a desk that has been in use a while. 365 days — a full year — fills the
 * whole grid (aside from the handful of leading days 371 - 365 leaves
 * hatched) with real variation.
 */
const midnight = (back) => {
  const at = new Date()
  at.setHours(0, 0, 0, 0)
  at.setDate(at.getDate() - back)
  return at.getTime()
}
const DAYS = 365
/**
 * A working year's shape: weekdays heavier than weekends (0.35×), a gentle
 * climb towards today — comfortably tens of a percent end to end, not the
 * multiples a steeper ramp produces once totalled over a year of days — and
 * a deterministic wobble on top of both — a sine keyed on the day index
 * rather than `Math.random()`, so the same run always produces the same
 * picture (every number here has to be reproducible; see `AGENTS.md`'s
 * testing conventions) while still keeping neighbouring days from reading as
 * a smooth, machine-drawn ramp.
 */
/*
 * And days off, because a year with none reads as generated: most weekends
 * empty, about one weekday in fourteen skipped, a quiet stretch over the new
 * year and a few days away in August. Drawn from a fixed-seed generator in
 * day order, so every take draws the same year; the last week is always
 * worked, so the Overview's 7- and 30-day figures stay steady.
 */
let seed = 0x2f6e2b1
const draw = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
const WEIGHTS = Array.from({ length: DAYS }, (_, i) => {
  const date = new Date(midnight(DAYS - 1 - i))
  const weekday = date.getDay()
  const weekend = weekday === 0 || weekday === 6
  const roll = draw()
  const holiday = (date.getMonth() === 11 && date.getDate() >= 23) || (date.getMonth() === 0 && date.getDate() <= 2) ||
    (date.getMonth() === 7 && date.getDate() >= 11 && date.getDate() <= 16)
  if (i < DAYS - 7 && (holiday || roll < (weekend ? 0.6 : 0.07))) return 0
  const wobble = 1 + 0.22 * Math.sin(i * 0.89) + 0.12 * Math.sin(i * 0.37 + 1.7)
  return (weekend ? 0.35 : 1) * (0.85 + (i / DAYS) * 0.3) * Math.max(0.15, wobble)
})
const WEIGHT_SUM = WEIGHTS.reduce((sum, w) => sum + w, 0)
/** Splits `total` over the weights, rounded, with the remainder on today so the sum is exact. */
const spread = (total, round) => {
  const parts = WEIGHTS.map(w => round((total * w) / WEIGHT_SUM))
  parts[DAYS - 1] = round(total - parts.slice(0, -1).reduce((sum, v) => sum + v, 0))
  return parts
}
const cents = (v) => Math.round(v * 100) / 100
const DAILY = LEDGER_ROWS.flatMap((row) => {
  const cost = spread(row.cost ?? 0, cents)
  const tokens = spread(row.tokens ?? 0, Math.round)
  const turns = spread(row.turns ?? 0, Math.round)
  return WEIGHTS.map((_, i) => ({
    day: midnight(DAYS - 1 - i),
    runtime: row.runtime,
    cost: cost[i],
    tokens: tokens[i],
    turns: turns[i],
  }))
})

/*
 * The hour view covers the same annual totals as the ledger. Work clusters
 * on weekdays from 9am to 7pm, with lighter shoulder hours, a little late
 * work and weekends. The deterministic hourly split keeps every runtime's
 * token and call sums exact, just like DAILY above.
 */
const hourWeight = (weekday, hour) => {
  const weekend = weekday === 0 || weekday === 6
  const dayShape = hour >= 9 && hour < 19 ? 1 : hour >= 7 && hour < 22 ? 0.42 : 0.16
  const weekdayShape = weekend ? 0.24 : weekday === 1 || weekday === 5 ? 0.86 : 1
  const wobble = 0.88 + 0.12 * Math.sin((weekday + 1) * 1.7 + hour * 0.73)
  return dayShape * weekdayShape * wobble
}
const HOUR_WEIGHTS = Array.from({ length: 7 * 24 }, (_, index) => hourWeight(Math.floor(index / 24), index % 24))
const HOUR_WEIGHT_SUM = HOUR_WEIGHTS.reduce((sum, weight) => sum + weight, 0)
const spreadHours = (total) => {
  const exact = HOUR_WEIGHTS.map(weight => total * weight / HOUR_WEIGHT_SUM)
  const parts = exact.map(Math.floor)
  const remainderOrder = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder)
  const remainder = total - parts.reduce((sum, value) => sum + value, 0)
  for (let index = 0; index < remainder; index += 1) {
    const target = remainderOrder[index]
    if (target) parts[target.index] = (parts[target.index] ?? 0) + 1
  }
  return parts
}
const HOURLY = LEDGER_ROWS.flatMap((row) => {
  const tokens = spreadHours(row.tokens ?? 0)
  const requests = spreadHours(row.turns ?? 0)
  return HOUR_WEIGHTS.map((_, index) => ({
    runtime: row.runtime,
    weekday: Math.floor(index / 24),
    hour: index % 24,
    tokens: tokens[index],
    requests: requests[index],
  }))
})

export const LEDGER = {
  days: DAYS,
  currency: 'USD',
  totalCost: Number(TOTAL_COST.toFixed(2)),
  totalTokens: TOTAL_TOKENS,
  provenance: 'listPrice',
  coverage: {
    priced: 1_416,
    unpriced: 72,
    unmetered: 0,
    estimated: 108,
    daysCovered: DAYS,
    daysRequested: DAYS,
    // Every runtime this stub carries a row for has a real turn boundary —
    // the Overview strip's "Turns" cell reads this to say "known for N of M
    // agents" rather than leaving every card unattributed (aa4a38fbf, #1068).
    turnsKnownFor: LEDGER_ROWS.map(row => rigRuntimeId(row.runtime)),
    hoursKnownFor: LEDGER_ROWS.map(row => rigRuntimeId(row.runtime)),
  },
  rows: LEDGER_ROWS.map(row => ({ ...row, key: rigRuntimeId(row.key), runtime: rigRuntimeId(row.runtime) })),
  daily: DAILY.map(row => ({ ...row, runtime: rigRuntimeId(row.runtime) })),
  hourly: HOURLY.map(row => ({ ...row, runtime: rigRuntimeId(row.runtime) })),
  scannedAt: Date.now() - 12 * MINUTE,
  totals: {
    input: Math.round(TOTAL_TOKENS * 0.05),
    output: Math.round(TOTAL_TOKENS * 0.02),
    cacheRead: Math.round(TOTAL_TOKENS * 0.9),
    cacheWrite: Math.round(TOTAL_TOKENS * 0.03),
    reasoning: 0,
    requests: TOTAL_TURNS,
    turns: TOTAL_TURNS,
  },
}

/** A scan that is already over, so none is ever started against the real corpus. */
export const SCAN = {
  running: false,
  filesDone: 0,
  filesTotal: 0,
  bytesDone: 0,
  bytesTotal: 0,
  startedAt: Date.now() - 13 * MINUTE,
  finishedAt: Date.now() - 12 * MINUTE,
}
