import type * as React from 'react'

import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (table), tightened one step for desktop density. */

const Table = ({
  className,
  containerClassName,
  variant = 'default',
  ...props
}: React.ComponentProps<'table'> & {
  containerClassName?: string
  variant?: 'default' | 'framed'
}) => (
  <div
    data-slot="table-container"
    data-variant={variant}
    className={cn(
      'relative w-full overflow-x-auto',
      variant === 'framed' && 'rounded-(--hd-radius) shadow-(--hd-hairline)',
      containerClassName,
    )}
  >
    <table
      data-slot="table"
      className={cn('w-full caption-bottom border-collapse text-sm', className)}
      {...props}
    />
  </div>
)

const TableHeader = ({ className, ...props }: React.ComponentProps<'thead'>) => (
  <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />
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
  variant?: 'default' | 'matrix'
  interactive?: boolean
}) => (
  <tr
    data-slot="table-row"
    data-variant={variant}
    {...(interactive ? { 'data-interactive': '' } : {})}
    className={cn(
      variant === 'default' && 'hover:bg-accent/50 data-[state=selected]:bg-muted',
      variant === 'matrix' && 'group/matrix',
      variant === 'matrix' && interactive && 'hover:bg-(--hd-hover) data-[state=selected]:bg-(--hd-hover)',
      'border-b transition-colors',
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
  ...props
}: Omit<React.ComponentProps<'th'>, 'align'> & {
  variant?: 'default' | 'matrix' | 'row' | 'footer'
  pinned?: boolean
  align?: 'start' | 'center' | 'end'
}) => (
  <th
    data-slot="table-head"
    data-variant={variant}
    data-align={align}
    {...(pinned ? { 'data-pinned': '' } : {})}
    className={cn(
      variant === 'default' && 'text-muted-foreground h-8 px-2 text-left align-middle text-xs font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0',
      variant === 'matrix' && 'bg-(--hd-background) px-2.5 py-2 text-left align-middle text-xs font-medium whitespace-nowrap text-(--hd-muted-foreground)',
      variant === 'row' && 'bg-(--hd-background) p-0 text-left align-middle text-sm font-normal text-(--hd-foreground) group-hover/matrix:bg-(--hd-hover) group-data-[state=selected]/matrix:bg-(--hd-hover)',
      variant === 'footer' && 'px-2.5 py-2 text-left text-xs font-medium whitespace-nowrap text-(--hd-muted-foreground)',
      pinned && 'bg-(--hd-background)',
      align === 'center' && 'text-center',
      align === 'end' && 'text-right',
      className,
    )}
    {...props}
  />
)

const TableCell = ({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'td'> & { variant?: 'default' | 'matrix' | 'flush' | 'detail' | 'footer' }) => (
  <td
    data-slot="table-cell"
    data-variant={variant}
    className={cn(
      variant === 'default' && 'px-2 py-1.5 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0',
      variant === 'matrix' && 'p-0 text-center align-middle',
      variant === 'flush' && 'bg-(--hd-background) p-0 align-middle',
      variant === 'detail' && 'bg-(--hd-background) px-3 pt-2.5 pb-3 align-middle',
      variant === 'footer' && 'px-1.5 py-2 text-center text-xs tabular-nums whitespace-nowrap text-(--hd-muted-foreground)',
      className,
    )}
    {...props}
  />
)

const TableCaption = ({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'caption'> & { variant?: 'default' | 'sr-only' }) => (
  <caption
    data-slot="table-caption"
    data-variant={variant}
    className={cn(
      variant === 'default' && 'text-muted-foreground mt-2 text-sm',
      variant === 'sr-only' && 'sr-only',
      className,
    )}
    {...props}
  />
)

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption }
