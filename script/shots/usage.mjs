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
import { CAST, PRIMARY, SHANE, OLIVIA } from './cast.mjs'

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

/** A week of spend that rises toward today, so the sparkline has a shape. */
const week = (peak) =>
  [6, 5, 4, 3, 2, 1, 0].map((n, i) => day(n, Number((peak * (0.35 + i * 0.11)).toFixed(2)), Math.round(peak * (0.35 + i * 0.11) * 41_000)))

export const REPORTS = [
  {
    runtime: 'claude-code',
    account: SHANE.email,
    plan: 'Max 20x',
    lanes: [
      lane('session', 'Session', 71, 300, 42),
      lane('weekly', 'Weekly', 88, 10_080, 3_400),
      // Spent, and scoped to one model family: the account is fine, this lane
      // is not, and the card has to say which.
      lane('weekly:opus', 'Weekly', 100, 10_080, 3_400, { scope: 'Opus' }),
      // Reset metadata, no figure. Drawn as unknown rather than as 0%.
      lane('review', 'Code review', 0, 10_080, 3_400, { usageKnown: false }),
    ],
    credits: null,
    spend: {
      currency: 'USD',
      todayCost: 18.4,
      windowCost: 96.2,
      windowDays: 7,
      todayTokens: 742_000,
      windowTokens: 3_940_000,
      provenance: 'priced',
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
    account: SHANE.email,
    plan: 'Team',
    lanes: [lane('session', '5-hour', 22, 300, 118), lane('weekly', 'Weekly', 34, 10_080, 5_020)],
    credits: null,
    spend: {
      currency: 'USD',
      todayCost: 6.1,
      windowCost: 41.7,
      windowDays: 7,
      todayTokens: 268_000,
      windowTokens: 1_710_000,
      provenance: 'priced',
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
    // A second account on the same agent — a supported shape, and every
    // surface has to say *which*, so the pair has to be on the page.
    runtime: 'claude-code',
    account: OLIVIA.email,
    plan: 'Pro',
    lanes: [lane('session', 'Session', 12, 300, 205), lane('weekly', 'Weekly', 44, 10_080, 6_100)],
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'file', label: "from Claude Code's own cache" },
    fetchedAt: ago(2),
    staleAfterMs: 600_000,
    error: null,
  },
  {
    runtime: 'cursor',
    account: `${PRIMARY.name}-Cursor`,
    plan: 'Pro',
    // A balance and no window at all: nothing to draw a bar from, and the card
    // must still be useful.
    lanes: [],
    credits: { remaining: 118.4, used: 81.6, unit: 'USD' },
    spend: null,
    reached: null,
    source: { kind: 'api', label: 'from its dashboard API' },
    fetchedAt: ago(9),
    staleAfterMs: 900_000,
    error: null,
  },
  {
    runtime: 'gemini-cli',
    account: SHANE.email,
    plan: 'Free',
    // Over its window. Not clamped, because being outrun carries meaning.
    lanes: [lane('daily', 'Daily', 104, 1_440, 380)],
    credits: null,
    spend: null,
    reached: 'Daily',
    source: { kind: 'runtime', label: 'from its own API' },
    fetchedAt: ago(6),
    staleAfterMs: 600_000,
    error: null,
  },
  {
    runtime: 'copilot',
    account: SHANE.email,
    plan: null,
    lanes: [],
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'runtime', label: 'from its own API' },
    fetchedAt: ago(31),
    staleAfterMs: 600_000,
    // One card in a failed state, because that is a state the page has and a
    // page that never shows it is a page nobody has checked.
    error: { message: 'Signed out — sign in to read quota.', needsSignIn: true },
  },
]

/** Only report on agents the desk actually has, so a rename cannot orphan a card. */
const known = new Set(CAST.map((one) => one.id))
export const USAGE = REPORTS.filter((one) => known.has(one.runtime))

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
const LEDGER_ROWS = [
  { key: 'claude-code', label: 'Claude', runtime: 'claude-code', tokens: 3_940_000, cost: 96.2, hasUnpriced: false },
  { key: 'codex', label: 'Codex', runtime: 'codex', tokens: 1_710_000, cost: 41.7, hasUnpriced: false },
  { key: 'cursor', label: 'Cursor', runtime: 'cursor', tokens: 820_000, cost: 18.4, hasUnpriced: false },
  { key: 'gemini-cli', label: 'Gemini', runtime: 'gemini-cli', tokens: 410_000, cost: 0, hasUnpriced: true },
  { key: 'amp', label: 'Amp', runtime: 'amp', tokens: 96_000, cost: 3.1, hasUnpriced: false },
]

const TOTAL_COST = LEDGER_ROWS.reduce((sum, row) => sum + (row.cost ?? 0), 0)
const TOTAL_TOKENS = LEDGER_ROWS.reduce((sum, row) => sum + (row.tokens ?? 0), 0)

/** Seven days of stacked daily cost, split across the three priced agents. */
const DAILY = [6, 5, 4, 3, 2, 1, 0].flatMap((back, i) =>
  ['claude-code', 'codex', 'cursor'].map((runtime, r) => ({
    day: Date.now() - back * 24 * 60 * MINUTE,
    runtime,
    cost: Number(((3.2 - r * 0.9) * (0.5 + i * 0.12)).toFixed(2)),
    tokens: Math.round((132_000 - r * 38_000) * (0.5 + i * 0.12)),
  })),
)

export const LEDGER = {
  days: 30,
  currency: 'USD',
  totalCost: Number(TOTAL_COST.toFixed(2)),
  totalTokens: TOTAL_TOKENS,
  provenance: 'priced',
  coverage: { priced: 118, unpriced: 6, unmetered: 0, estimated: 9, daysCovered: 30, daysRequested: 30 },
  rows: LEDGER_ROWS,
  daily: DAILY,
  scannedAt: Date.now() - 12 * MINUTE,
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
