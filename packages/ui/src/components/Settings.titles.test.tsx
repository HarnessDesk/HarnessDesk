import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { SettingsSection } from '../state/destinations'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { frameDestinationStore } from '../preview/frame-destination-store'
import { SettingsTestScope } from '../test-support/settings-page'
import { Settings } from './Settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each([
  ['profile', 'Profile'], ['general', 'General'], ['appearance', 'Appearance'],
  ['notifications', 'Notifications'], ['shortcuts', 'Keyboard shortcuts'],
  ['workspaces', 'Workspaces'], ['archive', 'Archive'], ['history', 'History'],
  ['storage', 'Storage'], ['runtimes', 'Runtimes'], ['models', 'Models'],
  ['skills', 'Skills'], ['extensions', 'Extensions'], ['permissions', 'Permissions'], ['browser', 'Browser'],
] as const)('%s names the page visibly above its content, with no title in the bar', async (section: SettingsSection, label) => {
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box), store = frameDestinationStore(previewStore())
  const route = { kind: 'section' as const, section, focus: null }
  store.openDestination({ kind: 'settings', route })
  try {
    await act(async () => root.render(<StoreProvider store={store}><SettingsTestScope>
      <Settings route={route} onRoute={() => {}} onSignIn={() => {}} />
    </SettingsTestScope></StoreProvider>))
    const page = box.querySelector('[data-slot="page"]')!
    const headings = page.querySelectorAll('h1')
    expect(headings).toHaveLength(1)
    expect(headings[0]?.textContent).toBe(label)
    expect(headings[0]?.classList.contains('sr-only')).toBe(false)
    expect(headings[0]?.getAttribute('data-role')).toBe('page')
    expect(page.firstElementChild).toBe(headings[0])
    expect(box.querySelector('[data-topbar-title]')?.textContent).toBe('')
  } finally {
    act(() => root.unmount())
    box.remove()
  }
})
