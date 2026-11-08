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
