import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { ListRow, ListRowDetail } from './list-row'

it('keeps the default description and metadata in the original content column', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<ListRow lead={<span>face</span>} title="Alpha" subtitle="Reviewer" meta={<span data-example="meta">Progress</span>} trail={<button>Open</button>} />)
  const row = host.firstElementChild!
  const content = row.querySelector('[data-slot="list-row-content"]')!
  expect(row.hasAttribute('data-subtitle-layout')).toBe(false)
  expect(row.querySelector('[data-slot="list-row-heading"]')).toBeNull()
  expect([...row.children].map(child => child.getAttribute('data-slot'))).toEqual(['list-row-lead', 'list-row-content', 'list-row-trail'])
  expect(content.querySelector('[data-slot="list-row-subtitle"]')?.textContent).toBe('Reviewer')
  expect(content.querySelector('[data-example="meta"]')?.textContent).toBe('Progress')
})

for (const size of ['sm', 'default'] as const) {
  for (const density of ['comfortable', 'compact'] as const) {
    it(`gives a below description and metadata the whole ${size} ${density} row width`, () => {
      const host = document.createElement('div')
      host.innerHTML = renderToStaticMarkup(<ListRow as="button" interactive size={size} density={density} subtitleLayout="below" lead={<span>face</span>} mark={<span>unread</span>} title="Alpha" subtitle="Reviewer" meta={<span data-example="meta">Progress</span>} trail={<span>Open</span>} />)
      const row = host.firstElementChild!
      const heading = row.querySelector('[data-slot="list-row-heading"]')!
      const description = row.querySelector('[data-slot="list-row-subtitle"]')!
      const metadata = row.querySelector('[data-example="meta"]')!.parentElement!
      expect(row.querySelectorAll('[data-example="meta"]')).toHaveLength(1)
      expect(metadata.parentElement).toBe(row)
      expect(row.tagName).toBe('BUTTON')
      expect(row.getAttribute('type')).toBe('button')
      expect(row.getAttribute('data-subtitle-layout')).toBe('below')
      expect([...heading.children].map(child => child.getAttribute('data-slot'))).toEqual(['list-row-lead', 'list-row-mark', 'list-row-content', 'list-row-trail'])
      expect([...row.children]).toEqual([heading, description, metadata])
      expect(description.className).toContain('mt-(--hd-table-line-gap)')
    })
  }
}

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
  expect(markup).toContain('[overflow-wrap:normal]')
  expect(markup).not.toContain('[overflow-wrap:anywhere]')
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

it('declares the role its title is drawn in, so the names rule measures the exact pair', () => {
  /* A small row is navigation (13/400) and a default row a subject (14/500). */
  const small = renderToStaticMarkup(<ListRow size="sm" nav title="Alpha" />)
  const regular = renderToStaticMarkup(<ListRow title="Alpha" />)

  expect(small).toContain('data-slot="list-row-title" data-role="navigation"')
  expect(regular).toContain('data-slot="list-row-title" data-role="subject"')
  expect(small).not.toContain('font-semibold')
})

it('keeps the default title in the subject pair', () => {
  const unselected = renderToStaticMarkup(<ListRow title="A subject" />)
  const selected = renderToStaticMarkup(<ListRow selected title="A subject" />)

  for (const markup of [unselected, selected]) {
    expect(markup).toContain('text-(length:--hd-table-name-size)')
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

it('centres leads and trailing controls beside wrapped copy without a first-line box', () => {
  for (const size of ['sm', 'default'] as const) {
    const markup = renderToStaticMarkup(<ListRow size={size} lead={<span>mark</span>} title="Board" subtitle="A second line" trail={<button>Open</button>} />)
    expect(markup).toContain('items-center')
    expect(markup).not.toContain('items-start')
    expect(markup).not.toContain('h-(--hd-line-sm)')
    expect(markup).not.toContain('h-(--hd-line)')
  }
})

it('uses the family’s full and bare row floors', () => {
  expect(renderToStaticMarkup(<ListRow title="Name" />)).toContain('min-h-(--hd-table-row-min-bare)')
  expect(renderToStaticMarkup(<ListRow lead={<span />} title="Name" />)).toContain('min-h-(--hd-table-row-min)')
  expect(renderToStaticMarkup(<ListRow subtitle="Fact" title="Name" />)).toContain('min-h-(--hd-table-row-min)')
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

it('keeps a selected record filled when hovered', () => {
  const markup = renderToStaticMarkup(<ListRow as="button" interactive selected title="Review the change" />)
  expect(markup).toContain('hover:bg-(--hd-selected)')
  expect(markup).not.toContain('hover:bg-(--hd-hover)')
})

it('centres a wrapped record title and its lead on the row', () => {
  const markup = renderToStaticMarkup(<ListRow wrapTitle lead={<svg />} title="A record with a long title" />)
  expect(markup).toContain('items-center')
  expect(markup).not.toContain('h-(--hd-line)')
  expect(markup).toContain('whitespace-normal')
  expect(markup).not.toContain('truncate')
})

it('keeps a state mark outside the title and subtitle text column', () => {
 const host=document.createElement('div')
 host.innerHTML=renderToStaticMarkup(<ListRow mark={<span>unread</span>} lead={<span>face</span>} title="Team" subtitle="Waiting" />)
 const mark=host.querySelector('[data-slot="list-row-mark"]')!
 const content=host.querySelector('[data-slot="list-row-content"]')!
 expect(mark).not.toBeNull()
 expect(content.contains(mark)).toBe(false)
 expect(content.querySelector('[data-slot="list-row-title"]')?.textContent).toBe('Team')
 expect(content.querySelector('[data-slot="list-row-subtitle"]')?.textContent).toBe('Waiting')
})

it('bounds a single filling face while keeping compound leads free to compose', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<ListRow title="Jane Doe" lead={<span data-shape="face" data-fill="" />} />)
  const lead = host.querySelector('[data-slot="list-row-lead"]')!
  expect(lead.className).toContain('has-[>[data-shape=face]:only-child]:size-(--hd-table-face)')
})

it('centres a bare glyph inside a direct hover trigger without its inline baseline gap', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<ListRow size="sm" title="Alpha" subtitle="Working"
    lead={<span data-slot="hover-card-trigger"><svg width="20" height="20" /></span>} />)
  const lead = host.querySelector('[data-slot="list-row-lead"]')!
  // The row already centres the lead's box. Its direct hover trigger must
  // centre the glyph too, rather than adding a text descender below an SVG.
  expect(lead.className).toContain('[&>[data-slot=hover-card-trigger]]:inline-flex')
  expect(lead.className).toContain('[&>[data-slot=hover-card-trigger]]:items-center')
  // Compound leads retain their own layout; no descendant-wide display rule.
  expect(lead.className).not.toContain('[&_*]:inline-flex')
  expect(lead.className).not.toContain('[&_*]:flex')
})

it('opts a record into compact density without making it a navigation row', () => {
  const markup = renderToStaticMarkup(<ListRow density="compact" title="Review" subtitle="4 checks" />)
  expect(markup).toContain('data-hd-table="compact"')
  expect(markup).toContain('data-role="row"')
  expect(markup).toContain('py-px')
  expect(markup).toContain('leading-(--hd-line-xs)')
})

it('gives wrapping compact copy the dense inset and keeps unwrapped rows tight', () => {
  for (const wrapping of [{ wrapTitle: true }, { wrapSubtitle: true }]) {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<ListRow density="compact" title="Review" subtitle="A whole sentence" {...wrapping} />)
    const row = host.firstElementChild!
    expect(row.className).toContain('py-(--hd-inset-dense)')
    expect(row.className).not.toContain('py-px')
  }
  expect(renderToStaticMarkup(<ListRow density="compact" title="Review" />)).toContain('py-px')
  expect(renderToStaticMarkup(<ListRow size="sm" wrapTitle title="Review" />)).toContain('py-1.5')
})

it('renders adaptive facts once and leaves the original row contract alone', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<ListRow subtitleLayout="below" title="Alpha" headingFacts={<><span>Working</span><span>8 turns</span></>} subtitle="Reviewer" trail={<span>Open</span>} />)
  const row = host.firstElementChild!
  expect(row.querySelectorAll('[data-slot="list-row-heading-facts"]')).toHaveLength(1)
  expect(row.querySelector('[data-slot="list-row-heading-facts"]')?.textContent).toBe('Working8 turns')
  expect(row.querySelector('[data-slot="list-row-heading-facts"]')?.parentElement?.getAttribute('data-slot')).toBe('list-row-heading')
  expect(row.querySelector('[data-slot="list-row-subtitle"]')?.parentElement).toBe(row)
})
