import { Tooltip as TooltipPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (tooltip). The surface is the platform's own
 * tooltip ground rather than an inverted primary, so it matches the
 * native-feeling tips the rest of the desk already shows. */

const TooltipProvider = ({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
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
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        'bg-(--hdp-alias-tooltip-bg) text-white animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-(--hd-z-popover) w-fit max-w-72 origin-(--radix-tooltip-content-transform-origin) rounded-md px-2 py-1 text-xs text-balance',
        className,
      )}
      {...props}
    >
      {children}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
)

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
