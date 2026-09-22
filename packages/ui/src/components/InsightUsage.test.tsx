import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { InsightReport } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { InsightUsage } from './InsightUsage'
import { Usage } from './Usage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const metric = (value: number | null) => ({ value, quality: value === null ? 'unknown' as const : 'exact' as const, unit: 'usd' as const, basis: 'vendorMetered' as const, sourceIds: ['source'], coverage: value === null ? 'none' as const : 'complete' as const, missing: [] })
const report = (): InsightReport => ({
  id: 'report', generatedAt: 10, query: { root: '/repo', from: 0, to: 10 }, goals: [], seats: [], goal: null, receipt: null,
  totals: { usd: metric(2), tokens: { ...metric(null), unit: 'tokens', basis: 'observed' }, activeMs: { ...metric(null), unit: 'milliseconds', basis: 'unknown' }, turns: { ...metric(1), unit: 'count', basis: 'observed' } }, elapsedMs: { ...metric(null), unit: 'milliseconds', basis: 'unknown' },
  breakdowns: [{ dimension: 'goal', rows: [{ key: 'goal:one', label: 'One Goal', amounts: { usd: metric(2), tokens: { ...metric(null), unit: 'tokens', basis: 'observed' }, activeMs: { ...metric(null), unit: 'milliseconds', basis: 'unknown' }, turns: { ...metric(1), unit: 'count', basis: 'observed' } }, seat: null, goal: 'goal-1', session: null, message: null, note: null, elapsedMs: { ...metric(null), unit: 'milliseconds', basis: 'unknown' } }], unattributed: { usd: metric(null), tokens: { ...metric(null), unit: 'tokens', basis: 'observed' }, activeMs: { ...metric(null), unit: 'milliseconds', basis: 'unknown' }, turns: { ...metric(null), unit: 'count', basis: 'observed' } }, reason: null }],
  sources: [{ id: 'source', kind: 'corpus', label: 'Transcript', observedAt: 0, checkedAt: 10, stale: false, problem: null }], recordedSpend: [], provenance: { state: 'available', note: '' }, gaps: [],
})

it('loads By Goal on the Usage window’s initial view', async () => {
  const readUsageInsight = vi.fn(async () => report())
  const openGoal = vi.fn()
  const snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadUsage: vi.fn(async () => {}), refreshUsage: vi.fn(async () => {}), ledger: vi.fn(async () => null), readUsageInsight, openGoal } as unknown as AppStore
  await act(async () => { root.render(<StoreProvider store={store}><Usage onClose={() => {}} /></StoreProvider>); await Promise.resolve() })
  expect(readUsageInsight).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('One Goal')
  const goal = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('One Goal'))
  await act(async () => goal?.click())
  expect(openGoal).toHaveBeenCalledWith('goal-1')
})

it('sends the Dashboard runtime scope with its project usage read', async () => {
  const readUsageInsight = vi.fn(async () => report())
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readUsageInsight, openGoal: vi.fn() } as unknown as AppStore
  await act(async () => {
    root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={'alpha' as never} view="goal" onGoal={() => {}} /></StoreProvider>)
    await Promise.resolve()
  })
  expect(readUsageInsight).toHaveBeenCalledWith(expect.objectContaining({ root: '/repo', runtime: 'alpha' }))
})

it('clears the previous project attribution while the next project loads', async () => {
  let resolveNext: ((value: InsightReport) => void) | null = null
  const readUsageInsight = vi.fn()
    .mockResolvedValueOnce(report())
    .mockImplementationOnce(() => new Promise<InsightReport>((resolve) => { resolveNext = resolve }))
  const snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readUsageInsight, openGoal: vi.fn() } as unknown as AppStore
  await act(async () => { root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>); await Promise.resolve() })
  expect(container.textContent).toContain('One Goal')
  await act(async () => { root.render(<StoreProvider store={store}><InsightUsage root="/other" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>); await Promise.resolve() })
  expect(container.textContent).toContain('Reading recorded usage…')
  expect(container.textContent).not.toContain('One Goal')
  await act(async () => { resolveNext?.(report()) })
})
