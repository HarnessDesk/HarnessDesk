import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { Button, Note } from '../index'
import css from './Settings.module.css?raw'

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

it('lets an inline note share its parent measure with a middle-truncated value', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<Note layout="inline"><span>Read from</span><span>storefront path</span><span>, committed with the code.</span></Note>))
    const note = container.querySelector<HTMLElement>('[data-slot="note"]')!
    expect(note.dataset['layout']).toBe('inline')
    const rule = css.match(/\.note\[data-layout='inline'\]\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(rule).toMatch(/width:\s*100%/)
    expect(rule).toMatch(/max-width:\s*none/)
    expect(rule).not.toMatch(/flex-wrap:\s*wrap/)
    expect(rule).toMatch(/gap:\s*var\(--hd-space-1\)/)
    expect(rule).toMatch(/flex-wrap:\s*nowrap/)
    expect(rule).toMatch(/white-space:\s*nowrap/)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
