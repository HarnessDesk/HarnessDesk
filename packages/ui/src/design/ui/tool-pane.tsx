import * as React from 'react'

import { CrossIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'

import { sortableItemClass } from './sortable-list'
import { Text } from '../patterns/Settings'
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

const ToolPane = ({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'section'> & { variant?: 'default' | 'integrated' }) => (
  <section
    data-slot="tool-pane"
    data-variant={variant}
    className={cn(
      'flex min-h-0 flex-col overflow-hidden bg-(--hd-card)',
      variant === 'default' && 'rounded-(--hd-radius) border border-(--hd-border)',
      variant === 'integrated' && 'size-full rounded-none border-0',
      className,
    )}
    {...props}
  />
)

const ToolPaneHeader = ({
  className,
  icon,
  title,
  lead,
  subtitle,
  subtitleFace = 'code',
  actions,
  corner = false,
  variant = 'default',
  hint,
  ...props
}: Omit<React.ComponentProps<'header'>, 'title'> & {
  icon?: React.ReactNode
  title: React.ReactNode
  /** Interactive content that replaces the title while the accessible name remains on the header. */
  lead?: React.ReactNode
  subtitle?: React.ReactNode
  /** `code` for a path, a URL, a branch; `text` for a sentence. */
  subtitleFace?: 'code' | 'text'
  actions?: React.ReactNode
  /** Leave room for the native window controls when this pane owns the corner. */
  corner?: boolean
  variant?: 'default' | 'window'
  hint?: string
}) => (
  <header
    data-slot="tool-pane-header"
    data-variant={variant}
    title={hint}
    {...(corner ? { 'data-corner': '' } : {})}
    className={cn(
      /* A bar, at the height every other bar in the window stands at. It used
         to reach one by adding its padding to whatever the tallest control in
         it happened to be, which put it at 45 — one off the bar above it, and
         one off the bar in the panel beside it, which was 47 by the same
         arithmetic. */
      'flex h-(--hd-bar-h) shrink-0 items-center gap-(--hd-bar-gap) border-b border-(--hd-border)',
      variant === 'default' && 'px-(--hd-bar-pad)',
      variant === 'window' && 'pr-3 pl-4',
      corner && 'pl-[max(var(--hd-space-4),var(--titlebar-inset,0px))]',
      className,
    )}
    {...props}
  >
    {icon != null && (
      <span aria-hidden className="shrink-0 text-(--hd-muted-foreground) [&_svg]:size-4">
        {icon}
      </span>
    )}
    {lead != null ? (
      <div className="flex min-w-0 flex-1 items-center">{lead}</div>
    ) : (
    <div className="flex min-w-0 flex-1 items-baseline gap-2">
      {/* The title truncates rather than holding its width. `shrink-0` here
          meant that a pane narrow enough — a board inside a room's right half,
          a tool in a three-way split — painted its title straight over its own
          actions, because the flex parent it overflowed was already at zero.
          An ellipsis is a title you can still read the start of. */}
      <span className={cn('min-w-0 truncate font-medium', variant === 'window' ? 'text-base' : 'text-sm')}>{title}</span>
      {subtitle != null && (
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs text-(--hd-muted-foreground)',
            subtitleFace === 'code' && 'text-left font-(family-name:--hd-font-code) [direction:rtl]',
          )}
        >
          {subtitle}
        </span>
      )}
    </div>
    )}
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
    {...(bleed ? { 'data-bleed': '' } : {})}
    className={cn('min-h-0 flex-1 overflow-auto', bleed ? 'p-0' : 'p-2.5', className)}
    {...props}
  />
)

/** A divider between controls for the tool and controls for its panel. */
const ToolPaneHeaderDivider = () => (
  <span
    data-slot="tool-pane-header-divider"
    aria-hidden
    className="mx-0.5 h-3.5 w-px shrink-0 self-center bg-(--hd-border-strong)"
  />
)

/**
 * A bar of the tool's own controls under its header.
 *
 * `tools` is the one whose controls are the tool's verbs and filters rather
 * than a single field — a repository's actions, its history's scope and
 * search, the head of the commit it has open. It stands at the same 36px as
 * `find`, and it is a floor rather than a height: a pane narrower than its
 * controls wraps them onto a second line, and the bar grows with them instead
 * of cutting the last one off. A bar whose one line must never break — a head
 * whose title ellipsises instead — says `flex-nowrap`. A bar that is a set of
 * controls says so with `role="toolbar"`, the one role a bar may take.
 */
const ToolPaneBar = ({
  as = 'div',
  variant,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'role'> & {
  as?: 'div' | 'form'
  variant: 'terminal' | 'address' | 'find' | 'annotate' | 'tools'
  role?: 'toolbar'
}) => {
  const height =
    variant === 'terminal'
      ? 'h-(--hd-control-h)'
      : variant === 'address'
        ? 'h-10'
        : variant === 'tools'
          ? 'min-h-9 flex-wrap gap-y-1 py-0.5'
          : 'h-9'
  return React.createElement(as, {
    ...props,
    'data-slot': 'tool-pane-bar',
    'data-variant': variant,
    className: cn(
      'flex shrink-0 items-center',
      height,
      variant === 'terminal'
        ? 'gap-2 pr-2 pl-[max(var(--hd-space-2-5),var(--titlebar-inset,0px))] text-sm text-(--hd-secondary-foreground) select-none'
        : 'gap-1 border-b border-(--hd-border) bg-(--hd-card) px-2',
      className,
    ),
  })
}

const ToolPaneNotice = ({
  tone = 'neutral',
  placement = 'top',
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'div'>, 'role'> & {
  tone?: 'neutral' | 'warning' | 'danger'
  placement?: 'top' | 'bottom'
}) => (
  <div
    data-slot="tool-pane-notice"
    data-placement={placement}
    className={cn(
      'flex shrink-0 items-center gap-2.5 bg-(--hd-muted) px-3 py-2 text-base leading-(--hd-line) text-(--hd-secondary-foreground)',
      placement === 'top' ? 'border-b border-(--hd-border)' : 'border-t border-(--hd-border)',
      tone === 'warning' && 'bg-(--hd-warning-dim) text-(--hd-warning-ink)',
      tone === 'danger' && 'bg-(--hd-danger-dim) text-(--hd-danger)',
      className,
    )}
    {...props}
  >
    {children}
  </div>
)

const ToolPaneMessage = ({
  as = 'p',
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'p'>, 'role'> & { as?: 'p' | 'div' }) => (
  React.createElement(as, {
    ...props,
    'data-slot': 'tool-pane-message',
    className: cn('m-0 p-4 text-base leading-(--hd-line) text-(--hd-muted-foreground)', className),
  }, children)
)

const ToolPaneEmptyState = ({
  icon,
  title,
  description,
  over = false,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  over?: boolean
}) => (
  <div
    data-slot="tool-pane-empty"
    {...(over ? { 'data-over': '' } : {})}
    className={cn(
      'flex max-w-full flex-1 flex-col items-center justify-center gap-3 bg-(--hd-card) p-6 text-center',
      over && 'absolute inset-0',
    )}
  >
    {icon != null && <span className="inline-grid place-items-center text-(--hd-border-emphasis)">{icon}</span>}
    <Text role="prose" ink="secondary">{title}</Text>
    {description != null && <Text as="p" role="muted" ink="muted" className="m-0 max-w-[40ch]">{description}</Text>}
  </div>
)

/**
 * Where a tool shows a page that is not ours — a site in the browser, a file's
 * rendered preview. It fills the body; `framed` is for a page shown at a
 * device's size instead, set on the muted ground a device frame stands on so
 * its edge reads as the device's and not the pane's.
 */
const ToolPaneStage = ({
  className,
  framed = false,
  ...props
}: React.ComponentProps<'div'> & { framed?: boolean }) => (
  <div
    data-slot="tool-pane-stage"
    {...(framed ? { 'data-framed': '' } : {})}
    className={cn('flex min-h-0 flex-1', framed && 'items-center justify-center overflow-hidden bg-(--hd-muted)', className)}
    {...props}
  />
)

/**
 * The guest itself: the `<iframe>` or `<webview>` a stage holds.
 *
 * Its ground is the one a web page assumes when it paints none of its own —
 * white, whatever the app's theme (`--hd-external-canvas`) — because a page
 * with no background of its own set in dark ink on the app's dark card is a
 * page nobody can read. `framed` gives it the device's corner and hairline.
 * `as="webview"` is Electron's guest tag, which JSX has no type for; the
 * attributes it takes (`partition`, `allowpopups`, `useragent`) pass through.
 */
const ToolPaneGuest = ({
  as = 'iframe',
  framed = false,
  className,
  ...props
}: Omit<React.ComponentProps<'iframe'>, 'ref'> & {
  as?: 'iframe' | 'webview'
  framed?: boolean
  /* Whichever element it is, typed by the caller: a `<webview>` ref is
     Electron's own element type, which no DOM type describes. */
  ref?: React.Ref<never>
  [attribute: string]: unknown
}) =>
  React.createElement(as, {
    ...props,
    'data-slot': 'tool-pane-guest',
    ...(framed ? { 'data-framed': '' } : {}),
    className: cn(
      'size-full flex-1 border-0 bg-(--hd-external-canvas)',
      framed && 'rounded-(--hd-radius-sm) shadow-(--hd-hairline)',
      className,
    ),
  })

/** A manual document tab for native guests that must remain mounted. */
const ToolPaneDocumentTab = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="tool-pane-document-tab"
    className={cn(
      'flex h-(--hd-control-h) shrink-0 cursor-pointer items-center gap-1.5 rounded-(--hd-radius-sm) py-0 pr-1 pl-2 text-base leading-(--hd-line) whitespace-nowrap text-(--hd-secondary-foreground)',
      'hover:bg-(--hd-hover) hover:text-(--hd-foreground)',
      'data-[active]:bg-(--hd-muted) data-[active]:text-(--hd-foreground) data-[active]:shadow-[inset_0_0_0_1px_var(--hd-border)]',
      // A tab in a strip the person orders draws its move the way every sortable item does.
      sortableItemClass('horizontal'),
      className,
    )}
    {...props}
  />
)

const ToolPaneTabViewport = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & { edges: { start: boolean; end: boolean } }
>(({ className, edges, style, ...props }, ref) => {
  const maskImage = edges.start && edges.end
    ? 'linear-gradient(to right, transparent, #000 20px, #000 calc(100% - 20px), transparent)'
    : edges.start
      ? 'linear-gradient(to right, transparent, #000 20px)'
      : edges.end
        ? 'linear-gradient(to right, #000 calc(100% - 20px), transparent)'
        : undefined
  return (
    <div
      ref={ref}
      data-slot="tool-pane-tab-viewport"
      {...(edges.start ? { 'data-more-start': '' } : {})}
      {...(edges.end ? { 'data-more-end': '' } : {})}
      className={cn('flex min-w-0 flex-initial items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
      style={{ ...style, maskImage }}
      {...props}
    />
  )
})
ToolPaneTabViewport.displayName = 'ToolPaneTabViewport'

const ToolPaneTabIcon = ({ className, ...props }: React.ComponentProps<'img'>) => (
  <img
    data-slot="tool-pane-tab-icon"
    className={cn('size-3.5 shrink-0 rounded-(--hd-radius-2xs) object-contain', className)}
    {...props}
  />
)

const ToolPaneActivity = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="tool-pane-activity"
    className={cn(
      'absolute right-3 bottom-3 left-3 flex items-center gap-2.5 rounded-(--hd-radius) bg-(--hd-card) px-3 py-2 shadow-[var(--hd-shadow),inset_0_0_0_1px_var(--hd-border-strong)]',
      className,
    )}
    {...props}
  />
)

const ToolPaneActivityMark = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="tool-pane-activity-mark"
    className={cn('inline-grid size-(--hd-chip-h) shrink-0 place-items-center rounded-full text-(--hd-accent) shadow-[inset_0_0_0_1.5px_var(--hd-accent)]', className)}
    {...props}
  />
)

const ToolPaneToolGroup = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="tool-pane-tool-group"
    className={cn('inline-flex shrink-0 gap-0.5 rounded-(--hd-radius-sm) bg-(--hd-card-raised) p-0.5', className)}
    {...props}
  />
)

const ToolPaneFooter = ({ children, className, ...props }: Omit<React.ComponentProps<'div'>, 'role'>) => (
  <div
    data-slot="tool-pane-footer"
    className={cn('flex shrink-0 items-center gap-2 border-t border-(--hd-border) px-2.5 py-2 text-xs leading-(--hd-line) text-(--hd-muted-foreground)', className)}
    {...props}
  >
    {children}
  </div>
)

const ToolPaneReading = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="tool-pane-reading" className={cn('max-w-3xl px-6 py-4', className)} {...props} />
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

export {
  ToolPane,
  ToolPaneActivity,
  ToolPaneActivityMark,
  ToolPaneBar,
  ToolPaneBody,
  ToolPaneDocumentTab,
  ToolPaneEmptyState,
  ToolPaneFooter,
  ToolPaneGuest,
  ToolPaneHeader,
  ToolPaneHeaderDivider,
  ToolPaneMessage,
  ToolPaneNotice,
  ToolPaneReading,
  ToolPaneStage,
  ToolPaneTab,
  ToolPaneTabIcon,
  ToolPaneTabViewport,
  ToolPaneTabs,
  ToolPaneToolGroup,
}
