import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerToastRegion } from './toast-clearance'

const resized = new Set<() => void>()
let region: HTMLDivElement
let release: (() => void) | undefined
const clearance = () => document.body.style.getPropertyValue('--hd-toast-clearance')

beforeEach(() => {
  region = document.createElement('div')
  region.innerHTML = '<ol data-sonner-toaster data-y-position="bottom" data-bottom="700"><li data-sonner-toast data-visible="true" data-height="58" style="--offset: 0px"></li></ol>'
  document.body.append(region)
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { resized.add(callback) }
    observe() { resized.add(this.callback) }
    disconnect() { resized.delete(this.callback) }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, Number(this.dataset['bottom']), 356, 0)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset['height'] ?? 0)
  })
})
afterEach(() => {
  release?.()
  region.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reserves a measured toast and its window inset, and releases it on unmount', () => {
  release = registerToastRegion(region)
  expect(clearance()).toBe(`calc(${window.innerHeight - 700 + 58}px + var(--hd-toast-gap))`)
  release()
  expect(clearance()).toBe('0px')
})

it('updates the lane when a toast grows and keeps room for the expanded visible stack', async () => {
  release = registerToastRegion(region)
  region.querySelector<HTMLElement>('li')!.dataset['height'] = '96'
  for (const resize of resized) resize()
  expect(clearance()).toBe(`calc(${window.innerHeight - 700 + 96}px + var(--hd-toast-gap))`)
  region.querySelector('ol')!.insertAdjacentHTML('beforeend', '<li data-sonner-toast data-visible="true" data-height="80" style="--offset: 110px"></li><li data-sonner-toast data-visible="false" data-height="800" style="--offset: 204px"></li>')
  await Promise.resolve()
  expect(clearance()).toBe(`calc(${window.innerHeight - 700 + 190}px + var(--hd-toast-gap))`)
  region.querySelectorAll('li').forEach(node => node.remove())
  await Promise.resolve()
  expect(clearance()).toBe('0px')
})
