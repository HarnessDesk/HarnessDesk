import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowEntry, FlowExecution } from '@harnessdesk/protocol'

import { flowGraphDocument } from '../preview/flow-graph-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { RunFlow } from './RunFlow'

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

const render = (store: AppStore, props: Partial<Parameters<typeof RunFlow>[0]> = {}) => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <RunFlow execution={run()} root="/repo" seats={[]} {...props} />
      </StoreProvider>,
    )
  })
}

const openFile = (): HTMLButtonElement => {
  const button = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Open the file')
  if (!button) throw new Error('no Open the file button')
  return button
}

it('names the Flow the Run holds, the revision it was frozen at, and says it cannot change under it', () => {
  render(fakeStore([]))
  const head = container.querySelector('[data-slot="run-flow-head"]')!
  expect(head.textContent).toContain('Write, review, land')
  expect(head.textContent).toContain('revision 3f9a1c')
  expect(head.textContent).toContain('frozen when this Run started')
})

it('says nothing of a revision an older record never kept', () => {
  render(fakeStore([]), { execution: run({ revision: null }) })
  const head = container.querySelector('[data-slot="run-flow-head"]')!
  expect(head.textContent).not.toContain('revision')
  expect(head.textContent).toContain('frozen when this Run started')
})

it('draws the Flow the Run froze, in the Flow tab and in the list under it', () => {
  render(fakeStore([]))
  expect([...container.querySelectorAll('[data-slot="flow-step"]')].map((one) => one.getAttribute('data-step'))).toEqual(['write', 'check', 'review', 'fix', 'land', 'you'])
  expect(container.querySelector('section[aria-label="Rules"]')!.textContent).toContain('Review → Fix')
})

it('draws a Run from before the current format as well, without a position it never had', () => {
  render(fakeStore([]), { execution: run({ document: flowGraphDocument('legacy') }) })
  expect([...container.querySelectorAll('[data-slot="flow-step"]')].map((one) => one.getAttribute('data-step'))).toEqual(['fixer', 'reviewer', 'referee'])
})

it('says whether the runtime held a step’s ceiling, from the seats the Run opened', () => {
  render(fakeStore([]), { seats: [{ id: 'seat-a', ceiling: { level: 'edit', hold: 'asked' } }] })
  expect(container.querySelector('[data-step="write"]')!.textContent).toContain('Edit · asked')
  expect(container.querySelector('[data-step="fix"]')!.textContent).not.toContain('·')
})

it('opens the file the Flow came from, as it is now, and says the Run keeps the one it started with', async () => {
  const store = fakeStore([entry({ id: 'other', name: 'Another' }), entry()])
  render(store)
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
  render(fakeStore([entry()]))
  act(() => openFile().click())
  await settle()
  const dialog = document.body.querySelector('[role="dialog"]')!
  expect(dialog.querySelector('textarea, input')).toBeNull()
  expect(dialog.querySelector('[data-slot="code-block"]')).not.toBeNull()
})

it('closes the file and goes back to the drawing', async () => {
  render(fakeStore([entry()]))
  act(() => openFile().click())
  await settle()
  act(() => (document.body.querySelector('[role="dialog"] [aria-label="Close"]') as HTMLButtonElement).click())
  await settle()
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[data-slot="flow-graph"]')).not.toBeNull()
})

it('says so when no file by that name is left, and reads nothing', async () => {
  const store = fakeStore([entry({ id: 'other', name: 'Another' })])
  render(store)
  act(() => openFile().click())
  await settle()
  expect(store.flowSource).not.toHaveBeenCalled()
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('No flow called “Write, review, land” is in the catalogue any more.')
})

it('skips a file that does not parse, rather than showing what could not be read as the Flow', async () => {
  const store = fakeStore([entry({ format: null, problem: 'file: this flow could not be parsed' })])
  render(store)
  act(() => openFile().click())
  await settle()
  expect(store.flowSource).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
})

it('says what went wrong when the file cannot be read', async () => {
  render(fakeStore([entry()], async () => { throw new Error('the host is not answering') }))
  act(() => openFile().click())
  await settle()
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('The file could not be read: the host is not answering')
})

it('cannot open a file for a Run whose project is not known, and says why', () => {
  const store = fakeStore([entry()])
  render(store, { root: null })
  expect(openFile().disabled || openFile().getAttribute('aria-disabled') === 'true').toBe(true)
  expect(container.textContent).toContain('This Run’s project is not known here')
  act(() => openFile().click())
  expect(store.flowCatalog).not.toHaveBeenCalled()
})

it('is not asked twice while the file is being read', async () => {
  let release: (text: string) => void = () => {}
  const store = fakeStore([entry()], () => new Promise<string>((resolve) => { release = resolve }))
  render(store)
  act(() => openFile().click())
  await settle()
  act(() => openFile().click())
  await settle()
  expect(store.flowSource).toHaveBeenCalledTimes(1)
  await act(async () => release('version: 2\n'))
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
})
