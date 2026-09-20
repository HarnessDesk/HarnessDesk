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
