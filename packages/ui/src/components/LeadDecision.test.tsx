import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LeadDecision } from './LeadDecision'

const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); vi.useRealTimers() })
const mount = () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box), approve = vi.fn()
  act(() => root.render(<LeadDecision id="plan" title="Review plan" pending={false} onApprove={approve} onDecline={vi.fn()} />))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const surface = box.querySelector<HTMLElement>('[data-slot="approval-card"]')!
  const digit = () => act(() => { surface.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true })) })
  return { surface, approve, digit }
}
it('a pointer press survives the microtask before focus and permits a decision digit', async () => {
  const { surface, approve, digit } = mount()
  await act(async () => { surface.dispatchEvent(new Event('pointerdown', { bubbles: true })); await Promise.resolve() })
  act(() => surface.focus()); digit()
  expect(approve).toHaveBeenCalledOnce()
})
it('focus without a pointer press still guards a typed-through digit', () => {
  const { surface, approve, digit } = mount()
  act(() => surface.focus()); digit()
  expect(approve).not.toHaveBeenCalled()
})
it.each(['focusin', 'timeout'])('consumes a pointer press at the following %s', async end => {
  vi.useFakeTimers()
  const { surface, approve, digit } = mount()
  act(() => { surface.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
  if (end === 'focusin') act(() => { surface.focus(); surface.blur() })
  else await act(async () => vi.advanceTimersByTimeAsync(501))
  act(() => surface.focus()); digit()
  expect(approve).not.toHaveBeenCalled()
})

it('guards the fourth shortcut against typed-through input, then invokes the explicit PR action once deliberately focused', () => {
  const box = document.createElement('div'), root = createRoot(box), openPr = vi.fn()
  document.body.append(box)
  act(() => root.render(<LeadDecision id="result" title="Accept these changes?" pending={false} link={{ label: 'Open changes', run: vi.fn() }} onApprove={vi.fn()} onDecline={vi.fn()} onOpenPr={openPr} />))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const surface = box.querySelector<HTMLElement>('[data-slot="approval-card"]')!
  act(() => { surface.focus(); surface.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true })) })
  expect(openPr).not.toHaveBeenCalled()
  act(() => { surface.dispatchEvent(new Event('pointerdown', { bubbles: true })); surface.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true })) })
  expect(openPr).toHaveBeenCalledOnce()
})
