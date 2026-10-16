import { installTopBarTestLayout } from '../test/top-bar-layout'
import { StrictMode, act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RunWorkspace } from '../components/RunWorkspace'
import { RunInspector } from '../components/RunInspector'
import { runTimeline } from '../lib/run-timeline'
import { runFixture } from '../preview/run-view-fixture'
import { runDockStore } from '../preview/frames-run-dock'
import { PaneProvider, StoreProvider } from '../state/context'
import { views } from './views'
import { RunDockProvider, RunDetailsView, useRunDock } from './run-dock'
import { TopBarProvider, WorkViewControlsOutlet, TopBarOutlet } from './top-bar'
import { RECORD_REASON } from '../lib/team-record'
import './builtins'

installTopBarTestLayout()

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const scope = (owner: string) => ({ paneId: owner, view: { kind: 'room' as const, room: owner }, sessionKey: null })

it('keeps Run details as a compatibility tool but declares no Steps mount', () => {
  expect(views.get('run-details')).toBeDefined()
  expect(views.get('run-steps')).toBeUndefined()
})

it('publishes inspection without opening or replacing the right tool', () => {
  const store = runDockStore()
  const fixture = runFixture()
  const container = document.createElement('div')
  const root = createRoot(container)
  const before = store.getSnapshot().workbench.right
  try {
    act(() => root.render(<StoreProvider store={store}><TopBarProvider><RunDockProvider>
      <PaneProvider scope={scope('dock-team')}>
        <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={() => {}}
          inspector={{ input: fixture, seats: [] }} />
      </PaneProvider>
    </RunDockProvider></TopBarProvider></StoreProvider>))
    expect(store.getSnapshot().workbench.right).toEqual(before)
    expect(container.querySelector('[data-slot="run-header"]')).toBeNull()
    expect(container.querySelector('[data-slot="run-steps"]')).not.toBeNull()
  } finally { act(() => root.unmount()); container.remove() }
})

it.each([false, true])('preserves the chosen tool and visibility through mount, Run update and cleanup (closed: %s)', closed => {
  const store = runDockStore()
  store.chooseWorkTool('activity', 'activity')
  if (closed) store.toggleWorkPanel()
  const before = store.getSnapshot().workbench
  const container = document.createElement('div'), root = createRoot(container)
  const source = runFixture()
  const show = (mounted: boolean, id = source.execution.id) => act(() => root.render(<StrictMode><StoreProvider store={store}><TopBarProvider><RunDockProvider>
    <PaneProvider scope={scope('dock-team')}>
      {mounted && <RunWorkspace model={runTimeline(source)} number={1} selectedRow={null} onSelect={() => {}}
        inspector={{input:{...source,execution:{...source.execution,id}},seats:[]}} />}
      <aside><RunDetailsView /></aside>
    </PaneProvider>
  </RunDockProvider></TopBarProvider></StoreProvider></StrictMode>))
  try {
    show(true); show(true,'new-run'); show(false)
    expect(store.getSnapshot().workbench).toBe(before)
    expect(container.querySelector('aside')?.textContent).toBe('')
  } finally { act(() => root.unmount()); container.remove() }
})

it('selecting Timeline or Flow changes main only, while selecting a row explicitly opens Details', () => {
  const store = runDockStore(), fixture = runFixture()
  const before = store.getSnapshot().workbench.right
  const container = document.createElement('div'), root = createRoot(container)
  const Producer = () => {
    const [selectedRow,onSelect] = useState<string | null>(null)
    return <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={selectedRow} onSelect={onSelect}
      flow={<div data-fixture-flow>Recorded Flow</div>} inspector={{input:fixture,seats:[]}} />
  }
  const choose = (label: string) => {
    act(() => container.querySelector<HTMLButtonElement>('[data-slot="page-options"] button[title="View"]')!.click())
    act(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(one => one.textContent === label)!.click())
  }
  try {
    act(() => root.render(<StoreProvider store={store}><TopBarProvider><RunDockProvider><PaneProvider scope={scope('dock-team')}>
      <WorkViewControlsOutlet owner="dock-team" /><TopBarOutlet owner="dock-team" fallback={{place:'Recorded Run',more:()=>null}} /><Producer />
    </PaneProvider></RunDockProvider></TopBarProvider></StoreProvider>))
    choose('Flow')
    expect(container.querySelector('[data-fixture-flow]')).not.toBeNull()
    expect(store.getSnapshot().workbench.right).toBe(before)
    choose('Timeline')
    expect(store.getSnapshot().workbench.right).toBe(before)
    act(() => container.querySelector<HTMLButtonElement>('[data-row="card-1-1"] button')!.click())
    expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]).toMatchObject({tool:'details',mode:'run-details',open:true})
  } finally { act(() => root.unmount()); container.remove() }
})

it('outlets read their mounted owner and cannot inherit another Team’s records after cleanup', () => {
  const store = runDockStore(), fixture = runFixture()
  const container = document.createElement('div'), root = createRoot(container)
  const source = (owner: string, title: string, mounted = true) => <PaneProvider scope={scope(owner)}>
    {mounted && <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow="card-1-1" onSelect={() => {}}
      inspector={{input:{...fixture,cards:fixture.cards.map(one=>one.id===1?{...one,title,handoff:title}:one)},seats:[]}} />}
    <aside data-owner={owner}><RunDetailsView /></aside>
  </PaneProvider>
  const show = (first: boolean) => act(() => root.render(<StoreProvider store={store}><TopBarProvider><RunDockProvider>
    {source('first','First recorded card',first)}{source('second','Second recorded card')}
  </RunDockProvider></TopBarProvider></StoreProvider>))
  try {
    show(true)
    expect(container.querySelector('[data-owner="first"]')?.textContent).toContain('First recorded card')
    expect(container.querySelector('[data-owner="first"]')?.textContent).not.toContain('Second recorded card')
    expect(container.querySelector('[data-owner="second"]')?.textContent).toContain('Second recorded card')
    show(false)
    expect(container.querySelector('[data-owner="first"]')?.textContent).toBe('')
    expect(container.querySelector('[data-owner="second"]')?.textContent).toContain('Second recorded card')
  } finally { act(() => root.unmount()); container.remove() }
})

it('a stale producer cleanup does not remove a newer owner publication', () => {
  const store = runDockStore(), fixture = runFixture()
  const container = document.createElement('div'), root = createRoot(container)
  let dock: ReturnType<typeof useRunDock> = null
  const Probe = () => { dock=useRunDock(); return <RunDetailsView /> }
  try {
    act(() => root.render(<StoreProvider store={store}><RunDockProvider><PaneProvider scope={scope('owner')}><Probe /></PaneProvider></RunDockProvider></StoreProvider>))
    let clearOld: () => void = () => {}
    act(() => {
      clearOld=dock!.publish('owner',{inspector:{input:fixture,seats:[],selectedRow:'card-1-1'}})
      dock!.publish('owner',{inspector:{input:{...fixture,cards:fixture.cards.map(one=>one.id===1?{...one,title:'New record'}:one)},seats:[],selectedRow:'card-1-1'}})
      clearOld()
    })
    expect(container.textContent).toContain('New record')
  } finally { act(() => root.unmount()); container.remove() }
})

it.each([null,'run','round-1','step:writer','missing'])('unsupported selection %s adds no duplicate Run summary in tool mode', selectedRow => {
  const fixture = runFixture()
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<RunInspector input={fixture} seats={[]} selectedRow={selectedRow} inspectionOnly />))
    expect(container.textContent).toBe('')
  } finally { act(() => root.unmount()); container.remove() }
})

it.each([
  ['record','running',undefined,RECORD_REASON],
  ['ended','stopped',undefined,'This Run is not running'],
  ['unavailable','running',undefined,'Stopping this Run is unavailable here'],
] as const)('permanent Stop verb preserves the %s refusal', (_kind,state,onStop,reason) => {
  const store=runDockStore(), fixture=runFixture()
  const container=document.createElement('div'),root=createRoot(container)
  try {
    act(()=>root.render(<StoreProvider store={store}><TopBarProvider>
      <WorkViewControlsOutlet owner="" /><TopBarOutlet owner="" fallback={{place:'Recorded Run',more:()=>null}} />
      <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={()=>{}} onStop={onStop}
        stopRefusal={_kind==='record'?RECORD_REASON:undefined} inspector={{input:{...fixture,execution:{...fixture.execution,state}},seats:[]}} />
    </TopBarProvider></StoreProvider>))
    const stop=container.querySelector<HTMLButtonElement>('[data-slot="page-options"] > button')!
    expect(stop.textContent).toBe('Stop run…')
    expect(stop.disabled).toBe(true)
    expect(stop.title).toBe(reason)
    expect(stop.querySelector('svg')).toBeNull()
  } finally {act(()=>root.unmount());container.remove()}
})

it('the permanent Stop verb calls the parent’s existing consent opener', () => {
  const store=runDockStore(),fixture=runFixture(),onStop=vi.fn()
  const container=document.createElement('div'),root=createRoot(container)
  try {
    act(()=>root.render(<StoreProvider store={store}><TopBarProvider>
      <WorkViewControlsOutlet owner="" /><TopBarOutlet owner="" fallback={{place:'Recorded Run',more:()=>null}} />
      <RunWorkspace model={runTimeline(fixture)} number={1} selectedRow={null} onSelect={()=>{}} onStop={onStop} inspector={{input:fixture,seats:[]}} />
    </TopBarProvider></StoreProvider>))
    act(()=>container.querySelector<HTMLButtonElement>('[data-slot="page-options"] > button')!.click())
    expect(onStop).toHaveBeenCalledOnce()
  } finally {act(()=>root.unmount());container.remove()}
})
