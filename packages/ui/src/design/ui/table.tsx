import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (table), with the app's shared row anatomy. */

const Table = ({
  className,
  containerClassName,
  variant = 'default',
  inset,
  density = variant === 'panel' ? 'compact' : 'comfortable',
  rows = 'default',
  ...props
}: React.ComponentProps<'table'> & {
  density?: 'comfortable' | 'compact'
  rows?: 'default' | 'bare'
  containerClassName?: string
  variant?: 'default' | 'framed' | 'panel'
  /** The table and its replacement list keep the same row-content edge. */
  inset?: 'row'
}) => (
  <div
    data-slot="table-container"
    data-variant={variant}
    className={cn(
      'relative w-full overflow-x-auto',
      variant === 'framed' && 'rounded-(--hd-radius) shadow-(--hd-hairline)',
      variant === 'panel' && 'rounded-(--hd-radius-sm) border border-(--hd-border)',
      containerClassName,
    )}
  >
    <table
      data-slot="table"
      data-hd-table={density}
      data-rows={rows}
      className={cn('w-full caption-bottom border-collapse', variant === 'panel' ? 'text-xs' : 'text-sm', inset === 'row' && '[&_th]:px-(--hd-inset-row) [&_td]:px-(--hd-inset-row)', className)}
      {...props}
    />
  </div>
)

const TableHeader = ({ className, ...props }: React.ComponentProps<'thead'>) => (
  <thead data-slot="table-header" className={cn('[&_tr]:border-b [&_tr]:border-(--hd-border-strong)', className)} {...props} />
)

const TableBody = ({ className, ...props }: React.ComponentProps<'tbody'>) => (
  <tbody
    data-slot="table-body"
    className={cn('[&_tr:last-child]:border-0', className)}
    {...props}
  />
)

const TableFooter = ({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'tfoot'> & { variant?: 'default' | 'plain' }) => (
  <tfoot
    data-slot="table-footer"
    data-variant={variant}
    className={cn(
      variant === 'default' && 'bg-muted/50 border-t font-medium',
      variant === 'plain' && 'border-t border-(--hd-border)',
      '[&>tr]:last:border-b-0',
      className,
    )}
    {...props}
  />
)

const TableRow = ({
  className,
  variant = 'default',
  interactive = false,
  ...props
}: React.ComponentProps<'tr'> & {
  variant?: 'default' | 'matrix' | 'panel'
  interactive?: boolean
}) => (
  <tr
    data-slot="table-row"
    data-variant={variant}
    {...(interactive ? { 'data-interactive': '' } : {})}
    className={cn(
      variant === 'matrix' && 'group/matrix',
      interactive && 'hover:bg-(--hd-hover)',
      'data-[state=selected]:bg-(--hd-selected)',
      interactive && 'data-[state=selected]:hover:bg-(--hd-selected)',
      'border-b border-(--hd-card-divider,var(--hd-border)) transition-colors',
      className,
    )}
    {...props}
  />
)

const TableHead = ({
  className,
  variant = 'default',
  pinned = false,
  align = 'start',
  numeric = false,
  scope = variant === 'row' ? 'row' : 'col',
  ...props
}: Omit<React.ComponentProps<'th'>, 'align'> & {
  variant?: 'default' | 'matrix' | 'row' | 'footer' | 'panel'
  pinned?: boolean
  align?: 'start' | 'center' | 'end'
  numeric?: boolean
}) => (
  <th
    scope={scope}
    data-slot="table-head"
    data-variant={variant}
    data-align={numeric ? 'end' : align}
    {...(pinned ? { 'data-pinned': '' } : {})}
    className={cn(
      'h-(--hd-table-head-h) px-(--hd-table-cell-x) first:ps-(--hd-table-edge) last:pe-(--hd-table-edge) text-left align-middle text-(length:--hd-table-head-size) font-medium text-(--hd-table-head-ink)',
      variant === 'default' && 'whitespace-nowrap',
      variant === 'matrix' && 'bg-(--hd-background) whitespace-nowrap',
      variant === 'row' && 'text-(length:--hd-table-name-size) font-medium text-(--hd-foreground)',
      variant === 'footer' && 'px-2.5 py-2 text-left text-xs font-medium whitespace-nowrap text-(--hd-muted-foreground)',
      variant === 'panel' && 'sticky top-0 bg-(--hd-card) whitespace-nowrap',
      variant === 'row' && 'h-(--hd-table-row-min) in-data-[rows=bare]:h-(--hd-table-row-min-bare)',
      pinned && 'bg-(--hd-background) group-data-[interactive]/matrix:group-hover/matrix:[background:linear-gradient(var(--hd-hover),var(--hd-hover)),var(--hd-background)] group-data-[state=selected]/matrix:[background:linear-gradient(var(--hd-selected),var(--hd-selected)),var(--hd-background)] group-data-[state=selected]/matrix:group-data-[interactive]/matrix:group-hover/matrix:[background:linear-gradient(var(--hd-selected),var(--hd-selected)),var(--hd-background)]',
      !numeric && align === 'center' && 'text-center',
      (numeric || align === 'end') && 'text-right',
      className,
    )}
    {...props}
  />
)

/**
 * `align` is the cell's half of the column's alignment, which `TableHead`
 * already carries: a column the head sets flush right is a column of figures,
 * so its cells are set flush right in tabular digits and line up under it.
 * A `lead` centres a face on the whole row, including wrapped text. A
 * FaceStack keeps its intrinsic width, including its remainder reading.
 */
const TableCell = ({
  className,
  variant = 'default',
  align = 'start',
  lead,
  numeric = false,
  children,
  ...props
}: Omit<React.ComponentProps<'td'>, 'align'> & {
  variant?: 'default' | 'matrix' | 'flush' | 'detail' | 'footer' | 'panel'
  align?: 'start' | 'center' | 'end'
  numeric?: boolean
  lead?: React.ReactNode
}) => (
  <td
    data-slot="table-cell"
    data-variant={variant}
    data-align={numeric ? 'end' : align}
    className={cn(
      variant === 'default' && 'py-1.5 whitespace-nowrap',
      variant === 'matrix' && 'py-0 text-center',
      variant === 'flush' && 'bg-(--hd-background) py-0',
      variant === 'detail' && 'bg-(--hd-background) px-3 pt-2.5 pb-3 align-middle',
      variant === 'footer' && 'px-1.5 py-2 text-center text-xs tabular-nums whitespace-nowrap text-(--hd-muted-foreground)',
      variant === 'panel' && 'py-1 whitespace-normal [overflow-wrap:anywhere]',
      'h-(--hd-table-row-min) in-data-[rows=bare]:h-(--hd-table-row-min-bare) px-(--hd-table-cell-x) first:ps-(--hd-table-edge) last:pe-(--hd-table-edge) align-middle',
      !numeric && align === 'center' && 'text-center',
      (numeric || align === 'end') && 'text-right tabular-nums',
      className,
    )}
    {...props}
  >
    {lead != null ? (
      <div className="flex min-w-0 items-center gap-(--hd-table-lead-gap)">
        <span data-slot="table-cell-lead" className="inline-flex size-(--hd-table-face) shrink-0 items-center justify-center overflow-hidden rounded-(--hd-table-face-radius) has-[[data-slot=face-stack]]:w-auto has-[[data-slot=face-stack]]:overflow-visible [&>*:not([data-slot=face-stack])]:size-full [&>*:not([data-slot=face-stack])]:rounded-[inherit]">{lead}</span>
        {children}
      </div>
    ) : children}
  </td>
)

const TableCaption = ({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'caption'> & { variant?: 'default' | 'sr-only' | 'panel' }) => (
  <caption
    data-slot="table-caption"
    data-variant={variant}
    className={cn(
      variant === 'default' && 'text-muted-foreground mt-2 text-sm',
      variant === 'sr-only' && 'sr-only',
      variant === 'panel' && 'px-2 py-1 text-left text-xs text-(--hd-muted-foreground)',
      className,
    )}
    {...props}
  />
)

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption }
