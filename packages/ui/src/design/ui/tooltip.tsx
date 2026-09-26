import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import { floatingMotion } from './motion'

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
  // Passed through so one Tooltip can follow a target that changes without a
  // Trigger of its own — a rail of marks too dense to give each one a real
  // control, where the "trigger" is really whichever mark is active.
  anchor,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> &
  Pick<React.ComponentProps<typeof TooltipPrimitive.Positioner>, 'align' | 'side' | 'sideOffset' | 'anchor'>) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Positioner
      align={align}
      side={side}
      sideOffset={sideOffset}
      {...(anchor === undefined ? {} : { anchor })}
      className="z-(--hd-z-popover)"
    >
      <TooltipPrimitive.Popup
        data-slot="tooltip-content"
        className={cn(
          floatingMotion,
          'bg-(--hd-tooltip-fill) text-(--hd-tooltip-foreground) w-fit max-w-72 rounded-(--hd-radius-sm) px-2 py-1 text-xs text-balance',
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
