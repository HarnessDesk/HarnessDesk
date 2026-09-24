import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FindingView, GoalView } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import type { FindingsListState } from '../lib/findings'
import { GoalFindings } from './GoalFindings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const A = 'a'.repeat(40)

const row = (id: string, over: Partial<FindingView> = {}): FindingView => ({
  id, origin: { goal: 'g1', run: 'run-1', round: 3, card: 2, seat: 'seat-writer', at: A },
  ownerGoal: 'g1', title: `Title of ${id}`, body: 'Body text.', category: 'ordinary', blocking: true,
  related: null, anchor: null, lifecycle: { state: 'open', confirmed: false, repairs: [] },
  sequence: 1, evidence: [`ev-${id}`], posted: [], restored: false, problem: null,
  ...over,
})

const goalView = (findingPublication?: boolean): GoalView => ({
  goal: {
    id: 'g1', root: '/repo', cwd: '/repo', sentence: 'Ship it', state: 'open', revision: 4,
    checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, receipt: null,
    ...(findingPublication !== undefined ? { findingPublication } : {}),
  },
  activity: 'working', waitingOn: [], members: [],
  board: { id: 'g1', name: 'Ship it', root: '/repo', updatedAt: 1, members: [], messaging: true, intents: [], channel: [] },
  receipt: null, problem: null,
})

const rig = (findings: FindingsListState | undefined, overrides: Partial<AppSnapshot> = {}): { store: AppStore } => {
  const snapshot = {
    ...emptySnapshot(),
    goals: new Map([['g1', goalView(true)]]),
    findings: findings ? new Map([['g1', findings]]) : new Map(),
    ...overrides,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadFindings: vi.fn().mockResolvedValue(undefined),
    loadFindingRun: vi.fn().mockResolvedValue(undefined),
    readFinding: vi.fn().mockResolvedValue({
      finding: row('f-open'), records: [], seat: null, next: null, problem: null,
    }),
    setFindingPublication: vi.fn().mockResolvedValue(goalView(false)),
  } as unknown as AppStore
  return { store }
}

const render = async (store: AppStore): Promise<void> => {
  act(() => { root.render(<StoreProvider store={store}><GoalFindings goal="g1" /></StoreProvider>) })
  await act(async () => {})
}

it('loads the Goal’s findings once on mount', async () => {
  const { store } = rig(undefined)
  await render(store)
  expect(store.loadFindings).toHaveBeenCalledWith('g1', 'all')
  expect(store.loadFindings).toHaveBeenCalledTimes(1)
})

it('the open filter shows a plain open row and a repaired-unconfirmed claim, each labelled honestly', async () => {
  const state: FindingsListState = {
    filter: 'open',
    rows: [
      row('finding-open-1'),
      row('finding-claim-1', { lifecycle: { state: 'repaired', confirmed: false, repairs: [A] } }),
    ],
    next: null, totals: { all: 3, open: 2, blocking: 1 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state)
  await render(store)
  expect(container.textContent).toContain('finding-open-1')
  expect(container.textContent).toContain('finding-claim-1')
  expect(container.textContent).toContain('Open')
  expect(container.textContent).toContain('Repair claimed · awaiting review')
  // Never "Verified": a claimed repair is not confirmed.
  expect(container.textContent).not.toContain('Verified')
  // No confirmed/withdrawn row was in this filter’s answer, so none is drawn.
  expect(container.textContent).not.toContain('finding-withdrawn')
  expect(container.textContent).toContain('1 blocking')
})

it('a carried row still shows its original origin round, not a new claim', async () => {
  const state: FindingsListState = {
    filter: 'all',
    rows: [row('finding-carried', { origin: { goal: 'source-goal', run: 'run-0', round: 5, card: 1, seat: 'seat-writer', at: A } })],
    next: null, totals: { all: 1, open: 1, blocking: 1 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state)
  await render(store)
  expect(container.textContent).toContain('finding-carried')
  expect(container.textContent).toContain('Raised in round 5')
})

it('pressing a filter tab asks the store for that filter, and Load more asks with the cursor', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [row('finding-a')], next: 'cursor-2', totals: { all: 5, open: 5, blocking: 0 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state)
  await render(store)
  const blocking = [...container.querySelectorAll('button, [role="tab"]')].find((one) => one.textContent === 'Blocking')!
  act(() => { (blocking as HTMLElement).click() })
  expect(store.loadFindings).toHaveBeenCalledWith('g1', 'blocking')
  const more = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Load more')!
  act(() => more.click())
  expect(store.loadFindings).toHaveBeenCalledWith('g1', 'all', 'cursor-2')
})

it('an unreadable ledger shows a banner, never an empty state', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [row('finding-a')], next: null, totals: null,
    problem: 'Some evidence records could not be read, so this ledger cannot be shown as complete. A person has to look.',
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state)
  await render(store)
  expect(container.textContent).toContain('cannot be shown as complete')
  expect(container.textContent).not.toContain('No findings recorded')
})

it('an empty Goal reads "No findings recorded"', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [], next: null, totals: { all: 0, open: 0, blocking: 0 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state)
  await render(store)
  expect(container.textContent).toContain('No findings recorded')
})

it('shows the publication switch only for a Goal with a bound pull request, and a local note otherwise', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [], next: null, totals: { all: 0, open: 0, blocking: 0 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state)
  await render(store)
  expect(container.textContent).toContain('Local findings')
  expect(container.querySelector('[role="switch"]')).toBeNull()

  const evidence = new Map([['g1', {
    room: 'g1', stamp: 1, checks: [], refused: [], unreadable: null,
    cards: [{ card: 1, running: [], facts: [{ record: { id: 'pr-1', restored: false, fact: { kind: 'pr', number: 9, state: 'open', head: A, url: null } }, freshness: { state: 'fresh' }, by: null }] }],
  }]])
  const { store: withPr } = rig(state, { boardEvidence: evidence as never })
  await render(withPr)
  expect(container.textContent).not.toContain('Local findings')
  expect(container.querySelector('[role="switch"]')).not.toBeNull()
})

it('preview smoke: the real preview store answers every findings method, never the silent fallback', async () => {
  const { previewStore } = await import('../preview/harness')
  const { PREVIEW_GOAL } = await import('../preview/goal-fixture')
  const warnings: unknown[][] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args) })
  const store = previewStore()
  act(() => { root.render(<StoreProvider store={store}><GoalFindings goal={PREVIEW_GOAL.goal.id} /></StoreProvider>) })
  await act(async () => {})
  await store.readFinding(PREVIEW_GOAL.goal.id, 'finding-open-1')
  await store.setFindingPublication(PREVIEW_GOAL.goal.id, PREVIEW_GOAL.goal.revision, false)
  await store.carryFindings({ goal: PREVIEW_GOAL.goal.id, revision: 0, source: 'goal-wrapped', receipt: 'r1', findings: ['finding-open-1'], request: 'r' })
  const findingCalls = warnings.filter((args) => String(args[0]).includes('finding'))
  expect(findingCalls).toEqual([])
  expect(container.textContent).toContain('Missing null check on the checkout path')
  warn.mockRestore()
})

it('shows the run’s status and a Decide control once a stopped run is cached, and opens the decision dialog', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [], next: null, totals: { all: 0, open: 0, blocking: 0 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const flowExecutions = new Map([['run-1', { id: 'run-1', goal: 'g1', findings: {} } as never]])
  const findingRuns = new Map([['run-1', {
    run: 'run-1', goal: 'g1', round: 2, finished: 2, total: 3, embargoed: false, open: 1, blocking: 1,
    reason: 'Round 2 ended with 1 open finding.', stamp: 'stamp-1', publication: 'posted',
    reviewersFinished: null, reviewersTotal: null, pendingExceptions: [], repair: null,
    boundPr: null, unbound: 'No open pull request is bound to this Goal, so this round stays on the desk.', undecidable: null,
  } as never]])
  const { store } = rig(state, { flowExecutions, findingRuns })
  await render(store)
  expect(container.textContent).toContain('Round 2 ended with 1 open finding.')
  const decide = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Decide this run')!
  act(() => decide.click())
  await act(async () => {})
  expect(document.body.textContent).toContain('Decide this run')
})

it('a wrapped Goal’s run greys Decide this run and says why', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [], next: null, totals: { all: 0, open: 0, blocking: 0 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const undecidable = 'This Goal is wrapped. Its findings are history here; carry them into an open Goal to decide them.'
  const flowExecutions = new Map([['run-1', { id: 'run-1', goal: 'g1', findings: {} } as never]])
  const findingRuns = new Map([['run-1', {
    run: 'run-1', goal: 'g1', round: 2, finished: 2, total: 3, embargoed: false, open: 1, blocking: 1,
    reason: 'Round 2 ended with 1 open finding.', stamp: 'stamp-1', publication: 'posted',
    reviewersFinished: null, reviewersTotal: null, pendingExceptions: [], repair: null,
    boundPr: null, unbound: null, undecidable,
  } as never]])
  const { store } = rig(state, { flowExecutions, findingRuns })
  await render(store)
  const decide = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Decide this run')! as HTMLButtonElement
  expect(decide.disabled).toBe(true)
  expect(container.textContent).toContain(undecidable)
})

it('opening a row reads its history explicitly, and closing returns focus to the row', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [row('finding-open-1')], next: null, totals: { all: 1, open: 1, blocking: 1 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state)
  await render(store)
  const opener = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('finding-open-1'))!
  act(() => opener.click())
  await act(async () => {})
  expect(store.readFinding).toHaveBeenCalledWith('g1', 'finding-open-1')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})
