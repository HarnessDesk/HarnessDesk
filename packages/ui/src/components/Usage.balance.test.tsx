import { describe, expect, it } from 'vitest'

import type { UsageReport } from '@harnessdesk/protocol'

import { balanceOf } from './Usage'

/**
 * The prepaid balance a Dashboard card is allowed to print.
 *
 * `UsageCredits.remaining` is `number | null`, and `NaN` satisfies both that
 * type and `typeof value === 'number'`. The card asked only whether the field
 * was present, cast it, and handed it to `amount()` — which for a vendor's own
 * unit formats with `toLocaleString`, so the headline figure on the card read
 * "NaN credits", and the line under a plan lane read "NaN credits left on top
 * of the plan". `describeLimits` had refused a non-finite balance since round
 * 1 of #207 and Codex's `balanceOf` since #207 itself, so the same reading was
 * safe in Settings and unguarded here: the guards all sat on the producer's
 * side of a type that cannot tell the two apart (#225).
 *
 * A zero is a balance (#85). Only what is not a finite number is none.
 */

const credits = (over: Partial<NonNullable<UsageReport['credits']>>): UsageReport['credits'] => ({
  remaining: 1200,
  unit: 'credits',
  ...over,
})

describe('the balance a card prints', () => {
  it('refuses a figure nobody can name', () => {
    expect(balanceOf(credits({ remaining: Number.NaN }))).toBeNull()
    expect(balanceOf(credits({ remaining: Number.POSITIVE_INFINITY }))).toBeNull()
    expect(balanceOf(credits({ remaining: Number.NaN, unit: 'USD' }))).toBeNull()
  })

  it('keeps a figure that is one, a zero included', () => {
    expect(balanceOf(credits({ remaining: 0 }))).toEqual({ remaining: 0, used: null, unit: 'credits' })
    expect(balanceOf(credits({ remaining: 1200 }))).toEqual({ remaining: 1200, used: null, unit: 'credits' })
    expect(balanceOf(credits({ remaining: 12.5, unit: 'USD' }))).toEqual({ remaining: 12.5, used: null, unit: 'USD' })
    expect(balanceOf(credits({ remaining: -5 }))).toEqual({ remaining: -5, used: null, unit: 'credits' })
  })

  it('is none where the account has no balance to show', () => {
    expect(balanceOf(null)).toBeNull()
    expect(balanceOf(credits({ remaining: null }))).toBeNull()
    // An unlimited account reports no figure, and never did: it must keep
    // reading as no balance rather than as one worth nothing.
    expect(balanceOf(credits({ remaining: null, unlimited: true }))).toBeNull()
  })

  it('reads what is gone on its own, so an unnameable half keeps the other half', () => {
    expect(balanceOf(credits({ remaining: 1200, used: 300 }))).toEqual({
      remaining: 1200,
      used: 300,
      unit: 'credits',
    })
    // The note beside a plan lane prints both halves, and a source can know
    // what is left without knowing what is gone.
    expect(balanceOf(credits({ remaining: 1200, used: Number.NaN }))).toEqual({
      remaining: 1200,
      used: null,
      unit: 'credits',
    })
    expect(balanceOf(credits({ remaining: 1200, used: null }))?.used).toBeNull()
  })
})
