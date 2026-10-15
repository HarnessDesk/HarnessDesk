import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StoreProvider } from '../state/context'
import { installTopBarTestLayout } from '../test/top-bar-layout'
import { TeamFramePreview } from './TeamFramePreview'
import { overviewTeamStore } from './team-overview-fixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
installTopBarTestLayout()
it('uses the real shell with a Team rail independent of its tool pane', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), store = overviewTeamStore()
  store.setWindowSize(1440, 900)
  try {
    await act(async () => root.render(<StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider>))
    const shell = host.querySelector('[data-slot="fixed-shell"]')!
    expect(shell).not.toBeNull()
    expect(shell.getAttribute('data-rail-open')).toBe('true')
    expect(shell.querySelector('[data-frame-region="rail"] [data-slot="tool-section"]')).not.toBeNull()
    await act(async () => store.chooseWorkTool('changes'))
    expect(shell.getAttribute('data-right-open')).toBe('true')
    expect(shell.getAttribute('data-rail-open')).toBe('true')
    await act(async () => store.toggleWorkRail())
    expect(shell.getAttribute('data-rail-open')).toBe('false')
    expect(shell.getAttribute('data-right-open')).toBe('true')
  } finally { act(() => root.unmount()); host.remove() }
})
