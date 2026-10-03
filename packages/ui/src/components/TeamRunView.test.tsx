import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { runFixture, runTeamStore } from '../preview/run-view-fixture'
import { runTimeline } from '../lib/run-timeline'
import { TeamRunView } from './TeamRunView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('Try again retries the inspector’s failed review read and clears its warning', async () => {
  const fixture = runFixture()
  const execution = { ...fixture.execution, findings: { version: 1 as const, budget: { rounds: 3, withoutProgress: 2 }, closedRounds: [], idleRounds: 0, progress: [], series: [], stopped: null, extraRound: null, overrides: [], lastDecision: null } }
  const base = runTeamStore()
  const read = vi.fn().mockRejectedValueOnce(new Error('Read unavailable')).mockResolvedValue(undefined)
  const retryTimeline = vi.fn()
  const store = new Proxy(base, { get(target, key) { if (key === 'loadFindingRun') return read; return Reflect.get(target, key) } })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<StoreProvider store={store}><TeamRunView execution={execution} origin={null} onOpenSeat={() => {}}
      model={runTimeline({ ...fixture, execution })} number={1} selectedRow={null} onSelect={() => {}} onRetry={retryTimeline} /></StoreProvider>))
    expect(container.textContent).toContain('Review details could not be read.')
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Try again')!
    await act(async () => retry.click())
    expect(retryTimeline).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Review details could not be read.')
  } finally { act(() => root.unmount()) }
})
