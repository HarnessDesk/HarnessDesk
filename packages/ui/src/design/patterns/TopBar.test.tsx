import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PlusIcon } from '../../components/Icons'
import { TopBar, type TopBarProps } from './TopBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const noop = () => {}
const base: TopBarProps = {
  place: 'Checkout retry',
  state: <span>Ready</span>,
  tabs: [{ value: 'overview', label: 'Overview', run: noop }, { value: 'board', label: 'Board', run: noop }],
  tab: 'overview',
  verb: { label: 'New job', icon: <PlusIcon />, run: noop },
  more: () => null,
}
const view = { content: () => null }
let container: HTMLDivElement
let root: Root
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let availableTitle: number
let resizeCallbacks: (() => void)[]

// jsdom has no flex layout. Hold the observed outer row at 720 while its
// rendered slots consume room: state + verb words cost 40, expanded tabs
// cost 100 more than the menu, View costs 28, and the two breadcrumbs differ.
const titleWidth = (row: Element): number => {
  const parent = row.querySelector('[data-topbar="place"] > button')?.textContent
  return availableTitle
    - (row.querySelector('[data-topbar="view"] button') ? 28 : 0)
    - (parent === 'Teams ›' ? 50 : parent ? 120 : 0)
    + (row.querySelector('[data-topbar="state"]') ? 0 : 20)
    + (row.querySelector('[data-topbar="verb"]')?.textContent?.includes('New job') ? 0 : 20)
    + (row.querySelector('[role="tablist"]') ? 0 : 100)
}
beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  availableTitle = 200
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  // No resize is delivered: only the intrinsic slot inputs change.
  resizeCallbacks = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallbacks.push(callback) }
    observe() {} disconnect() {} unobserve() {}
  })
  const computedStyle = getComputedStyle
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((node, pseudo) => {
    const result = computedStyle(node, pseudo)
    if (node.matches('[data-slot="top-bar"]')) {
      const property = result.getPropertyValue.bind(result)
      vi.spyOn(result, 'getPropertyValue').mockImplementation(name => name === '--hd-bar-title-min' ? '180px' : property(name))
    }
    return result
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const width = this.matches('[data-topbar-title], [data-topbar="place"]') ? titleWidth(this.closest('[data-slot="top-bar"]')!)
      : this.matches('[data-slot="top-bar"]') ? 720 : 0
    return new DOMRect(0, 0, width, 40)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const render = (changes: Partial<TopBarProps>): number[] => {
  act(() => root.render(<StrictMode><TopBar {...base} {...changes} /></StrictMode>))
  const row = container.querySelector('[data-slot="top-bar"]')!
  const stages = [Number(row.getAttribute('data-fold'))]
  for (let pass = 0; frames.size && pass < 10; pass++) {
    const pending = [...frames.values()]
    frames.clear()
    act(() => { for (const callback of pending) callback(pass) })
    const stage = Number(row.getAttribute('data-fold'))
    if (stage !== stages.at(-1)) stages.push(stage)
  }
  expect(frames.size).toBe(0)
  expect(row.getBoundingClientRect().width).toBe(720)
  return stages
}
const expectFloor = (stage: number): void => {
  const row = container.querySelector('[data-slot="top-bar"]')!
  expect(Number(row.getAttribute('data-fold'))).toBe(stage)
  expect(container.querySelector('[data-topbar-title]')!.getBoundingClientRect().width).toBeGreaterThanOrEqual(180)
  expect(container.querySelector('[data-topbar="state"]') === null).toBe(stage > 0)
  expect(container.querySelector('[data-topbar="verb"]')?.textContent).toBe(stage ? '' : 'New job')
  expect(container.querySelector('[role="tablist"]') === null).toBe(stage === 2)
}

test('adding and removing View remeasures the title at the same outer width', () => {
  expect(render({})).toEqual([0])
  expectFloor(0)
  expect(render({ view })).toEqual([0, 1])
  expectFloor(1)
  expect(render({})).toEqual([0])
  expectFloor(0)
})

test('breadcrumb insertion, label changes and removal use the same two fold stages', () => {
  expect(render({})).toEqual([0])
  expectFloor(0)
  expect(render({ parent: { label: 'Teams', run: noop } })).toEqual([0, 1])
  expectFloor(1)
  expect(render({ parent: { label: 'Engineering teams', run: noop } })).toEqual([0, 1, 2])
  expectFloor(2)
  expect(render({ parent: { label: 'Teams', run: noop } })).toEqual([0, 1])
  expectFloor(1)
  expect(render({})).toEqual([0])
  expectFloor(0)
})

test('a fractional title width below 180 uses the first fold to protect the full floor', () => {
  availableTitle = 179.75
  expect(render({})).toEqual([0, 1])
  expectFloor(1)
})

test('a standing tools column remeasures during a seam drag at the same outer width', () => {
  const observed = new Set<Element>()
  let resized = () => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(node: Element) {
      observed.add(node)
      if (node.matches('[data-slot="top-bar"]')) resized = this.callback
    }
    disconnect() {}
  })
  render({ tools: <button>Details</button>, rightColumnWidth: 460 })
  expectFloor(0)
  const tools = container.querySelector('[data-topbar="tools"]')!
  expect(observed.has(tools)).toBe(true)
  expect(observed.has(container.querySelector('[data-topbar-title]')!)).toBe(false)
  availableTitle = 160
  act(() => resized())
  for (let pass = 0; frames.size && pass < 10; pass++) {
    const pending = [...frames.values()]
    frames.clear()
    act(() => { for (const callback of pending) callback(pass) })
  }
  expectFloor(1)
  expect(container.querySelector('[data-slot="top-bar"]')!.getBoundingClientRect().width).toBe(720)
})


test('a refused destination stays reachable with its reason and refuses click and keyboard activation', () => {
  const run = vi.fn()
  render({ tabs: [{ value: 'overview', label: 'Overview', run: noop }, { value: 'run', label: 'Run', disabled: 'This Team has no Run yet', run }] })
  const tab = container.querySelector<HTMLButtonElement>('[data-team-page="run"]')!
  expect(tab.disabled).toBe(false)
  expect(tab.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(tab.getAttribute('aria-describedby')!)?.textContent).toBe('This Team has no Run yet')
  expect(tab.className).not.toContain('aria-disabled:pointer-events-none')
  act(() => tab.focus())
  expect(document.activeElement).toBe(tab)
  act(() => {
    tab.click()
    for (const key of ['Enter', ' ']) tab.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
  expect(run).not.toHaveBeenCalled()
  expect(tab.hasAttribute('data-active')).toBe(false)
})

test('a verb without an icon keeps its words through both folds and expanding restores focused tabs', () => {
  availableTitle = 60
  render({ verb: { label: 'Decide this run', run: noop } })
  expect(container.querySelector('[data-slot="top-bar"]')?.getAttribute('data-fold')).toBe('2')
  expect(container.querySelector('[data-topbar="verb"]')?.textContent).toBe('Decide this run')
  availableTitle = 300
  act(() => resizeCallbacks.forEach(callback => callback()))
  render({ verb: { label: 'Decide this run', run: noop } })
  const tab = container.querySelector<HTMLButtonElement>('[data-team-page="overview"]')!
  act(() => tab.focus())
  availableTitle = 60
  act(() => resizeCallbacks.forEach(callback => callback()))
  render({ verb: { label: 'Decide this run', run: noop } })
  expect(document.activeElement).toBe(container.querySelector('[data-topbar="tabs"] button'))
  availableTitle = 300
  act(() => resizeCallbacks.forEach(callback => callback()))
  render({ verb: { label: 'Decide this run', run: noop } })
  expect(document.activeElement).toBe(container.querySelector('[data-team-page="overview"]'))
  expect(container.querySelector('[data-topbar="state"]')?.textContent).toBe('Ready')
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2)
})
