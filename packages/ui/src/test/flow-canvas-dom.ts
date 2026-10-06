import { vi } from 'vitest'

/** jsdom has no layout; supply the browser measurements the real canvas needs. */
export const canvasDOM = () => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('react-flow__node') ? 232 : 1440 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('react-flow__node') ? 130 : 600 })
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: HTMLElement) { this.callback([{ target, contentRect: { width: target.offsetWidth, height: target.offsetHeight }, borderBoxSize: [{ inlineSize: target.offsetWidth, blockSize: target.offsetHeight }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver) }
    unobserve() {} disconnect() {}
  })
}
