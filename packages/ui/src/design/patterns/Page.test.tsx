import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'

import { Page } from './Page'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(['reading', 'wide', 'canvas'] as const)('keeps the %s page gutter on all four sides', (width) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<Page width={width}>content</Page>))
    const page = container.firstElementChild as HTMLElement
    expect(page.dataset['width']).toBe(width)
    expect(page.dataset['inset']).toBe(width === 'canvas' ? 'canvas' : 'reading')
    expect(page.style.padding).toBe(width === 'canvas' ? 'var(--hd-space-2) var(--hd-space-2)' : 'var(--hd-space-6) var(--hd-space-6)')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
