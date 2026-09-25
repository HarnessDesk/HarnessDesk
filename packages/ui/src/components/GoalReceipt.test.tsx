import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GoalReceipt as Receipt } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import stylesSettings from '../design/patterns/Settings.module.css'
import { GoalReceipt } from './GoalReceipt'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement; let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

it('keeps partial answers, retained lanes and gaps explicit while escaping hostile text', () => {
  const receipt = {
    version: 1, id: 'r1', goal: 'g1', sentence: 'Ship', wrappedAt: 4, summary: '<img src=x onerror=alert(1)>',
    cards: [{ id: 1, resolution: 'dropped', reason: 'Out of scope' }], seats: ['seat-1'], evidence: ['fact-1'],
    answers: [{ seat: 'seat-1', session: { runtime: 'codex', sessionId: 's1' }, turn: 't1', text: '<script>bad()</script>', partial: true, stopReason: 'cancelled' }],
    lanes: [{ lane: 'l1', cwd: '/repo/lane', dirty: true, retained: true }], revisions: [{ cwd: '/repo', head: null, dirty: null }], citations: [], gaps: ['Spend was not recorded.'],
  } as unknown as Receipt
  act(() => root.render(<GoalReceipt receipt={receipt} root="/repo" />))
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('script')).toBeNull()
  expect(container.textContent).toContain('<script>bad()</script>')
  expect(container.textContent).toContain('Partial · cancelled')
  expect(container.textContent).toContain('Dirty checkout retained')
  expect(container.textContent).toContain('Spend was not recorded.')
  expect(container.textContent).toContain('As recorded when wrapped')
  expect(container.querySelector('input, select, textarea')).toBeNull()
})

const baseReceipt = {
  version: 1, id: 'r1', goal: 'g1', sentence: 'Ship', wrappedAt: 4, summary: 'Finished.',
  cards: [], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
} as unknown as Receipt

it('a trigger Goal’s receipt keeps its origin and exact stop reason; an ordinary receipt names neither', () => {
  const receipt = {
    ...baseReceipt,
    intake: { trigger: 'review-pr', source: 'pull-request', label: 'from PR #12', stop: { reason: 'out of budget', detail: 'The daily cap was reached before this round closed.', at: 10 } },
  } as unknown as Receipt
  act(() => root.render(<GoalReceipt receipt={receipt} root="/repo" />))
  expect(container.textContent).toContain('Opened from PR #12.')
  expect(container.textContent).toContain('Out of budget.')
  expect(container.textContent).toContain('The daily cap was reached before this round closed.')

  act(() => root.render(<GoalReceipt receipt={baseReceipt} root="/repo" />))
  expect(container.textContent).not.toContain('Opened from')
})

it('an old receipt with no findings field never claims none were found', () => {
  act(() => root.render(<GoalReceipt receipt={baseReceipt} root="/repo" />))
  expect(container.textContent).toContain('Findings were not recorded.')
  expect(container.textContent).not.toContain('No findings recorded.')
})

it('an explicitly empty version-1 receipt says so, distinctly from an old one', () => {
  const receipt = { ...baseReceipt, findings: { version: 1, evidence: [], findings: [], overrides: [] } } as unknown as Receipt
  act(() => root.render(<GoalReceipt receipt={receipt} root="/repo" />))
  expect(container.textContent).toContain('No findings recorded.')
  expect(container.textContent).not.toContain('were not recorded')
})

it('a populated receipt shows a repair claim honestly and a person override without editing the finding', () => {
  const finding = {
    id: 'finding-0001', origin: { goal: 'g1', run: 'run-1', round: 2, card: 1, seat: 'seat-1', at: 'a'.repeat(40) },
    ownerGoal: 'g1', title: 'Off-by-one', body: '', category: 'ordinary', blocking: true, related: null, anchor: null,
    lifecycle: { state: 'repaired', confirmed: false, repairs: ['a'.repeat(40)] }, sequence: 2, evidence: ['ev-1'], posted: [],
    restored: false, problem: null,
  }
  const override = { by: 'person', run: 'run-1', round: 3, at: 'b'.repeat(40), findings: ['finding-0001'], reason: 'shipping with a tracked follow-up', decidedAt: 10 }
  const receipt = { ...baseReceipt, findings: { version: 1, evidence: ['ev-1'], findings: [finding], overrides: [override] } } as unknown as Receipt
  const opened: string[] = []
  act(() => root.render(<GoalReceipt receipt={receipt} root="/repo" onOpenFinding={(id) => opened.push(id)} />))
  expect(container.textContent).toContain('Repair claimed · awaiting review')
  expect(container.textContent).not.toContain('Repair accepted')
  expect(container.textContent).toContain('shipping with a tracked follow-up')
  const button = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('finding-0001'))!
  act(() => button.click())
  expect(opened).toEqual(['finding-0001'])
})

it('keeps a long lifecycle chip off the finding row\'s fixed icon mark, on the label\'s own line instead', () => {
  const finding = {
    id: 'finding-0001', origin: { goal: 'g1', run: 'run-1', round: 2, card: 1, seat: 'seat-1', at: 'a'.repeat(40) },
    ownerGoal: 'g1', title: 'Off-by-one', body: '', category: 'ordinary', blocking: true, related: null, anchor: null,
    lifecycle: { state: 'repaired', confirmed: false, repairs: ['a'.repeat(40)] }, sequence: 2, evidence: ['ev-1'], posted: [],
    restored: false, problem: null,
  }
  const receipt = { ...baseReceipt, findings: { version: 1, evidence: ['ev-1'], findings: [finding], overrides: [] } } as unknown as Receipt
  act(() => root.render(<GoalReceipt receipt={receipt} root="/repo" />))
  const rows = [...container.getElementsByClassName(stylesSettings.row!)]
  const target = rows.find((one) => one.textContent?.includes('finding-0001'))!
  const chip = target.querySelector('[data-slot="chip-words"]')
  expect(chip?.textContent).toBe('Repair claimed · awaiting review')
  const mark = target.getElementsByClassName(stylesSettings.rowMark!)[0] ?? null
  expect(mark === null || mark.querySelector('[data-slot="chip-words"]') === null).toBe(true)
})

/*
 * #875: "what each Seat answered" only means something if the reader can
 * tell which Seat that was without going and looking it up elsewhere — so
 * the receipt has to carry the name itself, not just the Seat's id.
 */
it('labels a Seat answer and its evidence by name, from the receipt’s own members — not a raw id', () => {
  const receipt = {
    version: 1, id: 'r1', goal: 'g1', sentence: 'Ship', wrappedAt: 4, summary: 'Done.',
    cards: [], seats: ['seat-1', 'seat-2'],
    members: [
      { seat: 'seat-1', agent: 'Code reviewer', seatLabel: 'Claude · Opus' },
      { seat: 'seat-2', agent: null, seatLabel: 'Codex · gpt-5.6' },
    ],
    evidence: ['fact-1', 'fact-2'],
    evidenceSeats: [
      { id: 'fact-1', seat: 'seat-1' },
      { id: 'fact-2', seat: null },
    ],
    answers: [
      { seat: 'seat-1', session: { runtime: 'claude-code', sessionId: 's1' }, turn: 't1', text: 'Two cases added. Six pass.', partial: false, stopReason: null },
      { seat: 'seat-2', session: { runtime: 'codex', sessionId: 's2' }, turn: 't2', text: 'Filed as blocked.', partial: false, stopReason: null },
    ],
    lanes: [], revisions: [], citations: [], gaps: [],
  } as unknown as Receipt
  act(() => root.render(<GoalReceipt receipt={receipt} root="/repo" />))
  const text = container.textContent ?? ''
  expect(text).toContain('Code reviewer · Claude · Opus')
  expect(text).toContain('Codex · gpt-5.6')
  expect(text).not.toContain('seat-1')
  expect(text).not.toContain('seat-2')
  // Evidence: named by the Seat that produced it when one did, and said to be
  // the desk's own when none did — an id either way is a reference, not the
  // headline.
  expect(text).toContain('fact-1')
  expect(text).toContain('fact-2')
  expect(text).toContain('Observed by the desk')
})

/*
 * A restored Seat — history a backup brought, never one this wrap held —
 * produces real evidence but has no entry in `members`, which excludes it
 * the same way `seats` does. `evidenceSeats` carries that Seat's own
 * `seatLabel` directly for exactly this case, so the row still reads as a
 * name rather than falling all the way to the bare evidence id.
 */
it('names evidence from a restored Seat by its own recorded seatLabel, absent from members', () => {
  const receipt = {
    version: 1, id: 'r1', goal: 'g1', sentence: 'Ship', wrappedAt: 4, summary: 'Done.',
    cards: [], seats: [], members: [], evidence: ['fact-restored'],
    evidenceSeats: [{ id: 'fact-restored', seat: 'restored-seat', seatLabel: 'Claude · Opus' }],
    answers: [], lanes: [], revisions: [], citations: [], gaps: [],
  } as unknown as Receipt
  act(() => root.render(<GoalReceipt receipt={receipt} root="/repo" />))
  const text = container.textContent ?? ''
  expect(text).toContain('Claude · Opus')
  expect(text).not.toContain('restored-seat')
  expect(text).toContain('fact-restored')
})

const settle = () => act(async () => {})

it('a citation row opens its retained detail in a dialog, reading through the store', async () => {
  const receipt = {
    version: 1, id: 'r1', goal: 'g1', sentence: 'Ship', wrappedAt: 4, summary: 'Done.',
    cards: [], seats: [], evidence: [], answers: [], lanes: [], revisions: [],
    citations: [{ goal: 'source-goal', receipt: 'r-source', project: '/repo', path: '.harnessdesk/memory/decisions.md', at: 'a'.repeat(40) }],
    gaps: [],
  } as unknown as Receipt
  const snapshot = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot
  const readMemoryCitation = vi.fn(async () => ({
    state: 'retained' as const,
    snapshot: {
      version: 1 as const,
      citation: receipt.citations[0]!,
      text: 'Chose the flat file.',
      receipt: { version: 1, id: 'r-source', goal: 'source-goal', sentence: 'Chose the format', wrappedAt: 1, summary: '', cards: [], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [] },
      seats: [],
      capturedAt: 1,
      missingSeatIds: [],
    },
    sourceAvailable: true,
    revisionAvailable: true,
    restored: false,
  }))
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readMemoryCitation } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><GoalReceipt receipt={receipt} root="/repo" /></StoreProvider>))
  const trigger = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('.harnessdesk/memory/decisions.md'))
  expect(trigger).toBeTruthy()
  act(() => trigger!.click())
  await settle()
  expect(readMemoryCitation).toHaveBeenCalledWith('/repo', receipt.citations[0])
  expect(document.body.textContent).toContain('Chose the flat file.')
  const closeButton = [...document.body.querySelectorAll('button')].find((one) => one.getAttribute('aria-label') === 'Close' || one.textContent === 'Close')
  act(() => (closeButton ?? document.body.querySelector('[role="dialog"] button'))?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  await settle()
})

it('falls back to the raw id when a receipt predates the members it would need to name a Seat', () => {
  const receipt = {
    version: 1, id: 'r1', goal: 'g1', sentence: 'Ship', wrappedAt: 4, summary: 'Done.',
    cards: [], seats: ['seat-1'], evidence: ['fact-1'],
    answers: [{ seat: 'seat-1', session: { runtime: 'codex', sessionId: 's1' }, turn: 't1', text: 'Done.', partial: false, stopReason: null }],
    lanes: [], revisions: [], citations: [], gaps: [],
  } as unknown as Receipt
  act(() => root.render(<GoalReceipt receipt={receipt} root="/repo" />))
  const text = container.textContent ?? ''
  expect(text).toContain('seat-1')
  expect(text).toContain('fact-1')
  expect(text).toContain('Recorded evidence ID')
})
