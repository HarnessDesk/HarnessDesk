import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LeadOpening } from './LeadOpening'

it('Start sends only the selected goal into the plan path, and an empty desk renders nothing', () => {
  const box = document.createElement('div'), root = createRoot(box), start = vi.fn()
  act(() => root.render(<LeadOpening jobs={[]} pending={false} onStart={start} />))
  expect(box.textContent).toBe('')
  const job = { id: 'run-1', title: 'Review finished run', goal: 'Draft a plan to review run-1.' }
  act(() => root.render(<LeadOpening jobs={[job]} pending={false} onStart={start} />))
  expect(start).not.toHaveBeenCalled()
  act(() => box.querySelector('button')!.click())
  expect(start).toHaveBeenCalledExactlyOnceWith(job.goal)
  act(() => root.unmount())
})
