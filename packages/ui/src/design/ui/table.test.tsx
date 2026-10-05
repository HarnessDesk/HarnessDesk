import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { Table, TableCell, TableHead, TableRow } from './table'

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

it('keeps a collapsible column in the semantic table without leaking its policy prop', () => {
  const markup = renderToStaticMarkup(<Table><thead><TableRow><TableHead>Account</TableHead><TableHead collapseBelow="sm">Resets</TableHead></TableRow></thead><tbody><TableRow><TableCell>Name</TableCell><TableCell collapseBelow="sm">in 3 d</TableCell></TableRow></tbody></Table>)
  const host = document.createElement('div'); host.innerHTML = markup
  expect(host.querySelectorAll('th')).toHaveLength(2)
  expect(host.querySelectorAll('td')).toHaveLength(2)
  expect(host.querySelectorAll('[data-collapse-below="sm"]')).toHaveLength(2)
  expect(markup).not.toContain('collapseBelow=')
})
