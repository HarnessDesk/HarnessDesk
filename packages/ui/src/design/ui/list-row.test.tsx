import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { ListRow } from './list-row'

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
