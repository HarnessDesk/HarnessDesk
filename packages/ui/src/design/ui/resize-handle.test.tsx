import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ResizeHandle } from './resize-handle'

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

it('offers a full-line seam without changing separator semantics', () => {
  act(() => root.render(
    <ResizeHandle
      appearance="line"
      orientation="vertical"
      value={0.5}
      onChange={vi.fn()}
    />,
  ))

  const handle = container.querySelector<HTMLElement>('[data-slot="resize-handle"]')
  expect(handle?.dataset['appearance']).toBe('line')
  expect(handle?.getAttribute('role')).toBe('separator')
  expect(handle?.className).toContain('bg-(--hd-border)')
  expect(handle?.className).toContain('hover:bg-(--hd-accent)')
  expect(handle?.querySelector('[aria-hidden="true"]')).toBeNull()
})
