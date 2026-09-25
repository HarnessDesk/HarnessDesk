import { PreviewCard as HoverCardPrimitive } from '@base-ui/react/preview-card'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (hover-card); z-index and surface from the app's
 * own token names, and the two delays below are the app's rather than the
 * registry's.
 *
 * The surface is the *popover's*, to the letter — `rounded-lg`, one border,
 * `shadow-md` — and not the app's big floating `--hd-shadow`. A hover card
 * opens beside menus, selects and popovers, often over one of them, and a
 * heavier shadow at a larger radius reads as a different class of object
 * lifted further off the page than the menu it is sitting next to. It is the
 * same kind of thing they are: a small surface on the popover layer. The
 * dialog's `--hd-surface-shadow` belongs to something modal that takes the
 * whole window; this takes 288px.
 *
 * A hover card is not a big tooltip. A tooltip repeats a label the row had no
 * room for; a hover card carries facts the surface does not hold at all, and
 * it can be entered and pressed. That difference is what the delays encode:
 *
 *   Open  is slow enough that dragging the pointer down a rail of eight
 *         members fires nothing. The former 700ms default was a beat too long
 *         to feel like a response to a deliberate rest; 420 is the point at
 *         which a pass reads as a pause.
 *   Close is long enough for the pointer to cross the gap into the card and
 *         reach a button. The former 300ms default left a card hanging over
 *         the row after the reader has plainly moved on. 160 with an 8px
 *         offset is comfortably inside the travel time and out of the way.
 *
 * Because the content is reachable, `Portal` matters more here than for a
 * tooltip: a card rendered inside a rail with `overflow: hidden` is clipped
 * at the rail's edge, and the buttons at its foot are the part that goes.
 */

const HOVER_CARD_OPEN_DELAY = 420
const HOVER_CARD_CLOSE_DELAY = 160

/* How far a card reaches out from its trigger: the `w-72` below, which is
 * 18rem, and the gap. Exported for a caller that has to know whether a side
 * has room for a card before it asks for that side — see `AgentHoverCard`. */
const HOVER_CARD_WIDTH_REM = 18
const HOVER_CARD_SIDE_OFFSET = 8

/* The gutter the positioner keeps between a card and the window's edge.
 *
 * The explicit shared value, written down here because a caller measures the room
 * beside a trigger with it too (`roomOn` in `AgentHoverCard`). Nothing crossed
 * the two rulers before: a `collisionPadding` given to the content would have
 * made the positioner the stricter of the two, which is the one direction that
 * produces a *trade* — the card drawn on the side this app did not ask for —
 * with the suite still green. So it is not a prop. The type below refuses one
 * from callers, and both rulers read this number.
 */
const HOVER_CARD_COLLISION_PADDING = 0

const HoverCard = ({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) => (
  <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
)

const HoverCardTrigger = ({
  delay = HOVER_CARD_OPEN_DELAY,
  closeDelay = HOVER_CARD_CLOSE_DELAY,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) => (
  <HoverCardPrimitive.Trigger
    data-slot="hover-card-trigger"
    delay={delay}
    closeDelay={closeDelay}
    {...props}
  />
)

const HoverCardContent = ({
  className,
  align = 'start',
  side = 'right',
  sideOffset = HOVER_CARD_SIDE_OFFSET,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Popup> &
  Pick<React.ComponentProps<typeof HoverCardPrimitive.Positioner>, 'align' | 'side' | 'sideOffset'>) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Positioner
      data-slot="hover-card-positioner"
      align={align}
      side={side}
      sideOffset={sideOffset}
      collisionPadding={HOVER_CARD_COLLISION_PADDING}
      className="z-(--hd-z-popover)"
    >
      <HoverCardPrimitive.Popup
        data-slot="hover-card-content"
        className={cn(
          /* `p-3`, so a card of plain facts — a sentence, a key/value list —
             is never the first thing that has to hand-roll its own inset;
             `AgentHoverCard`'s own fully custom body already cancels it with
             `p-0`, which was written defensively before this default existed
             and still means the same thing now that it does. */
          'bg-popover text-popover-foreground data-starting-style:animate-in data-starting-style:fade-in-0 data-starting-style:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 w-72 origin-(--transform-origin) overflow-hidden rounded-lg border p-3 shadow-md outline-hidden',
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Positioner>
  </HoverCardPrimitive.Portal>
)

export {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
  HOVER_CARD_OPEN_DELAY,
  HOVER_CARD_CLOSE_DELAY,
  HOVER_CARD_WIDTH_REM,
  HOVER_CARD_SIDE_OFFSET,
  HOVER_CARD_COLLISION_PADDING,
}
