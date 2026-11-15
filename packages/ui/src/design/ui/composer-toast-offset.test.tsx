import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ComposerDock } from './composer'
import { registerToastRegion } from './toast-clearance'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
const resized = new Set<() => void>()
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
const flushFrames = () => {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(callback => callback(0))
}
const appOffset = () => document.body.style.getPropertyValue('--hd-toast-bottom')

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { resized.add(callback) }
    observe() {}
    unobserve() {}
    disconnect() { resized.delete(this.callback) }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.hidden ? 0 : Number(this.dataset['height'] ?? 0)
    const bottom = window.innerHeight - Number(this.dataset['inset'] ?? 0)
    return new DOMRect(0, bottom - height, height ? 500 : 0, height)
  })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reports a mounted dock height plus its bottom inset and the gap at app level', () => {
  act(() => root.render(<ComposerDock data-height="120" data-inset="20" />))
  expect(appOffset()).toBe('calc(140px + var(--hd-toast-gap))')
  expect(document.body.style.getPropertyValue('--hd-composer-clearance')).toBe('140px')
})

it('uses the taller dock, drops it on unmount, and returns to the gap without composers', () => {
  act(() => root.render(<><ComposerDock key="short" data-height="80" /><ComposerDock key="tall" data-height="180" /></>))
  expect(appOffset()).toBe('calc(180px + var(--hd-toast-gap))')
  act(() => root.render(<ComposerDock key="short" data-height="80" />))
  expect(appOffset()).toBe('calc(80px + var(--hd-toast-gap))')
  act(() => root.render(null))
  expect(appOffset()).toBe('var(--hd-toast-gap)')
  expect(document.body.style.getPropertyValue('--hd-composer-clearance')).toBe('0px')
})

it('updates resized docks and excludes hidden docks until they show again', () => {
  act(() => root.render(<ComposerDock data-height="100" />))
  const dock = container.firstElementChild as HTMLElement
  dock.dataset['height'] = '200'
  act(() => { for (const update of resized) update(); flushFrames() })
  expect(appOffset()).toBe('calc(200px + var(--hd-toast-gap))')
  dock.hidden = true
  act(() => { for (const update of resized) update(); flushFrames() })
  expect(appOffset()).toBe('var(--hd-toast-gap)')
  dock.hidden = false
  act(() => { window.dispatchEvent(new Event('resize')); flushFrames() })
  expect(appOffset()).toBe('calc(200px + var(--hd-toast-gap))')
})

it('clears and restores a retained pane hidden with visibility, without resizing its dock', async () => {
  act(() => root.render(<div><ComposerDock data-height="140" /></div>))
  const pane = container.firstElementChild as HTMLElement
  await act(async () => { pane.style.visibility = 'hidden'; await Promise.resolve(); flushFrames() })
  expect(appOffset()).toBe('var(--hd-toast-gap)')
  await act(async () => { pane.style.visibility = ''; await Promise.resolve(); flushFrames() })
  expect(appOffset()).toBe('calc(140px + var(--hd-toast-gap))')
})

it('refreshes a position-only shift when a toast is inserted', async () => {
  act(() => root.render(<ComposerDock data-height="100" />))
  const dock = container.firstElementChild as HTMLElement
  await act(async () => { await Promise.resolve(); flushFrames(); await Promise.resolve(); flushFrames() })
  const region = document.createElement('div')
  document.body.append(region)
  const release = registerToastRegion(region)
  await act(async () => { await Promise.resolve(); flushFrames(); await Promise.resolve(); flushFrames() })
  try {
    // Change mock geometry without changing any observed attribute.
    const rect = vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, window.innerHeight - 180, 500, 100))
    expect(appOffset()).toBe('calc(100px + var(--hd-toast-gap))')
    region.innerHTML = '<ol data-sonner-toaster data-y-position="bottom"><li data-sonner-toast></li></ol>'
    await act(async () => { await Promise.resolve() })
    expect(rect).toHaveBeenCalled()
    expect(appOffset()).toBe('calc(180px + var(--hd-toast-gap))')
  } finally { release(); region.remove() }
})

it('coalesces observer and resize callbacks into one read per dock per frame and cancels on teardown', async () => {
  act(() => root.render(<><ComposerDock key="a" data-height="80" /><ComposerDock key="b" data-height="120" /></>))
  await act(async () => { await Promise.resolve(); flushFrames(); await Promise.resolve() })
  const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
  measure.mockClear()
  const pane = container
  await act(async () => {
    pane.style.width = '100px'
    await Promise.resolve()
    pane.style.width = '200px'
    await Promise.resolve()
    for (const update of resized) update()
    window.dispatchEvent(new Event('resize'))
  })
  expect(measure).not.toHaveBeenCalled()
  expect(frames.size).toBe(1)
  act(() => flushFrames())
  expect(measure).toHaveBeenCalledTimes(2)
  act(() => { window.dispatchEvent(new Event('resize')); root.render(null) })
  expect(frames.size).toBe(0)
  expect(appOffset()).toBe('var(--hd-toast-gap)')
})
