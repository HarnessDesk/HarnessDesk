import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { LeadWakeLedger } from './LeadWakeLedger'

it('is collapsed to the latest row and expands to include silent wakes with one line per wake', () => {
  const box = document.createElement('div'), root = createRoot(box)
  act(() => root.render(<LeadWakeLedger wakes={[
    { id: 'silent', at: 100, source: 'desk-change', decision: 'silent', modelTurn: false, usdMicros: null },
    { id: 'asked', at: 200, source: 'schedule', decision: 'asked', modelTurn: true, usdMicros: 1200 },
  ]} />))
  expect(box.querySelectorAll('[data-wake-row]')).toHaveLength(1)
  expect(box.textContent).toContain('schedule')
  expect(box.textContent).toContain('asked')
  act(() => box.querySelector('button')!.click())
  expect(box.querySelectorAll('[data-wake-row]')).toHaveLength(2)
  expect(box.textContent).toContain('stayed silent')
  expect(box.querySelector('time')?.title).toBeTruthy()
  expect(box.querySelectorAll('[data-slot="row-desc"]')).toHaveLength(0)
  act(() => root.unmount())
})

it('names a wake whose request failed, rather than calling it silence', () => {
  const box = document.createElement('div'), root = createRoot(box)
  act(() => root.render(<LeadWakeLedger wakes={[{ id: 'failed', at: 100, source: 'desk-change', decision: 'failed', modelTurn: false, usdMicros: null }]} />))
  expect(box.textContent).toContain('request failed')
  expect(box.textContent).not.toContain('stayed silent')
  act(() => root.unmount())
})

it('collapsed, shows the latest wake that produced a reply, not a later silent check (#2172)', () => {
  const box = document.createElement('div'), root = createRoot(box)
  act(() => root.render(<LeadWakeLedger wakes={[
    { id: 'spoke', at: 100, source: 'person', decision: 'spoke', modelTurn: true, usdMicros: 10_000 },
    { id: 'tick', at: 200, source: 'desk-change', decision: 'silent', modelTurn: false, usdMicros: null },
  ]} />))
  expect(box.querySelectorAll('[data-wake-row]')).toHaveLength(1)
  expect(box.textContent).toContain('person · spoke')
  expect(box.textContent).not.toContain('stayed silent')
  act(() => box.querySelector('button')!.click())
  expect(box.querySelectorAll('[data-wake-row]')).toHaveLength(2)
  expect(box.textContent).toContain('stayed silent')
  act(() => root.unmount())
})
