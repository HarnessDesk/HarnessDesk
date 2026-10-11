const SCROLLBAR_VISIBLE_MS = 900

/** Keep the shared scrollbar thumb visible only for a short time after a region moves. */
export const installOverlayScrollbarTracking = (documentRoot: Document = document): (() => void) => {
  const view = documentRoot.defaultView
  if (!view) return () => {}

  const timers = new Map<HTMLElement, number>()
  const onScroll = (event: Event): void => {
    const target = event.target
    if (!(target instanceof view.HTMLElement)) return
    const style = view.getComputedStyle(target)
    const vertical = /^(auto|scroll|overlay)$/.test(style.overflowY) && target.scrollHeight > target.clientHeight
    const horizontal = /^(auto|scroll|overlay)$/.test(style.overflowX) && target.scrollWidth > target.clientWidth
    if (!vertical && !horizontal) return

    target.setAttribute('data-scrolling', '')
    const previous = timers.get(target)
    if (previous !== undefined) view.clearTimeout(previous)
    timers.set(target, view.setTimeout(() => {
      target.removeAttribute('data-scrolling')
      timers.delete(target)
    }, SCROLLBAR_VISIBLE_MS))
  }

  documentRoot.addEventListener('scroll', onScroll, true)
  return () => {
    documentRoot.removeEventListener('scroll', onScroll, true)
    for (const [region, timer] of timers) {
      view.clearTimeout(timer)
      region.removeAttribute('data-scrolling')
    }
    timers.clear()
  }
}
