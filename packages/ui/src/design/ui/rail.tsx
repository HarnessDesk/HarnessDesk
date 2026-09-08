import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The left bar: where you are, and everywhere else you could be.
 *
 * A sidebar is the one surface in an app that is never the subject and always
 * on screen, which makes it the easiest thing to over-design and the most
 * expensive place to get density wrong. Three rules, and they are all about
 * restraint:
 *
 *   It is furniture.        Smaller text, quieter colour, no borders around
 *                           items. The reader's attention belongs to the pane
 *                           beside it, and every ounce the rail takes is taken
 *                           from the work.
 *
 *   Selection is a shape.   A filled, rounded row — not a left-edge stripe, not
 *                           bold text alone. It has to survive being glanced at
 *                           from the far side of the window, and a 2px stripe
 *                           does not.
 *
 *   Sections are labels.    Small caps, no rules. A horizontal line between
 *                           every group turns a list of twelve items into
 *                           twelve boxes, and the rail stops being scannable
 *                           at exactly the size it starts being useful.
 *
 * The header and footer are pinned and the middle scrolls, because the two
 * things a reader reaches for without looking — the workspace they are in and
 * the account they are signed in as — must not move.
 */

const Rail = ({
  className,
  width = 244,
  ...props
}: React.ComponentProps<'nav'> & { width?: number }) => (
  <nav
    data-slot="rail"
    style={{ width }}
    className={cn(
      'flex shrink-0 flex-col border-r border-(--hd-sidebar-border) bg-(--hd-sidebar,var(--hd-muted))',
      className,
    )}
    {...props}
  />
)

/** Pinned at the top: which workspace, and the way to switch it. */
const RailHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="rail-header"
    className={cn('flex shrink-0 items-center gap-2 p-2.5', className)}
    {...props}
  />
)

/** The scrolling middle. Everything that can grow lives here. */
const RailBody = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="rail-body"
    className={cn('flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2', className)}
    {...props}
  />
)

/**
 * A group's name.
 *
 * Optionally with something on the right — a count, a `+`. That slot is why
 * this is a component and not a `<div>`: the label and its action have to sit
 * on one baseline in every group, and by the third hand-rolled one they do not.
 */
const RailLabel = ({
  className,
  action,
  children,
  ...props
}: React.ComponentProps<'div'> & { action?: React.ReactNode }) => (
  <div
    data-slot="rail-label"
    className={cn(
      'flex items-center gap-1 px-1.5 pt-3 pb-1 text-xs font-medium tracking-wide text-(--hd-muted-foreground) uppercase',
      className,
    )}
    {...props}
  >
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {action}
  </div>
)

type RailItemProps = React.ComponentProps<'button'> & {
  icon?: React.ReactNode
  selected?: boolean
  /** A count, a state dot, a chip. */
  trail?: React.ReactNode
  /** Nesting, in steps. A tree in a rail is a rail; a tree with guides is a tree. */
  depth?: 0 | 1 | 2
}

const RailItem = ({
  className,
  icon,
  selected,
  trail,
  depth = 0,
  children,
  ...props
}: RailItemProps) => (
  <button
    type="button"
    data-slot="rail-item"
    /* `aria-current`, not a class alone — the rail's selection is navigation
       state, and a screen reader has to be told which page it is on. */
    {...(selected ? { 'aria-current': 'page' as const } : {})}
    style={depth ? { paddingLeft: `calc(var(--hd-space-2) + ${depth * 14}px)` } : undefined}
    className={cn(
      /* Geometry is the rail's own — this column has always been `--hd-row-h`
         at the small radius, and the Interface setting has no business
         reshaping it. Only the *marks* follow the app's navigation family. */
      'flex h-(--hd-row-h) w-full items-center gap-2 rounded-(--hd-radius-sm) px-2 text-left text-base',
      'text-(--hd-secondary-foreground) hover:bg-(--hd-sidebar-hover) hover:text-(--hd-sidebar-foreground)',
      '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-(--hd-muted-foreground)',
      /* The selected row restates hover for both background and ink, because
         `hover:` outranks a plain utility by a pseudo-class and would
         otherwise wipe the selection out from under the pointer. Each token
         carries its Desk value as a fallback: these are Studio-only, and
         `bg-(--x)` shorthand has nowhere to put one. See list-row.tsx. */
      selected &&
        'bg-[var(--hd-sidebar-selected,var(--hd-selected))] hover:bg-[var(--hd-sidebar-selected,var(--hd-selected))] font-[var(--hd-nav-weight-selected,500)] text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] hover:text-[var(--hd-sidebar-selected-foreground,var(--hd-foreground))] [&_svg]:text-[var(--hd-sidebar-selected-muted-foreground,var(--hd-foreground))] [&_[data-slot=rail-item-trail]]:text-[var(--hd-sidebar-selected-muted-foreground,var(--hd-foreground))]',
      className,
    )}
    {...props}
  >
    {icon}
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {/* `data-slot`, so the selected row above can recolour it. Left on the
        muted ink it stayed grey on the selection's own fill — 1.14:1 — which
        is the same defect `ListRow` had and the same fix. */}
    {trail != null && (
      <span
        data-slot="rail-item-trail"
        className="shrink-0 text-xs text-(--hd-muted-foreground) tabular-nums"
      >
        {trail}
      </span>
    )}
  </button>
)

/** Pinned at the foot: the account, the settings, the thing that is always there. */
const RailFooter = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="rail-footer"
    className={cn(
      'mt-auto flex shrink-0 items-center gap-2 border-t border-(--hd-border) p-2',
      className,
    )}
    {...props}
  />
)

export { Rail, RailHeader, RailBody, RailLabel, RailItem, RailFooter }
