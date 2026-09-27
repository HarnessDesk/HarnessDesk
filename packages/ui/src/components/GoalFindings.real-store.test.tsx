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

const runView = (): FindingRunView => ({
  run: 'run-1', goal: 'g1', round: 4, finished: 3, total: 5, embargoed: false, open: 1, blocking: 1,
  reason: null, stamp: STAMP, publication: 'posted', reviewersFinished: null, reviewersTotal: null,
  pendingExceptions: [], repair: null, boundPr: null, unbound: null, undecidable: null,
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

it('a reason typed on the real store path reaches finding/decide, and a live push mid-edit does not lose it (#1089, #1090)', async () => {
  const store = new AppStore('ws://localhost:0/')
  const requests: { method: HostMethodName; params: unknown }[] = []
  const decideParams: HostParams<'finding/decide'>[] = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    requests.push({ method, params })
    switch (method) {
      case 'finding/list': return findingsPage()
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
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

  const opener = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('finding-1'))!
  act(() => opener.click())
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.textContent).toContain('Decide it yourself')
  const why = dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Why"]')!
  typeInto(why, 'checked the fix myself')
  expect(why.value).toBe('checked the fix myself')

  // A real live push, mid-edit: the ledger changed (round 15's own verdicts,
  // say), coalesced into one real reload through the real store.
  notify(store, { method: 'finding/changed', params: { goal: 'g1', revision: 2 } })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })

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
