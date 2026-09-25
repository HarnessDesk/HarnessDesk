/**
 * How a surface arrives and leaves — said once, for every overlay.
 *
 * Base UI marks an opening surface `data-starting-style` for its first frame
 * and a closing one `data-ending-style` until its exit has finished, and it
 * waits for a running transition before it unmounts. So the answer is a
 * transition from those two states, never a keyframe animation keyed on them:
 * the starting attribute is gone a frame later, and an animation declared on
 * it is removed with it, which is how every menu in the app used to cut in
 * rather than arrive.
 *
 * The values are the motion tokens (`tokens.css`, "motion"): an entrance on
 * `--hd-ease-out` over `--hd-duration-enter`, an exit on `--hd-ease-in` over
 * the shorter `--hd-duration-exit`, growing from `--hd-motion-scale` toward
 * the trigger (`--transform-origin` is Base UI's, set on the positioner).
 * `prefers-reduced-motion` takes both to an instant in app.css.
 */

/** A floating surface anchored to a trigger: a menu, a popover, a select, a tooltip, a hover card. */
export const floatingMotion =
  'origin-(--transform-origin) transition-[opacity,scale] duration-(--hd-duration-enter) ease-(--hd-ease-out) data-starting-style:opacity-0 data-starting-style:scale-(--hd-motion-scale) data-ending-style:opacity-0 data-ending-style:scale-(--hd-motion-scale) data-ending-style:duration-(--hd-duration-exit) data-ending-style:ease-(--hd-ease-in)'

/** A surface centred over the window: a dialog. It grows from its own middle. */
export const modalMotion =
  'transition-[opacity,scale] duration-(--hd-duration-enter) ease-(--hd-ease-out) data-starting-style:opacity-0 data-starting-style:scale-(--hd-motion-scale) data-ending-style:opacity-0 data-ending-style:scale-(--hd-motion-scale) data-ending-style:duration-(--hd-duration-exit) data-ending-style:ease-(--hd-ease-in)'

/** The scrim behind a dialog: it only fades. */
export const scrimMotion =
  'transition-opacity duration-(--hd-duration-enter) ease-(--hd-ease-out) data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--hd-duration-exit) data-ending-style:ease-(--hd-ease-in)'

/**
 * A block that appears in place when something opens — a fold's body, a
 * disclosure's detail. It rises one step into place as it fades in, from CSS
 * `@starting-style`, so it needs no state of its own and a block rendered on
 * first paint does the same. Leaving is instant: the fold is already closing.
 */
export const revealMotion =
  'transition-[opacity,translate] duration-(--hd-duration-enter) ease-(--hd-ease-out) starting:opacity-0 starting:translate-y-(--hd-motion-rise)'
