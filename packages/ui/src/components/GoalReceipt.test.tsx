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

const baseReceipt = {
  version: 1, id: 'r1', goal: 'g1', sentence: 'Ship', wrappedAt: 4, summary: 'Finished.',
  cards: [], seats: [], evidence: [], answers: [], lanes: [], revisions: [], citations: [], gaps: [],
} as unknown as Receipt

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
