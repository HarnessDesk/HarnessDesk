import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { runtimeId, type RuntimeResources as Cost } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { RuntimeResources } from './RuntimeResources'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('shows process cost, keeps a refused recycle disabled, and refreshes after recycling', async () => {
  const id = runtimeId('fixture')
  const cost: { -readonly [K in keyof Cost]: Cost[K] } = { runtime: id, observedAt: Date.now(), processes: 3, residentBytes: 128 * 1024 * 1024, canRecycle: false, reason: 'Close its conversations first.' }
  const read = vi.fn(async () => [cost])
  const recycle = vi.fn(async () => { cost.processes = 0; return { recycled: true } })
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, runtimeResources: read, recycleRuntime: recycle } as unknown as AppStore
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={store}><RuntimeResources runtime={id} /></StoreProvider>))
    expect(box.textContent).toContain('3 processes')
    expect(box.textContent).toContain('128 MiB')
    const button = box.querySelector('button')!
    expect(button.disabled).toBe(true)
    expect(box.textContent).toContain('Close its conversations first.')
    cost.canRecycle = true
    // Trigger a fresh mount to consume the next authoritative observation.
    await act(async () => root.render(<StoreProvider store={store}><RuntimeResources key="next" runtime={id} /></StoreProvider>))
    expect(box.querySelector('button')!.disabled).toBe(false)
    await act(async () => box.querySelector('button')!.click())
    expect(recycle).toHaveBeenCalledWith(id)
    expect(box.textContent).toContain('0 processes')
  } finally { vi.useRealTimers(); act(() => root.unmount()); box.remove() }
})

it('a recycle completion from the previous page cannot invalidate the new page observation', async () => {
  const oldId = runtimeId('old-fixture'), newId = runtimeId('new-fixture')
  const cost = (runtime: typeof oldId, processes: number): Cost => ({ runtime, observedAt: Date.now(), processes, residentBytes: 0, canRecycle: true, reason: null })
  let finishRecycle!: (value: { recycled: boolean }) => void
  let finishRead!: (value: readonly Cost[]) => void
  const recycle = new Promise<{ recycled: boolean }>(resolve => { finishRecycle = resolve })
  const nextRead = new Promise<readonly Cost[]>(resolve => { finishRead = resolve })
  const read = vi.fn().mockResolvedValueOnce([cost(oldId, 1)]).mockReturnValueOnce(nextRead).mockResolvedValue([cost(oldId, 0)])
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, runtimeResources: read, recycleRuntime: () => recycle } as unknown as AppStore
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={store}><RuntimeResources runtime={oldId} /></StoreProvider>))
    act(() => box.querySelector('button')!.click())
    await act(async () => root.render(<StoreProvider store={store}><RuntimeResources runtime={newId} /></StoreProvider>))
    await act(async () => finishRecycle({ recycled: true }))
    await act(async () => finishRead([cost(newId, 9)]))
    expect(box.textContent).toContain('9 processes')
    expect(read).toHaveBeenCalledTimes(2)
  } finally { act(() => root.unmount()); box.remove() }
})
