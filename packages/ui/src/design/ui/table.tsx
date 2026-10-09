import * as React from 'react'

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
      className={cn('w-full caption-bottom border-collapse', variant === 'panel' ? 'text-xs' : 'text-sm', inset === 'row' && '[&_tr>:first-child]:ps-(--hd-inset-row) [&_tr>:last-child]:pe-(--hd-inset-row)', className)}
      {...props}
    />
  </div>
)

/** A log keeps its header outside the windowed body, in the same grid. */
const TableHeader = ({ className, as: Tag = 'thead', variant = 'default', ...props }: React.ComponentProps<'thead'> & {
  as?: 'thead' | 'div'
  variant?: 'default' | 'log'
}) => (
  <Tag data-slot="table-header" data-variant={variant} className={cn(
    variant === 'log'
      ? 'h-(--hd-table-log-head-h) border-b border-(--hd-border-strong)'
      : '[&_tr]:border-b [&_tr]:border-(--hd-border-strong)',
    className,
  )} {...props} />
)

/** Fixed-pitch rows, with geometry supplied by the scroll viewport. Only the
 * visible children mount; spacer rows preserve native table columns. */
const TableBody = ({ className, children, window: viewport, ...props }: React.ComponentProps<'tbody'> & {
  window?: { top: number; height: number; pitch: number; columns: number }
}) => {
  const rows = React.Children.toArray(children)
  const start = viewport ? Math.max(0, Math.floor(viewport.top / viewport.pitch) - 5) : 0
  const end = viewport ? Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / viewport.pitch) + 5) : rows.length
  const space = (height: number, key: string) => height > 0 && <tr key={key} aria-hidden="true"><td colSpan={viewport?.columns} style={{ height, padding: 0, border: 0 }} /></tr>
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props}>
    {viewport && space(start * viewport.pitch, 'before')}
    {rows.slice(start, end)}
    {viewport && space((rows.length - end) * viewport.pitch, 'after')}
  </tbody>
}

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

/** Collapse a narrow column without removing it from the semantic grid.
 * A spanning detail row must see the same columns before and after it opens.
 * The important width overrides a caller's normal column geometry. */
const collapsedColumn = '@max-[640px]:w-0! @max-[640px]:p-0! @max-[640px]:border-0! @max-[640px]:overflow-hidden'

const TableHead = ({
  className,
  variant = 'default',
  pinned = false,
  align = 'start',
  numeric = false,
  collapseBelow,
  scope = variant === 'row' ? 'row' : 'col',
  ...props
}: Omit<React.ComponentProps<'th'>, 'align'> & {
  variant?: 'default' | 'matrix' | 'row' | 'footer' | 'panel'
  pinned?: boolean
  align?: 'start' | 'center' | 'end'
  numeric?: boolean
  /** Collapse this column below 640px of the nearest size container; an ancestor must declare `container-type: inline-size`. */
  collapseBelow?: 'sm'
}) => (
  <th
    scope={scope}
    data-slot="table-head"
    data-variant={variant}
    data-align={numeric ? 'end' : align}
    data-collapse-below={collapseBelow}
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
      collapseBelow === 'sm' && collapsedColumn,
      className,
    )}
    {...props}
  />
)

/**
 * `align` is the cell's half of the column's alignment, which `TableHead`
 * already carries: a column the head sets flush right is a column of figures,
 * so its cells are set flush right in tabular digits and line up under it.
 * A `lead` centres a face on the whole row, including wrapped text. An
 * AvatarStack keeps its intrinsic width, including its remainder reading.
 */
const TableCell = ({
  className,
  variant = 'default',
  align = 'start',
  lead,
  numeric = false,
  collapseBelow,
  children,
  ...props
}: Omit<React.ComponentProps<'td'>, 'align'> & {
  variant?: 'default' | 'matrix' | 'flush' | 'detail' | 'footer' | 'panel'
  align?: 'start' | 'center' | 'end'
  numeric?: boolean
  /** Collapse this column below 640px of the nearest size container; an ancestor must declare `container-type: inline-size`. */
  collapseBelow?: 'sm'
  lead?: React.ReactNode
}) => (
  <td
    data-slot="table-cell"
    data-variant={variant}
    data-align={numeric ? 'end' : align}
    data-collapse-below={collapseBelow}
    className={cn(
      'h-(--hd-table-row-min) in-data-[rows=bare]:h-(--hd-table-row-min-bare) px-(--hd-table-cell-x) first:ps-(--hd-table-edge) last:pe-(--hd-table-edge) align-middle',
      variant === 'default' && 'py-1.5 whitespace-nowrap',
      variant === 'matrix' && 'py-0 text-center',
      variant === 'flush' && 'bg-(--hd-background) py-0',
      variant === 'detail' && 'bg-(--hd-background) px-3 pt-2.5 pb-3 align-middle',
      variant === 'footer' && 'px-1.5 py-2 text-center text-xs tabular-nums whitespace-nowrap text-(--hd-muted-foreground)',
      variant === 'panel' && 'py-1 whitespace-normal [overflow-wrap:anywhere]',
      !numeric && align === 'center' && 'text-center',
      (numeric || align === 'end') && 'text-right tabular-nums',
      collapseBelow === 'sm' && collapsedColumn,
      className,
    )}
    {...props}
  >
    {lead != null ? (
      <div className="flex min-w-0 items-center gap-(--hd-table-lead-gap)">
        <span data-slot="table-cell-lead" className="inline-flex size-(--hd-table-face) shrink-0 items-center justify-center overflow-hidden rounded-(--hd-table-face-radius) has-[[data-slot=avatar-stack]]:w-auto has-[[data-slot=avatar-stack]]:overflow-visible has-[[data-slot=face-badge]]:overflow-visible [&>*:not([data-slot=avatar-stack])]:size-full [&>*:not([data-slot=avatar-stack])]:rounded-[inherit]">{lead}</span>
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
