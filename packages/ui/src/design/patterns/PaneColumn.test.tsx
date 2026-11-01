import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { PaneColumn, PaneTabsRow, ReadingMeasure, useComposerHeightVar } from './PaneColumn'

/**
 * The column inset four screens shared with no owner: the reading column the
 * transcript's own scroll box and the room's stream both stand in, the bars
 * strip above the transcript's composer, the sidebar's rail, and the jobs
 * strip nested in the bars — and the composer-height measurement `reading`'s
 * own `clearComposer` reads.
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
  vi.unstubAllGlobals()
})

it('gives each inset its own inline gutter, and no vertical padding by default', () => {
  act(() => root.render(<PaneColumn inset="rail">rows</PaneColumn>))
  const column = container.firstElementChild as HTMLElement
  expect(column.dataset['slot']).toBe('pane-column')
  expect(column.dataset['inset']).toBe('rail')
  expect(column.style.padding).toBe('0 var(--hd-rail-inset)')
})

it('adds the scrollbar gutter back for the bars strip, which is not itself a scroll box', () => {
  act(() => root.render(<PaneColumn inset="bars">bars</PaneColumn>))
  const column = container.firstElementChild as HTMLElement
  expect(column.style.padding).toBe('0 calc(var(--hd-space-6) + var(--hd-scrollbar-width, 8px))')
})

/**
 * `reading` is the transcript's own scroll box and the room's stream both —
 * a flat gutter, no scrollbar compensation added here, because each of those
 * two already reserves it physically (`scrollbar-gutter: stable both-edges`
 * on its own scroll box). Adding it again in this padding is exactly the
 * regression #1016's review caught: 16px narrower than the composer below
 * the column's own cap.
 */
it('takes the reading column flat, without the scrollbar compensation, and its own static vertical air', () => {
  act(() => root.render(<PaneColumn inset="reading">stream</PaneColumn>))
  const column = container.firstElementChild as HTMLElement
  expect(column.style.padding).toBe('var(--hd-space-2) var(--hd-space-6)')
})

it('gives a prose page the reading inset above and below its content', () => {
  act(() => root.render(<PaneColumn inset="reading" page>receipt</PaneColumn>))
  expect((container.firstElementChild as HTMLElement).style.padding).toBe('var(--page-top, var(--hd-space-6)) var(--hd-space-6) var(--hd-space-6)')
})

it('clears the floating composer only when asked, on top of a notice inset', () => {
  act(() => root.render(<PaneColumn inset="reading" clearComposer>turns</PaneColumn>))
  const column = container.firstElementChild as HTMLElement
  expect(column.style.padding).toBe(
    'calc(8px + var(--hd-notice-inset, 0px)) var(--hd-space-6) calc(var(--composer-h, 150px) + var(--shared-composer-h, 0px) + 16px)',
  )
  // A turn scrolled into view (a plan waiting for approval) must land above the composer, not behind it.
  expect(column.style.getPropertyValue('scroll-padding-bottom')).toBe('calc(var(--composer-h, 150px) + var(--shared-composer-h, 0px) + 16px)')
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

it('caps and centers a transcript or composer notice on the reading measure', () => {
  act(() => root.render(<ReadingMeasure>Kept copy</ReadingMeasure>))
  const measure = container.firstElementChild as HTMLElement
  expect(measure.style.maxWidth).toBe('var(--hd-column)')
  expect(measure.style.marginInline).toBe('auto')
})

const conditionalDock = () => {
  const observers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn()
    disconnect = vi.fn()
    constructor(readonly callback: () => void) { observers.push(this) }
  })
  const Harness = ({ visible }: { visible: boolean }) => {
    const rootRef = useRef<HTMLDivElement>(null), dock = useComposerHeightVar(rootRef)
    return <div ref={rootRef} data-testid="root">{visible && <div ref={dock} data-testid="dock" />}</div>
  }
  const render = (visible: boolean) => act(() => root.render(<Harness visible={visible} />))
  const resize = (height: number) => {
    const dock = container.querySelector<HTMLElement>('[data-testid="dock"]')!
    Object.defineProperty(dock, 'offsetHeight', { configurable: true, value: height })
    act(() => observers.at(-1)?.callback())
  }
  return { observers, render, resize, height: () => container.querySelector<HTMLElement>('[data-testid="root"]')!.style.getPropertyValue('--composer-h') }
}

it('observes a dock mounted after the initial render without one', () => {
  const { observers, render, resize, height } = conditionalDock()
  render(false); render(true); resize(120)
  expect(height()).toBe('120px')
  expect(observers.at(-1)?.observe).toHaveBeenCalledWith(container.querySelector('[data-testid="dock"]'), { box: 'border-box' })
})

it('releases the old dock and observes a remounted dock through unmount', () => {
  const { observers, render, resize, height } = conditionalDock()
  render(true); resize(84)
  const oldDock = container.querySelector('[data-testid="dock"]'), oldObserver = observers.at(-1)!
  render(false)
  expect(oldObserver.disconnect).toHaveBeenCalledOnce()
  expect(height()).toBe('')
  render(true); resize(160)
  const newDock = container.querySelector('[data-testid="dock"]'), newObserver = observers.at(-1)!
  expect(newDock).not.toBe(oldDock)
  expect(newObserver).not.toBe(oldObserver)
  expect(newObserver.observe).toHaveBeenCalledWith(newDock, { box: 'border-box' })
  expect(height()).toBe('160px')
  act(() => root.unmount())
  expect(newObserver.disconnect).toHaveBeenCalledOnce()
  root = createRoot(container)
})

it('keeps several contextual controls in the same aligned row beside the pane tabs', () => {
  act(() => root.render(<PaneTabsRow controls={<><button>Findings</button><button>New task</button></>}>Tasks</PaneTabsRow>))
  const controls = container.querySelector('[data-pane-tabs-row]')?.lastElementChild as HTMLElement
  expect(controls.classList.contains('flex')).toBe(true)
  expect(controls.classList.contains('items-center')).toBe(true)
  // The group owns the pane's end gutter while tabs yield on the other edge.
  // Its buttons remain adjacent rather than sharing the free row space.
  expect(controls.classList.contains('ms-auto')).toBe(true)
  expect(controls.classList.contains('shrink-0')).toBe(true)
  expect([...controls.querySelectorAll('button')].map(one => one.textContent)).toEqual(['Findings', 'New task'])
})

it('heads a titled pane with its h1 and controls, and puts the tabs below them', () => {
  act(() => root.render(<PaneTabsRow title="Login flow" controls={<button>Stop run…</button>}>Tabs</PaneTabsRow>))
  const row = container.querySelector('[data-pane-tabs-row]') as HTMLElement
  expect(row.hasAttribute('data-pane-head')).toBe(true)
  const [head, tabs] = [...row.children] as HTMLElement[]
  // The name and what the page can do come first, on one line, in that order.
  expect(head!.querySelector('h1')?.textContent).toBe('Login flow')
  expect(head!.querySelector('h1')?.getAttribute('data-role')).toBe('page')
  expect(head!.lastElementChild?.textContent).toBe('Stop run…')
  expect(tabs!.textContent).toBe('Tabs')
})
