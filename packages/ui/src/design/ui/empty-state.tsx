import type * as React from 'react'

import { cn } from '@/lib/utils'
import { ChevronIcon } from '@/components/Icons'

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
 * `tight` is for an empty state inside a card or a pane rather than owning a
 * page — same words, less air, so a column that happens to be empty does not
 * push the columns beside it off the screen.
 */

type EmptyStateProps = React.ComponentProps<'div'> & {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** A footnote under everything — the way out for the reader none of the choices fit. */
  footer?: React.ReactNode
  tight?: boolean
}

const EmptyState = ({
  className,
  icon,
  title,
  description,
  footer,
  tight,
  children,
  ...props
}: EmptyStateProps) => (
  <div
    data-slot="empty-state"
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
