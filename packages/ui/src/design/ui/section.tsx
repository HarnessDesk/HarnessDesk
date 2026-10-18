import { cva, type VariantProps } from 'class-variance-authority'
import { createContext, useContext } from 'react'
import type * as React from 'react'

import { cn } from '@/lib/utils'
import { GroupLabel } from './group-label'
import { Text } from '../patterns/Settings'

/**
 * The card with a job: a titled region of a page.
 *
 * `Card` from the shadcn layer is a surface — a box with a ground and a corner.
 * `Section` is what almost every screen actually wants on top of it: a heading
 * that names the region, an optional line saying what the region is for, an
 * action that belongs to the region rather than to any row inside it, a body,
 * and sometimes a footer bar.
 *
 * Building it once matters because the alternative is what the survey found on
 * every admin template: forty hand-rolled headers, each with its own idea of the
 * gap between title and description, and the action variously 12px, 16px and
 * 20px from the right edge. That drift is invisible on any one screen and
 * obvious across ten.
 *
 * Two rules the parts hold, and both come from this repo rather than the
 * references:
 *
 *   The description is earned.   `docs/design.md` — a grey line under every
 *                               heading explains nothing, because the one that
 *                               warns looks like the four that natter. Give a
 *                               section a description when it needs one.
 *
 *   The default footer is for actions. A bar at the bottom of a card promises
 *   something to press. Quiet facts use the facts variant with natural height.
 *
 * It comes in two forms, chosen by whether it has a `title`. With one, it is a
 * section of a page: the label over a card, the spacing owned (below). Without
 * one, it is a boxed region — `card`, `plain`, `quiet`, `panel` — headed from
 * inside by `SectionHeader` when it is headed at all.
 */

const sectionVariants = cva('flex flex-col', {
  variants: {
    variant: {
      /* The default: an object on the page, with an edge of its own. */
      card: 'rounded-(--hd-radius) border border-(--hd-border) bg-(--hd-card)',
      /* No edge. For a region inside a surface that already has one — a card
         within a card is a box someone forgot to delete. */
      plain: '',
      /* A quiet inset panel: an aside, a summary block, a note. */
      quiet: 'rounded-(--hd-radius) bg-(--hd-muted)',
      /* A collapsible plugin panel inside a column: one separating rule and
         the compact inset the block vocabulary has always used. It stands no
         taller than the column allots its panels (`--panel-max`, which the
         column sets), so a long one scrolls inside itself instead of taking
         the column's list away. */
      panel: 'max-h-(--panel-max,none) gap-(--hd-card-gap) border-t border-(--hd-border) p-(--hd-inset-row)',
      /* A section of a page, with its label outside and over its card. Drawn
         only through `title` (below), which is what gives it its head. */
      page: 'mt-(--hd-space-8) min-w-0 gap-(--hd-card-gap) first:mt-0 *:my-0! [&>[data-section-head]]:mt-(--hd-space-3)! [&>button]:self-start',
      /* A file or definition, with its tools in a compact ruled header. */
      document: 'min-w-0 rounded-(--hd-panel-card-radius) border border-(--hd-border-strong) bg-(--hd-background)',
    },
  },
  defaultVariants: { variant: 'card' },
})

/**
 * A section of a page: the unit a settings page, a detail page and a project
 * page are made of.
 *
 * A page used to be a `SectionHead`, a `Note` and a `Rows` card, stacked by
 * hand — three parts, each with its own margin, and nothing owning the space
 * between them. The label sat 20px under the card above and 8px over its own,
 * a free paragraph came between them with 10 more, and a page of one-row
 * cards read as a list of floating grey words. So the section owns the rhythm,
 * and a screen that composes sections writes no margin of its own:
 *
 *   heading → content      12px (`--hd-card-gap`), the label belongs to its card.
 *                          The heading sits on its card: an action taller than
 *                          the label grows upward, so every label on a page is
 *                          the same 12px above what it names
 *   section → section      32px (`--hd-space-8`); after a page or detail head
 *                          the head's own 24px collapses into it, so the first
 *                          section sits at the same 32px as every other one
 *   inside, child → child  12px (`--hd-card-gap`); a card's or a note's own margin is dropped,
 *                          so nothing inside can reopen the gap. A card
 *                          fills the column; a lone button keeps its own
 *                          width at the start, never a full-width bar.
 *   a sub-group inside     a `SectionHead` among its children is a sub-head:
 *                          24px above it (12 on the gap), 12px to its card —
 *                          a step between the two, so Permissions' twelve
 *                          runtimes read as groups of one section rather
 *                          than twelve sections
 *
 * The heading is a small `GroupLabel` for forms and inspector groups; page-body
 * bands use `level="heading"` and the 16px semibold section role. The
 * `description` is one muted sentence directly under it — what the section is,
 * never a paragraph of how it works (that belongs on the row it explains, or
 * nowhere). The `action` belongs to the section rather than to any row in it,
 * sits at the heading's end, and follows the `sectionAction` slot rule: a
 * small `outline` button.
 *
 * It renders `<section aria-label={title}>`, so the title is a plain string: a
 * landmark's name has to be one.
 */
type PageSectionProps = Omit<React.ComponentProps<'section'>, 'title'> & {
  title: string
  /** Page-body bands use the section role; forms and inspector groups stay labels. */
  level?: 'label' | 'heading'
  description?: React.ReactNode
  action?: React.ReactNode
  /** @deprecated Page section headings stay on their content edge. */
  inset?: 'row' | 'card'
  variant?: never
}

/** The boxed region: a surface with its own ground or edge, headed from inside by `SectionHeader`. */
type RegionProps = React.ComponentProps<'section'> & {
  /** Tools inside a boxed region; the document variant uses a compact ruled bar. */
  header?: React.ReactNode
  variant?: Exclude<VariantProps<typeof sectionVariants>['variant'], 'page'>
  title?: never
  level?: never
  description?: never
  action?: never
}

type SectionProps = PageSectionProps | RegionProps

const isPageSection = (props: SectionProps): props is PageSectionProps => typeof props.title === 'string'

/*
 * Whether this is inside a titled Section. A section label is an h2; a
 * `SectionHead` among a Section's children heads a group of that section, so
 * it asks here and is an h3 — the outline follows the page's shape.
 */
const InPageSection = createContext(false)
const useInPageSection = (): boolean => useContext(InPageSection)

const Section = (props: SectionProps) => {
  if (isPageSection(props)) {
    const { className, title, description, action, inset, level = 'label', children, ...rest } = props
    void inset
    return (
      <section
        data-slot="section"
        data-variant="page"
        aria-label={title}
        className={cn(sectionVariants({ variant: 'page' }), className)}
        {...rest}
      >
        <div
          data-slot="section-head"
          /* This is page furniture. A body's card or row inset belongs to
             that body and never moves the heading away from the page edge.
             The description is a full-width flex item that cannot shrink
             beside the title, so it always starts below the heading. */
          className="flex min-w-0 flex-wrap items-end gap-x-(--hd-space-3) gap-y-(--hd-space-0-5)"
        >
          {level === 'heading'
            ? <Text as="h2" role="section" data-section-name="" className="m-0 min-w-0 flex-[1_1_20ch] truncate">{title}</Text>
            : <GroupLabel as="h2" data-section-name="" className="min-w-0 flex-[1_1_20ch] truncate">{title}</GroupLabel>}
          {action != null && (
            <div data-slot="section-action" className="flex max-w-full flex-none flex-wrap items-center gap-(--hd-space-2)">
              {action}
            </div>
          )}
          {description != null && (
            <p
              data-slot="section-description"
              className="m-0 basis-full shrink-0 text-(length:--hd-text-sm) leading-(--hd-line-sm) text-(--hd-muted-foreground)"
            >
              <span className="inline-block max-w-[62ch]">{description}</span>
            </p>
          )}
        </div>
        <InPageSection.Provider value>{children}</InPageSection.Provider>
      </section>
    )
  }
  const { className, variant, header, children, ...rest } = props
  return (
    <section
      data-slot="section"
      data-variant={variant ?? 'card'}
      className={cn(sectionVariants({ variant }), className)}
      {...rest}
    >
      {header != null && <SectionHeader variant={variant === 'document' ? 'bar' : 'default'}>{header}</SectionHeader>}
      {children}
    </section>
  )
}

/**
 * Title, optional description, optional action, on one line each doing its job.
 *
 * The grid is `1fr auto` only when an action is present — `has-data-[slot=…]`
 * asks the DOM rather than making the caller pass a flag, which is the shadcn
 * idiom and means a conditionally-rendered action cannot leave a dead column
 * behind.
 */
const SectionHeader = ({ className, variant = 'default', ...props }: React.ComponentProps<'div'> & { variant?: 'default' | 'bar' }) => (
  <div
    data-slot="section-header"
    className={cn(
      variant === 'bar' ? 'flex flex-wrap items-center gap-(--hd-space-2) border-b border-(--hd-border) p-(--hd-space-3)'
        : 'grid auto-rows-min items-start gap-x-3 gap-y-0.5 px-4 pt-4 has-data-[slot=section-action]:grid-cols-[1fr_auto]',
      className,
    )}
    {...props}
  />
)

const SectionTitle = ({ className, ...props }: React.ComponentProps<'h2'>) => (
  <h2
    data-slot="section-title"
    className={cn('text-base leading-(--hd-line) font-medium', className)}
    {...props}
  />
)

const SectionDescription = ({ className, ...props }: React.ComponentProps<'p'>) => (
  <p
    data-slot="section-description"
    className={cn('text-xs text-(--hd-muted-foreground)', className)}
    {...props}
  />
)

const SectionAction = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="section-action"
    className={cn('col-start-2 row-span-2 row-start-1 flex items-center gap-2 self-start', className)}
    {...props}
  />
)

/**
 * The body.
 *
 * `inset={false}` drops the horizontal padding, which is what a table or a list
 * of full-bleed rows needs — the rows draw their own padding and their hover
 * ground has to reach the card's edge or it looks like a mistake.
 * `spacing="inline"` keeps the row inset at the sides while an unframed
 * child's own rhythm owns its top and bottom, such as an inline empty state.
 */
const SectionBody = ({
  className,
  inset = true,
  spacing = 'default',
  ...props
}: React.ComponentProps<'div'> & {
  inset?: boolean
  spacing?: 'default' | 'compact' | 'inline' | 'tool-prose' | 'document'
}) => (
  <div
    data-slot="section-body"
    data-spacing={spacing}
    className={cn(
      spacing === 'default' && 'py-4 first:pt-4 [&:not(:first-child)]:pt-3',
      spacing === 'compact' && 'py-3',
      spacing === 'document' && 'min-w-0 py-(--hd-space-4)',
      /* desk: tool prose 16 → 12, a card's prose stands on its rows' edge (owner, 2026-10-14) */
      inset && (spacing === 'tool-prose' || spacing === 'inline' ? 'px-(--hd-inset-row)' : spacing === 'compact' ? 'px-3' : 'px-4'),
      className,
    )}
    {...props}
  />
)

/** Quiet facts wrap at natural height; action footers retain their existing spacing. */
const SectionFooter = ({ className, variant = 'actions', ruled = true, ...props }: React.ComponentProps<'div'> & {
  variant?: 'actions' | 'facts'
  ruled?: boolean
}) => (
  <div
    data-slot="section-footer"
    data-variant={variant}
    className={cn(
      variant === 'actions' ? 'mt-auto flex items-center gap-2 border-t border-(--hd-border) px-4 py-3'
        : 'flex shrink-0 flex-wrap items-center gap-(--hd-bar-gap) px-(--hd-inset-row) py-(--hd-space-1)',
      variant === 'facts' && ruled && 'border-t border-(--hd-border)',
      className,
    )}
    {...props}
  />
)

/**
 * The bar above a list: what you can do, and how to find things.
 *
 * Actions left, search and filters right — the order the hand expects, because
 * the primary action is the thing being looked for and the filters are the
 * thing being reached for second. `<ToolbarGap />` is the only spacer; a
 * toolbar with two spacers has a middle section nobody planned.
 */
const Toolbar = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="toolbar"
    className={cn('flex flex-wrap items-center gap-2', className)}
    {...props}
  />
)

const ToolbarGap = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="toolbar-gap" aria-hidden className={cn('flex-1', className)} {...props} />
)

export {
  Section,
  SectionHeader,
  SectionTitle,
  SectionDescription,
  SectionAction,
  SectionBody,
  SectionFooter,
  Toolbar,
  ToolbarGap,
  sectionVariants,
  useInPageSection,
}
