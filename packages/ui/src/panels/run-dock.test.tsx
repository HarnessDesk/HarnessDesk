import { expect, it } from 'vitest'
import { readView, sameView, type Layout } from '../state/layout'
import { permits, views } from './views'
import './builtins'

it('registers both Run inspectors as movable dock views using the shared chrome', () => {
  for (const kind of ['run-details', 'run-steps'] as const) {
    const definition = views.get(kind as Parameters<typeof views.get>[0])
    expect(definition?.label).toBe(kind === 'run-details' ? 'Run details' : 'Steps')
    expect(definition?.ownsChrome).not.toBe(true)
    expect(definition?.defaultMount).toBe('right')
    expect(definition?.mounts).toEqual(['right', 'bottom', 'sidebar'])
    const value = readView({ kind })
    expect(value.kind).toBe(kind)
    expect(sameView(value, readView({ kind }))).toBe(true)
    expect(permits(value, 'main')).toBe(false)
  }
})

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PaneProvider, StoreProvider } from '../state/context'
import { RunDockProvider, RunDetailsView, RunStepsView } from './run-dock'
import { RunWorkspace } from '../components/RunWorkspace'
import { runTimeline } from '../lib/run-timeline'
import { runFixture } from '../preview/run-view-fixture'
import { previewStore } from '../preview/harness'
import { runDockStore } from '../preview/frames-run-dock'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('publishes beside main, preserves a hidden dock during updates, and clears on leaving the Run', () => {
  const store = runDockStore()
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture()
  const Producer = ({ brief }: { brief: string }) => {
    const [selected, select] = useState<string | null>(null)
    const input = { ...fixture, execution: { ...fixture.execution, brief } }
    return <main><RunWorkspace model={runTimeline(input)} number={1} selectedRow={selected} onSelect={select}
      flow={<span>Flow</span>} inspector={{ input, seats: [] }} /></main>
  }
  const show = (mounted: boolean, brief = 'A recorded brief') => act(() => root.render(<StoreProvider store={store}>
    <RunDockProvider>{mounted && <Producer brief={brief} />}<aside><RunDetailsView /><RunStepsView /></aside></RunDockProvider>
  </StoreProvider>))
  try {
    show(true)
    expect(container.querySelector('main [data-slot="run-inspector"]')).toBeNull()
    expect(container.querySelector('aside')?.textContent).toContain('A recorded brief')
    act(() => store.togglePanel('right'))
    expect(store.getSnapshot().workbench.right.collapsed).toBe(true)
    show(true, 'The updated brief')
    expect(container.querySelector('aside')?.textContent).toContain('The updated brief')
    expect(store.getSnapshot().workbench.right.collapsed).toBe(true)
    show(false)
    expect(container.querySelector('[data-slot="run-inspector"]')).toBeNull()
    expect(container.querySelector('[data-slot="run-steps"]')).toBeNull()
    expect(container.textContent).toContain('Open a Team’s Run')
    show(true, 'Another Run')
    expect(container.querySelector('aside')?.textContent).toContain('Another Run')
    expect(container.textContent).not.toContain('The updated brief')
  } finally { act(() => root.unmount()) }
})


it('keeps a background Team from replacing the focused Run in the shared dock', () => {
  const snapshot = runDockStore().getSnapshot()
  const main: Layout = { ...snapshot.workbench.main, root: { kind: 'split', id: 'two-teams', direction: 'row', ratio: 0.5,
    first: snapshot.workbench.main.root, second: { kind: 'pane', id: 'other-team', view: { kind: 'room', room: 'other-team' } } } }
  const store = previewStore({ ...snapshot, layout: main, workbench: { ...snapshot.workbench, main } })
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture()
  const Producer = ({ id, brief }: { id: string; brief: string }) => <PaneProvider scope={{ paneId: id, view: { kind: 'room', room: id }, sessionKey: null }}>
    <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={() => {}}
      inspector={{ input: { ...fixture, execution: { ...fixture.execution, brief } }, seats: [] }} />
  </PaneProvider>
  try {
    act(() => root.render(<StoreProvider store={store}><RunDockProvider>
      <Producer id="dock-team" brief="The focused Run" /><Producer id="other-team" brief="A background Run" />
      <aside><RunDetailsView /></aside>
    </RunDockProvider></StoreProvider>))
    expect(container.querySelector('aside')?.textContent).toContain('The focused Run')
    expect(container.querySelector('aside')?.textContent).not.toContain('A background Run')
    act(() => store.focusPane('other-team'))
    expect(container.querySelector('aside')?.textContent).toContain('A background Run')
    expect(container.querySelector('aside')?.textContent).not.toContain('The focused Run')
    act(() => store.focusPane('dock-team'))
    expect(container.querySelector('aside')?.textContent).toContain('The focused Run')
  } finally { act(() => root.unmount()) }
})
