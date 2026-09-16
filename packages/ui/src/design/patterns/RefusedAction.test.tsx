import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'

import { Button } from '../ui/button'
import { RefusedAction } from './RefusedAction'

test('makes a disabled action reason keyboard reachable', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(() =>
    root.render(
      <RefusedAction reason="This runtime cannot delete one conversation.">
        <Button disabled>Delete</Button>
      </RefusedAction>,
    ),
  )

  const explanation = host.querySelector<HTMLElement>('[data-slot="refused-action"]')!
  const button = host.querySelector<HTMLButtonElement>('button')!
  expect(explanation.tabIndex).toBe(0)
  expect(explanation.getAttribute('aria-label')).toBe('This runtime cannot delete one conversation.')
  expect(button.disabled).toBe(true)
  await act(() => root.unmount())
  host.remove()
})
