import { describe, expect, it } from 'vitest'

import { rankedChange } from './Usage'

/**
 * "Where it went"'s own change chip — only ever shown for the by-agent
 * pivot, and only ever computed from figures that can honestly answer "more
 * or less than before".
 */
describe('rankedChange', () => {
  it('is the plain percentage change against the previous period', () => {
    expect(rankedChange(120, 100)).toBeCloseTo(20, 5)
    expect(rankedChange(80, 100)).toBeCloseTo(-20, 5)
  })

  it('has no percentage for a rise from nothing, the same rule periodTotals keeps', () => {
    expect(rankedChange(50, 0)).toBeNull()
  })

  it('has no percentage when either figure is missing', () => {
    expect(rankedChange(null, 100)).toBeNull()
    expect(rankedChange(50, null)).toBeNull()
  })
})
