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

it('treats the theme cards as one keyboard choice, keeping focus and selection together', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  let snapshot = { ...emptySnapshot(), theme: 'light' as const } as ReturnType<typeof emptySnapshot>
  const listeners = new Set<() => void>()
  const store = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    setTheme: (theme: typeof snapshot.theme) => { snapshot = { ...snapshot, theme }; for (const listener of listeners) listener() },
  } as unknown as AppStore
  const radios = () => [...host.querySelectorAll<HTMLElement>('[role="radio"]')]
  const selected = () => radios().find(radio => radio.getAttribute('aria-checked') === 'true')!
  const key = async (key: string) => {
    await act(async () => {
      const target = document.activeElement as HTMLElement
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
      // jsdom has no native button activation default for Space.
      if (key === ' ') target.click()
    })
  }
  try {
    await act(async () => root.render(<StoreProvider store={store}><ThemeCards /></StoreProvider>))
    expect(radios().filter(radio => radio.tabIndex === 0)).toEqual([selected()])
    act(() => selected().focus())
    for (const [pressed, theme] of [['ArrowRight', 'dark'], ['Home', 'dark'], ['End', 'dark'], ['ArrowLeft', 'light'], ['ArrowUp', 'system'], ['ArrowDown', 'light']] as const) {
      await key(pressed)
      expect(snapshot.theme).toBe(theme)
      expect(document.activeElement).toBe(selected())
    }
    // Space activates a focused radio, and the pointer can still pick any card.
    act(() => radios()[0]!.focus())
    await key(' ')
    expect(snapshot.theme).toBe('system')
    await act(async () => { radios()[2]!.focus(); radios()[2]!.click() })
    expect(snapshot.theme).toBe('dark')
    expect(radios().filter(radio => radio.tabIndex === 0)).toEqual([selected()])
  } finally { act(() => root.unmount()); host.remove() }
})
