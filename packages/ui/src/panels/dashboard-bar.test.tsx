import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { TopBarProvider, TopBarOutlet } from './top-bar'
import { DestinationPageScope } from './destination-page'
import { DashboardBar } from './dashboard-bar'
import { PageOptions } from '../design'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { installTopBarTestLayout } from '../test/top-bar-layout'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
installTopBarTestLayout()

test('five Dashboard views start the body; the permanent bar holds only its title', async () => {
  const node = document.createElement('div'); document.body.append(node)
  const root = createRoot(node), changeView = vi.fn(), refresh = vi.fn()
  try {
    await act(async () => root.render(<StoreProvider store={previewStore()}><TopBarProvider>
      <DestinationPageScope owner="destination:dashboard" active>
        <DashboardBar view="overview" attention={2} changeView={changeView} />
        <PageOptions choices={[{ id: 'scope', label: 'Scope the dashboard to one account', value: '', mode: 'menu',
          items: [{ value: '', label: 'All accounts' }], change: () => {} }]}
          read="Read just now" action={{ label: 'Refresh', run: refresh }} />
      </DestinationPageScope>
      <TopBarOutlet owner="destination:dashboard" fallback={{ place: 'Dashboard', more: () => null }} />
    </TopBarProvider></StoreProvider>))
    expect(node.querySelectorAll('[role="tab"]')).toHaveLength(5)
    const spend = [...node.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === 'Spend')!
    act(() => spend.click()); expect(changeView).toHaveBeenCalledWith('spend')
    const refreshButton = [...node.querySelectorAll<HTMLButtonElement>('[data-slot="page-options"] button')].find(button => button.textContent === 'Refresh')!
    act(() => refreshButton.click()); expect(refresh).toHaveBeenCalledOnce()
    expect(node.querySelector('[data-slot="page-options"]')?.textContent).toContain('All accounts')
    expect(node.querySelector('[data-slot="top-bar"]')?.textContent).not.toContain('Refresh')
    expect(node.querySelector('[data-slot="top-bar"] [role="tab"]')).toBeNull()
    expect(node.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Dashboard views')
    expect(node.querySelector('[data-topbar="view"] button')).toBeNull()
  } finally { await act(async () => root.unmount()); node.remove() }
})
