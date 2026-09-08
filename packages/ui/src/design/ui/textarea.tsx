import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (textarea); ring utilities dropped for the app's
 * own focus outline. */

const Textarea = ({ className, ...props }: React.ComponentProps<'textarea'>) => (
  <textarea
    data-slot="textarea"
    spellCheck={false}
    className={cn(
      'border-input placeholder:text-muted-foreground flex field-sizing-content min-h-14 w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50',
      'aria-invalid:border-destructive dark:bg-input/30',
      className,
    )}
    {...props}
  />
)

export { Textarea }
