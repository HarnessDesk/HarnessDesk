import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowEntry, FlowExecution, FlowPreview, FrontDoorPreview, HostMethodName } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { FrontDoor } from './FrontDoor'
import { CONTEST_START_POLICY } from '../lib/contest-start-fixture'

/**
 * The front door: choose a file-based shape, read its populated dry run,
 * Start — two clicks, once the chooser is already open. The real `AppStore`
 * is used throughout (only `transport.request` is mocked, per method name),
 * because the race this file protects (test 3) is a property of the store's
 * own generation guard, not of anything this component tracks itself.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const ENTRY = (id: string, name: string, over: Partial<FlowEntry> = {}): FlowEntry => ({
  id, origin: 'project', path: `.harnessdesk/flows/${id}.yml`, name, description: null, format: 'agents', problem: null, shadows: [], ...over,
})

const emptyFlow = (token: string | null): FlowPreview => ({
  token,
  compiled: {
    document: { format: 'agents', flow: { version: 2, name: 'Review', inputs: [], roles: [], rules: [], seed: { role: 'reviewer', title: 'Go' }, messaging: 'board-only', wait: 240 } },
    bindings: [], problems: [],
  },
  seats: [], commands: [], guards: [], messaging: 'board-only', problems: [],
})

const previewOf = (flow: FlowPreview, over: Partial<FrontDoorPreview> = {}): FrontDoorPreview => ({
  flow,
  target: { label: 'this project', base: null, head: null, dirty: false, independence: 'unknown' },
  vars: {},
  source: 'version: 2\nname: Review\n',
  sentence: 'Review — this project',
  goal: null,
  ...over,
})

const EXECUTION: FlowExecution = {
  version: 2, id: 'run-1', goal: 'goal-1', document: emptyFlow('t').compiled.document, state: 'running',
  rounds: [], operations: [], legacyRun: null, reason: null,
}

const render = (store: AppStore, context: import('@harnessdesk/protocol').StartContext = { kind: 'project', root: '/repo' }, initial?: import('./FrontDoor').FrontDoorProps['initial'], initialTask?: string) => {
  const onClose = vi.fn()
  const onStarted = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <FrontDoor context={context} initial={initial} initialTask={initialTask} onClose={onClose} onStarted={onStarted} />
      </StoreProvider>,
    )
  })
  return { onClose, onStarted }
}

// `Dialog` portals its content to `document.body`, not into `container` —
// the same reason `NewSessionChoice.test.tsx` (itself all `Dialog`) queries
// `document` rather than the render target.
const rowFor = (name: string): HTMLButtonElement => {
  const find = () => [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="flow-card"]')].find(one => one.textContent?.startsWith(name))
  if (!find()) {
    const change = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'Change')
    if (change && !change.disabled) act(() => flushSync(() => change.click()))
  }
  if (!find()) {
    const all = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === 'All Flows')
    if (all) act(() => flushSync(() => all.click()))
  }
  const found = find()
  if (!found) throw new Error(`no row for “${name}”`)
  return found
}
const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button “${label}”`)
  return found
}
const settle = () => act(async () => {})

const requestSpy = (store: AppStore, handlers: Partial<Record<HostMethodName, (params: unknown) => unknown>>) =>
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    const handler = handlers[method]
    if (handler) return handler(params)
    return null
  }) as never)

it('shows three quick Flows, then replaces the catalogue with the selected policy and Change', async () => {
  const store = new AppStore('ws://localhost:0/')
  const entries = ['a', 'b', 'c', 'd', 'e'].map(id => ENTRY(id, `Flow ${id}`))
  requestSpy(store, { 'flow/catalog': () => entries, 'agent/list': () => [], 'flow/source': () => 'source', 'authoring/start/preview': () => previewOf(emptyFlow('token')) })
  render(store)
  await settle()
  expect(document.querySelectorAll('[data-slot="flow-card"]')).toHaveLength(4)
  await act(async () => button('All Flows').click())
  expect(document.querySelectorAll('[data-slot="flow-card"]')).toHaveLength(6)
  await act(async () => rowFor('Flow e').click())
  expect(document.querySelector('[data-slot="selected-flow"]')?.textContent).toContain('Flow e')
  expect(document.querySelector('[aria-label="Search Flows"]')).toBeNull()
  expect(document.querySelectorAll('[data-slot="flow-card"]')).toHaveLength(0)
  expect(document.activeElement).toBe(button('Change'))
  await act(async () => button('Change').click())
  expect(document.querySelector('[aria-label="Search Flows"]')).toBe(document.activeElement)
  expect(document.querySelectorAll('[data-slot="flow-card"]')).toHaveLength(6)
})

it('keeps optional completion and dry-run controls folded without adding another page', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, { 'flow/catalog': () => [], 'agent/list': () => [] })
  vi.spyOn(store, 'loadAgents').mockResolvedValue(undefined)
  render(store)
  await settle()
  await act(async () => rowFor('Just a Team').click())
  const disclosure = button('Completion and dry run')
  const details = document.getElementById(disclosure.getAttribute('aria-controls')!)!
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  expect(details.hidden).toBe(true)
  expect(details.querySelector('[aria-label="Done when · optional"]')).not.toBeNull()
  expect(button('Dry run').closest('[data-slot="dialog-footer"]')).toBeNull()
  await act(async () => disclosure.click())
  expect(details.hidden).toBe(false)
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
})

it('keeps the task, Flow picker and plain Team controls in one New Team dialog', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, { 'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [] })
  vi.spyOn(store, 'loadAgents').mockResolvedValue(undefined)
  render(store)
  await settle()
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.getAttribute('aria-label')).toBe('New Team')
  expect(dialog.querySelector('textarea[aria-label="What should they do?"]')).not.toBeNull()
  act(() => rowFor('Just a Team').click())
  await settle()
  expect(document.querySelector('[role="dialog"]')).toBe(dialog)
  expect(dialog.getAttribute('aria-label')).toBe('New Team')
  expect(rowFor('Review')).toBeDefined()
  expect(button('Dry run')).toBeDefined()
  expect(button('Start Team').disabled).toBe(true)
})

it('previews an unsaved Flow source without re-reading its catalogue file', async () => {
  const store = new AppStore('ws://localhost:0/')
  const source = 'unsaved flow source'
  const preview = previewOf(emptyFlow('unsaved-token'), { source })
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [],
    'authoring/start/preview': () => preview, 'flow/start-goal': () => EXECUTION,
  })
  act(() => root.render(<StoreProvider store={store}><FrontDoor context={{ kind: 'project', root: '/repo' }} initial={{ id: 'review', origin: 'project' }} initialSource={source} onClose={() => {}} onStarted={() => {}} /></StoreProvider>))
  await settle()
  expect(spy.mock.calls.some(([method]) => method === 'flow/source')).toBe(false)
  expect(spy.mock.calls.find(([method]) => method === 'authoring/start/preview')?.[1]).toMatchObject({ source })
  expect(document.querySelector('[data-slot="selected-flow"]')).not.toBeNull()
  await act(async () => button('Start Team').click())
  expect(spy.mock.calls.find(([method]) => method === 'flow/start-goal')?.[1]).toMatchObject({ source, token: 'unsaved-token' })
})

it('brings a refused Flow start into view and focuses its existing alert', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  const store = new AppStore('ws://localhost:0/')
  const source = 'version: 2\nname: Review\n'
  requestSpy(store, {
    'flow/catalog': () => [], 'agent/list': () => [],
    'authoring/start/preview': () => previewOf(emptyFlow('token'), { source }),
    'flow/start-goal': () => { throw new Error('The reviewer is no longer available.') },
  })
  act(() => root.render(<StoreProvider store={store}><FrontDoor context={{ kind: 'project', root: '/repo' }} initialSource={source} onClose={() => {}} onStarted={() => {}} /></StoreProvider>))
  await settle()
  await act(async () => button('Start Team').click())
  const failure = document.querySelector('[role="alert"]')!
  expect(failure.textContent).toContain('The reviewer is no longer available.')
  expect(document.activeElement?.contains(failure)).toBe(true)
  expect(scroll.mock.contexts).toContain(document.activeElement)
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
  expect(button('Start Team').disabled).toBe(false)
  scroll.mockRestore()
})

it('reissues the initial source in StrictMode and ignores the retired preview before starting', async () => {
  const store = new AppStore('ws://localhost:0/')
  const source = JSON.stringify(emptyFlow('fresh-token').compiled.document.flow)
  let finishRetired!: (value: FrontDoorPreview) => void
  let previews = 0
  const spy = requestSpy(store, {
    'flow/catalog': () => [], 'agent/list': () => [],
    'authoring/start/preview': () => ++previews === 1
      ? new Promise<FrontDoorPreview>(resolve => { finishRetired = resolve })
      : previewOf(emptyFlow('fresh-token'), { source }),
    'flow/start-goal': () => EXECUTION,
  })
  const onStarted = vi.fn()
  act(() => root.render(<StrictMode><StoreProvider store={store}><FrontDoor context={{ kind: 'project', root: '/repo' }} initialSource={source} onClose={() => {}} onStarted={onStarted} /></StoreProvider></StrictMode>))
  await settle()
  expect(previews).toBe(2)
  expect(document.querySelector('[data-slot="selected-flow"]')?.textContent).toContain('Review')
  expect(button('Start Team').disabled).toBe(false)
  await act(async () => finishRetired(previewOf(emptyFlow('retired-token'), { source: 'retired source' })))
  expect(store.getSnapshot().frontDoor?.preview?.flow.token).toBe('fresh-token')
  await act(async () => button('Start Team').click())
  expect(spy.mock.calls.find(([method]) => method === 'flow/start-goal')?.[1]).toMatchObject({ source, token: 'fresh-token' })
  expect(onStarted).toHaveBeenCalledExactlyOnceWith(EXECUTION)
})

it('starts a legal just-a-team Flow from its source even when the plain prefill is also present', async () => {
  const source = JSON.stringify({ ...emptyFlow('token').compiled.document.flow, name: 'Custom pipeline' })
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('just-a-team', 'Custom pipeline')], 'agent/list': () => [],
    'authoring/start/preview': params => {
      const input = params as { source: string; vars: Record<string, string> }
      const base = emptyFlow('custom-token')
      return previewOf({ ...base, compiled: { ...base.compiled, document: { format: 'agents', flow: JSON.parse(input.source) } } }, { source: input.source, vars: input.vars })
    }, 'flow/start-goal': () => EXECUTION,
  })
  vi.spyOn(store, 'loadAgents').mockResolvedValue(undefined)
  act(() => root.render(<StoreProvider store={store}><FrontDoor context={{ kind: 'project', root: '/repo' }} initialPlain initial={{ id: 'just-a-team', origin: 'project' }} initialSource={source} onClose={() => {}} onStarted={() => {}} /></StoreProvider>))
  await settle()
  expect(store.getSnapshot().frontDoor?.preview?.source).toBe(source)
  await act(async () => button('Start Team').click())
  expect(spy.mock.calls.find(([method]) => method === 'flow/start-goal')?.[1]).toMatchObject({ source, token: 'custom-token' })
  expect(spy.mock.calls.some(([method]) => method === 'goal/create')).toBe(false)
})

it('keeps an unsaved draft separate from a legal __draft Flow file', async () => {
  const unsaved = JSON.stringify({ ...emptyFlow('token').compiled.document.flow, name: 'Unsaved work' })
  const saved = JSON.stringify({ ...emptyFlow('token').compiled.document.flow, name: 'Saved draft' })
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('__draft', 'Saved draft')], 'agent/list': () => [], 'flow/source': () => saved,
    'authoring/start/preview': params => {
      const input = params as { source: string; vars: Record<string, string> }
      const base = emptyFlow('token')
      return previewOf({ ...base, compiled: { ...base.compiled, document: { format: 'agents', flow: JSON.parse(input.source) } } }, { source: input.source, vars: input.vars })
    },
  })
  act(() => root.render(<StoreProvider store={store}><FrontDoor context={{ kind: 'project', root: '/repo' }} initialSource={unsaved} onClose={() => {}} onStarted={() => {}} /></StoreProvider>))
  await settle()
  await act(async () => rowFor('Saved draft').click())
  expect(spy.mock.calls.find(([method]) => method === 'flow/source')?.[1]).toMatchObject({ id: '__draft', origin: 'project' })
  expect(store.getSnapshot().frontDoor?.preview?.source).toBe(saved)
})

it('keeps the unsaved policy intact instead of applying first-use comparison defaults', async () => {
  const { TEAM_START_POLICIES } = await import('../preview/team-start-fixture')
  const policy = TEAM_START_POLICIES.comparison
  const source = JSON.stringify(policy)
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('comparison', 'Side by side')], 'agent/list': () => [],
    'authoring/start/preview': params => {
      const input = params as { source: string; vars: Record<string, string> }
      const base = emptyFlow('current-token')
      return previewOf({ ...base, compiled: { ...base.compiled, document: { format: 'agents', flow: JSON.parse(input.source) } } }, { source: input.source, vars: input.vars })
    },
    'authoring/shape/render': params => ({ source: JSON.stringify((params as { policy: unknown }).policy), issues: [] }),
  })
  act(() => root.render(<StoreProvider store={store}><FrontDoor context={{ kind: 'project', root: '/repo' }} initial={{ id: 'comparison' }} initialSource={source} onClose={() => {}} onStarted={() => {}} /></StoreProvider>))
  await settle()
  expect(spy.mock.calls.some(([method]) => method === 'authoring/shape/render')).toBe(false)
  expect(store.getSnapshot().frontDoor?.preview?.source).toBe(source)
})

it('keeps a literal seed intact when its unsaved Flow is selected again', async () => {
  const source = JSON.stringify(emptyFlow('token').compiled.document.flow)
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [],
    'authoring/shape/render': params => ({ source: JSON.stringify((params as { policy: unknown }).policy), issues: [] }),
    'authoring/start/preview': params => {
      const input = params as { source: string; vars: Record<string, string> }
      const base = emptyFlow('token')
      return previewOf({ ...base, compiled: { ...base.compiled, document: { format: 'agents', flow: JSON.parse(input.source) } } }, { source: input.source, vars: input.vars })
    },
  })
  act(() => root.render(<StoreProvider store={store}><FrontDoor context={{ kind: 'project', root: '/repo' }} initial={{ id: 'review' }} initialSource={source} onClose={() => {}} onStarted={() => {}} /></StoreProvider>))
  await settle()
  await act(async () => rowFor('Review').click())
  expect(spy.mock.calls.some(([method]) => method === 'authoring/shape/render')).toBe(false)
  expect(store.getSnapshot().frontDoor?.preview?.source).toBe(source)
})

it('binds a task entered before choosing a Flow to its literal seed', async () => {
  const policy = emptyFlow('token').compiled.document.flow
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [], 'flow/source': () => JSON.stringify(policy),
    'authoring/shape/render': params => ({ source: JSON.stringify((params as { policy: unknown }).policy), issues: [] }),
    'authoring/start/preview': params => {
      const input = params as { source: string; vars: Record<string, string> }
      const base = emptyFlow('token')
      return previewOf({ ...base, compiled: { ...base.compiled, document: { format: 'agents', flow: JSON.parse(input.source) } } }, { source: input.source, vars: input.vars })
    }, 'flow/start-goal': () => EXECUTION,
  })
  render(store)
  await settle()
  const task = document.querySelector<HTMLTextAreaElement>('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, 'Fix the cart')
    task.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => rowFor('Review').click())
  await act(async () => button('Start Team').click())
  const started = spy.mock.calls.find(([method]) => method === 'flow/start-goal')?.[1] as { source: string }
  expect(JSON.parse(started.source).seed.title).toBe('Fix the cart')
})

it('retires a pending brief file read when another Flow is selected', async () => {
  const base = emptyFlow('token')
  const policy = base.compiled.document.flow
  const withBrief = { ...policy, name: 'With brief', inputs: [{ id: 'task', label: 'Task', default: 'Fix the cart' }, { id: 'brief', label: 'Brief' }] }
  const withoutBrief = { ...policy, name: 'Without brief', inputs: [{ id: 'task', label: 'Task', default: 'Fix the cart' }] }
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('with', 'With brief'), ENTRY('without', 'Without brief')], 'agent/list': () => [],
    'flow/source': params => JSON.stringify((params as { id: string }).id === 'with' ? withBrief : withoutBrief),
    'authoring/start/preview': params => {
      const input = params as { source: string; vars: Record<string, string> }
      const flow = JSON.parse(input.source)
      return previewOf({ ...base, token: flow.name, compiled: { ...base.compiled, document: { format: 'agents', flow } } }, { source: input.source, vars: input.vars })
    }, 'flow/start-goal': () => EXECUTION,
  })
  render(store)
  await settle()
  await act(async () => rowFor('With brief').click())
  act(() => button('Details').click())
  let finishFile!: (value: string) => void
  const file = new File(['Late brief'], 'brief.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: () => new Promise<string>(resolve => { finishFile = resolve }) })
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!
  await act(async () => {
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] })
    picker.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(button('Start Team').disabled).toBe(true)
  await act(async () => rowFor('Without brief').click())
  expect(button('Start Team').disabled).toBe(false)
  await act(async () => finishFile('Late brief'))
  await act(async () => button('Start Team').click())
  expect(spy.mock.calls.find(([method]) => method === 'flow/start-goal')?.[1]).toMatchObject({ token: 'Without brief', vars: { task: 'Fix the cart' } })
})

it.each(['render', 'preview'])('keeps a literal task editable during a pending %s and starts only its latest text', async phase => {
  const base = emptyFlow('token')
  const policy = base.compiled.document.flow
  const store = new AppStore('ws://localhost:0/')
  const releases: (() => void)[] = []
  const hold = () => new Promise<void>(resolve => { releases.push(resolve) })
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [], 'flow/source': () => JSON.stringify(policy),
    'authoring/shape/render': async params => {
      if (phase === 'render') await hold()
      return { source: JSON.stringify((params as { policy: unknown }).policy), issues: [] }
    },
    'authoring/start/preview': async params => {
      const input = params as { source: string; vars: Record<string, string> }
      const flow = JSON.parse(input.source)
      if (phase === 'preview' && flow.seed.title !== 'Go') await hold()
      return previewOf({ ...base, token: flow.seed.title, compiled: { ...base.compiled, document: { format: 'agents', flow } } }, { source: input.source, vars: input.vars })
    }, 'flow/start-goal': () => EXECUTION,
  })
  render(store)
  await settle()
  await act(async () => rowFor('Review').click())
  const task = document.querySelector<HTMLTextAreaElement>('textarea')!
  act(() => task.focus())
  const type = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, value)
    task.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await type('A')
  expect(task.disabled).toBe(false)
  expect(document.activeElement).toBe(task)
  expect(button('Start Team').disabled).toBe(true)
  await type('AB')
  expect(task.value).toBe('AB')
  expect(releases).toHaveLength(2)
  expect(button('Start Team').disabled).toBe(true)
  await act(async () => releases[1]!())
  expect(button('Start Team').disabled).toBe(false)
  await act(async () => releases[0]!())
  expect(task.value).toBe('AB')
  await act(async () => button('Start Team').click())
  const started = spy.mock.calls.find(([method]) => method === 'flow/start-goal')?.[1] as { source: string; token: string }
  expect(JSON.parse(started.source).seed.title).toBe('AB')
  expect(started.token).toBe('AB')
})

it('keeps other input defaults when typing while the initial literal task is rendered', async () => {
  const base = emptyFlow('token')
  const policy = { ...base.compiled.document.flow, inputs: [{ id: 'brief', label: 'Brief', default: 'Existing context' }] }
  const store = new AppStore('ws://localhost:0/')
  const releases: (() => void)[] = []
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [], 'flow/source': () => JSON.stringify(policy),
    'authoring/shape/render': async params => {
      await new Promise<void>(resolve => { releases.push(resolve) })
      return { source: JSON.stringify((params as { policy: unknown }).policy), issues: [] }
    },
    'authoring/start/preview': params => {
      const input = params as { source: string; vars: Record<string, string> }
      return previewOf({ ...base, compiled: { ...base.compiled, document: { format: 'agents', flow: JSON.parse(input.source) } } }, { source: input.source, vars: input.vars })
    }, 'flow/start-goal': () => EXECUTION,
  })
  render(store, { kind: 'project', root: '/repo' }, { id: 'review' }, 'A')
  await settle()
  const task = document.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, 'AB')
    task.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(releases).toHaveLength(2)
  await act(async () => releases[1]!())
  await act(async () => releases[0]!())
  await act(async () => button('Start Team').click())
  expect(spy.mock.calls.find(([method]) => method === 'flow/start-goal')?.[1]).toMatchObject({ vars: { brief: 'Existing context' } })
})

it('focuses search, filters by summary, and picks with the keyboard', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review', { summary: 'Security specialists.' }), ENTRY('other', 'Other')],
    'agent/list': () => [], 'flow/source': () => 'source',
    'authoring/start/preview': () => previewOf(emptyFlow('token')),
  })
  render(store)
  await settle()
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search Flows"]')!
  expect(search).not.toBeNull()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'security')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.body.textContent).toContain('Review')
  expect(document.body.textContent).not.toContain('Other')
  act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await settle()
  expect(document.body.textContent).toContain('Done when · optional')
})

it('Enter opens the focused Flow card', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review'), ENTRY('other', 'Other')],
    'agent/list': () => [],
    'flow/source': () => 'source',
    'authoring/start/preview': () => previewOf(emptyFlow('token')),
  })
  render(store)
  await settle()

  const first = rowFor('Other')
  act(() => first.focus())
  act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement).toBe(rowFor('Review'))

  act(() => rowFor('Review').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await settle()
  expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('New Team')
  expect(document.querySelector('[data-slot="selected-flow"]')?.textContent).toContain('Review')
})

it('gives the shape search its search glyph and a plain Search placeholder', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [], 'flow/source': () => 'source',
  })
  render(store)
  await settle()

  const search = document.querySelector<HTMLElement>('[data-slot="search"]')
  expect(search?.querySelector('svg')).not.toBeNull()
  expect(search?.querySelector<HTMLInputElement>('input[type="search"]')?.placeholder).toBe('Search Flows…')
})

it('uses each Flow policy for its shared mini graph', async () => {
  const { TEAM_START_POLICIES } = await import('../preview/team-start-fixture')
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('fan-out', 'Fan-out review', { policy: TEAM_START_POLICIES['fan-out'] }), ENTRY('staged-relay', 'Staged relay', { policy: TEAM_START_POLICIES['staged-relay'] })],
    'agent/list': () => [],
  })
  render(store)
  await settle()
  expect(rowFor('Fan-out review').querySelector('[data-slot="flow-mini-graph"]')).not.toBeNull()
  expect(rowFor('Staged relay').querySelector('[data-slot="flow-mini-graph"]')).not.toBeNull()
  expect(rowFor('Fan-out review').querySelector('svg')?.outerHTML).not.toBe(rowFor('Staged relay').querySelector('svg')?.outerHTML)
})

it('Reselecting a Flow keeps the task and Done when is the sentence sent to start', async () => {
  const store = new AppStore('ws://localhost:0/')
  const base = emptyFlow('token')
  const flow: FlowPreview = { ...base, compiled: { ...base.compiled, document: { format: 'agents', flow: {
    ...(base.compiled.document.format === 'agents' ? base.compiled.document.flow : neverFlow()),
    inputs: [{ id: 'task', label: 'Task' }],
  } } } }
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [], 'flow/source': () => 'source',
    'authoring/start/preview': params => previewOf(flow, { vars: (params as { vars: Record<string, string> }).vars }),
    'flow/start-goal': () => EXECUTION,
  })
  render(store)
  await settle()
  act(() => rowFor('Review').click())
  await settle()
  const task = document.querySelector<HTMLTextAreaElement>('[aria-label="What should they do?"]')!
  expect(task).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, 'Fix the cart')
    task.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => rowFor('Review').click())
  await settle()
  expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Fix the cart')
  const done = document.querySelector<HTMLInputElement>('[aria-label="Done when · optional"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(done, 'The cart test passes')
    done.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => button('Start Team').click())
  await settle()
  expect(spy.mock.calls.find(call => call[0] === 'flow/start-goal')?.[1]).toMatchObject({ sentence: 'The cart test passes', vars: { task: 'Fix the cart' } })
})

const neverFlow = (): never => { throw new Error('expected current format') }

it.each([['comparison', 'Side by side', 'judge', 'to-judge'], ['mechanical-contest', 'Mechanical contest', 'referee', 'to-person']])('prefills %s’s project check, previews edits, and keeps an empty check after reselection', async (id, name, destination, route) => {
  const { TEAM_START_POLICIES } = await import('../preview/team-start-fixture')
  const original: import('@harnessdesk/protocol').FlowPolicy = id === 'mechanical-contest' ? CONTEST_START_POLICY : TEAM_START_POLICIES.comparison
  const policy = { ...original, inputs: [{ id: 'task', label: 'Task', default: 'Fix the cart' }], roles: original.roles.filter(role => role.kind !== 'check'), rules: [
    { id: route, on: 'competitor', then: { role: destination, title: 'Choose an attempt' } },
    ...original.rules.filter(rule => rule.on === 'judge'),
  ] }
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY(id, name)], 'agent/list': () => [], 'flow/source': () => JSON.stringify(policy),
    'authoring/shape/render': params => ({ source: JSON.stringify((params as { policy: unknown }).policy), issues: [] }),
    'authoring/start/preview': params => {
      const input = params as { source: string; vars: Record<string, string> }
      const base = emptyFlow('token')
      return { ...previewOf({ ...base, compiled: { ...base.compiled, document: { format: 'agents', flow: JSON.parse(input.source) } } }, { source: input.source, vars: input.vars }), projectCheckCommand: 'pnpm test' }
    },
    'flow/start-goal': () => EXECUTION,
  })
  render(store)
  await settle()
  act(() => rowFor(name).click())
  await settle()
  const check = (): HTMLInputElement => {
    const label = [...document.querySelectorAll('label')].find(one => one.textContent?.includes('Check each attempt with'))
    expect(label).toBeDefined()
    return document.getElementById(label!.htmlFor) as HTMLInputElement
  }
  expect(check().value).toBe('pnpm test')
  if (id === 'comparison') {
    expect(document.body.textContent).toContain('JudgeOptional')
    const judge = document.querySelector<HTMLButtonElement>('button[aria-label="Configure Judge"]')!
    expect(judge.textContent).toContain('You')
    expect(store.getSnapshot().frontDoor!.preview!.flow.compiled.document.flow.roles.some(role => role.id === 'judge')).toBe(false)
  }
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(check(), value)
      check().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await type('node check.mjs')
  const edited = store.getSnapshot().frontDoor!.preview!
  expect(edited.flow.compiled.document.flow.roles.find(role => role.id === 'verify')).toMatchObject({ check: { run: 'node check.mjs' } })
  await type('')
  act(() => rowFor(name).click())
  await settle()
  expect(check().value).toBe('')
  act(() => button('Start Team').click())
  await settle()
  const started = spy.mock.calls.find(call => call[0] === 'flow/start-goal')?.[1] as { source: string }
  expect(JSON.parse(started.source).roles.some((role: { kind: string }) => role.kind === 'check')).toBe(false)
  expect(JSON.parse(started.source).rules.find((rule: { then: { role: string } }) => rule.then.role === 'referee').on).toBe('competitor')
})

it.each(['render', 'preview'])('holds Flow choices and Details inputs until a policy %s settles, then keeps the edit', async phase => {
  const { TEAM_START_POLICIES } = await import('../preview/team-start-fixture')
  const policy = { ...TEAM_START_POLICIES['fix-and-review'], inputs: [{ id: 'task', label: 'Task', default: 'Fix the cart' }, { id: 'ticket', label: 'Ticket', default: '42' }] }
  const store = new AppStore('ws://localhost:0/')
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('fix-and-review', 'Write and review')], 'agent/list': () => [], 'flow/source': () => JSON.stringify(policy),
    'authoring/shape/render': async params => {
      if (phase === 'render') await delayed
      return { source: JSON.stringify((params as { policy: unknown }).policy), issues: [] }
    },
    'authoring/start/preview': async params => {
      const input = params as { source: string; vars: Record<string, string> }
      const flow = JSON.parse(input.source) as typeof policy
      if (phase === 'preview' && flow.budget?.rounds === 5) await delayed
      const base = emptyFlow('token')
      return previewOf({ ...base, compiled: { ...base.compiled, document: { format: 'agents', flow } } }, { source: input.source, vars: input.vars })
    },
    'flow/start-goal': () => EXECUTION,
  })
  render(store)
  await settle()
  act(() => rowFor('Write and review').click())
  await settle()
  act(() => button('2').click())
  await settle()
  expect(button('Start Team').disabled).toBe(true)
  expect(button('Change').disabled).toBe(true)
  const task = document.querySelector<HTMLTextAreaElement>('textarea')!
  expect(task.disabled).toBe(false)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, 'Fix the updated cart')
    task.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(button('Start Team').disabled).toBe(true)
  const ticket = [...document.querySelectorAll<HTMLInputElement>('input')].find(one => one.value === '42')!
  expect(ticket.disabled).toBe(true)
  expect(document.querySelector('[aria-label="Search Flows"]')).toBeNull()
  await act(async () => release())
  expect(button('Change').disabled).toBe(false)
  expect(ticket.disabled).toBe(false)
  act(() => rowFor('Write and review').click())
  await settle()
  expect(button('2').getAttribute('aria-pressed')).toBe('true')
  act(() => button('Start Team').click())
  await settle()
  const started = spy.mock.calls.find(call => call[0] === 'flow/start-goal')?.[1] as { source: string; vars: Record<string, string> }
  expect(JSON.parse(started.source).budget.rounds).toBe(5)
  expect(started.vars.task).toBe('Fix the updated cart')
})

it('retires Start during a policy edit and ignores an older refused render', async () => {
  const store = new AppStore('ws://localhost:0/')
  const base = emptyFlow('old-token')
  const policy = { ...(base.compiled.document.format === 'agents' ? base.compiled.document.flow : neverFlow()),
    inputs: [{ id: 'task', label: 'Task', default: 'Fix the cart' }],
    roles: [{ id: 'verify', kind: 'check' as const, check: { run: 'pnpm test', timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } }],
  }
  let refuse!: (value: { source: string; issues: { at: string; text: string; fix: null }[] }) => void
  const delayed = new Promise<{ source: string; issues: { at: string; text: string; fix: null }[] }>(resolve => { refuse = resolve })
  let renders = 0
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('check', 'Check')], 'agent/list': () => [], 'flow/source': () => JSON.stringify(policy),
    'authoring/start/preview': params => {
      const input = params as { source: string; vars: Record<string, string> }
      return previewOf({ ...base, token: 'new-token', compiled: { ...base.compiled, document: { format: 'agents', flow: JSON.parse(input.source) } } }, { vars: input.vars })
    },
    'authoring/shape/render': params => {
      if (++renders === 1) return delayed
      if (renders === 3) return { source: '', issues: [{ at: 'roles.verify', text: 'A command is required.', fix: null }] }
      return { source: JSON.stringify((params as { policy: unknown }).policy), issues: [] }
    },
  })
  render(store)
  await settle()
  act(() => rowFor('Check').click())
  await settle()
  expect(button('Start Team').disabled).toBe(false)
  const command = (): HTMLInputElement => { const label = [...document.querySelectorAll('label')].find(one => one.textContent === 'Check · verify')!; return document.getElementById(label.htmlFor) as HTMLInputElement }
  const edit = (value: string): void => {
    const field = command()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  act(() => edit('pnpm slow'))
  expect(button('Start Team').disabled).toBe(true)
  expect(store.getSnapshot().frontDoor?.preview).toBeNull()
  act(() => edit('pnpm good'))
  await settle()
  expect(button('Start Team').disabled).toBe(false)
  await act(async () => refuse({ source: '', issues: [{ at: 'roles.verify', text: 'Old refusal', fix: null }] }))
  expect(document.body.textContent).not.toContain('Old refusal')
  expect(button('Start Team').disabled).toBe(false)
  act(() => edit(''))
  await settle()
  expect(button('Start Team').disabled).toBe(true)
  expect(document.body.textContent).toContain('A command is required.')
})

it('Just a Team starts through selected-project admission instead of generic Goal creation', async () => {
  const store = new AppStore('ws://localhost:0/')
  const team = { goal: { id: 'team-1', revision: 0 }, board: { id: 'team-1', members: [], intents: [] } } as unknown as import('@harnessdesk/protocol').GoalView
  const spy = requestSpy(store, { 'flow/catalog': () => [], 'agent/list': () => [], 'goal/create': () => team, 'goal/start': () => team })
  vi.spyOn(store, 'loadAgents').mockResolvedValue(undefined)
  vi.spyOn(store, 'teamAdd').mockResolvedValue(undefined)
  vi.spyOn(store, 'openGoal').mockImplementation(() => {})
  const { onClose } = render(store, { kind: 'project', root: '/selected-project' }, undefined, 'Inspect the cart')
  await settle()
  await act(async () => rowFor('Just a Team').click())
  await act(async () => button('Start Team').click())
  expect(spy.mock.calls.find(([method]) => method === 'goal/start')?.[1]).toEqual({ root: '/selected-project', sentence: 'Inspect the cart', checkout: 'shared' })
  expect(spy.mock.calls.some(([method]) => method === 'goal/create')).toBe(false)
  expect(onClose).toHaveBeenCalledOnce()
})

it('Just a Team creates a flow-less Team with the typed completion sentence', async () => {
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, { 'flow/catalog': () => [], 'agent/list': () => [] })
  vi.spyOn(store, 'loadAgents').mockResolvedValue(undefined)
  const create = vi.spyOn(store, 'startTeam').mockResolvedValue({ goal: { id: 'team-1' } } as import('@harnessdesk/protocol').GoalView)
  const open = vi.spyOn(store, 'openGoal').mockImplementation(() => {})
  const add = vi.spyOn(store, 'teamAdd').mockResolvedValue(undefined)
  const { onClose } = render(store)
  await settle()
  act(() => rowFor('Just a Team').click())
  await settle()
  const task = document.querySelector<HTMLTextAreaElement>('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, 'Investigate the cart')
    task.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const done = document.querySelector<HTMLInputElement>('[aria-label="Done when · optional"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(done, 'The cause is documented')
    done.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => button('Start Team').click())
  await settle()
  expect(create).toHaveBeenCalledWith({ root: '/repo', sentence: 'The cause is documented', checkout: 'shared' })
  expect(add).toHaveBeenCalledWith('team-1', { title: 'Investigate the cart' })
  expect(open).toHaveBeenCalledWith('team-1')
  expect(onClose).toHaveBeenCalledOnce()
  expect(spy.mock.calls.some(call => call[0] === 'flow/start-goal')).toBe(false)
})

it('the seed preview follows input defaults, edits and clearing in the front door', async () => {
  const base = emptyFlow('token')
  const flow: FlowPreview = {
    ...base,
    compiled: {
      ...base.compiled,
      document: { format: 'agents', flow: {
        version: 2, name: 'Review', inputs: [{ id: 'task', label: 'Task', default: 'Initial task' }],
        roles: [], seed: { role: 'reviewer', title: '{{ task }}' },
        rules: [{ id: 'check', on: 'reviewer', then: { role: 'verify', title: 'Check the task' } }],
        messaging: 'board-only', wait: 240,
      } },
    },
  }
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')],
    'agent/list': () => [],
    'flow/source': () => 'saved flow',
    'authoring/start/preview': params => previewOf(flow, { vars: (params as { vars: Record<string, string> }).vars }),
  })
  render(store)
  await settle()
  act(() => rowFor('Review').click())
  await settle()
  const rounds = () => document.body.querySelector('[aria-label="Rounds and rules"]')!.textContent
  expect(rounds()).toContain('Seed round — Initial task')
  for (const [value, expected] of [['Edited task', 'Edited task'], ['Keep {{task}} literal', 'Keep {{task}} literal'], ['', 'Task']]) {
    const label = [...document.body.querySelectorAll('label')].find(one => one.textContent === 'What should they do?')!
    const field = document.getElementById(label.htmlFor) as HTMLTextAreaElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    expect(rounds()).toContain(`Seed round — ${expected}`)
  }
})

it('review is choice then Start: two clicks, one start call', async () => {
  const preview = previewOf(emptyFlow('strict-token'))
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')],
    'agent/list': () => [],
    'flow/source': () => 'version: 2\nname: Review\n',
    'authoring/start/preview': () => preview,
    'flow/start-goal': () => EXECUTION,
  })

  const { onStarted } = render(store)
  await settle()

  // Click one: choose the shape.
  act(() => rowFor('Review').click())
  await settle()
  expect(document.body.textContent).toContain('It opens no Agents')
  expect(button('Start Team').hasAttribute('disabled')).toBe(false)

  // Click two: Start.
  act(() => button('Start Team').click())
  await settle()

  const starts = spy.mock.calls.filter((call) => call[0] === 'flow/start-goal')
  expect(starts).toHaveLength(1)
  expect(starts[0]![1]).toMatchObject({ root: '/repo', token: 'strict-token', source: 'version: 2\nname: Review\n' })
  expect(onStarted).toHaveBeenCalledWith(EXECUTION)
})

it('the rendered list follows the catalogue, never a hardcoded set of shapes', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('ship-it', 'Ship the thing'), ENTRY('bug-hunt', 'Bug hunt', { origin: 'user', description: 'Finds what broke' })],
    'agent/list': () => [],
  })

  render(store)
  await settle()

  expect(document.body.textContent).toContain('Ship the thing')
  expect(document.body.textContent).toContain('Bug hunt')
  expect(document.body.textContent).toContain('Finds what broke')
})

it('a context shortcut shows only what its own metadata accepts, never a silently chosen unrelated file', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [
      ENTRY('review', 'Review a branch', { frontDoor: { order: null, contexts: ['branch'] } }),
      ENTRY('release', 'Cut a release', { frontDoor: { order: null, contexts: ['pull-request'] } }),
      ENTRY('anything', 'Anything, anywhere'),
    ],
    'agent/list': () => [],
  })

  render(store, { kind: 'branch', root: '/repo', branch: 'feature' })
  await settle()

  // Declares `branch` — shown. Declares only `pull-request` — hidden, not an
  // error thrown at Start; a shape with no `contexts` at all still shows,
  // since absence is never read as a refusal.
  expect(document.body.textContent).toContain('Review a branch')
  expect(document.body.textContent).toContain('Anything, anywhere')
  expect(document.body.textContent).not.toContain('Cut a release')
})

it('validated order sorts shapes first; an unordered shape falls back to name', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [
      ENTRY('zzz-unordered', 'Zzz unordered'),
      ENTRY('second', 'Second', { frontDoor: { order: 2, contexts: null } }),
      ENTRY('aaa-unordered', 'Aaa unordered'),
      ENTRY('first', 'First', { frontDoor: { order: 1, contexts: null } }),
    ],
    'agent/list': () => [],
  })

  render(store)
  await settle()

  act(() => button('All Flows').click())
  const names = [...document.body.querySelectorAll('button')]
    .map((one) => one.getAttribute('aria-label'))
    .filter((text): text is string => text === 'First' || text === 'Second' || text === 'Aaa unordered' || text === 'Zzz unordered')
  expect(names).toEqual(['First', 'Second', 'Aaa unordered', 'Zzz unordered'])
})

it('an asked candidate stays visible with its reason and fix; Start is disabled until it holds', async () => {
  const flow: FlowPreview = {
    ...emptyFlow(null),
    seats: [{
      role: 'reviewer',
      index: 0,
      agent: 'reviewer',
      isolate: false,
      reviews: true,
      plan: {
        id: 'reviewer', from: 'prefer', winner: null, blocked: null, ceiling: null,
        candidates: [{
          seat: { runtime: 'codex' },
          label: 'Codex',
          runtimeName: 'Codex',
          state: 'passed',
          reason: { kind: 'signedOut' },
          fix: { kind: 'signIn', runtime: 'codex' },
        }],
      },
    }],
  }
  const preview = previewOf(flow)
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')],
    'agent/list': () => [],
    'flow/source': () => 'version: 2\nname: Review\n',
    'authoring/start/preview': () => preview,
  })

  render(store)
  await settle()
  act(() => rowFor('Review').click())
  await settle()

  // The dry run's own seat rows are read-only (`FlowPreviewReport`, shared
  // with the plain flow chooser) — the reason and its fix are visible words,
  // not a clickable action here; fixing it is Settings' job, reached from
  // elsewhere. What this dialog owns is refusing to light Start.
  expect(document.body.textContent).toContain('Codex')
  expect(document.body.textContent).toContain('is signed out')
  expect(document.body.textContent).toContain('Sign in to Codex')
  expect(button('Start Team').hasAttribute('disabled')).toBe(true)
})

it('choosing a different shape clears the old dry run and its token immediately, before the new shape’s own file or preview arrives', async () => {
  const previewA = previewOf(emptyFlow('token-a'))
  const store = new AppStore('ws://localhost:0/')
  let resolveSourceB!: (value: string) => void
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review-a', 'Review A'), ENTRY('review-b', 'Review B')],
    'agent/list': () => [],
    'flow/source': (params) => {
      const { id } = params as { id: string }
      if (id === 'review-a') return 'version: 2\nname: A\n'
      return new Promise<string>((resolve) => { resolveSourceB = resolve })
    },
    'authoring/start/preview': () => previewA,
  })

  render(store)
  await settle()
  act(() => rowFor('Review A').click())
  await settle()
  expect(button('Start Team').hasAttribute('disabled')).toBe(false)

  await settle()
  act(() => rowFor('Review B').click())

  // Review B's own `flow/source` has not answered yet — Review A's token
  // must already be gone, not merely stale until B's own preview replaces it.
  expect(store.getSnapshot().frontDoor?.preview).toBeNull()

  resolveSourceB('version: 2\nname: B\n')
  await settle()
})

it('keeps Change reachable and Every time with the Flow details', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, { 'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [], 'flow/source': () => 'source', 'authoring/start/preview': () => previewOf(emptyFlow('strict-token')) })
  render(store)
  await settle()
  act(() => rowFor('Review').click())
  await settle()
  expect(button('Change')).toBeDefined()
  expect(document.querySelector('[aria-label="Search Flows"]')).toBeNull()
  expect(button('Every time…').closest('[data-slot="dialog-footer"]')).toBeNull()
})

it('the picker footer opens a solo session directly', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, { 'flow/catalog': () => [], 'agent/list': () => [] })
  const draft = vi.spyOn(store, 'newDraft').mockImplementation(() => {})
  const { onClose } = render(store)
  await settle()
  act(() => button('New session ⌘N').click())
  expect(draft).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})

it('names no internal path or layout key in its copy', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [],
    'agent/list': () => [],
  })

  render(store)
  await settle()

  expect(document.body.textContent).not.toContain('.harnessdesk/flows')
  expect(document.body.textContent).not.toContain('layout.frontDoor.contexts')
})

it('routes Build your own to the Flow page with its start context and closes the dialog', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, { 'flow/catalog': () => [], 'agent/list': () => [] })
  const open = vi.spyOn(store, 'openDestination').mockImplementation(() => {})
  const { onClose } = render(store)
  await settle()
  act(() => button('Build your own').click())
  expect(open).toHaveBeenCalledExactlyOnceWith({ kind: 'flows', root: '/repo', id: null, origin: null, start: { context: { kind: 'project', root: '/repo' }, task: '', done: '' } })
  expect(onClose).toHaveBeenCalledOnce()
})

it('keeps a reused Goal bound to the dry run and redeems the revision it echoes', async () => {
  const goal = { id: 'goal-1', revision: 4 }
  const echoedGoal = { id: 'goal-1', revision: 5 }
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, { 'flow/catalog': () => [], 'agent/list': () => [], 'authoring/start/preview': () => previewOf(emptyFlow('shape-token'), { goal: echoedGoal }), 'flow/start-goal': () => EXECUTION })
  act(() => root.render(<StoreProvider store={store}><FrontDoor context={{ kind: 'project', root: '/repo' }} goal={goal} initialSource="unsaved source" onClose={() => {}} onStarted={() => {}} /></StoreProvider>))
  await settle()
  expect(document.querySelector('[aria-label="Just a Team"]')).toBeNull()
  expect(document.querySelector('[data-slot="selected-flow"]')?.textContent).toContain('Review')
  expect(spy.mock.calls.find(([method]) => method === 'authoring/start/preview')?.[1]).toMatchObject({ goal })
  await act(async () => button('Start Team').click())
  expect(spy.mock.calls.find(([method]) => method === 'flow/start-goal')?.[1]).toMatchObject({ goal: echoedGoal })
})

it('carries the existing Goal and typed fields when Build your own opens a Flow page', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, { 'flow/catalog': () => [], 'agent/list': () => [] })
  const open = vi.spyOn(store, 'openDestination').mockImplementation(() => {})
  const goal = { id: 'goal-1', revision: 4 }
  const context = { kind: 'branch' as const, root: '/repo', branch: 'feature' }
  act(() => root.render(<StoreProvider store={store}><FrontDoor context={context} goal={goal} initialTask="Fix the cart" initialDone="Cart tests pass" onClose={() => {}} onStarted={() => {}} /></StoreProvider>))
  await settle()
  act(() => button('Build your own').click())
  expect(open).toHaveBeenCalledExactlyOnceWith({ kind: 'flows', root: '/repo', id: null, origin: null, start: { context, goal, task: 'Fix the cart', done: 'Cart tests pass' } })
})

it('an input bound from the start target renders read-only, as a fact, never an editable field that refuses its own edit', async () => {
  const boundPolicy = {
    version: 2 as const, name: 'Review', inputs: [{ id: 'branch', label: 'Branch' }],
    roles: [{ id: 'reviewer', kind: 'person' as const, outcomes: ['done'] }], rules: [],
    seed: { role: 'reviewer', title: 'Go' }, messaging: 'board-only' as const, wait: 240,
    layout: { frontDoor: { bindings: [{ input: 'branch', value: 'branch' as const }] } },
  }
  const flow: FlowPreview = {
    token: 'tok', compiled: { document: { format: 'agents', flow: boundPolicy }, bindings: [], problems: [] },
    seats: [], commands: [], guards: [], messaging: 'board-only', problems: [],
  }
  const preview = previewOf(flow, {
    vars: { branch: 'feature' },
    target: { label: 'branch feature', base: null, head: 'a1b2c3d4e5f6', dirty: false, independence: 'unknown' },
  })
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')],
    'agent/list': () => [],
    'flow/source': () => 'version: 2\nname: Review\n',
    'authoring/start/preview': () => preview,
  })

  render(store, { kind: 'branch', root: '/repo', branch: 'feature' })
  await settle()
  act(() => rowFor('Review').click())
  await settle()

  // A bound input is shown as a fact, never as a field a person can type
  // into only to have the edit refused.
  expect([...document.body.querySelectorAll('input')].some((one) => one.value === 'feature')).toBe(false)
  expect(document.body.textContent).toContain('feature')
  // The reviewed revision itself is shown, short — the same fact `Goal.at`
  // and `FlowExecution.target` otherwise carry with nowhere to read them.
  expect(document.body.textContent).toContain('branch feature at a1b2c3d')
  // The full sha is still there, on hover — a shortened value never loses it.
  expect(document.body.querySelector('[title="a1b2c3d4e5f6"]')).not.toBeNull()
})

it('a bound input carrying a commit — head or base — shows it short, with the full sha in title; a branch or a pull request bound input shows its own value whole', async () => {
  const boundPolicy = {
    version: 2 as const, name: 'Review',
    inputs: [{ id: 'head', label: 'Commit to review' }, { id: 'base', label: 'Compared with' }, { id: 'pr', label: 'Pull request' }],
    roles: [{ id: 'reviewer', kind: 'person' as const, outcomes: ['done'] }], rules: [],
    seed: { role: 'reviewer', title: 'Go' }, messaging: 'board-only' as const, wait: 240,
    layout: {
      frontDoor: {
        bindings: [
          { input: 'head', value: 'head' as const },
          { input: 'base', value: 'base' as const },
          { input: 'pr', value: 'pr' as const },
        ],
      },
    },
  }
  const flow: FlowPreview = {
    token: 'tok', compiled: { document: { format: 'agents', flow: boundPolicy }, bindings: [], problems: [] },
    seats: [], commands: [], guards: [], messaging: 'board-only', problems: [],
  }
  const preview = previewOf(flow, {
    vars: { head: 'a1b2c3d4e5f6789', base: 'f6e5d4c3b2a1000', pr: '#42' },
    target: { label: 'pull request #42', base: null, head: 'a1b2c3d4e5f6789', dirty: false, independence: 'unknown' },
  })
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')],
    'agent/list': () => [],
    'flow/source': () => 'version: 2\nname: Review\n',
    'authoring/start/preview': () => preview,
  })

  render(store, { kind: 'pull-request', root: '/repo', number: 42 })
  await settle()
  act(() => rowFor('Review').click())
  await settle()

  // The two commit-bearing inputs read short, in the interface font, never
  // the raw 15-character value sitting in the row as if it were prose.
  expect(document.body.textContent).toContain('a1b2c3d')
  expect(document.body.textContent).not.toContain('a1b2c3d4e5f6789')
  expect(document.body.textContent).toContain('f6e5d4c')
  expect(document.body.textContent).not.toContain('f6e5d4c3b2a1000')
  // The full sha for each is still reachable, on hover.
  expect(document.body.querySelector('[title="a1b2c3d4e5f6789"]')).not.toBeNull()
  expect(document.body.querySelector('[title="f6e5d4c3b2a1000"]')).not.toBeNull()
  // A pull request number is not a commit — shown whole, never shortened.
  expect(document.body.textContent).toContain('#42')
})

it('source or input changes disable Start immediately, before the fresh dry run answers', async () => {
  const held = previewOf({ ...emptyFlow('held-token') })
  const store = new AppStore('ws://localhost:0/')
  let resolveSecond!: (value: FrontDoorPreview) => void
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')],
    'agent/list': () => [],
    'flow/source': () => 'version: 2\nname: Review\n',
    'authoring/start/preview': () => held,
  })

  render(store)
  await settle()
  act(() => rowFor('Review').click())
  await settle()
  expect(button('Start Team').hasAttribute('disabled')).toBe(false)

  // A fresh request starts (a variable being edited, in the real component);
  // its answer has not landed yet, so the token from before must not still
  // be live.
  vi.spyOn(store.transport, 'request').mockImplementation((async () => new Promise<FrontDoorPreview>((resolve) => { resolveSecond = resolve })) as never)
  act(() => {
    void store.previewFrontDoor({ context: { kind: 'project', root: '/repo' }, source: 'version: 2\nname: Review\nedited: true\n', vars: {} })
  })
  expect(store.getSnapshot().frontDoor?.preview).toBeNull()
  resolveSecond(held)
  await settle()
})

it('opens the refused project and refreshes the preview without losing the task or completion sentence', async () => {
  const store = new AppStore('ws://localhost:0/')
  let opened = false
  const base = emptyFlow('fresh-token')
  const flow: FlowPreview = { ...base, compiled: { ...base.compiled, document: { format: 'agents', flow: {
    ...(base.compiled.document.format === 'agents' ? base.compiled.document.flow : neverFlow()),
    inputs: [{ id: 'task', label: 'Task' }],
  } } } }
  const request = requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [], 'flow/source': () => 'source',
    'workspace/open': () => { opened = true; return { path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 } },
    'workspace/recent': () => [{ path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 }],
    'worktree/list': () => [],
    'authoring/start/preview': params => {
      if (!opened) throw new Error('/work/storefront is outside every folder and repository opened here. Open it first.')
      return previewOf(flow, { vars: (params as { vars: Record<string, string> }).vars })
    },
    'flow/start-goal': () => EXECUTION,
  })
  const { onStarted } = render(store, { kind: 'project', root: '/work/storefront' })
  await settle()
  act(() => rowFor('Review').click())
  await settle()
  expect(button('Start Team').disabled).toBe(true)
  // A task already entered must survive a refused preview and its recovery.
  const task = document.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, 'Fix the cart')
    task.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Open storefront').click())
  expect(store.getSnapshot().workspace?.path).toBe('/work/storefront')
  expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Fix the cart')
  expect(document.body.textContent).not.toContain('outside every folder and repository opened here')
  const done = document.querySelector<HTMLInputElement>('[aria-label="Done when · optional"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(done, 'The cart works')
    done.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(button('Start Team').disabled).toBe(false)
  await act(async () => button('Start Team').click())
  expect(request.mock.calls.find(([method]) => method === 'flow/start-goal')?.[1]).toMatchObject({ root: '/work/storefront', token: 'fresh-token', sentence: 'The cart works', vars: { task: 'Fix the cart' } })
  expect(onStarted).toHaveBeenCalledWith(EXECUTION)
})

it('keeps recovery available and Start disabled when opening the refused folder fails', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review')], 'agent/list': () => [], 'flow/source': () => 'source',
    'authoring/start/preview': () => { throw new Error('/work/storefront is outside every folder and repository opened here. Open it first.') },
    'workspace/open': () => { throw new Error('The folder is unavailable.') },
  })
  render(store, { kind: 'project', root: '/work/storefront' })
  await settle()
  act(() => rowFor('Review').click())
  await settle()
  await act(async () => button('Open storefront').click())
  expect(button('Start Team').disabled).toBe(true)
  expect(button('Open storefront').disabled).toBe(false)
  expect(store.getSnapshot().workspace).toBeNull()
})

it('can open a project before its shape catalogue can be read', async () => {
  const store = new AppStore('ws://localhost:0/')
  let opened = false
  requestSpy(store, {
    'flow/catalog': () => {
      if (!opened) throw new Error('/work/storefront is outside every folder and repository opened here. Open it first.')
      return [ENTRY('review', 'Review')]
    },
    'agent/list': () => [], 'worktree/list': () => [],
    'workspace/open': () => { opened = true; return { path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 } },
    'workspace/recent': () => [{ path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 }],
  })
  render(store, { kind: 'project', root: '/work/storefront' })
  await settle()
  expect(button('Start Team').disabled).toBe(true)
  await act(async () => button('Open storefront').click())
  expect(rowFor('Review')).toBeDefined()
  expect(rowFor('Review').disabled).toBe(false)
  expect(document.body.textContent).not.toContain('outside every folder and repository opened here')
})

it.each(['catalogue', 'create'])('Just a Team recovers a %s refusal and keeps the form choices', async stage => {
  const store = new AppStore('ws://localhost:0/')
  const refusal = '/work/storefront is outside every folder and repository opened here. Open it first.'
  let opened = false
  let finishOpen!: () => void
  requestSpy(store, {
    'flow/catalog': () => {
      if (stage === 'catalogue' && !opened) throw new Error(refusal)
      return []
    },
    'agent/list': () => [], 'worktree/list': () => [],
    'workspace/open': () => new Promise(resolve => { finishOpen = () => {
      opened = true
      resolve({ path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 })
    } }),
    'workspace/recent': () => [{ path: '/work/storefront', name: 'storefront', lastOpenedAt: 1 }],
  })
  vi.spyOn(store, 'loadAgents').mockResolvedValue(undefined)
  const create = vi.spyOn(store, 'startTeam').mockImplementation(async () => {
    if (!opened) throw new Error(refusal)
    return { goal: { id: 'team-1' } } as import('@harnessdesk/protocol').GoalView
  })
  const add = vi.spyOn(store, 'teamAdd').mockResolvedValue(undefined)
  vi.spyOn(store, 'openGoal').mockImplementation(() => {})
  const { onClose } = render(store, { kind: 'project', root: '/work/storefront' })
  await settle()
  act(() => rowFor('Just a Team').click())
  await settle()
  const task = document.querySelector<HTMLTextAreaElement>('textarea')!
  const done = document.querySelector<HTMLInputElement>('[aria-label="Done when · optional"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, 'Investigate the cart')
    task.dispatchEvent(new Event('input', { bubbles: true }))
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(done, 'The cause is documented')
    done.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[aria-label="Use an isolated checkout"]')!.click()
  })
  if (stage === 'create') await act(async () => button('Start Team').click())
  // The catalogue's known refusal must survive entering the plain-Team form too.
  expect(document.body.textContent).toContain(refusal)
  await act(async () => button('Open storefront').click())
  expect(button('Start Team').disabled).toBe(true)
  await act(async () => finishOpen())
  expect(task.value).toBe('Investigate the cart')
  expect(done.value).toBe('The cause is documented')
  expect(document.querySelector('[aria-label="Use an isolated checkout"]')?.getAttribute('aria-checked')).toBe('true')
  expect(document.body.textContent).not.toContain(refusal)
  await act(async () => button('Start Team').click())
  expect(create).toHaveBeenLastCalledWith({ root: '/work/storefront', sentence: 'The cause is documented', checkout: 'isolated' })
  expect(add).toHaveBeenCalledWith('team-1', { title: 'Investigate the cart' })
  expect(onClose).toHaveBeenCalledOnce()
})


it.each([['alpha', 'beta', false], ['beta', 'beta', false], ['alpha', 'beta', true]] as const)('prefills a comparison with signed-in attempts %s and %s, delayed accounts %s', async (first, second, delayed) => {
  const { TEAM_START_POLICIES } = await import('../preview/team-start-fixture')
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), {
    runtimes: ['out', 'alpha', 'beta'].map(id => ({ id, presentation: { name: `Agent ${id}` }, capabilities: {} })),
    accountsByRuntime: delayed ? {} : { out: { accounts: [] }, alpha: { accounts: first === 'alpha' ? [{ kind: 'opaque' }] : [] }, beta: { accounts: [{ kind: 'opaque' }] } },
  })
  const accountReads: (() => void)[] = []
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('comparison', 'Side by side')], 'agent/list': () => [], 'runtime/models': () => [],
    'runtime/account': params => new Promise(resolve => { accountReads.push(() => resolve({ accounts: (params as { runtime: string }).runtime === 'out' ? [] : [{ kind: 'opaque', label: 'Signed in' }], signInMethods: [] })) }),
    'flow/source': () => JSON.stringify(TEAM_START_POLICIES.comparison),
    'authoring/shape/render': params => ({ source: JSON.stringify((params as { policy: unknown }).policy), issues: [] }),
    'authoring/start/preview': params => {
      const input = params as { source: string; vars: Record<string, string> }
      const policy = JSON.parse(input.source)
      return previewOf({ ...emptyFlow('token'), compiled: { document: { format: 'agents', flow: policy }, bindings: [], problems: [] },
        seats: policy.roles.filter((r: { kind: string }) => r.kind === 'agent').flatMap((r: { id: string; uses: string[]; seats: { runtime: string }[]; count?: number }) => Array.from({ length: r.count ?? Math.max(1, r.seats.length) }, (_, index) => ({ role: r.id, index, agent: r.uses[0], reviews: false, isolate: true, plan: { winner: 0, candidates: [{ seat: { runtime: index === 0 ? 'alpha' : 'beta' }, runtimeName: 'Available agent', label: 'Available agent', state: 'taken', reason: null, fix: null }] } }))),
      }, { source: input.source, vars: input.vars })
    },
  })
  render(store, { kind: 'project', root: '/repo' }, { id: 'comparison' }, 'Fix the cart total')
  await settle()
  if (delayed) expect(button('Start Team').disabled).toBe(true)
  if (delayed) {
    expect(document.body.textContent).toContain('Reading signed-in runtimes…')
    await act(async () => { accountReads.forEach(resolve => resolve()) })
  }
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="What should both try?"]')?.value).toBe('Fix the cart total')
  expect(document.querySelector('[aria-label="Configure Attempt A"]')?.textContent).toContain(`Agent ${first}`)
  expect(document.querySelector('[aria-label="Configure Attempt B"]')?.textContent).toContain(`Agent ${second}`)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Configure Attempt A"]')!.click())
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Model for Attempt A"]')?.disabled).toBe(false)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Configure Attempt A"]')!.click())
  expect(button('Start Team').disabled).toBe(false)
  expect(spy.mock.calls.filter(call => call[0] === 'authoring/start/preview').at(-1)?.[1]).toMatchObject({ vars: { task: 'Fix the cart total' } })
})

it('keeps placeholder rows visible until the chosen form has loaded and explains disabled Start', async () => {
  const store = new AppStore('ws://localhost:0/')
  let release!: (source: string) => void
  requestSpy(store, { 'flow/catalog': () => [ENTRY('comparison', 'Side by side')], 'agent/list': () => [],
    'flow/source': () => new Promise<string>(resolve => { release = resolve }),
    'authoring/start/preview': () => { const flow = emptyFlow('token'); return previewOf({ ...flow, compiled: { ...flow.compiled, document: { format: 'agents', flow: { ...(flow.compiled.document.format === 'agents' ? flow.compiled.document.flow : neverFlow()), inputs: [{ id: 'task', label: 'Task' }] } } } }) },
  })
  render(store)
  await settle()
  act(() => rowFor('Side by side').click())
  await settle()
  expect(document.querySelector('[aria-label="Loading Team form"]')?.querySelectorAll('[data-slot="row"]').length).toBeGreaterThanOrEqual(2)
  const reason = document.getElementById('team-start-reason')!
  expect(reason.textContent).toContain('Reading the shape')
  expect(reason.closest('[data-slot="dialog-footer"]')).not.toBeNull()
  expect(reason.closest('[data-slot="dialog-footer-navigation"]')).toBeNull()
  expect(button('Start Team').getAttribute('aria-describedby')).toBe(reason.id)
  await act(async () => release('source'))
  expect(document.querySelector('[aria-label="Loading Team form"]')).toBeNull()
  expect(button('Start Team').disabled).toBe(true)
  expect(document.body.textContent).toContain('Add a task first')
})
