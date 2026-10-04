import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FindingDetailPage, GoalView, SeatRecord } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { FindingDetail } from './FindingDetail'

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

const seat = (over: Partial<SeatRecord> = {}): SeatRecord => ({
  id: 'seat-1', session: { runtime: 'beta', sessionId: 'sess-1' }, board: 'g1', role: 'reviewer',
  agent: { id: 'code-reviewer', name: 'CodeReviewer-v1', origin: 'project' } as SeatRecord['agent'],
  checkout: { cwd: '/repo', project: '/repo', branch: 'fix', head: A },
  standing: { kind: 'ceiling', level: 'read' }, ceiling: null, passedOver: [], seatLabel: 'beta',
  openedAt: 1, closed: null, restored: null,
  ...over,
} as unknown as SeatRecord)

const page = (over: Partial<FindingDetailPage> = {}): FindingDetailPage => ({
  finding: {
    id: 'finding-1', origin: { goal: 'g1', run: 'run-1', round: 2, card: 1, seat: 'seat-1', at: A },
    ownerGoal: 'g1', title: 'A real problem', body: 'Body text.', category: 'ordinary', blocking: true,
    related: null, anchor: null, lifecycle: { state: 'open', confirmed: false, repairs: [] },
    sequence: 1, evidence: ['ev-1'], posted: [], restored: false, problem: null,
  },
  records: [], seat: seat(), next: null, problem: null,
  ...over,
})

const rig = (resolved: FindingDetailPage): { store: AppStore; readFinding: ReturnType<typeof vi.fn> } => {
  const readFinding = vi.fn().mockResolvedValue(resolved)
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readFinding, readSeatAttachments: vi.fn(async () => null) } as unknown as AppStore
  return { store, readFinding }
}

const render = async (store: AppStore): Promise<void> => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <FindingDetail goal="g1" finding="finding-1" onClose={() => {}} />
      </StoreProvider>,
    )
  })
  await act(async () => {})
}

it('reads the exact history a Goal’s wire read answers, not a live lookup', async () => {
  const { store, readFinding } = rig(page())
  await render(store)
  expect(readFinding).toHaveBeenCalledWith('g1', 'finding-1')
  expect(document.body.textContent).toContain('A real problem')
})

it('a historical Seat’s own identity is shown even though a later session moved on', async () => {
  const { store } = rig(page({ seat: seat({ agent: { id: 'code-reviewer', name: 'CodeReviewer-v1', origin: 'project' } as SeatRecord['agent'] }) }))
  await render(store)
  expect(document.body.textContent).toContain('CodeReviewer-v1')
})

it('a missing Seat says so, and never substitutes a current name', async () => {
  const { store } = rig(page({ seat: null }))
  await render(store)
  expect(document.body.textContent).toContain('This Seat is unavailable.')
})

it('names each later part of the history as one of the dialog’s own groups', async () => {
  const { store } = rig(page({ seat: null }))
  await render(store)
  const groups = [...document.querySelectorAll('[role="dialog"] [data-slot="fieldset"][role="group"]')].map(
    (group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent,
  )
  // Nothing after the raise yet, so there is no later history to name.
  expect(groups).toEqual(['Where it was posted', 'Raised by'])
  expect(document.body.textContent).toContain('Not published yet')

  // A later page of events is a history, even before it is read.
  act(() => root.unmount())
  root = createRoot(container)
  await render(rig(page({ seat: null, next: 'cursor-2' })).store)
  const named = [...document.querySelectorAll('[role="dialog"] [data-slot="fieldset"][role="group"]')].map(
    (group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent,
  )
  expect(named).toEqual(['History', 'Where it was posted', 'Raised by'])
  expect(document.body.textContent).toContain('Show more history')
})

it('a script-bearing body and an unsafe link are never executed or opened', async () => {
  const malicious = page({
    finding: {
      ...page().finding,
      body: 'See this: <script>window.__pwned = true</script><img src=x onerror="window.__pwned2 = true">',
    },
  })
  const { store } = rig({
    ...malicious,
    finding: { ...malicious.finding, posted: [{ repo: 'org/repo', pr: 1, comment: 1, kind: 'issue-comment', url: 'javascript:alert(1)', operation: 'op-1' }] },
  })
  const opened: string[] = []
  vi.spyOn(await import('../lib/desktop'), 'openExternal').mockImplementation((url: string) => { opened.push(url) })
  await render(store)
  expect(document.querySelector('script')).toBeNull()
  expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined()
  expect((globalThis as { __pwned2?: boolean }).__pwned2).toBeUndefined()
  // The unsafe posting address stays text; nothing offers to open it.
  expect(document.body.textContent).toContain('its address could not be verified')
  const buttons = [...document.querySelectorAll('button')].map((one) => one.textContent)
  expect(buttons.some((text) => text?.includes('PR comment'))).toBe(false)
  expect(opened).toEqual([])
})

it('an unreadable history says so without pretending the ledger is complete', async () => {
  const { store } = rig(page({ problem: 'Some evidence records could not be read, so this history cannot be shown as complete. A person has to look.' }))
  await render(store)
  expect(document.body.textContent).toContain('cannot be shown as complete')
})

// ------------------------------------------------------------ a person decides

const STAMP = 'c'.repeat(64)
const runView = (over: Record<string, unknown> = {}) => ({
  run: 'run-1', goal: 'g1', round: 4, finished: 3, total: 5, embargoed: false, open: 1, blocking: 1,
  reason: null, stamp: STAMP, publication: 'posted', rounds: [], reviewersFinished: null, reviewersTotal: null,
  pendingExceptions: [], repair: null, boundPr: null, unbound: null, undecidable: null, ...over,
}) as never

const renderDeciding = async (store: AppStore, decide: unknown): Promise<void> => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <FindingDetail goal="g1" finding="finding-1" onClose={() => {}} decide={decide as never} />
      </StoreProvider>,
    )
  })
  await act(async () => {})
}

const clickNamed = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')].find((one) => one.textContent === label)! as HTMLButtonElement

const typeReason = (text: string): void => {
  const textarea = document.querySelector('textarea[aria-label="Why"]') as HTMLTextAreaElement
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('a person decides a claimed repair with a reason, against the run view they read', async () => {
  const repaired = page({ finding: { ...page().finding, lifecycle: { state: 'repaired', confirmed: false, repairs: [] } } })
  const { store } = rig(repaired)
  const decideFindingRun = vi.fn(async () => runView())
  Object.assign(store, { decideFindingRun })
  await renderDeciding(store, runView())
  expect(clickNamed('Accept the repair')).toBeTruthy()
  expect(clickNamed('Reject the repair')).toBeTruthy()
  await act(async () => { clickNamed('Accept the repair').click() })
  expect(decideFindingRun).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Say why.')
  typeReason('checked the change myself')
  await act(async () => { clickNamed('Accept the repair').click() })
  expect(decideFindingRun).toHaveBeenCalledWith({
    goal: 'g1', run: 'run-1', round: 4, stamp: STAMP,
    action: { kind: 'adjudicate', finding: 'finding-1', state: 'repaired' }, reason: 'checked the change myself',
  })
})

it('a reason typed into Why reaches Withdraw it without the empty-reason warning (#1089)', async () => {
  const { store } = rig(page())
  const decideFindingRun = vi.fn(async () => runView())
  Object.assign(store, { decideFindingRun })
  await renderDeciding(store, runView())

  typeReason('not relevant any more')
  await act(async () => { clickNamed('Withdraw it').click() })

  expect(document.body.textContent).not.toContain('Say why.')
  expect(decideFindingRun).toHaveBeenCalledWith({
    goal: 'g1', run: 'run-1', round: 4, stamp: STAMP,
    action: { kind: 'adjudicate', finding: 'finding-1', state: 'withdrawn' }, reason: 'not relevant any more',
  })
})

it('an open finding can only be withdrawn by a person; a repair is never accepted before one is claimed', async () => {
  const { store } = rig(page())
  Object.assign(store, { decideFindingRun: vi.fn(async () => runView()) })
  await renderDeciding(store, runView())
  expect(clickNamed('Withdraw it')).toBeTruthy()
  expect(clickNamed('Accept the repair')).toBeUndefined()
})

it('a finding of another run, or a Goal no longer open, keeps the decision greyed with its reason', async () => {
  const { store } = rig(page())
  Object.assign(store, { decideFindingRun: vi.fn(async () => runView()) })
  await renderDeciding(store, runView({ run: 'run-2' }))
  expect(clickNamed('Withdraw it').disabled).toBe(true)
  expect(document.body.textContent).toContain('This finding belongs to an earlier run on this Goal.')
  await renderDeciding(store, runView({ undecidable: 'This Goal is wrapped. Its findings are history here; carry them into an open Goal to decide them.' }))
  expect(clickNamed('Withdraw it').disabled).toBe(true)
  expect(document.body.textContent).toContain('This Goal is wrapped.')
})

/**
 * A Run that ends wraps its Team, even under a person who is deciding one of
 * its findings. The run view the form holds still says the run is open, so
 * only the Team itself can say a verdict is no longer takable (#1317, round 1).
 */
const wrapsLater = (store: AppStore, goal: string): (() => void) => {
  let snapshot = store.getSnapshot()
  const listeners = new Set<() => void>()
  Object.assign(store, {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
  })
  return () => {
    snapshot = { ...snapshot, goals: new Map([[goal, { goal: { state: 'wrapped' } } as unknown as GoalView]]) }
    act(() => listeners.forEach((listener) => listener()))
  }
}

it('a verdict form already open stops taking a verdict when the Team wraps, though the run it read still looks open', async () => {
  const repaired = page({ finding: { ...page().finding, lifecycle: { state: 'repaired', confirmed: false, repairs: [] } } })
  const { store } = rig(repaired)
  const decideFindingRun = vi.fn(async () => runView())
  Object.assign(store, { decideFindingRun })
  const wrap = wrapsLater(store, 'g1')
  await renderDeciding(store, runView())
  typeReason('checked the change myself')
  const choices = (): HTMLButtonElement[] => ['Accept the repair', 'Reject the repair', 'Withdraw it'].map(clickNamed)
  expect(choices().every((one) => !one.disabled)).toBe(true)
  expect(document.body.textContent).not.toContain('This Team is wrapped')

  wrap()

  expect(choices().every((one) => one.disabled)).toBe(true)
  expect(choices().every((one) => one.title === 'This Team is wrapped')).toBe(true)
  expect(document.body.textContent).toContain('This Team is wrapped')
  expect((document.querySelector('textarea[aria-label="Why"]') as HTMLTextAreaElement).disabled).toBe(true)
  for (const one of choices()) await act(async () => { one.click() })
  expect(decideFindingRun).not.toHaveBeenCalled()
})

it('regression guard: a reason typed survives PersonVerdict remounting if `decide` is ever absent and back (#1089, #1090)', async () => {
  // #1090's review found that the real store never actually drops an
  // already-loaded `decide` (`flowExecutions`/`findingRuns` are only ever
  // added to, and a live push keeps a Goal's cached run views in place while
  // it refetches) — see `GoalFindings.real-store.test.tsx` for the real path,
  // which passes even on main. This test is not a reproduction of #1089's
  // reported bug; it pins the defensive fix (the reason lifted to
  // `FindingDetail`, which does not remount here) against `PersonVerdict`
  // ever being asked to remount for a cause this suite does not know about.
  const { store } = rig(page())
  const decideFindingRun = vi.fn(async () => runView())
  Object.assign(store, { decideFindingRun })
  await renderDeciding(store, runView())
  expect(document.body.textContent).toContain('Decide it yourself')

  typeReason('checked the fix myself')
  expect((document.querySelector('textarea[aria-label="Why"]') as HTMLTextAreaElement).value).toBe('checked the fix myself')

  // The run view blinks out of the snapshot for one render, then comes back —
  // same run, a fresh object, the shape `#findingsRefresh` produces.
  await renderDeciding(store, undefined)
  expect(document.body.textContent).not.toContain('Decide it yourself')
  await renderDeciding(store, runView())
  expect(document.body.textContent).toContain('Decide it yourself')

  const why = document.querySelector('textarea[aria-label="Why"]') as HTMLTextAreaElement
  expect(why.value).toBe('checked the fix myself')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()

  await act(async () => { clickNamed('Withdraw it').click() })
  expect(document.body.textContent).not.toContain('Say why.')
  expect(decideFindingRun).toHaveBeenCalledWith({
    goal: 'g1', run: 'run-1', round: 4, stamp: STAMP,
    action: { kind: 'adjudicate', finding: 'finding-1', state: 'withdrawn' }, reason: 'checked the fix myself',
  })
})

it('an empty reason is refused plainly, whether or not a decision has ever been attempted', async () => {
  const { store } = rig(page())
  const decideFindingRun = vi.fn(async () => runView())
  Object.assign(store, { decideFindingRun })
  await renderDeciding(store, runView())
  await act(async () => { clickNamed('Withdraw it').click() })
  expect(document.body.textContent).toContain('Say why.')
  expect(decideFindingRun).not.toHaveBeenCalled()
})

it('a resolved finding offers no decision at all', async () => {
  const done = page({ finding: { ...page().finding, lifecycle: { state: 'withdrawn', confirmed: true, repairs: [] } } })
  const { store } = rig(done)
  await renderDeciding(store, runView())
  expect(document.body.textContent).not.toContain('Decide it yourself')
})

it('shows why a losing attempt stays open without gating the picked attempt', async () => {
  const base = page()
  const reason = 'The review selected revision bbbbbbbbbbbb for the next step.'
  const { store } = rig(page({ finding: { ...base.finding, activeBlocking: false, inactiveReason: reason } }))
  await render(store)
  expect(document.body.textContent).toContain('Not kept')
  expect(document.body.textContent).toContain(reason)
})
