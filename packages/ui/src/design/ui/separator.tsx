import { Separator as SeparatorPrimitive } from '@base-ui/react/separator'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (separator). */

const Separator = ({
  className,
  orientation = 'horizontal',
  decorative = true,
  length,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive> & { decorative?: boolean; length?: 'bar' }) => (
  <SeparatorPrimitive
    data-slot="separator"
    {...(decorative ? { role: 'none' } : {})}
    orientation={orientation}
    className={cn(
      length === 'bar'
        ? 'shrink-0 bg-[var(--hd-border)] h-[var(--hd-bar-divider-h)] w-[var(--hd-border-width)]'
        : 'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
      className,
    )}
    {...props}
  />
)

export { Separator }
