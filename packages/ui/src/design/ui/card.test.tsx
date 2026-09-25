import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Card, CardViewport } from './card'
import { KeyValue, KeyValueRow } from './key-value'
import { Section, SectionBody } from './section'
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

it('preserves the larger card radius and compact section inset as named variants', () => {
  act(() => root.render(
    <>
      <Card radius="lg">Configuration</Card>
      <Section variant="quiet"><SectionBody spacing="compact">Grant</SectionBody></Section>
    </>,
  ))
  const card = container.querySelector<HTMLElement>('[data-slot="card"]')
  const body = container.querySelector<HTMLElement>('[data-slot="section-body"]')
  expect(card?.dataset['radius']).toBe('lg')
  expect(card?.className).toContain('rounded-(--hd-radius-lg)')
  expect(body?.dataset['spacing']).toBe('compact')
  expect(body?.className).toContain('py-3')
  expect(body?.className).toContain('px-3')
})

it('offers the small system radius for compact code and diff plates', () => {
  act(() => root.render(<Card variant="flush" radius="sm">Patch</Card>))
  const card = container.querySelector<HTMLElement>('[data-slot="card"]')
  expect(card?.dataset['radius']).toBe('sm')
  expect(card?.className).toContain('rounded-(--hd-radius-sm)')
})

it('owns the compact inset and rhythm of a dense report card', () => {
  act(() => root.render(<Card spacing="compact">Flow report</Card>))
  const card = container.querySelector<HTMLElement>('[data-slot="card"]')
  expect(card?.dataset['spacing']).toBe('compact')
  expect(card?.className).toContain('gap-2')
  expect(card?.className).toContain('p-3')
  expect(card?.className).not.toContain('py-4')
})

it('owns the fixed preview viewport inside a card', () => {
  act(() => root.render(<CardViewport size="editor">Preview</CardViewport>))
  const viewport = container.querySelector<HTMLElement>('[data-slot="card-viewport"]')
  expect(viewport?.dataset['size']).toBe('editor')
  expect(viewport?.className).toContain('h-44')
})

it('owns the compact panel section and key-value readings', () => {
  act(() => root.render(
    <Section variant="panel">
      <KeyValue variant="panel">
        <KeyValueRow variant="panel" label="Branch">main</KeyValueRow>
      </KeyValue>
    </Section>,
  ))
  expect(container.querySelector('[data-slot="section"]')?.getAttribute('data-variant')).toBe('panel')
  expect(container.querySelector('[data-slot="section"]')?.className).toContain('border-t')
  expect(container.querySelector('[data-slot="key-value"]')?.getAttribute('data-variant')).toBe('panel')
  expect(container.querySelector('[data-slot="key-value-row"]')?.getAttribute('data-variant')).toBe('panel')
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

it('owns the compact plugin-panel table variant', () => {
  act(() => root.render(
    <Table variant="panel">
      <TableCaption variant="panel">Files</TableCaption>
      <tbody><TableRow variant="panel"><TableCell variant="panel">src/app.ts</TableCell></TableRow></tbody>
    </Table>,
  ))
  expect(container.querySelector('[data-slot="table-container"]')?.getAttribute('data-variant')).toBe('panel')
  expect(container.querySelector('[data-slot="table-caption"]')?.getAttribute('data-variant')).toBe('panel')
  expect(container.querySelector('[data-slot="table-cell"]')?.getAttribute('data-variant')).toBe('panel')
  expect(container.querySelector('[data-slot="table-row"]')?.getAttribute('data-variant')).toBe('panel')
})

it('draws the plate card from the app card family, with its hairline inside the box', () => {
  act(() => root.render(<Card variant="plate" spacing="compact">Edited 2 files</Card>))
  const card = container.firstElementChild as HTMLElement | null
  expect(card?.dataset['variant']).toBe('plate')
  expect(card?.className).toContain('bg-(--hd-card-fill,var(--hd-card))')
  expect(card?.className).toContain('rounded-(--hd-card-radius,var(--hd-radius-lg))')
  expect(card?.className).toContain('shadow-[inset_0_0_0_1px_var(--hd-card-border,var(--hd-border-strong))]')
  expect(card?.className).toContain('border-0')
  /* The registry card's own ground and edge are replaced, not stacked. */
  expect(card?.className).not.toMatch(/(^|\s)bg-card(\s|$)/)
  expect(card?.className).not.toMatch(/(^|\s)border(\s|$)/)
  expect(card?.className).toContain('p-3')
})

it('bounds a lines viewport at the height it is given, and scrolls past it', () => {
  act(() => root.render(<CardViewport size="lines" maxHeight={96}>code</CardViewport>))
  const viewport = container.querySelector<HTMLElement>('[data-slot="card-viewport"]')
  expect(viewport?.dataset['size']).toBe('lines')
  expect(viewport?.style.maxHeight).toBe('96px')
  expect(viewport?.className).toContain('overflow-auto')
  expect(viewport?.className).not.toContain('h-44')
})

it('sets a cell flush right in figures when its column is aligned to the end', () => {
  act(() => root.render(
    <table><tbody><TableRow><TableCell>name</TableCell><TableCell align="end">12</TableCell></TableRow></tbody></table>,
  ))
  const [start, end] = [...container.querySelectorAll<HTMLElement>('[data-slot="table-cell"]')]
  expect(start?.dataset['align']).toBe('start')
  expect(start?.className).not.toContain('text-right')
  expect(end?.dataset['align']).toBe('end')
  expect(end?.className).toContain('text-right')
  expect(end?.className).toContain('tabular-nums')
})

it('caps a panel section at the column\'s allotment for panels', () => {
  act(() => root.render(<Section variant="panel">panel</Section>))
  expect(container.querySelector('[data-slot="section"]')?.className).toContain('max-h-(--panel-max,none)')
  act(() => root.render(<Section variant="plain">plain</Section>))
  expect(container.querySelector('[data-slot="section"]')?.className).not.toContain('max-h-')
})
