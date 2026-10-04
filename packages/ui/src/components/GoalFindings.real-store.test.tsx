import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type {
  FindingDetailPage, FindingPage, FindingRunView, GoalView, HostMethodName, HostParams, SeatRecord, WireNotification,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { GoalFindings } from './GoalFindings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * #1090 review: the earlier reproduction of #1089 hand-flipped `decide` and
 * emptied `flowExecutions` directly — states the real store never produces,
 * since `flowExecutions` and `findingRuns` are only ever added to, and
 * `#findingsRefresh` keeps a Goal's cached rows and run views in place while
 * it refetches. This file goes through the real `AppStore` and real DOM
 * events instead, to settle what actually happens on the genuine path: a
 * person types a reason with the browser's own input event (which is how
 * React's controlled `Textarea` learns of it — not a hand-set `.value`), a
 * live `finding/changed` push arrives mid-edit, and the person then submits.
 */

/**
 * A ceiling sized for a starved machine, not a delay. Every wait below ends on
 * the thing it waits for, so a passing run never reaches it (#1303, as #1289).
 *
 * A push reaches the screen through two timers: the store's coalesced refresh,
 * then its coalesced wake of every subscriber (a frame, or 32ms, each). A fixed
 * sleep guessed how long that takes, and lost the guess on a loaded machine.
 */
const LOADED_MACHINE_MS = 10_000
/** A test with several such waits gets room for all of them, so a wait's own message fires before the runner's. */
const TEST_MS = 4 * LOADED_MACHINE_MS
/** A window that proves nothing happens: it can miss a late reload, but cannot fail because the machine is slow. */
const QUIET_MS = 80

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
const STAMP = 'c'.repeat(64)

const goalView = (): GoalView => ({
  goal: {
    id: 'g1', root: '/repo', cwd: '/repo', sentence: 'Ship it', state: 'open', revision: 1,
    checkout: 'shared', dependsOn: [], origin: { kind: 'person' }, createdAt: 1, updatedAt: 1, receipt: null,
  },
  activity: 'working', waitingOn: [], members: [],
  board: { id: 'g1', name: 'Ship it', root: '/repo', updatedAt: 1, members: [], messaging: true, intents: [], channel: [] },
  receipt: null, problem: null,
})

const seat = (): SeatRecord => ({
  id: 'seat-1', session: { runtime: 'beta', sessionId: 'sess-1' }, board: 'g1', role: 'reviewer',
  agent: { id: 'code-reviewer', name: 'CodeReviewer-v1', origin: 'project' } as SeatRecord['agent'],
  checkout: { cwd: '/repo', project: '/repo', branch: 'fix', head: A },
  standing: { kind: 'ceiling', level: 'read' }, ceiling: null, passedOver: [], seatLabel: 'beta',
  openedAt: 1, closed: null, restored: null,
} as unknown as SeatRecord)

const findingsPage = (): FindingPage => ({
  goal: 'g1', stamp: 'stamp-1',
  rows: [{
    id: 'finding-1', origin: { goal: 'g1', run: 'run-1', round: 2, card: 1, seat: 'seat-1', at: A },
    ownerGoal: 'g1', title: 'A real problem', body: 'Body text.', category: 'ordinary', blocking: true,
    related: null, anchor: null, lifecycle: { state: 'open', confirmed: false, repairs: [] },
    sequence: 1, evidence: ['ev-1'], posted: [], restored: false, problem: null,
  }],
  next: null, totals: { all: 1, open: 1, blocking: 1 }, problem: null,
})

const detailPage = (): FindingDetailPage => ({
  finding: findingsPage().rows[0]!, records: [], seat: seat(), next: null, problem: null,
})

const runView = (over: Partial<FindingRunView> = {}): FindingRunView => ({
  run: 'run-1', goal: 'g1', round: 4, finished: 3, total: 5, embargoed: false, open: 1, blocking: 1,
  reason: null, stamp: STAMP, publication: 'posted', rounds: [], reviewersFinished: null, reviewersTotal: null,
  pendingExceptions: [], repair: null, boundPr: null, unbound: null, undecidable: null,
  ...over,
} as unknown as FindingRunView)

const notify = (store: AppStore, notification: WireNotification): void => {
  const transport = store.transport as unknown as { handlers: { onNotification(notification: WireNotification): void } }
  transport.handlers.onNotification(notification)
}

/** Sets a textarea's value the way a browser does — through the element's own native setter, so React's controlled `onChange` actually fires (a hand-set `.value` with no such event would not). */
const typeInto = (textarea: HTMLTextAreaElement, text: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}


/**
 * Waits until `look` stops throwing, and hands back what it returned.
 *
 * What is waited for arrives from timers the test does not drive, so there is
 * nothing for `act` to flush: it would hold React's own work back until its
 * scope closed, and the wait would watch a screen that cannot change. While it
 * waits, React is told it is not under `act`, as Testing Library's `waitFor`
 * does, so an update that arrives on its own is rendered rather than warned of.
 */
const eventually = async <T,>(look: () => T): Promise<T> => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  environment.IS_REACT_ACT_ENVIRONMENT = false
  try {
    return await vi.waitFor(look, { timeout: LOADED_MACHINE_MS, interval: 10 })
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = true
  }
}

/** The first button on screen that says `words`, as soon as there is one. */
const buttonSaying = (words: string): Promise<HTMLButtonElement> =>
  eventually(() => {
    const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes(words))
    expect(found, `a button saying “${words}”`).toBeDefined()
    return found!
  })

/** The reason box of the finding dialog, as soon as the dialog has read its finding. */
const reasonBox = (): Promise<HTMLTextAreaElement> =>
  eventually(() => {
    const found = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea[aria-label="Why"]')
    expect(found, 'the finding dialog, with its reason box').not.toBeNull()
    return found!
  })

it('refreshes the round budget and blind reviewer counts from a flow execution push', { timeout: TEST_MS }, async () => {
  const store = new AppStore('ws://localhost:0/')
  let current = runView({ round: 5, finished: 5, total: 5, embargoed: true, reviewersFinished: 1, reviewersTotal: 2 })
  let lists = 0
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    switch (method) {
      case 'finding/list': lists += 1; return findingsPage()
      case 'finding/run': return current
      default: throw new Error(`unexpected ${method}`)
    }
  }) as never)

  notify(store, { method: 'goal/changed', params: { view: goalView() } })
  notify(store, { method: 'flow/execution-changed', params: { execution: { id: 'run-1', goal: 'g1', findings: {} } as never } })
  act(() => {
    root.render(<StoreProvider store={store}><GoalFindings goal="g1" /></StoreProvider>)
  })
  await eventually(() => {
    expect(container.textContent).toContain('Round5 of 5')
    expect(container.textContent).toContain('1 of 2 reviewers finished')
  })

  current = runView({ round: 7, finished: 7, total: 8, embargoed: true, reviewersFinished: 2, reviewersTotal: 3 })
  const listsBefore = lists
  notify(store, { method: 'flow/execution-changed', params: { execution: { id: 'run-1', goal: 'g1', findings: { extraRound: { after: 5, reason: 'make room', count: 3 } } } as never } })
  await eventually(() => {
    expect(container.textContent).toContain('Round7 of 8')
    expect(container.textContent).toContain('2 of 3 reviewers finished')
  })
  // The run views only: a push that moves a run must not reload the list, or
  // a person paging through findings is sent back to the first page (#1091).
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, QUIET_MS)) })
  expect(lists).toBe(listsBefore)
})

it('a reason typed on the real store path reaches finding/decide, and a live push mid-edit does not lose it (#1089, #1090)', { timeout: TEST_MS }, async () => {
  const store = new AppStore('ws://localhost:0/')
  const requests: { method: HostMethodName; params: unknown }[] = []
  const decideParams: HostParams<'finding/decide'>[] = []
  // What the reload brings back: a second finding, which is how it shows on screen that it has landed.
  const grown: FindingPage = {
    ...findingsPage(),
    rows: [findingsPage().rows[0]!, { ...findingsPage().rows[0]!, id: 'finding-2', title: 'A second problem', sequence: 2 }],
    totals: { all: 2, open: 2, blocking: 2 },
  }
  let lists = 0
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    requests.push({ method, params })
    switch (method) {
      case 'finding/list': lists += 1; return lists === 1 ? findingsPage() : grown
      case 'finding/read': return detailPage()
      case 'finding/run': return runView()
      case 'finding/decide':
        decideParams.push(params as HostParams<'finding/decide'>)
        return runView()
      default: throw new Error(`unexpected ${method}`)
    }
  }) as never)

  notify(store, { method: 'goal/changed', params: { view: goalView() } })
  notify(store, { method: 'flow/execution-changed', params: { execution: { id: 'run-1', goal: 'g1', findings: {} } as never } })

  act(() => {
    root.render(<StoreProvider store={store}><GoalFindings goal="g1" /></StoreProvider>)
  })
  const opener = await buttonSaying('finding-1')
  act(() => opener.click())

  const why = await reasonBox()
  expect(document.querySelector<HTMLElement>('[role="dialog"]')!.textContent).toContain('Decide it yourself')
  typeInto(why, 'checked the fix myself')
  expect(why.value).toBe('checked the fix myself')

  // A real live push, mid-edit: the ledger changed (round 15's own verdicts,
  // say), coalesced into one real reload through the real store. It has landed
  // once the finding it brought is on the list behind the dialog.
  notify(store, { method: 'finding/changed', params: { goal: 'g1', revision: 2 } })
  await eventually(() => expect(container.textContent).toContain('finding-2'))

  const stillOpen = document.querySelector<HTMLElement>('[role="dialog"]')
  expect(stillOpen).not.toBeNull()
  const whyAfter = stillOpen!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Why"]')!
  expect(whyAfter.value).toBe('checked the fix myself')

  const withdraw = [...stillOpen!.querySelectorAll('button')].find((one) => one.textContent === 'Withdraw it')!
  await act(async () => { withdraw.click() })

  expect(stillOpen!.textContent).not.toContain('Say why.')
  expect(decideParams).toHaveLength(1)
  expect(decideParams[0]).toMatchObject({
    goal: 'g1', run: 'run-1', action: { kind: 'adjudicate', finding: 'finding-1', state: 'withdrawn' },
    reason: 'checked the fix myself',
  })
})

it('a page-two finding keeps its origin run when finding/changed reloads page one (#1091)', { timeout: TEST_MS }, async () => {
  const firstRow = findingsPage().rows[0]!
  const secondRow = {
    ...firstRow,
    id: 'finding-2',
    origin: { ...firstRow.origin, run: 'run-old', round: 1, card: 2 },
    title: 'A later-page problem',
  }
  const firstPage: FindingPage = { ...findingsPage(), rows: [firstRow], next: 'cursor-2', totals: { all: 2, open: 2, blocking: 2 } }
  const secondPage: FindingPage = { ...firstPage, rows: [secondRow], next: null }
  const refreshedPage: FindingPage = firstPage
  const oldRun: FindingRunView = { ...runView(), run: 'run-old', round: 1, stamp: 'stamp-old' }
  const newRun: FindingRunView = runView()
  const store = new AppStore('ws://localhost:0/')
  const decideParams: HostParams<'finding/decide'>[] = []
  let firstList = true
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    switch (method) {
      case 'finding/list': {
        const input = params as HostParams<'finding/list'>
        if (input.cursor !== undefined) return secondPage
        const page = firstList ? firstPage : refreshedPage
        firstList = false
        return page
      }
      case 'finding/read':
        return { finding: secondRow, records: [], seat: null, next: null, problem: null }
      case 'finding/run':
        return (params as HostParams<'finding/run'>).run === 'run-old' ? oldRun : newRun
      case 'finding/decide':
        decideParams.push(params as HostParams<'finding/decide'>)
        return oldRun
      default: throw new Error(`unexpected ${method}`)
    }
  }) as never)

  notify(store, { method: 'goal/changed', params: { view: goalView() } })
  notify(store, { method: 'flow/execution-changed', params: { execution: { id: 'run-old', goal: 'g1', state: 'stopped', findings: {} } as never } })
  notify(store, { method: 'flow/execution-changed', params: { execution: { id: 'run-1', goal: 'g1', state: 'running', findings: {} } as never } })

  act(() => {
    root.render(<StoreProvider store={store}><GoalFindings goal="g1" /></StoreProvider>)
  })
  const more = await buttonSaying('Load more')
  act(() => more.click())
  const opener = await buttonSaying(secondRow.id)
  act(() => opener.click())

  const why = await reasonBox()
  typeInto(why, 'checked the fix myself')
  // The reload of page one has landed once "Load more" is back: page two had
  // used it up, and the fresh first page brings its cursor again.
  notify(store, { method: 'finding/changed', params: { goal: 'g1', revision: 2 } })
  await buttonSaying('Load more')

  const stillOpen = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(stillOpen).not.toBeNull()
  expect((stillOpen.querySelector('textarea[aria-label="Why"]') as HTMLTextAreaElement).value).toBe('checked the fix myself')
  await act(async () => { [...stillOpen.querySelectorAll('button')].find((one) => one.textContent === 'Withdraw it')!.click() })

  expect(stillOpen.textContent).not.toContain('Say why.')
  expect(decideParams).toHaveLength(1)
  expect(decideParams[0]).toMatchObject({
    goal: 'g1', run: 'run-old', action: { kind: 'adjudicate', finding: secondRow.id, state: 'withdrawn' },
    reason: 'checked the fix myself',
  })
})
