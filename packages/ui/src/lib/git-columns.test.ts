import { describe, expect, it } from 'vitest'

import { clampColumn, readColumnWidths } from './git-columns'

/**
 * Stored widths are hydration, not state: what matters is that a value from
 * an older build, a hand-edited file, or a bad write cannot produce a column
 * nobody can see or grab back.
 */

describe('readColumnWidths', () => {
  it('keeps the columns it knows and the values that are numbers', () => {
    expect(readColumnWidths({ graph: 40, sha: 80, nonsense: 12, date: 'wide' })).toEqual({
      graph: 40,
      sha: 80,
    })
  })

  it('clamps a stored width into the range that still makes a column', () => {
    // Three pixels of "Commit" is a column nobody can read or grab.
    expect(readColumnWidths({ sha: 3 })).toEqual({ sha: 44 })
    expect(readColumnWidths({ author: 99999 })).toEqual({ author: 320 })
    // The graph alone may be nothing: dragging it shut is a real choice.
    expect(readColumnWidths({ graph: 0 })).toEqual({ graph: 0 })
    expect(readColumnWidths({ graph: -20 })).toEqual({ graph: 0 })
  })

  it('treats junk as "nobody has dragged anything"', () => {
    expect(readColumnWidths(undefined)).toEqual({})
    expect(readColumnWidths(null)).toEqual({})
    expect(readColumnWidths('120')).toEqual({})
    expect(readColumnWidths({ sha: Number.NaN })).toEqual({})
    expect(readColumnWidths({ date: Number.POSITIVE_INFINITY })).toEqual({})
  })

  it('an absent key is not a zero — it is the column following its default', () => {
    expect('graph' in readColumnWidths({ sha: 70 })).toBe(false)
  })
})

describe('clampColumn', () => {
  it('rounds, so a drag never stores a fractional pixel', () => {
    expect(clampColumn('author', 120.6)).toBe(121)
  })
})
