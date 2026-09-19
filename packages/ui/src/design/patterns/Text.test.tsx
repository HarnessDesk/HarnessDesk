import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Text } from './Settings'

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

it('names its role and carries tone, truncation, and numeric semantics', () => {
  act(() =>
    root.render(
      <Text as="strong" role="figure" tone="warning" truncate numeric>
        12%
      </Text>,
    ),
  )
  const text = container.firstElementChild as HTMLElement | null
  expect(text?.tagName).toBe('STRONG')
  expect(text?.dataset['slot']).toBe('text')
  expect(text?.dataset['role']).toBe('figure')
  expect(text?.dataset['tone']).toBe('warning')
  expect(text?.className).toContain('text-(--hd-warning-ink)')
  expect(text?.className).not.toContain('text-(--hd-foreground)')
  expect(text?.className).toContain('truncate')
  expect(text?.className).toContain('tabular-nums')
})
