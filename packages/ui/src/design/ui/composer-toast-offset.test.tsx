import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ComposerDock } from './composer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
const resized = new Set<() => void>()
const appOffset = () => document.body.style.getPropertyValue('--hd-toast-bottom')

beforeEach(() => {
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
  act(() => { for (const update of resized) update() })
  expect(appOffset()).toBe('calc(200px + var(--hd-toast-gap))')
  dock.hidden = true
  act(() => { for (const update of resized) update() })
  expect(appOffset()).toBe('var(--hd-toast-gap)')
  dock.hidden = false
  act(() => { window.dispatchEvent(new Event('resize')) })
  expect(appOffset()).toBe('calc(200px + var(--hd-toast-gap))')
})

it('clears and restores a retained pane hidden with visibility, without resizing its dock', async () => {
  act(() => root.render(<div><ComposerDock data-height="140" /></div>))
  const pane = container.firstElementChild as HTMLElement
  await act(async () => { pane.style.visibility = 'hidden' })
  expect(appOffset()).toBe('var(--hd-toast-gap)')
  await act(async () => { pane.style.visibility = '' })
  expect(appOffset()).toBe('calc(140px + var(--hd-toast-gap))')
})
