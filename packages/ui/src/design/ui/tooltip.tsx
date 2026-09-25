import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (tooltip). The surface is the platform's own
 * tooltip ground rather than an inverted primary, so it matches the
 * native-feeling tips the rest of the desk already shows. */

const TooltipProvider = ({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider> & { delayDuration?: number }) => (
  <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delayDuration} {...props} />
)

const Tooltip = ({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) => (
  <TooltipProvider>
    <TooltipPrimitive.Root data-slot="tooltip" {...props} />
  </TooltipProvider>
)

const TooltipTrigger = ({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) => (
  <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
)

const TooltipContent = ({
  className,
  sideOffset = 4,
  align = 'center',
  side = 'top',
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> &
  Pick<React.ComponentProps<typeof TooltipPrimitive.Positioner>, 'align' | 'side' | 'sideOffset'>) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Positioner align={align} side={side} sideOffset={sideOffset} className="z-(--hd-z-popover)">
      <TooltipPrimitive.Popup
        data-slot="tooltip-content"
        className={cn(
          'bg-(--hd-tooltip-fill) text-(--hd-tooltip-foreground) data-starting-style:animate-in data-starting-style:fade-in-0 data-starting-style:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 w-fit max-w-72 origin-(--transform-origin) rounded-(--hd-radius-sm) px-2 py-1 text-xs text-balance',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Popup>
    </TooltipPrimitive.Positioner>
  </TooltipPrimitive.Portal>
)

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
