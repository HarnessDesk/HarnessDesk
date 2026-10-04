import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StopRunDialog } from './StopRunDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let box: HTMLDivElement
let root: Root
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box) })
afterEach(() => { act(() => root.unmount()); box.remove() })
const draw = (props: Partial<Parameters<typeof StopRunDialog>[0]> = {}) => {
  const onStop = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  act(() => root.render(<StopRunDialog seats={[]} onStop={onStop} onClose={onClose} {...props} />))
  return { onStop, onClose }
}
const dialog = () => document.body.querySelector('[role="alertdialog"]')!
const button = (name: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === name)!
const note = (value: string) => act(() => {
  const input = dialog().querySelector<HTMLInputElement>('input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

it('says the Run stops first, then states each Seat’s interruption capability without promising for an unknown runtime', () => {
  draw({ seats: [
    { id: 'a', name: 'Alpha', interrupt: true },
    { id: 'b', name: 'Beta', interrupt: false },
    { id: 'c', name: '<b>Gamma</b>\u001b[31m', interrupt: undefined },
  ] })
  expect(dialog().querySelector('p')?.textContent).toBe('The Run stops now and no further step starts.')
  const rows = [...dialog().querySelectorAll('[data-stop-seat]')]
  expect(rows.map(one => one.textContent)).toEqual(['Alphastops now', 'Betastops when its current turn ends', '<b>Gamma</b>stops when its current turn ends'])
  expect(dialog().querySelector('b')).toBeNull()
  expect(dialog().textContent).toContain('Stopping a Seat is best effort')
})
it.each(['', '   ', '  The brief changed.  '])('sends a nonempty reason for an optional note %j', async value => {
  const { onStop, onClose } = draw()
  note(value)
  await act(async () => { button('Stop run').click() })
  expect(onStop).toHaveBeenCalledWith(value.trim() || 'You stopped this Run. No further step starts.')
  expect(onClose).toHaveBeenCalledOnce()
})
it('bounds the note to the host’s limit even for programmatic input', async () => {
  const { onStop } = draw()
  expect(dialog().querySelector('input')?.maxLength).toBe(4096)
  note('x'.repeat(4097))
  expect(button('Stop run').disabled).toBe(true)
  expect(dialog().textContent).toContain('4,096 characters')
  note('x'.repeat(4096))
  await act(async () => { button('Stop run').click() })
  expect(onStop.mock.calls[0]?.[0]).toHaveLength(4096)
})
it('holds the request once, keeps a failure beside it, and lets the person retry cleanup', async () => {
  let reject!: (error: Error) => void
  const onStop = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, no) => { reject = no })).mockResolvedValue(undefined)
  const onClose = vi.fn()
  draw({ onStop, onClose })
  act(() => { button('Stop run').click(); button('Stop run').click() })
  expect(onStop).toHaveBeenCalledOnce()
  expect(button('Stopping…').disabled).toBe(true)
  await act(async () => { reject(new Error('Seat cleanup needs another try.')) })
  expect(onClose).not.toHaveBeenCalled()
  expect(dialog().textContent).toContain('Seat cleanup needs another try.')
  expect(button('Stop run').disabled).toBe(false)
  await act(async () => { button('Stop run').click() })
  expect(onStop).toHaveBeenCalledTimes(2)
  expect(onClose).toHaveBeenCalledOnce()
})
it('keeps the note and disables the final action if the Team wraps while the question is open', () => {
  const { onStop, onClose } = draw()
  note('Keep this note')
  act(() => root.render(<StopRunDialog seats={[]} onStop={onStop} onClose={onClose} refusal="This Team is wrapped" />))
  expect(dialog().querySelector('input')?.value).toBe('Keep this note')
  expect(button('Stop run').disabled).toBe(true)
  expect(dialog().textContent).toContain('This Team is wrapped')
})
