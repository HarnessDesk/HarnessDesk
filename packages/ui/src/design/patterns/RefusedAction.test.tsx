import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, afterEach, expect, test, vi } from 'vitest'

import { Button } from '../ui/button'
import { RefusedAction } from './RefusedAction'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)

afterEach(async () => {
  await act(() => root.render(null))
})

afterAll(async () => {
  await act(() => root.unmount())
  host.remove()
})

test('keeps the disabled button as the single named focus target and describes its reason', async () => {
  const activate = vi.fn()
  await act(() =>
    root.render(
      <RefusedAction reason="This runtime cannot delete one conversation.">
        <Button disabled onClick={activate}>Delete</Button>
      </RefusedAction>,
    ),
  )

  const button = host.querySelector<HTMLButtonElement>('button')!
  expect(button.tabIndex).toBe(0)
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.textContent).toBe('Delete')
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)
    .toBe('This runtime cannot delete one conversation.')
  expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
  await act(() => {
    button.focus()
    button.click()
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  expect(document.activeElement).toBe(button)
  expect(activate).not.toHaveBeenCalled()
})

test('describes rich reasons without replacing an icon action name', async () => {
  await act(() => root.render(
    <RefusedAction reason={<span>Finish the <strong>active turn</strong> first.</span>}>
      <Button disabled aria-label="Remove agent"><svg aria-hidden="true" /></Button>
    </RefusedAction>,
  ))
  const button = host.querySelector('button')!
  expect(button.getAttribute('aria-label')).toBe('Remove agent')
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)
    .toBe('Finish the active turn first.')
})

test('leaves an action without a refusal unchanged', async () => {
  await act(() => root.render(<RefusedAction><Button disabled>Busy</Button></RefusedAction>))
  expect(host.querySelector('button')!.disabled).toBe(true)
  expect(host.querySelector('[data-slot="refused-action"]')).toBeNull()
})
