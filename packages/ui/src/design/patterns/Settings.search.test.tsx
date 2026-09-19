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
