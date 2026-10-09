import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { IconTile } from './icon-tile'
import { Table, TableCell, TableHead, TableHeader, TableRow } from './table'

const element = (markup: string, slot: string) => {
  const host = document.createElement('div')
  host.innerHTML = markup
  return host.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!
}

it('centres the lead on the whole cell without a first-line box', () => {
  const cell = element(renderToStaticMarkup(<table><tbody><TableRow><TableCell lead={<span>Face</span>}><div>Name<br />A second line</div></TableCell></TableRow></tbody></table>), 'table-cell')
  expect(cell.firstElementChild?.className).toContain('items-center')
  expect(cell.firstElementChild?.className).not.toContain('items-start')
  expect(cell.querySelector('[data-slot="table-cell-lead"]')?.className).not.toContain('h-(--hd-line-sm)')
})

it('only promises a hover action on interactive rows and uses one selection fill', () => {
  for (const variant of ['default', 'matrix', 'panel'] as const) {
    for (const interactive of [false, true]) {
      const row = element(renderToStaticMarkup(<table><tbody><TableRow variant={variant} interactive={interactive} data-state="selected" /></tbody></table>), 'table-row')
      expect(row.className.includes('hover:bg-')).toBe(interactive)
      expect(row.className).toContain('data-[state=selected]:bg-(--hd-selected)')
    }
  }
})

it('aligns numeric headers and cells together and supports a centred cell', () => {
  const markup = renderToStaticMarkup(<Table><thead><TableRow><TableHead numeric>Cost</TableHead></TableRow></thead><tbody><TableRow><TableCell numeric>12.34</TableCell><TableCell align="center">Ready</TableCell></TableRow></tbody></Table>)
  const head = element(markup, 'table-head')
  const cell = element(markup, 'table-cell')
  expect(head.getAttribute('scope')).toBe('col')
  expect(head.className).toContain('text-right')
  expect(cell.className).toContain('text-right')
  expect(cell.className).toContain('tabular-nums')
  const host = document.createElement('div'); host.innerHTML = markup
  expect(host.querySelector('[data-align="center"]')?.className).toContain('text-center')
})

it('declares compact density and bare rows, with panel tables compact by default', () => {
  expect(element(renderToStaticMarkup(<Table density="compact" rows="bare" />), 'table').dataset['hdTable']).toBe('compact')
  expect(element(renderToStaticMarkup(<Table rows="bare" />), 'table').dataset['rows']).toBe('bare')
  expect(element(renderToStaticMarkup(<Table variant="panel" />), 'table').dataset['hdTable']).toBe('compact')
  expect(element(renderToStaticMarkup(<Table variant="panel" density="comfortable" />), 'table').dataset['hdTable']).toBe('comfortable')
})

it('renders the native header by default and a separate log header as a div', () => {
  const head = element(renderToStaticMarkup(<Table><TableHeader className="custom"><TableRow><TableHead>Name</TableHead></TableRow></TableHeader></Table>), 'table-header')
  expect(head.tagName).toBe('THEAD')
  expect(head.dataset['variant']).toBe('default')
  expect(head.className).toContain('[&_tr]:border-b')
  expect(head.className).toContain('custom')
  const log = element(renderToStaticMarkup(<TableHeader as="div" variant="log" role="row" aria-rowindex={1} className="custom">Name</TableHeader>), 'table-header')
  expect(log.tagName).toBe('DIV')
  expect(log.dataset['variant']).toBe('log')
  expect(log.getAttribute('role')).toBe('row')
  expect(log.getAttribute('aria-rowindex')).toBe('1')
  expect(log.className).toContain('h-(--hd-table-log-head-h)')
  expect(log.className).toContain('custom')
  expect(log.hasAttribute('as')).toBe(false)
  expect(log.hasAttribute('variant')).toBe(false)
})

it('keeps detail and footer padding in a framed table whose outer edges use the row inset', () => {
  const markup = renderToStaticMarkup(<Table variant="framed" inset="row" density="compact"><tbody><TableRow><TableCell>Name</TableCell><TableCell variant="detail">Detail</TableCell><TableCell variant="footer">Total</TableCell><TableCell>State</TableCell></TableRow></tbody></Table>)
  const table = element(markup, 'table')
  expect(table.className).not.toContain('[&_td]:px-')
  expect(table.className).not.toContain('[&_th]:px-')
  const detail = table.querySelector('[data-variant="detail"]')!
  const footer = table.querySelector('[data-variant="footer"]')!
  expect(detail.className).toContain('px-3')
  expect(footer.className).toContain('px-1.5')
})

it('keeps a collapsible column in the semantic table without leaking its policy prop', () => {
  const markup = renderToStaticMarkup(<Table><thead><TableRow><TableHead>Account</TableHead><TableHead collapseBelow="sm">Resets</TableHead></TableRow></thead><tbody><TableRow><TableCell>Name</TableCell><TableCell collapseBelow="sm">in 3 d</TableCell></TableRow></tbody></Table>)
  const host = document.createElement('div'); host.innerHTML = markup
  expect(host.querySelectorAll('th')).toHaveLength(2)
  expect(host.querySelectorAll('td')).toHaveLength(2)
  expect(host.querySelectorAll('[data-collapse-below="sm"]')).toHaveLength(2)
  expect(markup).not.toContain('collapseBelow=')
})


it('allows a qualified face badge to extend beyond the table lead', () => {
  const lead = element(renderToStaticMarkup(<table><tbody><TableRow><TableCell lead={<IconTile shape="face" badge="AL">A</IconTile>}>Alice</TableCell></TableRow></tbody></table>), 'table-cell-lead')
  expect(lead.querySelector('[data-slot="face-badge"]')?.textContent).toBe('AL')
  expect(lead.className).toContain('has-[[data-slot=face-badge]]:overflow-visible')
})

it('windows a thousand bare rows while spacers retain the full scroll extent', async () => {
  const { TableBody } = await import('./table')
  const markup = renderToStaticMarkup(<Table rows="bare"><TableBody window={{ top: 4400, height: 440, pitch: 44, columns: 1 }}>
    {Array.from({ length: 1000 }, (_, i) => <TableRow key={i}><TableCell>Row {i}</TableCell></TableRow>)}
  </TableBody></Table>)
  const body = element(markup, 'table-body')
  expect(body.querySelectorAll('[data-slot="table-row"]')).toHaveLength(20)
  expect(body.textContent).toContain('Row 95')
  expect(body.textContent).not.toContain('Row 94')
  expect(body.querySelectorAll('[aria-hidden="true"] td')[0]?.getAttribute('style')).toContain('height:4180px')
  expect(body.querySelectorAll('[aria-hidden="true"] td')[1]?.getAttribute('style')).toContain('height:38940px')
})
