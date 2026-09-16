import type * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

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
const nativeSelectVariants = cva(
  'w-full appearance-none rounded-md border bg-transparent pr-7 pl-2.5 text-sm transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
  {
    variants: {
      variant: {
        default: 'border-input',
        filled: 'border-(--hd-border) bg-(--hd-muted)',
      },
      size: {
        default: 'h-(--hd-field-h)',
        compact: 'h-6',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type NativeSelectVariants = VariantProps<typeof nativeSelectVariants>
type NativeSelectProps = React.ComponentProps<'select'> & {
  variant?: NonNullable<NativeSelectVariants['variant']>
  controlSize?: NonNullable<NativeSelectVariants['size']>
}

const NativeSelect = ({
  className,
  children,
  variant = 'default',
  controlSize = 'default',
  ...props
}: NativeSelectProps) => (
  <span data-slot="native-select" className={cn('relative inline-flex', className)}>
    <select
      data-slot="native-select-control"
      className={nativeSelectVariants({ variant, size: controlSize })}
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

export { NativeSelect, nativeSelectVariants, type NativeSelectProps }
