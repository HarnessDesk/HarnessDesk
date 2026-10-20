import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { installTopBarTestLayout } from '../test/top-bar-layout'
import { SideBySideFrames } from './frames-side-by-side'

vi.mock('./main', () => ({ Frame: ({ children }: { children: React.ReactNode }) => children }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
installTopBarTestLayout()

it('opens the dedicated Split preview on its tiles instead of the default Work page', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<SideBySideFrames comparisonOnly scene="before" />))
    expect(container.querySelector('[data-slot="side-by-side-grid"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(2)
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Chat')
  } finally { act(() => root.unmount()); container.remove() }
})
