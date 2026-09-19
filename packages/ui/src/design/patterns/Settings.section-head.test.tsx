import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { SectionHead } from './Settings'

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

it('owns the opaque sticky group-label surface', () => {
  act(() => root.render(<SectionHead name="What is left" action={<button>Range</button>} sticky />))
  const head = container.firstElementChild as HTMLElement | null
  expect(head?.dataset['sticky']).toBe('')
  expect(head?.textContent).toBe('What is leftRange')
})
