import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PaneProvider, StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { WorkViewControlsOutlet, TopBarOutlet, TopBarProvider } from '../panels/top-bar'
import { runFixture } from '../preview/run-view-fixture'
import { triggerPreferences } from '../preview/intake-fixture'
import { TeamRuns, type useTeamTrigger } from './TeamRuns'
import { sanitizeText } from '../lib/sanitize'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let store: ReturnType<typeof previewStore>
beforeEach(() => {
  store = previewStore()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const execution = runFixture('running').execution
// A trigger's Team: its Runs came from the trigger, which is what earns the cap, pausing and the trigger's own verbs.
const intake = { key: 'firing-1', trigger: 'review-pr', closureDigest: 'demo', dispatchHeld: false, again: null }
const runs = [
  { ...execution, id: 'first-run', state: 'running' as const, intake },
  { ...execution, id: 'second-run', state: 'settled' as const, intake: { ...intake, key: 'firing-2' } },
]
const trigger = (over: Partial<ReturnType<typeof useTeamTrigger>> = {}): ReturnType<typeof useTeamTrigger> => ({
  view: null, ready: false, prefs: triggerPreferences(), busy: false, problem: null,
  pause: vi.fn().mockResolvedValue(undefined), ...over,
})
const visibility = vi.fn()
const edit = vi.fn()
const render = (active = true, source = trigger()): void => act(() => root.render(<StoreProvider store={store}><TopBarProvider>
  <PaneProvider scope={{ paneId: 'main', view: { kind: 'room', room: execution.goal }, sessionKey: null }}>
    <WorkViewControlsOutlet owner="main" /><TopBarOutlet owner="main" fallback={{ place: 'Review work', more: () => null }} />
    <TeamRuns runs={runs} findings={new Map()} ledger={undefined} origin={null} trigger={source} problem={null}
      onOpen={() => {}} onEdit={edit} onRunVisibility={visibility} active={active} />
  </PaneProvider>
</TopBarProvider></StoreProvider>))
const open = async (slot: 'view' | 'more'): Promise<void> => {
  await act(async () => container.querySelector<HTMLButtonElement>(slot === 'view' ? '[data-slot="page-options"] button[title="View"]' : '[data-topbar="more"] button')!.click())
}
const switchNamed = (label: string): HTMLButtonElement => {
  const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(one => one.textContent?.startsWith(label))!
  expect(choice).toBeDefined()
  return choice
}

it('keeps state counts in View while search and a state filter survive hiding and return', async () => {
  const source = trigger()
  render(true, source)
  await open('view')
  expect([...document.querySelectorAll('[role="switch"]')].map(one => one.textContent)).toEqual(['All2', 'Running1', 'Needs you0', 'Settled1', 'Stopped0'])
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Filter Runs"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Run 2')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.querySelectorAll('[data-run]')).toHaveLength(1)
  expect(container.querySelector('[data-slot="page-options"] [data-filtered="true"]')).not.toBeNull()
  await act(async () => switchNamed('Settled').click())
  render(false, source)
  expect(container.querySelector('[data-slot="page-options"] button[title="View"]')).toBeNull()
  render(true, source)
  await open('view')
  expect(document.querySelector<HTMLInputElement>('input[placeholder="Filter Runs"]')!.value).toBe('Run 2')
  expect(switchNamed('Settled').getAttribute('aria-checked')).toBe('true')
  expect([...document.querySelectorAll('[role="switch"]')].map(one => one.textContent)).toEqual(['All2', 'Running1', 'Needs you0', 'Settled1', 'Stopped0'])
  expect(container.querySelector('[data-run="second-run"]')).not.toBeNull()
})

it.each([
  [{ prefs: null }, 'Trigger preferences are unavailable'],
  [{ busy: true }, 'A trigger change is in progress'],
] as const)('keeps Pause with its unavailable reason in More', async (over, reason) => {
  const source = trigger(over)
  render(true, source)
  await open('more')
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
  const pause = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent?.startsWith('Pause every trigger'))!
  expect(pause.title).toBe(reason)
  expect(pause.getAttribute('aria-disabled')).toBe('true')
  await act(async () => pause.click())
  expect(source.pause).not.toHaveBeenCalled()
  expect(container.querySelector('[data-slot="team-runs"]')?.textContent).toContain('interrupting its turns and checks')
})

it('resumes and edits through existing callbacks in More, with no Runs verb', async () => {
  const source = trigger({ prefs: triggerPreferences({ paused: true }) })
  render(true, source)
  expect(container.querySelector('[data-slot="page-options"] > button')).toBeNull()
  await open('more')
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent === 'Resume every trigger')!.click())
  expect(source.pause).toHaveBeenCalledTimes(1)
  await open('more')
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent === 'Edit the trigger')!.click())
  expect(edit).toHaveBeenCalledTimes(1)
})

it('releases visible reads when hidden and never registers hidden Runs actions', async () => {
  visibility.mockClear()
  const observers: { rows: Element[]; notify: (row: Element) => void; disconnect: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('IntersectionObserver', class {
    rows: Element[] = []
    disconnect = vi.fn()
    constructor(callback: IntersectionObserverCallback) {
      observers.push({ rows: this.rows, disconnect: this.disconnect, notify: row => callback([{ target: row, isIntersecting: true }] as IntersectionObserverEntry[], this as unknown as IntersectionObserver) })
    }
    observe(row: Element) { this.rows.push(row) }
  })
  const source = trigger()
  render(false, source)
  expect(observers).toHaveLength(0)
  expect(container.querySelector('[data-topbar="more"] button')).toBeNull()
  render(true, source)
  await open('more')
  expect([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(one => one.textContent?.trim()))
    .toEqual(['Pause every trigger', 'Edit the trigger'])
  const observer = observers[0]!
  expect(observer.rows).toHaveLength(2)
  act(() => observer.notify(observer.rows.find(row => (row as HTMLElement).dataset.run === 'first-run')!))
  expect(visibility).toHaveBeenCalledWith('first-run', true)
  render(false, source)
  expect(observer.disconnect).toHaveBeenCalledTimes(1)
  expect(visibility).toHaveBeenCalledWith('first-run', false)
  expect(container.querySelector('[data-slot="page-options"] button[title="View"]')).toBeNull()
  expect(container.querySelector('[data-topbar="more"] button')).toBeNull()
})

it('marks a run an MCP client started with a chip on its title line, and only that run', async () => {
  const mcp = { ...execution, id: 'mcp-run', state: 'running' as const, startedBy: { via: 'mcp' as const, client: 'example-client@1.0.0\u001b[31m' } }
  const cli = { ...execution, id: 'cli-run', state: 'running' as const, startedBy: { via: 'cli' as const, client: 'harnessdesk@0.1.0' } }
  act(() => root.render(<StoreProvider store={store}><TopBarProvider>
    <PaneProvider scope={{ paneId: 'main', view: { kind: 'room', room: execution.goal }, sessionKey: null }}>
      <TeamRuns runs={[mcp, cli, runs[1]!]} findings={new Map()} ledger={undefined} origin={null} trigger={trigger()} problem={null}
        onOpen={() => {}} onEdit={edit} onRunVisibility={visibility} active />
    </PaneProvider>
  </TopBarProvider></StoreProvider>))
  await act(async () => {})
  const chips = [...container.querySelectorAll('tr[data-run]')].map(row => [row.getAttribute('data-run'), [...row.querySelectorAll('[data-slot="chip"]')].filter(chip => chip.textContent === 'MCP').map(chip => chip.closest('[title^="Started by"]')?.getAttribute('title') ?? chip.getAttribute('title'))])
  expect(Object.fromEntries(chips)).toEqual({ 'mcp-run': [`Started by ${sanitizeText(mcp.startedBy.client)} through an MCP client`], 'cli-run': [], 'second-run': [] })
  expect(JSON.stringify(chips)).not.toContain('\\u001b')
})

it('says nothing about triggers on the Runs of a Team an MCP client or a person started', async () => {
  const started = [
    { ...execution, id: 'mcp-run', state: 'running' as const, startedBy: { via: 'mcp' as const, client: 'example-client@1.0.0' } },
    { ...execution, id: 'hand-run', state: 'settled' as const },
  ]
  const show = (shown: typeof started | typeof runs) => act(() => root.render(<StoreProvider store={store}><TopBarProvider>
    <PaneProvider scope={{ paneId: 'main', view: { kind: 'room', room: execution.goal }, sessionKey: null }}>
      <WorkViewControlsOutlet owner="main" /><TopBarOutlet owner="main" fallback={{ place: 'Review work', more: () => null }} />
      <TeamRuns runs={shown} findings={new Map()} ledger={undefined} origin={null} trigger={trigger({ prefs: null })} problem={null}
        onOpen={() => {}} onEdit={edit} onRunVisibility={visibility} active />
    </PaneProvider>
  </TopBarProvider></StoreProvider>))
  show(started)
  await act(async () => {})
  const summary = container.querySelector('[aria-label="Runs summary"]')!.textContent!
  expect(summary).toContain('2 Runs')
  expect(summary).not.toMatch(/daily cap|Daily cap/)
  expect(container.textContent).not.toContain('Pausing stops watching')
  const more = container.querySelector<HTMLButtonElement>('[data-topbar="more"] button')
  if (more) {
    await act(async () => more.click())
    expect([...document.querySelectorAll('[role="menuitem"]')].map(one => one.textContent)).not.toContain('Edit the trigger')
  }
  // The same page for a trigger's Runs keeps all of it.
  show(runs)
  await act(async () => {})
  expect(container.querySelector('[aria-label="Runs summary"]')!.textContent).toContain('Daily cap unavailable')
  expect(container.textContent).toContain('Pausing stops watching')
})
