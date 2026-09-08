import { describe, expect, it } from 'vitest'

import type { UsageLane } from '@harnessdesk/protocol'

import { burn, burnWord } from './burn'

const NOON = new Date('2026-08-22T12:00:00').getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A weekly window unless the case says otherwise — the shape most plans use. */
const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane => ({
  label: over.label ?? over.id,
  windowMinutes: 10_080,
  resetsAt: null,
  ...over,
})

describe('burn', () => {
  it('puts an even burn exactly on the sustainable rate', () => {
    // Half the week gone, half the quota gone.
    const view = burn(lane({ id: 'weekly', usedPercent: 50, resetsAt: NOON + 3.5 * DAY }), NOON)
    expect(view?.elapsed).toBeCloseTo(0.5, 5)
    expect(view?.left).toBe(50)
    expect(view?.ideal).toBeCloseTo(50, 5)
    expect(view?.margin).toBeCloseTo(0, 5)
    expect(view?.status).toBe('onPace')
    expect(view?.runsOut).toBe(false)
    expect(view?.etaMs).toBeNull()
  })

  it('reads headroom as a positive margin, above the diagonal', () => {
    // Half the week gone, a fifth of the quota gone.
    const view = burn(lane({ id: 'weekly', usedPercent: 20, resetsAt: NOON + 3.5 * DAY }), NOON)
    expect(view?.margin).toBeCloseTo(30, 5)
    expect(view?.status).toBe('conserving')
    expect(view?.runsOut).toBe(false)
  })

  it('projects to the floor and says when, for a window being outrun', () => {
    // Half the week gone, 90% spent: the last tenth goes in a ninth of a week.
    const view = burn(lane({ id: 'weekly', usedPercent: 90, resetsAt: NOON + 3.5 * DAY }), NOON)
    expect(view?.margin).toBeCloseTo(-40, 5)
    expect(view?.status).toBe('overPace')
    expect(view?.runsOut).toBe(true)
    expect(view?.projectedLeft).toBe(0)
    // At 90% in half a week the rate is 180%/week, so the last 10% takes 1/18
    // of a week — a little under nine and a half hours.
    expect(view?.etaMs).toBeCloseTo((7 / 18) * DAY, -5)
    expect(view?.projectedAt).toBeCloseTo(0.5 + 1 / 18, 5)
  })

  it('stops the projection at the reset when the burn will not reach the floor', () => {
    const view = burn(lane({ id: 'weekly', usedPercent: 30, resetsAt: NOON + 3.5 * DAY }), NOON)
    expect(view?.runsOut).toBe(false)
    expect(view?.projectedAt).toBe(1)
    // 30% in half a week projects to 60% by the reset, leaving 40%.
    expect(view?.projectedLeft).toBeCloseTo(40, 5)
  })

  it('withholds the forecast while the window has barely opened', () => {
    // Under 5% of a week gone: one sample, and it would read "runs dry today".
    const view = burn(lane({ id: 'weekly', usedPercent: 3, resetsAt: NOON + 6.9 * DAY }), NOON)
    expect(view).not.toBeNull()
    expect(view?.forecast).toBe(false)
    expect(view?.runsOut).toBe(false)
    expect(view?.etaMs).toBeNull()
    // And the projection is a point at now rather than a flat line to the
    // reset: a caller that forgets to check `forecast` then draws nothing,
    // instead of promising the level will hold.
    expect(view?.projectedAt).toBe(view?.elapsed)
    expect(view?.projectedLeft).toBe(view?.left)
    // The geometry is still true, and is what the chart draws.
    expect(view?.left).toBe(97)
    expect(view?.elapsed).toBeCloseTo(0.1 / 7, 4)
  })

  it('calls a full window full and a spent one spent, whatever the margin says', () => {
    const full = burn(lane({ id: 'weekly', usedPercent: 0, resetsAt: NOON + 3.5 * DAY }), NOON)
    expect(full?.status).toBe('fresh')
    const gone = burn(lane({ id: 'weekly', usedPercent: 100, resetsAt: NOON + 3.5 * DAY }), NOON)
    expect(gone?.status).toBe('spent')
    expect(gone?.runsOut).toBe(true)
    expect(gone?.etaMs).toBe(0)
  })

  it('treats an over-quota figure as spent rather than as negative room', () => {
    const view = burn(lane({ id: 'weekly', usedPercent: 118, resetsAt: NOON + 3.5 * DAY }), NOON)
    expect(view?.left).toBe(0)
    expect(view?.status).toBe('spent')
  })

  it('has no geometry for a lane whose usage was never reported', () => {
    const view = lane({ id: 'w', usedPercent: 0, usageKnown: false, resetsAt: NOON + 3.5 * DAY })
    expect(burn(view, NOON)).toBeNull()
  })

  it('has no geometry without a reset or a window length', () => {
    expect(burn(lane({ id: 'w', usedPercent: 50, resetsAt: null }), NOON)).toBeNull()
    expect(
      burn(lane({ id: 'w', usedPercent: 50, windowMinutes: null, resetsAt: NOON + HOUR }), NOON),
    ).toBeNull()
    expect(
      burn(lane({ id: 'w', usedPercent: 50, windowMinutes: 0, resetsAt: NOON + HOUR }), NOON),
    ).toBeNull()
  })

  it('refuses a reset further away than one whole window', () => {
    // "Now" would fall outside its own axis, so there is nothing to draw.
    expect(burn(lane({ id: 'w', usedPercent: 50, resetsAt: NOON + 9 * DAY }), NOON)).toBeNull()
  })

  it('refuses a reset already in the past', () => {
    expect(burn(lane({ id: 'w', usedPercent: 50, resetsAt: NOON - HOUR }), NOON)).toBeNull()
  })

  it('keeps a short window drawable', () => {
    // The five-hour session window, an hour in.
    const view = burn(
      lane({ id: 'session', usedPercent: 40, windowMinutes: 300, resetsAt: NOON + 4 * HOUR }),
      NOON,
    )
    expect(view?.elapsed).toBeCloseTo(0.2, 5)
    expect(view?.left).toBe(60)
    expect(view?.margin).toBeCloseTo(-20, 5)
    expect(view?.status).toBe('overPace')
    expect(view?.windowMs).toBe(5 * HOUR)
    expect(view?.startsAt).toBe(NOON - HOUR)
  })
})

describe('burnWord', () => {
  it('names every status', () => {
    expect(burnWord('fresh')).toBe('full')
    expect(burnWord('conserving')).toBe('conserving')
    expect(burnWord('onPace')).toBe('on pace')
    expect(burnWord('overPace')).toBe('over pace')
    expect(burnWord('spent')).toBe('spent')
  })
})
