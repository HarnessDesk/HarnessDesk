import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowEntry, FlowUpdatePreview } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ProjectFlows } from './ProjectFlows'

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

const fakeStore = (entries: readonly FlowEntry[] | (() => Promise<readonly FlowEntry[]>)): AppStore => {
  const snapshot = emptySnapshot()
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    flowCatalog: vi.fn(async () => (typeof entries === 'function' ? entries() : entries)),
    previewFlowUpdate: vi.fn(async (): Promise<FlowUpdatePreview> => { throw new Error('not reached') }),
    applyFlowUpdate: vi.fn(async () => { throw new Error('not reached') }),
    openFile: vi.fn(),
  } as unknown as AppStore
}

const render = (store: AppStore, current = true) => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ProjectFlows root="/repo" current={current} />
      </StoreProvider>,
    )
  })
}

it('a broken shadow entry shows its refusal on screen and writes nothing', async () => {
  const broken: FlowEntry = {
    id: 'fix', origin: 'project', path: '.harnessdesk/flows/fix.yml', name: 'Fix',
    description: null, format: null, problem: 'file: this flow could not be parsed', shadows: [{ origin: 'user', path: 'fix.yml' }],
  }
  const store = fakeStore([broken])
  render(store)
  await settle()
  expect(container.textContent).toContain('this flow could not be parsed')
  expect(container.textContent).toContain('Will not run')
  expect(store.previewFlowUpdate).not.toHaveBeenCalled()
  expect(store.applyFlowUpdate).not.toHaveBeenCalled()
})

it('an empty catalogue reads as a claim, not a folder the host was refused, and writes nothing', async () => {
  const store = fakeStore([])
  render(store)
  await settle()
  expect(container.textContent).toContain('No flows of its own')
  expect(store.previewFlowUpdate).not.toHaveBeenCalled()
  expect(store.applyFlowUpdate).not.toHaveBeenCalled()
})

it('opening Update or Customize is the only thing that reads a preview — never on render', async () => {
  const legacy: FlowEntry = { id: 'old', origin: 'project', path: '.harnessdesk/flows/old.yml', name: 'Old', description: null, format: 'legacy', problem: null, shadows: [] }
  const shipped: FlowEntry = { id: 'ship', origin: 'builtin', path: 'ship.yml', name: 'Ship', description: 'A starting point.', format: 'agents', problem: null, shadows: [] }
  const store = fakeStore([legacy, shipped])
  render(store)
  await settle()
  expect(store.previewFlowUpdate).not.toHaveBeenCalled()

  const update = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Update…')
  expect(update).toBeDefined()
  act(() => update!.click())
  await settle()
  expect(store.previewFlowUpdate).toHaveBeenCalledWith('/repo', 'old', 'update')

  const customize = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Customize…')
  expect(customize).toBeDefined()
})
