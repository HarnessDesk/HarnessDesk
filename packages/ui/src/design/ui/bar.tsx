import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * A bar: one row at the height every bar in the window stands at.
 *
 * The window is read along a few horizontal lines — the row under the traffic
 * lights, the row that names a column, a filter row over a list, a facts line
 * under it — and each of them is `--hd-bar-h` tall, its controls centred, its
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
  ...props
}: React.ComponentProps<'div'> & {
  as?: 'div' | 'header'
  inset?: 'box' | 'ink'
  corner?: boolean
  rule?: 'top' | 'bottom'
}) => (
  <Element
    data-slot="bar"
    data-inset={inset}
    {...(corner ? { 'data-corner': '' } : {})}
    {...(rule ? { 'data-rule': rule } : {})}
    className={cn(
      'flex h-(--hd-bar-h) shrink-0 items-center gap-(--hd-bar-gap) pr-(--hd-bar-pad)',
      inset === 'box' && (corner ? 'pl-[max(var(--hd-bar-pad),var(--titlebar-inset,0px))]' : 'pl-(--hd-bar-pad)'),
      inset === 'ink' && (corner ? 'pl-[max(var(--hd-bar-ink),var(--titlebar-inset,0px))]' : 'pl-(--hd-bar-ink)'),
      rule === 'bottom' && 'border-b border-(--hd-border)',
      rule === 'top' && 'border-t border-(--hd-border)',
      className,
    )}
    {...props}
  />
)

export { Bar }
