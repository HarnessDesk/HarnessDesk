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
