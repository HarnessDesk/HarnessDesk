import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Card } from './card'
import { Table, TableCaption, TableCell, TableFooter, TableHead, TableRow } from './table'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('draws an unavailable card as a quiet dashed surface', () => {
  act(() => root.render(<Card variant="muted">No reading</Card>))
  const card = container.firstElementChild as HTMLElement | null
  expect(card?.dataset['variant']).toBe('muted')
  expect(card?.className).toContain('border-dashed')
  expect(card?.className).toContain('bg-(--hd-muted)')
})

it('draws a flush card for content that owns its internal rhythm', () => {
  act(() => root.render(<Card variant="flush">Diff contents</Card>))
  const card = container.firstElementChild as HTMLElement | null
  expect(card?.dataset['variant']).toBe('flush')
  expect(card?.className).toContain('gap-0')
  expect(card?.className).toContain('py-0')
  expect(card?.className).toContain('overflow-hidden')
})

it('offers the framed matrix table anatomy without changing the default table', () => {
  act(() =>
    root.render(
      <Table variant="framed">
        <TableCaption variant="sr-only">Reach by agent</TableCaption>
        <thead>
          <TableRow variant="matrix">
            <TableHead variant="matrix" pinned>Name</TableHead>
            <TableHead variant="matrix" align="center">Agent</TableHead>
          </TableRow>
        </thead>
        <tbody>
          <TableRow variant="matrix" interactive data-state="selected">
            <TableHead variant="row" pinned>Skill</TableHead>
            <TableCell variant="matrix">Loaded</TableCell>
          </TableRow>
          <TableRow variant="matrix">
            <TableCell variant="detail" colSpan={2}>Copies</TableCell>
          </TableRow>
        </tbody>
        <TableFooter variant="plain">
          <TableRow variant="matrix">
            <TableHead variant="footer">Advertised each turn</TableHead>
            <TableCell variant="footer">≈120 tok</TableCell>
          </TableRow>
        </TableFooter>
      </Table>,
    ),
  )

  expect(container.querySelector('[data-slot="table-container"]')?.getAttribute('data-variant')).toBe('framed')
  expect(container.querySelector('[data-slot="table-caption"]')?.getAttribute('data-variant')).toBe('sr-only')
  expect(container.querySelector('[data-slot="table-head"][data-pinned]')).not.toBeNull()
  expect(container.querySelector('[data-slot="table-head"][data-align="center"]')?.className).toContain('text-center')
  expect(container.querySelector('[data-slot="table-row"][data-state="selected"]')?.hasAttribute('data-interactive')).toBe(true)
  expect(container.querySelector('[data-slot="table-row"][data-state="selected"]')?.className).toContain('data-[state=selected]:bg-(--hd-hover)')
  expect(container.querySelector('[data-slot="table-head"][data-variant="row"]')?.className).toContain('group-hover/matrix:bg-(--hd-hover)')
  expect(container.querySelector('[data-slot="table-cell"][data-variant="detail"]')?.className).toContain('px-3')
  expect(container.querySelector('[data-slot="table-footer"]')?.getAttribute('data-variant')).toBe('plain')
})
