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
import * as triggersView from './ProjectTriggers'
import { PREVIEW_GOAL } from '../preview/goal-fixture'
import type { AppSnapshot, AppStore } from '../state/store'
import { prDefinition, triggerProjectView } from '../preview/intake-fixture'

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
  await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  const manage = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Manage triggers'))!
  await act(async () => manage.click())
  expect([...document.querySelectorAll<HTMLOptionElement>('[role="dialog"][aria-label="Triggers"] select option')].map(option => option.value)).toEqual(['/work/demo'])
})

it('disables project actions when no catalogue can be read and retries restored folders', async () => {
  const { catalog, create } = await mount(store => {
    vi.spyOn(store, 'flowCatalog').mockRejectedValue(new Error('Project folder is unavailable'))
  })
  const newFlow = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New Flow')!
  expect(newFlow.disabled).toBe(true)
  expect(newFlow.title).toBe('No project folder could be read.')
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Open Just a Team"]')?.disabled).toBe(true)
  expect(container.textContent).toContain('Flows could not be read from 1 project folder.')
  expect(container.textContent).not.toContain('Open a project folder to build or start a Flow.')
  catalog.mockResolvedValue([entry('release', 'project')])
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!.click())
  expect(container.querySelectorAll('[data-slot="alert"]')).toHaveLength(0)
  expect(newFlow.disabled).toBe(false)
  await act(async () => newFlow.click())
  expect(create).toHaveBeenCalledWith('/work/demo')
  expect(container.querySelector('button[aria-label="Open Release notes"]')).not.toBeNull()
})

it('keeps folder details open through retry, refreshes failures and clears them after recovery', async () => {
  const launch = vi.spyOn(frontDoor, 'FrontDoor').mockImplementation(({ context }) => <input aria-label="Team draft" defaultValue={context.root} />)
  const { catalog } = await mount(store => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({
      workspaces: [{ path: '/work/demo', name: 'Demo', lastOpenedAt: 1 }, { path: '/work/missing', name: 'Missing', lastOpenedAt: 0 }],
    })
    vi.spyOn(store, 'flowCatalog').mockImplementation(async root => {
      if (root === '/work/missing') throw new Error('Old failure')
      return [entry('review', 'builtin')]
    })
  })
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Just a Team"]')!.click())
  const draft = document.querySelector<HTMLInputElement>('[aria-label="Team draft"]')!
  draft.value = 'Draft retained'
  const details = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Folder details')!
  await act(async () => details.click())
  expect(container.textContent).toContain('Old failure')
  let settle!: (entries: readonly FlowEntry[]) => void
  let fail!: (error: Error) => void
  const pending = new Promise<readonly FlowEntry[]>((resolve, reject) => { settle = resolve; fail = reject })
  catalog.mockImplementation(root => root === '/work/missing' ? pending : Promise.resolve([entry('review', 'builtin')]))
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!.click())
  expect(container.contains(details)).toBe(true)
  expect(details.getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).toContain('Reading Flows…')
  expect(container.textContent).not.toContain('Old failure')
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Retry')).toBe(false)
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="New Flow"]')!.disabled).toBe(true)
  expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({ context: { kind: 'project', root: '/work/demo' }, startBlocked: 'Reading project Flows…' })
  await act(async () => fail(new Error('New failure')))
  expect(details.getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).toContain('New failure')
  expect(container.textContent).not.toContain('Old failure')
  expect(document.querySelector('[aria-label="Team draft"]')).toBe(draft)
  expect(draft.value).toBe('Draft retained')
  const recovered = new Promise<readonly FlowEntry[]>(resolve => { settle = resolve })
  catalog.mockImplementation(root => root === '/work/missing' ? recovered : Promise.resolve([entry('review', 'builtin')]))
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!.click())
  expect(container.contains(details)).toBe(true)
  expect(details.getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).not.toContain('New failure')
  await act(async () => settle([entry('release', 'project')]))
  expect(container.querySelector('[data-slot="alert"]')).toBeNull()
  expect(container.textContent).not.toContain('New failure')
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Retry')).toBe(false)
  expect([...container.querySelectorAll<HTMLOptionElement>('select[aria-label="Flow origin"] option')].map(option => option.value)).toEqual(['all', 'builtin', '/work/demo', '/work/missing'])
  expect(document.querySelector('[aria-label="Team draft"]')).toBe(draft)
  expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({ context: { kind: 'project', root: '/work/demo' }, startBlocked: null })
})

it('keeps the selected project option while rereading and disables new work for the loading reason', async () => {
  const { catalog, store } = await mount()
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Flow origin"]')!
  await act(async () => { select.value = '/work/demo'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  catalog.mockImplementation(() => new Promise(() => {}))
  await act(async () => {
    const workbench = store.getSnapshot().workbench
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workbench: { ...workbench, navigation: { ...workbench.navigation, current: { kind: 'flows', root: null, id: null, origin: null } } } })
  })
  expect(container.textContent).toContain('Reading Flows')
  expect(select.value).toBe('/work/demo')
  const newFlow = container.querySelector<HTMLButtonElement>('button[aria-label="New Flow"]')!
  expect(newFlow.disabled).toBe(true)
  expect(newFlow.title).toBe('Reading Flows…')
})

it.each(['all', '/work/demo'])('clears an unavailable selection through recovery from %s', async origin => {
  const { catalog, store } = await mount()
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Flow origin"]')!
  await act(async () => { select.value = origin; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Release notes"]')!.click())
  expect(container.querySelector('section[aria-label="Release notes"]')).not.toBeNull()
  // A background route refresh observes that the selected folder disappeared.
  catalog.mockRejectedValue(new Error('Project folder is unavailable'))
  const retry = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!
  await act(async () => {
    const workbench = store.getSnapshot().workbench
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workbench: { ...workbench, navigation: { ...workbench.navigation, current: { kind: 'flows', root: null, id: null, origin: null } } } })
  })
  expect(select.value).toBe('all')
  expect(container.querySelector('section[aria-label="Release notes"]')).toBeNull()
  catalog.mockResolvedValue([entry('release', 'project')])
  await act(async () => retry().click())
  expect(container.querySelector('button[aria-label="Open Release notes"]')).not.toBeNull()
  expect(container.querySelector('section[aria-label="Release notes"]')).toBeNull()
})

it('ignores a late reply for a project that is no longer in the catalogue', async () => {
  let finish!: (entries: readonly FlowEntry[]) => void
  const pending = new Promise<readonly FlowEntry[]>(resolve => { finish = resolve })
  const { store, catalog } = await mount(store => { vi.spyOn(store, 'flowCatalog').mockReturnValue(pending) })
  catalog.mockResolvedValue([{ ...entry('review', 'builtin'), name: 'Current Flow' }])
  await act(async () => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspace: { path: '/work/other', name: 'Other', lastOpenedAt: 2 }, workspaces: [] })
  })
  expect(container.querySelector('button[aria-label="Open Current Flow"]')).not.toBeNull()
  await act(async () => finish([entry('release', 'project')]))
  expect(container.querySelector('button[aria-label="Open Current Flow"]')).not.toBeNull()
  expect(container.querySelector('button[aria-label="Open Release notes"]')).toBeNull()
})

it('keeps the current trigger editor mounted while an updated project list is being read', async () => {
  vi.spyOn(triggersView, 'ProjectTriggers').mockImplementation(({ root }) => <input aria-label="Trigger draft" defaultValue={root} />)
  const { store, catalog } = await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  const manage = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Manage triggers'))!
  await act(async () => manage.click())
  const draft = document.querySelector<HTMLInputElement>('[aria-label="Trigger draft"]')!
  draft.value = 'Unsaved trigger edit'
  catalog.mockImplementation(() => new Promise(() => {}))
  await act(async () => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspaces: [...store.getSnapshot().workspaces, { path: '/work/other', name: 'Other', lastOpenedAt: 2 }] })
  })
  expect(document.querySelector('[aria-label="Trigger draft"]')).toBe(draft)
  expect(draft.value).toBe('Unsaved trigger edit')
})

it('keeps the plain Team draft on its chosen project through a pending read and a changed default project', async () => {
  const launch = vi.spyOn(frontDoor, 'FrontDoor').mockImplementation(({ context }) => <input aria-label="Team draft" defaultValue={context.root} />)
  const { store, catalog } = await mount()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Just a Team"]')!.click())
  const draft = document.querySelector<HTMLInputElement>('[aria-label="Team draft"]')!
  draft.value = 'Unsaved task and seating choices'
  let finish!: (entries: readonly FlowEntry[]) => void
  const pending = new Promise<readonly FlowEntry[]>(resolve => { finish = resolve })
  catalog.mockReturnValue(pending)
  await act(async () => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspace: { path: '/work/other', name: 'Other', lastOpenedAt: 2 }, workspaces: [...store.getSnapshot().workspaces] })
  })
  expect(document.querySelector('[aria-label="Team draft"]')).toBe(draft)
  expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({ context: { kind: 'project', root: '/work/demo' }, startBlocked: 'Reading project Flows…' })
  await act(async () => finish([entry('review', 'builtin')]))
  expect(document.querySelector('[aria-label="Team draft"]')).toBe(draft)
  expect(draft.value).toBe('Unsaved task and seating choices')
  expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({ context: { kind: 'project', root: '/work/demo' }, startBlocked: null })
  catalog.mockRejectedValue(new Error('Project folder is unavailable'))
  await act(async () => {
    const workbench = store.getSnapshot().workbench
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workbench: { ...workbench, navigation: { ...workbench.navigation, current: { kind: 'flows', root: null, id: null, origin: null } } } })
  })
  expect(document.querySelector('[aria-label="Team draft"]')).toBe(draft)
  expect(draft.value).toBe('Unsaved task and seating choices')
  expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({ context: { kind: 'project', root: '/work/demo' }, startBlocked: 'This project folder is unavailable. Return to Flows and try again.' })
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

it.each([true, false])('retains the trigger editor when its root fails (another readable: %s)', async otherReadable => {
  vi.spyOn(triggersView, 'ProjectTriggers').mockImplementation(({ root }) => <input aria-label="Trigger draft" defaultValue={root} />)
  const { store, catalog } = await mount(store => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspaces: [
      { path: '/work/demo', name: 'Demo', lastOpenedAt: 1 }, { path: '/work/other', name: 'Other', lastOpenedAt: 2 },
    ] })
  })
  await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Manage triggers'))!.click())
  const draft = document.querySelector<HTMLInputElement>('[aria-label="Trigger draft"]')!
  draft.value = 'Unsaved trigger edit'
  catalog.mockImplementation(async project => {
    if (project === '/work/demo' || !otherReadable) throw new Error('Unavailable')
    return [entry('release', 'project')]
  })
  await act(async () => {
    const workbench = store.getSnapshot().workbench
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workbench: { ...workbench, navigation: { ...workbench.navigation, current: { kind: 'flows', root: null, id: null, origin: null } } } })
  })
  expect(document.querySelector('[aria-label="Trigger draft"]')).toBe(draft)
  expect(draft.value).toBe('Unsaved trigger edit')
  const dialog = document.querySelector('[role="dialog"][aria-label="Triggers"]')!
  expect(dialog.textContent).toContain('This project folder is unavailable')
  const select = dialog.querySelector<HTMLSelectElement>('select')!
  expect(select.value).toBe('/work/demo')
  expect([...select.options].map(option => option.value)).toEqual(otherReadable ? ['/work/demo', '/work/other'] : ['/work/demo'])
  expect(dialog.querySelector('[aria-label="Pause every trigger"]')).not.toBeNull()
  catalog.mockResolvedValue([entry('release', 'project')])
  await act(async () => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspaces: [...store.getSnapshot().workspaces, { path: '/work/recovered', name: 'Recovered', lastOpenedAt: 3 }] })
  })
  expect(document.querySelector('[aria-label="Trigger draft"]')).toBe(draft)
  expect(draft.value).toBe('Unsaved trigger edit')
  expect(dialog.textContent).not.toContain('This project folder is unavailable')
})

it('retains the explicitly chosen trigger project when it becomes unavailable', async () => {
  vi.spyOn(triggersView, 'ProjectTriggers').mockImplementation(({ root }) => <input aria-label="Trigger draft" defaultValue={root} />)
  const { store, catalog } = await mount(store => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspaces: [
      { path: '/work/demo', name: 'Demo', lastOpenedAt: 1 }, { path: '/work/other', name: 'Other', lastOpenedAt: 2 },
    ] })
  })
  await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Manage triggers'))!.click())
  const dialog = document.querySelector('[role="dialog"][aria-label="Triggers"]')!
  const select = dialog.querySelector<HTMLSelectElement>('select')!
  await act(async () => { select.value = '/work/other'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  const draft = document.querySelector<HTMLInputElement>('[aria-label="Trigger draft"]')!
  expect(draft.value).toBe('/work/other')
  draft.value = 'Other project draft'
  catalog.mockImplementation(async project => {
    if (project === '/work/other') throw new Error('Unavailable')
    return [entry('release', 'project')]
  })
  await act(async () => {
    const workbench = store.getSnapshot().workbench
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workbench: { ...workbench, navigation: { ...workbench.navigation, current: { kind: 'flows', root: null, id: null, origin: null } } } })
  })
  expect(select.value).toBe('/work/other')
  expect(document.querySelector('[aria-label="Trigger draft"]')).toBe(draft)
  expect(draft.value).toBe('Other project draft')
  expect(dialog.textContent).toContain('This project folder is unavailable')
  catalog.mockResolvedValue([entry('release', 'project')])
  await act(async () => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspaces: [...store.getSnapshot().workspaces, { path: '/work/recovered', name: 'Recovered', lastOpenedAt: 3 }] })
  })
  expect(select.value).toBe('/work/other')
  expect(document.querySelector('[aria-label="Trigger draft"]')).toBe(draft)
  expect(draft.value).toBe('Other project draft')
  expect(dialog.textContent).not.toContain('This project folder is unavailable')
  await act(async () => { select.value = '/work/demo'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(document.querySelector<HTMLInputElement>('[aria-label="Trigger draft"]')!.value).toBe('/work/demo')
})

it('keeps an actual unsaved trigger creation dialog when its project becomes unreadable', async () => {
  const { store, catalog } = await mount(store => {
    store.draftTrigger = async ({ id }) => prDefinition({ id })
    store.renderTriggers = async () => ({ source: 'triggers: []', issues: [] })
  })
  await act(async () => container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')!.click())
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Manage triggers'))!.click())
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New trigger…')!.click())
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Continue')!.click())
  const editor = document.querySelector('[role="dialog"][aria-label="Every time"]')!
  const label = [...editor.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent?.includes('Trigger name'))!
  const name = document.getElementById(label.htmlFor) as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'unsaved-trigger')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  catalog.mockRejectedValue(new Error('Unavailable'))
  await act(async () => {
    const workbench = store.getSnapshot().workbench
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workbench: { ...workbench, navigation: { ...workbench.navigation, current: { kind: 'flows', root: null, id: null, origin: null } } } })
  })
  expect(document.querySelector('[role="dialog"][aria-label="Every time"]')).toBe(editor)
  expect(name.value).toBe('unsaved-trigger')
})

it('keeps a real Flow Team draft and captured project through failure and recovery', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const { store, catalog } = await mount()
  const source = vi.spyOn(store, 'flowSource')
  const start = vi.spyOn(store, 'startFlowGoal')
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Release notes"]')!.click())
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Start Team')!.click())
  const dialog = document.querySelector('[role="dialog"][aria-label="New Team"]')!
  expect(dialog).not.toBeNull()
  expect(source).toHaveBeenCalledWith('/work/demo', 'release', 'project')
  const task = dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="What should they do?"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, 'Keep this Flow draft')
    task.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const startButton = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Start Team')!
  expect(startButton.disabled).toBe(false)
  catalog.mockRejectedValue(new Error('Unavailable'))
  await act(async () => {
    const workbench = store.getSnapshot().workbench
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workbench: { ...workbench, navigation: { ...workbench.navigation, current: { kind: 'flows', root: null, id: null, origin: null } } } })
  })
  expect(document.querySelector('[role="dialog"][aria-label="New Team"]')).toBe(dialog)
  expect(dialog.querySelector('textarea[aria-label="What should they do?"]')).toBe(task)
  expect(task.value).toBe('Keep this Flow draft')
  expect(startButton.disabled).toBe(true)
  expect(dialog.textContent).toContain('This project folder is unavailable')
  await act(async () => startButton.click())
  expect(start).not.toHaveBeenCalled()
  catalog.mockResolvedValue([entry('release', 'project')])
  await act(async () => {
    ;(store as unknown as { patch: (next: Partial<AppSnapshot>) => void }).patch({ workspaces: [...store.getSnapshot().workspaces, { path: '/work/recovered', name: 'Recovered', lastOpenedAt: 3 }] })
  })
  expect(dialog.querySelector('textarea[aria-label="What should they do?"]')).toBe(task)
  expect(task.value).toBe('Keep this Flow draft')
  expect(startButton.disabled).toBe(false)
  expect(store.getSnapshot().frontDoor?.context).toEqual({ kind: 'project', root: '/work/demo' })
  await act(async () => startButton.click())
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ root: '/work/demo' }))
})
