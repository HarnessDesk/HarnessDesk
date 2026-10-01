import { describe, expect, it } from 'vitest'

import type { SessionKey } from '@harnessdesk/protocol'

import {
  MAX_TILES,
  displayFor,
  emptySideBySide,
  expandTile,
  focusIndex,
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
