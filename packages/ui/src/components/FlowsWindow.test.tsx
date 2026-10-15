import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { FlowEntry } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { TopBarOutlet, TopBarProvider } from '../panels/top-bar'
import { DestinationPageScope } from '../panels/destination-page'
import { emptyShapePolicy } from '../lib/shapes'
import { FlowsWindow } from './FlowsWindow'
import { PREVIEW_GOAL } from '../preview/goal-fixture'
import type { AppSnapshot, AppStore } from '../state/store'
import { triggerProjectView } from '../preview/intake-fixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const container = document.createElement('div')
document.body.append(container)
const root = createRoot(container)
afterEach(() => { act(() => root.render(null)); vi.restoreAllMocks() })
const entry = (id: string, origin: FlowEntry['origin']): FlowEntry => ({
  id, origin, name: id === 'review' ? 'Review a change' : 'Release notes', path: `${id}.yml`,
  format: 'agents', description: 'One round', summary: null, shadows: [], problem: null,
  policy: { ...emptyShapePolicy(), name: id },
})
const mount = async (prepare?: (store: AppStore) => void) => {
  const store = previewStore({ workspaces: [{ path: '/work/demo', name: 'Demo', lastOpenedAt: 1 }], workspace: { path: '/work/demo', name: 'Demo', lastOpenedAt: 1 } })
  const catalog = vi.spyOn(store, 'flowCatalog').mockImplementation(async () => [entry('review', 'builtin'), entry('release', 'project')])
  prepare?.(store)
  const open = vi.fn(), create = vi.fn()
  await act(async () => root.render(<StoreProvider store={store}><TopBarProvider>
    <DestinationPageScope owner="destination:flows" active><FlowsWindow onOpen={open} onNew={create} /></DestinationPageScope>
    <TopBarOutlet owner="destination:flows" fallback={{place:'Flows',more:()=>null}} />
  </TopBarProvider></StoreProvider>))
  return { open, create, store, catalog }
}

it('lists the real catalogue plus Just a Team, opens an origin-bound Flow and creates in the chosen project', async () => {
  const { open, create } = await mount()
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes(text))!
  expect(button('Just a Team')).toBeDefined()
  await act(async () => button('Review a change').click())
  expect(open).toHaveBeenCalledWith('/work/demo', 'review', 'builtin')
  await act(async () => button('New Flow').click())
  expect(create).toHaveBeenCalledWith('/work/demo')
})

it('filters cards by origin and search without previewing or starting a Team', async () => {
  const { store } = await mount()
  const preview = vi.spyOn(store, 'previewFrontDoor')
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Flow origin"]')!
  await act(async () => { select.value = 'builtin'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.textContent).toContain('Review a change')
  expect(container.textContent).not.toContain('Release notes')
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search Flows"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'missing')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.textContent).toContain('No matching Flows')
  expect(preview).not.toHaveBeenCalled()
})

it('keeps failed Run coverage unknown rather than showing a zero or treating a Team as plain', async () => {
  await mount(store => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ goals: new Map([[PREVIEW_GOAL.goal.id, { ...PREVIEW_GOAL, goal: { ...PREVIEW_GOAL.goal, root: '/work/demo' } }]]), flowExecutions: new Map() })
    vi.spyOn(store, 'loadTeamRunsBatch').mockResolvedValue({ loaded: new Set(), unavailable: new Set([PREVIEW_GOAL.goal.id]) })
  })
  const cards = [...container.querySelectorAll('[data-slot="flow-card"]')]
  expect(cards.every(card => card.textContent?.includes('— matching Runs'))).toBe(true)
  expect(cards.some(card => /\b[01] Runs/.test(card.textContent ?? ''))).toBe(false)
})

it('keeps an unread Team catalogue unknown, even when the current snapshot has no Teams', async () => {
  await mount(store => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ goals: new Map(), flowExecutions: new Map() })
    vi.spyOn(store, 'loadGoals').mockRejectedValue(new Error('Team catalogue unavailable'))
  })
  expect([...container.querySelectorAll('[data-slot="flow-card-runs"]')].every(count => count.textContent?.includes('—'))).toBe(true)
})

it('retires the old project cards while the next project catalogue is still loading', async () => {
  const { store, catalog } = await mount()
  catalog.mockImplementation(() => new Promise(() => {}))
  await act(async () => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspace: { path: '/work/other', name: 'Other', lastOpenedAt: 2 }, workspaces: [] })
  })
  expect(container.textContent).toContain('Reading Flows')
  expect(container.querySelector('button[aria-label="Open Release notes"]')).toBeNull()
})

it('keeps Agent triggers reachable for arming, disarming and review after they leave Settings', async () => {
  await mount(store => {
    const view = triggerProjectView()
    const first = view.triggers[0]!
    vi.spyOn(store, 'projectTriggers').mockResolvedValue({ ...view, triggers: [{ ...first, id: 'agent-review', definition: { ...first.definition!, opens: { agent: 'code-reviewer' } } }] })
  })
  await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  const manage = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Manage triggers'))
  expect(manage).toBeDefined()
  await act(async () => manage!.click())
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Triggers')
  expect(document.querySelector('[aria-label="Arm agent-review"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Pause every trigger"]')).not.toBeNull()
})

it('keeps machine-wide trigger preferences reachable without a project or project-trigger read', async () => {
  const { store } = await mount(store => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspace: null, workspaces: [] })
  })
  const projectTriggers = vi.spyOn(store, 'projectTriggers')
  const setPreferences = vi.spyOn(store, 'setTriggerPreferences')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  const manage = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Manage triggers'))!
  expect(manage.getAttribute('aria-disabled')).not.toBe('true')
  await act(async () => manage.click())
  const dialog = document.querySelector('[role="dialog"][aria-label="Triggers"]')!
  expect(dialog).not.toBeNull()
  expect(dialog.querySelector('select')).toBeNull()
  expect(projectTriggers).not.toHaveBeenCalled()
  expect(dialog.querySelector('[aria-label="Stop for the day after, in US dollars"]')).not.toBeNull()
  const pause = dialog.querySelector<HTMLButtonElement>('[aria-label="Pause every trigger"]')!
  expect(pause).not.toBeNull()
  await act(async () => pause.click())
  expect(setPreferences).toHaveBeenCalledOnce()
  expect(pause.getAttribute('aria-checked')).toBe('true')
  expect(projectTriggers).not.toHaveBeenCalled()
})
