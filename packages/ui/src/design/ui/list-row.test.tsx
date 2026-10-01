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

it('sets the small title in the navigation pair and does not bold selection', () => {
  const unselected = renderToStaticMarkup(<ListRow size="sm" nav title="Board" />)
  const selected = renderToStaticMarkup(<ListRow size="sm" nav selected title="Board" />)

  for (const markup of [unselected, selected]) {
    expect(markup).toContain('text-sm')
    expect(markup).toContain('leading-(--hd-line-sm)')
    expect(markup).toContain('font-normal')
    expect(markup).not.toContain('font-medium')
  }
})

it('keeps the default title in the subject pair', () => {
  const unselected = renderToStaticMarkup(<ListRow title="A subject" />)
  const selected = renderToStaticMarkup(<ListRow selected title="A subject" />)

  for (const markup of [unselected, selected]) {
    expect(markup).toContain('text-base')
    expect(markup).toContain('leading-(--hd-line)')
    expect(markup).toContain('font-medium')
  }
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

it('gives a lead beside wrapped copy a box the height of its first line', () => {
  const small = renderToStaticMarkup(<ListRow size="sm" lead={<span>mark</span>} title="Board" subtitle="A second line" />)
  const regular = renderToStaticMarkup(<ListRow lead={<span>mark</span>} title="Workspace" subtitle="A second line" />)

  expect(small).toContain('h-(--hd-line-sm)')
  expect(regular).toContain('h-(--hd-line)')
  expect(small).not.toContain('translate-y-(--hd-space-px)')
  expect(regular).not.toContain('translate-y-(--hd-space-px)')
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
  // No end padding of its own: a plate, an argument panel, a result block
  // and reasoning text all end at the row's own right edge alike, without a
  // caller having to remember to cancel a padded box a step further in.
  expect(title).not.toMatch(/(?:^|\s)pe-/)

  // A caller can still add its own vertical rhythm — the gap between
  // several parts, say — without disturbing the insets this part owns.
  const spaced = renderToStaticMarkup(
    <ListRowDetail inset="title" className="grid gap-(--hd-space-2)">output</ListRowDetail>,
  )
  expect(spaced).toContain('ps-(--hd-space-6)')
  expect(spaced).toContain('gap-(--hd-space-2)')
  expect(spaced).not.toMatch(/(?:^|\s)pe-/)

  // Text has no edge of its own, so a body that holds it takes the wider
  // step and a gap between its parts; a plate keeps the tight step.
  const text = renderToStaticMarkup(<ListRowDetail inset="title" holds="text">output</ListRowDetail>)
  expect(text).toMatch(/(?:\s|")grid(?:\s|")/)
  expect(text).toContain('gap-(--hd-space-2)')
  expect(text).toContain('pt-(--hd-space-2)')
  expect(text).toContain('pb-(--hd-space-3)')
  expect(text).toContain('ps-(--hd-space-6)')
  expect(title).toContain('pt-(--hd-space-0-5)')
  expect(title).toContain('pb-(--hd-space-1-5)')
})
