import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { DesktopBridge } from '../lib/desktop'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { frameDestinationStore } from '../preview/frame-destination-store'
import { SettingsTestScope } from '../test-support/settings-page'
import { Settings } from './Settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('global Browser Settings clears all conversation panes through its explicit bridge action', async () => {
  const clearAll = vi.fn(async () => {})
  const clearProfile = vi.fn(async () => {})
  const previous = window.harnessdesk
  window.harnessdesk = { platform: 'darwin', browserReady: vi.fn(), clearBrowserData: clearProfile, clearAllBrowserData: clearAll } as unknown as DesktopBridge
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box), store = frameDestinationStore(previewStore())
  const route = { kind: 'section' as const, section: 'browser' as const, focus: null }
  store.openDestination({ kind: 'settings', route })
  try {
    await act(async () => root.render(<StoreProvider store={store}><SettingsTestScope>
      <Settings route={route} onRoute={() => {}} onSignIn={() => {}} />
    </SettingsTestScope></StoreProvider>))
    const button = [...box.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Clear')!
    await act(async () => button.click())
    expect(clearAll).toHaveBeenCalledTimes(1)
    expect(clearProfile).not.toHaveBeenCalled()
    expect(box.textContent).toContain('all conversation browser panes')
  } finally {
    act(() => root.unmount())
    box.remove()
    window.harnessdesk = previous
  }
})
