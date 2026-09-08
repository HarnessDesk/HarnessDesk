import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { noteGlyph } from './Usage'

/**
 * A usage card's one line of prose, and the glyph beside it.
 *
 * `pace()` already returns `tone: 'good'` for a window that lasts to its
 * reset, and `noteOf` already passes it through. The card drew the glyph off
 * `tone === undefined` instead of off the tone, so every card carrying good
 * news carried a warning triangle with it — three of them at once, under a
 * heading that read "Nothing is close to a limit". A ⚠ that also means "you
 * are fine" is not a signal.
 */
describe('noteGlyph', () => {
  const svg = (tone: Parameters<typeof noteGlyph>[0]): string =>
    renderToStaticMarkup(<>{noteGlyph(tone)}</>)

  it('does not warn about good news', () => {
    const good = svg('good')
    expect(good).not.toBe(svg('warn'))
    expect(good).not.toBe(svg('bad'))
  })

  it('warns about what is actually wrong', () => {
    expect(svg('bad')).toBe(svg('warn'))
    expect(svg('warn')).not.toBe(svg(undefined))
  })
})
