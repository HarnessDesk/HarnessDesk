import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { PanelPlayground } from './PanelPlayground'

/**
 * The panel playground demonstrates the workbench, so where it behaves
 * differently it teaches the wrong thing (review of #183, round 5).
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<PanelPlayground />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const point = (node: HTMLElement, type: string, clientX: number, clientY = 0): void => {
  act(() => {
    node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX, clientY }))
  })
}

/** Splits the demo stack, gives the split a 1000 × 600 box, and hands back its seam and first half. */
const split = (label: 'Split side by side' | 'Split one above the other') => {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button, 'a stack with two views offers a split').toBeTruthy()
  act(() => button!.click())
  const seam = container.querySelector<HTMLElement>('[aria-label="Resize these panels"]')
  expect(seam, 'the split has a seam').toBeTruthy()
  const box = seam!.parentElement as HTMLElement
  box.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}) }) as DOMRect
  const first = seam!.previousElementSibling as HTMLElement
  return { seam: seam!, first, start: parseFloat(first.style.flexBasis) }
}

const size = (half: HTMLElement): number => parseFloat(half.style.flexBasis)
const resizing = (): string | null => document.documentElement.getAttribute('data-hd-resizing')

it('a split seam drags, as the workbench seam it demonstrates does', () => {
  // The seam wore the workbench's resize cursor and had no drag behind it.
  const { seam, first, start } = split('Split side by side')
  point(seam, 'pointerdown', 500)
  point(seam, 'pointermove', 600)
  // A hundred pixels of a thousand is a tenth of the split.
  expect(size(first)).toBeCloseTo(start + 10, 5)
  point(seam, 'pointerup', 600)
  // Committed: the layout holds the new ratio once the preview is gone.
  expect(size(first)).toBeCloseTo(start + 10, 5)
})

it('a cancelled drag keeps the size it started with (review of #183, round 6)', () => {
  const { seam, first, start } = split('Split side by side')
  point(seam, 'pointerdown', 500)
  point(seam, 'pointermove', 600)
  expect(size(first)).toBeCloseTo(start + 10, 5)
  point(seam, 'pointercancel', 600)
  expect(size(first)).toBeCloseTo(start, 5)
})

it('a drag that loses its pointer capture ends there, and keeps where it got to (review of #183, round 6)', () => {
  const { seam, first, start } = split('Split side by side')
  point(seam, 'pointerdown', 500)
  point(seam, 'pointermove', 600)
  point(seam, 'lostpointercapture', 600)
  expect(size(first)).toBeCloseTo(start + 10, 5)
  // Ended, not merely paused: a later move is not a drag.
  point(seam, 'pointermove', 800)
  expect(size(first)).toBeCloseTo(start + 10, 5)
  expect(resizing()).toBeNull()
})

it('a split one above the other drags along its height (review of #183, round 6)', () => {
  const { seam, first, start } = split('Split one above the other')
  point(seam, 'pointerdown', 500, 300)
  // Sixty pixels of six hundred is a tenth; the four hundred across are not its axis.
  point(seam, 'pointermove', 900, 360)
  expect(size(first)).toBeCloseTo(start + 10, 5)
})

it('a drag stops where the workbench stops it (review of #183, round 6)', () => {
  const { seam, first } = split('Split side by side')
  point(seam, 'pointerdown', 500)
  point(seam, 'pointermove', 1900)
  expect(size(first)).toBeCloseTo(85, 5)
  point(seam, 'pointermove', -900)
  expect(size(first)).toBeCloseTo(15, 5)
})

it('marks the window as resizing for as long as the drag lasts, however it ends (review of #183, round 6)', () => {
  const { seam } = split('Split side by side')
  point(seam, 'pointerdown', 500)
  expect(resizing()).toBe('vertical')
  point(seam, 'pointerup', 500)
  expect(resizing()).toBeNull()
  point(seam, 'pointerdown', 500)
  point(seam, 'pointercancel', 500)
  expect(resizing()).toBeNull()
  point(seam, 'pointerdown', 500)
  // The split goes away under the pointer.
  act(() => root.unmount())
  expect(resizing()).toBeNull()
  root = createRoot(container)
})
