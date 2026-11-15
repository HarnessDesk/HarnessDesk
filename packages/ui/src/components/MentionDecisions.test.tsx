import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { useMentionTriage } from './MentionDecisions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('ignores an older review reply after a revision has supplied newer history', async () => {
  const stop = { id: `u-${'a'.repeat(64)}`, trigger: 't', project: '/example', repository: 'example/project', thread: { kind: 'issue' as const, number: 1 }, author: null, excerpt: '', url: 'https://example.com', createdAt: 1, state: 'unconfirmed' as const, progress: { queuedCancelled: 0, runsMarkedStopped: 0, interruptRequestsIssued: 0, leadRunsMarkedStopped: 0, leadPlanStopped: false }, summary: 'Could not confirm interruption.' }
  const page = { mode: 'act' as const, decisions: [], threads: [], unconfirmedStops: [stop] }
  let finish!: (value: Omit<typeof stop, 'state'> & { state: 'reviewed' }) => void
  const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), triggerDecisions: vi.fn(async () => page), reviewTriggerStop: vi.fn(() => new Promise(resolve => { finish = resolve })) } as unknown as AppStore
  let state!: ReturnType<typeof useMentionTriage>
  const View = ({ revision }: { revision: number }) => { state = useMentionTriage('/example', 't', true, revision); return null }
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => { root.render(<StoreProvider store={store}><View revision={1} /></StoreProvider>) })
    await act(async () => { void state.reviewStop(stop.id) })
    expect(state.busy).toBe(true)
    await act(async () => { root.render(<StoreProvider store={store}><View revision={2} /></StoreProvider>) })
    expect(state.busy).toBe(false)
    await act(async () => { finish({ ...stop, state: 'reviewed' }) })
    expect(state.page?.unconfirmedStops?.[0]?.state).toBe('unconfirmed')
  } finally { act(() => root.unmount()) }
})

it('sends the acknowledgement to the dedicated review method with its exact identity', async () => {
  const { AppStore } = await import('../state/store')
  const store = new AppStore('ws://localhost:0/')
  const stop = `u-${'b'.repeat(64)}`
  const request = vi.spyOn(store.transport, 'request').mockResolvedValue({ id: stop, state: 'reviewed' } as never)
  await store.reviewTriggerStop('/example', 't', stop)
  expect(request).toHaveBeenCalledWith('trigger/stop-unconfirmed/review', { root: '/example', id: 't', stop })
})
