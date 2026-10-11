import { afterEach, beforeEach, vi } from 'vitest'
import { FRAME } from '../design/frame'

/** Publication/action tests need a title with room; jsdom has no flex layout. */
export const installTopBarTestLayout = (): void => {
  let restore: () => void
  beforeEach(() => {
    const bounds = Element.prototype.getBoundingClientRect
    const geometry = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.matches('[data-topbar-title]') ? new DOMRect(0, 0, FRAME.bar.titleMin, FRAME.bar.height)
        : this.matches('[data-topbar="place"]') ? new DOMRect(0, 0, 300, FRAME.bar.height) : bounds.call(this)
    })
    const noLayout = document.createElement('div').style
    const computed = getComputedStyle
    const token = vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((node, pseudo) => {
      // The retained composer now mounts beneath page specimens. jsdom has
      // no track geometry or loaded token cascade; measuring that empty track
      // repeatedly walks the full frame's descendants for every control.
      if (node.matches('[data-slot="composer-tools"]')) return noLayout
      const result = computed(node, pseudo)
      if (!node.matches('[data-slot="top-bar"]')) return result
      return new Proxy(result, { get(target, property) {
        if (property === 'getPropertyValue') return (name: string) => name === '--hd-bar-title-min'
          ? `${FRAME.bar.titleMin}px` : target.getPropertyValue(name)
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    })
    restore = () => { token.mockRestore(); geometry.mockRestore() }
  })
  afterEach(() => restore())
}
