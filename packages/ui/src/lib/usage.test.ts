import { describe, expect, it } from 'vitest'

import { runtimeId, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import {
  bindingLane,
  byUrgency,
  describeReport,
  formatAge,
  formatCountdown,
  formatMoney,
  gatedUntil,
  pace,
  planLabel,
  runway,
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
  it('picks the lane with the least left, not the first or the longest', () => {
    const lanes = [
      lane({ id: 'session', usedPercent: 29, windowMinutes: 300 }),
      lane({ id: 'weekly', usedPercent: 72 }),
      lane({ id: 'review', usedPercent: 88 }),
    ]
    expect(bindingLane(lanes)?.id).toBe('review')
  })

  it('will not let one spent model speak for the whole account', () => {
    const lanes = [
      lane({ id: 'session', usedPercent: 29, windowMinutes: 300 }),
      lane({ id: 'weekly', usedPercent: 72 }),
      lane({ id: 'weekly:fable', usedPercent: 100, scope: 'Fable' }),
    ]
    // 0% left is true about Fable and false about the account, which still has
    // 28% and every other model.
    expect(bindingLane(lanes)?.id).toBe('weekly')
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
    // Fable is spent, but the account is not: the headline is the account's.
    expect(view.hero?.id).toBe('weekly')
    expect(view.hero?.remainingPercent).toBe(28)
    expect(view.hero?.title).toBe('Weekly')
    expect(view.hero?.countdown).toBe('3d 12h')
    expect(view.tone).toBe('warn')
    expect(view.blocked).toBe(false)
  })

  it('counts every hidden lane, not just the ones the cap dropped', () => {
    const view = describeReport(report({ lanes }), { now: NOON, maxLanes: 2 })
    expect(view.lanes.map((row) => row.id)).toEqual(['session', 'weekly:fable'])
    expect(view.overflow).toBe(2)
  })

  it('draws the headline among its peers, in the source’s own order', () => {
    const view = describeReport(report({ lanes }), { now: NOON, maxLanes: 2 })
    // Source order, and `weekly` — the headline — is back in the list rather
    // than pulled out of it: the card's table is one scale, and the big figure
    // is the lowest row of that table promoted.
    expect(view.all.map((row) => row.id)).toEqual(['session', 'weekly', 'weekly:fable'])
    expect(view.heroId).toBe('weekly')
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

  it('lets a scoped lane block only when the account reports no wide one', () => {
    // The contract every source we read satisfies is that an account-wide
    // window exists; with none, the scoped lanes are the whole of what we
    // know and the least left of them binds. A source that ever arrives
    // shaped like this fails here rather than quietly blocking an account.
    const onlyScoped = [
      lane({ id: 'weekly:fable', usedPercent: 100, scope: 'Fable' }),
      lane({ id: 'weekly:opus', usedPercent: 20, scope: 'Opus' }),
    ]
    const view = describeReport(report({ lanes: onlyScoped }), { now: NOON, maxLanes: 3 })
    expect(view.blocked).toBe(true)
    // And with an account-wide lane beside them it goes back to being a fact
    // about one model, whichever of them is spent.
    const withWide = describeReport(
      report({ lanes: [...onlyScoped, lane({ id: 'weekly', usedPercent: 63 })] }),
      { now: NOON, maxLanes: 4 },
    )
    expect(withWide.blocked).toBe(false)
    expect(withWide.hero?.id).toBe('weekly')
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

describe('formatting', () => {
  it('rounds a countdown to the unit a person would say', () => {
    expect(formatCountdown(47.9 * HOUR)).toBe('2d')
    expect(formatCountdown(2 * DAY + 9 * HOUR)).toBe('2d 9h')
    expect(formatCountdown(3 * HOUR + 20 * MINUTE)).toBe('3h 20m')
    expect(formatCountdown(45 * MINUTE)).toBe('45m')
    expect(formatCountdown(-1)).toBeNull()
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
