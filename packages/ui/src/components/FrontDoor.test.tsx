import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowEntry, FlowExecution, FlowPreview, FrontDoorPreview, HostMethodName } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { FrontDoor } from './FrontDoor'

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

const render = (store: AppStore, context: import('@harnessdesk/protocol').StartContext = { kind: 'project', root: '/repo' }) => {
  const onClose = vi.fn()
  const onStarted = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <FrontDoor context={context} onClose={onClose} onStarted={onStarted} />
      </StoreProvider>,
    )
  })
  return { onClose, onStarted }
}

// `Dialog` portals its content to `document.body`, not into `container` —
// the same reason `NewSessionChoice.test.tsx` (itself all `Dialog`) queries
// `document` rather than the render target.
const rowFor = (name: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.startsWith(name))
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

it('focuses search, filters by summary, and picks with the keyboard', async () => {
  const store = new AppStore('ws://localhost:0/')
  requestSpy(store, {
    'flow/catalog': () => [ENTRY('review', 'Review', { summary: 'Security specialists.' }), ENTRY('other', 'Other')],
    'agent/list': () => [], 'flow/source': () => 'source',
    'authoring/start/preview': () => previewOf(emptyFlow('token')),
  })
  render(store)
  await settle()
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search shapes"]')!
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

it('Change keeps the task and Done when is the sentence sent to start', async () => {
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
  act(() => button('Change').click())
  act(() => rowFor('Review').click())
  await settle()
  expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Fix the cart')
  const done = document.querySelector<HTMLInputElement>('[aria-label="Done when · optional"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(done, 'The cart test passes')
    done.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => button('Start').click())
  await settle()
  expect(spy.mock.calls.find(call => call[0] === 'flow/start-goal')?.[1]).toMatchObject({ sentence: 'The cart test passes', vars: { task: 'Fix the cart' } })
})

const neverFlow = (): never => { throw new Error('expected current format') }

it('prefills the project check, previews an edited command, and keeps an empty check after Change', async () => {
  const { TEAM_START_POLICIES } = await import('../preview/team-start-fixture')
  const original: import('@harnessdesk/protocol').FlowPolicy = TEAM_START_POLICIES.comparison
  const policy = { ...original, inputs: [{ id: 'task', label: 'Task', default: 'Fix the cart' }], roles: original.roles.filter(role => role.kind !== 'check'), rules: [
    { id: 'to-judge', on: 'competitor', then: { role: 'judge', title: 'Pick the best attempt' } },
    ...original.rules.filter(rule => rule.on === 'judge'),
  ] }
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, {
    'flow/catalog': () => [ENTRY('comparison', 'Side by side')], 'agent/list': () => [], 'flow/source': () => JSON.stringify(policy),
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
  act(() => rowFor('Side by side').click())
  await settle()
  const check = (): HTMLInputElement => {
    const label = [...document.querySelectorAll('label')].find(one => one.textContent?.includes('Check each attempt with'))
    expect(label).toBeDefined()
    return document.getElementById(label!.htmlFor) as HTMLInputElement
  }
  expect(check().value).toBe('pnpm test')
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
  act(() => button('Change').click())
  act(() => rowFor('Side by side').click())
  await settle()
  expect(check().value).toBe('')
  act(() => button('Start').click())
  await settle()
  const started = spy.mock.calls.find(call => call[0] === 'flow/start-goal')?.[1] as { source: string }
  expect(JSON.parse(started.source).roles.some((role: { kind: string }) => role.kind === 'check')).toBe(false)
  expect(JSON.parse(started.source).rules.find((rule: { id: string }) => rule.id === 'to-judge').on).toBe('competitor')
})

it.each(['render', 'preview'])('holds Change and Details inputs until a policy %s settles, then keeps the edit', async phase => {
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
  expect(button('Start').disabled).toBe(true)
  expect(button('Change').disabled).toBe(true)
  const ticket = [...document.querySelectorAll<HTMLInputElement>('input')].find(one => one.value === '42')!
  expect(ticket.disabled).toBe(true)
  act(() => button('Change').click())
  expect(document.querySelector('[aria-label="Search shapes"]')).toBeNull()
  await act(async () => release())
  expect(button('Change').disabled).toBe(false)
  expect(ticket.disabled).toBe(false)
  act(() => button('Change').click())
  act(() => rowFor('Write and review').click())
  await settle()
  expect(button('2').getAttribute('aria-pressed')).toBe('true')
  act(() => button('Start').click())
  await settle()
  const started = spy.mock.calls.find(call => call[0] === 'flow/start-goal')?.[1] as { source: string }
  expect(JSON.parse(started.source).budget.rounds).toBe(5)
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
  expect(button('Start').disabled).toBe(false)
  const command = (): HTMLInputElement => [...document.querySelectorAll('input')].find(one => one.value.startsWith('pnpm') || one.value === '')!
  const edit = (value: string): void => {
    const field = command()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  act(() => edit('pnpm slow'))
  expect(button('Start').disabled).toBe(true)
  expect(store.getSnapshot().frontDoor?.preview).toBeNull()
  act(() => edit('pnpm good'))
  await settle()
  expect(button('Start').disabled).toBe(false)
  await act(async () => refuse({ source: '', issues: [{ at: 'roles.verify', text: 'Old refusal', fix: null }] }))
  expect(document.body.textContent).not.toContain('Old refusal')
  expect(button('Start').disabled).toBe(false)
  act(() => edit(''))
  await settle()
  expect(button('Start').disabled).toBe(true)
  expect(document.body.textContent).toContain('A command is required.')
})

it('Just a Team creates a flow-less Team with the typed completion sentence', async () => {
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, { 'flow/catalog': () => [], 'agent/list': () => [] })
  vi.spyOn(store, 'loadAgents').mockResolvedValue(undefined)
  const create = vi.spyOn(store, 'createGoal').mockResolvedValue({ goal: { id: 'team-1' } } as import('@harnessdesk/protocol').GoalView)
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
  act(() => button('Start').click())
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
  expect(button('Start').hasAttribute('disabled')).toBe(false)

  // Click two: Start.
  act(() => button('Start').click())
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

  const names = [...document.body.querySelectorAll('button')]
    .map((one) => one.textContent?.trim())
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
  expect(button('Start').hasAttribute('disabled')).toBe(true)
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
  expect(button('Start').hasAttribute('disabled')).toBe(false)

  act(() => button('Change').click())
  await settle()
  act(() => rowFor('Review B').click())

  // Review B's own `flow/source` has not answered yet — Review A's token
  // must already be gone, not merely stale until B's own preview replaces it.
  expect(store.getSnapshot().frontDoor?.preview).toBeNull()

  resolveSourceB('version: 2\nname: B\n')
  await settle()
})

it('"Choose a different shape" reads before "Every time…" in the footer', async () => {
  const preview = previewOf(emptyFlow('strict-token'))
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

  const labels = [...document.body.querySelectorAll('button')].map((one) => one.textContent?.trim())
  const chooseIndex = labels.indexOf('Change')
  const everyTimeIndex = labels.indexOf('Every time…')
  expect(chooseIndex).toBeGreaterThan(-1)
  expect(everyTimeIndex).toBeGreaterThan(-1)
  expect(chooseIndex).toBeLessThan(everyTimeIndex)
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

it('passes a reused empty Goal through to "Your own shape", its dry run and Start', async () => {
  const goal = { id: 'goal-1', revision: 4 }
  const echoedGoal = { id: 'goal-1', revision: 5 }
  const preview = previewOf(emptyFlow('shape-token'), { goal: echoedGoal })
  const store = new AppStore('ws://localhost:0/')
  const spy = requestSpy(store, {
    'flow/catalog': () => [],
    'agent/list': () => [],
    'authoring/shape/render': (params) => {
      const { policy } = params as { policy: unknown }
      return { source: JSON.stringify(policy), issues: [] }
    },
    'authoring/start/preview': () => preview,
    'flow/start-goal': () => EXECUTION,
  })

  const onStarted = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <FrontDoor context={{ kind: 'project', root: '/repo' }} goal={goal} onClose={() => {}} onStarted={onStarted} />
      </StoreProvider>,
    )
  })
  await settle()
  act(() => rowFor('Build your own').click())
  await settle()

  const previewCalls = spy.mock.calls.filter((call) => call[0] === 'authoring/start/preview')
  expect(previewCalls.length).toBeGreaterThan(0)
  expect((previewCalls[0]![1] as { goal?: unknown }).goal).toEqual(goal)

  act(() => button('Start').click())
  await settle()
  const started = spy.mock.calls.find((call) => call[0] === 'flow/start-goal')![1] as { goal?: unknown }
  // Start redeems the goal the preview itself echoed back — at the revision
  // the server actually saw it at, never the possibly-stale prop.
  expect(started.goal).toEqual(echoedGoal)
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
  expect(button('Start').hasAttribute('disabled')).toBe(false)

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
