import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { Button, Note } from '../index'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('places a usable recovery action after the sentence', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const retry = vi.fn()
  try {
    act(() => root.render(<Note tone="warn" action={<Button size="sm" variant="outline" onClick={retry}>Try again</Button>}>Run counts are unavailable for some Teams.</Note>))
    const note = container.querySelector('[data-slot="note"]')!
    expect(note.firstElementChild?.textContent).toBe('Run counts are unavailable for some Teams.')
    const action = note.querySelector('button')!
    expect(action?.textContent).toBe('Try again')
    act(() => action.click())
    expect(retry).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
