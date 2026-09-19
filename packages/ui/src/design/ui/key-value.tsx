import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Facts about one thing, in the shape a reader scans them.
 *
 * A definition list, spelled `<dl>` because that is what it is — which means
 * a screen reader announces "term, value" instead of reading two columns of
 * loose text and leaving the pairing to be inferred.
 *
 * `emphasis` on the last pair is the totals-line rule: the figure everything
 * above was building toward gets weight, and it gets it from a prop rather
 * than from a caller adding `font-semibold` in one place and `font-bold` in
 * the next.
 */

const KeyValue = ({
  className,
  columns = 1,
  variant = 'default',
  ...props
}: React.ComponentProps<'dl'> & { columns?: 1 | 2; variant?: 'default' | 'panel' }) => (
  <dl
    data-slot="key-value"
    data-variant={variant}
    className={cn(
      'grid',
      variant === 'default' && 'gap-x-6 gap-y-2 text-base',
      variant === 'panel' && 'gap-x-2.5 gap-y-0.5 text-sm',
      columns === 2 ? 'grid-cols-[auto_1fr_auto_1fr]' : 'grid-cols-[auto_1fr]',
      className,
    )}
    {...props}
  />
)

const KeyValueRow = ({
  className,
  label,
  children,
  emphasis,
  variant = 'default',
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  label: React.ReactNode
  children: React.ReactNode
  emphasis?: boolean
  variant?: 'default' | 'panel'
}) => (
  /* `display: contents` so the pair joins the parent grid's columns; wrapping
     each pair in its own box would give every row its own idea of where the
     value column starts, which is the drift this component exists to stop. */
  <div data-slot="key-value-row" data-variant={variant} className={cn('contents', className)} {...props}>
    <dt
      className={cn(
        'text-(--hd-muted-foreground)',
        variant === 'panel' && 'text-xs',
        emphasis && 'font-medium text-(--hd-foreground)',
      )}
    >
      {label}
    </dt>
    <dd
      className={cn(
        'min-w-0',
        variant === 'default' && 'text-right tabular-nums',
        variant === 'panel' && 'text-left text-sm',
        emphasis && 'font-semibold',
      )}
    >
      {children}
    </dd>
  </div>
)

export { KeyValue, KeyValueRow }
