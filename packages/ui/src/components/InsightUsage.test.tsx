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

it('keeps safe unreadable-source warnings visible when the Dashboard has no attribution rows', async () => {
  const unreadable = {
    ...report(),
    breakdowns: [],
    sources: [{ id: 'unreadable', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: 'Recorded usage source could not be discovered.' }],
    gaps: ['Recorded usage may be incomplete.'],
  }
  const store = { subscribe: () => () => {}, getSnapshot: emptySnapshot, readUsageInsight: vi.fn(async () => unreadable), openGoal: vi.fn() } as unknown as AppStore

  await act(async () => {
    root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>)
    await Promise.resolve()
  })

  expect(container.textContent).toContain('Recorded usage has no goal attribution.')
  expect(container.textContent).toContain('Recorded usage source could not be discovered.')
  expect(container.textContent).toContain('Recorded usage may be incomplete.')
  expect(container.textContent).toContain('Recorded usage')
  expect(container.textContent).toContain('Unavailable')
})

it('wraps every unavailable source’s full failure sentence instead of clipping it, one row per source', async () => {
  const longSentence = 'Recorded usage source could not be discovered because the folder that holds an agent’s own transcripts could not be opened for reading on this machine.'
  const secondSentence = 'A second, differently unavailable recorded usage source.'
  const multiFailure = {
    ...report(),
    breakdowns: [],
    sources: [
      { id: 'unreadable-one', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: longSentence },
      { id: 'unreadable-two', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: secondSentence },
    ],
  }
  const store = { subscribe: () => () => {}, getSnapshot: emptySnapshot, readUsageInsight: vi.fn(async () => multiFailure), openGoal: vi.fn() } as unknown as AppStore

  await act(async () => {
    root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>)
    await Promise.resolve()
  })

  // `data-wrap` is what the stylesheet keys on to let a sentence run to a
  // second line instead of being ellipsised — see Row's description, which wraps unless it is a name or a path (`truncateDesc`).
  const wrapped = [...container.querySelectorAll('[data-wrap]')]
  expect(wrapped.map((el) => el.textContent)).toEqual([longSentence, secondSentence])
})

it('wraps the unattributed row’s reason sentence instead of clipping it', async () => {
  const store = { subscribe: () => () => {}, getSnapshot: emptySnapshot, readUsageInsight: vi.fn(async () => report()), openGoal: vi.fn() } as unknown as AppStore

  await act(async () => {
    root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>)
    await Promise.resolve()
  })

  const row = [...container.querySelectorAll('[data-wrap]')].find((el) => el.textContent === 'No unique historical Seat could be established.')
  expect(row).toBeTruthy()
})

it('wraps the empty-state reason sentence instead of clipping it', async () => {
  const empty = {
    ...report(),
    breakdowns: [{ dimension: 'goal' as const, rows: [], unattributed: report().breakdowns[0]!.unattributed, reason: null }],
  }
  const store = { subscribe: () => () => {}, getSnapshot: emptySnapshot, readUsageInsight: vi.fn(async () => empty), openGoal: vi.fn() } as unknown as AppStore

  await act(async () => {
    root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>)
    await Promise.resolve()
  })

  const row = [...container.querySelectorAll('[data-wrap]')].find((el) => el.textContent === 'Unknown historical usage remains unassigned.')
  expect(row).toBeTruthy()
})

it('wraps a Goal row’s joined fact list — a RowButton, not just a Row — instead of losing facts to clipping', async () => {
  const unfresh = {
    ...report(),
    sources: [{ id: 'source', kind: 'corpus' as const, label: 'Transcript', observedAt: null, checkedAt: 10, stale: false, problem: null }],
  }
  const store = { subscribe: () => () => {}, getSnapshot: emptySnapshot, readUsageInsight: vi.fn(async () => unfresh), openGoal: vi.fn() } as unknown as AppStore

  await act(async () => {
    root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>)
    await Promise.resolve()
  })

  // 'One Goal' has a `goal`, so it renders as a RowButton, not a Row — the
  // fact this joined desc still carries `data-wrap` is what proves RowButton
  // grew the same option Row already had.
  const goalButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('One Goal'))
  expect(goalButton).toBeTruthy()
  const desc = goalButton!.querySelector('[data-wrap]')
  expect(desc).toBeTruthy()
  expect(desc!.textContent).toContain('Observation time unavailable')
})

it('keeps a group-level gap note outside the Rows card rather than flush against it', async () => {
  const withGapAndFailure = {
    ...report(),
    breakdowns: [],
    sources: [{ id: 'unreadable', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: 'Recorded usage source could not be discovered.' }],
    gaps: ['Recorded usage may be incomplete.'],
  }
  const store = { subscribe: () => () => {}, getSnapshot: emptySnapshot, readUsageInsight: vi.fn(async () => withGapAndFailure), openGoal: vi.fn() } as unknown as AppStore

  await act(async () => {
    root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>)
    await Promise.resolve()
  })

  const note = [...container.querySelectorAll('[data-slot="note"]')].find((el) => el.textContent === 'Recorded usage may be incomplete.')
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
