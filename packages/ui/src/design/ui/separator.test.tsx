import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { Separator } from './separator'

test('bar length uses foundation divider geometry without changing the ordinary separator', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<Separator orientation="vertical" length="bar" data-slot="bar-divider" />))
    const bar = container.querySelector('[data-slot="bar-divider"]')!
    expect(bar.getAttribute('data-orientation')).toBe('vertical')
    expect(bar.className).toContain('h-[var(--hd-bar-divider-h)]')
    expect(bar.className).toContain('w-[var(--hd-border-width)]')
    expect(bar.className).not.toContain('h-full')
    act(() => root.render(<Separator orientation="vertical" />))
    expect(container.querySelector('[data-slot="separator"]')?.className).toContain('data-[orientation=vertical]:h-full')
  } finally {
    act(() => root.unmount())
  }
})
