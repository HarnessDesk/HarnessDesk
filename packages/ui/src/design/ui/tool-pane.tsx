import type * as React from 'react'

import { CrossIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'
import { TabsList, TabsTrigger } from './tabs'

/**
 * The frame every tool wears.
 *
 * A terminal, a browser, an editor, a repository, a file tree — each has its
 * own body and each needs the same three things around it: a mark saying which
 * tool this is, a line saying what it is pointed at, and the controls that act
 * on the whole pane. Building that frame once is what stops the browser pane's
 * reload button sitting 2px from where the terminal's clear button sits.
 *
 * The subtitle is the pane's *subject* and is nearly always earned: a terminal
 * without its working directory, a browser without its URL, an editor without
 * its path — each is a pane you cannot trust, because you cannot tell what it
 * is showing. This is the exception the second-line rule allows for: a fact
 * that varies, which the title cannot carry.
 *
 * It is set in the code face because that subject is nearly always a *machine
 * string* — a path, a URL, a branch — and those want the figure widths and the
 * unambiguous l/1/O of a mono. `subtitleFace="text"` is for the panes whose
 * subject is a sentence instead: the board's subject is a tally of its own
 * columns, and a tally in a code face reads as a filename that failed to
 * resolve. Two faces and no more; a third would be a pane deciding its own
 * typography.
 *
 * `bleed` is for a body that must reach the frame's edge — a viewport, a
 * terminal, a video. Padding inside a pane whose content has its own ground
 * draws a border nobody asked for.
 */

const ToolPane = ({ className, ...props }: React.ComponentProps<'section'>) => (
  <section
    data-slot="tool-pane"
    className={cn(
      'flex min-h-0 flex-col overflow-hidden rounded-(--hd-radius) border border-(--hd-border) bg-(--hd-card)',
      className,
    )}
    {...props}
  />
)

const ToolPaneHeader = ({
  className,
  icon,
  title,
  subtitle,
  subtitleFace = 'code',
  actions,
  ...props
}: Omit<React.ComponentProps<'header'>, 'title'> & {
  icon?: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** `code` for a path, a URL, a branch; `text` for a sentence. */
  subtitleFace?: 'code' | 'text'
  actions?: React.ReactNode
}) => (
  <header
    data-slot="tool-pane-header"
    className={cn(
      'flex shrink-0 items-center gap-2 border-b border-(--hd-border) px-2.5 py-2',
      className,
    )}
    {...props}
  >
    {icon != null && (
      <span aria-hidden className="shrink-0 text-(--hd-muted-foreground) [&_svg]:size-4">
        {icon}
      </span>
    )}
    <div className="flex min-w-0 flex-1 items-baseline gap-2">
      {/* The title truncates rather than holding its width. `shrink-0` here
          meant that a pane narrow enough — a board inside a room's right half,
          a tool in a three-way split — painted its title straight over its own
          actions, because the flex parent it overflowed was already at zero.
          An ellipsis is a title you can still read the start of. */}
      <span className="min-w-0 truncate text-sm font-medium">{title}</span>
      {subtitle != null && (
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs text-(--hd-muted-foreground)',
            subtitleFace === 'code' && 'font-(family-name:--hd-font-code)',
          )}
        >
          {subtitle}
        </span>
      )}
    </div>
    {actions != null && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
  </header>
)

const ToolPaneBody = ({
  className,
  bleed,
  ...props
}: React.ComponentProps<'div'> & { bleed?: boolean }) => (
  <div
    data-slot="tool-pane-body"
    className={cn('min-h-0 flex-1 overflow-auto', bleed ? 'p-0' : 'p-2.5', className)}
    {...props}
  />
)

/**
 * The strip of tabs a tool pane can carry.
 *
 * `TabsList variant="line"` from the system's tabs, with the pane's own
 * padding and a divider under it — not a second tab component. Everything that
 * makes a tab a tab (roving focus, arrow keys, `aria-controls` wired to the
 * panel) comes from Base UI through `tabs.tsx`; what is added here is the two
 * things a *document* tab has that a section tab does not: it scrolls rather
 * than shrinking, and it can be closed.
 *
 * Tabs, not a dropdown, while there are few enough to see at once: the point
 * of a second open file is knowing it is there. Past what fits, the strip
 * scrolls — a hidden tab is a file the reader has forgotten they left open.
 */
const ToolPaneTabs = ({ className, ...props }: React.ComponentProps<typeof TabsList>) => (
  <TabsList
    variant="line"
    data-slot="tool-pane-tabs"
    className={cn(
      'w-full shrink-0 justify-start gap-0.5 overflow-x-auto border-b border-(--hd-border) px-1.5 py-1',
      className,
    )}
    {...props}
  />
)

/**
 * One tab, and the ✕ that is welded to it rather than inside it.
 *
 * The close control cannot live within the trigger — a button inside a button
 * is invalid markup, and browsers resolve it by dropping one of them, usually
 * the one you wanted. So it is a sibling pulled back over the tab's own
 * padding: it looks welded on, it is separately reachable by keyboard, and the
 * tab's click never has to guess whether it was meant for the ✕.
 */
const ToolPaneTab = ({
  className,
  icon,
  onClose,
  children,
  ...props
}: React.ComponentProps<typeof TabsTrigger> & {
  icon?: React.ReactNode
  onClose?: () => void
}) => (
  <span className="flex shrink-0 items-center">
    <TabsTrigger
      className={cn(
        'h-(--hd-control-h-sm) flex-none gap-1.5 px-2',
        '[&_svg]:size-3.5 [&_svg]:shrink-0',
        onClose && 'pr-5',
        className,
      )}
      {...props}
    >
      {icon}
      <span className="max-w-40 truncate">{children}</span>
    </TabsTrigger>
    {onClose && (
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="-ml-5 inline-flex size-4 items-center justify-center rounded-(--hd-radius-sm) text-(--hd-muted-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) [&_svg]:size-3"
      >
        <CrossIcon />
      </button>
    )}
  </span>
)

export { ToolPane, ToolPaneHeader, ToolPaneBody, ToolPaneTabs, ToolPaneTab }
