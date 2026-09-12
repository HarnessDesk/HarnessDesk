/**
 * The dismissal contract: how something that takes the screen gets the
 * floating things under it out of the way, and who answers one Escape.
 *
 * Two questions, one contract, because the bugs behind them are one bug — a
 * layer that floats without taking part. A menu left open over a window paints
 * across a surface it cannot be clicked through; a window that answers Escape
 * ahead of the menu open inside it closes both on one press. So the rules live
 * here, once, rather than in each surface's own `document` listener, which is
 * where they were and where they disagreed.
 *
 * Deliberately free of React and of the app: the primitives are a subscribe and
 * a push, so a component anywhere can take part — including the vendored Radix
 * menus in `design/ui`, which cannot reach `components/`.
 * `components/Popover.tsx` wraps both as hooks.
 */

/**
 * "Something took the screen." A modal announces itself so every floating
 * panel closes, because a panel outranks the modal layer by design and
 * would otherwise be painted over a dialog it cannot be clicked through.
 */
export const DISMISS_OVERLAYS = 'hd:dismiss-overlays'

export interface DismissDetail {
  /**
   * For a caller that gives focus back, when it goes, to what had it when it
   * came: a menu holding focus hands it to its trigger first. The floating
   * sidebar asks; Settings and Usage do not, because they take no focus of
   * their own and focus handed to a trigger behind them answered Enter by
   * opening the menu again, above the window.
   */
  readonly returnFocus?: boolean
}

/**
 * Called by anything that takes the whole window — a dialog, a palette — and
 * by a sidebar laid over a narrow window's conversation, both ways.
 */
export const dismissOverlays = ({ returnFocus = false }: DismissDetail = {}): void => {
  document.dispatchEvent(new CustomEvent(DISMISS_OVERLAYS, { detail: { returnFocus } }))
}

/** Hears the dismissal until the function it answers with is called. */
export const onDismissOverlays = (handler: (detail: DismissDetail) => void): (() => void) => {
  const listen = (event: Event): void => {
    handler((event as CustomEvent<DismissDetail | null>).detail ?? {})
  }
  document.addEventListener(DISMISS_OVERLAYS, listen)
  return () => document.removeEventListener(DISMISS_OVERLAYS, listen)
}

/* ------------------------------------------------------------------ Escape */

/**
 * Every surface that answers Escape, the one on top last.
 *
 * "One Escape closes one thing" is only true if the surfaces agree an order,
 * and listeners on a node run in the order they were *added* — which is the
 * order things opened, not the order they are stacked. Settings registered its
 * handler when the window mounted and a menu opened inside it registered later,
 * so the window answered first, found nothing spent, and closed itself along
 * with the menu (#206). A stack read from the top is what `Dialog` already does
 * among dialogs; this is the same list for the surfaces outside it.
 *
 * A surface answers `true` when it took the key, and `false` to pass it down —
 * for one that is on the stack but has nothing to close.
 */
const SURFACES: Array<() => boolean> = []

/**
 * The one listener: on the window, in the bubble phase, registered as this
 * module is evaluated rather than when a surface opens. Both halves are
 * load-bearing.
 *
 *   On the window, bubbling, it runs after every listener on `document`, which
 *   is where menus put theirs. A menu spends the key with `preventDefault` and
 *   is therefore heard first, whenever it happened to open.
 *
 *   At module scope, it precedes every listener a component adds in an effect.
 *   The approval card and the floating sidebar stand aside for a key something
 *   else has spent, and they can only do that if the thing spending it has
 *   already run. Registered on first use, this would sit after whichever of
 *   them opened earlier — and Escape over an open Settings window would deny a
 *   command nobody can see.
 */
const onKeyDown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  for (let at = SURFACES.length - 1; at >= 0; at -= 1) {
    if (SURFACES[at]?.() === true) {
      // Said out loud, so whatever this covers — a sidebar floating under it,
      // an approval pending in the pane behind it — knows the key is gone.
      event.preventDefault()
      return
    }
  }
}

if (typeof window !== 'undefined') window.addEventListener('keydown', onKeyDown)

/**
 * Joins the stack as the surface on top, until the function it answers with is
 * called. `answer` runs only while nothing above it took the key, and says
 * whether it took the key itself.
 */
export const escapeSurface = (answer: () => boolean): (() => void) => {
  SURFACES.push(answer)
  return () => {
    const at = SURFACES.indexOf(answer)
    if (at !== -1) SURFACES.splice(at, 1)
  }
}
