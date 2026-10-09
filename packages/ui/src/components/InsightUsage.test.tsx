import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { InsightReport, SeatRecord } from '@harnessdesk/protocol'

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

it('loads By Goal on the Dashboard’s Projects view', async () => {
  const readUsageInsight = vi.fn(async () => report())
  const openGoal = vi.fn()
  const snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } } }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadUsage: vi.fn(async () => {}), refreshUsage: vi.fn(async () => {}), ledger: vi.fn(async () => null), readUsageInsight, openGoal } as unknown as AppStore
  await act(async () => { root.render(<StoreProvider store={store}><Usage view="projects" onClose={() => {}} /></StoreProvider>); await Promise.resolve() })
  expect(readUsageInsight).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Goal')
  expect(container.textContent).not.toContain('goal-1')
  const goal = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Open One Goal')
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
  expect(container.textContent).toContain('Goal')
  expect(container.textContent).not.toContain('goal-1')
  await act(async () => { root.render(<StoreProvider store={store}><InsightUsage root="/other" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>); await Promise.resolve() })
  expect(container.textContent).toContain('Reading recorded usage…')
  expect(container.textContent).not.toContain('Goal goal-1')
  await act(async () => { resolveNext?.(report()) })
})

it('keeps safe unreadable-source warnings visible when the Dashboard has no attribution rows', async () => {
  const unreadable = {
    ...report(),
    breakdowns: [],
    sources: [{ id: 'unreadable', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: 'Recorded usage source could not be discovered.' }],
    gaps: ['Recorded usage may be incomplete.'],
  }
  const store = { subscribe: () => () => {}, getSnapshot: (() => { const snapshot=emptySnapshot(); return () => snapshot })(), readUsageInsight: vi.fn(async () => unreadable), openGoal: vi.fn() } as unknown as AppStore

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
  const store = { subscribe: () => () => {}, getSnapshot: (() => { const snapshot=emptySnapshot(); return () => snapshot })(), readUsageInsight: vi.fn(async () => multiFailure), openGoal: vi.fn() } as unknown as AppStore

  await act(async () => {
    root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>)
    await Promise.resolve()
  })

  // `data-wrap` is what the stylesheet keys on to let a sentence run to a
  // second line instead of being ellipsised — see Row's description, which wraps unless it is a name or a path (`truncateDesc`).
  const wrapped = [...container.querySelectorAll('[data-wrap]')]
  expect(wrapped.map((el) => el.textContent)).toEqual(['Unknown historical usage remains unassigned.', longSentence, secondSentence])
})

it('keeps the unattributed reason on the table footer', async () => {
 const store={subscribe:()=>()=>{},getSnapshot:(() => { const snapshot=emptySnapshot(); return () => snapshot })()} as unknown as AppStore
 await act(async()=>root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={()=>{}} report={report()} /></StoreProvider>))
 expect(container.querySelector('tfoot td')?.hasAttribute('title')).toBe(false)
 expect(container.querySelector('tfoot td')?.textContent).toContain('No unique historical Seat could be established.')
})

it('does not count an unassigned Seat as belonging to a null Goal row', async () => {
 const base = report()
 const goalRow = { ...base.breakdowns[0]!.rows[0]!, key: 'goal:unassigned', label: 'Unassigned usage', goal: null }
 const unassignedSeat = { id: 'seat-unassigned', board: null, openedAt: 1, closed: null } as unknown as SeatRecord
 const unassigned: InsightReport = {
  ...base,
  seats: [unassignedSeat],
  breakdowns: [{ ...base.breakdowns[0]!, rows: [goalRow] }],
 }
 const snapshot = emptySnapshot()
 const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
 await act(async () => root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} report={unassigned} /></StoreProvider>))
 expect(container.querySelector('tbody tr td:nth-child(3)')?.textContent).toBe('0')
})

it('uses the report sentence while Goal records are pending', async () => {
 const base = report()
 const goalSentence = 'Repair the storefront checkout.'
 const waiting = { ...base, breakdowns: [{ ...base.breakdowns[0]!, rows: [{ ...base.breakdowns[0]!.rows[0]!, label: goalSentence }] }] }
 let finishLoading: (() => void) | undefined
 const loading = new Promise<void>(resolve => { finishLoading = resolve })
 const snapshot = emptySnapshot()
 const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadGoals: vi.fn(() => loading), loadTeamRunsBatch: vi.fn(async (teams: readonly string[]) => ({ loaded: new Set(teams), unavailable: new Set<string>() })) } as unknown as AppStore
 await act(async () => root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} report={waiting} /></StoreProvider>))
 expect(container.querySelector('tbody tr')?.textContent).toContain(goalSentence)
 expect(container.querySelector('button[aria-label]')?.getAttribute('aria-label')).toBe(`Open ${goalSentence}`)
 expect(container.textContent).not.toContain('goal-1')
 await act(async () => { finishLoading?.(); await Promise.resolve(); await Promise.resolve() })
})

it('loads Runs only for Teams represented by the visible breakdown rows', async () => {
 const base = report()
 const otherSeat = { id: 'seat-hidden', board: 'hidden-team', openedAt: 1, closed: null } as unknown as SeatRecord
 const selected = { ...base, seats: [otherSeat] }
 const loadTeamRunsBatch = vi.fn(async (teams: readonly string[]) => ({ loaded: new Set(teams), unavailable: new Set<string>() }))
 const snapshot = emptySnapshot()
 const store = {
  subscribe: () => () => {}, getSnapshot: () => snapshot,
  loadGoals: vi.fn(async () => {}), loadTeamRunsBatch,
 } as unknown as AppStore
 await act(async () => {
  root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} report={selected} /></StoreProvider>)
  await Promise.resolve(); await Promise.resolve()
 })
 expect(loadTeamRunsBatch).toHaveBeenCalledWith(['goal-1'])
})

it('says visibly when Run counts could not be loaded', async () => {
 const loadTeamRunsBatch = vi.fn(async () => ({ loaded: new Set<string>(), unavailable: new Set(['goal-1']) }))
 const snapshot = emptySnapshot()
 const store = {
  subscribe: () => () => {}, getSnapshot: () => snapshot,
  loadGoals: vi.fn(async () => {}), loadTeamRunsBatch,
 } as unknown as AppStore
 await act(async () => {
  root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} report={report()} /></StoreProvider>)
  await Promise.resolve(); await Promise.resolve()
 })
 expect(container.textContent).toContain('Run counts are unavailable for some Teams')
 expect(container.querySelector('tbody tr td:nth-child(2)')?.textContent).toBe('—')
})

it('keeps row notes and the compact Cost qualification visible while leaving the basis in the title', async () => {
 const base = report()
 const row = base.breakdowns[0]!.rows[0]!
 const basis = 'Vendor- or list-price cost; another portion is unknown'
 const shown: InsightReport = {
  ...base,
  breakdowns: [{
   ...base.breakdowns[0]!,
   rows: [{
    ...row,
    note: 'Streaming usage remains a floor.',
    amounts: { ...row.amounts, usd: { ...metric(2), basis: 'mixed', quality: 'estimate', coverage: 'partial' } },
   }],
   reason: 'No unique historical Seat could be established for this amount.',
  }],
 }
 const snapshot = emptySnapshot()
 const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
 await act(async () => root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} report={shown} /></StoreProvider>))
 const rowElement = container.querySelector('tbody tr')!
 const costCell = rowElement.querySelector('td:nth-child(4)')!
 expect(container.querySelector('[data-slot="note"]')?.textContent).toBe('Streaming usage remains a floor.')
 expect(container.querySelector('tfoot')?.textContent).toContain('No unique historical Seat could be established for this amount.')
 expect(costCell.textContent).toContain('Estimate')
 expect(costCell.textContent).toContain('Known subtotal')
 expect(costCell.textContent).not.toContain('Estimated known subtotal')
 expect(costCell.textContent).not.toContain(basis)
 expect(costCell.querySelector('[title]')?.getAttribute('title')).toContain(basis)
 expect(costCell.querySelector('[title]')?.getAttribute('title')).toContain('Estimated known subtotal')
})

it('wraps the empty-state reason sentence instead of clipping it', async () => {
  const empty = {
    ...report(),
    breakdowns: [{ dimension: 'goal' as const, rows: [], unattributed: report().breakdowns[0]!.unattributed, reason: null }],
  }
  const store = { subscribe: () => () => {}, getSnapshot: (() => { const snapshot=emptySnapshot(); return () => snapshot })(), readUsageInsight: vi.fn(async () => empty), openGoal: vi.fn() } as unknown as AppStore

  await act(async () => {
    root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} /></StoreProvider>)
    await Promise.resolve()
  })

  const row = [...container.querySelectorAll('[data-wrap]')].find((el) => el.textContent === 'Unknown historical usage remains unassigned.')
  expect(row).toBeTruthy()
})

it('retains source age and cost qualification on the numeric cost cell', async () => {
 const unfresh={...report(),sources:[{id:'source',kind:'corpus' as const,label:'Transcript',observedAt:null,checkedAt:10,stale:false,problem:null}]}
 const store={subscribe:()=>()=>{},getSnapshot:(() => { const snapshot=emptySnapshot(); return () => snapshot })()} as unknown as AppStore
 await act(async()=>root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={()=>{}} report={unfresh} /></StoreProvider>))
 expect(container.querySelector('tbody td:nth-child(4) [title]')?.getAttribute('title')).toContain('Observation time unavailable')
})

it('keeps a group-level gap note outside the Rows card rather than flush against it', async () => {
  const withGapAndFailure = {
    ...report(),
    breakdowns: [],
    sources: [{ id: 'unreadable', kind: 'corpus' as const, label: 'Recorded usage', observedAt: null, checkedAt: 10, stale: false, problem: 'Recorded usage source could not be discovered.' }],
    gaps: ['Recorded usage may be incomplete.'],
  }
  const store = { subscribe: () => () => {}, getSnapshot: (() => { const snapshot=emptySnapshot(); return () => snapshot })(), readUsageInsight: vi.fn(async () => withGapAndFailure), openGoal: vi.fn() } as unknown as AppStore

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

it('shows a budget-limited report as one whole-range warning', async () => {
  const base = report()
  const partial: InsightReport = { ...base, scan: 'partial', gaps: ['Insight stopped at 64 MiB of source data. Choose a narrower range.'], breakdowns: base.breakdowns.map(b => ({ ...b, rows: b.rows.map(row => ({ ...row, amounts: { ...row.amounts, usd: { ...metric(2), quality: 'estimate', coverage: 'partial' } } })) })) }
  const store = { subscribe: () => () => {}, getSnapshot: (() => { const snapshot = emptySnapshot(); return () => snapshot })() } as unknown as AppStore
  await act(async () => { root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} report={partial} /></StoreProvider>) })
  expect(container.textContent).toContain('Amounts are incomplete for this range')
  expect(container.textContent).not.toContain('Amounts are unknown')
  expect([...container.querySelectorAll('th')].map(cell => cell.textContent)).toContain('Cost')
  expect(container.querySelector('tbody td:nth-child(4)')?.textContent).toContain('Known subtotal')
  expect(container.textContent).toContain('Reading stopped at 64 MiB')
  expect(container.querySelector('tbody')?.textContent).not.toContain('Partial')
  expect(container.textContent).not.toContain('Insight stopped at')
})

it('replaces unknown amounts with one range warning and offers a shorter read', async () => {
 const base=report()
 const unknown={...base,scan:'partial' as const,totals:{...base.totals,usd:metric(null)},gaps:['Insight stopped at 64 MiB of source data. Choose a narrower range.'],breakdowns:base.breakdowns.map(b=>({...b,rows:b.rows.map(row=>({...row,amounts:{...row.amounts,usd:metric(null)}}))}))}
 const readUsageInsight=vi.fn(async (_query: unknown)=>unknown)
 const store={subscribe:()=>()=>{},getSnapshot:(() => { const snapshot=emptySnapshot(); return () => snapshot })(),readUsageInsight} as unknown as AppStore
 await act(async()=>{root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={()=>{}} /></StoreProvider>);await Promise.resolve()})
 expect(container.textContent).toContain('Amounts are unknown for this range')
 expect(container.textContent).toContain('64 MiB')
 expect(container.querySelectorAll('thead th').length).toBeGreaterThan(1)
 expect(container.querySelector('tbody')?.textContent).not.toContain('Unknown')
 expect(container.querySelector('tfoot')?.textContent).toContain('Not attributed to a Team')
 const shorter=[...container.querySelectorAll('button')].find(b=>b.textContent==='Last 24 hours')!
 await act(async()=>{shorter.click();await Promise.resolve()})
 const query=readUsageInsight.mock.calls.at(-1)![0] as unknown as {from:number,to:number}
 expect(query.to-query.from).toBe(86400000)
})

it('reads Team names and range-scoped Run counts without showing the Goal brief', async () => {
 const base=report()
 const goal={id:'goal-1',sentence:'A very long instruction that should never become the row name',origin:{kind:'person'}} as never
 const snapshot={...emptySnapshot(),goals:new Map([['goal-1',{goal,board:{name:'Storefront'}} as never]]),flowExecutions:new Map([
  ['recent',{goal:'goal-1',startedAt:5,document:{flow:{name:'Build'}},base:{branch:'feature/storefront'}} as never],
  ['older',{goal:'goal-1',startedAt:-1,document:{flow:{name:'Build'}}} as never],
 ])}
 const loadTeamRunsBatch=vi.fn(async (teams: readonly string[])=>({loaded:new Set(teams),unavailable:new Set<string>()}))
 const store={subscribe:()=>()=>{},getSnapshot:()=>snapshot,loadGoals:vi.fn(async()=>{}),loadTeamRunsBatch} as unknown as AppStore
 await act(async()=>{root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={()=>{}} report={{...base,goals:[goal]}} /></StoreProvider>);await Promise.resolve();await Promise.resolve()})
 const row=container.querySelector('tbody tr')!
 expect(row.textContent).toContain('Storefront')
 expect(row.textContent).toContain('Team Storefront · Build flow · branch feature/storefront')
 expect(row.textContent).not.toContain('A very long instruction')
 expect(row.children[1]?.textContent).toBe('1')
})

const scopedSeat = (id: string, runtime: string, openedAt: number, closedAt: number | null): SeatRecord => ({
 id, board: 'goal-1', agent: { id: 'builder', origin: 'project', name: 'Builder' },
 session: { runtime, sessionId: id }, openedAt, closed: closedAt === null ? null : { at: closedAt },
} as SeatRecord)

const showCounts = async (view: 'goal' | 'agent', runtime: string | null, from = 100, to = 200) => {
 const base = report()
 const seats = [scopedSeat('old', 'alpha', 0, 99), scopedSeat('current', 'alpha', 100, null), scopedSeat('other', 'beta', 100, null), scopedSeat('future', 'alpha', 201, null)]
 const snapshot = { ...emptySnapshot(), flowExecutions: new Map([
  ['alpha', { goal: 'goal-1', startedAt: 110, document: { flow: { name: 'Build' } }, rounds: [{ seats: ['current'] }] } as never],
  ['beta', { goal: 'goal-1', startedAt: 120, document: { flow: { name: 'Build' } }, rounds: [{ seats: ['other'] }] } as never],
  ['old', { goal: 'goal-1', startedAt: 90, document: { flow: { name: 'Build' } }, rounds: [{ seats: ['old'] }] } as never],
 ]) }
 const rows = base.breakdowns[0]!.rows.map(row => view === 'goal' ? row : { ...row, key: 'agent:project:builder', goal: null, label: 'Builder' })
 const selected: InsightReport = { ...base, query: { root: '/repo', from, to }, seats: runtime ? seats.filter(seat => seat.session.runtime === runtime) : seats, breakdowns: [{ ...base.breakdowns[0]!, dimension: view, rows }] }
 const loadTeamRunsBatch = vi.fn(async (teams: readonly string[]) => ({ loaded: new Set(teams), unavailable: new Set<string>() }))
 const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadGoals: vi.fn(async () => {}), loadTeamRunsBatch } as unknown as AppStore
 await act(async () => { root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={runtime as never} view={view} onGoal={() => {}} report={selected} /></StoreProvider>); await Promise.resolve(); await Promise.resolve() })
 return [...container.querySelectorAll('tbody tr:first-child td')].slice(1, 3).map(cell => cell.textContent)
}

it('counts only Runs with Seats in the selected runtime for a Goal', async () => {
 expect((await showCounts('goal', 'alpha'))[0]).toBe('1')
})

it.each(['goal', 'agent'] as const)('counts only Seats overlapping the range in the %s view', async view => {
 expect((await showCounts(view, null))[1]).toBe('2')
})

it('applies both runtime and range to Agent counts', async () => {
 expect(await showCounts('agent', 'alpha')).toEqual(['1', '1'])
})

it('shows observed zero counts when an Agent has no Seats or Runs in the range', async () => {
 expect(await showCounts('agent', 'alpha', -100, -1)).toEqual(['0', '0'])
})

it('labels Project usage’s range, restores it and resets it on a project switch', async () => {
  const base = report()
  const unknown = { ...base, totals: { ...base.totals, usd: metric(null) }, breakdowns: base.breakdowns.map(b => ({ ...b, rows: b.rows.map(row => ({ ...row, amounts: { ...row.amounts, usd: metric(null) } })) })) }
  const readUsageInsight = vi.fn(async (_query: unknown) => unknown)
  let snapshot = { ...emptySnapshot(), workspace: { path: '/repo', name: 'repo', lastOpenedAt: 0, repo: { root: '/repo' } } }
  const listeners = new Set<() => void>()
  const store = { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => snapshot, loadUsage: vi.fn(async () => {}), refreshUsage: vi.fn(async () => {}), ledger: vi.fn(async () => null), readUsageInsight, openGoal: vi.fn() } as unknown as AppStore
  await act(async () => { root.render(<StoreProvider store={store}><Usage view="projects" onClose={() => {}} /></StoreProvider>); await Promise.resolve() })
  const span = () => { const query = readUsageInsight.mock.calls.at(-1)![0] as unknown as { from: number; to: number }; return query.to - query.from }
  const click = async (text: string) => { await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === text)!.click(); await Promise.resolve() }) }
  expect(container.querySelector('[aria-label="Project usage"]')?.textContent).toContain('Last 30 days')
  expect(span()).toBe(30 * 86400000)
  await click('Last 24 hours')
  expect(span()).toBe(86400000)
  expect(container.querySelector('[aria-label="Project usage"]')?.textContent).toContain('Last 24 hours')
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Last 24 hours')).toBe(false)
  await click('Last 30 days')
  expect(span()).toBe(30 * 86400000)
  await click('Last 24 hours')
  await act(async () => { snapshot = { ...snapshot, workspace: { path: '/other', name: 'other', lastOpenedAt: 0, repo: { root: '/other' } } }; listeners.forEach(listener => listener()); await Promise.resolve() })
  expect(span()).toBe(30 * 86400000)
  expect(readUsageInsight).toHaveBeenLastCalledWith(expect.objectContaining({ root: '/other' }))
  expect(container.querySelector('[aria-label="Project usage"]')?.textContent).toContain('Last 30 days')
})


it('states Historical Seats once beneath the table and omits a restated footer reason', async () => {
 const base = report(); const b = base.breakdowns[0]!
 const shown = { ...base, breakdowns: [{ ...b, reason: 'Not attributed to a Team.', rows: [1, 2].map(n => ({ ...b.rows[0]!, key: `goal-${n}`, note: 'Historical Seats' })) }] }
 const snapshot = emptySnapshot()
 const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
 await act(async () => root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} report={shown} /></StoreProvider>))
 expect(container.querySelector('tbody')?.textContent).not.toContain('Historical Seats')
 expect([...container.querySelectorAll('[data-slot="note"]')].filter(n => n.textContent === 'Historical Seats')).toHaveLength(1)
 expect(container.querySelector('tfoot td')?.textContent).toBe('Not attributed to a Team')
})

it('uses only Known subtotal for an exact partial cost', async () => {
 const base = report(); const b = base.breakdowns[0]!
 const shown = { ...base, breakdowns: [{ ...b, rows: [{ ...b.rows[0]!, amounts: { ...b.rows[0]!.amounts, usd: { ...metric(2), coverage: 'partial' as const } } }] }] }
 const snapshot = emptySnapshot()
 const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
 await act(async () => root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} report={shown} /></StoreProvider>))
 expect(container.querySelector('tbody td:nth-child(4)')?.textContent).toBe('$2.00Known subtotal')
})

it('retains Team reads across views and requests only newly visible Teams', async () => {
 const base = report(); const b = base.breakdowns[0]!
 const seats = [scopedSeat('current', 'alpha', 0, null), { ...scopedSeat('other', 'alpha', 0, null), board: 'team-two' }]
 const shown = { ...base, seats, breakdowns: [b, { ...b, dimension: 'agent' as const, rows: [{ ...b.rows[0]!, key: 'agent:project:builder', label: 'Builder' }] }] }
 const snapshot = { ...emptySnapshot(), flowExecutions: new Map([['run', { goal: 'goal-1', startedAt: 5, document: { flow: { name: 'Build' } }, rounds: [{ seats: ['current'] }] } as never]]) }
 let finish: (() => void) | undefined
 const loadTeamRunsBatch = vi.fn(async (teams: readonly string[]) => {
   if (teams.includes('team-two')) await new Promise<void>(resolve => { finish = resolve })
   return { loaded: new Set(teams), unavailable: new Set<string>() }
 })
 const loadGoals = vi.fn(async () => {})
 const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadGoals, loadTeamRunsBatch } as unknown as AppStore
 const show = async (view: 'goal' | 'agent') => { await act(async () => { root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view={view} onGoal={() => {}} report={shown} /></StoreProvider>); await Promise.resolve(); await Promise.resolve() }) }
 await show('goal')
 expect(container.querySelector('tbody td:nth-child(2)')?.textContent).toBe('1')
 await show('agent')
 expect(loadTeamRunsBatch.mock.calls.map(c => c[0])).toEqual([['goal-1'], ['team-two']])
 await show('goal')
 expect(container.querySelector('tbody td:nth-child(2)')?.textContent).toBe('1')
 expect(loadGoals).toHaveBeenCalledOnce()
 await act(async () => { finish?.(); await Promise.resolve() })
 await show('agent')
 expect(container.querySelector('tbody td:nth-child(2)')?.textContent).toBe('1')
 expect(loadTeamRunsBatch).toHaveBeenCalledTimes(2)
})

it('retries refused Teams on view entry while retaining successful reads', async () => {
 const base = report(); const b = base.breakdowns[0]!
 const seat = { ...scopedSeat('other', 'alpha', 0, null), board: 'team-two' }
 const shown = { ...base, seats: [seat], breakdowns: [b, { ...b, dimension: 'agent' as const, rows: [{ ...b.rows[0]!, key: 'agent:project:builder', label: 'Builder' }] }] }
 const snapshot = emptySnapshot()
 const loadTeamRunsBatch = vi.fn(async (teams: readonly string[]) => ({ loaded: new Set(teams.filter(t => t !== 'team-two')), unavailable: new Set(teams.filter(t => t === 'team-two')) }))
 const loadGoals = vi.fn(async () => {})
 const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadGoals, loadTeamRunsBatch } as unknown as AppStore
 const show = async (view: 'goal' | 'agent', selected = shown) => { await act(async () => { root.render(<StoreProvider store={store}><InsightUsage root={selected.query.root} runtime={null} view={view} onGoal={() => {}} report={selected} /></StoreProvider>); await Promise.resolve(); await Promise.resolve() }) }
 await show('agent')
 expect(container.textContent).toContain('Run counts are unavailable')
 await show('goal')
 expect(container.textContent).not.toContain('Run counts are unavailable')
 expect(container.querySelector('tbody td:nth-child(2)')?.textContent).toBe('0')
 await show('agent')
 expect(container.textContent).toContain('Run counts are unavailable')
 expect(loadTeamRunsBatch.mock.calls.map(c => c[0])).toEqual([['team-two'], ['goal-1'], ['team-two']])
 await show('goal', { ...shown, query: { ...shown.query, root: '/other' } })
 expect(loadTeamRunsBatch).toHaveBeenCalledTimes(4)
 expect(loadGoals).toHaveBeenCalledTimes(2)
})


it('retries only refused Teams from the note and recovers their counts', async () => {
 const base = report(); const b = base.breakdowns[0]!
 const shown = { ...base, breakdowns: [{ ...b, rows: [b.rows[0]!, { ...b.rows[0]!, key: 'team-two', goal: 'team-two', label: 'Second Goal' }] }] }
 const snapshot = emptySnapshot()
 const loadTeamRunsBatch = vi.fn()
   .mockResolvedValueOnce({ loaded: new Set(['goal-1']), unavailable: new Set(['team-two']) })
   .mockRejectedValueOnce(new Error('Timeout'))
   .mockResolvedValueOnce({ loaded: new Set(['team-two']), unavailable: new Set() })
 const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadGoals: vi.fn(async () => {}), loadTeamRunsBatch } as unknown as AppStore
 await act(async () => root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} report={shown} /></StoreProvider>))
 expect(container.querySelector('tbody tr:first-child td:nth-child(2)')?.textContent).toBe('0')
 expect(container.querySelector('tbody tr:last-child td:nth-child(2)')?.textContent).toBe('—')
 const retry = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Try again')
 expect(retry()).toBeTruthy()
 await act(async () => retry()!.click())
 expect(container.textContent).toContain('Run counts are unavailable')
 await act(async () => retry()!.click())
 expect(loadTeamRunsBatch.mock.calls.map(c => c[0])).toEqual([['goal-1', 'team-two'], ['team-two'], ['team-two']])
 expect(container.textContent).not.toContain('Run counts are unavailable')
 expect(container.querySelector('tbody tr:last-child td:nth-child(2)')?.textContent).toBe('0')
})

it('keeps the focused retry and refusal visible until a delayed retry settles', async () => {
 const shown = report()
 const snapshot = emptySnapshot()
 let settle: ((value: { loaded: Set<string>; unavailable: Set<string> }) => void) | undefined
 const loadTeamRunsBatch = vi.fn()
   .mockResolvedValueOnce({ loaded: new Set(), unavailable: new Set(['goal-1']) })
   .mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
 const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, loadGoals: vi.fn(async () => {}), loadTeamRunsBatch } as unknown as AppStore
 await act(async () => root.render(<StoreProvider store={store}><InsightUsage root="/repo" runtime={null} view="goal" onGoal={() => {}} report={shown} /></StoreProvider>))
 const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Try again')!
 retry.focus()
 await act(async () => retry.click())
 expect(container.textContent).toContain('Run counts are unavailable for some Teams.')
 expect(retry.isConnected).toBe(true)
 expect(retry.textContent).toBe('Trying again…')
 expect(retry.getAttribute('aria-disabled')).toBe('true')
 expect(document.activeElement).toBe(retry)
 await act(async () => retry.click())
 expect(loadTeamRunsBatch).toHaveBeenCalledTimes(2)
 await act(async () => settle!({ loaded: new Set(), unavailable: new Set(['goal-1']) }))
 expect(retry.textContent).toBe('Try again')
 expect(retry.getAttribute('aria-disabled')).not.toBe('true')
 expect(document.activeElement).toBe(retry)
 expect(container.textContent).toContain('Run counts are unavailable for some Teams.')
})
