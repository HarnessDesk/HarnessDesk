import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (badge); focus-ring utilities dropped for the
 * app's own single ring — see button.tsx. */

/**
 * A registry badge. The app's own compact state is `Chip`, and its grammar
 * holds here too: one line (`whitespace-nowrap`), and the tone contract in
 * `design/usage.ts` (family `tone`) — `destructive` only for something broken
 * or about to be lost, never for a default or a stop the person asked for.
 */

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-1.5 py-px text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none transition-colors overflow-hidden',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-white',
        outline: 'text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

const Badge = ({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) => (
  <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
)

export { Badge, badgeVariants }
