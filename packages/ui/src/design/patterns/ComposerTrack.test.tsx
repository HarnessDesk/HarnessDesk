import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { ComposerTrack } from './ComposerTrack'
import css from './ComposerTrack.module.css?raw'

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

const draw = (node: ReactNode): HTMLElement => {
  act(() => root.render(node))
  const track = container.firstElementChild
  if (!(track instanceof HTMLElement)) throw new Error('no track rendered')
  return track
}

it('lets a selected value keep its natural width and shrink with the row', () => {
  const track = draw(<ComposerTrack name="mode" folded contentSized>Default</ComposerTrack>)
  expect(track.dataset['folded']).toBe('true')
  expect(track.textContent).toBe('Default')
  expect(track.className).toContain('trackContentSized')
  expect(css).toMatch(/\.trackContentSized,[\s\S]*?\{[^}]*width:\s*max-content[^}]*flex:\s*0 1 auto/s)
})

it('keeps the context track width tied to its wide, folded or tight token', () => {
  const wide = draw(<ComposerTrack name="context" />)
  expect(wide.style.width).toBe('var(--hd-composer-track-context-wide)')

  const folded = draw(<ComposerTrack name="context" folded />)
  expect(folded.style.width).toBe('var(--hd-composer-track-context-folded)')

  const tight = draw(<ComposerTrack name="context" folded tight />)
  expect(tight.style.width).toBe('var(--hd-composer-track-context-tight)')
})
