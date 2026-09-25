import type * as React from 'react'

import { cn } from '@/lib/utils'
import { ChevronIcon } from '@/components/Icons'
import { Row } from '../patterns/Settings'

/**
 * The screen with nothing on it yet, doing something useful anyway.
 *
 * Most empty states are an apology — an icon, "No data", and a dead end. The
 * good ones are a menu: they take the space the missing content would have
 * occupied and spend it telling the reader what the screen is for and what
 * they could press to fill it.
 *
 * Which is why `children` here is usually a short list of `ChoiceRow`s rather
 * than a single button. A screen with one obvious next step should say so with
 * one action; a screen with three legitimate starting points should offer the
 * three, because guessing which one the reader wanted and hiding the others is
 * how a first run becomes a support question.
 *
 * **Three shapes, one per place** — the fourth and fifth layouts the app grew
 * were each one of these, drawn by hand:
 *
 * - `panel` (the default): centred icon, title, sentence and choices. It owns
 *   a page, a pane or a dialog body. `tight` is the same words with less air,
 *   for a panel inside a card, so a column that happens to be empty does not
 *   push the columns beside it off the screen.
 * - `inline`: one muted line, no icon, no heading — for inside a list, a
 *   column or a pane that already says what it is. `description` joins the
 *   same line.
 * - `row`: a row inside a `Rows` card, with a Row's own padding and hairline,
 *   its title in secondary ink so it never reads as one more item.
 *   `children` is its trailing control.
 *
 * **Rules.** A navigation tree never renders an empty-state sentence under a
 * node: an empty node has no children and at most a count, and only a whole
 * list with nothing in it at all may carry one `inline` line. And when the
 * header above already carries the primary action, the empty state's own
 * action is secondary — two ink buttons on one screen is two primaries, which
 * is none.
 */

type EmptyStateVariant = 'panel' | 'inline' | 'row'

type EmptyStateProps = Omit<React.ComponentProps<'div'>, 'title'> & {
  /** Where it sits: a page or pane (`panel`), a list or column (`inline`), a `Rows` card (`row`). */
  variant?: EmptyStateVariant
  /** `panel` draws it in a disc; `row` as the row's mark; `inline` never draws one. */
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** A footnote under everything — the way out for the reader none of the choices fit. `panel` only. */
  footer?: React.ReactNode
  /** `panel` only: the same words with less air, for a panel inside a card. */
  tight?: boolean
}

const EmptyState = ({
  className,
  variant = 'panel',
  icon,
  title,
  description,
  footer,
  tight,
  children,
  ...props
}: EmptyStateProps) => {
  if (variant === 'inline') {
    return (
      <p
        data-slot="empty-state"
        data-variant="inline"
        className={cn('min-w-0 text-sm leading-(--hd-line-sm) text-(--hd-muted-foreground)', className)}
        {...(props as React.ComponentProps<'p'>)}
      >
        {title}
        {description != null && <> {description}</>}
        {children != null && <> {children}</>}
      </p>
    )
  }
  if (variant === 'row') {
    return (
      <Row
        data-slot="empty-state"
        data-variant="row"
        mark={icon}
        title={title}
        desc={description}
        wrapDesc
        control={children}
        {...(className ? { className } : {})}
        {...props}
      />
    )
  }
  return (
    <div
      data-slot="empty-state"
      data-variant="panel"
      className={cn(
        'mx-auto flex w-full max-w-md flex-col items-center text-center',
        tight ? 'gap-2 py-6' : 'gap-3 py-10',
        className,
      )}
      {...props}
    >
      {icon != null && (
        <span
          aria-hidden
          className="inline-flex size-10 items-center justify-center rounded-full bg-(--hd-muted) text-(--hd-muted-foreground) [&_svg]:size-5"
        >
          {icon}
        </span>
      )}
      <div className="flex flex-col gap-1">
        <h3 className={cn('font-semibold', tight ? 'text-base' : 'text-lg')}>{title}</h3>
        {description != null && (
          <p className="text-base text-(--hd-muted-foreground)">{description}</p>
        )}
      </div>
      {children != null && <div className="mt-2 flex w-full flex-col gap-2">{children}</div>}
      {footer != null && <div className="mt-1 text-xs text-(--hd-muted-foreground)">{footer}</div>}
    </div>
  )
}

/**
 * One of several ways to begin.
 *
 * A bordered row with a marked icon, a name, a line saying what happens if you
 * pick it, and a chevron that promises the press goes somewhere. It is a
 * button, not a link with a hover — the whole row is the target, because a
 * three-word title is a small thing to hit and the description is part of what
 * the reader is choosing.
 *
 * Here the second line is always earned: the reader is choosing between options
 * whose names cannot, by themselves, tell them apart.
 */
const ChoiceRow = ({
  className,
  icon,
  title,
  description,
  ...props
}: React.ComponentProps<'button'> & {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
}) => (
  <button
    type="button"
    data-slot="choice-row"
    className={cn(
      'flex w-full items-center gap-3 rounded-(--hd-radius) border border-(--hd-border) bg-(--hd-card) px-3 py-2.5 text-left',
      'hover:border-(--hd-border-strong) hover:bg-(--hd-hover)',
      className,
    )}
    {...props}
  >
    {icon != null && <span className="shrink-0">{icon}</span>}
    <span className="min-w-0 flex-1">
      <span className="block truncate text-base font-medium">{title}</span>
      {description != null && (
        <span className="block truncate text-xs text-(--hd-muted-foreground)">{description}</span>
      )}
    </span>
    <ChevronIcon aria-hidden className="size-4 shrink-0 text-(--hd-muted-foreground)" />
  </button>
)

export { EmptyState, ChoiceRow }
