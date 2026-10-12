import { Separator as SeparatorPrimitive } from '@base-ui/react/separator'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (separator). */

const Separator = ({
  className,
  orientation = 'horizontal',
  decorative = true,
  painted = true,
  length,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive> & { decorative?: boolean; length?: 'bar'; painted?: boolean }) => (
  <SeparatorPrimitive
    data-slot="separator"
    {...(decorative ? { role: 'none' } : {})}
    orientation={orientation}
    className={cn(
      painted ? (length === 'bar' ? 'bg-[var(--hd-border)]' : 'bg-border') : 'bg-transparent',
      length === 'bar'
        ? 'shrink-0 h-[var(--hd-bar-divider-h)] w-[var(--hd-border-width)]'
        : 'shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
      className,
    )}
    {...props}
  />
)

export { Separator }
