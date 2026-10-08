import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { PopoverSurface } from './Popover'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let input: HTMLTextAreaElement | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  input?.remove()
  input = undefined
})

it('exposes the canonical floating surface to composite pickers', () => {
  act(() => root.render(<PopoverSurface role="listbox" limit="trigger">Commands</PopoverSurface>))
  const surface = container.querySelector('[data-slot="popover-surface"]')
  expect(surface?.getAttribute('role')).toBe('listbox')
  expect(surface?.getAttribute('data-limit')).toBe('trigger')
  expect(surface?.textContent).toBe('Commands')
})

it('positions an anchored picker outside its scrolling parent without taking typing focus', async () => {
  input = document.createElement('textarea')
  container.before(input)
  input.focus()
  const anchor = { current: input }
  await act(async () => root.render(
    <PopoverSurface {...{ anchor }} role="listbox" limit="trigger">Recipients</PopoverSurface>,
  ))
  expect(container.querySelector('[data-slot="popover-surface"]')).toBeNull()
  expect(document.body.querySelector('[data-slot="popover-surface"]')?.textContent).toBe('Recipients')
  expect(document.activeElement).toBe(input)
})
