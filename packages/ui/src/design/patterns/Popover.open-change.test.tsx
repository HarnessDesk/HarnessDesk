import { act, StrictMode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { Popover } from './Popover'

/**
 * A caller told the menu opened or closed, and who is allowed to hear it when.
 *
 * `onOpenChange` is the caller's to act on — the seat's menu resets its folds
 * from it — and a caller acting on it sets its own state. Called from inside
 * the popover's own state updater, that set happened while React was
 * rendering the popover: "Cannot update a component while rendering a
 * different component" on every open (#973). Pinned: the caller hears each
 * change once, and hearing it never updates the caller during a render.
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
  vi.restoreAllMocks()
})

const Caller = ({ heard }: { heard: (open: boolean) => void }) => {
  const [times, setTimes] = useState(0)
  return (
    <>
      <span data-times>{times}</span>
      <Popover
        label="Open"
        onOpenChange={(open) => {
          heard(open)
          setTimes((value) => value + 1)
        }}
      >
        {() => <span>Inside</span>}
      </Popover>
    </>
  )
}

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

it('tells its caller it opened and closed, once each, and never while rendering', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const heard = vi.fn()
  // StrictMode runs state updaters twice, during render — which is where an
  // updater with a side effect shows itself.
  act(() => root.render(<StrictMode><Caller heard={heard} /></StrictMode>))
  const trigger = container.querySelector('button')
  if (!trigger) throw new Error('no trigger')

  click(trigger)
  expect(document.body.textContent).toContain('Inside')
  click(trigger)

  expect(heard.mock.calls).toEqual([[true], [false]])
  expect(container.querySelector('[data-times]')?.textContent).toBe('2')
  const duringRender = errors.mock.calls.filter((call) => String(call[0]).includes('while rendering a different component'))
  expect(duringRender).toEqual([])
})
