import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FindingView, GoalView } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import type { FindingsListState } from '../lib/findings'
import stylesSettings from '../design/patterns/Settings.module.css'
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
    readFindingPublications: vi.fn().mockResolvedValue({ goal: 'g1', run: 'run-1', items: [], backfill: null, backfillRefusal: null }),
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

  // A plain "Open" finding is the normal, default state — never the amber a
  // person must act on now. A claimed repair genuinely is one.
  const chips = [...container.querySelectorAll('[data-slot="chip"]')]
  const openChip = chips.find((one) => one.textContent === 'Open')
  const claimChip = chips.find((one) => one.textContent === 'Repair claimed · awaiting review')
  expect(openChip?.getAttribute('data-tone')).toBe('neutral')
  expect(claimChip?.getAttribute('data-tone')).toBe('warning')
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

it('a carried finding not yet admitted on its target agrees with the header: Advisory, never Blocking, when the header counts it out', async () => {
  const state: FindingsListState = {
    filter: 'all',
    rows: [row('finding-carried', {
      origin: { goal: 'source-goal', run: 'run-0', round: 5, card: 1, seat: 'seat-writer', at: A },
      blocking: true, activeBlocking: false,
    })],
    next: null, totals: { all: 1, open: 1, blocking: 0 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state)
  await render(store)
  expect(container.textContent).toContain('0 blocking of 1')
  expect(container.textContent).toContain('Advisory')
  expect(container.textContent).not.toContain('· Blocking')
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

it('a dropped run\'s refreshed view greys Decide this run with the drop\'s own reason, and drops the stale ceiling banner', async () => {
  // The exact shape the server answers once a run has been decided (drop): the stale round-ceiling
  // `reason` is gone, and `undecidable` now carries the run's own concluded reason instead.
  const state: FindingsListState = {
    filter: 'all', rows: [], next: null, totals: { all: 1, open: 1, blocking: 1 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const undecidable = 'Design problem; parking this Goal.'
  const flowExecutions = new Map([['run-1', { id: 'run-1', goal: 'g1', findings: {} } as never]])
  const findingRuns = new Map([['run-1', {
    run: 'run-1', goal: 'g1', round: 2, finished: 2, total: 3, embargoed: false, open: 1, blocking: 1,
    reason: null, stamp: 'stamp-2', publication: 'local',
    reviewersFinished: null, reviewersTotal: null, pendingExceptions: [], repair: null,
    boundPr: null, unbound: null, undecidable, override: null,
  } as never]])
  const { store } = rig(state, { flowExecutions, findingRuns })
  await render(store)
  expect(container.textContent).not.toContain('Waiting for a person')
  const decide = [...container.querySelectorAll('button')].find((one) => one.textContent === 'Decide this run')! as HTMLButtonElement
  expect(decide.disabled).toBe(true)
  expect(container.textContent).toContain(undecidable)
})

const runView = (run: string, reason: string, undecidable: string | null = null) => ({
  run, goal: 'g1', round: 1, finished: 1, total: 1, embargoed: false, open: 1, blocking: 1,
  reason, stamp: `stamp-${run}`, publication: 'local',
  reviewersFinished: null, reviewersTotal: null, pendingExceptions: [], repair: null,
  boundPr: null, unbound: null, undecidable, override: null,
}) as never

it('a Goal with an old dropped run and a live one shows the live run, not the first it finds (#890)', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [], next: null, totals: { all: 0, open: 0, blocking: 0 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  // The dropped run is cached first, as it would be: this window heard of it before the new one started.
  const flowExecutions = new Map([
    ['run-old', { id: 'run-old', goal: 'g1', state: 'stopped', findings: {} } as never],
    ['run-new', { id: 'run-new', goal: 'g1', state: 'running', findings: {} } as never],
  ])
  const findingRuns = new Map([
    ['run-old', runView('run-old', 'The old round.', 'Dropped: parking this.')],
    ['run-new', runView('run-new', 'The live round.')],
  ])
  const { store } = rig(state, { flowExecutions, findingRuns })
  await render(store)
  expect(container.textContent).toContain('The live round.')
  expect(container.textContent).not.toContain('Dropped: parking this.')
  expect(store.loadFindingRun).toHaveBeenCalledWith('g1', 'run-new')
  expect(store.loadFindingRun).not.toHaveBeenCalledWith('g1', 'run-old')
})

it('the run reserved on the Goal wins over any other cached run, as the room header reads it (#890)', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [], next: null, totals: { all: 0, open: 0, blocking: 0 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const flowExecutions = new Map([
    ['run-old', { id: 'run-old', goal: 'g1', state: 'stopped', findings: {} } as never],
    ['run-reserved', { id: 'run-reserved', goal: 'g1', state: 'stopped', findings: {} } as never],
  ])
  const findingRuns = new Map([
    ['run-old', runView('run-old', 'The old round.')],
    ['run-reserved', runView('run-reserved', 'The reserved round.')],
  ])
  const goals = new Map([['g1', { ...goalView(true), reservation: { run: 'run-reserved' } }]])
  const { store } = rig(state, { flowExecutions, findingRuns, goals })
  await render(store)
  expect(container.textContent).toContain('The reserved round.')
  expect(container.textContent).not.toContain('The old round.')
})

it('keeps a long lifecycle chip off the row\'s fixed icon mark, on the label\'s own line instead', async () => {
  const state: FindingsListState = {
    filter: 'all',
    rows: [row('finding-claim-1', { lifecycle: { state: 'repaired', confirmed: false, repairs: [A] } })],
    next: null, totals: { all: 1, open: 0, blocking: 1 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state)
  await render(store)
  const rows = [...container.getElementsByClassName(stylesSettings.row!)]
  const target = rows.find((one) => one.textContent?.includes('finding-claim-1'))!
  // The chip renders somewhere on the row...
  const chip = target.querySelector('[data-slot="chip-words"]')
  expect(chip?.textContent).toBe('Repair claimed · awaiting review')
  // ...but never inside the row's fixed 34×34 icon tile, which a multi-word
  // state sentence overflows and overlaps the finding's own name with.
  const mark = target.getElementsByClassName(stylesSettings.rowMark!)[0] ?? null
  expect(mark === null || mark.querySelector('[data-slot="chip-words"]') === null).toBe(true)
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

/* #890's remainder: earlier runs are history a person can switch to, and a dropped run's open findings stay decidable. */
const twoRuns = () => ({
  flowExecutions: new Map([
    ['run-old', { id: 'run-old', goal: 'g1', state: 'stopped', findings: {} } as never],
    ['run-new', { id: 'run-new', goal: 'g1', state: 'running', findings: {} } as never],
  ]),
  findingRuns: new Map([
    ['run-old', runView('run-old', 'The old round.', 'Dropped: parking this.')],
    ['run-new', runView('run-new', 'The live round.')],
  ]),
})

const choose = (select: HTMLSelectElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('earlier runs are history a person can switch to; the live run is the default (#890)', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [], next: null, totals: { all: 0, open: 0, blocking: 0 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state, twoRuns())
  await render(store)
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Run"]')!
  expect(select).not.toBeNull()
  expect([...select.options].map((one) => one.textContent)).toEqual(['Run 1 of 2 · stopped', 'Run 2 of 2 · going on'])
  expect(select.value).toBe('run-new')
  expect(container.textContent).toContain('The live round.')
  choose(select, 'run-old')
  await act(async () => {})
  expect(store.loadFindingRun).toHaveBeenCalledWith('g1', 'run-old')
  expect(container.textContent).toContain('The old round.')
  expect(container.textContent).toContain('Dropped: parking this.')
})

it('a Goal with one run offers no run to switch to', async () => {
  const state: FindingsListState = {
    filter: 'all', rows: [], next: null, totals: { all: 0, open: 0, blocking: 0 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { flowExecutions, findingRuns } = twoRuns()
  flowExecutions.delete('run-old')
  const { store } = rig(state, { flowExecutions, findingRuns })
  await render(store)
  expect(container.querySelector('select[aria-label="Run"]')).toBeNull()
})

it('a dropped run’s open finding says where it came from, and is decided against its own run (#890)', async () => {
  const old = row('finding-old', { origin: { goal: 'g1', run: 'run-old', round: 1, card: 2, seat: 'seat-writer', at: A } })
  const state: FindingsListState = {
    filter: 'all', rows: [old], next: null, totals: { all: 1, open: 1, blocking: 1 }, problem: null,
    loading: false, loadingMore: false, error: null, stale: false,
  }
  const { store } = rig(state, twoRuns())
  const decideFindingRun = vi.fn().mockResolvedValue(undefined)
  Object.assign(store, {
    readFinding: vi.fn().mockResolvedValue({ finding: old, records: [], seat: null, next: null, problem: null }),
    decideFindingRun,
  })
  await render(store)
  expect(container.textContent).toContain('1 open finding here was raised by an earlier run of this Goal')
  const opener = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('finding-old'))!
  act(() => opener.click())
  await act(async () => {})
  expect(store.loadFindingRun).toHaveBeenCalledWith('g1', 'run-old')
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.textContent).toContain('Decide it yourself')
  expect(dialog.textContent).not.toContain('belongs to an earlier run')
  const why = dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Why"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(why, 'Not relevant any more.')
    why.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const withdraw = [...dialog.querySelectorAll('button')].find((one) => one.textContent === 'Withdraw it')!
  expect(withdraw.disabled).toBe(false)
  act(() => withdraw.click())
  await act(async () => {})
  expect(decideFindingRun).toHaveBeenCalledWith(expect.objectContaining({
    goal: 'g1', run: 'run-old', stamp: 'stamp-run-old', action: { kind: 'adjudicate', finding: 'finding-old', state: 'withdrawn' },
  }))
})
