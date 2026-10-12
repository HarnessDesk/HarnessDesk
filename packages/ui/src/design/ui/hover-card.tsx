import { PreviewCard as HoverCardPrimitive } from '@base-ui/react/preview-card'
import * as React from 'react'
import { useState, useEffect } from 'react'
import { menusOpen, useMenusOpen } from './popup-state'

import { DialogFormContext } from '@/lib/dialog-form'
import { floatingMotion } from './motion'

/* Vendored preview-card behavior with the frame's typed information plate.
 * Facts open after a deliberate 420ms rest, and stay for the 160ms trip into
 * the card. A portal avoids the rail's clipping boundary. Menus suppress the
 * plate through popup-state; factual content offers no action controls. */

const HOVER_CARD_OPEN_DELAY = 420
const HOVER_CARD_CLOSE_DELAY = 160

/* Retained compatibility export; actual placement reads --hd-info-card-width. */
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

const HoverCardIntent = React.createContext<(() => void) | undefined>(undefined)

const HoverCard = ({ open: controlledOpen, defaultOpen, onOpenChange, ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) => {
  const blocked = useMenusOpen()
  const [localOpen, setLocalOpen] = useState(defaultOpen ?? false)
  const [disarmed, setDisarmed] = useState(false)
  const disarmedRef = React.useRef(false)
  useEffect(() => { if (blocked) { disarmedRef.current = true; setLocalOpen(false); setDisarmed(true) } }, [blocked])
  const arm = React.useCallback(() => {
    if (!menusOpen()) { disarmedRef.current = false; setDisarmed(false) }
  }, [])
  return <HoverCardIntent.Provider value={arm}><HoverCardPrimitive.Root {...props} open={!blocked && !disarmed && (controlledOpen ?? localOpen)} data-slot="hover-card"
    onOpenChange={(next, details) => {
      if (next && (menusOpen() || disarmedRef.current)) { details.cancel(); return }
      onOpenChange?.(next, details)
      if (details.isCanceled) return
      setLocalOpen(next)
    }} /></HoverCardIntent.Provider>
}


const HoverCardTrigger = ({
  delay = HOVER_CARD_OPEN_DELAY,
  closeDelay = HOVER_CARD_CLOSE_DELAY,
  onPointerEnter,
  onFocus,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) => {
  const arm = React.useContext(HoverCardIntent)
  return (
  <HoverCardPrimitive.Trigger
    data-slot="hover-card-trigger"
    delay={delay}
    closeDelay={closeDelay}
    onPointerEnter={event => { arm?.(); onPointerEnter?.(event) }}
    onFocus={event => { arm?.(); onFocus?.(event) }}
    {...props}
  />
  )
}

const HoverCardContent = ({ align = 'start', side = 'right', sideOffset = HOVER_CARD_SIDE_OFFSET, ...props }:
  Omit<React.ComponentProps<typeof HoverCardPrimitive.Popup>, 'className' | 'style'> &
  Pick<React.ComponentProps<typeof HoverCardPrimitive.Positioner>, 'align' | 'side' | 'sideOffset'>) => (
  <HoverCardPrimitive.Portal><HoverCardPrimitive.Positioner data-slot="hover-card-positioner" align={align} side={side} sideOffset={sideOffset} collisionPadding={HOVER_CARD_COLLISION_PADDING} className="z-(--hd-z-popover)">
    <DialogFormContext.Provider value={false}><HoverCardPrimitive.Popup {...props} data-slot="hover-card-content" data-popup-kind="info-card" className={floatingMotion} /></DialogFormContext.Provider>
  </HoverCardPrimitive.Positioner></HoverCardPrimitive.Portal>
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
