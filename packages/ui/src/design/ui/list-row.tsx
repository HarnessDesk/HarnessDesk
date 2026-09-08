import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * A line in a list of things, each of which has a face, a name and a reading.
 *
 * Recent sessions, lead sources, top files, connected accounts, agents on a
 * workspace. Once a screen has three of these lists it has three subtly
 * different rows, and the version that grew a second line grew it everywhere.
 *
 * The parts are slots rather than props so a row can hold whatever the list is
 * actually about — a `Delta` on one screen, a `Progress` on the next, a chip
 * and a menu on a third — without this component learning about any of them.
 *
 * `interactive` is a real decision and not a hover style: a row that lights up
 * is a row that promises to do something when pressed. A list of readings is
 * not clickable, and giving it a hover ground teaches the reader to click
 * things that ignore them.
 *
 * The subtitle follows the repo's rule (`docs/design.md`): it is earned by
 * a fact that varies — a path, a count, a reason — and not spent on restating
 * the title in more words.
 */

/* `title` is omitted from the div's own props before being re-declared. It is
   documented here as a `ReactNode`, but intersecting it with the HTML `title`
   attribute — which is a `string` — narrowed it to `string & ReactNode`, so a
   row whose name was anything but a bare string did not compile. Every other
   component in this folder that re-declares `title` already omits it first;
   this one did not, and the slot was a `ReactNode` in the documentation only. */
type ListRowProps = Omit<React.ComponentProps<'div'>, 'title'> & {
  /** An avatar, an `IconTile`, a logo. */
  lead?: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** The reading: a figure, a chip, a `Delta`, a menu. */
  trail?: React.ReactNode
  /** Below the title, full width — a `Progress`, a set of chips. */
  meta?: React.ReactNode
  interactive?: boolean
  /**
   * `sm` is the navigation density: a roster down the side of a screen, where
   * the list is furniture and the content beside it is the subject. It is a
   * different job from the default, which is the list a reader came to read.
   */
  size?: 'sm' | 'default'
  /**
   * One of a set, and the one being shown. Only meaningful in a list that
   * drives something else on screen; a list of readings has no selection, and
   * giving it one invents a state nobody can leave.
   */
  selected?: boolean
  /**
   * This list is a set of destinations, not a set of readings.
   *
   * The distinction is not decoration. A selected row in a *roster* is one
   * record highlighted among records, and a quiet ground is right for it. A
   * selected row in a **navigation column** is the page you are on, and the
   * app marks that one way everywhere — the sidebar, the settings window and
   * the room's rail all read `--hd-sidebar-selected`, so the Interface
   * setting moves the three together.
   *
   * Without this flag the room's rail kept a grey wash while the sidebar
   * beside it filled with the brand, which read as two apps in one window.
   */
  nav?: boolean
}

const ListRow = ({
  className,
  lead,
  title,
  subtitle,
  trail,
  meta,
  interactive,
  size = 'default',
  selected,
  nav,
  ...props
}: ListRowProps) => (
  <div
    data-slot="list-row"
    /* `aria-current` rather than a class alone: a screen reader moving down a
       roster is told which conversation is open, which is the whole reason the
       row looks different. */
    {...(selected ? { 'aria-current': 'true' as const } : {})}
    className={cn(
      'flex items-center',
      size === 'sm' ? 'gap-2 rounded-(--hd-radius-sm) px-2 py-1.5' : 'gap-3 px-4 py-2.5',
      interactive && 'cursor-pointer hover:bg-(--hd-hover)',
      interactive && nav && 'hover:bg-(--hd-sidebar-hover)',
      selected && 'bg-(--hd-selected)',
      /*
       * A selected destination takes the app's one navigation mark, and
       * everything inside it comes off the row's own ink — a subtitle or a
       * count left on `--hd-muted-foreground` is unreadable on a saturated
       * fill.
       *
       * Two things here are not decoration:
       *
       *   The hover is restated. `hover:bg-…` compiles to a `:hover` class,
       *   which outranks a plain `bg-…` by a pseudo-class — so the hover wash
       *   won over the selection and left white text on light grey at 1.1:1
       *   the moment a pointer crossed the row you were on.
       *
       *   Every token carries its Desk value as a `var()` fallback. These four
       *   are defined only in the Studio block, and Tailwind's `bg-(--x)`
       *   shorthand has nowhere to put one — written that way the selected row
       *   had no background at all under Desk, because tailwind-merge had
       *   already dropped the `bg-(--hd-selected)` above as the same utility.
       */
      selected &&
        nav &&
        'bg-[var(--hd-sidebar-selected,var(--hd-selected))] hover:bg-[var(--hd-sidebar-selected,var(--hd-selected))] text-[var(--hd-sidebar-selected-foreground,inherit)] [&_[data-slot=list-row-subtitle]]:text-[var(--hd-sidebar-selected-muted-foreground,var(--hd-muted-foreground))] [&_[data-slot=list-row-trail]]:text-[var(--hd-sidebar-selected-muted-foreground,var(--hd-muted-foreground))]',
      className,
    )}
    {...props}
  >
    {lead != null && <span className="shrink-0">{lead}</span>}
    <div className="min-w-0 flex-1">
      <div
        className={cn(
          'truncate leading-snug',
          size === 'sm' ? 'text-base' : 'text-base font-medium',
          selected && 'font-medium',
        )}
      >
        {title}
      </div>
      {subtitle != null && (
        <div
          data-slot="list-row-subtitle"
          className="truncate text-xs text-(--hd-muted-foreground)"
        >
          {subtitle}
        </div>
      )}
      {meta != null && <div className="mt-1.5">{meta}</div>}
    </div>
    {trail != null && (
      <div
        data-slot="list-row-trail"
        className={cn(
          'flex shrink-0 items-center gap-2 tabular-nums',
          size === 'sm' ? 'text-xs text-(--hd-muted-foreground)' : 'text-xs',
        )}
      >
        {trail}
      </div>
    )}
  </div>
)

/**
 * The rows together.
 *
 * Divided by hairlines rather than gaps: a list separated by whitespace is a
 * stack of cards, which is a different claim — that each entry is its own
 * object rather than one of a set. `divide-y` on the container also means the
 * last row has no trailing rule, which a per-row border cannot manage without
 * a `:last-child` exception someone has to remember.
 *
 * `size="sm"` drops the rules and takes a small gap instead. A roster of
 * rounded, selectable rows is the one list where dividers are wrong: the
 * selected row is a filled shape, and a rule cutting across the shape above
 * and below it makes the selection look like a rendering error.
 */
const ListRows = ({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<'div'> & { size?: 'sm' | 'default' }) => (
  <div
    data-slot="list-rows"
    className={cn(
      'flex flex-col',
      size === 'sm' ? 'gap-0.5' : 'divide-y divide-(--hd-border)',
      className,
    )}
    {...props}
  />
)

export { ListRow, ListRows }
