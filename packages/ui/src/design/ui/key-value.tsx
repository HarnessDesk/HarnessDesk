import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * One line that gives up its middle rather than its end.
 *
 * A path's two informative ends are where it starts (whose home, which
 * repository) and what it names (the file). Ellipsising the end, which is
 * what `truncate` does, keeps the part every path in the list shares and
 * throws away the part that tells them apart. So the text is split before
 * its last segment: the head shortens with an ellipsis, the tail stays whole,
 * and `~/work/storefront/packages/…/retry.ts` is what a narrow box shows.
 *
 * Without a `/`, the last twelve characters are the tail. When even the tail
 * is wider than what the head leaves, it ellipsises too — the line never runs
 * past its container. The whole text is the `title` while it is cut, decided as the
 * pointer arrives, as `Clipped` does.
 */
const splitAt = (text: string): number => {
  const slash = text.lastIndexOf('/')
  if (slash > 0) return slash
  return Math.max(0, text.length - 12)
}

type MiddleTruncateProps = Omit<React.ComponentProps<'span'>, 'children'> & {
  children: string
}

const MiddleTruncate = ({ children, className, ...props }: MiddleTruncateProps) => {
  const at = splitAt(children)
  const head = children.slice(0, at)
  const tail = children.slice(at)
  const long = head.length > 3
  return (
    <span
      data-slot="middle-truncate"
      className={cn('inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap align-bottom', className)}
      onMouseEnter={(event) => {
        const node = event.currentTarget
        const cut = [...node.children].some((part) => part.scrollWidth > part.clientWidth)
        if (cut) node.title = children
        else node.removeAttribute('title')
      }}
      {...props}
    >
      {/* Only the head gives way, so the name stays whole while there is any
          head left to give — and the head keeps enough of itself (`~/…`) to
          show that something was cut. A name wider than all of that is the
          one case where the tail ellipsises too. */}
      {head !== '' && (
        <span data-part="head" className={cn('truncate', long ? 'min-w-6' : 'min-w-0')}>{head}</span>
      )}
      <span data-part="tail" className={cn('shrink-0 truncate', long ? 'max-w-[calc(100%-1.5rem)]' : 'max-w-full')}>{tail}</span>
    </span>
  )
}

/**
 * Facts about one thing, in the shape a reader scans them.
 *
 * A definition list, spelled `<dl>` because that is what it is — which means
 * a screen reader announces "term, value" instead of reading two columns of
 * loose text and leaving the pairing to be inferred.
 *
 * **The inspector shape.** Keys are muted and sit in one column whose width
 * is shared — by every pair in the list, and at least `5rem`, so two lists
 * in one dialog start their values on the same line. Values are left-aligned
 * and read as sentences: they wrap inside their column and never push it past
 * the container. A path is given as `kind="path"` and gives up its middle,
 * with the whole path in its title while it is cut. Numbers — a count, a
 * total, money — are right-aligned on tabular figures, and only when the row
 * says `numeric`: a right-aligned sentence has a ragged left edge that no
 * reader can scan.
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
      'grid min-w-0',
      variant === 'default' && 'gap-x-6 gap-y-2 text-base',
      variant === 'panel' && 'gap-x-2.5 gap-y-0.5 text-sm',
      /* `minmax(0, 1fr)`, not `1fr`: a bare fraction will not go below its
         longest word, which is how a path ran past a dialog's edge. */
      columns === 2 ? 'grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]' : 'grid-cols-[auto_minmax(0,1fr)]',
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
  numeric = false,
  kind = 'text',
  variant = 'default',
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  label: React.ReactNode
  children: React.ReactNode
  emphasis?: boolean
  /** A count, a total, money: right-aligned on tabular figures so a column of them lines up by place. */
  numeric?: boolean
  /** `path` gives up the middle of a string value rather than its end, with the whole in its title while cut. */
  kind?: 'text' | 'path'
  variant?: 'default' | 'panel'
}) => (
  /* `display: contents` so the pair joins the parent grid's columns; wrapping
     each pair in its own box would give every row its own idea of where the
     value column starts, which is the drift this component exists to stop. */
  <div
    data-slot="key-value-row"
    data-variant={variant}
    {...(numeric ? { 'data-numeric': '' } : {})}
    {...(kind === 'path' ? { 'data-kind': 'path' } : {})}
    className={cn('contents', className)}
    {...props}
  >
    <dt
      className={cn(
        'text-start text-(--hd-muted-foreground)',
        variant === 'default' && 'min-w-20',
        variant === 'panel' && 'text-xs',
        emphasis && 'font-medium text-(--hd-foreground)',
      )}
    >
      {label}
    </dt>
    <dd
      className={cn(
        'min-w-0 break-words',
        numeric ? 'text-right tabular-nums' : 'text-left',
        variant === 'panel' && 'text-sm',
        emphasis && 'font-semibold',
      )}
    >
      {kind === 'path' && typeof children === 'string' ? <MiddleTruncate>{children}</MiddleTruncate> : children}
    </dd>
  </div>
)

export { KeyValue, KeyValueRow, MiddleTruncate }
