import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, afterEach, expect, test } from 'vitest'

import { ActionError } from '../index'

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

test('announces the reason an action failed with the canonical alert', async () => {
  await act(() => root.render(<ActionError className="failure-layout">Could not save.</ActionError>))

  const alert = host.querySelector('[data-slot="alert"]')
  expect(alert?.getAttribute('role')).toBe('alert')
  expect(alert?.classList.contains('failure-layout')).toBe(true)
  expect(alert?.querySelector('[data-slot="alert-content"]')?.textContent).toBe('Could not save.')
})
