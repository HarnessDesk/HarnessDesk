import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { AccountMark } from './Settings'
import css from './Settings.module.css?raw'

/**
 * An account's mark. Pinned: drawn as a control — one ring of a picker — it
 * is the same plate, and the platform's button edge and inset are the part's
 * to take off, not each screen's.
 */

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

const render = (node: ReactNode): HTMLElement => {
  act(() => root.render(node))
  const mark = container.firstElementChild
  if (!(mark instanceof HTMLElement)) throw new Error('no mark')
  return mark
}

it('draws a mark that is a control without the platform button edge or inset', () => {
  const mark = render(<AccountMark as="button" aria-label="blue" data-tint="blue">A</AccountMark>)
  expect(mark.tagName).toBe('BUTTON')
  expect(mark.getAttribute('type')).toBe('button')
  const style = getComputedStyle(mark)
  expect(style.borderTopWidth).toBe('0px')
  expect(style.paddingLeft).toBe('0px')
  expect(style.cursor).toBe('pointer')
})

it('leaves a mark that is not a control as the plate alone', () => {
  const mark = render(<AccountMark>A</AccountMark>)
  expect(mark.tagName).toBe('SPAN')
  expect(getComputedStyle(mark).cursor).not.toBe('pointer')
})

it('draws a signed-out mark as an empty seat: no plate, a dashed ring, the quietest ink', () => {
  // Rendered, with a tint beside it: the off rule wins on the element, not by its place in the file.
  const mark = render(<AccountMark size="sm" data-tint="blue" data-off="">A</AccountMark>)
  const style = getComputedStyle(mark)
  expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(style.color).toBe('var(--hd-muted-foreground)')
  expect(style.boxShadow).toBe('none')
  // jsdom does not resolve an outline shorthand written with var(), so the ring is read from the rule.
  const ring = css.match(/\.avatar\[data-off\]:not\(:focus-visible\)\s*\{([^}]*)\}/)?.[1] ?? ''
  expect(ring).toMatch(/outline:\s*var\(--hd-border-width\) dashed var\(--hd-border-strong\)/)
  // The ring steps aside for a focus ring: no unscoped outline on an off mark.
  const plate = css.match(/\.avatar\[data-off\]\s*\{([^}]*)\}/)?.[1] ?? ''
  expect(plate).not.toMatch(/outline/)
})

it('leaves a tinted mark that is not off its colour — the control for the test above', () => {
  const style = getComputedStyle(render(<AccountMark size="sm" data-tint="blue">A</AccountMark>))
  expect(style.boxShadow).not.toBe('none')
  expect(style.color).not.toBe('var(--hd-muted-foreground)')
})
