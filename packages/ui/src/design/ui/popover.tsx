import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (popover); z-index from the app's layer names. */

const Popover = ({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) => (
  <PopoverPrimitive.Root data-slot="popover" {...props} />
)

const PopoverTrigger = ({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) => (
  <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
)

const PopoverPortal = ({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Portal>) => (
  <PopoverPrimitive.Portal data-slot="popover-portal" {...props} />
)

const PopoverPositioner = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Positioner>,
  React.ComponentProps<typeof PopoverPrimitive.Positioner>
>(({ ...props }, ref) => (
  <PopoverPrimitive.Positioner ref={ref} data-slot="popover-positioner" {...props} />
))
PopoverPositioner.displayName = 'PopoverPositioner'

/* A surface that takes focus wears no ring; see `SURFACE_FOCUS` in dialog.tsx. */
const SURFACE_FOCUS = 'outline-none focus-visible:outline-none'
const surfaceFocus = <S,>(className: string | ((state: S) => string | undefined) | undefined) =>
  typeof className === 'function' ? (state: S) => cn(SURFACE_FOCUS, className(state)) : cn(SURFACE_FOCUS, className)

const PopoverPopup = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Popup>,
  React.ComponentProps<typeof PopoverPrimitive.Popup>
>(({ className, ...props }, ref) => (
  <PopoverPrimitive.Popup ref={ref} data-slot="popover-popup" className={surfaceFocus(className)} {...props} />
))
PopoverPopup.displayName = 'PopoverPopup'

const PopoverContent = ({
  className,
  align = 'center',
  sideOffset = 4,
  side = 'bottom',
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> &
  Pick<React.ComponentProps<typeof PopoverPrimitive.Positioner>, 'align' | 'side' | 'sideOffset'>) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="z-(--hd-z-popover)">
      <PopoverPrimitive.Popup
        data-slot="popover-content"
        className={cn(
          'bg-popover text-popover-foreground data-starting-style:animate-in data-starting-style:fade-in-0 data-starting-style:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 w-72 origin-(--transform-origin) rounded-lg border p-4 shadow-md',
          SURFACE_FOCUS,
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Positioner>
  </PopoverPrimitive.Portal>
)

export { Popover, PopoverTrigger, PopoverPortal, PopoverPositioner, PopoverPopup, PopoverContent }
