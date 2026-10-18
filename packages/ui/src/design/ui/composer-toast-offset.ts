/**
 * Composer docks can live in separate panes, while Sonner lives beside them
 * at app level. Publish their greatest visible clearance on the app root (body)
 * so the floating stack clears every dock, including its inset from the window
 * bottom. Hidden, cached pages contribute no geometry. The gap remains a token.
 */
const docks = new Set<HTMLElement>()
let observer: ResizeObserver | undefined
let visibility: MutationObserver | undefined

const publish = (): void => {
  let clearance = 0
  for (const dock of docks) {
    const rect = dock.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(dock).visibility === 'hidden') continue
    clearance = Math.max(clearance, window.innerHeight - rect.top)
  }
  const value = clearance > 0
    ? `calc(${clearance}px + var(--hd-toast-gap))`
    : 'var(--hd-toast-gap)'
  // Tokens live on body. Write only when changed so observing an ancestor's
  // style (including this one) cannot create a mutation-observer feedback loop.
  if (document.body.style.getPropertyValue('--hd-toast-bottom') !== value) {
    document.body.style.setProperty('--hd-toast-bottom', value)
  }
}

// Retained work panes keep their size while hidden. Observe their ancestors'
// visibility attributes as well as size.
const watchVisibility = (): void => {
  visibility?.disconnect()
  for (const dock of docks) {
    for (let node: HTMLElement | null = dock; node && node !== document.documentElement; node = node.parentElement) {
      visibility?.observe(node, { attributes: true, attributeFilter: ['hidden', 'data-hidden', 'inert', 'class', 'style'] })
    }
  }
}

export const registerComposerDock = (dock: HTMLElement): (() => void) => {
  if (!observer) {
    observer = new ResizeObserver(publish)
    visibility = new MutationObserver(publish)
    window.addEventListener('resize', publish)
  }
  docks.add(dock)
  watchVisibility()
  observer.observe(dock, { box: 'border-box' })
  publish()
  return () => {
    observer?.unobserve(dock)
    docks.delete(dock)
    watchVisibility()
    publish()
    if (docks.size === 0) {
      observer?.disconnect()
      observer = undefined
      visibility = undefined
      window.removeEventListener('resize', publish)
    }
  }
}
