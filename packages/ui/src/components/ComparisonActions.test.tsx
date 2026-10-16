import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import type { AppStore } from '../state/store'
import { shapeFixture } from '../preview/run-shapes-fixture'
import { runTimeline } from '../lib/run-timeline'
import { comparisonVerdictOf } from '../lib/comparison-verdict'
import { ComparisonActions } from './ComparisonActions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

it.each(['person', 'card'] as const)('credits the %s who made the recorded pick', async kind => {
  const input = shapeFixture('comparison')
  const verdict = comparisonVerdictOf(runTimeline(input), input.execution, input.cards)
  if (verdict?.kind !== 'picked') throw new Error('no pick')
  const store = { transport: { request: vi.fn(async () => ({ branch: 'main' })) } } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><ComparisonActions room="room" root="/code/project" execution={input.execution} cards={input.cards}
    verdict={{ ...verdict, judge: { ...verdict.judge, kind } }} choice={verdict.attempt} onKeep={() => {}} onMerged={() => {}} /></StoreProvider>))
  expect(document.body.textContent).toContain(kind === 'person' ? 'You picked A' : 'The judge picked A')
  if (kind === 'person') expect(document.body.textContent).not.toContain('The judge picked')
})
