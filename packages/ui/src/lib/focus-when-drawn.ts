/**
 * Brings the element a selector names into view and focus as soon as it is drawn: now when it is already there, else
 * when it arrives (a section reads its own view, a rail's contents land through an outlet a commit later). Gives up
 * after `waitMs`. Returns a cancel for an effect's cleanup.
 */
export const focusWhenDrawn = (selector: string, shown: (element: HTMLElement) => void, waitMs = 5_000): (() => void) => {
  const show = (element: HTMLElement) => { element.scrollIntoView?.({ block: 'center' }); element.focus({ preventScroll: true }); shown(element) }
  const now = document.querySelector<HTMLElement>(selector)
  if (now) { show(now); return () => {} }
  const watch = new MutationObserver(() => { const found = document.querySelector<HTMLElement>(selector); if (found) { stop(); show(found) } })
  const give = setTimeout(() => watch.disconnect(), waitMs)
  const stop = () => { watch.disconnect(); clearTimeout(give) }
  watch.observe(document.body, { childList: true, subtree: true })
  return stop
}
