import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ThemeCards } from './AppearancePreview'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(['light', 'dark'] as const)('keeps each miniature selection in its own neutral palette from a %s app', theme => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const snapshot = { ...emptySnapshot(), theme }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  try {
    act(() => root.render(<StoreProvider store={store}><ThemeCards /></StoreProvider>))
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(3)
    const groups = [...host.querySelectorAll('svg g')]
    expect(groups).toHaveLength(4)
    for (const group of groups) {
      const selected = group.querySelector('rect[x="10"][y="30"]')!.getAttribute('fill')
      expect(selected).toBe(group.querySelector('rect[x="186"][y="118"]')!.getAttribute('fill'))
      expect(selected).not.toBe(group.querySelector('rect[x="0"][width="64"]')!.getAttribute('fill'))
    }
  } finally { act(() => root.unmount()); host.remove() }
})
