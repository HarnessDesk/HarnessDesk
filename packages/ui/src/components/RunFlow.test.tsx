import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowEntry, FlowExecution } from '@harnessdesk/protocol'

import { RunDockProvider } from '../panels/run-dock'
import { flowGraphDocument } from '../preview/flow-graph-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { RunFlow } from './RunFlow'
import { canvasDOM } from '../test/flow-canvas-dom'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  canvasDOM()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await import('../design/patterns/FlowCanvas/Engine')
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

const settle = (): Promise<void> => act(async () => {})

const entry = (over: Partial<FlowEntry> = {}): FlowEntry => ({
  id: 'review', origin: 'project', path: '.harnessdesk/flows/review.yml', name: 'Write, review, land',
  description: null, format: 'agents', problem: null, shadows: [], ...over,
})

const fakeStore = (entries: readonly FlowEntry[], source: () => Promise<string> = async () => 'version: 2\nname: Write, review, land\n') => {
  const snapshot = emptySnapshot()
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    flowCatalog: vi.fn(async () => entries),
    flowSource: vi.fn(source),
  } as unknown as AppStore & { flowCatalog: ReturnType<typeof vi.fn>; flowSource: ReturnType<typeof vi.fn> }
}

const run = (over: Partial<Pick<FlowExecution, 'document' | 'revision' | 'rounds'>> = {}): Pick<FlowExecution, 'document' | 'revision' | 'rounds'> => ({
  document: flowGraphDocument('blueprint'),
  revision: '3f9a1c',
  rounds: [{ n: 1, role: 'write', cards: [1], seats: ['seat-a'], evidence: [], state: 'closed', cause: 'seed' }],
  ...over,
})

const render = async (store: AppStore, props: Partial<Parameters<typeof RunFlow>[0]> = {}) => {
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <RunFlow execution={run()} root="/repo" seats={[]} {...props} />
      </StoreProvider>,
    )
  })
  await act(async () => { await vi.waitFor(() => expect(container.querySelector('.react-flow__node')).not.toBeNull()) })
}

const openFile = (): HTMLButtonElement => {
  const button = [...container.querySelectorAll('button')].find((one) => one.getAttribute('aria-label') === 'Open the file')
  if (!button) throw new Error('no Open the file button')
  return button
}

it('names the Flow the Run holds, the revision it was frozen at, and says it cannot change under it', async () => {
  await render(fakeStore([]))
  const head = container.querySelector('[data-slot="run-flow-head"]')!
  expect(head.textContent).toContain('Write, review, land')
  expect(head.textContent).toContain('revision 3f9a1c')
  expect(head.textContent).toContain('frozen when this Run started')
})

it('says nothing of a revision an older record never kept', async () => {
  await render(fakeStore([]), { execution: run({ revision: null }) })
  const head = container.querySelector('[data-slot="run-flow-head"]')!
  expect(head.textContent).not.toContain('revision')
  expect(head.textContent).toContain('frozen when this Run started')
})

it('draws the Flow the Run froze, in the Flow tab and in the list under it', async () => {
  await render(fakeStore([]))
  expect([...container.querySelectorAll('[data-slot="flow-step"]')].map((one) => one.getAttribute('data-step'))).toEqual(['write', 'check', 'review', 'fix', 'land', 'you'])
  expect(container.querySelector('section[aria-label="Rules"]')!.textContent).toContain('Review → Fix')
})

it('draws a Run from before the current format as well, without a position it never had', async () => {
  await render(fakeStore([]), { execution: run({ document: flowGraphDocument('legacy') }) })
  expect([...container.querySelectorAll('[data-slot="flow-step"]')].map((one) => one.getAttribute('data-step'))).toEqual(['fixer', 'reviewer', 'referee'])
})

it('says what a step’s seats ran under and whether the runtime held it, from the seats the Run opened', async () => {
  await render(fakeStore([]), { seats: [{ id: 'seat-a', ceiling: { level: 'edit', hold: 'asked' } }] })
  expect(container.querySelector('[data-step="write"]')!.textContent).toContain('Edit · asked, not enforced')
  expect(container.querySelector('[data-step="fix"]')!.textContent).not.toContain('·')
})

it('says the level a step’s seat ran at, not the one the Flow asks for, when its Agent’s own ceiling was narrower', async () => {
  // The blueprint grants `write` an edit ceiling; a seat of an Agent that only reads runs at read.
  await render(fakeStore([]), { seats: [{ id: 'seat-a', ceiling: { level: 'read', hold: 'held' } }] })
  const write = container.querySelector('[data-step="write"]')!.textContent
  expect(write).toContain('Read only')
  expect(write).not.toContain('Edit')
})

it('says the narrowest level of a step’s seats when they ran at different ones', async () => {
  await render(fakeStore([]), {
    execution: run({ rounds: [{ n: 1, role: 'write', cards: [1, 2], seats: ['seat-a', 'seat-b'], evidence: [], state: 'closed', cause: 'seed' }] }),
    seats: [{ id: 'seat-a', ceiling: { level: 'edit', hold: 'held' } }, { id: 'seat-b', ceiling: { level: 'read', hold: 'held' } }],
  })
  expect(container.querySelector('[data-step="write"]')!.textContent).toContain('Read only')
})

it('says only the grant for a step when any one of its seats is unknown here, rather than speak for the rest', async () => {
  await render(fakeStore([]), {
    execution: run({ rounds: [{ n: 1, role: 'write', cards: [1, 2], seats: ['seat-a', 'seat-gone'], evidence: [], state: 'closed', cause: 'seed' }] }),
    seats: [{ id: 'seat-a', ceiling: { level: 'edit', hold: 'held' } }],
  })
  const write = container.querySelector('[data-step="write"]')!.textContent
  expect(write).toContain('Edit')
  expect(write).not.toContain('·')
})

it('opens the file the Flow came from, as it is now, and says the Run keeps the one it started with', async () => {
  const store = fakeStore([entry({ id: 'other', name: 'Another' }), entry()])
  await render(store)
  act(() => openFile().click())
  await settle()
  expect(store.flowCatalog).toHaveBeenCalledWith('/repo')
  expect(store.flowSource).toHaveBeenCalledWith('/repo', 'review', 'project')
  const dialog = document.body.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('version: 2')
  expect(dialog.textContent).toContain('.harnessdesk/flows/review.yml')
  expect(dialog.textContent).toContain('keeps the revision it started with')
})

it('opens it read-only: the source is text to read, not a field to edit', async () => {
  await render(fakeStore([entry()]))
  act(() => openFile().click())
  await settle()
  const dialog = document.body.querySelector('[role="dialog"]')!
  expect(dialog.querySelector('textarea, input')).toBeNull()
  expect(dialog.querySelector('[data-slot="code-block"]')).not.toBeNull()
})

it('closes the file and goes back to the drawing', async () => {
  await render(fakeStore([entry()]))
  act(() => openFile().click())
  await settle()
  act(() => (document.body.querySelector('[role="dialog"] [aria-label="Close"]') as HTMLButtonElement).click())
  await settle()
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[data-slot="flow-graph"]')).not.toBeNull()
})

it('says so when no file by that name is left, and reads nothing', async () => {
  const store = fakeStore([entry({ id: 'other', name: 'Another' })])
  await render(store)
  act(() => openFile().click())
  await settle()
  expect(store.flowSource).not.toHaveBeenCalled()
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('No flow called “Write, review, land” is in the catalogue any more.')
})

it('does not choose between two files that carry the Flow’s name, and says so', async () => {
  const store = fakeStore([entry({ id: 'copy', path: '.harnessdesk/flows/review-copy.yml' }), entry()])
  await render(store)
  act(() => openFile().click())
  await settle()
  expect(store.flowSource).not.toHaveBeenCalled()
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('More than one flow in the catalogue is called “Write, review, land”')
})

it('opens the one file of that name that parses when another of the name does not', async () => {
  const store = fakeStore([entry({ id: 'broken', format: null, problem: 'file: this flow could not be parsed' }), entry()])
  await render(store)
  act(() => openFile().click())
  await settle()
  expect(store.flowSource).toHaveBeenCalledWith('/repo', 'review', 'project')
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
})

it('skips a file that does not parse, rather than showing what could not be read as the Flow', async () => {
  const store = fakeStore([entry({ format: null, problem: 'file: this flow could not be parsed' })])
  await render(store)
  act(() => openFile().click())
  await settle()
  expect(store.flowSource).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
})

it('says what went wrong when the file cannot be read', async () => {
  await render(fakeStore([entry()], async () => { throw new Error('the host is not answering') }))
  act(() => openFile().click())
  await settle()
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('The file could not be read: the host is not answering')
  expect(container.querySelector('[role="alert"]')!.closest('.react-flow__panel')).toBeNull()
})

it('cannot open a file for a Run whose project is not known, and says why', async () => {
  const store = fakeStore([entry()])
  await render(store, { root: null })
  expect(openFile().disabled || openFile().getAttribute('aria-disabled') === 'true').toBe(true)
  expect(container.textContent).toContain('This Run’s project is not known here')
  act(() => openFile().click())
  expect(store.flowCatalog).not.toHaveBeenCalled()
})

it('is not asked twice while the file is being read', async () => {
  let release: (text: string) => void = () => {}
  const store = fakeStore([entry()], () => new Promise<string>((resolve) => { release = resolve }))
  await render(store)
  act(() => openFile().click())
  await settle()
  act(() => openFile().click())
  await settle()
  expect(store.flowSource).toHaveBeenCalledTimes(1)
  await act(async () => release('version: 2\n'))
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
})

it('shortens the check in both drawing and Steps, retaining its raw hover title', async () => {
  const store = fakeStore([])
  const snapshot = { ...store.getSnapshot(), home: '/home/dev' }
  store.getSnapshot = () => snapshot
  const source = flowGraphDocument('blueprint')
  if (source.format !== 'agents') throw new Error('expected an Agent flow fixture')
  const document = { ...source, flow: { ...source.flow, roles: source.flow.roles.map(role => role.kind === 'check' ? { ...role, check: { ...role.check!, run: 'node /home/dev/tools/land.mjs --check' } } : role) } }
  await render(store, { execution: run({ document }) })
  for (const selector of ['[data-step="check"]', '[data-step-row="check"]']) {
    const step = container.querySelector(selector)!
    expect(step.textContent).toContain('node ~/tools/land.mjs --check')
    expect(step.querySelector('[title="node /home/dev/tools/land.mjs --check"]')).not.toBeNull()
  }
})

// The graph's own container decides, not the window: 500px is a narrow pane.
const listInNarrowPane = async (docked: boolean) => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  canvasDOM({ graphWidth: 500 })
  const view = <StoreProvider store={fakeStore([])}><RunFlow execution={run()} root="/repo" seats={[]} /></StoreProvider>
  await act(async () => { root.render(docked ? <RunDockProvider>{view}</RunDockProvider> : view) })
  await act(async () => { await vi.waitFor(() => expect(container.querySelector('.react-flow__node')).not.toBeNull()) })
  return container.querySelector<HTMLElement>('[data-slot="flow-list"]')!
}

it('leaves the Steps to the Team dock in a narrow pane, instead of listing them a second time', async () => {
  expect((await listInNarrowPane(true)).dataset.placement).toBe('dock')
})

it('lists the Steps under the drawing in a narrow pane that has no dock', async () => {
  expect((await listInNarrowPane(false)).dataset.placement).toBe('below')
})
