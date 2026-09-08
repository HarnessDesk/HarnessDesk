import { describe, expect, it } from 'vitest'

import { runtimeId, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import { readinessOf } from '../lib/readiness'
import { describeReport, isBlocked } from '../lib/usage'
import { stateOf } from './Usage'

/**
 * The plan chip beside an account's name on a Dashboard card.
 *
 * The chip is a claim about the *account*, so it may only be turned by an
 * account-wide limit — the rule `docs/usage-dashboard.md` states and the rest
 * of the card already keeps. It took `report.reached` instead, which names
 * whichever window the source hit, scoped ones included: on a real Claude Code
 * account with the Fable weekly spent, the card headlined 37% left, said
 * *Fable is spent — other models still work* under its lanes, and put an amber
 * `Max 20x` over the top of both.
 */

const NOON = new Date('2026-08-22T12:00:00').getTime()

const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane => ({
  label: over.label ?? over.id,
  windowMinutes: 10_080,
  resetsAt: null,
  ...over,
})

const report = (over: Partial<UsageReport>): UsageReport => ({
  runtime: runtimeId('claude'),
  account: 'olivia@acme.dev',
  plan: 'Max 20x',
  lanes: [],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'runtime', label: 'from its own API' },
  fetchedAt: NOON,
  staleAfterMs: 5 * 60_000,
  error: null,
  ...over,
})

/** What Claude Code reports on a Max plan whose Fable week is gone. */
const fableSpent = report({
  lanes: [
    lane({ id: 'session', label: 'Session', usedPercent: 12, windowMinutes: 300 }),
    lane({ id: 'weekly', label: 'Weekly', usedPercent: 63 }),
    lane({ id: 'weekly:fable', label: 'Weekly', usedPercent: 100, scope: 'Fable' }),
  ],
  reached: 'weekly:fable',
})

const state = (input: UsageReport) => stateOf(input, describeReport(input, { now: NOON, maxLanes: 3 }))

describe('the plan chip', () => {
  it('does not limit an account because one model is spent', () => {
    const view = describeReport(fableSpent, { now: NOON, maxLanes: 3 })
    // The card's own two facts, unchanged: the headline is the account-wide
    // weekly, and the scoped window still gets its sentence.
    expect(view.hero?.id).toBe('weekly')
    expect(view.hero?.remainingPercent).toBe(37)
    expect(view.reachedLane?.scope).toBe('Fable')
    expect(state(fableSpent)).toBe('ready')
  })

  it('limits it when the window that is gone is the account own', () => {
    const spent = report({
      lanes: [lane({ id: 'weekly', label: 'Weekly', usedPercent: 100 })],
      reached: 'weekly',
    })
    expect(state(spent)).toBe('limit')
  })

  it('limits it on a spent account-wide lane the source never named', () => {
    const spent = report({ lanes: [lane({ id: 'weekly', label: 'Weekly', usedPercent: 100 })] })
    expect(state(spent)).toBe('limit')
  })

  it('lets a broken reading outrank everything it might have said', () => {
    const broken = report({ ...fableSpent, error: { message: 'no reading' } })
    expect(state(broken)).toBe('broken')
  })
})

/**
 * The three surfaces that answer "is this account out?" — the Dashboard card's
 * chip, the account row and detail page in Settings, and the readiness word the
 * sidebar, menu bar and sign-in all draw — must answer it the same way for the
 * same reading, or the screens contradict each other about one account. They do
 * because they share one predicate; this pins that they keep sharing it, over
 * the lane shapes that used to pull them apart.
 */

const signedIn = {
  accounts: [{ kind: 'oauth', label: 'olivia@acme.dev' }],
  signInMethods: [],
} as never

const shapes: readonly { readonly name: string; readonly report: UsageReport; readonly out: boolean }[] = [
  { name: 'a spent model-scoped week', report: fableSpent, out: false },
  {
    name: 'a spent account-wide week the source named',
    report: report({ lanes: [lane({ id: 'weekly', usedPercent: 100 })], reached: 'weekly' }),
    out: true,
  },
  {
    name: 'a spent account-wide week the source never named',
    report: report({ lanes: [lane({ id: 'weekly', usedPercent: 100 })] }),
    out: true,
  },
  {
    name: 'a limit the source names but no lane explains',
    report: report({ lanes: [lane({ id: 'weekly', usedPercent: 40 })], reached: 'rate_limit_reached' }),
    out: true,
  },
  {
    name: 'scoped lanes and no account-wide one',
    report: report({
      lanes: [
        lane({ id: 'weekly:fable', usedPercent: 100, scope: 'Fable' }),
        lane({ id: 'weekly:opus', usedPercent: 20, scope: 'Opus' }),
      ],
    }),
    out: true,
  },
  { name: 'an account with plenty left', report: report({ lanes: [lane({ id: 'weekly', usedPercent: 12 })] }), out: false },
  { name: 'an account that reports no lane at all', report: report({}), out: false },
]

describe('every surface agrees about one account', () => {
  for (const shape of shapes) {
    it(`reads ${shape.name} the same way on all three`, () => {
      // The Dashboard card's chip.
      expect(stateOf(shape.report, describeReport(shape.report, { now: NOON, maxLanes: 3 })) === 'limit').toBe(shape.out)
      // Settings' account row and its detail page, which ask this directly.
      expect(isBlocked(shape.report)).toBe(shape.out)
      // The word the sidebar, the menu bar and sign-in draw.
      expect(
        readinessOf({
          registered: true,
          health: { state: 'ready' },
          account: signedIn,
          usage: [shape.report],
        }) === 'limit',
      ).toBe(shape.out)
    })
  }
})
