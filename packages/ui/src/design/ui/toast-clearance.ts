/**
 * A floating result must not take a page's pointer targets. Reserve the visible
 * stack's measured expanded extent, so hovering an older result cannot cover
 * newly exposed controls. Sonner owns its heights and offsets; this bridge
 * publishes their geometry just as composer-toast-offset publishes dock space.
 */
const regions = new Set<HTMLElement>()
let resize: ResizeObserver | undefined
let mutation: MutationObserver | undefined

const publish = (): void => {
  let clearance = 0
  for (const region of regions) {
    for (const stack of region.querySelectorAll<HTMLElement>('[data-sonner-toaster][data-y-position="bottom"]')) {
      const box = stack.getBoundingClientRect()
      if (box.width <= 0 || getComputedStyle(stack).visibility === 'hidden') continue
      for (const toast of stack.querySelectorAll<HTMLElement>('[data-sonner-toast]:not([data-visible="false"])')) {
        // offsetHeight ignores the collapsed stack's transform; initial-height
        // also retains an older result's own height while Sonner collapses it.
        const height = parseFloat(toast.style.getPropertyValue('--initial-height')) || toast.offsetHeight
        const offset = parseFloat(toast.style.getPropertyValue('--offset')) || 0
        if (height > 0) clearance = Math.max(clearance, window.innerHeight - box.bottom + height + offset)
      }
    }
  }
  const value = clearance > 0 ? `calc(${clearance}px + var(--hd-toast-gap))` : '0px'
  if (document.body.style.getPropertyValue('--hd-toast-clearance') !== value) {
    document.body.style.setProperty('--hd-toast-clearance', value)
  }
}

const observe = (): void => {
  resize?.disconnect()
  mutation?.disconnect()
  // A composer can move the global stack without changing a result's size.
  mutation?.observe(document.body, { attributes: true, attributeFilter: ['style'] })
  for (const region of regions) {
    mutation?.observe(region, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-visible', 'hidden', 'class'] })
    for (const node of region.querySelectorAll<HTMLElement>('[data-sonner-toaster], [data-sonner-toast]')) resize?.observe(node)
  }
}

export const registerToastRegion = (region: HTMLElement): (() => void) => {
  if (!resize) {
    resize = new ResizeObserver(publish)
    mutation = new MutationObserver(() => { observe(); publish() })
    window.addEventListener('resize', publish)
  }
  regions.add(region)
  observe()
  publish()
  return () => {
    regions.delete(region)
    observe()
    publish()
    if (regions.size === 0) {
      resize?.disconnect()
      mutation?.disconnect()
      resize = undefined
      mutation = undefined
      window.removeEventListener('resize', publish)
    }
  }
}
