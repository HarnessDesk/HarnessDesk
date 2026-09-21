import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEntry, InsightReport } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { AgentSeatCosts } from './AgentSeatCosts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const entry = {
  id: 'reviewer', origin: 'project', path: '/repo/.harnessdesk/agents/reviewer/AGENT.md', digest: 'same', shadows: [], problems: [],
  definition: { id: 'reviewer', name: 'Reviewer', description: '', permission: 'read', answers: [], produces: [], skills: [], brief: 'review', prefer: [{ runtime: 'runtime', model: 'expensive' }, { runtime: 'runtime', model: 'cheap' }] },
} as unknown as AgentEntry
const metric = (value: number | null) => ({ value, quality: value === null ? 'unknown' as const : 'exact' as const, unit: 'usd' as const, basis: 'vendorMetered' as const, sourceIds: ['source'], coverage: value === null ? 'none' as const : 'complete' as const, missing: [] })
const report = (): InsightReport => ({
  id: 'report', generatedAt: 10, query: { root: '/repo', from: 0, to: 10 }, goal: null, receipt: null,
  goals: [{ id: 'goal-1', root: '/repo', sentence: 'Review one', state: 'wrapped' } as never],
  seats: [
    { id: 'left', agent: { id: 'reviewer', name: 'Reviewer', origin: 'project' }, briefDigest: 'same', seat: { runtime: 'runtime', model: 'expensive' }, seatLabel: 'Expensive', board: 'goal-1', checkout: { project: '/repo' }, session: { runtime: 'runtime', sessionId: 'left' }, openedAt: 0, closed: null },
    { id: 'right', agent: { id: 'reviewer', name: 'Reviewer', origin: 'project' }, briefDigest: 'same', seat: { runtime: 'runtime', model: 'cheap' }, seatLabel: 'Cheap', board: 'goal-1', checkout: { project: '/repo' }, session: { runtime: 'runtime', sessionId: 'right' }, openedAt: 0, closed: null },
  ] as never,
  totals: { usd: metric(12), tokens: { ...metric(null), unit: 'tokens', basis: 'observed' }, activeMs: { ...metric(null), unit: 'milliseconds', basis: 'unknown' }, turns: { ...metric(2), unit: 'count', basis: 'observed' } }, elapsedMs: { ...metric(null), unit: 'milliseconds', basis: 'unknown' },
  breakdowns: [], sources: [{ id: 'source', kind: 'corpus', label: 'Transcript', observedAt: 0, checkedAt: 10, stale: false, problem: null }], recordedSpend: [], provenance: { state: 'available', note: '' }, gaps: [],
})

it('offers an explicit reviewed order only for two historical candidates with a shared completed Goal', async () => {
  const readAgentInsight = vi.fn(async () => report())
  const snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } }, seating: { revision: 0, path: '/tmp/seating.json', entries: [{ id: 'reviewer', seats: entry.definition!.prefer }], problems: [] } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readAgentInsight, previewInsightOrder: vi.fn(), applyInsightOrder: vi.fn() } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><AgentSeatCosts entry={entry} /></StoreProvider>))
  await act(async () => {})
  const order = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Order by cost')
  expect(order).toBeTruthy()
  expect(order?.hasAttribute('disabled')).toBe(false)
  expect(container.textContent).toContain('Expensive')
  expect(readAgentInsight).toHaveBeenCalledWith('/repo', 'reviewer', 'project')
})
