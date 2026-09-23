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

it('sends the effective default order when this machine has no seating override', async () => {
  const readAgentInsight = vi.fn(async () => report())
  const previewInsightOrder = vi.fn(async () => ({ stamp: 'swap', expiresAt: 20, current: entry.definition!.prefer, proposed: [...entry.definition!.prefer].reverse(), labels: ['Expensive', 'Cheap'], report: { leftPerGoalUsd: metric(12), sources: [] }, reason: null }))
  const snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } }, seating: { revision: 0, path: '/tmp/seating.json', entries: [], problems: [] } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readAgentInsight, previewInsightOrder, applyInsightOrder: vi.fn() } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><AgentSeatCosts entry={entry} /></StoreProvider>))
  await act(async () => {})
  const order = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Order by cost')
  await act(async () => order?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(previewInsightOrder).toHaveBeenCalledWith(expect.objectContaining({ current: entry.definition!.prefer }))
})

it('shows the actual current order beside a reviewed swap', async () => {
  const readAgentInsight = vi.fn(async () => report())
  const previewInsightOrder = vi.fn(async () => ({
    stamp: 'swap', expiresAt: 20, current: entry.definition!.prefer, proposed: [...entry.definition!.prefer].reverse(), labels: ['Expensive', 'Cheap'],
    report: { leftPerGoalUsd: metric(12), sources: [] }, reason: null,
  }))
  const snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } }, seating: { revision: 0, path: '/tmp/seating.json', entries: [{ id: 'reviewer', seats: entry.definition!.prefer }], problems: [] } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readAgentInsight, previewInsightOrder, applyInsightOrder: vi.fn() } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><AgentSeatCosts entry={entry} /></StoreProvider>))
  await act(async () => {})
  const order = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Order by cost')
  await act(async () => order?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await act(async () => {})
  expect(previewInsightOrder).toHaveBeenCalledOnce()
  expect(document.body.textContent).toContain('Current orderExpensive, Cheap')
  expect(document.body.textContent).toContain('Proposed ordercheap, expensive')
})

it('keeps an unavailable historical source visible when the Agent has no Seats', async () => {
  const unavailable = {
    ...report(),
    seats: [],
    sources: [{ id: 'unavailable-source', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: 'Recorded usage is unavailable.' }],
  }
  const readAgentInsight = vi.fn(async () => unavailable)
  const snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readAgentInsight, previewInsightOrder: vi.fn(), applyInsightOrder: vi.fn() } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><AgentSeatCosts entry={entry} /></StoreProvider>))
  await act(async () => {})
  expect(container.textContent).toContain('No historical Seats were recorded')
  expect(container.textContent).toContain('Recorded usage')
  expect(container.textContent).toContain('Unavailable')
  expect(container.textContent).toContain('Recorded usage is unavailable.')
})

it('keeps generic historical gaps visible beside partial Agent Seats', async () => {
  const partial = { ...report(), gaps: ['Some historical usage is unavailable.'] }
  const readAgentInsight = vi.fn(async () => partial)
  const snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readAgentInsight, previewInsightOrder: vi.fn(), applyInsightOrder: vi.fn() } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><AgentSeatCosts entry={entry} /></StoreProvider>))
  await act(async () => {})
  expect(container.textContent).toContain('Expensive')
  expect(container.textContent).toContain('Some historical usage is unavailable.')
})

it('wraps every unavailable source’s full failure sentence instead of clipping it, one row per source', async () => {
  const longSentence = 'Recorded usage is unavailable because the folder that holds this Agent’s own transcripts could not be opened for reading on this machine.'
  const secondSentence = 'A second, differently unavailable recorded usage source.'
  const multiFailure = {
    ...report(),
    seats: [],
    sources: [
      { id: 'unavailable-one', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: longSentence },
      { id: 'unavailable-two', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: secondSentence },
    ],
  }
  const readAgentInsight = vi.fn(async () => multiFailure)
  const snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readAgentInsight, previewInsightOrder: vi.fn(), applyInsightOrder: vi.fn() } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><AgentSeatCosts entry={entry} /></StoreProvider>))
  await act(async () => {})

  // `data-wrap` is what the stylesheet keys on to let a sentence run to a
  // second line instead of being ellipsised — see Row's `wrapDesc`.
  const wrapped = [...container.querySelectorAll('[data-wrap]')]
  expect(wrapped.map((el) => el.textContent)).toEqual([longSentence, secondSentence])
})

it('keeps a group-level gap note outside the Rows card rather than flush against it', async () => {
  const withGapAndFailure = {
    ...report(),
    seats: [],
    sources: [{ id: 'unavailable', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: 'Recorded usage is unavailable.' }],
    gaps: ['Some historical usage is unavailable.'],
  }
  const readAgentInsight = vi.fn(async () => withGapAndFailure)
  const snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readAgentInsight, previewInsightOrder: vi.fn(), applyInsightOrder: vi.fn() } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><AgentSeatCosts entry={entry} /></StoreProvider>))
  await act(async () => {})

  const note = [...container.querySelectorAll('[data-slot="note"]')].find((el) => el.textContent === 'Some historical usage is unavailable.')
  expect(note).toBeTruthy()
  // The failed-source row's wrapped desc span sits, by Row's own fixed
  // markup, three levels below the Rows card: the desc span, inside
  // rowText, inside the row itself, inside the card — not a guess at a
  // hashed CSS-module class name.
  const wrappedDesc = container.querySelector('[data-wrap]')
  expect(wrappedDesc).toBeTruthy()
  const card = wrappedDesc!.parentElement!.parentElement!.parentElement!
  expect(card.contains(note!)).toBe(false)
})
