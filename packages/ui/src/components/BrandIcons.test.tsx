import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BRANDS } from '../lib/brands'
import { BrandMark } from './BrandIcons'

/**
 * Every brand mark comes from lobe-icons through this one wrapper, on the
 * same terms as a Lucide glyph: inline, on currentColor, sized by a prop,
 * hidden from readers unless labelled. These tests hold that line for all of
 * them at once, so a new key in `BRANDS` without a file fails here, not in
 * someone's sidebar.
 */

describe('BrandMark', () => {
  it.each(BRANDS)('%s is an inline mark on currentColor, hidden from readers', (brand) => {
    const markup = renderToStaticMarkup(<BrandMark brand={brand} />)
    expect(markup).toMatch(/^<svg /)
    // The wrapper gives width and height one `size`, so the box has to start
    // at the origin and be square, or the drawing is stretched — which the
    // backreference is saying. Nearly all of lobe-icons is the 24-grid; the
    // few that are not would fail here rather than in somebody's sidebar.
    expect(/viewBox="([^"]+)"/.exec(markup)?.[1]).toMatch(/^0 0 (\d+) \1$/)
    expect(markup).toContain('fill="currentColor"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('focusable="false"')
    expect(markup).toContain(`class="brand brand-${brand}"`)
    // The file's own chrome is gone: its title would be read aloud, and the
    // `flex:none;line-height:1` it carries on its root tag would fight the
    // size prop. Only the root tag — a `style` *inside* the drawing is part
    // of the drawing, as Poolside's `mask-type:alpha` is.
    expect(markup).not.toContain('<title>')
    expect(/^<svg [^>]*>/.exec(markup)![0]).not.toContain('style=')
    // And there is a drawing left.
    expect(markup).toMatch(/<path/)
  })

  it('gives every id it inlines a name of its own, and still points at it', () => {
    // Two files in the collection define something and refer to it, and
    // OpenClaw calls its clip path `a`. Inlined, that id lands in the page's
    // own document, where `url(#a)` finds whichever `a` comes first.
    for (const brand of BRANDS) {
      const markup = renderToStaticMarkup(<BrandMark brand={brand} />)
      // A capture that somehow did not match reads as '', which fails both
      // assertions below rather than being filtered quietly out of them.
      const all = (pattern: RegExp) => [...markup.matchAll(pattern)].map((match) => match[1] ?? '')
      const ids = all(/id="([^"]*)"/g)
      const refs = all(/url\(#([^)]*)\)/g)
      for (const id of ids) expect(id.startsWith(`brand-${brand}-`)).toBe(true)
      for (const ref of refs) expect(ids).toContain(ref)
    }
  })

  it('is not vacuous about that — these two marks really do carry ids', () => {
    expect(renderToStaticMarkup(<BrandMark brand="openclaw" />)).toContain('id="brand-openclaw-a"')
    expect(renderToStaticMarkup(<BrandMark brand="poolside" />)).toMatch(/id="brand-poolside-/)
  })

  it('draws each mark on the box its own file declares', () => {
    // Every mark this app ships is the 24-grid — but read from the file, not
    // asserted over it: the day one is not, it renders right instead of clipped.
    expect(renderToStaticMarkup(<BrandMark brand="codex" />)).toContain('viewBox="0 0 24 24"')
  })

  it('defaults to 16px and takes a size', () => {
    expect(renderToStaticMarkup(<BrandMark brand="codex" />)).toContain('width="16" height="16"')
    expect(renderToStaticMarkup(<BrandMark brand="codex" size={12} />)).toContain('width="12" height="12"')
  })

  it('speaks its name when labelled, for a mark that stands alone', () => {
    const markup = renderToStaticMarkup(<BrandMark brand="cursor" label="Cursor" />)
    expect(markup).toContain('role="img"')
    expect(markup).toContain('aria-label="Cursor"')
    expect(markup).not.toContain('aria-hidden')
  })

  it('passes className and other props through', () => {
    const markup = renderToStaticMarkup(<BrandMark brand="claude" className="avatar" data-x="" />)
    expect(markup).toContain('class="brand brand-claude avatar"')
    expect(markup).toContain('data-x=""')
  })

  it('draws different companies differently', () => {
    const paths = (brand: (typeof BRANDS)[number]) => renderToStaticMarkup(<BrandMark brand={brand} />).replace(/^<svg[^>]*>/, '')
    expect(paths('openai')).not.toBe(paths('codex'))
    expect(paths('claude')).not.toBe(paths('claudecode'))
    expect(paths('gemini')).not.toBe(paths('geminicli'))
  })
})
