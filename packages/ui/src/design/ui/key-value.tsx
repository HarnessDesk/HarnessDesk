import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * One line that gives up its middle rather than its end.
 *
 * A path's two informative ends are where it starts (whose home, which
 * repository) and what it names (the file). Ellipsising the end, which is
 * what `truncate` does, keeps the part every path in the list shares and
 * throws away the part that tells them apart. So the text is split before
 * its last segment — at the last `/` or `\` — the head shortens with an
 * ellipsis, the tail stays whole, and `~/work/storefront/packages/…/retry.ts`
 * is what a narrow box shows. The split counts graphemes, so it never lands
 * inside an emoji or a combined letter; with no separator, the last twelve
 * graphemes are the tail. When even the tail is wider than what the head
 * leaves, it ellipsises too — the line never runs past its container.
 *
 * **The text is the whole path, once.** The two visible halves are layout:
 * flex items, which a copy and an accessible name would each join with a
 * break or a space ("…/triggers\n/review.json"). So a screen reader is given
 * the whole path as one visually hidden run and the halves are hidden from
 * it; and a copy of any selection that touches the path — a drag, a
 * double-click, a triple-click on the halves, which stay selectable — is
 * answered with the whole path, on one line. The whole path is also the
 * `title` while it is cut, decided as the pointer arrives, as `Clipped` does.
 */
const graphemes = (text: string): string[] =>
  typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment)
    : Array.from(text)

/** Where a path gives way: before its last separator, or before its last twelve graphemes. */
export const splitPath = (text: string): readonly [head: string, tail: string] => {
  const parts = graphemes(text)
  let at = -1
  for (let index = parts.length - 1; index > 0; index -= 1) {
    if (parts[index] === '/' || parts[index] === '\\') {
      at = index
      break
    }
  }
  if (at < 0) at = Math.max(0, parts.length - 12)
  return [parts.slice(0, at).join(''), parts.slice(at).join('')]
}

type MiddleTruncateProps = Omit<React.ComponentProps<'span'>, 'children'> & {
  children: string
}

const MiddleTruncate = ({ children, className, ...props }: MiddleTruncateProps) => {
  const [head, tail] = splitPath(children)
  const long = graphemes(head).length > 3
  return (
    <span
      data-slot="middle-truncate"
      className={cn('inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap align-bottom', className)}
      onMouseEnter={(event) => {
        const node = event.currentTarget
        const cut = [...node.querySelectorAll('[data-part]')].some((part) => part.scrollWidth > part.clientWidth)
        if (cut) node.title = children
        else node.removeAttribute('title')
      }}
      onCopy={(event) => {
        const node = event.currentTarget
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed) return
        // `intersectsNode`, not `containsNode(…, true)`: a selection wholly
        // inside the path does not "partially contain" the path itself.
        const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
        if (!ranges.some((range) => range.intersectsNode(node))) return
        event.clipboardData.setData('text/plain', children)
        event.preventDefault()
      }}
      {...props}
    >
      {/* Out of the selection, so a copy that starts before the path does not
          take it twice. */}
      <span className="sr-only select-none">{children}</span>
      {/* Only the head gives way, so the name stays whole while there is any
          head left to give — and the head keeps enough of itself (`~/…`) to
          show that something was cut. A name wider than all of that is the
          one case where the tail ellipsises too. */}
      {head !== '' && (
        <span aria-hidden="true" data-part="head" className={cn('truncate', long ? 'min-w-6' : 'min-w-0')}>{head}</span>
      )}
      <span aria-hidden="true" data-part="tail" className={cn('shrink-0 truncate', long ? 'max-w-[calc(100%-1.5rem)]' : 'max-w-full')}>{tail}</span>
    </span>
  )
}

/** The key column's look, one spelling for every shape of the list. */
const KEY_CLASS = 'text-start text-(--hd-muted-foreground)'

/** A value as the list draws it: a path gives up its middle, anything else is itself. */
const valueOf = (children: React.ReactNode, kind: 'text' | 'path'): React.ReactNode =>
  kind === 'path' && typeof children === 'string' ? <MiddleTruncate>{children}</MiddleTruncate> : children

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
      /* `minmax(0, 1fr)` says outright that the value column may be narrower
         than its content — the value's own `min-w-0` already let it. That is
         not what kept the path in the dialog: the path was one unbreakable
         word painted past its box. What holds a value inside is the value
         itself — `break-words` wraps a long word, and `kind="path"` cuts
         the middle of a path. */
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
        KEY_CLASS,
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
      {valueOf(children, kind)}
    </dd>
  </div>
)

/**
 * Several facts about one thing, in one card.
 *
 * The third shape of the same list. `KeyValue` is the bare inspector (a
 * dialog's facts, a panel's), and `SummaryList` is that inspector drawn as a
 * settings card — the `Rows` ground, edge, corner and hairline, read from the
 * same `--hd-card-*` tokens — for a page that has five facts about one object
 * and used to spend five labelled one-row cards on them.
 *
 * Each `SummaryItem` is a row of three columns shared by the whole card: the
 * key, muted, in a column as wide as the widest key; the value, left-aligned
 * and wrapping as a sentence (`kind="path"` gives up the middle, `numeric`
 * right-aligns tabular figures — the `KeyValueRow` rules, unchanged); and an
 * optional trailing `action`, a small button or a ⋯ menu, at the row's end.
 * A `note` is one line of explanation under the value, in the secondary ink,
 * and wraps rather than ellipsises: it is a sentence.
 *
 * When any row has an action, every row stands as tall as one, and the text
 * sits on the action's centre line — so a card of facts keeps one row height
 * whether or not a given fact can be acted on.
 *
 * Narrow (under 28rem of card), the key rises onto its own line above the
 * value, and the action keeps the row's end beside the value, as a wrapped
 * `Row` control does.
 */
const SummaryList = ({ className, children, ...props }: React.ComponentProps<'dl'>) => (
  <div data-slot="summary-list" className={cn('@container/summary min-w-0', className)}>
    <dl
      data-slot="summary-card"
      className={cn(
        'group/summary m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] overflow-hidden',
        'text-(length:--hd-text-sm) leading-(--hd-line-sm)',
        'rounded-[var(--hd-card-radius,var(--hd-radius-lg))] border-(length:--hd-border-width) border-[color:var(--hd-card-border,var(--hd-border))] bg-[var(--hd-card-fill,var(--hd-card))]',
        '@max-md/summary:grid-cols-[minmax(0,1fr)_auto]',
      )}
      {...props}
    >
      {children}
    </dl>
  </div>
)

/* The text's padding when the card holds an action: half of what a small
   button stands above a line of text, so the line sits on the button's centre. */
const ON_ACTION_LINE =
  'group-has-[[data-slot=summary-action]]/summary:py-[calc((var(--hd-btn-h-sm)_-_var(--hd-line-sm))_/_2)]'

const SummaryItem = ({
  className,
  label,
  children,
  note,
  action,
  numeric = false,
  kind = 'text',
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  label: React.ReactNode
  children: React.ReactNode
  /** One sentence under the value: what it means, or why it is so. */
  note?: React.ReactNode
  /** A small button or a ⋯ menu that acts on this one fact. */
  action?: React.ReactNode
  /** A count, a total, money: right-aligned on tabular figures. */
  numeric?: boolean
  /** `path` gives up the middle of a string value rather than its end. */
  kind?: 'text' | 'path'
}) => (
  <div
    data-slot="summary-item"
    {...(numeric ? { 'data-numeric': '' } : {})}
    {...(kind === 'path' ? { 'data-kind': 'path' } : {})}
    className={cn(
      'col-span-full grid grid-cols-subgrid gap-x-(--hd-space-6) gap-y-(--hd-space-0-5) px-(--hd-card-padding) py-(--hd-space-3)',
      'border-b-(length:--hd-border-width) border-[color:var(--hd-card-divider,var(--hd-border))] last:border-b-0',
      className,
    )}
    {...props}
  >
    <dt className={cn(KEY_CLASS, 'min-w-20 @max-md/summary:col-span-full @max-md/summary:pb-0!', ON_ACTION_LINE)}>{label}</dt>
    <dd className="col-span-2 m-0 grid min-w-0 grid-cols-subgrid">
      <div
        data-slot="summary-value"
        className={cn(
          'min-w-0 break-words text-(--hd-foreground)',
          numeric ? 'text-right tabular-nums' : 'text-left',
          /* With no action of its own, the value takes the action's column
             too, so a figure lines up with the ends of the actions above it. */
          action == null && 'col-span-2',
          ON_ACTION_LINE,
        )}
      >
        {valueOf(children, kind)}
        {note != null && (
          <p data-slot="summary-note" className="m-0 mt-(--hd-space-0-5) text-left text-(--hd-secondary-foreground)">
            {note}
          </p>
        )}
      </div>
      {action != null && (
        <div data-slot="summary-action" className="col-start-2 flex min-w-0 items-start justify-end gap-(--hd-space-2)">
          {action}
        </div>
      )}
    </dd>
  </div>
)

export { KeyValue, KeyValueRow, MiddleTruncate, SummaryItem, SummaryList }
