/**
 * Asked of a folded card that holds a row a door wants to show: the event bubbles from the row, and a card that folds
 * (`ToolSection`) unfolds on hearing it. A row inside a `hidden` body cannot take focus, so the person would see nothing.
 */
export const REVEAL_FOLDED_EVENT = 'hd-reveal-folded'
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
 * focused instead. A row drawn inside a folded card asks the card to unfold (`REVEAL_FOLDED_EVENT`) and is focused once
 * it is shown; a card that does not unfold leaves the person on the fallback when the wait ends. Returns the cancel.
 */
export const focusWhenDrawn = (selector: string, shown: (element: HTMLElement) => void, options: FocusWhenDrawnOptions = {}): (() => void) => {
  const { fallback = [], gone, waitMs = 5_000 } = options
  const show = (element: HTMLElement) => { element.scrollIntoView?.({ block: 'center' }); element.focus({ preventScroll: true }); shown(element) }
  const landing = () => fallback.map(one => document.querySelector<HTMLElement>(one)).find(Boolean) ?? null
  // True when the look is over: the row was focused, or the row is gone and the person landed beside it.
  const look = (final: boolean): boolean => {
    const found = document.querySelector<HTMLElement>(selector), folded = !!found?.closest('[hidden]')
    if (found && !folded) { show(found); return true }
    if (found && !final) { found.dispatchEvent(new Event(REVEAL_FOLDED_EVENT, { bubbles: true })); return false }
    if (!found && !final && !gone?.()) return false
    const beside = landing()
    if (beside) { beside.scrollIntoView?.({ block: 'nearest' }); beside.focus({ preventScroll: true }) }
    return !!beside || final
  }
  if (look(false)) return () => {}
  const watch = new MutationObserver(() => { if (look(false)) stop() })
  const give = setTimeout(() => { watch.disconnect(); look(true) }, waitMs)
  const stop = () => { watch.disconnect(); clearTimeout(give) }
  // A fold opening only takes `hidden` off its body, so that attribute is watched as well as what is drawn.
  watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
  return stop
}
