import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Rows } from '../patterns/Settings'
import css from '../patterns/Settings.module.css?raw'
import { EmptyState } from './empty-state'

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

const draw = (node: ReactNode): HTMLElement => {
  act(() => root.render(node))
  const found = container.querySelector<HTMLElement>('[data-slot="empty-state"]')
  if (!found) throw new Error('no empty state rendered')
  return found
}

it('keeps the centred panel as the default, so existing callers do not move', () => {
  const panel = draw(<EmptyState icon={<svg data-testid="icon" />} title="Nothing in the background" description="Work that outlives a turn is listed here." />)
  expect(panel.dataset['variant']).toBe('panel')
  expect(panel.className).toContain('items-center')
  expect(panel.className).toContain('text-center')
  expect(panel.querySelector('h3')?.textContent).toBe('Nothing in the background')
  expect(panel.querySelector('[data-testid="icon"]')).not.toBeNull()
})

it('draws inline as one muted line with no icon and no heading', () => {
  const line = draw(<EmptyState variant="inline" icon={<svg data-testid="icon" />} title="Nothing here." description="Cards land here when claimed." />)
  expect(line.tagName).toBe('P')
  expect(line.dataset['variant']).toBe('inline')
  expect(line.className).toContain('text-(--hd-muted-foreground)')
  expect(line.querySelector('[data-testid="icon"]')).toBeNull()
  expect(line.querySelector('h3')).toBeNull()
  expect(line.textContent).toBe('Nothing here. Cards land here when claimed.')
})

it('sits as a row inside a Rows card, with the row’s own anatomy and a quieter title', () => {
  const row = draw(
    <Rows>
      <EmptyState variant="row" icon={<svg data-testid="icon" />} title="No rules yet" description="Every request reaches you.">
        <button type="button">Add a rule</button>
      </EmptyState>
    </Rows>,
  )
  expect(row.dataset['variant']).toBe('row')
  // The Row's own classes: same padding and hairline as every other row in the card.
  expect(row.className).toMatch(/row/)
  expect(row.parentElement?.className).toMatch(/rows/)
  expect(row.querySelector('[data-testid="icon"]')).not.toBeNull()
  expect(row.textContent).toContain('No rules yet')
  expect(row.textContent).toContain('Every request reaches you.')
  expect(row.querySelector('button')?.textContent).toBe('Add a rule')
  expect(css).toMatch(/\.row\[data-slot='empty-state'\] \.rowTitle\s*\{[^}]*font-weight:\s*var\(--hd-weight-normal\)[^}]*color:\s*var\(--hd-secondary-foreground\)/s)
})

it('lets a caller keep its own slot name on the inline line', () => {
  const line = container
  act(() => root.render(<EmptyState variant="inline" data-slot="board-empty" title="Nothing here" />))
  const empty = line.querySelector<HTMLElement>('[data-slot="board-empty"]')
  expect(empty?.dataset['variant']).toBe('inline')
  expect(empty?.textContent).toBe('Nothing here')
})
