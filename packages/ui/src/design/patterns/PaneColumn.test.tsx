import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { PaneColumn, useComposerHeightVar } from './PaneColumn'

/**
 * The column inset four screens shared with no owner: the transcript's own
 * scroll box and bars strip, the room's stream, the sidebar's rail, and the
 * jobs strip nested in the transcript's bars — and the composer-height
 * measurement the transcript's `clearComposer` reads.
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

it('gives each inset its own inline gutter, and no vertical padding by default', () => {
  act(() => root.render(<PaneColumn inset="rail">rows</PaneColumn>))
  const column = container.firstElementChild as HTMLElement
  expect(column.dataset['slot']).toBe('pane-column')
  expect(column.dataset['inset']).toBe('rail')
  expect(column.style.padding).toBe('0 var(--rail)')
})

it('reaches for the transcript and bars strip through the same wide gutter', () => {
  act(() => root.render(<PaneColumn inset="bars">bars</PaneColumn>))
  const column = container.firstElementChild as HTMLElement
  expect(column.style.padding).toBe('0 calc(var(--hd-space-6) + var(--hd-scrollbar-width, 8px))')
})

it('takes the room stream flat, without the scrollbar compensation, and its own static vertical air', () => {
  act(() => root.render(<PaneColumn inset="stream">stream</PaneColumn>))
  const column = container.firstElementChild as HTMLElement
  expect(column.style.padding).toBe('var(--hd-space-2) var(--hd-space-6)')
})

it('clears the floating composer only when asked, on top of a notice inset', () => {
  act(() => root.render(<PaneColumn inset="transcript" clearComposer>turns</PaneColumn>))
  const column = container.firstElementChild as HTMLElement
  expect(column.style.padding).toBe(
    'calc(8px + var(--hd-notice-inset, 0px)) calc(var(--hd-space-6) + var(--hd-scrollbar-width, 8px)) calc(var(--composer-h, 150px) + 16px)',
  )
})

it('keeps a caller’s own className and forwards its ref to the real element', () => {
  const ref = { current: null as HTMLDivElement | null }
  act(() => root.render(<PaneColumn inset="jobs" ref={ref} className="jobs-strip" />))
  const column = container.firstElementChild as HTMLElement
  expect(column.className).toBe('jobs-strip')
  expect(ref.current).toBe(column)
})

it('measures the dock and sets --composer-h on the root it is given', () => {
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 84 })
  try {
    const Harness = () => {
      const rootRef = useRef<HTMLDivElement>(null)
      const dock = useComposerHeightVar(rootRef)
      return (
        <div ref={rootRef} data-testid="root">
          <div ref={dock} data-testid="dock" />
        </div>
      )
    }
    act(() => root.render(<Harness />))
    const rootElement = container.querySelector('[data-testid="root"]') as HTMLElement
    expect(rootElement.style.getPropertyValue('--composer-h')).toBe('84px')
  } finally {
    if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight)
  }
})
