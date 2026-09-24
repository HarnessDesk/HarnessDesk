import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FindingDetailPage, SeatRecord } from '@harnessdesk/protocol'

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
  reason: null, stamp: STAMP, publication: 'posted', reviewersFinished: null, reviewersTotal: null,
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

it('a resolved finding offers no decision at all', async () => {
  const done = page({ finding: { ...page().finding, lifecycle: { state: 'withdrawn', confirmed: true, repairs: [] } } })
  const { store } = rig(done)
  await renderDeciding(store, runView())
  expect(document.body.textContent).not.toContain('Decide it yourself')
})
