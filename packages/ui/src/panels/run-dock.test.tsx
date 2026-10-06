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

import { act, StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PaneProvider, StoreProvider } from '../state/context'
import { RunDockProvider, RunDetailsView, RunStepsView } from './run-dock'
import { RunWorkspace } from '../components/RunWorkspace'
import { runTimeline } from '../lib/run-timeline'
import { runFixture } from '../preview/run-view-fixture'
import { previewStore } from '../preview/harness'
import { runDockStore } from '../preview/frames-run-dock'
import { dockViews, stacks } from '../state/workbench'
import { TeamRunView } from '../components/TeamRunView'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const activeRightKind = (store: ReturnType<typeof runDockStore>) => {
  const right = store.getSnapshot().workbench.right
  const active = new Set(stacks(right.root).flatMap(stack => stack.active ? [stack.active] : []))
  return dockViews(right).find(one => active.has(one.id))?.view.kind
}

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

it('closes a Run-only dock when its Run leaves the main pane', async () => {
  const store = runDockStore()
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture()
  const Producer = () => <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={() => {}}
    flow={<span>Flow</span>} inspector={{ input: fixture, seats: [] }} />
  const show = (mounted: boolean) => act(() => root.render(<StoreProvider store={store}><RunDockProvider>
    {mounted && <Producer />}<aside><RunDetailsView /><RunStepsView /></aside>
  </RunDockProvider></StoreProvider>))
  try {
    show(true)
    expect(store.getSnapshot().workbench.right.collapsed).toBe(false)
    show(false)
    await act(async () => { await Promise.resolve() })
    expect(store.getSnapshot().workbench.right.collapsed).toBe(true)
  } finally { act(() => root.unmount()) }
})

it('keeps the first Run dock open through StrictMode effect replay', async () => {
  const store = runDockStore()
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture()
  const Producer = () => <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={() => {}}
    flow={<span>Flow</span>} inspector={{ input: fixture, seats: [] }} />
  try {
    act(() => root.render(<StrictMode><StoreProvider store={store}><RunDockProvider>
      <Producer /><aside><RunDetailsView /><RunStepsView /></aside>
    </RunDockProvider></StoreProvider></StrictMode>))
    await act(async () => { await Promise.resolve() })
    expect(store.getSnapshot().workbench.right.collapsed).toBe(false)
  } finally { act(() => root.unmount()) }
})

it('re-adds a Run tab that was closed without making it active on return', () => {
  const store = runDockStore()
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture()
  const Producer = () => <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={() => {}}
    flow={<span>Flow</span>} inspector={{ input: fixture, seats: [] }} />
  const show = (mounted: boolean) => act(() => root.render(<StoreProvider store={store}><RunDockProvider>
    {mounted && <Producer />}<aside><RunDetailsView /><RunStepsView /></aside>
  </RunDockProvider></StoreProvider>))
  try {
    show(true)
    expect(activeRightKind(store)).toBe('run-details')
    const steps = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'run-steps')!
    act(() => store.closeView(steps.id))
    show(false)
    show(true)
    expect(dockViews(store.getSnapshot().workbench.right).some(one => one.view.kind === 'run-steps')).toBe(true)
    expect(activeRightKind(store)).toBe('run-details')
  } finally { act(() => root.unmount()) }
})

it('keeps a Run-only dock open when the Team switches to another Run', async () => {
  const store = runDockStore()
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture()
  const Producer = ({ runId }: { runId: string }) => {
    const execution = { ...fixture.execution, id: runId }
    const input = { ...fixture, execution }
    return <PaneProvider scope={{ paneId: 'dock-team', view: { kind: 'room', room: 'dock-team' }, sessionKey: null }}>
      <TeamRunView key={runId} execution={execution} origin={null} onOpenSeat={() => {}}
        model={runTimeline(input)} number={1} selectedRow={null} onSelect={() => {}} />
    </PaneProvider>
  }
  const show = (runId: string) => act(() => root.render(<StoreProvider store={store}><RunDockProvider>
    <Producer runId={runId} /><aside><RunDetailsView /><RunStepsView /></aside>
  </RunDockProvider></StoreProvider>))
  try {
    show('run-a')
    expect(store.getSnapshot().workbench.right.collapsed).toBe(false)
    show('run-b')
    await act(async () => { await Promise.resolve() })
    expect(store.getSnapshot().workbench.right.collapsed).toBe(false)
  } finally { act(() => root.unmount()) }
})

it('reopens a Run-only dock after leaving, unless the person hid it', async () => {
  const store = runDockStore()
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture()
  const Producer = () => <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={() => {}}
    flow={<span>Flow</span>} inspector={{ input: fixture, seats: [] }} />
  const show = (mounted: boolean) => act(() => root.render(<StoreProvider store={store}><RunDockProvider>
    {mounted && <Producer />}<aside><RunDetailsView /><RunStepsView /></aside>
  </RunDockProvider></StoreProvider>))
  const tick = () => act(async () => { await Promise.resolve() })
  try {
    show(true)
    show(false)
    await tick()
    expect(store.getSnapshot().workbench.right.collapsed).toBe(true)
    show(true)
    expect(store.getSnapshot().workbench.right.collapsed).toBe(false)

    act(() => store.togglePanel('right'))
    expect(store.getSnapshot().workbench.right.collapsed).toBe(true)
    show(false)
    await tick()
    show(true)
    expect(store.getSnapshot().workbench.right.collapsed).toBe(true)
  } finally { act(() => root.unmount()) }
})

it('restores the tab that was in front before the Run used the dock', async () => {
  const store = runDockStore()
  store.showViewIn('right', { kind: 'changes' })
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture()
  const Producer = () => <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={() => {}}
    flow={<span>Flow</span>} inspector={{ input: fixture, seats: [] }} />
  const show = (mounted: boolean) => act(() => root.render(<StoreProvider store={store}><RunDockProvider>
    {mounted && <Producer />}<aside><RunDetailsView /><RunStepsView /></aside>
  </RunDockProvider></StoreProvider>))
  try {
    expect(activeRightKind(store)).toBe('changes')
    show(true)
    expect(activeRightKind(store)).toBe('run-details')
    show(false)
    await act(async () => { await Promise.resolve() })
    const right = store.getSnapshot().workbench.right
    expect(dockViews(right).map(one => one.view.kind)).toEqual(['changes'])
    expect(activeRightKind(store)).toBe('changes')
  } finally { act(() => root.unmount()) }
})

it('does not change the dock when an unfocused Team mounts a Run', () => {
  const store = runDockStore()
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture()
  const Producer = () => <PaneProvider scope={{ paneId: 'background-team', view: { kind: 'room', room: 'background-team' }, sessionKey: null }}>
    <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={() => {}}
      inspector={{ input: fixture, seats: [] }} />
  </PaneProvider>
  try {
    act(() => root.render(<StoreProvider store={store}><RunDockProvider>
      <Producer /><aside><RunDetailsView /></aside>
    </RunDockProvider></StoreProvider>))
    expect(dockViews(store.getSnapshot().workbench.right)).toHaveLength(0)
    expect(store.getSnapshot().workbench.right.collapsed).toBe(false)
  } finally { act(() => root.unmount()) }
})

it('keeps the focused Run dock open when a background Team leaves', async () => {
  const store = runDockStore()
  const container = document.createElement('div')
  const root = createRoot(container)
  const fixture = runFixture()
  const Producer = ({ id }: { id: string }) => <PaneProvider scope={{ paneId: id, view: { kind: 'room', room: id }, sessionKey: null }}>
    <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={() => {}}
      inspector={{ input: fixture, seats: [] }} />
  </PaneProvider>
  const show = (background: boolean) => act(() => root.render(<StoreProvider store={store}><RunDockProvider>
    <Producer id="dock-team" />{background && <Producer id="background-team" />}
    <aside><RunDetailsView /><RunStepsView /></aside>
  </RunDockProvider></StoreProvider>))
  try {
    show(true)
    expect(store.getSnapshot().workbench.right.collapsed).toBe(false)
    show(false)
    await act(async () => { await Promise.resolve() })
    expect(store.getSnapshot().workbench.right.collapsed).toBe(false)
  } finally { act(() => root.unmount()) }
})
