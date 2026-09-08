import type * as React from 'react'

import { CaretIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'

/*
 * A real <select>, dressed as the shadcn trigger.
 *
 * Not upstream shadcn, and deliberately so: radix's Select is a fine menu
 * and a poor citizen of tests and forms — jsdom cannot open it, and a
 * change event means nothing to it. Where the picker is plumbing rather
 * than presentation (the Team composer's recipient, a settings filter), the
 * platform's own element does everything needed; this only makes it look
 * like it belongs beside the other controls.
 */
const NativeSelect = ({
  className,
  children,
  ...props
}: React.ComponentProps<'select'>) => (
  <span data-slot="native-select" className={cn('relative inline-flex', className)}>
    <select
      data-slot="native-select-control"
      className="border-input h-(--hd-field-h) w-full appearance-none rounded-md border bg-transparent pr-7 pl-2.5 text-sm transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
      {...props}
    >
      {children}
    </select>
    <span
      aria-hidden="true"
      className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
    >
      <CaretIcon size={13} />
    </span>
  </span>
)

export { NativeSelect }
