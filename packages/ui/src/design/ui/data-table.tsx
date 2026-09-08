import { useCallback, useMemo, useState } from 'react'
import type * as React from 'react'

import { ChevronIcon, SortNameIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'
import { Checkbox } from './checkbox'

/**
 * The parts that turn a table into a data table.
 *
 * shadcn's `data-table` is the one entry in the registry that is not a
 * component: it is a guide to wiring TanStack Table into the `table` we have
 * already vendored. So this adopts the *capability* it describes &mdash;
 * sortable headers, row selection, pagination &mdash; and does not add the
 * library, for a reason worth stating rather than assuming:
 *
 *   TanStack earns its weight on filtering, grouping, column pinning and
 *   virtualised thousands. The longest table in this app is a plugin roster.
 *   Adding a table engine to an application that never reaches the network and
 *   bundles its own font, to serve a need no screen has yet, is the trade the
 *   audit flagged. **If a table here ever grows past what these hooks are good
 *   for, take the library** &mdash; the parts below are deliberately the same
 *   shape as the recipe's, so that swap is an internals change.
 *
 * The two hooks hold state and no markup; the three components hold markup and
 * no state. A screen can take either half.
 */

export type SortDirection = 'asc' | 'desc'

/**
 * Sorting, for a table small enough to sort in memory.
 *
 * Sorting is a *view* of the rows, so it is derived rather than stored: there
 * is no second copy of the data to fall out of date, and a row that changes
 * underneath re-sorts on the next render rather than staying where it was.
 */
export const useTableSort = <T,>(
  rows: readonly T[],
  compare: Record<string, (a: T, b: T) => number>,
  initial?: { key: string; direction?: SortDirection },
) => {
  const [sort, setSort] = useState<{ key: string; direction: SortDirection } | null>(
    initial ? { key: initial.key, direction: initial.direction ?? 'asc' } : null,
  )

  /* A third press clears the sort rather than cycling back to ascending. The
     unsorted order is the order the host sent, which is usually meaningful
     (most recent first) and is otherwise unreachable once a column is pressed. */
  const toggle = useCallback((key: string) => {
    setSort((was) => {
      if (was?.key !== key) return { key, direction: 'asc' }
      if (was.direction === 'asc') return { key, direction: 'desc' }
      return null
    })
  }, [])

  const sorted = useMemo(() => {
    if (!sort) return rows
    const fn = compare[sort.key]
    if (!fn) return rows
    const out = [...rows].sort(fn)
    return sort.direction === 'desc' ? out.reverse() : out
  }, [rows, sort, compare])

  return { sort, toggle, sorted }
}

/**
 * Which rows are picked.
 *
 * Keyed by id rather than by index, so a selection survives the table being
 * re-sorted underneath it &mdash; which is the bug every index-keyed selection
 * has, and it only shows up once sorting is added.
 */
export const useTableSelection = (ids: readonly string[]) => {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = useCallback((id: string) => {
    setSelected((was) => {
      const next = new Set(was)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const all = ids.length > 0 && ids.every((id) => selected.has(id))
  const some = !all && ids.some((id) => selected.has(id))

  const toggleAll = useCallback(() => {
    setSelected((was) => (ids.every((id) => was.has(id)) ? new Set() : new Set(ids)))
  }, [ids])

  return { selected, toggle, toggleAll, all, some, count: selected.size }
}

/**
 * A column heading that can be pressed to sort by it.
 *
 * The glyph says three things and has to say them apart: unsorted is the faint
 * two-way mark, and a sorted column shows the direction it is actually in.
 * `aria-sort` is what a screen reader reads, and is the part hand-rolled
 * sortable tables always miss.
 */
const DataTableColumnHeader = ({
  className,
  direction,
  children,
  ...props
}: React.ComponentProps<'button'> & { direction?: SortDirection | null }) => (
  <button
    type="button"
    data-slot="data-table-column-header"
    className={cn(
      'group/sort -mx-1 inline-flex items-center gap-1 rounded-(--hd-radius-sm) px-1 py-0.5',
      'hover:bg-(--hd-hover) hover:text-(--hd-foreground)',
      className,
    )}
    {...props}
  >
    {children}
    {direction == null ? (
      <SortNameIcon aria-hidden className="size-3 opacity-0 group-hover/sort:opacity-50" />
    ) : (
      <ChevronIcon
        aria-hidden
        className={cn('size-3 transition-transform', direction === 'asc' ? '-rotate-90' : 'rotate-90')}
      />
    )}
  </button>
)

/** The select-all box, which is indeterminate when only some rows are picked. */
const DataTableSelectAll = ({
  all,
  some,
  ...props
}: React.ComponentProps<typeof Checkbox> & { all: boolean; some: boolean }) => (
  <Checkbox
    data-slot="data-table-select-all"
    aria-label={all ? 'Clear selection' : 'Select every row'}
    checked={all ? true : some ? 'indeterminate' : false}
    {...props}
  />
)

/**
 * The footer: what is picked, and the way through the rest.
 *
 * The count is on the left because it is a reading, and the movement is on the
 * right because it is an act &mdash; the same order the composer's tool row
 * holds. Both ends stay put when the middle is empty.
 */
const DataTablePagination = ({
  className,
  selected,
  total,
  page,
  pages,
  onPrevious,
  onNext,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  selected?: number
  total: number
  page: number
  pages: number
  onPrevious?: () => void
  onNext?: () => void
}) => (
  <div
    data-slot="data-table-pagination"
    className={cn(
      'flex items-center gap-2 border-t border-(--hd-border) px-3 py-2 text-xs text-(--hd-muted-foreground)',
      className,
    )}
    {...props}
  >
    <span className="min-w-0 flex-1 truncate tabular-nums">
      {selected != null && selected > 0
        ? `${selected} of ${total} selected`
        : `${total} row${total === 1 ? '' : 's'}`}
    </span>
    <span className="shrink-0 tabular-nums">
      Page {page} of {pages}
    </span>
    <button
      type="button"
      aria-label="Previous page"
      disabled={page <= 1}
      onClick={onPrevious}
      className="inline-flex size-5 items-center justify-center rounded-(--hd-radius-sm) hover:bg-(--hd-hover) hover:text-(--hd-foreground) disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3"
    >
      <ChevronIcon aria-hidden className="rotate-180" />
    </button>
    <button
      type="button"
      aria-label="Next page"
      disabled={page >= pages}
      onClick={onNext}
      className="inline-flex size-5 items-center justify-center rounded-(--hd-radius-sm) hover:bg-(--hd-hover) hover:text-(--hd-foreground) disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3"
    >
      <ChevronIcon aria-hidden />
    </button>
  </div>
)

export { DataTableColumnHeader, DataTableSelectAll, DataTablePagination }
