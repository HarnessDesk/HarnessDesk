import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { PluginsSection } from './PluginsSection'
import { MAIN_PAGE_ENTRIES } from '../app/main-page-entries'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('E7 registers Plugins as a main destination', () => {
  expect(MAIN_PAGE_ENTRIES.plugins).toBeTypeOf('function')
})
it('E7 missing detail replaces only the active Plugins route without a visit', async () => {
  const store = new AppStore('ws://localhost:0/')
  store.openDestination({ kind: 'plugins', section: 'installed', id: 'missing' })
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  const visit = vi.fn()
  const render = (active: boolean) => act(async () => root.render(<StoreProvider store={store}><TopBarProvider>
    <DestinationPageScope owner="destination:plugins" active={active}>
      <PluginsSection {...{ section: 'installed' as const, id: 'missing', onSection: visit, onPlugin: visit }} />
    </DestinationPageScope><TopBarOutlet owner="destination:plugins" fallback={{ place: 'New session', more: () => null }} />
  </TopBarProvider></StoreProvider>))
  try {
    await render(false)
    expect(store.getSnapshot().workbench.navigation.current).toMatchObject({ id: 'missing' })
    const back = store.getSnapshot().workbench.navigation.back
    await render(true)
    expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'plugins', section: 'installed', id: null })
    expect(store.getSnapshot().workbench.navigation.back).toEqual(back)
    expect(visit).not.toHaveBeenCalled()
  } finally { act(() => root.unmount()); box.remove() }
})
