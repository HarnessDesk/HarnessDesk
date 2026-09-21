import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Spinner } from './Settings'

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

it('is a named running-operation mark', () => {
  act(() => root.render(<Spinner size="sm" tone="brand" aria-hidden />))

  const spinner = container.querySelector<HTMLElement>('[data-slot="spinner"]')
  expect(spinner?.dataset['size']).toBe('sm')
  expect(spinner?.dataset['tone']).toBe('brand')
  expect(spinner?.getAttribute('aria-hidden')).toBe('true')
  expect(spinner?.className).toContain('animate-spin')
  expect(spinner?.className).toContain('border-t-(--hd-primary)')
})
