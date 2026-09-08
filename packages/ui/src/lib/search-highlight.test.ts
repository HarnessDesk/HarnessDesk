import { describe, expect, it } from 'vitest'

import { extractHit, highlightAll, stripForSearch } from './search-highlight'

describe('stripForSearch', () => {
  it('removes HTML tags and collapses spaces', () => {
    expect(stripForSearch('<p>Hello  <b>world</b></p>')).toBe('Hello world')
  })
  it('preserves newlines', () => {
    expect(stripForSearch('line one\nline two')).toBe('line one\nline two')
  })
  it('returns empty for empty input', () => {
    expect(stripForSearch('')).toBe('')
  })
})

describe('extractHit', () => {
  it('returns null for no match', () => {
    expect(extractHit('xyz', 'hello world')).toBeNull()
  })
  it('returns null for empty query', () => {
    expect(extractHit('', 'hello world')).toBeNull()
  })
  it('finds a match in plain text', () => {
    const hit = extractHit('world', 'hello world')
    expect(hit).not.toBeNull()
    expect(hit!.line).toBe('hello world')
    expect(hit!.spans).toEqual([{ start: 6, end: 11 }])
  })
  it('is case-insensitive', () => {
    const hit = extractHit('HELLO', 'say hello there')
    expect(hit).not.toBeNull()
    expect(hit!.spans[0]).toEqual({ start: 4, end: 9 })
  })
  it('strips HTML before matching', () => {
    const hit = extractHit('bold', '<p>This is <b>bold</b> text</p>')
    expect(hit).not.toBeNull()
    expect(hit!.line).toContain('bold')
    expect(hit!.line).not.toContain('<')
  })
  it('trims long lines around the match', () => {
    const long = 'a'.repeat(200) + ' findme ' + 'b'.repeat(200)
    const hit = extractHit('findme', long)
    expect(hit).not.toBeNull()
    expect(hit!.line.length).toBeLessThanOrEqual(122) // 120 + possible ellipses
    expect(hit!.line).toContain('findme')
    expect(hit!.line.startsWith('…')).toBe(true)
    expect(hit!.line.endsWith('…')).toBe(true)
  })
  it('handles multiline text and picks the matching line', () => {
    const text = 'first line here\nsecond line has the match\nthird line'
    const hit = extractHit('match', text)
    expect(hit).not.toBeNull()
    expect(hit!.line).toBe('second line has the match')
  })
})

describe('highlightAll', () => {
  it('returns empty for no match', () => {
    expect(highlightAll('xyz', 'hello')).toEqual([])
  })
  it('finds all occurrences', () => {
    expect(highlightAll('lo', 'lo and lo again')).toEqual([
      { start: 0, end: 2 },
      { start: 7, end: 9 },
    ])
  })
  it('is case-insensitive', () => {
    expect(highlightAll('ABC', 'xAbCyAbC')).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 8 },
    ])
  })
})
