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
import * as frontDoor from './FrontDoor'
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
  expect(open).not.toHaveBeenCalled()
  expect(container.querySelector('section[aria-label="Review a change"]')).not.toBeNull()
  expect(document.body.textContent).toContain('Example')
  const edit = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Edit Flow')!
  await act(async () => edit.click())
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

it('groups unavailable project reads behind one notice and creates only in a readable project', async () => {
  const { create } = await mount(store => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({
      workspace: { path: '/work/deleted-0', name: 'Deleted 0', lastOpenedAt: 2 },
      workspaces: [...Array.from({ length: 20 }, (_, index) => ({ path: `/work/deleted-${index}`, name: `Deleted ${index}`, lastOpenedAt: 1 })), { path: '/work/demo', name: 'Demo', lastOpenedAt: 1 }],
    })
    vi.spyOn(store, 'flowCatalog').mockImplementation(async root => {
      if (root !== '/work/demo') throw new Error(`ENOENT: no such file or directory, realpath '${root}'`)
      return [entry('review', 'builtin'), entry('release', 'project')]
    })
  })
  expect(container.querySelectorAll('[data-slot="alert"]')).toHaveLength(1)
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.textContent).toContain('Flows could not be read from 20 project folders.')
  expect(container.textContent).not.toContain('ENOENT')
  expect(container.querySelector('button[aria-label="Open Review a change"]')).not.toBeNull()
  const origins = [...container.querySelectorAll<HTMLOptionElement>('select[aria-label="Flow origin"] option')].map(option => option.value)
  expect(origins).toEqual(['all', 'builtin', '/work/demo'])
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New Flow')!.click())
  expect(create).toHaveBeenCalledWith('/work/demo')
  const details = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Folder details'))!
  await act(async () => details.click())
  expect(details.getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).toContain("realpath '/work/deleted-19'")
})

it('disables project actions when no catalogue can be read and retries restored folders', async () => {
  const { catalog, create } = await mount(store => {
    vi.spyOn(store, 'flowCatalog').mockRejectedValue(new Error('Project folder is unavailable'))
  })
  const newFlow = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New Flow')!
  expect(newFlow.disabled).toBe(true)
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Open Just a Team"]')?.disabled).toBe(true)
  expect(container.textContent).toContain('Flows could not be read from 1 project folder.')
  catalog.mockResolvedValue([entry('review', 'builtin')])
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!.click())
  expect(container.querySelectorAll('[data-slot="alert"]')).toHaveLength(0)
  expect(newFlow.disabled).toBe(false)
  await act(async () => newFlow.click())
  expect(create).toHaveBeenCalledWith('/work/demo')
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

it('names the Flows page once in its body and keeps the shell bar for tools', async () => {
  await mount()
  const heading = container.querySelector('h1')
  expect(heading?.textContent).toBe('Flows')
  expect(heading?.closest('[data-slot="page"]')).not.toBeNull()
  expect(container.querySelector('[data-topbar-title]')).toBeNull()
})


it('keeps catalogue inspection local until Start Team is requested', async () => {
  const { store } = await mount()
  const preview = vi.spyOn(store, 'previewFrontDoor')
  const source = vi.spyOn(store, 'flowSource')
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Review a change"]')!.click())
  expect(source).not.toHaveBeenCalled()
  expect(preview).not.toHaveBeenCalled()
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Start Team')).toBe(true)
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search Flows"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'missing')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.querySelector('section[aria-label="Review a change"]')).toBeNull()
})

it('inspects custom earlier-format entries and keeps broken entries disabled', async () => {
  await mount(store => {
    vi.spyOn(store, 'flowCatalog').mockResolvedValue([
      { ...entry('custom', 'user'), name: 'Custom path', policy: null },
      { ...entry('broken', 'project'), name: 'Broken path', problem: 'Cannot parse this Flow' },
    ])
  })
  const broken = container.querySelector<HTMLButtonElement>('button[aria-label="Open Broken path"]')!
  expect(broken.disabled).toBe(true)
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Custom path"]')!.click())
  expect(container.textContent).toContain('This earlier Flow format has no drawable policy')
  expect(container.textContent).toContain('Edit Flow')
})


it('passes the selected catalogue identity to the existing Team launch contract', async () => {
  const launch = vi.spyOn(frontDoor, 'FrontDoor').mockImplementation(() => <div data-test-launch="" />)
  await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Review a change"]')!.click())
  expect(launch).not.toHaveBeenCalled()
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Start Team')!.click())
  expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({ context: { kind: 'project', root: '/work/demo' }, initial: { id: 'review', origin: 'builtin' } })
})


it('puts the selected example before the gallery and focuses its detail region', async () => {
  await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Review a change"]')!.click())
  const detail = container.querySelector<HTMLElement>('section[aria-label="Review a change"]')!
  const gallery = container.querySelector('[data-slot="flow-card-grid"]')!
  expect(detail.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(document.activeElement).toBe(detail)
})

it('preserves example playback across unrelated host snapshots', async () => {
  const { store } = await mount(store => {
    vi.spyOn(store, 'flowCatalog').mockResolvedValue([{ ...entry('review', 'builtin'), policy: {
      ...emptyShapePolicy(), seed: { role: 'work', title: 'Task' },
      roles: [{ id: 'work', kind: 'agent', grant: 'read', isolate: false, uses: [], seats: [], independentOf: [] }],
    } }])
  })
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Review a change"]')!.click())
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Play')!.click())
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Pause')).toBe(true)
  await act(async () => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspace: { path: '/work/demo', name: 'Demo', lastOpenedAt: 2 } })
  })
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Pause')).toBe(true)
})

it.each(['changed', 'broken'] as const)('resolves the selected identity against a delayed %s catalogue refresh', async state => {
  const { store, catalog } = await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Review a change"]')!.click())
  let release!: (entries: readonly FlowEntry[]) => void
  const pending = new Promise<readonly FlowEntry[]>(resolve => { release = resolve })
  catalog.mockImplementation(() => pending)
  await act(async () => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspaces: [
      { path: '/work/demo', name: 'Demo', lastOpenedAt: 1 },
      { path: '/work/other', name: 'Other', lastOpenedAt: 2 },
    ] })
  })
  expect(container.querySelector('section[aria-label="Review a change"]')).toBeNull()
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Start Team')).toBe(false)
  const fresh = { ...entry('review', 'builtin'), name: 'Updated Flow', policy: { ...emptyShapePolicy(), roles: [{ id: 'updated_person', kind: 'person' as const, outcomes: ['done'] }], seed: { role: 'updated_person', title: 'Updated task' } }, ...(state === 'broken' ? { problem: 'The changed source cannot be parsed', policy: null } : {}) }
  await act(async () => release([fresh]))
  const detail = container.querySelector<HTMLElement>('section[aria-label="Updated Flow"]')!
  expect(detail).not.toBeNull()
  const start = [...detail.querySelectorAll('button')].find(button => button.textContent === 'Start Team')!
  if (state === 'broken') {
    expect(start.disabled).toBe(true)
    expect(detail.textContent).toContain('The changed source cannot be parsed')
    expect(detail.querySelector('[data-slot="flow-example"]')).toBeNull()
  } else {
    expect(start.disabled).toBe(false)
    expect(detail.textContent).toContain('Updated person')
    expect(detail.textContent).not.toContain('Example step: Review')
  }
})
