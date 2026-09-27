import { describe, expect, it } from 'vitest'

import { runtimeId, type UsageBilling, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import {
  approxTurnsOf,
  budgetLeftPercentOf,
  cycleOf,
  describeRow,
  feePerUnitOf,
  leftOf,
  moneyRowOf,
  ownUnitOf,
  planRows,
  primaryShapeOf,
  resetsOf,
  runwayDaysOf,
  shapeCountsOf,
  sortRows,
  statusOf,
  type PlanRow,
} from './plans-table'
import { describeReport } from './usage'

const NOON = new Date('2026-08-22T12:00:00').getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane => ({
  label: over.label ?? over.id,
  windowMinutes: 10_080,
  resetsAt: null,
  ...over,
})

const report = (over: Partial<UsageReport>): UsageReport => ({
  runtime: runtimeId('a'),
  account: null,
  plan: null,
  lanes: [],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'runtime', label: 'from its own API' },
  fetchedAt: NOON,
  staleAfterMs: 5 * MINUTE,
  error: null,
  ...over,
})

const billing = (kinds: UsageBilling['kinds'], over: Partial<UsageBilling> = {}): UsageBilling => ({
  kinds,
  ...over,
})

describe('primaryShapeOf', () => {
  it('picks the first shape in the fixed order, whatever order billing.kinds lists them', () => {
    expect(primaryShapeOf(report({ billing: billing(['metered', 'allowance']) }))).toBe('allowance')
    expect(primaryShapeOf(report({ billing: billing(['free', 'windows']) }))).toBe('windows')
    expect(primaryShapeOf(report({ billing: billing(['balance']) }))).toBe('balance')
    expect(primaryShapeOf(report({ billing: billing(['metered']) }))).toBe('metered')
    expect(primaryShapeOf(report({ billing: billing(['free']) }))).toBe('free')
  })

  it('falls back to real lanes or a real balance when there is no billing at all', () => {
    expect(primaryShapeOf(report({ lanes: [lane({ id: 'weekly', usedPercent: 10 })] }))).toBe('windows')
    expect(primaryShapeOf(report({ credits: { remaining: 5, unit: 'USD' } }))).toBe('balance')
  })

  it('reads as not reporting with no billing, no lanes and no balance', () => {
    expect(primaryShapeOf(report({}))).toBe('none')
    expect(primaryShapeOf(report({ credits: { remaining: null, unit: 'USD' } }))).toBe('none')
  })
})

describe('shapeCountsOf', () => {
  it('counts every row by its shape, plus a total', () => {
    const shapes = ['windows', 'windows', 'allowance', 'balance', 'none'] as const
    expect(shapeCountsOf(shapes)).toEqual({
      all: 5,
      windows: 2,
      allowance: 1,
      balance: 1,
      metered: 0,
      free: 0,
      none: 1,
    })
  })

  it('folds silent agents into "not reporting" and the total', () => {
    expect(shapeCountsOf(['windows'], 3)).toEqual({
      all: 4,
      windows: 1,
      allowance: 0,
      balance: 0,
      metered: 0,
      free: 0,
      none: 3,
    })
  })
})

describe('leftOf', () => {
  it('windows/allowance: the binding lane\'s own percent left', () => {
    const lanes = [lane({ id: 'weekly', usedPercent: 71 })]
    const subject = report({ billing: billing(['windows']), lanes })
    const view = describeReport(subject, { now: NOON })
    expect(leftOf('windows', subject, view).percent).toBe(29)
  })

  it('balance: runway days against a 30-day scale', () => {
    const subject = report({
      billing: billing(['balance']),
      credits: { remaining: 15, unit: 'USD' },
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: null,
        windowDays: 7,
        todayTokens: null,
        windowTokens: null,
        provenance: 'vendorMetered',
        coverage: { priced: 3, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 3, daysRequested: 3 },
        daily: [
          { day: NOON - 2 * DAY, cost: 1, tokens: null },
          { day: NOON - DAY, cost: 1, tokens: null },
          { day: NOON, cost: 1, tokens: null },
        ],
      },
    })
    const view = describeReport(subject, { now: NOON })
    // draw = (1+1+1)/3 = 1/day, runway = 15 days, 15/30 = 50%
    expect(leftOf('balance', subject, view).percent).toBe(50)
  })

  it('balance: no bar with no draw rate to divide by', () => {
    const subject = report({ billing: billing(['balance']), credits: { remaining: 15, unit: 'USD' } })
    const view = describeReport(subject, { now: NOON })
    expect(leftOf('balance', subject, view).percent).toBeNull()
  })

  // A spent balance is a real zero, not "nothing to report" — it draws the
  // meter's own empty track in the danger tone rather than no meter at all,
  // even with no draw rate on file yet to compute a runway from.
  it('balance: a spent balance is 0% left, never null, whether or not a draw rate is known', () => {
    const subject = report({ billing: billing(['balance']), credits: { remaining: 0, unit: 'USD' } })
    expect(leftOf('balance', subject, describeReport(subject, { now: NOON })).percent).toBe(0)

    const negative = report({ billing: billing(['balance']), credits: { remaining: -2.15, unit: 'USD' } })
    expect(leftOf('balance', negative, describeReport(negative, { now: NOON })).percent).toBe(0)
  })

  it('metered (Key): budget left, or no bar without one', () => {
    const withBudget = report({
      billing: billing(['metered'], { budget: { amount: 50, currency: 'USD', period: 'month' } }),
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: 22.4,
        windowDays: 30,
        todayTokens: null,
        windowTokens: null,
        provenance: 'listPrice',
        coverage: null,
      },
    })
    const view = describeReport(withBudget, { now: NOON })
    expect(leftOf('metered', withBudget, view).percent).toBeCloseTo(55.2, 5)

    const noBudget = report({ billing: billing(['metered']) })
    expect(leftOf('metered', noBudget, describeReport(noBudget, { now: NOON })).percent).toBeNull()
  })

  it('free: never a bar', () => {
    const subject = report({ billing: billing(['free']) })
    expect(leftOf('free', subject, describeReport(subject, { now: NOON })).percent).toBeNull()
  })
})

describe('runwayDaysOf', () => {
  it('divides the balance by the mean cost over the days the report covers, zero days included', () => {
    const subject = report({
      credits: { remaining: 30, unit: 'USD' },
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: null,
        windowDays: 3,
        todayTokens: null,
        windowTokens: null,
        provenance: 'vendorMetered',
        coverage: { priced: 3, unpriced: 0, unmetered: 0, estimated: 0, daysCovered: 3, daysRequested: 3 },
        daily: [
          { day: NOON - 2 * DAY, cost: 2, tokens: null },
          { day: NOON - DAY, cost: 4, tokens: null },
          { day: NOON, cost: 0, tokens: null },
        ],
      },
    })
    // mean over all three covered days, the zero included = (2+4+0)/3 = 2/day, runway = 15
    expect(runwayDaysOf(subject)).toBe(15)
  })

  it('is null with no balance or no priced day', () => {
    expect(runwayDaysOf(report({}))).toBeNull()
    expect(runwayDaysOf(report({ credits: { remaining: 30, unit: 'USD' } }))).toBeNull()
  })
})

describe('budgetLeftPercentOf', () => {
  it('reads what is left of a set budget', () => {
    const subject = report({
      billing: billing(['metered'], { budget: { amount: 50, currency: 'USD', period: 'month' } }),
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: 10,
        windowDays: 30,
        todayTokens: null,
        windowTokens: null,
        provenance: 'listPrice',
        coverage: null,
      },
    })
    expect(budgetLeftPercentOf(subject)).toBe(80)
  })

  it('clamps an overdrawn budget at zero, never negative', () => {
    const subject = report({
      billing: billing(['metered'], { budget: { amount: 50, currency: 'USD', period: 'month' } }),
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: 90,
        windowDays: 30,
        todayTokens: null,
        windowTokens: null,
        provenance: 'listPrice',
        coverage: null,
      },
    })
    expect(budgetLeftPercentOf(subject)).toBe(0)
  })

  it('is null with no budget set', () => {
    expect(budgetLeftPercentOf(report({}))).toBeNull()
  })

  it('is null with a budget set but spend unknown — never "$0.00 of the budget" (B6)', () => {
    const subject = report({ billing: billing(['metered'], { budget: { amount: 50, currency: 'USD', period: 'month' } }) })
    expect(budgetLeftPercentOf(subject)).toBeNull()
  })
})

describe('ownUnitOf', () => {
  // The table's own % column already carries "29% left" — a "71% session" or
  // "22% 5-hour" beside it read as USED, a second scale the meter-direction
  // rule (docs/usage-dashboard.md, "one scale per card") does not allow.
  // Never a usedPercent next to a % column: the lane's own label, alone
  // (`hero.title` — the label plus its scope, "Weekly · Opus" when one
  // applies), is the one reading that cannot be misread as the other scale.
  it('windows: the lane\'s own label — never a repeated used% beside the % column', () => {
    const subject = report({ billing: billing(['windows']), lanes: [lane({ id: 'weekly', label: 'Weekly', usedPercent: 71 })] })
    expect(ownUnitOf('windows', subject, describeReport(subject, { now: NOON }))).toBe('Weekly')
  })

  it('windows: the label plus its scope, when the lane has one', () => {
    const subject = report({
      billing: billing(['windows']),
      lanes: [lane({ id: 'weekly:opus', label: 'Weekly', usedPercent: 55, scope: 'Opus' })],
    })
    expect(ownUnitOf('windows', subject, describeReport(subject, { now: NOON }))).toBe('Weekly · Opus')
  })

  it('windows: an em dash with no hero lane at all', () => {
    expect(ownUnitOf('windows', report({}), describeReport(report({}), { now: NOON }))).toBe('—')
  })

  it('allowance: "312 of 500 requests"', () => {
    const subject = report({
      billing: billing(['allowance']),
      lanes: [lane({ id: 'monthly', usedPercent: 62.4, unit: 'requests', used: 312, limit: 500 })],
    })
    expect(ownUnitOf('allowance', subject, describeReport(subject, { now: NOON }))).toBe('312 of 500 requests')
  })

  // Cursor's own request-summary source: a lane with a percent and nothing
  // else. The same rule as Windows — the label alone, never "91% left"
  // beside a % column that already says 91.
  it('allowance with no used/limit to report: the lane\'s own label, not a repeated percent', () => {
    const subject = report({ billing: billing(['allowance']), lanes: [lane({ id: 'plan', label: 'Plan', usedPercent: 9 })] })
    expect(ownUnitOf('allowance', subject, describeReport(subject, { now: NOON }))).toBe('Plan')
  })

  it('allowance in dollars: "$12.40 of $20" — formatMoney\'s own rounding, the one money formatter every card uses', () => {
    const subject = report({
      billing: billing(['allowance']),
      lanes: [lane({ id: 'monthly', usedPercent: 62, unit: 'usd', used: 12.4, limit: 20 })],
    })
    expect(ownUnitOf('allowance', subject, describeReport(subject, { now: NOON }))).toBe('$12.40 of $20.00')
  })

  it('balance: "$0.88 balance"', () => {
    const subject = report({ billing: billing(['balance']), credits: { remaining: 0.88, unit: 'USD' } })
    expect(ownUnitOf('balance', subject, describeReport(subject, { now: NOON }))).toBe('$0.88 balance')
  })

  it('metered with a budget: "$22.40 of $50 budget"', () => {
    const subject = report({
      billing: billing(['metered'], { budget: { amount: 50, currency: 'USD', period: 'month' } }),
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: 22.4,
        windowDays: 30,
        todayTokens: null,
        windowTokens: null,
        provenance: 'listPrice',
        coverage: null,
      },
    })
    expect(ownUnitOf('metered', subject, describeReport(subject, { now: NOON }))).toBe('$22.40 of $50.00 budget')
  })

  it('metered with a budget but unknown spend: "— of $50 budget", never "$0.00" (B6)', () => {
    const subject = report({ billing: billing(['metered'], { budget: { amount: 50, currency: 'USD', period: 'month' } }) })
    expect(ownUnitOf('metered', subject, describeReport(subject, { now: NOON }))).toBe('— of $50.00 budget')
  })

  it('free: "1.1M tokens"', () => {
    const subject = report({
      billing: billing(['free']),
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: null,
        windowDays: 30,
        todayTokens: null,
        windowTokens: 1_100_000,
        provenance: 'listPrice',
        coverage: null,
      },
    })
    expect(ownUnitOf('free', subject, describeReport(subject, { now: NOON }))).toBe('1.1M tokens')
  })

  it('none: an em dash', () => {
    expect(ownUnitOf('none', report({}), describeReport(report({}), { now: NOON }))).toBe('—')
  })
})

describe('approxTurnsOf', () => {
  it('divides remaining allowance units by unitsPerTurn, only for a requests lane', () => {
    const subject = report({
      billing: billing(['allowance']),
      lanes: [lane({ id: 'monthly', usedPercent: 37.6, unit: 'requests', used: 188, limit: 500 })],
      turns: { count: 40, unitsPerTurn: 3.2, since: NOON - 14 * DAY },
    })
    // remaining = 312, /3.2 = 97.5 -> ~98
    expect(approxTurnsOf('allowance', subject)).toBe('~98')
  })

  it('is "—" for an allowance lane not priced in requests (B7)', () => {
    const subject = report({
      billing: billing(['allowance']),
      lanes: [lane({ id: 'monthly', usedPercent: 37.6, unit: 'usd', used: 12, limit: 20 })],
      turns: { count: 40, unitsPerTurn: 3.2, since: NOON - 14 * DAY },
    })
    expect(approxTurnsOf('allowance', subject)).toBe('—')
  })

  it('is "—" with no unitsPerTurn — a plain percent window, always', () => {
    const subject = report({
      billing: billing(['windows']),
      lanes: [lane({ id: 'weekly', usedPercent: 40 })],
      turns: { count: 40, unitsPerTurn: null, since: NOON - 14 * DAY },
    })
    expect(approxTurnsOf('windows', subject)).toBe('—')
  })

  it('is "—" with no turns reported at all', () => {
    expect(approxTurnsOf('balance', report({ credits: { remaining: 10, unit: 'USD' } }))).toBe('—')
  })

  it('divides a balance by its own unitsPerTurn (Value per turn), only when the credit\'s unit matches the report\'s currency', () => {
    const subject = report({
      billing: billing(['balance']),
      credits: { remaining: 9.75, unit: 'USD' },
      turns: { count: 20, unitsPerTurn: 0.25, since: NOON - 14 * DAY },
    })
    expect(approxTurnsOf('balance', subject)).toBe('~39')
  })

  it('is "—" for a balance kept in a different unit than the report\'s currency (B7)', () => {
    const subject = report({
      billing: billing(['balance']),
      credits: { remaining: 9.75, unit: 'credits' },
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: null,
        windowDays: 30,
        todayTokens: null,
        windowTokens: null,
        provenance: 'vendorMetered',
        coverage: null,
      },
      turns: { count: 20, unitsPerTurn: 0.25, since: NOON - 14 * DAY },
    })
    expect(approxTurnsOf('balance', subject)).toBe('—')
  })

  it('is "—" for a key budget in a different currency than the report\'s (B7)', () => {
    const subject = report({
      billing: billing(['metered'], { budget: { amount: 50, currency: 'EUR', period: 'month' } }),
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: 10,
        windowDays: 30,
        todayTokens: null,
        windowTokens: null,
        provenance: 'listPrice',
        coverage: null,
      },
      turns: { count: 20, unitsPerTurn: 0.5, since: NOON - 14 * DAY },
    })
    expect(approxTurnsOf('metered', subject)).toBe('—')
  })
})

describe('cycleOf', () => {
  it('reads a monthly or yearly window, within a few days\' tolerance', () => {
    expect(cycleOf(30 * 24 * 60)).toBe('month')
    expect(cycleOf(365 * 24 * 60)).toBe('year')
  })

  it('is null for any other window length, and for an unknown one', () => {
    expect(cycleOf(10_080)).toBeNull()
    expect(cycleOf(300)).toBeNull()
    expect(cycleOf(null)).toBeNull()
  })
})

describe('resetsOf', () => {
  it('reads the binding lane\'s own short reset', () => {
    const subject = report({ lanes: [lane({ id: 'weekly', usedPercent: 10, resetsAt: NOON + 2 * DAY })] })
    expect(resetsOf(describeReport(subject, { now: NOON }))).toBe('2d')
  })

  it('is "—" with no binding lane', () => {
    expect(resetsOf(describeReport(report({}), { now: NOON }))).toBe('—')
  })
})

describe('statusOf', () => {
  it('is "out" when the report is blocked, reusing the one rule', () => {
    const subject = report({ lanes: [lane({ id: 'weekly', usedPercent: 100 })] })
    expect(statusOf(subject, 'windows', describeReport(subject, { now: NOON }), NOON)).toBe('out')
  })

  it('is "out" for a spent balance', () => {
    const subject = report({ billing: billing(['balance']), credits: { remaining: -2, unit: 'USD' } })
    expect(statusOf(subject, 'balance', describeReport(subject, { now: NOON }), NOON)).toBe('out')
  })

  it('is "on overage" once metered spend is enabled and something has been spent', () => {
    const subject = report({
      billing: billing(['allowance'], { overage: { enabled: true, spent: 4.5, currency: 'USD' } }),
      lanes: [lane({ id: 'monthly', usedPercent: 20 })],
    })
    expect(statusOf(subject, 'allowance', describeReport(subject, { now: NOON }), NOON)).toBe('overage')
  })

  it('is "low" under the card\'s own amber threshold', () => {
    const subject = report({ lanes: [lane({ id: 'weekly', usedPercent: 90 })] })
    expect(statusOf(subject, 'windows', describeReport(subject, { now: NOON }), NOON)).toBe('low')
  })

  it('is "no limit" for Free, and for a Key with no budget set', () => {
    expect(
      statusOf(report({ billing: billing(['free']) }), 'free', describeReport(report({ billing: billing(['free']) }), { now: NOON }), NOON),
    ).toBe('unlimited')
    const key = report({ billing: billing(['metered']) })
    expect(statusOf(key, 'metered', describeReport(key, { now: NOON }), NOON)).toBe('unlimited')
  })

  // A report with no billing shape, no lanes and no balance at all is not
  // "no limit" — there is no limit to have an opinion about because nothing
  // came back. It reads its own status, distinct from Free/Key's "no limit
  // by design" (docs/usage-dashboard.md, "Not reporting").
  it('is "not reporting" for a shape-less report — never "no limit"', () => {
    const subject = report({})
    expect(statusOf(subject, 'none', describeReport(subject, { now: NOON }), NOON)).toBe('notReporting')
  })

  it('otherwise reads "ready"', () => {
    const subject = report({ lanes: [lane({ id: 'weekly', usedPercent: 10 })] })
    expect(statusOf(subject, 'windows', describeReport(subject, { now: NOON }), NOON)).toBe('ready')
  })

  // The four cases `reportNeedsAttention` (`lib/usage.ts`) already caught
  // that the card's own tone check missed — review of #1069, B2.
  it('is "low" for a report carrying its own error, even with a fine-looking view', () => {
    const subject = report({
      lanes: [lane({ id: 'weekly', usedPercent: 10 })],
      error: { message: 'Could not reach the account' },
    })
    expect(statusOf(subject, 'windows', describeReport(subject, { now: NOON }), NOON)).toBe('low')
  })

  it('is "low" for a severity: critical lane, whose tone is bad rather than warn', () => {
    const subject = report({
      lanes: [lane({ id: 'weekly', usedPercent: 40, severity: 'critical' })],
    })
    expect(statusOf(subject, 'windows', describeReport(subject, { now: NOON }), NOON)).toBe('low')
  })

  it('is "low" for a low account-wide lane hiding behind a headline pinned to a healthier one — the bug the old copy missed', () => {
    const subject = report({
      lanes: [
        lane({ id: 'session', usedPercent: 29 }), // 71% left, healthy
        lane({ id: 'weekly', usedPercent: 88 }), // 12% left, low
      ],
    })
    const preference = { pinLaneId: 'session' }
    // A pin makes the healthier Session the headline even though the Weekly
    // behind it has less left (`bindingLane`'s own `rankLive`) — `view.tone`
    // reads the *headline's* tone, so it stays "good" while the account
    // itself has a low lane the old check never looked past the headline to
    // find.
    const view = describeReport(subject, { now: NOON, maxLanes: 3, preference })
    expect(view.hero?.id).toBe('session')
    expect(view.tone).toBe('good')
    expect(statusOf(subject, 'windows', view, NOON, preference)).toBe('low')
  })
})

describe('sortRows', () => {
  const row = (over: Partial<PlanRow>): PlanRow => ({
    key: over.key ?? 'x',
    report: report({}),
    raw: report({}),
    shape: 'windows',
    view: describeReport(report({}), { now: NOON }),
    left: { percent: null },
    status: 'ready',
    ownUnit: '—',
    approxTurns: '—',
    resets: '—',
    ...over,
  })

  it('sorts least left first', () => {
    const rows = [row({ key: 'b', left: { percent: 60 } }), row({ key: 'a', left: { percent: 10 } })]
    expect(sortRows(rows).map((r) => r.key)).toEqual(['a', 'b'])
  })

  it('puts every "out" row first, whatever its percent', () => {
    const rows = [row({ key: 'measured', left: { percent: 5 } }), row({ key: 'out', left: { percent: 80 }, status: 'out' })]
    expect(sortRows(rows).map((r) => r.key)).toEqual(['out', 'measured'])
  })

  it('puts unmeasured rows after every measured one, and "none" last of all', () => {
    const rows = [
      row({ key: 'none', shape: 'none', left: { percent: null } }),
      row({ key: 'measured', left: { percent: 50 } }),
      row({ key: 'unmeasured', shape: 'free', left: { percent: null } }),
    ]
    expect(sortRows(rows).map((r) => r.key)).toEqual(['measured', 'unmeasured', 'none'])
  })

  // A stable tiebreak — review of #1069, N4.
  it('breaks a tie at the same percent by status severity, "low" before "overage"', () => {
    const tiedPercent = [row({ key: 'b', left: { percent: 40 }, status: 'overage' }), row({ key: 'a', left: { percent: 40 }, status: 'low' })]
    expect(sortRows(tiedPercent).map((r) => r.key)).toEqual(['a', 'b'])
  })

  it('breaks a tie by the reset soonest first, then the runtime, then the account', () => {
    const soon = describeReport(
      report({ lanes: [lane({ id: 'weekly', usedPercent: 40, resetsAt: NOON + DAY })] }),
      { now: NOON },
    )
    const later = describeReport(
      report({ lanes: [lane({ id: 'weekly', usedPercent: 40, resetsAt: NOON + 3 * DAY })] }),
      { now: NOON },
    )
    const rows = [
      row({ key: 'later', left: { percent: 40 }, view: later }),
      row({ key: 'soon', left: { percent: 40 }, view: soon }),
    ]
    expect(sortRows(rows).map((r) => r.key)).toEqual(['soon', 'later'])
  })

  it('is stable across repeated calls with the same input', () => {
    const rows = [row({ key: 'a', left: { percent: 30 } }), row({ key: 'b', left: { percent: 30 } }), row({ key: 'c', left: { percent: 30 } })]
    const first = sortRows(rows).map((r) => r.key)
    const second = sortRows(rows).map((r) => r.key)
    expect(second).toEqual(first)
  })
})

describe('feePerUnitOf', () => {
  it('divides the fee by the limit, for a requests lane whose period matches the fee\'s', () => {
    expect(feePerUnitOf({ amount: 20, period: 'month' }, { unit: 'requests', limit: 500, windowMinutes: 30 * 24 * 60 })).toBe(0.04)
  })

  it('is null with no fee or no limit', () => {
    expect(feePerUnitOf(null, { unit: 'requests', limit: 500 })).toBeNull()
    expect(feePerUnitOf({ amount: 20, period: 'month' }, null)).toBeNull()
    expect(feePerUnitOf({ amount: 20, period: 'month' }, { unit: 'requests', limit: 0 })).toBeNull()
  })

  it('is null for a lane not priced in requests or credits — B7', () => {
    expect(feePerUnitOf({ amount: 20, period: 'month' }, { unit: 'usd', limit: 500 })).toBeNull()
    expect(feePerUnitOf({ amount: 20, period: 'month' }, { unit: 'percent', limit: 100 })).toBeNull()
  })

  it('is null when the fee\'s period does not match the lane\'s own reset cadence — B7', () => {
    expect(feePerUnitOf({ amount: 240, period: 'year' }, { unit: 'requests', limit: 500, windowMinutes: 30 * 24 * 60 })).toBeNull()
  })

  it('draws when the lane names no cadence at all — nothing to contradict', () => {
    expect(feePerUnitOf({ amount: 20, period: 'month' }, { unit: 'credits', limit: 500 })).toBe(0.04)
  })
})

describe('planRows', () => {
  it('describes and sorts every report in one pass', () => {
    const spent = report({ account: 'spent', lanes: [lane({ id: 'weekly', usedPercent: 100 })] })
    const healthy = report({ account: 'healthy', lanes: [lane({ id: 'weekly', usedPercent: 10 })] })
    const rows = planRows([healthy, spent], NOON)
    expect(rows.map((r) => r.report.account)).toEqual(['spent', 'healthy'])
    expect(rows[0]?.status).toBe('out')
  })

  it('threads a per-report preference through to describeReport', () => {
    const subject = report({
      lanes: [lane({ id: 'a', usedPercent: 50 }), lane({ id: 'b', usedPercent: 10 })],
    })
    const rows = planRows([subject], NOON, () => ({ pinLaneId: 'a' }))
    expect(rows[0]?.view.heroId).toBe('a')
  })
})

describe('moneyRowOf', () => {
  it('is the window\'s own Value and the plan\'s own fee — never a computed Paid (B4)', () => {
    const subject = report({
      billing: billing(['windows'], {
        fee: { amount: 20, currency: 'USD', period: 'month', source: 'user' },
        overage: { enabled: true, spent: 4.5, currency: 'USD' },
      }),
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: 31,
        windowDays: 30,
        todayTokens: null,
        windowTokens: null,
        provenance: 'listPrice',
        coverage: null,
      },
    })
    const row = moneyRowOf(subject)
    expect(row?.value).toBe(31)
    expect(row?.fee).toEqual({ amount: 20, currency: 'USD', period: 'month' })
    expect(row?.feeIsUser).toBe(true)
    expect(row).not.toHaveProperty('paid')
    expect(row).not.toHaveProperty('ratio')
  })

  it('is null with neither a fee nor a priced window to show', () => {
    expect(moneyRowOf(report({}))).toBeNull()
  })

  it('carries no fee when none is set, rather than a computed figure', () => {
    const subject = report({
      spend: {
        currency: 'USD',
        todayCost: null,
        windowCost: 12,
        windowDays: 30,
        todayTokens: null,
        windowTokens: null,
        provenance: 'listPrice',
        coverage: null,
      },
    })
    const row = moneyRowOf(subject)
    expect(row?.value).toBe(12)
    expect(row?.fee).toBeNull()
  })

  it('a vendor-reported fee is not "you set this"', () => {
    const subject = report({ billing: billing(['metered'], { fee: { amount: 20, currency: 'USD', period: 'month', source: 'vendor' } }) })
    const row = moneyRowOf(subject)
    expect(row?.feeIsUser).toBe(false)
  })
})

describe('describeRow', () => {
  it('assembles one row from a report and a clock', () => {
    const subject = report({ billing: billing(['windows']), lanes: [lane({ id: 'weekly', label: 'Weekly', usedPercent: 71 })] })
    const row = describeRow(subject, NOON)
    expect(row.shape).toBe('windows')
    expect(row.left.percent).toBe(29)
    expect(row.ownUnit).toBe('Weekly')
    expect(row.key).toBe(`${subject.runtime}:`)
  })

  // The row and the expanded card's chip must agree — both read `statusOf`
  // on the same rule now (review of #1069, B2).
  it('agrees with a headline pinned to a healthier lane than the account-wide one behind it', () => {
    const subject = report({
      lanes: [
        lane({ id: 'session', usedPercent: 29 }),
        lane({ id: 'weekly', usedPercent: 88 }),
      ],
    })
    const row = describeRow(subject, NOON, { pinLaneId: 'session' })
    expect(row.view.hero?.id).toBe('session')
    expect(row.status).toBe('low')
  })
})
