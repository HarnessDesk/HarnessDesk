import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Section } from './section'
import { Table } from './table'

it('a page section can align its label with a row body', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<Section title="Agents" inset="row"><div>Rows</div></Section>)
  expect(host.querySelector('[data-slot="section-head"]')!.className).toContain('px-(--hd-inset-row)')
})

it('a framed table can share the row inset of the list replacing it', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<Table variant="framed" inset="row" />)
  expect(host.querySelector('table')!.className).toContain('[&_th]:px-(--hd-inset-row)')
  expect(host.querySelector('table')!.className).toContain('[&_td]:px-(--hd-inset-row)')
})
