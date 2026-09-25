import { describe, expect, it } from 'vitest'

import type { TriggerBudgetState, TriggerGoalStatus } from '@harnessdesk/protocol'

import { budgetMeterWords, formatMeterUsd, originHoverWords, originSubject } from './intake'

const status = (over: Partial<TriggerGoalStatus>): TriggerGoalStatus => ({
  goal: 'g1',
  trigger: 'triage-issue',
  source: 'issue',
  label: 'from issue #42',
  url: 'https://github.com/acme/widgets/issues/42',
  budget: null,
  waits: [],
  ...over,
})

describe('originSubject', () => {
  it('reads the bare number off the host\'s own url, for an issue and a pull request', () => {
    expect(originSubject(status({ source: 'issue', url: 'https://github.com/acme/widgets/issues/42' }))).toBe('#42')
    expect(originSubject(status({ source: 'pull-request', url: 'https://github.com/acme/widgets/pull/7' }))).toBe('#7')
  })

  it('is null for a schedule, or a source with no url', () => {
    expect(originSubject(status({ source: 'schedule', url: null }))).toBeNull()
    expect(originSubject(status({ source: 'issue', url: null }))).toBeNull()
  })
})

describe('originHoverWords', () => {
  it('names the exact source and its number', () => {
    expect(originHoverWords(status({ source: 'issue', url: 'https://github.com/acme/widgets/issues/42' })))
      .toBe('Issue #42 · started this Goal')
    expect(originHoverWords(status({ source: 'pull-request', url: 'https://github.com/acme/widgets/pull/7' })))
      .toBe('Pull request #7 · started this Goal')
  })

  it('never repeats the source under a heading that already names it', () => {
    const issue = status({ source: 'issue', url: 'https://github.com/acme/widgets/issues/42' })
    expect(originHoverWords(issue, 'Issue #42')).toBe('Started this Goal')
    expect(originHoverWords(issue, 'Crash when config is empty')).toBe('Issue #42 · started this Goal')
  })

  it('says a schedule started it, honestly, when there is no subject to name', () => {
    expect(originHoverWords(status({ source: 'schedule', url: null }))).toBe('A scheduled run started this Goal.')
  })
})

const budgetState = (over: Partial<TriggerBudgetState>): TriggerBudgetState => ({
  goal: 'g1',
  startedAt: 0,
  deadline: 60 * 60_000,
  budget: { usd: 5, rounds: 1, hours: 1, withoutProgress: 1 },
  spentMicros: 1_200_000,
  reservedMicros: 0,
  provenance: 'vendorMetered',
  closedRounds: [],
  idleRounds: 0,
  stop: null,
  ...over,
})

describe('budgetMeterWords', () => {
  it('reads spend, rounds and time exactly as the meter and its hover card show them', () => {
    const words = budgetMeterWords(
      budgetState({ spentMicros: 1_200_000, closedRounds: [1], budget: { usd: 5, rounds: 1, hours: 1, withoutProgress: 1 } }),
      12 * 60_000,
    )
    expect(words.spentUsd).toBe(1.2)
    expect(words.totalUsd).toBe(5)
    expect(words.leftUsd).toBeCloseTo(3.8)
    expect(words.percentLeft).toBe(76)
    expect(words.roundsUsed).toBe(1)
    expect(words.roundNow).toBe(1)
    expect(words.roundsTotal).toBe(1)
    expect(words.minutesUsed).toBe(12)
    expect(words.minutesTotal).toBe(60)
    expect(words.minutesLeft).toBe(48)
  })

  it('counts the round being worked from 1, and never past the last', () => {
    const budget = { usd: 5, rounds: 3, hours: 1, withoutProgress: 1 }
    expect(budgetMeterWords(budgetState({ closedRounds: [], budget }), 0).roundNow).toBe(1)
    expect(budgetMeterWords(budgetState({ closedRounds: [1], budget }), 0).roundNow).toBe(2)
    expect(budgetMeterWords(budgetState({ closedRounds: [1, 2, 3], budget }), 0).roundNow).toBe(3)
  })

  it('fills the meter with what is left, never past 0% or past 100%', () => {
    const spent = budgetMeterWords(budgetState({ spentMicros: 6_000_000, budget: { usd: 5, rounds: 1, hours: 1, withoutProgress: 1 } }), 0)
    expect(spent.leftUsd).toBe(0)
    expect(spent.percentLeft).toBe(0)

    const untouched = budgetMeterWords(budgetState({ spentMicros: 0 }), 0)
    expect(untouched.spentUsd).toBe(0)
    expect(untouched.percentLeft).toBe(100)
  })

  it('reads an unknown spend as unknown — never as nothing spent — because the host stops on it', () => {
    const unknown = budgetMeterWords(budgetState({ spentMicros: null }), 0)
    expect(unknown.spentUsd).toBeNull()
    expect(unknown.leftUsd).toBeNull()
    expect(unknown.percentLeft).toBeNull()
  })

  it('reads time off the host’s own window, and stops the clock where the run stopped', () => {
    const window = { startedAt: 0, deadline: 90 * 60_000 }
    expect(budgetMeterWords(budgetState(window), 30 * 60_000).minutesTotal).toBe(90)
    expect(budgetMeterWords(budgetState(window), 200 * 60_000).minutesUsed).toBe(90)
    const stopped = budgetState({ ...window, stop: { reason: 'cancelled', detail: 'Cancelled.', at: 20 * 60_000 } })
    expect(budgetMeterWords(stopped, 60 * 60_000).minutesUsed).toBe(20)
  })

  it('has no round to name when the budget allows none', () => {
    expect(budgetMeterWords(budgetState({ budget: { usd: 5, rounds: 0, hours: 1, withoutProgress: 1 } }), 0).roundNow).toBeNull()
  })

  it('never reads a negative time left once a run has run past its own deadline', () => {
    const words = budgetMeterWords(budgetState({ budget: { usd: 5, rounds: 1, hours: 1, withoutProgress: 1 } }), 90 * 60_000)
    // The host stops the run at its deadline, so the clock stops there too.
    expect(words.minutesUsed).toBe(60)
    expect(words.minutesLeft).toBe(0)
  })
})

describe('formatMeterUsd', () => {
  it('always shows two places, since a spend is rarely a whole dollar', () => {
    expect(formatMeterUsd(1.2)).toBe('$1.20')
    expect(formatMeterUsd(0)).toBe('$0.00')
    expect(formatMeterUsd(3.8)).toBe('$3.80')
  })
})
