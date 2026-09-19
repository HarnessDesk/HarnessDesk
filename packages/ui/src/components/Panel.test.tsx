import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { PanelFilter } from './Panel'

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

it('uses the shared search field for an inspector filter', () => {
  act(() => root.render(<PanelFilter value="" placeholder="Filter files" onChange={() => {}} />))
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')
  expect(input?.type).toBe('search')
  expect(input?.closest('[data-slot="search"]')).not.toBeNull()
})
