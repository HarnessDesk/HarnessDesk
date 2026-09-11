import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import workbenchSheet from '../../panels/Workbench.module.css?raw'
import { PanelPlayground } from './PanelPlayground'
import playgroundSheet from './panel-playground.module.css?raw'

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

const point = (node: HTMLElement, type: string, clientX: number): void => {
  act(() => {
    node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX, clientY: 0 }))
  })
}

it('a split seam drags, as the workbench seam it demonstrates does', () => {
  // The seam wore the workbench's resize cursor and had no drag behind it.
  const split = container.querySelector<HTMLButtonElement>('button[aria-label="Split side by side"]')
  expect(split, 'a stack with two views offers a split').toBeTruthy()
  act(() => split!.click())
  const seam = container.querySelector<HTMLElement>('[aria-label="Resize these panels"]')
  expect(seam, 'the split has a seam').toBeTruthy()
  const box = seam!.parentElement as HTMLElement
  box.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}) }) as DOMRect
  const first = seam!.previousElementSibling as HTMLElement
  const start = parseFloat(first.style.flexBasis)

  point(seam!, 'pointerdown', 500)
  point(seam!, 'pointermove', 600)
  // A hundred pixels of a thousand is a tenth of the split.
  expect(parseFloat(first.style.flexBasis)).toBeCloseTo(start + 10, 5)

  point(seam!, 'pointerup', 600)
  // Committed: the layout holds the new ratio once the preview is gone.
  expect(parseFloat(first.style.flexBasis)).toBeCloseTo(start + 10, 5)
})

it('collapses a lone panel to its tabs, as the workbench does', () => {
  // Only a split's strips gave up their share when collapsed; a lone panel kept flex: 1.
  const collapsing = (sheet: string) =>
    [...sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((rule) => /flex:\s*none/.test(rule[2] ?? ''))
      .flatMap((rule) => (rule[1] ?? '').split(',').map((selector) => selector.trim()))
      .filter((selector) => selector.includes('[data-collapsed]'))
  expect(collapsing(workbenchSheet).length).toBeGreaterThan(0)
  expect(collapsing(playgroundSheet)).toEqual(expect.arrayContaining(collapsing(workbenchSheet)))
})
