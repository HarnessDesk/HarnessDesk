import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ComposerNotice } from './Notices'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(['It refills', 'It refills.'])('separates an inline title from its detail: %s', title => {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<ComposerNotice message={{ id: 'pace', title, body: 'Weekly runs out soon' }} />))
  expect(host.querySelector('[data-slot="notice-message-line"]')?.textContent).toBe('It refills. Weekly runs out soon')
  act(() => root.unmount())
})
