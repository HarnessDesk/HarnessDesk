import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { PaneColumn, SummaryItem, SummaryList } from '../index'

it('keeps the replacement reading summary inside the page gutter', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<PaneColumn inset="reading"><SummaryList aria-label="Board summary"><SummaryItem label="Work">12 open</SummaryItem></SummaryList></PaneColumn>)
  expect(host.querySelector('[data-slot="pane-column"]')?.getAttribute('data-inset')).toBe('reading')
  expect(host.querySelector('[data-slot="summary-value"]')?.textContent).toBe('12 open')
})

it('keeps the table summary as content without repeating a title or a second action bar', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<PaneColumn inset="reading"><SummaryList aria-label="Board summary"><SummaryItem label="Work">4 jobs</SummaryItem></SummaryList></PaneColumn>)
  expect(host.querySelector('[data-slot="summary-value"]')?.textContent).toBe('4 jobs')
  expect(host.querySelector('header, h1, h2, h3, button')).toBeNull()
  // The real Board/List browser check measures this summary's text against
  // the first table cell; verbs now belong to B's shell TopBar.
})
