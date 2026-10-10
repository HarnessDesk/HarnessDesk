import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore, PREVIEW_SESSION_KEY } from '../preview/harness'
import { overviewTeamStore } from '../preview/team-overview-fixture'
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
  act(() => container.querySelector<HTMLButtonElement>('button[title="Team members"]')!.click())
  const watch = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="team-members"] button')].find(one => one.getAttribute('aria-label')?.startsWith(`Watch ${name} `))!
  expect(watch).not.toBeUndefined()
  await act(async () => watch.closest<HTMLElement>('[data-slot="list-row"]')!.click())
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

it('the retained Team header closes and reopens its remembered Browser without replacing the resource', async () => {
  const { store } = await mountTeam()
  await act(async () => { await store.openBrowser() })
  const subject = store.workSubject()!
  const resource = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  const toggle = button('Toggle right panel')!
  expect(toggle).not.toBeNull()
  expect(toggle.closest('[data-slot="tool-pane-header"]')).not.toBeNull()
  act(() => toggle.click())
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(false)
  act(() => toggle.click())
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'browser', mode: 'browser', open: true })
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === resource.id)?.view).toBe(resource.view)
})

it('a narrow Team Run auto-collapses its legacy inspector without drawing an empty overlay', async () => {
  const { store } = await mountTeam(false, 720)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  const snapshot = store.getSnapshot()
  const subject = store.workSubject()!
  const inspector = dockViews(snapshot.workbench.right).find(one => one.view.kind === 'run-details')!
  expect(inspector).not.toBeUndefined()
  expect(snapshot.workbench.right.collapsed).toBe(true)
  expect(snapshot.windowWidth).toBe(720)
  expect(snapshot.workbench.frameTools[subject]).toMatchObject({ tool: 'details', mode: 'run-details', open: false })
  expect(container.querySelector('[data-slot="run-workspace"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="workbench-main"]')?.closest('[inert]')).toBeNull()
  act(() => button('Toggle right panel')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]?.open).toBe(true)
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === inspector.id)?.view).toBe(inspector.view)
  expect(container.querySelector('[data-slot="run-inspector"]')).not.toBeNull()
})

it('the retained Team toggle preserves selected Steps through close and reopen', async () => {
  const { store } = await mountTeam()
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  const flow = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(one => one.textContent === 'Flow')!
  expect(flow).not.toBeUndefined()
  await act(async () => flow.click())
  const subject = store.workSubject()!
  const before = store.getSnapshot().workbench
  const steps = dockViews(before.right).find(one => one.view.kind === 'run-steps')!
  expect(activeView(before.right)?.id).toBe(steps.id)
  expect(before.frameTools[subject]).toMatchObject({ tool: 'details', mode: 'run-details', open: true })
  act(() => button('Toggle right panel')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'details', mode: 'run-details', open: false })
  expect(activeView(store.getSnapshot().workbench.right)?.id).toBe(steps.id)
  act(() => button('Toggle right panel')!.click())
  expect(store.getSnapshot().workbench.frameTools[subject]).toMatchObject({ tool: 'details', mode: 'run-details', open: true })
  expect(activeView(store.getSnapshot().workbench.right)?.id).toBe(steps.id)
  expect(dockViews(store.getSnapshot().workbench.right)).toEqual(dockViews(before.right))
  expect(dockViews(store.getSnapshot().workbench.right).find(one => one.id === steps.id)?.view).toBe(steps.view)
  const stepsBody = container.querySelector('[data-slot="run-steps"]')!
  expect(stepsBody).not.toBeNull()
  expect(stepsBody.closest('[data-hidden], [inert]')).toBeNull()
})

it('a narrow Team Flow opens its retained Steps with one unpressed toggle click', async () => {
  const { store } = await mountTeam(false, 720)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!.click())
  const flow = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(one => one.textContent === 'Flow')!
  expect(flow).not.toBeUndefined()
  await act(async () => flow.click())
  const subject = store.workSubject()!
  const before = store.getSnapshot().workbench
  const steps = dockViews(before.right).find(one => one.view.kind === 'run-steps')!
  expect(before.right.collapsed).toBe(false)
  expect(before.frameTools[subject]).toMatchObject({ tool: 'details', mode: 'run-details', open: false })
  expect(activeView(before.right)?.id).toBe(steps.id)
  const toggle = button('Toggle right panel')!
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  act(() => toggle.click())
  const after = store.getSnapshot().workbench
  expect(after.frameTools[subject]).toMatchObject({ tool: 'details', mode: 'run-details', open: true })
  expect(after.right.collapsed).toBe(false)
  expect(activeView(after.right)?.id).toBe(steps.id)
  expect(dockViews(after.right)).toEqual(dockViews(before.right))
  expect(dockViews(after.right).find(one => one.id === steps.id)?.view).toBe(steps.view)
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  const stepsBody = container.querySelector('[data-slot="run-steps"]')!
  expect(stepsBody).not.toBeNull()
  expect(stepsBody.closest('[data-hidden], [inert]')).toBeNull()
})

it('an embedded Team member keeps its own folder Commit and legacy tool aliases in canonical More', async () => {
  const { store } = await mountTeam(true)
  await selectMember('Alpha')
  const bar = container.querySelector('[data-slot="top-bar"]')!
  if (!bar) throw new Error('Selected Team member has no canonical bar')
  expect(bar.querySelector('[data-work-tool]') === null).toBe(true)
  act(() => bar.querySelector<HTMLButtonElement>('button[title="More"]')!.click())
  const rows = () => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"], [role="menu"] button')]
  expect(rows().some(one => one.textContent?.includes('Compact now'))).toBe(true)
  expect(rows().some(one => one.textContent?.includes('Save as an Agent'))).toBe(true)
  expect(rows().some(one => one.textContent === 'Browser')).toBe(true)
  expect(rows().filter(one => /^Changes(?: ·|$)/.test(one.textContent ?? ''))).toHaveLength(0)
  const folder = rows().find(one => one.textContent?.startsWith('Folder actions'))!
  expect(folder).not.toBeUndefined()
  act(() => folder.click())
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
  expect(container.querySelector('[data-topbar-title]')?.textContent).toContain('Reviewer conversation')
  expect(container.querySelector<HTMLTextAreaElement>('[data-slot="workbench-main"] textarea')?.value).toBe('')
  act(() => container.querySelector<HTMLButtonElement>('[data-team-page="room"]')!.click())
  expect(container.querySelector('[data-slot="top-bar"]')).toBeNull()
})
