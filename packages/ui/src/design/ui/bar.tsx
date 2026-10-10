import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * A bar: one row at the height every bar in the window stands at.
 *
 * The window is read along a few horizontal lines — the row under the traffic
 * lights, the row that names a column, a filter row over a list, a facts line
 * under it — and the ordinary bars are `--hd-bar-h` tall, its controls centred, its
 * sides on the bar's own padding. Screens used to spell that row for
 * themselves (a height here, a padding there, an inline style for the corner),
 * which is how one of them ends up a step off the line the eye follows across.
 *
 * Three choices, each a fact about where the bar is rather than a look:
 *
 *   inset   `box` puts the first thing in the bar on the bar's padding — a
 *           control, whose own box carries its ink. `ink` puts it where the
 *           rows below it draw their ink (`--hd-bar-ink`), for a bar that
 *           starts with words standing over a list of navigation rows.
 *   corner  The bar owns the window's top-left corner, so its leading padding
 *           is at least the room the native window buttons take. See
 *           `--titlebar-inset` in `app.css`.
 *   rule    The one hairline that separates the bar from what it heads
 *           (`bottom`) or closes (`top`).
 *   active  The bar heads the pane that has the keyboard among several
 *           shown at once (a room's Side by side tiles): its rule is drawn
 *           in the focus ink, so which pane a key will reach is visible
 *           without a ring around the whole pane.
 *   grow    The bar's height is a floor, not a size: words on it that must
 *           not truncate (a member's name) wrap, and the bar grows to hold
 *           them rather than letting them spill into what it heads.
 *
 * `as="header"` is for a bar that names what is under it — a page's own top
 * row, a column's head — so a screen reader can find it as that region's
 * header rather than as one more box.
 */
const Bar = ({
  as: Element = 'div',
  className,
  inset = 'box',
  corner = false,
  rule,
  paintedRule = false,
  active = false,
  grow = false,
  ...props
}: React.ComponentProps<'div'> & {
  as?: 'div' | 'header' | 'footer'
  inset?: 'box' | 'ink'
  corner?: boolean
  rule?: 'top' | 'bottom'
  /** Paint a seam without consuming a pixel of the controls' region. */
  paintedRule?: boolean
  active?: boolean
  grow?: boolean
}) => (
  <Element
    data-slot="bar"
    data-inset={inset}
    {...(corner ? { 'data-corner': '' } : {})}
    {...(rule ? { 'data-rule': rule } : {})}
    {...(active ? { 'data-active': '' } : {})}
    className={cn(
      'flex shrink-0 items-center gap-(--hd-bar-gap) pr-(--hd-bar-pad)',
      'h-(--hd-bar-h)',
      grow && ['h-auto py-(--hd-space-1)', 'min-h-(--hd-bar-h)'],
      inset === 'box' && (corner ? 'pl-[max(var(--hd-bar-pad),var(--titlebar-inset,0px))]' : 'pl-(--hd-bar-pad)'),
      inset === 'ink' && (corner ? 'pl-[max(var(--hd-bar-ink),var(--titlebar-inset,0px))]' : 'pl-(--hd-bar-ink)'),
      rule === 'bottom' && !paintedRule && 'border-b border-(--hd-border)',
      rule === 'top' && !paintedRule && 'border-t border-(--hd-border)',
      paintedRule && rule && ['relative after:absolute after:pointer-events-none after:inset-x-0 after:h-(--hd-border-width) after:bg-(--hd-border)', rule === 'top' ? 'after:top-0' : 'after:bottom-0'],
      active && rule && (paintedRule ? 'after:bg-(--hd-ring)' : 'border-(--hd-ring)'),
      className,
    )}
    {...props}
  />
)

export { Bar }
