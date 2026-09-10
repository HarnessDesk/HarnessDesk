import { describe, expect, it } from 'vitest'

import { describeLimits, formatReset } from './limits'

const NOON = new Date('2026-08-22T12:00:00').getTime()

describe('describeLimits', () => {
  it('does not call a plan user with no prepaid credits blocked', () => {
    const view = describeLimits(
      {
        hasCredits: false,
        unlimited: false,
        planType: 'team',
        windows: [
          { label: '5-hour', usedPercent: 10, windowMinutes: 300, resetsAt: null },
          { label: 'Weekly', usedPercent: 96, windowMinutes: 10080, resetsAt: NOON + 4 * 3_600_000 },
        ],
        reached: null,
      },
      NOON,
    )
    expect(view?.blocked).toBeNull()
    expect(view?.credits).toBeNull()
    expect(view?.usage).toMatchObject({ label: '4% left', remainingPercent: 4, tone: 'warn' })
    expect(view?.usage?.detail).toBe('Weekly · resets 4:00 PM')
  })

  it('blocks only on a limit the backend says was reached', () => {
    const view = describeLimits({ reached: 'workspace_member_credits_depleted', windows: [] })
    expect(view?.blocked?.title).toBe('Credits depleted')
    expect(view?.usage).toBeNull()
  })

  it('names an unknown reached type without crashing', () => {
    expect(describeLimits({ reached: 'something_new' })?.blocked?.title).toBe('Limit reached')
  })

  it('shows a prepaid balance when there is one', () => {
    const view = describeLimits({ hasCredits: true, balance: 1200, windows: [] })
    expect(view?.credits?.label).toBe('1,200 credits')
  })

  it('shows a prepaid balance of zero, rather than nothing', () => {
    // #85: `hasCredits && balance` was false at 0, so an empty balance read as no balance at all.
    expect(describeLimits({ hasCredits: true, balance: 0, windows: [] })?.credits).toEqual({ label: '0 credits', tone: 'bad' })
    expect(describeLimits({ hasCredits: true, balance: 1200, windows: [] })?.credits).toEqual({ label: '1,200 credits', tone: 'good' })
  })

  it('returns nothing for an unmetered runtime', () => {
    expect(describeLimits(null)).toBeNull()
  })
})

describe('formatReset', () => {
  it('drops the day when the reset is today', () => {
    expect(formatReset(NOON + 3_600_000, NOON)).toBe('1:00 PM')
  })
  it('names the day otherwise', () => {
    expect(formatReset(NOON + 2 * 86_400_000, NOON)).toMatch(/^Mon \d{1,2}:\d{2} [AP]M$/)
  })
})
