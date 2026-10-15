import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { AppearanceSection } from './SettingsYou'

vi.mock('../editor/CodeView', () => ({ CodeView: ({ minimap }: { minimap?: boolean }) => <div data-sample-minimap={String(minimap)} /> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('offers an off-by-default Minimap switch and persists both choices with editor preferences', async () => {
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockResolvedValue(null as never)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<StoreProvider store={store}><AppearanceSection /></StoreProvider>))
    const toggle = host.querySelector<HTMLElement>('[role="switch"][aria-label="Minimap"]')
    expect(toggle).not.toBeNull()
    expect(toggle!.getAttribute('aria-checked')).toBe('false')
    expect(host.querySelector('[data-sample-minimap]')?.getAttribute('data-sample-minimap')).toBe('false')
    for (const minimap of [true, false]) {
      await act(async () => {
        toggle!.click()
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      })
      expect(store.getSnapshot().editorPrefs.minimap).toBe(minimap)
      expect(host.querySelector('[role="switch"][aria-label="Minimap"]')?.getAttribute('aria-checked')).toBe(String(minimap))
      expect(host.querySelector('[data-sample-minimap]')?.getAttribute('data-sample-minimap')).toBe(String(minimap))
      expect(request).toHaveBeenLastCalledWith('app/state/set', { patch: { editorPrefs: expect.objectContaining({ minimap }) } })
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
