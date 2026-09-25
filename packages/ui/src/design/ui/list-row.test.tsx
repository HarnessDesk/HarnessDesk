import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { ListRow, ListRowDetail } from './list-row'

it('lets an earned sentence wrap instead of cutting it into a caption', () => {
  const markup = renderToStaticMarkup(
    <ListRow
      title="Agent A"
      subtitle="The executable did not answer, so a session sent to it would not start."
      wrapSubtitle
    />,
  )

  expect(markup).toContain('data-wrap-subtitle=""')
  expect(markup).toContain('whitespace-normal')
  expect(markup).toContain('[overflow-wrap:anywhere]')
})

/*
 * Scoped to the lead and the title only — never the row as a whole, and
 * never the subtitle. A refused row's subtitle is its reason, the one
 * sentence a person is shown this row at all to read, and fading the whole
 * row along with it measured at roughly 1.9:1 in light mode: below body
 * text contrast for the one line that has to carry the explanation.
 */
it('fades a row a caller marks refused by its lead and title, leaving the subtitle at full ink', () => {
  const markup = renderToStaticMarkup(
    <ListRow as="label" interactive lead={<span>icon</span>} title="Judge" data-refused="" subtitle="Can't seat here · Cursor is signed out" wrapSubtitle />,
  )

  expect(markup).toContain('data-refused=""')
  expect(markup).not.toContain('data-[refused]:opacity-45')
  // `renderToStaticMarkup` HTML-escapes the `&` in Tailwind's `[&_...]` arbitrary variant.
  expect(markup).toContain('data-[refused]:[&amp;_[data-slot=list-row-lead]]:opacity-45')
  expect(markup).toContain('data-[refused]:[&amp;_[data-slot=list-row-title]]:opacity-45')
})

it('keeps multiple lead marks beside rather than over one another', () => {
  const markup = renderToStaticMarkup(
    <ListRow lead={<><span>choice</span><span>agent</span></>} title="Session" />,
  )

  expect(markup).toContain('data-slot="list-row-lead"')
  expect(markup).toContain('inline-flex')
  expect(markup).toContain('gap-2')
})

it('opens a row detail at the row\'s edges, or on the list\'s inner line when inset', () => {
  const edge = renderToStaticMarkup(<ListRowDetail>patch</ListRowDetail>)
  // A step under the row and a longer one before the next, no side inset.
  expect(edge).toContain('pt-1')
  expect(edge).toContain('pb-2')
  expect(edge).not.toContain('px-3')
  expect(edge).not.toContain('data-inset')

  const inset = renderToStaticMarkup(<ListRowDetail inset>patch</ListRowDetail>)
  expect(inset).toContain('data-inset')
  expect(inset).toContain('px-3')
  expect(inset).toContain('pb-3')
  expect(inset).not.toContain('pb-2')
})

it('hangs a detail under a row\'s own title, on the third inset step', () => {
  const title = renderToStaticMarkup(<ListRowDetail inset="title">reasoning</ListRowDetail>)
  expect(title).toContain('data-inset="title"')
  // The header's 2px of padding, its 16px icon and the 8px gap after it.
  expect(title).toContain('ps-(--hd-space-6)')
  expect(title).not.toContain('px-3')
  expect(title).not.toContain('pt-1 ')

  // A caller composing a plate back in (a code block, a diff) keeps the
  // part's left indent and drops its own right padding with a plain
  // `className`, rather than a fourth inset step for one shape.
  const bare = renderToStaticMarkup(<ListRowDetail inset="title" className="pe-0">output</ListRowDetail>)
  expect(bare).toContain('pe-0')
})
