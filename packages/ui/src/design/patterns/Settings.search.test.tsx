import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { Search } from './Settings'

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

it('offers an accessible clear action only while the field has a value', () => {
  const onClear = vi.fn()
  const render = (value: string) => act(() => root.render(
    <Search
      value={value}
      onChange={() => {}}
      placeholder="Search history"
      clear={{ label: 'Clear the search', onClick: onClear }}
    />,
  ))

  render('')
  expect(container.querySelector('button')).toBeNull()
  render('needle')
  const clear = container.querySelector<HTMLButtonElement>('button[aria-label="Clear the search"]')
  expect(clear).not.toBeNull()
  act(() => clear?.click())
  expect(onClear).toHaveBeenCalledOnce()
})

it('mounts as a compact quiet filter without swallowing input events', () => {
  const onFocus = vi.fn()
  const onKeyDown = vi.fn()
  act(() => root.render(
    <Search
      value=""
      onChange={() => {}}
      placeholder="Filter sessions"
      size="compact"
      icon="filter"
      title="Narrow the list below."
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    />,
  ))

  const search = container.querySelector<HTMLElement>('[data-slot="search"]')
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')
  expect(search?.dataset['size']).toBe('compact')
  expect(search?.dataset['icon']).toBe('filter')
  expect(search?.querySelector('svg')?.classList.contains('lucide-funnel')).toBe(true)
  expect(input?.dataset['variant']).toBe('quiet')
  expect(input?.dataset['size']).toBe('compact')
  expect(input?.title).toBe('Narrow the list below.')
  act(() => {
    input?.focus()
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(onFocus).toHaveBeenCalledOnce()
  expect(onKeyDown).toHaveBeenCalledOnce()
})
