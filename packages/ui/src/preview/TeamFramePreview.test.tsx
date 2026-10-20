import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StoreProvider } from '../state/context'
import { installTopBarTestLayout } from '../test/top-bar-layout'
import { TeamFramePreview } from './TeamFramePreview'
import { overviewTeamStore } from './team-overview-fixture'
import { flowOverlayRig } from './flow-overlay-fixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
installTopBarTestLayout()
it('uses the real shell with a retained Team rail that yields to a tool until revealed', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), store = overviewTeamStore()
  store.setWindowSize(1440, 900)
  try {
    await act(async () => root.render(<StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider>))
    const shell = host.querySelector('[data-slot="fixed-shell"]')!
    expect(shell).not.toBeNull()
    expect(shell.getAttribute('data-rail-open')).toBe('true')
    const record = shell.querySelector('[data-frame-region="rail"] [data-slot="tool-section"]')
    expect(record).not.toBeNull()
    await act(async () => store.chooseWorkTool('changes'))
    expect(shell.getAttribute('data-right-open')).toBe('true')
    expect(shell.getAttribute('data-rail-open')).toBe('false')
    await act(async () => store.toggleWorkRail())
    expect(shell.getAttribute('data-rail-open')).toBe('true')
    expect(shell.getAttribute('data-right-open')).toBe('true')
    expect(shell.querySelector('[data-frame-region="rail"] [data-slot="tool-section"]')).toBe(record)
  } finally { act(() => root.unmount()); host.remove() }
})

it('does not own window commands or mount another sidebar', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), store = overviewTeamStore()
  const before = store.getSnapshot().workbench
  try {
    await act(async () => root.render(<StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider>))
    const staged = store.getSnapshot().workbench
    expect(staged.main).not.toBe(before.main)
    expect(host.querySelector('[data-left-column]')).toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true })))
    expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
    await act(async () => window.dispatchEvent(new Event('harnessdesk:review')))
    expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
  } finally { act(() => root.unmount()); host.remove() }
})

it('keeps the selected Team and tool when the fake host pushes', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), rig = flowOverlayRig()
  try {
    await act(async () => root.render(<StoreProvider store={rig.store}><TeamFramePreview room="overlay-team" view={{ kind: 'room', room: 'overlay-team', framePage: 'run' }} /></StoreProvider>))
    await act(async () => rig.store.chooseWorkTool('changes'))
    const before = rig.store.getSnapshot().workbench
    await act(async () => rig.advance('review'))
    expect(rig.store.getSnapshot().workbench).toBe(before)
    expect(host.querySelector('[data-slot="team-room"]')).not.toBeNull()
  } finally { act(() => root.unmount()); host.remove() }
})
