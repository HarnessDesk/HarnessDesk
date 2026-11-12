export type FocusWhenDrawnOptions = {
  /** Where the person lands when the row is gone: the first of these drawn, its section's heading or the card it was in. */
  readonly fallback?: readonly string[]
  /** True once the data the row comes from has arrived without it: land on the fallback now rather than wait. */
  readonly gone?: () => boolean
  readonly waitMs?: number
}

/**
 * Focuses the first element matching `selector`, now or as soon as it is drawn. A door can open a page whose rows arrive
 * after it does: a rail opening, a settings list read on mount. A row that never comes (a note forgotten, a reminder
 * cancelled) does not leave the person nowhere: once `gone` says so, or the wait ends, the first `fallback` drawn is
 * focused instead. Returns the cancel.
 */
export const focusWhenDrawn = (selector: string, shown: (element: HTMLElement) => void, options: FocusWhenDrawnOptions = {}): (() => void) => {
  const { fallback = [], gone, waitMs = 5_000 } = options
  const show = (element: HTMLElement) => { element.scrollIntoView?.({ block: 'center' }); element.focus({ preventScroll: true }); shown(element) }
  const landing = () => fallback.map(one => document.querySelector<HTMLElement>(one)).find(Boolean) ?? null
  // True when the look is over: the row was focused, or the row is gone and the person landed beside it.
  const look = (final: boolean): boolean => {
    const found = document.querySelector<HTMLElement>(selector)
    if (found) { show(found); return true }
    if (!final && !gone?.()) return false
    const beside = landing()
    if (beside) { beside.scrollIntoView?.({ block: 'nearest' }); beside.focus({ preventScroll: true }) }
    return !!beside || final
  }
  if (look(false)) return () => {}
  const watch = new MutationObserver(() => { if (look(false)) stop() })
  const give = setTimeout(() => { watch.disconnect(); look(true) }, waitMs)
  const stop = () => { watch.disconnect(); clearTimeout(give) }
  watch.observe(document.body, { childList: true, subtree: true })
  return stop
}
