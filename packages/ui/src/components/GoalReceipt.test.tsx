import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { GoalReceipt as Receipt } from '@harnessdesk/protocol'
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
