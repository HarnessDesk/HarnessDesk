import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Section, SectionBody } from './section'
import { Table } from './table'

it('a page section keeps its heading on the page text edge when its body is inset', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<Section title="Agents" inset="row"><div>Rows</div></Section>)
  expect(host.querySelector('[data-slot="section-head"]')!.className).not.toContain('px-(--hd-inset-row)')
  expect(host.querySelector('[data-slot="section-head"]')!.className).not.toContain('has-[+[data-slot=rows]]')
})

it('a framed table can share the row inset of the list replacing it', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<Table variant="framed" inset="row" />)
  const table = host.querySelector('table')!
  expect(table.className).toContain('[&_tr>:first-child]:ps-(--hd-inset-row)')
  expect(table.className).toContain('[&_tr>:last-child]:pe-(--hd-inset-row)')
  expect(table.className).not.toContain('[&_th]:px-')
  expect(table.className).not.toContain('[&_td]:px-')
})


it('a document section keeps its framed toolbar and full body inset', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<Section variant="document" aria-label="Definition" header="SKILL.md"><SectionBody spacing="document">Text</SectionBody></Section>)
  expect(host.querySelector('section')?.className).toContain('rounded-(--hd-panel-card-radius)')
  expect(host.querySelector('[data-slot="section-header"]')?.className).toContain('border-b')
  expect(host.querySelector('[data-slot="section-body"]')?.className).toContain('py-(--hd-space-4)')
})
