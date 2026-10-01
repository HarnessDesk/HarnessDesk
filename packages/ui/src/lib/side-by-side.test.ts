import { describe, expect, it } from 'vitest'

import type { SessionKey } from '@harnessdesk/protocol'

import {
  MAX_TILES,
  canPlace,
  columnsThatFit,
  displayFor,
  emptySideBySide,
  expandTile,
  focusIndex,
  focusTile,
  forgetMissing,
  fromStored,
  pinTile,
  placeTile,
  removeTile,
  setTileMode,
  toStored,
  wouldReplace,
} from './side-by-side'

const k = (name: string) => name as SessionKey

describe('placeTile', () => {
  it('adds tiles up to four, focusing the newest', () => {
    let s = emptySideBySide()
    for (const name of ['a', 'b', 'c', 'd']) s = placeTile(s, k(name))
    expect(s.tiles).toEqual([k('a'), k('b'), k('c'), k('d')])
    expect(s.focused).toBe(k('d'))
    expect(s.tiles.length).toBe(MAX_TILES)
  })

  it('placing a tile already up focuses it and adds nothing', () => {
    let s = placeTile(placeTile(emptySideBySide(), k('a')), k('b'))
    s = placeTile(s, k('a'))
    expect(s.tiles).toEqual([k('a'), k('b')])
    expect(s.focused).toBe(k('a'))
  })

  it('when full, replaces the least-recently-seen tile that is neither pinned nor focused', () => {
    let s = emptySideBySide()
    for (const name of ['a', 'b', 'c', 'd']) s = placeTile(s, k(name))
    s = pinTile(s, k('a'), true)
    expect(wouldReplace(s, k('e'))).toBe(k('b'))
    s = placeTile(s, k('e'))
    expect(s.tiles).toEqual([k('a'), k('e'), k('c'), k('d')])
  })

  it('refuses to replace when every tile is pinned or focused', () => {
    let s = emptySideBySide()
    for (const name of ['a', 'b', 'c', 'd']) s = placeTile(s, k(name))
    for (const name of ['a', 'b', 'c']) s = pinTile(s, k(name), true)
    expect(wouldReplace(s, k('e'))).toBeNull()
    expect(placeTile(s, k('e')).tiles).toEqual(s.tiles)
  })
})

describe('removeTile', () => {
  it('drops the tile, its mode, its pin, and moves focus to a neighbour', () => {
    let s = placeTile(placeTile(emptySideBySide(), k('a')), k('b'))
    s = setTileMode(s, k('b'), 'browser')
    s = pinTile(s, k('b'), true)
    s = removeTile(s, k('b'))
    expect(s.tiles).toEqual([k('a')])
    expect(s.modes).toEqual({})
    expect(s.pinned).toEqual([])
    expect(s.focused).toBe(k('a'))
  })

  it('removing the expanded tile collapses', () => {
    let s = placeTile(placeTile(emptySideBySide(), k('a')), k('b'))
    s = expandTile(s, k('b'))
    expect(removeTile(s, k('b')).expanded).toBeNull()
  })
})

describe('focusIndex and expand', () => {
  it('focuses by position and ignores an index past the end', () => {
    let s = placeTile(placeTile(emptySideBySide(), k('a')), k('b'))
    expect(focusIndex(s, 0).focused).toBe(k('a'))
    expect(focusIndex(s, 3).focused).toBe(k('b'))
  })

  it('expanding a tile focuses it; null collapses', () => {
    let s = placeTile(placeTile(emptySideBySide(), k('a')), k('b'))
    s = expandTile(s, k('a'))
    expect(s.expanded).toBe(k('a'))
    expect(s.focused).toBe(k('a'))
    expect(expandTile(s, null).expanded).toBeNull()
  })
})

describe('displayFor', () => {
  const four = ['a', 'b', 'c', 'd'].reduce((s, name) => placeTile(s, k(name)), emptySideBySide())

  it('lays four tiles out as a 2×2 grid when each column gets 420px', () => {
    expect(displayFor(four, 900)).toEqual({ layout: 'grid', columns: 2, shown: four.tiles })
  })

  it('three tiles take three columns only when each gets 420px, else two', () => {
    const three = removeTile(four, k('d'))
    expect(displayFor(three, 1300).columns).toBe(3)
    expect(displayFor(three, 1000).columns).toBe(2)
  })

  it('below two columns it shows the focused tile alone, and never trims the tiles', () => {
    const narrow = displayFor(four, 600)
    expect(narrow).toEqual({ layout: 'single', columns: 1, shown: [four.focused] })
    expect(four.tiles.length).toBe(4)
  })

  it('an expanded tile is shown alone at any width', () => {
    expect(displayFor(expandTile(four, k('b')), 1600)).toEqual({ layout: 'single', columns: 1, shown: [k('b')] })
  })
})

describe('forgetMissing', () => {
  it('drops tiles whose member is gone and keeps the rest', () => {
    const s = placeTile(placeTile(emptySideBySide(), k('a')), k('b'))
    const kept = forgetMissing(s, new Set([k('a')]))
    expect(kept.tiles).toEqual([k('a')])
    expect(kept.focused).toBe(k('a'))
  })
})

describe('stored tiles', () => {
  it('round-trips tiles, pins, modes, focus and expand; seen restarts as tile order', () => {
    let s = placeTile(placeTile(emptySideBySide(), k('a')), k('b'))
    s = setTileMode(pinTile(s, k('a'), true), k('b'), 'browser')
    s = expandTile(s, k('b'))
    expect(fromStored(toStored(s))).toEqual({ ...s, seen: [k('a'), k('b')] })
  })

  it('an empty grid is stored as nothing', () => {
    expect(toStored(emptySideBySide())).toBeUndefined()
  })

  it('migrates an old view that only had watching columns', () => {
    expect(fromStored(undefined, [k('a'), k('b')]).tiles).toEqual([k('a'), k('b')])
  })

  it('drops what is not a session key, a mode it does not know, and focus on a missing tile', () => {
    const back = fromStored({ tiles: [k('a'), '' as SessionKey], modes: { a: 'radio' as never }, focused: k('z') })
    expect(back.tiles).toEqual([k('a')])
    expect(back.modes).toEqual({})
    expect(back.focused).toBe(k('a'))
  })
})

describe('review round 1', () => {
  const four = () => ['a', 'b', 'c', 'd'].reduce((state, name) => placeTile(state, k(name)), emptySideBySide())

  it('replaces the least recently seen tile, not the first one up', () => {
    // Seen in the order c, d, a, b, with b focused: c is the oldest movable
    // tile, although a is the first tile on the grid.
    const s = focusTile(focusTile(four(), k('a')), k('b'))
    expect(placeTile(s, k('e')).tiles).toEqual([k('a'), k('b'), k('e'), k('d')])
  })

  it('moves an expanded tile with the focus, so the keys never land on a tile nobody can see', () => {
    const expanded = expandTile(four(), k('a'))
    const focused = focusIndex(expanded, 1)
    expect(focused.focused).toBe(k('b'))
    expect(focused.expanded).toBe(k('b'))
    expect(displayFor(focused, 1600).shown).toEqual([k('b')])
  })

  it('shows a newly watched member when a tile is expanded, rather than adding it hidden', () => {
    const expanded = expandTile(placeTile(placeTile(emptySideBySide(), k('a')), k('b')), k('a'))
    const placed = placeTile(expanded, k('c'))
    expect(placed.expanded).toBe(k('c'))
    expect(displayFor(placed, 1600).shown).toEqual([k('c')])
  })

  it('returns the same state for a click on the tile that already has the keys', () => {
    const s = four()
    expect(focusTile(s, k('d'))).toBe(s)
  })

  it('cannot place a member when every other tile is pinned or focused, and says so', () => {
    let s = four()
    for (const name of ['a', 'b', 'c']) s = pinTile(s, k(name), true)
    expect(canPlace(s, k('e'))).toBe(false)
    expect(placeTile(s, k('e'))).toBe(s)
    expect(canPlace(s, k('a'))).toBe(true)
    expect(canPlace(pinTile(s, k('c'), false), k('e'))).toBe(true)
  })

  it('drops the focused and the expanded tile when its member leaves', () => {
    const s = expandTile(four(), k('b'))
    const left = forgetMissing(s, new Set([k('a'), k('c'), k('d')]))
    expect(left.tiles).toEqual([k('a'), k('c'), k('d')])
    expect(left.expanded).toBeNull()
    expect(left.focused).toBe(k('c'))
  })

  it('restores a malformed record without throwing, dropping what is the wrong shape', () => {
    const bad = { tiles: ['a', 'a', 'b', 7, '', 'c', 'd', 'e'], pinned: 'b', modes: ['browser'], focused: 3, expanded: 'zz' } as never
    const s = fromStored(bad)
    expect(s.tiles).toEqual([k('a'), k('b'), k('c'), k('d')])
    expect(s.pinned).toEqual([])
    expect(s.modes).toEqual({})
    expect(s.focused).toBe(k('a'))
    expect(s.expanded).toBeNull()
    expect(fromStored({ tiles: 'a' } as never).tiles).toEqual([])
  })

  it('counts the seams: two tiles need 841px, three need 1262px', () => {
    const two = placeTile(placeTile(emptySideBySide(), k('a')), k('b'))
    expect(displayFor(two, 841).layout).toBe('grid')
    expect(displayFor(two, 840).layout).toBe('single')
    expect(displayFor(two, 0).shown).toEqual([k('b')])
    const three = placeTile(two, k('c'))
    expect(displayFor(three, 1262).columns).toBe(3)
    expect(displayFor(three, 1261).columns).toBe(2)
    // Each of n tracks really is at least the floor at the width that admits n.
    for (const width of [841, 1262, 1683]) {
      const n = columnsThatFit(width)
      expect((width - (n - 1) * 1) / n).toBeGreaterThanOrEqual(420)
    }
  })

  it('restores an expanded tile with the keys, whatever focus the record names', () => {
    const s = fromStored({ tiles: [k('a'), k('b')], focused: k('a'), expanded: k('b') })
    expect(s.focused).toBe(k('b'))
  })
})
