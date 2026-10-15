import { splitSessionKey, type Approval, type CapabilityContribution } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { ToolBody, ToolSection, DestinationBody } from '../design'
import { DestinationBar, DestinationPageScope } from './destination-page'
import { useSessionKey, useIsFocusedPane, PaneProvider } from '../state/context'
import { publishComponent } from '../slots/registry'
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
import { Workbench as WorkbenchBody } from './Workbench'
import { TopBarProvider } from './top-bar'
import { ShellHostsProvider, ShellOutlets } from './shell-hosts'
import type { ComponentProps } from 'react'
const Workbench = ({ pageOwner, ...props }: ComponentProps<typeof WorkbenchBody> & { pageOwner?: string }) => <TopBarProvider><ShellHostsProvider><WorkbenchBody {...props} /><ShellOutlets activeOwner={pageOwner ?? null} hostOwner={pageOwner ? 'work' : undefined} /></ShellHostsProvider></TopBarProvider>
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
  const bounds = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('[data-topbar-title], [data-topbar="place"]')) return { ...bounds.call(this), width: FRAME.bar.titleMin } as DOMRect
    return bounds.call(this)
  })
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
  vi.stubGlobal('innerWidth', 1440)
  vi.stubGlobal('innerHeight', 900)
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
  if (button('Toggle rail')?.getAttribute('aria-pressed') !== 'true') await act(async () => openRail())
  await act(async () => container.querySelector<HTMLButtonElement>(`button[title="Actions for ${name}"]`)!.click())
  const opener = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent === 'Open conversation')!
  await act(async () => opener.click())
}
const openRail = (within: ParentNode = container) => {
  const toggle = within.querySelector<HTMLButtonElement>('[data-work-rail-toggle]')!
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click()
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

/** Destination navigation uses the current shell transport at either fold. */
const chooseTeamPage = async (page: string, within: ParentNode = container): Promise<void> => {
  const tab = within.querySelector<HTMLButtonElement>(`[role="tab"][data-team-page="${page}"]`)
  if (tab) {
    await act(async () => tab.click())
    return
  }
  const trigger = within.querySelector<HTMLButtonElement>('button[title="Destination views"]')
  expect(trigger, 'folded Team destinations remain reachable').not.toBeNull()
  if (trigger!.getAttribute('aria-expanded') !== 'true') await act(async () => trigger!.click())
  const choice = document.body.querySelector<HTMLButtonElement>(`[role="menuitemradio"][data-team-page="${page}"]`)
  expect(choice, `the folded menu keeps ${page}`).not.toBeNull()
  await act(async () => choice!.click())
}

it('a draft has four tool doors and no second body header', () => {
  mountDraft()
  for (const label of ['Terminal', 'Changes', 'Browser', 'Files']) expect(button(label)).not.toBeNull()
  expect(button('Changes')?.disabled).toBe(true)
  expect(container.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
  expect(container.querySelector('[data-slot="workbench-main"] header')).toBeNull()
})
it('draft Details opens without a legacy payload and the panel toggle closes it', () => {
  const store = mountDraft()
  act(() => openRail())
  expect(container.querySelector('[data-slot="tool-body"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="summary-card"]')?.getAttribute('data-surface')).toBe('panel')
  expect(container.querySelector('[data-slot="tool-body"]')?.textContent).toContain('Plan')
  expect(dockViews(store.getSnapshot().workbench.right)).toHaveLength(0)
  expect(button('Toggle rail')?.getAttribute('aria-pressed')).toBe('true')
  act(() => button('Toggle rail')?.click())
  expect(button('Toggle rail')?.getAttribute('aria-pressed')).toBe('false')
})

it('selecting Details keeps the real Browser body and its resource mounted', async () => {
  const store = mountDraft()
  await act(async () => { await store.openBrowser() })
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  const browser = container.querySelector('[data-slot="tool-pane"]')
  expect(browser).not.toBeNull()
  act(() => openRail())
  expect(container.querySelector('[data-slot="tool-pane"]')).toBe(browser)
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === resource.id)?.view).toBe(resource.view)
  act(() => button('Browser')?.click())
  expect(container.querySelector('[data-slot="tool-pane"]')).toBe(browser)
})


it('lit Files closes an artifact once, then unlit Changes opens its default body', async () => {
  const store = mountWork(true)
  await act(async () => { await store.openFile('/work/storefront/src/login.ts') })
  const subject = store.workSubject()!
  expect(store.getSnapshot().workbench.frameTools[subject]?.mode).toBe('file')
  act(() => button('Files')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
  act(() => button('Files')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'files', mode: 'file', open: true })
  act(() => button('Files')!.click())
  act(() => button('Changes')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]?.mode).toBe('changes')
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(true)
})

it('an unlit Details door returns to canonical facts after a plugin mode was closed', () => {
  const store = mountWork(true)
  act(() => store.chooseWorkTool('details', 'plugin'))
  act(() => store.toggleWorkPanel())
  act(() => openRail())
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.mode).toBe('plugin')
  expect(container.querySelector('[data-frame-region="rail"] [data-slot="tool-body"]')).not.toBeNull()
})


it('tool doors stay in the subject bar instead of projecting a pane width', () => {
  mountDraft()
  act(() => openRail())
  const slot = container.querySelector<HTMLElement>('[data-topbar="tools"]')!
  expect(slot.hasAttribute('data-standing')).toBe(false)
  expect(slot.style.getPropertyValue('--topbar-right-column')).toBe('')
})

it('Details Commit returns from Browser focus to its owning conversation composer', async () => {
  const store = mountWork(true)
  await act(async () => { await store.openBrowser() })
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  act(() => store.focusView(resource.id))
  act(() => openRail())
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
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.mode).toBe('browser')
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === resource.id)?.view).toBe(resource.view)
})

it('the canonical Team bar closes and reopens its remembered Browser without replacing the resource', async () => {
  const { store } = await mountTeam()
  await act(async () => { await store.openBrowser() })
  const subject = store.workSubject()!
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  const toggle = button('Browser')!
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
  await chooseTeamPage('run')
  const snapshot = store.getSnapshot()
  const subject = store.workSubject()!
  expect(snapshot.workbench.right).toEqual(before)
  expect(dockViews(snapshot.workbench.right)).toEqual([])
  expect(snapshot.windowWidth).toBe(720)
  expect(snapshot.workbench.frameTools[subject]?.open ?? false).toBe(false)
  expect(container.querySelector('[data-slot="run-workspace"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="workbench-main"] [data-slot="run-steps"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="workbench-main"]')?.closest('[inert]')).toBeNull()
  act(() => button('Browser')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(true)
  expect(container.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="run-inspector"]')).toBeNull()
})

it('the canonical Team toggle restores its remembered Browser while layout changes leave the cache intact', async () => {
  const { store } = await mountTeam()
  await act(async () => { await store.openBrowser() })
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  await chooseTeamPage('run')
  const before = store.getSnapshot().workbench
  await chooseRunLayout('Flow')
  expect(store.getSnapshot().workbench.right).toEqual(before.right)
  const subject = store.workSubject()!
  act(() => button('Browser')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'browser', mode: 'browser', open: false })
  act(() => button('Browser')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'browser', mode: 'browser', open: true })
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === resource.id)?.view).toBe(resource.view)
  expect(dockViews(store.getSnapshot().workbench.right).some(one => one.view.kind === 'run-steps')).toBe(false)
  await chooseRunLayout('Timeline')
  expect(container.querySelector('[data-slot="workbench-main"] [data-slot="run-steps"]')).not.toBeNull()
})

it('a narrow Team Flow keeps persistent cards independent of the tool pane', async () => {
  const { store } = await mountTeam(false, 720)
  await chooseTeamPage('run')
  await chooseRunLayout('Flow')
  const subject = store.workSubject()!, before = store.getSnapshot().workbench.right
  const toggle = button('Toggle rail')!
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  act(() => toggle.click())
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  act(() => toggle.click())
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
  expect(store.getSnapshot().workbench.right).toBe(before)
  expect(container.querySelector('[data-frame-region="rail"] [aria-label="Team Run facts"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="work-tools"] [data-slot="run-steps"]')).toBeNull()
})

it('direct Team tabs retain Flow while the historical Steps opener explicitly returns to Timeline', async () => {
  const { store } = await mountTeam()
  await chooseTeamPage('run')
  await chooseRunLayout('Flow')
  await chooseTeamPage('overview')
  await chooseTeamPage('run')
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
  await chooseTeamPage('room')
  expect(container.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
})

it('Team publishes one shell row, four tools and persistent Run then Seats on Overview', async () => {
  await mountTeam()
  expect(container.querySelectorAll('[data-slot="top-bar"]')).toHaveLength(1)
  expect(container.querySelector('button[title="Team members"]')).toBeNull()
  expect([...container.querySelectorAll('[data-work-tool]')].map(one => one.getAttribute('data-work-tool'))).toEqual(['terminal', 'changes', 'browser', 'files'])
  await act(async () => openRail())
  const sections = container.querySelectorAll('[data-slot="tool-body"] [data-slot="tool-section"]')
  expect([...sections].map(one => one.querySelector('[data-slot="tool-section-label"]')?.textContent ?? one.firstElementChild?.textContent)).toEqual(['Run', 'Seats'])
  expect(container.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="tool-body"] [data-slot="summary-card"][data-surface="card"]')).toBeNull()
})


it('a real selected Run inspection augments persistent Team Run and Seats in canonical Details', async () => {
  const {store} = await mountTeam()
  await chooseTeamPage('run')
  const row = container.querySelector<HTMLElement>('[data-slot="run-workspace"] [data-row][data-kind="card"]')!
  expect(row).not.toBeNull()
  await act(async () => row.click())
  const body = [...container.querySelectorAll<HTMLElement>('[data-slot="tool-body"]')].find(one => !one.closest('[hidden], [data-hidden], [inert]'))!
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]).toMatchObject({tool:'details',mode:'run-details',open:true})
  expect(body.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  expect(body.querySelector('[aria-label="Seats"]')).not.toBeNull()
  expect(container.querySelector('[data-frame-region="right"] [data-slot="run-inspector"]')).not.toBeNull()
  expect(body.querySelector('[data-slot="summary-card"][data-surface="card"]')).toBeNull()
  const groups = [...body.querySelectorAll('[data-slot="tool-section"]')]
  expect(groups[0]?.textContent).toContain('Run')
  expect(groups.at(-1)?.textContent).toContain('Seats')
})

it('the Preview store refreshes only remembered matching Team subjects and does not revive removed owners', async () => {
  const {store} = await mountTeam()
  act(() => store.chooseWorkTool('details'))
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
  await act(async()=>openRail(one))
  expect(one.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  expect(two.querySelector('[data-frame-region="rail"] [data-slot="tool-body"]')).not.toBeNull()
  await chooseTeamPage('run', one)
  await act(async()=>one.querySelector<HTMLElement>('[data-row][data-kind="card"]')!.click())
  expect(one.querySelector('[data-slot="tool-body"] [data-slot="run-inspector"]')).not.toBeNull()
  await act(async()=>root.render(scenes(false)))
  expect(container.querySelector('[data-fixture="first"]')).toBeNull()
  await act(async()=>openRail(two))
  expect(two.querySelector('[data-slot="tool-body"]')?.textContent).toContain('settled')
  expect(two.querySelector('[data-slot="run-inspector"]')).toBeNull()
})


it.each([720,1440])('standalone Team cards use the measured rail placement at %ipx', async width => {
  vi.stubGlobal('innerWidth', width)
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,width,600))
  const store=overviewTeamStore('running')
  store.setWindowSize(width, 600)
  await act(async()=>root.render(<StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider>))
  await act(async()=>openRail())
  const shell=container.querySelector<HTMLElement>('[data-slot="fixed-shell"]')!
  expect(shell.dataset.railFloats).toBe(String(width < FRAME.main.min + FRAME.infoCard.width))
  expect(container.querySelector('[data-frame-region="rail"] [aria-label="Team Run facts"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="workbench-main"]')?.closest('[inert]')).toBeNull()
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
  await act(async()=>openRail())
  expect(container.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  await chooseTeamPage('run')
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
  await act(async()=>openRail())
  const rows=[...container.querySelectorAll('[data-slot="list-row"]')]
  const row=(name:string)=>rows.find(one=>one.querySelector('[data-slot="list-row-title"]')?.textContent===name)!
  expect(row('Alpha').textContent).toContain('Edit · asked, not enforced')
  expect(row('Beta').textContent).toContain('Read only')
  expect([...store.getSnapshot().sessions.values()].map(one=>one.settings?.ceiling)).toEqual([{level:'edit',hold:'asked'},{level:'read',hold:'held'}])
})

it('keeps a selected Not reached step when returning from Flow without reopening the closed tool', async () => {
  const store = runTeamStore('empty')
  await act(async () => root.render(<StoreProvider store={store}><TeamFramePreview room="overview-team" /></StoreProvider>))
  await chooseTeamPage('run')
  const future = container.querySelector<HTMLButtonElement>('[data-slot="run-steps"] [data-step-row="person"]')!
  await act(async () => future.click())
  expect(container.querySelector('[data-step-row="person"]')?.getAttribute('data-selected')).toBe('true')
  await act(async () => store.toggleWorkPanel())
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
  await chooseTeamPage('run')
  const again = [...container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Run again…')!
  await act(async () => again.click())
  const start = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(one => one.textContent === 'Start')!
  await act(async () => { await vi.waitFor(() => expect(start()?.disabled).toBe(false)) })
  await act(async () => start().click())
  expect(store.getSnapshot().flowExecutions.size).toBe(2)
  expect(container.querySelector('[aria-label="Choose a Run"]')).not.toBeNull()
  await act(async () => openRail())
  expect([...container.querySelectorAll('[aria-label="Choose a Run"] button')].map(one => one.textContent)).toEqual(['Run 1', 'Run 2'])
  expect([...container.querySelectorAll('[data-slot="summary-item"]')].find(one => one.textContent?.startsWith('Continues'))?.textContent).toContain('Run 1')
})

it('B7 work tools have no dock strip, inspector bar or arrangement buttons', () => {
  const store = mountWork(true)
  act(() => store.showView('changes'))
  expect(container.querySelector('[data-slot="dock-panel-tabs"]')).toBeNull()
  expect(container.querySelector('[data-slot="inspector-tools"]')).toBeNull()
  for (const name of ['Move panel', 'Split panel', 'Expand panel', 'Collapse panel']) expect(button(name)).toBeNull()
})

it('B7 retains both real Browser profile bodies across close, work navigation and older-profile reveal', async () => {
  const store = mountWork(true)
  await act(async () => store.openBrowser('https://example.com/first', { profile: 'lane-first' }))
  const first = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  const firstNode = container.querySelector('[data-slot="tool-pane"]')
  expect(firstNode).not.toBeNull()
  act(() => store.toggleWorkPanel())
  expect(container.contains(firstNode)).toBe(true)
  act(() => store.toggleWorkPanel())
  await act(async () => store.openBrowser('https://example.com/second', { profile: 'lane-second' }))
  const second = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser' && one.id !== first.id)!
  const secondNode = container.querySelector(`[data-tool-mount="${second.id}"] [data-slot="tool-pane"]`)
  expect(secondNode).not.toBeNull()
  act(() => store.toggleWorkPanel())
  act(() => store.toggleWorkPanel())
  expect(activeView(store.getSnapshot().workbench.right)?.id).toBe(second.id)
  expect(container.querySelector(`[data-tool-mount="${second.id}"]`)?.hasAttribute('data-hidden')).toBe(false)
  act(() => store.revealView(first.id))
  expect(container.querySelector(`[data-tool-mount="${first.id}"]`)?.hasAttribute('data-hidden')).toBe(false)
  expect(container.querySelector(`[data-tool-mount="${second.id}"]`)?.hasAttribute('inert')).toBe(true)
  act(() => store.toggleWorkPanel())
  expect(container.querySelector(`[data-tool-mount="${first.id}"] [data-slot="tool-pane"]`)).toBe(firstNode)
  act(() => store.openTeamRoom('another-team'))
  expect(container.querySelector(`[data-tool-mount="${first.id}"] [data-slot="tool-pane"]`)).toBe(firstNode)
  act(() => store.revealView(second.id))
  expect(activeView(store.getSnapshot().workbench.right)?.id).toBe(second.id)
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.open).toBe(true)
  expect(container.querySelector(`[data-tool-mount="${second.id}"] [data-slot="tool-pane"]`)).toBe(secondNode)
  expect(container.querySelector(`[data-tool-mount="${second.id}"]`)?.hasAttribute('data-hidden')).toBe(false)
  expect(store.getSnapshot().workbench.toolOwners[first.id]).toBe(`session:${PREVIEW_SESSION_KEY}`)
})


it('B7 actual session removal retains the admitted Browser node, original owner and refusal', async () => {
  const fixture = previewStore().getSnapshot()
  const workbench = emptyWorkbench()
  const main = { ...workbench.main, root: { kind: 'pane' as const, id: 'owner', view: { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY } }, focused: 'owner' }
  // AppStore coalesces notifications per frame; deliver a synthetic frame inside act.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1 })
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), fixture, { windowWidth: 1440, layout: main, workbench: { ...workbench, main }, activeSessionKey: PREVIEW_SESSION_KEY })
  const requested = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'session/remove') return { undoUntil: null }
    if (method === 'workspace/read') return fixture.workspace
    if (method === 'workspace/recent') return []
    return null
  }) as never)
  await act(async () => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} /></StoreProvider>))
  await act(async () => store.openBrowser('https://example.com/retained', { profile: 'lane-removed' }))
  const entry = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  const node = container.querySelector(`[data-tool-mount="${entry.id}"] [data-slot="tool-pane"]`)
  expect(node).not.toBeNull()
  const owner = store.getSnapshot().workbench.toolOwners[entry.id]
  const { id, runtime } = splitSessionKey(PREVIEW_SESSION_KEY)
  await act(async () => store.removeSession(id, runtime))
  expect(container.querySelector(`[data-tool-mount="${entry.id}"] [data-slot="tool-pane"]`)).toBe(node)
  expect(container.querySelector(`[data-tool-mount="${entry.id}"]`)?.hasAttribute('inert')).toBe(true)
  expect(container.querySelector(`[data-tool-mount="${entry.id}"]`)?.hasAttribute('data-hidden')).toBe(true)
  expect(store.getSnapshot().workbench.toolOwners[entry.id]).toBe(owner)
  expect(dockViews(store.getSnapshot().workbench.right)).toContainEqual(entry)
  expect(store.getSnapshot().workbench.frameSubjects[owner!]).toBeUndefined()
  act(() => store.revealView(entry.id))
  expect(store.getSnapshot().activeSessionKey).toBeNull()
  expect(store.getSnapshot().notices.at(-1)?.message).toContain('no longer available')
  expect(requested.mock.calls.filter(([method]) => method === 'session/close')).toHaveLength(0)
  // A cold cache has no locally captured provenance: it must not instantiate this revoked entry.
  const cold = previewStore(store.getSnapshot())
  await act(async () => root.render(null))
  await act(async () => root.render(<StoreProvider store={cold}><Workbench sidebar={<div />} /></StoreProvider>))
  expect(container.querySelector(`[data-tool-mount="${entry.id}"]`)).toBeNull()
  expect(container.querySelector('[data-slot="tool-pane"]')).toBeNull()
})

it('the terminal shell close action leaves another subject’s hidden terminal retained', async () => {
  const store = mountWork(true), runtime = splitSessionKey(PREVIEW_SESSION_KEY).runtime
  act(() => store.showViewIn('bottom', { kind: 'terminal', terminalId: 'subject-a-pty', runtime, cwd: '/repo/a' }))
  const original = dockViews(store.getSnapshot().workbench.bottom)[0]!
  await act(async () => store.openTeamRoom('terminal-b'))
  act(() => store.showViewIn('bottom', { kind: 'terminal', terminalId: 'subject-b-pty', runtime, cwd: '/repo/b' }))
  const subject = store.workSubject()!
  await act(async () => button('Close terminal')!.click())
  expect(dockViews(store.getSnapshot().workbench.bottom)).toEqual([original])
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
})

it('explicit Agents selection shows its retained body beside the independent rail', async () => {
  const store = mountWork(true)
  await act(async () => store.showView('agents'))
  const snapshot = store.getSnapshot(), subject = store.workSubject()!
  const resource = dockViews(snapshot.workbench.right).find(one => one.view.kind === 'agents')!
  expect(resource).toBeDefined()
  expect(snapshot.workbench.frameTools[subject]).toMatchObject({ tool: 'details', mode: 'agents', open: true })
  const layer = container.querySelector<HTMLElement>(`[data-tool-mount="${resource.id}"]`)!
  expect(layer.querySelector('input[placeholder="Filter sub-agents"]')).not.toBeNull()
  expect(layer.closest('[hidden], [data-hidden], [inert]')).toBeNull()
  expect(container.querySelector('[data-frame-region="rail"]')?.getAttribute('inert')).toBeNull()
  expect(snapshot.workbench.frameSubjects[subject]?.view).toMatchObject({ kind: 'conversation', session: PREVIEW_SESSION_KEY })
  act(() => store.toggleWorkPanel())
  expect(layer.closest('[hidden], [data-hidden], [inert]')).not.toBeNull()
  await act(async () => store.showView('agents'))
  expect(container.querySelector(`[data-tool-mount="${resource.id}"]`)).toBe(layer)
  expect(layer.closest('[hidden], [data-hidden], [inert]')).toBeNull()
})

it('Repository history opens the Changes pane and keeps its retained resource', async () => {
  const store = mountWork(true)
  await act(async () => store.showView('git'))
  const snapshot = store.getSnapshot(), subject = store.workSubject()!
  expect(snapshot.workbench.frameTools[subject]).toMatchObject({ tool: 'changes', mode: 'git', open: true })
  expect(button('Changes')?.getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelector('[data-work-pane-header]')?.textContent).toContain('Changes')
  const resource = dockViews(snapshot.workbench.right).find(one => one.view.kind === 'git')!
  const layer = container.querySelector<HTMLElement>(`[data-tool-mount="${resource.id}"]`)!
  expect(layer.closest('[hidden], [data-hidden], [inert]')).toBeNull()
  act(() => store.toggleWorkPanel())
  await act(async () => store.showView('git'))
  expect(container.querySelector(`[data-tool-mount="${resource.id}"]`)).toBe(layer)
  expect(layer.closest('[hidden], [data-hidden], [inert]')).toBeNull()
})

it('B7 admitted plugin facts join the actual parent Details scroll and keep their original session', async () => {
  const store = mountWork(true)
  const probe = () => <ToolBody><ToolSection label="Fixture facts"><span data-testid="plugin-scope">{useSessionKey()}</span><span data-testid="plugin-focused">{String(useIsFocusedPane())}</span></ToolSection></ToolBody>
  publishComponent('fixture.b7-facts', probe)
  const contribution = { kind: 'ui', id: 'fixture-b7', owner: 'fixture-extension', slot: 'sidebar.panel', label: 'Fixture facts', component: 'fixture.b7-facts', mounts: ['right'], order: 1 } as unknown as CapabilityContribution
  act(() => store.patch({ contributions: [contribution] }))
  act(() => store.showViewIn('right', { kind: 'plugin', contribution: String(contribution.id), label: 'Fixture facts', mounts: ['right'] }))
  expect(container.querySelectorAll('[data-frame-region="right"] [data-slot="tool-body"]')).toHaveLength(1)
  expect(container.querySelectorAll('[data-frame-region="right"] [data-slot="tool-scroll"]')).toHaveLength(1)
  expect(container.querySelector('[aria-label="Conversation"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Fixture facts"]')).not.toBeNull()
  const node = container.querySelector('[data-testid="plugin-scope"]')
  expect(node?.textContent).toBe(PREVIEW_SESSION_KEY)
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'plugin')!
  act(() => store.focusView(resource.id))
  expect(container.querySelector('[data-testid="plugin-focused"]')?.textContent).toBe('true')
  act(() => store.toggleWorkPanel())
  expect(container.querySelector('[data-testid="plugin-scope"]')).toBe(node)
  expect(container.querySelector('[data-testid="plugin-focused"]')?.textContent).toBe('false')
  act(() => store.openTeamRoom('another-team'))
  expect(container.querySelector('[data-testid="plugin-scope"]')?.textContent).toBe(PREVIEW_SESSION_KEY)
})


it.each(['details', 'close'] as const)('B7 hidden fixed Browser cannot consume shortcuts after address focus then %s', async destination => {
  const store = mountWork(true)
  await act(async () => store.openBrowser('https://example.com/keyboard', { profile: 'lane-keyboard' }))
  const entry = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  const address = container.querySelector<HTMLInputElement>(`[data-tool-mount="${entry.id}"] [aria-label="Address"]`)!
  expect(address).not.toBeNull()
  act(() => address.focus())
  expect(store.getSnapshot().workbench.focus).toBe(entry.id)
  // Prove the real Browser listener was armed before hiding its retained body.
  const visible = new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true, cancelable: true })
  await act(async () => { document.dispatchEvent(visible); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(visible.defaultPrevented).toBe(true)
  const before = dockViews(store.getSnapshot().workbench.right).find(one => one.id === entry.id)!
  expect(before.view.kind === 'browser' ? before.view.tabs.length : null).toBe(2)
  const door = destination === 'details' ? button('Changes')! : button('Browser')!
  act(() => { door.focus(); door.click() })
  const hidden = container.querySelector(`[data-tool-mount="${entry.id}"]`)!
  expect(hidden.hasAttribute('inert')).toBe(true)
  expect(hidden.hasAttribute('data-hidden')).toBe(true)
  expect(hidden.querySelector('[aria-label="Address"]')).toBe(address)
  // Deliberately name the hidden Browser as focused: its visibility policy
  // must win even when logical focus has not followed the closed panel.
  act(() => store.focusView(entry.id))
  expect(store.getSnapshot().workbench.focus).toBe(entry.id)
  const shortcut = new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true, cancelable: true })
  act(() => document.dispatchEvent(shortcut))
  expect(shortcut.defaultPrevented).toBe(false)
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === entry.id)?.view).toBe(before.view)
})

it('suspending work retains its real Browser and denies hidden shortcuts while P13 selects the returning tool', async () => {
  const store = mountWork(true)
  await act(async () => store.openBrowser('https://example.com/suspended', { profile: 'lane-suspended' }))
  const entry = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  const node = container.querySelector(`[data-tool-mount="${entry.id}"] [data-slot="tool-pane"]`)
  const address = node!.querySelector<HTMLInputElement>('[aria-label="Address"]')!
  act(() => address.focus())
  const active = new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true, cancelable: true })
  await act(async () => { document.dispatchEvent(active); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(active.defaultPrevented).toBe(true)
  const before = dockViews(store.getSnapshot().workbench.right).find(one => one.id === entry.id)!
  await act(async () => root.render(<StoreProvider store={store}><Workbench suspended sidebar={<div />} /></StoreProvider>))
  expect(container.querySelector(`[data-tool-mount="${entry.id}"] [data-slot="tool-pane"]`)).toBe(node)
  expect(container.querySelector(`[data-tool-mount="${entry.id}"]`)?.hasAttribute('inert')).toBe(true)
  expect(container.querySelector('[data-slot="work-tools"]')?.getAttribute('data-open')).toBe('false')
  const hidden = new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true, cancelable: true })
  act(() => document.dispatchEvent(hidden))
  expect(hidden.defaultPrevented).toBe(false)
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === entry.id)?.view).toBe(before.view)
  // A real work request is remembered under the covered window, without revealing its tools.
  act(() => store.chooseWorkTool('activity'))
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.tool).toBe('activity')
  expect(container.querySelector('[data-slot="work-tools"]')?.getAttribute('data-open')).toBe('false')
  await act(async () => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} /></StoreProvider>))
  expect(container.querySelector('[data-slot="work-tools"]')?.getAttribute('data-tool')).toBe('activity')
  expect(container.querySelector('[data-slot="work-tools"]')?.getAttribute('data-open')).toBe('true')
  act(() => store.revealView(entry.id))
  expect(container.querySelector(`[data-tool-mount="${entry.id}"] [data-slot="tool-pane"]`)).toBe(node)
  expect(container.querySelector(`[data-tool-mount="${entry.id}"]`)?.hasAttribute('inert')).toBe(false)
})


it('default Changes and Activity provide actual subject bodies through canonical doors', async () => {
  const store = mountWork(true)
  await act(async () => button('Changes')!.click())
  expect(container.querySelector('[data-slot="work-tools"][data-tool="changes"] [data-slot="tool-body"]')).not.toBeNull()
  await act(async () => store.chooseWorkTool('activity'))
  expect(container.querySelector('[data-slot="work-tools"]')?.textContent).toContain('Events')
})


it('the five region nodes and the Browser body survive closing and both exact folds', async () => {
  const store = mountWork(true)
  await act(async () => { await store.openBrowser() })
  const regions = [...container.querySelectorAll('[data-frame-region]')]
  expect(regions.map(node => node.getAttribute('data-frame-region'))).toEqual(['left', 'top', 'main', 'rail', 'right', 'bottom'])
  const browser = container.querySelector('[data-slot="tool-pane"]')!
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  for (const width of [1280, 1279, 1000, 999, 720, 1440]) {
    act(() => store.setWindowSize(width, 900))
    expect([...container.querySelectorAll('[data-frame-region]')]).toEqual(regions)
    expect(container.querySelector('[data-slot="tool-pane"]')).toBe(browser)
    expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === resource.id)?.view).toBe(resource.view)
  }
  act(() => store.toggleWorkPanel())
  expect(container.querySelector('[data-slot="tool-pane"]')).toBe(browser)
  expect(regions[4]!.hasAttribute('inert')).toBe(true)
  act(() => store.toggleWorkPanel())
  expect([...container.querySelectorAll('[data-frame-region]')]).toEqual(regions)
})

it('right-tool Escape is scoped, respects a nested refusal, and returns focus to its door', async () => {
  const store = mountWork(true)
  act(() => store.setWindowSize(720, 900))
  await act(async () => { await store.openBrowser() })
  const subject = store.workSubject()!
  const main = container.querySelector<HTMLElement>('[data-slot="workbench-main"]')!
  const address = container.querySelector<HTMLInputElement>('[data-slot="tool-pane"] input')!
  const outside = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => main.dispatchEvent(outside))
  expect(outside.defaultPrevented).toBe(false)
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(true)
  const stop = (event: KeyboardEvent) => event.preventDefault()
  address.addEventListener('keydown', stop)
  act(() => address.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(true)
  address.removeEventListener('keydown', stop)
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => { address.dispatchEvent(escape); await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(escape.defaultPrevented).toBe(true)
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
  expect(document.activeElement).toBe(button('Browser'))
  expect(container.querySelector('[data-slot="workbench-main"]')!.hasAttribute('inert')).toBe(false)
})

it('a deferred Activity Escape returns to the current same-subject tool instead of its captured door', () => {
  const store = mountWork(true)
  act(() => store.chooseWorkTool('activity'))
  const subject = store.workSubject()!
  const body = container.querySelector<HTMLElement>('[data-slot="work-tools"]')!
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  act(() => body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
  expect(frames.length).toBeGreaterThan(0)
  act(() => store.chooseWorkTool('details'))
  expect(store.workSubject()).toBe(subject)
  act(() => button('Toggle rail')!.focus())
  act(() => { for (const callback of [...frames]) callback(0) })
  expect(document.activeElement).toBe(button('Toggle rail'))
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'details', open: true })
})

it('a page keeps remembered work, Browser, terminal and the shared notice host mounted', async () => {
  const store = mountWork(true)
  await act(async () => { await store.openBrowser(); await store.openTerminal() })
  const before = store.getSnapshot().workbench
  const workPane = container.querySelector('[data-slot="workbench-main"] [data-pane-id]')!
  const browser = container.querySelector('[data-slot="tool-pane"]')!
  const terminal = container.querySelector('[data-frame-region="right"] [data-terminal-id]')!
  expect(workPane).not.toBeNull(); expect(browser).not.toBeNull(); expect(terminal).not.toBeNull()
  const draw = (pageActive: boolean) => act(() => root.render(<StoreProvider store={store}>
    <Workbench sidebar={<div />} pageActive={pageActive} pageOwner={pageActive ? 'destination:library' : undefined}
      pages={<DestinationBody id="library" active={pageActive}><DestinationPageScope owner="destination:library" active={pageActive}>
        <DestinationBar place="Library" /><input aria-label="Library query" />
      </DestinationPageScope></DestinationBody>} />
  </StoreProvider>))
  draw(true)
  expect(container.querySelector('[data-slot="retained-work"]')?.hasAttribute('data-hidden')).toBe(true)
  expect(container.querySelector('[data-slot="retained-work"]')?.hasAttribute('inert')).toBe(true)
  const shell = container.querySelector<HTMLElement>('[data-slot="fixed-shell"]')!
  expect(shell.getAttribute('data-right-open')).toBe('true')
  expect(shell.getAttribute('data-panel-floats')).toBe('false')
  expect(shell.style.getPropertyValue('--frame-right-size')).toBe(`${FRAME.rightPanel.width}px`)
  expect(shell.style.getPropertyValue('--frame-right-open')).toBe(`${FRAME.rightPanel.width}px`)
  expect(container.querySelector('[data-topbar-title]')?.textContent).toBe('Library')
  expect(container.querySelectorAll('[data-shell-host="main-notice"]')).toHaveLength(1)
  expect(container.querySelector('[data-shell-host="main-notice"]')?.closest('[data-slot="retained-work"]')).toBeNull()
  expect(container.querySelector('[data-frame-region="right"] [data-terminal-id]')).toBe(terminal)
  expect(container.querySelector('[data-slot="tool-pane"]')).toBe(browser)
  expect(store.getSnapshot().workbench.frameTools).toBe(before.frameTools)
  expect(store.getSnapshot().workbench.bottom).toBe(before.bottom)
  draw(false)
  expect(container.querySelector('[data-slot="retained-work"]')?.hasAttribute('data-hidden')).toBe(false)
  expect(container.querySelector('[data-slot="workbench-main"] [data-pane-id]')).toBe(workPane)
  expect(container.querySelector('[data-slot="tool-pane"]')).toBe(browser)
  expect(container.querySelector('[data-frame-region="right"] [data-terminal-id]')).toBe(terminal)
  expect(shell.getAttribute('data-right-open')).toBe('true')
  expect(store.getSnapshot().activeSessionKey).toBe(PREVIEW_SESSION_KEY)
})

it('folderless pages hide the terminal without changing its shells or saved height', async () => {
  const store = mountWork(true)
  await act(async () => store.openTerminal())
  const terminal = container.querySelector('[data-terminal-id]')!
  const before = store.getSnapshot().workbench
  Object.assign(store.getSnapshot(), { workspace: null })
  Object.assign(before, { navigation: { current: { kind: 'agents' }, back: [], forward: [] } })
  act(() => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} pageActive /></StoreProvider>))
  const shell = container.querySelector<HTMLElement>('[data-slot="fixed-shell"]')!
  expect(shell.dataset.bottomOpen).toBe('false')
  expect(shell.style.getPropertyValue('--frame-bottom-size')).toBe('0px')
  expect(container.querySelector('[data-terminal-id]')).toBe(terminal)
  expect(store.getSnapshot().workbench.bottom).toBe(before.bottom)
  Object.assign(before, { navigation: { current: { kind: 'work', view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } }, back: [], forward: [] } })
  act(() => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} /></StoreProvider>))
  expect(shell.dataset.rightOpen).toBe('true')
  expect(container.querySelector('[data-terminal-id]')).toBe(terminal)
  expect(store.getSnapshot().workbench.bottom).toBe(before.bottom)
})

it('Editor has one scoped right Conversation composer and retains main chrome without duplicate approvals', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1 })
  const { frameDestinationStore } = await import('../preview/frame-destination-store')
  const store = frameDestinationStore(previewStore())
  store.showViewIn('main', { kind: 'conversation', session: PREVIEW_SESSION_KEY })
  store.chooseWorkTool('activity'); store.toggleWorkPanel()
  await act(async () => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} /></StoreProvider>))
  await act(async () => store.setWindowMode('editor'))
  expect([...container.querySelectorAll('[data-work-tool]')].map(one => one.getAttribute('data-work-tool'))).toEqual(['conversation', 'terminal', 'changes', 'browser', 'files'])
  expect(container.querySelector('[data-work-tool="conversation"]')?.getAttribute('aria-pressed')).toBe('true')
  const main = container.querySelector('[data-frame-region="main"]')!, right = container.querySelector('[data-frame-region="right"]')!
  expect(main.querySelector('[data-slot="composer"]')).toBeNull()
  expect(main.querySelector('[data-live-transcript]')).toBeNull()
  expect(right.querySelectorAll('[data-slot="composer"]')).toHaveLength(1)
  expect(right.querySelectorAll('[data-live-transcript]')).toHaveLength(1)
  expect(container.querySelectorAll('[data-slot="composer"]')).toHaveLength(1)
  const textarea = right.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: { text: 'Review the open file', replace: true } })))
  expect(textarea.value).toBe('Review the open file')
  expect(document.activeElement).toBe(textarea)
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]?.open).toBe(false)
  await act(async () => store.chooseWorkTool('conversation'))
  await act(async () => store.chooseWorkTool('details'))
  expect(right.querySelector('textarea')).toBe(textarea)
  await act(async () => store.chooseWorkTool('conversation'))
  expect(textarea.value).toBe('Review the open file')
  await act(async () => store.setWindowMode('conversation'))
  expect(container.querySelectorAll('[data-work-tool]')).toHaveLength(4)
  expect(main.querySelectorAll('[data-slot="composer"]')).toHaveLength(1)
  expect(main.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Review the open file')
  expect(right.querySelector('[data-slot="composer"]')).toBeNull()
  expect(store.getSnapshot().workbench.frameTools[store.workSubject()!]).toEqual({ tool: 'activity', mode: 'activity', open: false })
  Object.assign(store.getSnapshot(), { approvals: [{ key: PREVIEW_SESSION_KEY, approval: {
    id: 'fixture-approval', sessionId: splitSessionKey(PREVIEW_SESSION_KEY).id, requestedAt: 1,
    type: 'command', command: 'pwd', cwd: '/work/storefront', actions: [],
    options: [{ id: 'yes', label: 'Run it', intent: 'approve' }, { id: 'no', label: 'Cancel', intent: 'deny' }],
  } as unknown as Approval }] })
  await act(async () => store.setWindowMode('editor'))
  expect(document.querySelectorAll('[data-slot="approval-dialog-scope"]')).toHaveLength(1)
  expect(right.querySelector('[data-slot="approval-dialog-scope"]')).toBeNull()
})

it('Editor routes session notices to the visible right composer and removes them while its tool is hidden', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 100))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1 })
  const { frameDestinationStore } = await import('../preview/frame-destination-store')
  const store = frameDestinationStore(previewStore())
  store.showViewIn('main', { kind: 'conversation', session: PREVIEW_SESSION_KEY })
  const from = splitSessionKey(PREVIEW_SESSION_KEY)
  Object.assign(store.getSnapshot(), { agentNotices: [{ id: 'fixture-question', from: { runtime: from.runtime, sessionId: from.id, name: 'File review' }, where: 'composer', title: 'Which checkout path should I update?', at: 1 }] })
  store.setWindowMode('editor')
  await act(async () => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} /></StoreProvider>))
  const right = container.querySelector('[data-frame-region="right"]')!
  expect(right.querySelector('[data-slot="composer-notice"]')?.textContent ?? '').toContain('Which checkout path should I update?')
  await act(async () => store.chooseWorkTool('details'))
  expect(right.querySelector('[data-slot="composer-notice"]')).toBeNull()
  await act(async () => store.chooseWorkTool('conversation'))
  expect(right.querySelector('[data-slot="composer-notice"]')?.textContent ?? '').toContain('Which checkout path should I update?')
})

it('a Browser focused in Editor cannot strand compose events after the prior Details panel is restored', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1 })
  const { frameDestinationStore } = await import('../preview/frame-destination-store')
  const store = frameDestinationStore(previewStore())
  store.showViewIn('main', { kind: 'conversation', session: PREVIEW_SESSION_KEY })
  store.chooseWorkTool('details'); store.setWindowMode('editor')
  await act(async () => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} /></StoreProvider>))
  await act(async () => store.openBrowser())
  const browser = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  await act(async () => store.focusView(browser.id))
  await act(async () => store.setWindowMode('conversation'))
  const textarea = container.querySelector<HTMLTextAreaElement>('[data-frame-region="main"] textarea')!
  await act(async () => window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: { paneId: store.getSnapshot().layout.focused, text: 'Continue reviewing the checkout', replace: true } })))
  expect(textarea.value).toBe('Continue reviewing the checkout')
  expect(document.activeElement).toBe(textarea)
})


it('a retained Team Details pane receives keyboard scope when leaving a Browser-focused Editor', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1 })
  const { frameDestinationStore } = await import('../preview/frame-destination-store')
  const store = frameDestinationStore(previewStore())
  store.openTeamRoom(PREVIEW_ROOM); store.chooseWorkTool('details')
  store.showViewIn('main', { kind: 'conversation', session: PREVIEW_SESSION_KEY })
  store.chooseWorkTool('details'); store.setWindowMode('editor')
  await act(async () => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} /></StoreProvider>))
  await act(async () => store.openBrowser())
  const browser = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  await act(async () => store.focusView(browser.id))
  await act(async () => store.openTeamRoom(PREVIEW_ROOM))
  const snapshot = store.getSnapshot(), pane = snapshot.layout.root
  if (pane.kind !== 'pane') throw new Error('expected one Team destination')
  const FocusProbe = () => <output data-team-keyboard-scope>{String(useIsFocusedPane())}</output>
  await act(async () => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} />
    <PaneProvider scope={{ paneId: pane.id, view: pane.view, sessionKey: null }}><FocusProbe /></PaneProvider>
  </StoreProvider>))
  expect(container.querySelector(`[data-tool-mount="${browser.id}"]`)?.hasAttribute('data-hidden')).toBe(true)
  expect(container.querySelector('[data-slot="work-tools"]')?.getAttribute('data-tool')).toBe('details')
  expect(container.querySelector('[data-team-keyboard-scope]')?.textContent).toBe('true')
})


it('pages keep the terminal visible when the project is still chosen', async () => {
  const store = mountWork(true)
  await act(async () => store.openTerminal())
  const terminal = container.querySelector('[data-terminal-id]')!
  const before = store.getSnapshot().workbench
  Object.assign(before, { navigation: { current: { kind: 'agents' }, back: [], forward: [] } })
  act(() => root.render(<StoreProvider store={store}><Workbench sidebar={<div />} pageActive /></StoreProvider>))
  expect(container.querySelector<HTMLElement>('[data-slot="fixed-shell"]')!.dataset.rightOpen).toBe('true')
  expect(container.querySelector('[data-terminal-id]')).toBe(terminal)
  expect(store.getSnapshot().workbench.bottom).toBe(before.bottom)
})
