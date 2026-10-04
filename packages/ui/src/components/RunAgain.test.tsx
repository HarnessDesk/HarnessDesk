import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { FlowPreview } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { runFixture } from '../preview/run-view-fixture'
import { RunAgain } from './RunAgain'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('reads the saved inputs, obtains fresh consent and starts a new Run with lineage', async () => {
  const execution = runFixture('stopped').execution
  const vars = { brief: 'The recorded brief' }
  const flowDocument = { ...execution.document, flow: { ...execution.document.flow, inputs: [{ id: 'brief', label: 'Brief' }] } } as typeof execution.document
  const dry: FlowPreview = { token: 'fresh-token', compiled: { document: flowDocument, bindings: [], problems: [] }, seats: [], commands: [], guards: [], messaging: 'board-only', problems: [] }
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, flowGeneration: () => 0,
    flowExecutionSource: vi.fn().mockResolvedValue({ source: 'saved-source', vars }),
    flowCatalog: vi.fn().mockResolvedValue([]), agentsIn: vi.fn().mockResolvedValue([]),
    previewFlow: vi.fn().mockResolvedValueOnce(dry).mockResolvedValue({ ...dry, token: 'new-token' }),
    startFlowGoal: vi.fn().mockRejectedValueOnce(new Error('A Seat is still inside a turn.')).mockResolvedValue({ ...execution, id: 'new-run', continues: execution.id }),
  } as unknown as AppStore
  const onStarted = vi.fn(), onClose = vi.fn()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<StoreProvider store={store}><RunAgain execution={execution} root="/repo" sentence="Retry checkout" onStarted={onStarted} onClose={onClose} /></StoreProvider>))
    expect(store.flowExecutionSource).toHaveBeenCalledWith(execution.id)
    expect(store.previewFlow).toHaveBeenCalledWith('/repo', 'saved-source', vars, { seats: undefined, attended: true, continues: execution.id })
    expect(store.startFlowGoal).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')!.value).toBe(vars.brief)
    const start = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(one => one.textContent === 'Start')!
    await act(async () => start.click())
    expect(store.startFlowGoal).toHaveBeenCalledWith({ root: '/repo', sentence: 'Retry checkout', source: 'saved-source', vars, token: 'fresh-token', continues: execution.id, seats: undefined, attended: true })
    expect(onStarted).not.toHaveBeenCalled()
    expect(store.previewFlow).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('A Seat is still inside a turn.')
    await act(async () => start.click())
    expect(store.startFlowGoal).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'new-token', vars, continues: execution.id }))
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-run', continues: execution.id }))
  } finally { act(() => root.unmount()); container.remove() }
})

it('withholds Start when the saved source cannot be read', async () => {
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot,
    flowExecutionSource: vi.fn().mockRejectedValue(new Error('The saved source is unavailable.')),
    previewFlow: vi.fn(), startFlowGoal: vi.fn(),
  } as unknown as AppStore
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<StoreProvider store={store}><RunAgain execution={runFixture('stopped').execution} root="/repo" sentence="Retry" onStarted={() => {}} onClose={() => {}} /></StoreProvider>))
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('The saved source is unavailable.')
    const start = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(one => one.textContent === 'Start')!
    expect(start.disabled).toBe(true)
    expect(store.previewFlow).not.toHaveBeenCalled()
    expect(store.startFlowGoal).not.toHaveBeenCalled()
  } finally { act(() => root.unmount()); container.remove() }
})
