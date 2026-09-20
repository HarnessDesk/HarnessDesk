import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { PopoverGroupLabel } from './Popover'

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

it('names the group-label role and can leave its inset to a containing row', () => {
  act(() => root.render(<PopoverGroupLabel inset={false}>Tasks · 3/3</PopoverGroupLabel>))

  const label = container.querySelector<HTMLElement>('[data-slot="group-label"]')
  expect(label?.textContent).toBe('Tasks · 3/3')
  expect(label?.dataset['inset']).toBe('false')
})
