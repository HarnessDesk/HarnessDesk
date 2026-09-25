import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { AccountMark } from './Settings'

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
