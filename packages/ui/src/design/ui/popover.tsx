import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import * as React from 'react'

import { DialogFormContext } from '@/lib/dialog-form'
import { cn } from '@/lib/utils'
import { floatingMotion } from './motion'

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
  <DialogFormContext.Provider value={false}>
    <PopoverPrimitive.Popup ref={ref} data-slot="popover-popup" className={surfaceFocus(className)} {...props} />
  </DialogFormContext.Provider>
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
  <DialogFormContext.Provider value={false}>
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="z-(--hd-z-popover)">
      <PopoverPrimitive.Popup
        data-slot="popover-content"
        className={cn(
          floatingMotion,
          'bg-popover text-popover-foreground w-72 rounded-lg border p-4 shadow-md',
          SURFACE_FOCUS,
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Positioner>
  </PopoverPrimitive.Portal>
  </DialogFormContext.Provider>
)

export { Popover, PopoverTrigger, PopoverPortal, PopoverPositioner, PopoverPopup, PopoverContent }
