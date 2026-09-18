import { describe, expect, it } from 'vitest'

import { runtimeId, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import {
  bindingLane,
  byUrgency,
  describeReport,
  drawnReport,
  formatAge,
  formatCountdown,
  formatCountdownShort,
  formatMoney,
  gatedUntil,
  isBlocked,
  pace,
  costClause,
  planLabel,
  pricedNote,
  runway,
  spendHint,
  workingAccount,
} from './usage'

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

describe('bindingLane', () => {
  it('picks the shortest account-wide lane, not the first or the longest', () => {
    const lanes = [
      lane({ id: 'session', usedPercent: 29, windowMinutes: 300 }),
      lane({ id: 'weekly', usedPercent: 72 }),
      lane({ id: 'review', usedPercent: 88 }),
    ]
    expect(bindingLane(lanes)?.id).toBe('session')
  })

  it('will not let one spent model speak for the whole account', () => {
    const lanes = [
      lane({ id: 'session', usedPercent: 29, windowMinutes: 300 }),
      lane({ id: 'weekly', usedPercent: 72 }),
      lane({ id: 'weekly:fable', usedPercent: 100, scope: 'Fable' }),
    ]
    // 0% left is true about Fable and false about the account, which still has
    // 28% and every other model.
    expect(bindingLane(lanes)?.id).toBe('session')
  })

  it('falls back to a scoped lane when there is nothing else to go on', () => {
    const lanes = [lane({ id: 'weekly:fable', usedPercent: 40, scope: 'Fable' })]
    expect(bindingLane(lanes)?.id).toBe('weekly:fable')
  })

  it('keeps the source order on a tie', () => {
    const lanes = [lane({ id: 'first', usedPercent: 50 }), lane({ id: 'second', usedPercent: 50 })]
    expect(bindingLane(lanes)?.id).toBe('first')
  })

  it('will not let an unmeasured lane outrank a measured one', () => {
    const lanes = [
      lane({ id: 'unknown', usedPercent: 0, usageKnown: false }),
      lane({ id: 'weekly', usedPercent: 90 }),
    ]
    expect(bindingLane(lanes)?.id).toBe('weekly')
  })

  it('never chooses a placeholder', () => {
    const lanes = [
      lane({ id: 'session', usedPercent: 0, placeholder: true }),
      lane({ id: 'weekly', usedPercent: 40 }),
    ]
    expect(bindingLane(lanes)?.id).toBe('weekly')
  })

  it('returns nothing for an agent with no lanes', () => {
    expect(bindingLane([])).toBeNull()
  })

  it('prefers the shortest account-wide window when no longer window is spent', () => {
    const lanes = [
      lane({ id: 'weekly', usedPercent: 72, windowMinutes: 10_080 }),
      lane({ id: 'session', usedPercent: 29, windowMinutes: 300 }),
      lane({ id: 'monthly', usedPercent: 10, windowMinutes: 43_200 }),
    ]
    expect(bindingLane(lanes)?.id).toBe('session')
  })

  it('keeps a spent longer-term window ahead of a live shorter window', () => {
    const lanes = [
      lane({ id: 'session', usedPercent: 20, windowMinutes: 300 }),
      lane({ id: 'weekly', usedPercent: 100, windowMinutes: 10_080 }),
    ]
    expect(bindingLane(lanes)?.id).toBe('weekly')
  })

  it('lets a valid pin choose a live window after safety blockers are considered', () => {
    const lanes = [
      lane({ id: 'session', usedPercent: 20, windowMinutes: 300 }),
      lane({ id: 'weekly', usedPercent: 72, windowMinutes: 10_080 }),
    ]
    expect(bindingLane(lanes, { pinLaneId: 'weekly' })?.id).toBe('weekly')
  })

  it('falls back to automatic selection when the pinned lane is absent', () => {
    const lanes = [
      lane({ id: 'session', usedPercent: 20, windowMinutes: 300 }),
      lane({ id: 'weekly', usedPercent: 72, windowMinutes: 10_080 }),
    ]
    expect(bindingLane(lanes, { pinLaneId: 'monthly' })?.id).toBe('session')
  })
})

describe('gatedUntil', () => {
  const session = lane({ id: 'session', usedPercent: 10, windowMinutes: 300, resetsAt: NOON + 3 * HOUR })

  it('holds a fresh session behind a spent weekly, and takes the later reset', () => {
    const weekly = lane({ id: 'weekly', usedPercent: 100, resetsAt: NOON + 2 * DAY })
    expect(gatedUntil(session, [session, weekly], NOON)).toBe(NOON + 2 * DAY)
  })

  it('waits for the last of several gates', () => {
    const weekly = lane({ id: 'weekly', usedPercent: 100, resetsAt: NOON + 2 * DAY })
    const monthly = lane({ id: 'monthly', usedPercent: 100, windowMinutes: 43_200, resetsAt: NOON + 9 * DAY })
    expect(gatedUntil(session, [session, weekly, monthly], NOON)).toBe(NOON + 9 * DAY)
  })

  it('withholds a date rather than promise the early one when a blocker has no reset', () => {
    const weekly = lane({ id: 'weekly', usedPercent: 100, resetsAt: NOON + 2 * DAY })
    const opaque = lane({ id: 'opaque', usedPercent: 100, windowMinutes: 20_000, resetsAt: null })
    expect(gatedUntil(session, [session, weekly, opaque], NOON)).toBeNull()
  })

  it('ignores a shorter spent lane — it does not gate a longer one', () => {
    const weekly = lane({ id: 'weekly', usedPercent: 20 })
    const spentSession = lane({ id: 'session', usedPercent: 100, windowMinutes: 300, resetsAt: NOON + HOUR })
    expect(gatedUntil(weekly, [weekly, spentSession], NOON)).toBeNull()
  })

  it('ignores a gate that has already reset', () => {
    const stale = lane({ id: 'weekly', usedPercent: 100, resetsAt: NOON - HOUR })
    expect(gatedUntil(session, [session, stale], NOON)).toBeNull()
  })
})

describe('pace', () => {
  it('calls an even burn on track and says it lasts', () => {
    // Half the week gone, half the quota gone.
    const weekly = lane({ id: 'weekly', usedPercent: 50, resetsAt: NOON + 3.5 * DAY })
    const view = pace(weekly, NOON)
    expect(view?.stage).toBe('onTrack')
    expect(view?.willLastToReset).toBe(true)
    expect(view?.text).toBe('On pace · lasts to reset')
  })

  it('says how long is left when the burn will not reach the reset', () => {
    // Half the week gone, 90% spent: the rest goes in well under the remaining half.
    const weekly = lane({ id: 'weekly', usedPercent: 90, resetsAt: NOON + 3.5 * DAY })
    const view = pace(weekly, NOON)
    expect(view?.stage).toBe('ahead')
    expect(view?.willLastToReset).toBe(false)
    expect(view?.text).toMatch(/^40% ahead of pace · runs out in /)
    expect(view?.tone).toBe('warn')
  })

  it('stays quiet in the first moments of a window, where the arithmetic is noise', () => {
    const weekly = lane({ id: 'weekly', usedPercent: 3, resetsAt: NOON + 6.9 * DAY })
    expect(pace(weekly, NOON)).toBeNull()
  })

  it('stays quiet without a reset or a window length', () => {
    expect(pace(lane({ id: 'w', usedPercent: 50, resetsAt: null }), NOON)).toBeNull()
    expect(pace(lane({ id: 'w', usedPercent: 50, windowMinutes: null, resetsAt: NOON + HOUR }), NOON)).toBeNull()
  })

  it('says nothing about a lane whose usage was never reported', () => {
    const unknown = lane({ id: 'w', usedPercent: 0, usageKnown: false, resetsAt: NOON + 3.5 * DAY })
    expect(pace(unknown, NOON)).toBeNull()
  })
})

describe('describeReport', () => {
  const lanes = [
    lane({ id: 'session', label: 'Session', usedPercent: 29, windowMinutes: 300, resetsAt: NOON + 3 * HOUR + 20 * MINUTE }),
    lane({ id: 'weekly', label: 'Weekly', usedPercent: 72, resetsAt: NOON + 3.5 * DAY }),
    lane({ id: 'weekly:fable', label: 'Weekly', scope: 'Fable', usedPercent: 100, severity: 'critical', resetsAt: NOON + 3.5 * DAY }),
    lane({ id: 'routines', label: 'Routines', usedPercent: 0, usageKnown: false, resetsAt: NOON + 3.5 * DAY }),
    lane({ id: 'review', label: 'Code review', usedPercent: 35, resetsAt: NOON + 3.5 * DAY }),
  ]

  it('leads with the binding lane and names both forms of its reset', () => {
    const view = describeReport(report({ lanes }), { now: NOON, maxLanes: 2 })
    // Fable is spent, but the account is not: the headline is the shortest
    // account-wide window, not the model-scoped lane.
    expect(view.hero?.id).toBe('session')
    expect(view.hero?.remainingPercent).toBe(71)
    expect(view.hero?.title).toBe('Session')
    expect(view.hero?.countdown).toBe('3h 20m')
    expect(view.tone).toBe('good')
    expect(view.blocked).toBe(false)
  })

  it('counts every hidden lane, not just the ones the cap dropped', () => {
    const view = describeReport(report({ lanes }), { now: NOON, maxLanes: 2 })
    expect(view.lanes.map((row) => row.id)).toEqual(['weekly', 'weekly:fable'])
    expect(view.overflow).toBe(2)
  })

  it('draws the headline among its peers, in the source’s own order', () => {
    const view = describeReport(report({ lanes }), { now: NOON, maxLanes: 2 })
    // Source order, and `weekly` — the headline — is back in the list rather
    // than pulled out of it: the card's table is one scale, and the big figure
    // is the lowest row of that table promoted.
    expect(view.all.map((row) => row.id)).toEqual(['session', 'weekly', 'weekly:fable'])
    expect(view.heroId).toBe('session')
    expect(view.all.every((row) => row.remainingPercent !== 0 || row.spent)).toBe(true)
  })

  it('has no headline row to promote when nothing is measurable', () => {
    const view = describeReport(report({ lanes: [] }), { now: NOON })
    expect(view.all).toEqual([])
    expect(view.heroId).toBeNull()
  })

  it('names the model that is out without claiming the account is', () => {
    const view = describeReport(report({ lanes, reached: 'weekly:fable' }), { now: NOON, maxLanes: 3 })
    expect(view.blocked).toBe(false)
    expect(view.reachedLane?.scope).toBe('Fable')
    expect(view.tone).toBe('warn')
  })

  it('is blocked when the account-wide lane is the one that was reached', () => {
    const spent = [lane({ id: 'weekly', usedPercent: 100 }), lane({ id: 'session', usedPercent: 10, windowMinutes: 300 })]
    const view = describeReport(report({ lanes: spent, reached: 'weekly' }), { now: NOON, maxLanes: 3 })
    expect(view.blocked).toBe(true)
    expect(view.tone).toBe('bad')
  })

  it('steps around a spent scope when the account reports no wide lane', () => {
    // Antigravity's shape, measured 2026-09-17: a weekly limit per group of
    // models and none for the account. The Gemini group is spent and the
    // Claude one is untouched, and the agent runs Claude Opus as happily as
    // ever — so the account is not out, and its headline is the scope that
    // still has room, not the one that has none.
    const groups = [
      lane({ id: 'gemini-weekly', usedPercent: 100, scope: 'Gemini Models', resetsAt: NOON + 6 * DAY }),
      lane({ id: '3p-weekly', usedPercent: 0, scope: 'Claude and GPT models', resetsAt: null }),
    ]
    const view = describeReport(report({ lanes: groups, reached: 'gemini-weekly' }), { now: NOON, maxLanes: 3 })
    expect(view.blocked).toBe(false)
    expect(view.hero?.id).toBe('3p-weekly')
    expect(view.hero?.remainingPercent).toBe(100)
    // The spent one is still on the card, and still named as what ran out.
    expect(view.all.map((row) => row.id)).toEqual(['gemini-weekly', '3p-weekly'])
    expect(view.reachedLane?.scope).toBe('Gemini Models')
    expect(view.tone).toBe('warn')
    // And with an account-wide lane beside them it is a fact about one model,
    // whichever of them is spent, exactly as before.
    const withWide = describeReport(
      report({ lanes: [...groups, lane({ id: 'weekly', usedPercent: 63 })] }),
      { now: NOON, maxLanes: 4 },
    )
    expect(withWide.blocked).toBe(false)
    expect(withWide.hero?.id).toBe('weekly')
  })

  it('waits for the first scope back when every scope is spent', () => {
    const spent = [
      lane({ id: 'gemini-weekly', usedPercent: 100, scope: 'Gemini Models', resetsAt: NOON + 6 * DAY }),
      lane({ id: '3p-weekly', usedPercent: 100, scope: 'Claude and GPT models', resetsAt: NOON + 2 * DAY }),
      lane({ id: 'other', usedPercent: 100, scope: 'Other', resetsAt: null }),
    ]
    const view = describeReport(report({ lanes: spent }), { now: NOON, maxLanes: 3 })
    expect(view.blocked).toBe(true)
    expect(view.hero?.id).toBe('3p-weekly')
    expect(view.tone).toBe('bad')
  })

  it('does not let an unmeasured scope stand in for a spent one', () => {
    // Unknown is not evidence of room, but it is not evidence of none either:
    // the account is not called out while a scope might still answer.
    const view = describeReport(
      report({
        lanes: [
          lane({ id: 'a', usedPercent: 100, scope: 'A' }),
          lane({ id: 'b', usedPercent: 0, scope: 'B', usageKnown: false }),
        ],
      }),
      { now: NOON, maxLanes: 3 },
    )
    expect(view.blocked).toBe(false)
    expect(view.hero?.id).toBe('b')
  })

  it("draws another sign-in's figures without making them the account's", () => {
    const other = {
      whose: 'agy CLI sign-in',
      lanes: [lane({ id: 'gemini-weekly', usedPercent: 100, scope: 'Gemini Models' })],
      reached: 'gemini-weekly',
      fetchedAt: NOON - HOUR,
      staleAfterMs: HOUR,
    }
    const borrowed = report({ account: 'Google account', unverified: other })
    const drawn = drawnReport(borrowed)
    expect(drawn.account).toBe('agy CLI sign-in')
    expect(drawn.lanes).toBe(other.lanes)
    expect(drawn.reached).toBe('gemini-weekly')
    expect(drawn.fetchedAt).toBe(NOON - HOUR)
    // The report itself is untouched, and it is the one everything else reads.
    expect(borrowed.lanes).toEqual([])
    expect(isBlocked(borrowed)).toBe(false)
    // An account with lanes of its own is drawn as itself.
    const own = report({ lanes: [lane({ id: 'weekly', usedPercent: 10 })], unverified: other })
    expect(drawnReport(own)).toBe(own)
    // Its source failing is drawn with its figures, and is not the report's.
    const failing = report({ unverified: { ...other, error: { message: 'agy /usage failed: HTTP 503' } } })
    expect(drawnReport(failing).error?.message).toBe('agy /usage failed: HTTP 503')
    expect(failing.error).toBeNull()
  })

  it('marks a lane with no usage figure as unknown rather than empty', () => {
    const view = describeReport(report({ lanes }), { now: NOON, maxLanes: 5 })
    const routines = view.lanes.find((row) => row.id === 'routines')
    expect(routines?.known).toBe(false)
    expect(routines?.remainingPercent).toBeNull()
    expect(routines?.usedPercent).toBeNull()
  })

  it('escalates a healthy figure whose pace will not reach the reset', () => {
    const burning = [lane({ id: 'weekly', label: 'Weekly', usedPercent: 90, resetsAt: NOON + 3.5 * DAY })]
    const view = describeReport(report({ lanes: burning }), { now: NOON })
    expect(view.hero?.remainingPercent).toBe(10)
    expect(view.pace?.willLastToReset).toBe(false)
    expect(view.tone).toBe('warn')
  })

  it('marks a fresh session as unusable while a longer lane is spent', () => {
    const view = describeReport(
      report({
        lanes: [
          lane({ id: 'session', label: 'Session', usedPercent: 0, windowMinutes: 300, resetsAt: NOON + HOUR }),
          lane({ id: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: NOON + 2 * DAY }),
        ],
      }),
      { now: NOON },
    )
    // The spent weekly is the binding lane, so it leads; the session it blocks
    // shows its own 100% left but says it cannot be spent until the weekly is back.
    expect(view.hero?.id).toBe('weekly')
    const session = view.lanes.find((row) => row.id === 'session')
    expect(session?.remainingPercent).toBe(100)
    expect(session?.gatedUntil).toBe(NOON + 2 * DAY)
    expect(session?.gatedFor).toBe('2d')
    expect(view.gated).toBe(true)
    expect(view.tone).toBe('bad')
  })

  it('knows when its own reading has gone stale', () => {
    const fresh = describeReport(report({ fetchedAt: NOON - MINUTE }), { now: NOON })
    const old = describeReport(report({ fetchedAt: NOON - 30 * MINUTE }), { now: NOON })
    expect(fresh.stale).toBe(false)
    expect(old.stale).toBe(true)
    expect(old.age).toBe('30m ago')
  })

  it('uses the account pin for the hero while preserving the report lanes', () => {
    const view = describeReport(
      report({
        lanes: [
          lane({ id: 'session', label: 'Session', usedPercent: 90, windowMinutes: 300 }),
          lane({ id: 'weekly', label: 'Weekly', usedPercent: 12, windowMinutes: 10_080 }),
        ],
      }),
      { now: NOON, preference: { pinLaneId: 'weekly' } },
    )
    expect(view.heroId).toBe('weekly')
    expect(view.all.map((entry) => entry.id)).toEqual(['session', 'weekly'])
  })
})

describe('byUrgency', () => {
  it('puts what is about to bite first, and an empty agent last', () => {
    const spent = report({ runtime: runtimeId('spent'), lanes: [lane({ id: 'w', usedPercent: 100 })] })
    const low = report({ runtime: runtimeId('low'), lanes: [lane({ id: 'w', usedPercent: 88 })] })
    const fine = report({ runtime: runtimeId('fine'), lanes: [lane({ id: 'w', usedPercent: 4 })] })
    const ledgerOnly = report({
      runtime: runtimeId('ledger'),
      spend: {
        currency: 'USD',
        todayCost: 1,
        windowCost: 18,
        windowDays: 30,
        todayTokens: null,
        windowTokens: null,
        provenance: 'listPrice',
        coverage: null,
      },
    })
    const nothing = report({ runtime: runtimeId('nothing') })
    const order = byUrgency([nothing, fine, ledgerOnly, low, spent]).map((row) => row.runtime)
    expect(order).toEqual(['spent', 'low', 'fine', 'ledger', 'nothing'])
  })
})

describe('runway', () => {
  const nameFor = (row: UsageReport): string => String(row.runtime)

  it('names the one agent that is out, and when it comes back', () => {
    const summary = runway(
      [
        report({ runtime: runtimeId('alpha'), lanes: [lane({ id: 'w', usedPercent: 100, resetsAt: NOON + 2 * DAY })] }),
        report({ runtime: runtimeId('beta'), lanes: [lane({ id: 'w', usedPercent: 10 })] }),
      ],
      nameFor,
      NOON,
    )
    expect(summary.headline).toBe('alpha is out of quota.')
    expect(summary.detail).toBe('Back in 2d · 2 of 2 agents report usage')
  })

  it('counts them once there is more than one', () => {
    const out = (id: string): UsageReport =>
      report({ runtime: runtimeId(id), lanes: [lane({ id: 'w', usedPercent: 100, resetsAt: NOON + DAY })] })
    expect(runway([out('a'), out('b')], nameFor, NOON).headline).toBe('2 agents are out of quota.')
  })

  it('says so plainly when nothing is close', () => {
    const summary = runway([report({ lanes: [lane({ id: 'w', usedPercent: 5 })] })], nameFor, NOON)
    expect(summary.headline).toBe('Nothing is close to a limit.')
  })

  it('does not pretend an unmetered roster is healthy', () => {
    expect(runway([report({})], nameFor, NOON).headline).toBe('No agent here reports plan usage.')
    // Another sign-in's figures are not the agent's, so they are still not
    // "plan usage" here — but the line says what the card below is showing,
    // rather than contradicting it (#769, found launching the app).
    const other = {
      whose: 'agy CLI sign-in',
      lanes: [lane({ id: 'gemini-weekly', usedPercent: 100, scope: 'Gemini Models' })],
      reached: 'gemini-weekly',
      fetchedAt: NOON,
      staleAfterMs: HOUR,
    }
    const borrowed = runway([report({ unverified: other })], nameFor, NOON)
    expect(borrowed.headline).toBe("No agent here reports its own plan usage — a shows another sign-in's.")
    expect(borrowed.metered).toBe(0)
    expect(borrowed.exhausted).toEqual([])
  })

  it('counts a prepaid balance as usage reported, and a spent one as out of credits', () => {
    // Amp and Cline have a balance and nothing else. The line above the cards
    // once said "No agent here reports plan usage." beside a card reading
    // "Limit reached" for an overdrawn Cline account.
    const funded = report({ runtime: runtimeId('amp'), credits: { remaining: 10, unit: 'USD' } })
    const overdrawn = report({ runtime: runtimeId('cline'), credits: { remaining: -0.016, unit: 'USD' }, reached: 'credits' })
    const healthy = runway([funded, report({})], nameFor, NOON)
    expect(healthy.headline).toBe('Nothing is close to a limit.')
    expect(healthy.metered).toBe(1)
    const spent = runway([funded, overdrawn], nameFor, NOON)
    expect(spent.exhausted).toEqual([overdrawn])
    expect(spent.headline).toBe(`${nameFor(overdrawn)} is out of credits.`)
    // A balance that cannot be named is not one.
    expect(runway([report({ credits: { remaining: Number.NaN, unit: 'USD' } })], nameFor, NOON).metered).toBe(0)
  })

  it('calls more than one spent account by what it actually ran out of', () => {
    // Two spent balances have no quota at all; the plural line used to say
    // "quota" for them regardless (#772, review round 4).
    const ampOut = report({ runtime: runtimeId('amp'), credits: { remaining: 0, unit: 'USD' }, reached: 'credits' })
    const clineOut = report({ runtime: runtimeId('cline'), credits: { remaining: -0.016, unit: 'USD' }, reached: 'credits' })
    const windowOut = report({
      runtime: runtimeId('alpha'),
      lanes: [lane({ id: 'w', usedPercent: 100 })],
      reached: 'w',
    })
    expect(runway([ampOut, clineOut], nameFor, NOON).headline).toBe('2 agents are out of credits.')
    expect(runway([windowOut, report({ runtime: runtimeId('beta'), lanes: [lane({ id: 'w2', usedPercent: 100 })], reached: 'w2' })], nameFor, NOON).headline).toBe(
      '2 agents are out of quota.',
    )
    expect(runway([ampOut, windowOut], nameFor, NOON).headline).toBe('2 agents are out of credits or quota.')
  })

  it('treats a reached limit as out even when the lane reads fine', () => {
    const summary = runway(
      [report({ runtime: runtimeId('alpha'), reached: 'rate_limit_reached', lanes: [lane({ id: 'w', usedPercent: 40 })] })],
      nameFor,
      NOON,
    )
    expect(summary.exhausted).toHaveLength(1)
  })
})

describe('spendHint', () => {
  it('says what the money band is made of, and never calls an agent’s own cost a list price', () => {
    expect(spendHint('listPrice')).toBe('what these tokens would have cost at public API rates. Not a bill.')
    expect(spendHint(undefined)).toBe(spendHint('listPrice'))
    expect(spendHint('vendorMetered')).toBe('what the agents recorded these tokens cost.')
    expect(spendHint('mixed')).toContain('what the agents recorded')
    expect(spendHint('mixed')).toContain('public API rates')
  })
})

describe('costClause', () => {
  it('calls the work public-rate cost only when every price is a public one', () => {
    expect(costClause('listPrice')).toBe('what the work cost at public rates')
    expect(costClause(undefined)).toBe(costClause('listPrice'))
    expect(costClause('vendorMetered')).not.toContain('public rates')
    expect(costClause('mixed')).toBe('what the work cost as the agents recorded it or at public rates')
  })
})

describe('pricedNote', () => {
  it('claims a public price for every call only when every price is one', () => {
    expect(pricedNote(0, 'listPrice')).toBe('Every call in this window has a public price, so these figures are exact.')
    expect(pricedNote(0, undefined)).toBe(pricedNote(0, 'listPrice'))
    expect(pricedNote(0, 'vendorMetered')).not.toContain('public price')
    expect(pricedNote(0, 'vendorMetered')).toContain('its agent recorded')
    expect(pricedNote(0, 'mixed')).toContain("its agent's record or a public price")
  })

  it('names the rows that are short, whatever priced the rest', () => {
    expect(pricedNote(1, 'mixed')).toBe(
      'One of these rows includes a model with no public price, so its cost is lower than shown.',
    )
    expect(pricedNote(3, 'listPrice')).toBe(
      '3 of these rows include models with no public price, so their cost is lower than shown.',
    )
  })
})

describe('formatting', () => {
  it('rounds a countdown to the unit a person would say', () => {
    expect(formatCountdown(47.9 * HOUR)).toBe('2d')
    expect(formatCountdown(2 * DAY + 9 * HOUR)).toBe('2d 9h')
    expect(formatCountdown(3 * HOUR + 20 * MINUTE)).toBe('3h 20m')
    expect(formatCountdown(45 * MINUTE)).toBe('45m')
    expect(formatCountdown(-1)).toBeNull()
  })

  it('rolls a rounded unit over into the next one at every boundary (#107)', () => {
    // Just under a day: 59.5 minutes rounds to 60, which carries into a
    // twenty-fourth hour — a count only the day branch has a word for.
    expect(formatCountdown(23 * HOUR + 59 * MINUTE + 40 * 1000)).toBe('1d')
    expect(formatCountdown(23 * HOUR + 59 * MINUTE + 30 * 1000)).toBe('1d')
    expect(formatCountdown(23 * HOUR + 59 * MINUTE + 29 * 1000)).toBe('23h 59m')
    expect(formatCountdown(23 * HOUR + 29 * MINUTE)).toBe('23h 29m')
    // The same carry below that boundary stays in hours.
    expect(formatCountdown(HOUR + 59 * MINUTE + 40 * 1000)).toBe('2h')
    // Just under an hour — the one boundary left where a rounded unit did not
    // roll over, so a reset 59½ minutes away read "60m".
    expect(formatCountdown(59 * MINUTE + 30 * 1000)).toBe('1h')
    expect(formatCountdown(59 * MINUTE + 29 * 1000)).toBe('59m')
    // The short form has the same boundaries.
    expect(formatCountdownShort(23 * HOUR + 59 * MINUTE + 40 * 1000)).toBe('1d')
    expect(formatCountdownShort(23 * HOUR + 29 * MINUTE)).toBe('23h')
    expect(formatCountdownShort(59 * MINUTE + 30 * 1000)).toBe('1h')
    expect(formatCountdownShort(59 * MINUTE + 29 * 1000)).toBe('59m')
  })

  it('carries the rollover to the card, not just the helper', () => {
    const near = NOON + 23 * HOUR + 59 * MINUTE + 40 * 1000
    const view = describeReport(
      report({ lanes: [lane({ id: 'weekly', label: 'Weekly', usedPercent: 72, resetsAt: near })] }),
      { now: NOON, maxLanes: 2 },
    )
    expect(view.hero?.countdown).toBe('1d')
    expect(view.hero?.shortCountdown).toBe('1d')
  })

  it('spends cents only where they carry information', () => {
    expect(formatMoney(2.92)).toBe('$2.92')
    expect(formatMoney(373.01)).toBe('$373')
    expect(formatMoney(0)).toBe('$0')
  })

  it('says just now before it says a number', () => {
    expect(formatAge(NOON - 10_000, NOON)).toBe('just now')
    expect(formatAge(NOON - 2 * MINUTE, NOON)).toBe('2m ago')
  })

  it('reads a plan the same on every badge, without rewriting what the source wrote', () => {
    // Codex reports its login method, in lower case; Cursor already title-cases.
    expect(planLabel('team')).toBe('Team')
    expect(planLabel('pro trial')).toBe('Pro Trial')
    expect(planLabel('Max 20x')).toBe('Max 20x')
    expect(planLabel('Pro')).toBe('Pro')
    expect(planLabel('  ')).toBeNull()
    expect(planLabel(null)).toBeNull()
  })
})

describe('workingAccount', () => {
  const spent = (account: string, resetsAt: number | null) =>
    report({
      account,
      lanes: [lane({ id: 'weekly', usedPercent: 100, resetsAt })],
      reached: 'weekly',
    })

  it('picks the account with most left, since either one will run the turn', () => {
    const chosen = workingAccount([
      report({ account: 'work', lanes: [lane({ id: 'weekly', usedPercent: 91 })] }),
      report({ account: 'personal', lanes: [lane({ id: 'weekly', usedPercent: 12 })] }),
    ])
    expect(chosen?.account).toBe('personal')
  })

  it('does not let a spent account speak for an agent that has a working one', () => {
    const chosen = workingAccount([spent('work', NOON + HOUR), report({ account: 'personal', lanes: [lane({ id: 'weekly', usedPercent: 30 })] })])
    expect(chosen?.account).toBe('personal')
  })

  it('prefers a measured account to an unmeasured one, because silence is not evidence', () => {
    const chosen = workingAccount([
      report({ account: 'quiet', lanes: [] }),
      report({ account: 'loud', lanes: [lane({ id: 'weekly', usedPercent: 97 })] }),
    ])
    expect(chosen?.account).toBe('loud')
  })

  it('falls back to the soonest return when every account is spent', () => {
    const chosen = workingAccount([spent('later', NOON + 3 * HOUR), spent('sooner', NOON + HOUR)])
    expect(chosen?.account).toBe('sooner')
  })

  it('keeps the source order on a tie, and has nothing to say about nothing', () => {
    const chosen = workingAccount([
      report({ account: 'first', lanes: [lane({ id: 'weekly', usedPercent: 40 })] }),
      report({ account: 'second', lanes: [lane({ id: 'weekly', usedPercent: 40 })] }),
    ])
    expect(chosen?.account).toBe('first')
    expect(workingAccount([])).toBeNull()
  })
})
