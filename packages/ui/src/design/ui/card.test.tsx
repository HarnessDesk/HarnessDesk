import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Card } from './card'

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
