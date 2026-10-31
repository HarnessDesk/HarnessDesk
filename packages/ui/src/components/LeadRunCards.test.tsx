import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LeadCards } from './LeadCards'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
import { leadBudget, leadContract } from '../preview/lead-fixture'
import type { LeadCard } from '@harnessdesk/protocol'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const clean: (() => void)[] = []
afterEach(() => clean.splice(0).forEach(fn => fn()))
const mount = (card: LeadCard, raise = vi.fn(async () => {})) => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), decide = vi.fn()
  act(() => root.render(<StoreProvider store={previewStore()}><LeadCards cards={[card]} contract={leadContract} budget={leadBudget}
    onDecide={decide} onRaiseLimit={raise} onChanges={() => {}} onApprovals={() => {}} /></StoreProvider>))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, raise, decide }
}

it('renders the host second look facts safely with no approval control', () => {
  const { box, decide } = mount({ version: 1, id: 'look-1', revision: 1, type: 'second-look', contractDigest: leadContract.digest,
    logicalGoalId: 'goal-1', runId: 'run-1', stopKey: 'stop-1', said: '<script>bad()</script>blocked on #231', found: '#231 merged at 13:42', did: 'Restarted, round 2 of 3.' })
  expect(box.textContent).toContain('Second look')
  for (const fact of ['Said', 'Found', 'Did', 'blocked on #231', '#231 merged at 13:42', 'Restarted, round 2 of 3.']) expect(box.textContent).toContain(fact)
  expect(box.querySelector('script')).toBeNull()
  expect(box.querySelector('[data-lead-decision]')).toBeNull()
  expect(box.querySelector('button')).toBeNull()
  expect(decide).not.toHaveBeenCalled()
})

it('shows the known 80% figure and applies a person limit raise directly', async () => {
  const { box, raise, decide } = mount({ version: 1, id: '80-1', revision: 1, type: 'allowance-warning', contractDigest: leadContract.digest,
    logicalGoalId: 'goal-1', usdMicros: 4000000, caps: { usdMicros: 5000000, rounds: 4 } })
  expect(box.textContent).toContain('At 80%')
  expect(box.textContent).toContain('$4.00 of $5.00')
  expect(box.textContent).toContain('At $5.00 the goal stops, as before')
  expect(box.querySelector('[data-lead-decision]')).toBeNull()
  await act(async () => [...box.querySelectorAll('button')].find(node => node.textContent === 'Raise limit…')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog).not.toBeNull()
  const input = dialog.querySelector<HTMLInputElement>('[aria-label="New dollar cap"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '6')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => [...dialog.querySelectorAll('button')].find(node => node.textContent === 'Apply')!.click())
  expect(raise).toHaveBeenCalledWith('goal-1', { usdMicros: 6000000, rounds: 4 })
  expect(decide).not.toHaveBeenCalled()
})
