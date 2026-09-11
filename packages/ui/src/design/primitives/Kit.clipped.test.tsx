import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Clipped } from './Kit'

/**
 * `Clipped`: a line that says itself whole on hover only while it is cut, so
 * text that fits never hides the tooltip of the row that holds it.
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

/** jsdom lays nothing out, so a width is whatever the test says it is. */
const sized = (node: HTMLElement, scroll: number, client: number): void => {
  Object.defineProperty(node, 'scrollWidth', { configurable: true, value: scroll })
  Object.defineProperty(node, 'clientWidth', { configurable: true, value: client })
}

const hover = (node: HTMLElement): void => {
  act(() => {
    node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}

it('says itself whole on hover while it is cut, and nothing once it fits', () => {
  const name = 'Jane Doe, Keeper of Several Long Names'
  act(() => {
    root.render(
      <button type="button" title="New sessions run as Codex">
        <Clipped>{name}</Clipped>
      </button>,
    )
  })
  const label = container.querySelector('span')
  if (!label) throw new Error('no label')
  sized(label, 320, 120)
  hover(label)
  expect(label.getAttribute('title')).toBe(name)
  // A wider window: the name fits, so the row's own title is the one that shows.
  sized(label, 80, 120)
  hover(label)
  expect(label.hasAttribute('title')).toBe(false)
  expect(container.querySelector('button')?.getAttribute('title')).toBe('New sessions run as Codex')
})
