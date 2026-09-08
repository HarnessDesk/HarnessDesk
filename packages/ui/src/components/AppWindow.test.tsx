import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { WindowNavItem } from './AppWindow'

/**
 * A settings nav is a list of equal rows.
 *
 * Its labels are not all ours: a runtime supplies its own word for a page —
 * "Skills & commands" is what every ACP agent calls that one — and a label
 * long enough to wrap made its row half again as tall as the eleven around
 * it, on three of the four agents HarnessDesk ships with. The row cuts now
 * rather than wrapping, and the height stays the height.
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

const render = (node: Parameters<Root['render']>[0]): void => {
  act(() => root.render(node))
}

it('cuts a label the runtime chose rather than wrapping its row', () => {
  render(
    <WindowNavItem
      icon={<span />}
      label="Skills & commands"
      count={25}
      trail={<span>Cursor</span>}
      selected={false}
      onClick={() => {}}
    />,
  )
  const label = [...container.querySelectorAll('span')].find(
    (span) => span.textContent === 'Skills & commands',
  )
  expect(label).toBeDefined()
  const style = getComputedStyle(label as HTMLElement)
  expect(style.whiteSpace).toBe('nowrap')
  expect(style.textOverflow).toBe('ellipsis')
  expect(style.overflow).toBe('hidden')
})

it('keeps the trailing values out of the label’s space', () => {
  render(
    <WindowNavItem
      icon={<span />}
      label="Skills & commands"
      count={25}
      selected={false}
      onClick={() => {}}
    />,
  )
  const count = [...container.querySelectorAll('span')].find((span) => span.textContent === '25')
  // `flex: none` on the count is what stops the browser shrinking the number
  // instead of the label it sits beside.
  expect(getComputedStyle(count as HTMLElement).flexGrow).toBe('0')
  expect(getComputedStyle(count as HTMLElement).flexShrink).toBe('0')
})
