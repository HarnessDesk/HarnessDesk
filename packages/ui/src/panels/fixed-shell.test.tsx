import { sideBySideStore, SIDE_BY_SIDE_KEYS } from '../preview/side-by-side-fixture'
import { PREVIEW_ROOM } from '../preview/harness'
import { runTeamStore } from '../preview/run-view-fixture'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore, PREVIEW_SESSION_KEY } from '../preview/harness'
import { overviewTeamStore } from '../preview/team-overview-fixture'
import { TeamFramePreview } from '../preview/TeamFramePreview'
import { activeView, emptyWorkbench, dockViews } from '../state/workbench'
import { Workbench } from './Workbench'
import './builtins'
import { onDismissOverlays } from '../lib/overlays'
import { FRAME } from '../design/frame'
import foundationTokens from '../design/foundation/tokens.css?raw'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: Root
beforeEach(() => {
  // jsdom has no layout and recursively resolving absent custom properties
  // through an embedded Team's ancestors is expensive. These routing tests
  // supply the real foundation values only to the two measured toolbars;
  // browser contracts and ComposerControls.narrow test their geometry/folds.
  const tokens = new Map([...foundationTokens.matchAll(/(--hd-[\w-]+):\s*([\d.]+px)/g)].map(([, name, value]) => [name!, value!]))
  const computed = getComputedStyle
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((node, pseudo) => {
    if (node.matches('[data-slot="top-bar"]')) return { getPropertyValue: name => name === '--hd-bar-title-min' ? `${FRAME.bar.titleMin}px` : '' } as CSSStyleDeclaration
    if (node.matches('[data-slot="composer-tools"]')) return {
      getPropertyValue: name => tokens.get(name) ?? '', columnGap: tokens.get('--hd-space-1-5'), gap: tokens.get('--hd-space-1-5'),
      paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px',
    } as CSSStyleDeclaration
    return computed(node, pseudo)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  if (!window.matchMedia) Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const mountWork = (session = false) => {
  const workbench = emptyWorkbench()
  const main = { ...workbench.main, root: { kind: 'pane' as const, id: 'draft', view: { kind: 'conversation' as const, session: session ? PREVIEW_SESSION_KEY : null } }, focused: 'draft' }
  const store = previewStore({ layout: main, workbench: { ...workbench, main }, activeSessionKey: session ? PREVIEW_SESSION_KEY : null })
  Object.assign(store, { reportEditor: () => {}, readSeatAttachments: async () => null })
  act(() => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} /></StoreProvider>))
  return store
}
const mountDraft = () => mountWork()
const mountTeam = async (memberActions = false, windowWidth = 1440) => {
  vi.stubGlobal('innerWidth', windowWidth)
  const fixture = overviewTeamStore('running')
  const seed = fixture.getSnapshot()
  const workbench = emptyWorkbench()
  const main = { root: { kind: 'pane' as const, id: 'team-main', view: { kind: 'room' as const, room: 'overview-team' } }, focused: 'team-main', expanded: null }
  const store = previewStore({ ...seed, layout: main, workbench: { ...workbench, main }, activeSessionKey: null, windowWidth,
    runtimes: memberActions ? seed.runtimes.map(runtime => ({ ...runtime, capabilities: { ...runtime.capabilities, compaction: true, undo: true } })) : seed.runtimes })
  Object.assign(store, { reportEditor: () => {}, readSeatAttachments: async () => null, teamPeers: fixture.teamPeers, readGoalInsight: fixture.readGoalInsight })
  await act(async () => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} /></StoreProvider>))
  return { store }
}
const selectMember = async (name: string) => {
  if (button('Details')?.getAttribute('aria-pressed') !== 'true') await act(async () => button('Details')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>(`button[title="Actions for ${name}"]`)!.click())
  const opener = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent === 'Open conversation')!
  await act(async () => opener.click())
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
it('a draft has four tool doors and no second body header', () => {
  mountDraft()
  for (const label of ['Details', 'Changes', 'Activity', 'Browser']) expect(button(label)).not.toBeNull()
  expect(button('Changes')?.disabled).toBe(true)
  expect(button('Activity')?.disabled).toBe(true)
  expect(container.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
  expect(container.querySelector('[data-slot="workbench-main"] header')).toBeNull()
})
it('draft Details opens without a legacy payload and the panel toggle closes it', () => {
  const store = mountDraft()
  act(() => button('Details')?.click())
  expect(container.querySelector('[data-slot="tool-body"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="summary-card"]')?.getAttribute('data-surface')).toBe('panel')
  expect(container.querySelector('[data-slot="tool-body"]')?.textContent).toContain('Plan')
  expect(dockViews(store.getSnapshot().workbench.right)).toHaveLength(0)
  expect(button('Details')?.getAttribute('aria-pressed')).toBe('true')
  act(() => button('Toggle right panel')?.click())
  expect(button('Details')?.getAttribute('aria-pressed')).toBe('false')
})

it('selecting Details keeps the real Browser body and its resource mounted', async () => {
  const store = mountDraft()
  await act(async () => { await store.openBrowser() })
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  const browser = container.querySelector('[data-slot="tool-pane"]')
  expect(browser).not.toBeNull()
  act(() => button('Details')?.click())
  expect(container.querySelector('[data-slot="tool-pane"]')).toBe(browser)
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === resource.id)?.view).toBe(resource.view)
  act(() => button('Browser')?.click())
  expect(container.querySelector('[data-slot="tool-pane"]')).toBe(browser)
})


it('lit Changes closes an artifact once, then unlit Changes opens its default body', async () => {
  const store = mountWork(true)
  await act(async () => { await store.openFile('/work/storefront/src/login.ts') })
  const subject = store.workSubject()!
  expect(store.getSnapshot().workbench.frameTools[subject]?.mode).toBe('file')
  act(() => button('Changes')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
  act(() => button('Changes')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]?.mode).toBe('changes')
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(true)
})

it('an unlit Details door returns to canonical facts after a plugin mode was closed', () => {
  const store = mountWork(true)
  act(() => store.chooseWorkTool('details', 'plugin'))
  act(() => store.toggleWorkPanel())
  act(() => button('Details')!.click())
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.mode).toBe('details')
  expect(container.querySelector('[data-slot="tool-body"]')).not.toBeNull()
})


it('standing tools use the same live width as the right column', () => {
  mountDraft()
  act(() => button('Details')!.click())
  const slot = container.querySelector<HTMLElement>('[data-topbar="tools"]')!
  expect(slot.hasAttribute('data-standing')).toBe(true)
  expect(slot.style.getPropertyValue('--topbar-right-column')).toBe('var(--panel-right)')
})

it('Details Commit returns from Browser focus to its owning conversation composer', async () => {
  const store = mountWork(true)
  await act(async () => { await store.openBrowser() })
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  act(() => store.focusView(resource.id))
  act(() => button('Details')!.click())
  act(() => button('Folder actions')!.click())
  const commit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(one => one.textContent === 'Commit the changes')!
  expect(commit).not.toBeUndefined()
  const dismissed = vi.fn()
  const stop = onDismissOverlays(dismissed)
  act(() => commit.click())
  stop()
  expect(dismissed).toHaveBeenCalledWith({ returnFocus: false })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  const composer = container.querySelector<HTMLTextAreaElement>('[data-slot="workbench-main"] textarea')!
  expect(composer.value).toBe('Commit the changes from this conversation with a clear message, then tell me the commit hash.')
  expect(document.activeElement).toBe(composer)
  expect(store.getSnapshot().workbench.focus).toBeNull()
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.mode).toBe('details')
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === resource.id)?.view).toBe(resource.view)
})

it('the canonical Team bar closes and reopens its remembered Browser without replacing the resource', async () => {
  const { store } = await mountTeam()
  await act(async () => { await store.openBrowser() })
  const subject = store.workSubject()!
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  const toggle = button('Toggle right panel')!
  expect(toggle).not.toBeNull()
  expect(toggle.closest('[data-slot="top-bar"]')).not.toBeNull()
  act(() => toggle.click())
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
  act(() => toggle.click())
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'browser', mode: 'browser', open: true })
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === resource.id)?.view).toBe(resource.view)
})

const chooseRunLayout = async (layout: 'Timeline' | 'Flow') => {
  await act(async () => button('View')!.click())
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(one => one.textContent === layout)!
  expect(item).not.toBeUndefined()
  await act(async () => item.click())
}
it('a narrow Team Run publishes without opening an empty overlay, and Details opens persistent facts', async () => {
  const { store } = await mountTeam(false, 720)
  const before = store.getSnapshot().workbench.right
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  const snapshot = store.getSnapshot()
  const subject = store.workSubject()!
  expect(snapshot.workbench.right).toEqual(before)
  expect(dockViews(snapshot.workbench.right)).toEqual([])
  expect(snapshot.windowWidth).toBe(720)
  expect(snapshot.workbench.frameTools[subject]?.open ?? false).toBe(false)
  expect(container.querySelector('[data-slot="run-workspace"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="workbench-main"] [data-slot="run-steps"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="workbench-main"]')?.closest('[inert]')).toBeNull()
  act(() => button('Toggle right panel')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(true)
  expect(container.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="run-inspector"]')).toBeNull()
})

it('the canonical Team toggle restores its remembered Browser while layout changes leave the cache intact', async () => {
  const { store } = await mountTeam()
  await act(async () => { await store.openBrowser() })
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  const before = store.getSnapshot().workbench
  await chooseRunLayout('Flow')
  expect(store.getSnapshot().workbench.right).toEqual(before.right)
  const subject = store.workSubject()!
  act(() => button('Toggle right panel')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'browser', mode: 'browser', open: false })
  act(() => button('Toggle right panel')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'browser', mode: 'browser', open: true })
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === resource.id)?.view).toBe(resource.view)
  expect(dockViews(store.getSnapshot().workbench.right).some(one => one.view.kind === 'run-steps')).toBe(false)
  await chooseRunLayout('Timeline')
  expect(container.querySelector('[data-slot="workbench-main"] [data-slot="run-steps"]')).not.toBeNull()
})

it('a narrow Team Flow opens persistent Details with one unpressed canonical toggle click', async () => {
  const { store } = await mountTeam(false, 720)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  await chooseRunLayout('Flow')
  const subject = store.workSubject()!
  const before = store.getSnapshot().workbench.right
  const toggle = button('Toggle right panel')!
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  act(() => toggle.click())
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'details', open: true })
  expect(dockViews(store.getSnapshot().workbench.right)).toEqual(dockViews(before))
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="work-tools"] [data-slot="run-steps"]')).toBeNull()
})

it('direct Team tabs retain Flow while the historical Steps opener explicitly returns to Timeline', async () => {
  const { store } = await mountTeam()
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  await chooseRunLayout('Flow')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="overview"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  expect(container.querySelector('[data-slot="run-workspace"]')?.getAttribute('data-view')).toBe('flow')
  const before = store.getSnapshot().workbench.right
  await act(async () => store.showView('run-steps'))
  expect(container.querySelector('[data-slot="run-workspace"]')?.getAttribute('data-view')).toBe('timeline')
  expect(store.getSnapshot().workbench.right).toEqual(before)
  expect(dockViews(before).some(one => one.view.kind === 'run-steps')).toBe(false)
})

it('a selected Team member keeps its scoped Folder Commit and capability actions in the Team More', async () => {
  const { store } = await mountTeam(true)
  await selectMember('Alpha')
  const bar = container.querySelector('[data-slot="top-bar"]')!
  if (!bar) throw new Error('Selected Team member has no canonical bar')
  expect(bar.querySelectorAll('[data-work-tool]')).toHaveLength(4)
  await act(async () => bar.querySelector<HTMLButtonElement>('button[title="More"]')!.click())
  const rows = () => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"], [role="menu"] button')]
  expect(rows().some(one => one.textContent?.includes('Compact now'))).toBe(true)
  expect(rows().some(one => one.textContent?.includes('Save as an Agent'))).toBe(true)
  expect(rows().some(one => one.textContent === 'Browser')).toBe(false)
  expect(rows().filter(one => /^Changes(?: ·|$)/.test(one.textContent ?? ''))).toHaveLength(0)
  const folder = rows().find(one => one.textContent?.startsWith('Folder actions'))!
  expect(folder).not.toBeUndefined()
  await act(async () => { folder.focus(); folder.click() })
  expect(folder.getAttribute('aria-expanded')).toBe('true')
  expect(rows().filter(one => /^Changes(?: ·|$)/.test(one.textContent ?? ''))).toHaveLength(1)
  const commit = rows().find(one => one.textContent === 'Commit the changes')!
  expect(commit).not.toBeUndefined()
  act(() => commit.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  const composer = container.querySelector<HTMLTextAreaElement>('[data-slot="workbench-main"] textarea')!
  expect(composer.value).toContain('Commit the changes from this conversation')
  expect(document.activeElement).toBe(composer)
  expect(store.getSnapshot().workbench.main.focused).toBe('team-main')
  expect(store.getSnapshot().workbench.focus).toBeNull()
  await selectMember('Beta')
  expect(container.querySelector('[data-topbar-title]')?.textContent).toContain('Retry the checkout call')
  expect(container.querySelector<HTMLTextAreaElement>('[data-slot="workbench-main"] textarea')?.value).toBe('')
  act(() => container.querySelector<HTMLButtonElement>('[data-team-page="room"]')!.click())
  expect(container.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
})

it('Team publishes one shell row, four tools and persistent Run then Seats on Overview', async () => {
  await mountTeam()
  expect(container.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
  expect(container.querySelector('button[title="Team members"]')).toBeNull()
  expect([...container.querySelectorAll('[data-work-tool]')].map(one => one.getAttribute('data-work-tool'))).toEqual(['details', 'changes', 'activity', 'browser'])
  await act(async () => button('Details')!.click())
  const sections = container.querySelectorAll('[data-slot="tool-body"] [data-slot="tool-section"]')
  expect([...sections].map(one => one.querySelector('[data-slot="tool-section-label"]')?.textContent ?? one.firstElementChild?.textContent)).toEqual(['Run', 'Seats'])
  expect(container.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="tool-body"] [data-slot="summary-card"][data-surface="card"]')).toBeNull()
})


it('a real selected Run inspection augments persistent Team Run and Seats in canonical Details', async () => {
  const {store} = await mountTeam()
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  const row = container.querySelector<HTMLElement>('[data-slot="run-workspace"] [data-row][data-kind="card"]')!
  expect(row).not.toBeNull()
  await act(async () => row.click())
  const body = [...container.querySelectorAll<HTMLElement>('[data-slot="tool-body"]')].find(one => !one.closest('[hidden], [data-hidden], [inert]'))!
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]).toMatchObject({tool:'details',mode:'run-details',open:true})
  expect(body.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  expect(body.querySelector('[aria-label="Seats"]')).not.toBeNull()
  expect(body.querySelector('[data-slot="run-inspector"]')).not.toBeNull()
  expect(body.querySelector('[data-slot="summary-card"][data-surface="card"]')).toBeNull()
  const groups = [...body.querySelectorAll('[data-slot="tool-section"]')]
  expect(groups[0]?.textContent).toContain('Run')
  expect(groups.at(-1)?.textContent).toContain('Seats')
})

it('the Preview store refreshes only remembered matching Team subjects and does not revive removed owners', async () => {
  const {store} = await mountTeam()
  act(() => button('Details')!.click())
  const subject=store.workSubject()!, remembered=store.getSnapshot().workbench.frameSubjects[subject]!
  const unrelated={paneId:'unrelated',view:{kind:'room' as const,room:'another-team',framePage:'overview' as const}}
  const before=store.getSnapshot()
  Object.assign(before.workbench.frameSubjects,{other:unrelated})
  act(() => { store.setTeamFramePage('overview-team','board'); store.setRoomWatching('team-main',[...store.getSnapshot().sessions.keys()].slice(0,1)) })
  expect(store.getSnapshot().workbench.frameSubjects[subject]?.paneId).toBe(remembered.paneId)
  expect(store.getSnapshot().workbench.frameSubjects[subject]?.view).toMatchObject({kind:'room',room:'overview-team',framePage:'board',watching:[...store.getSnapshot().sessions.keys()].slice(0,1)})
  expect(store.getSnapshot().workbench.frameSubjects['other']).toBe(unrelated)
  const {[subject]:_removed,...remaining}=store.getSnapshot().workbench.frameSubjects
  Object.assign(store.getSnapshot().workbench,{frameSubjects:remaining})
  act(() => store.setTeamFramePage('overview-team','room'))
  expect(store.getSnapshot().workbench.frameSubjects[subject]).toBeUndefined()
})


it('standalone Team previews own their bar and Details registries through selection and unmount', async () => {
  const first=overviewTeamStore('running'),second=overviewTeamStore('done')
  const scenes=(showFirst=true)=><>{showFirst && <div key="first" data-fixture="first"><StoreProvider store={first}><TeamFramePreview room="overview-team" /></StoreProvider></div>}<div key="second" data-fixture="second"><StoreProvider store={second}><TeamFramePreview room="overview-team" /></StoreProvider></div></>
  await act(async()=>root.render(scenes()))
  const one=container.querySelector('[data-fixture="first"]')!,two=container.querySelector('[data-fixture="second"]')!
  expect(one.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
  expect(two.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
  await act(async()=>one.querySelector<HTMLButtonElement>('button[aria-label="Details"]')!.click())
  expect(one.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  expect(two.querySelector('[data-slot="tool-body"]')).toBeNull()
  await act(async()=>one.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  await act(async()=>one.querySelector<HTMLElement>('[data-row][data-kind="card"]')!.click())
  expect(one.querySelector('[data-slot="tool-body"] [data-slot="run-inspector"]')).not.toBeNull()
  await act(async()=>root.render(scenes(false)))
  expect(container.querySelector('[data-fixture="first"]')).toBeNull()
  await act(async()=>two.querySelector<HTMLButtonElement>('button[aria-label="Details"]')!.click())
  expect(two.querySelector('[data-slot="tool-body"]')?.textContent).toContain('settled')
  expect(two.querySelector('[data-slot="run-inspector"]')).toBeNull()
})


it.each([720,1440])('standalone Team Details uses the measured frame placement at %ipx', async width => {
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,width,600))
  const store=overviewTeamStore('running')
  await act(async()=>root.render(<StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider>))
  await act(async()=>button('Details')!.click())
  const panel=container.querySelector<HTMLElement>('[data-preview-tool-placement]')!
  expect(panel.dataset.previewToolPlacement).toBe(width < FRAME.fold.panelFloats ? 'floating' : 'column')
  expect(panel.style.width).toBe(`${FRAME.rightPanel.width}px`)
  const tools=container.querySelector<HTMLElement>('[data-topbar="tools"]')!
  expect(tools.hasAttribute('data-standing')).toBe(width >= FRAME.fold.panelFloats)
  expect(container.querySelector('[data-slot="workbench-main"]')?.closest('[inert]')).toBeNull()
  expect(container.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
})


it('Preview Browser reveal restores fresh remembered Team navigation and tiles without relabeling its resource', async () => {
  const {store}=await mountTeam()
  await act(async()=>store.openBrowser())
  const resource=dockViews(store.getSnapshot().workbench.right).find(one=>one.view.kind==='browser')!
  const owner=store.getSnapshot().workbench.toolOwners[resource.id]!, remembered=store.getSnapshot().workbench.frameSubjects[owner]!
  const key=[...store.getSnapshot().sessions.keys()][0]!
  act(()=> {
    store.setTeamFramePage('overview-team','board')
    store.setRoomSideBySide(remembered.paneId,{tiles:[key],pinned:[],focused:key,expanded:null,modes:{},seen:[key]})
  })
  const fresh=store.getSnapshot().workbench.frameSubjects[owner]!
  expect(fresh).toMatchObject({paneId:remembered.paneId,view:{kind:'room',room:'overview-team',framePage:'board',sideBySide:{tiles:[key]}}})
  act(()=> {store.openTeamRoom('another-team');store.revealView(resource.id)})
  expect(store.getSnapshot().workbench.main.root).toMatchObject({id:remembered.paneId,view:fresh.view})
  expect(store.getSnapshot().workbench.toolOwners[resource.id]).toBe(owner)
  expect(dockViews(store.getSnapshot().workbench.right).find(one=>one.id===resource.id)?.view).toBe(resource.view)
})

it('live-polish standalone Team uses one store for tool admission, Run selection and its inspector', async () => {
  const store=runTeamStore('live-polish')
  await act(async()=>root.render(<StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider>))
  await act(async()=>button('Details')!.click())
  expect(container.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  await act(async()=>container.querySelector<HTMLElement>('[data-row][data-kind="card"]')!.click())
  expect(container.querySelector('[data-slot="tool-body"] [data-slot="run-inspector"]')).not.toBeNull()
})

it.each(['thread','side-by-side'] as const)('Preview Browser reveal preserves the chosen Chat %s and independent pinned tile state', chatLayout => {
  const store=previewStore()
  store.openTeamRoom('fixture-chat')
  store.openBrowser('https://example.com/')
  const resource=dockViews(store.getSnapshot().workbench.right).find(one=>one.view.kind==='browser')!
  const owner=store.getSnapshot().workbench.toolOwners[resource.id]!, remembered=store.getSnapshot().workbench.frameSubjects[owner]!
  const key='fixture-runtime\0seat' as never
  store.setRoomSideBySide(remembered.paneId,{tiles:[key],pinned:[key],focused:key,expanded:null,modes:{[key]:'browser'},seen:[key]})
  store.setTeamFramePage('fixture-chat','room',chatLayout)
  store.setTeamFramePage('fixture-chat','board')
  store.setTeamFramePage('fixture-chat','room')
  const fresh=store.getSnapshot().workbench.frameSubjects[owner]!
  expect(fresh).toMatchObject({paneId:remembered.paneId,view:{framePage:'room',chatLayout,sideBySide:{tiles:[key],pinned:[key],focused:key,modes:{[key]:'browser'}}}})
  store.openTeamRoom('another-team')
  store.revealView(resource.id)
  expect(store.getSnapshot().workbench.main.root).toMatchObject({id:remembered.paneId,view:fresh.view})
  expect(store.getSnapshot().workbench.toolOwners[resource.id]).toBe(owner)
})

it('preserves both recorded live-polish Seat ceilings when its sessions have no settings yet', async () => {
  const store=runTeamStore('live-polish')
  await act(async()=>root.render(<StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider>))
  await act(async()=>button('Details')!.click())
  const rows=[...container.querySelectorAll('[data-slot="list-row"]')]
  const row=(name:string)=>rows.find(one=>one.querySelector('[data-slot="list-row-title"]')?.textContent===name)!
  expect(row('Alpha').textContent).toContain('Edit · asked, not enforced')
  expect(row('Beta').textContent).toContain('Read only')
  expect([...store.getSnapshot().sessions.values()].map(one=>one.settings?.ceiling)).toEqual([{level:'edit',hold:'asked'},{level:'read',hold:'held'}])
})

it('keeps a selected Not reached step when returning from Flow without reopening the closed tool', async () => {
  const store = runTeamStore('empty')
  await act(async () => root.render(<StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider>))
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  const future = container.querySelector<HTMLButtonElement>('[data-slot="run-steps"] [data-step-row="person"]')!
  await act(async () => future.click())
  expect(container.querySelector('[data-step-row="person"]')?.getAttribute('data-selected')).toBe('true')
  await act(async () => button('Toggle right panel')!.click())
  const before = store.getSnapshot().workbench.right
  const subject = store.workSubject()!
  await chooseRunLayout('Flow')
  expect(container.querySelector('[data-slot="run-flow"] [data-step-row="person"]')?.getAttribute('data-selected')).toBe('true')
  await chooseRunLayout('Timeline')
  expect(container.querySelector('[data-step-row="person"]')?.getAttribute('data-selected')).toBe('true')
  expect(store.getSnapshot().workbench.right).toEqual(before)
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
})

it('standalone Team admission retains each original Seat browser profile and planner page', async () => {
  const store = sideBySideStore({ browsers: true })
  const held = dockViews(store.getSnapshot().workbench.right)
  expect(held).toHaveLength(2)
  const keys = SIDE_BY_SIDE_KEYS.slice(0, 2)
  const view = { kind: 'room' as const, room: PREVIEW_ROOM, framePage: 'room' as const, chatLayout: 'side-by-side' as const,
    sideBySide: { tiles: keys, focused: keys[0], modes: Object.fromEntries(keys.map(key => [key, 'browser' as const])) } }
  await act(async () => root.render(<StoreProvider store={store}><TeamFramePreview room={PREVIEW_ROOM} view={view} /></StoreProvider>))
  expect(dockViews(store.getSnapshot().workbench.right)).toEqual(held)
  expect([...container.querySelectorAll<HTMLIFrameElement>('iframe')].map(frame => frame.getAttribute('src'))).toEqual([
    '/src/preview/tile-page.html?seat=alpha', '/src/preview/tile-page.html?seat=beta',
  ])
})

it('Run again retains both original Runs and continuation in the real parent Details', async () => {
  const store = runTeamStore('settled')
  await act(async () => root.render(<StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider>))
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  const again = [...container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Run again…')!
  await act(async () => again.click())
  const start = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(one => one.textContent === 'Start')!
  await act(async () => { await vi.waitFor(() => expect(start()?.disabled).toBe(false)) })
  await act(async () => start().click())
  expect(store.getSnapshot().flowExecutions.size).toBe(2)
  expect(container.querySelector('[aria-label="Choose a Run"]')).toBeNull()
  await act(async () => button('Details')!.click())
  expect([...container.querySelectorAll('[aria-label="Choose a Run"] button')].map(one => one.textContent)).toEqual(['Run 1', 'Run 2'])
  expect([...container.querySelectorAll('[data-slot="summary-item"]')].find(one => one.textContent?.startsWith('Continues'))?.textContent).toContain('Run 1')
})
