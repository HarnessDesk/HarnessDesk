import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ComposerChip, ComposerDropHint } from './composer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('owns removable composer chips and preserves the caller’s accessible name', () => {
  const remove = vi.fn()
  act(() => root.render(
    <ComposerChip tone="brand" removeLabel="Remove report.pdf" onRemove={remove}>report.pdf</ComposerChip>,
  ))

  expect(container.querySelector('[data-slot="composer-chip"]')?.getAttribute('data-tone')).toBe('brand')
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Remove report.pdf"]')
  expect(button).not.toBeNull()
  act(() => button?.click())
  expect(remove).toHaveBeenCalledOnce()
})

it('names the composer drop state without making it interactive', () => {
  act(() => root.render(<ComposerDropHint>Drop images to attach</ComposerDropHint>))
  const hint = container.querySelector('[data-slot="composer-drop-hint"]')
  expect(hint?.textContent).toBe('Drop images to attach')
  expect(hint?.getAttribute('aria-hidden')).toBe('true')
})
