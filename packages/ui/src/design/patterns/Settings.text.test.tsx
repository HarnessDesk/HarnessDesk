import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { NoteList, RowChoice, Text } from './Settings'

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

it('can preserve the end of a truncated path', () => {
  act(() => root.render(<Text truncateFrom="start">packages/ui/src/Composer.tsx</Text>))
  const text = container.querySelector('[data-slot="text"]')
  expect(text?.getAttribute('data-truncate-from')).toBe('start')
  expect(text?.className).toContain('[direction:rtl]')
  expect(text?.className).toContain('text-left')
})

it('lets a narrow choice deliver its consequence whole', () => {
  act(() => root.render(
    <RowChoice title="Summary" desc="The goal, exchanges, files and tasks." wrapDesc selected onClick={() => {}} />,
  ))
  expect(container.querySelector('[data-wrap="true"]')?.textContent).toContain('files and tasks')
})

it('moves and selects radio choices with arrow keys', () => {
  const chooseSummary = vi.fn()
  const chooseTranscript = vi.fn()
  act(() => root.render(
    <div role="radiogroup" aria-label="What to carry">
      <RowChoice title="Summary" selected onClick={chooseSummary} />
      <RowChoice title="Transcript" selected={false} onClick={chooseTranscript} />
    </div>,
  ))

  const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  radios[0]?.focus()
  act(() => radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))

  expect(chooseTranscript).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(radios[1])
})

it('keeps a short list of note details semantically grouped', () => {
  act(() => root.render(<NoteList><li>flow.yaml — unknown role</li></NoteList>))
  const list = container.querySelector('[data-slot="note-list"]')
  expect(list?.tagName).toBe('UL')
  expect(list?.textContent).toContain('unknown role')
})

it('lets the named text role carry list-item semantics', () => {
  act(() => root.render(<Text as="li" role="value">Run the checks</Text>))
  const text = container.querySelector('[data-slot="text"]')
  expect(text?.tagName).toBe('LI')
  expect(text?.getAttribute('data-role')).toBe('value')
})
