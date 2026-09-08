import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

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
 *   The footer is for actions.   Not for a summary, not for a count. A bar at
 *                               the bottom of a card promises something to press.
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
    },
  },
  defaultVariants: { variant: 'card' },
})

type SectionProps = React.ComponentProps<'section'> & VariantProps<typeof sectionVariants>

const Section = ({ className, variant, ...props }: SectionProps) => (
  <section
    data-slot="section"
    data-variant={variant ?? 'card'}
    className={cn(sectionVariants({ variant }), className)}
    {...props}
  />
)

/**
 * Title, optional description, optional action, on one line each doing its job.
 *
 * The grid is `1fr auto` only when an action is present — `has-data-[slot=…]`
 * asks the DOM rather than making the caller pass a flag, which is the shadcn
 * idiom and means a conditionally-rendered action cannot leave a dead column
 * behind.
 */
const SectionHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="section-header"
    className={cn(
      'grid auto-rows-min items-start gap-x-3 gap-y-0.5 px-4 pt-4 has-data-[slot=section-action]:grid-cols-[1fr_auto]',
      className,
    )}
    {...props}
  />
)

const SectionTitle = ({ className, ...props }: React.ComponentProps<'h2'>) => (
  <h2
    data-slot="section-title"
    className={cn('text-base leading-tight font-semibold', className)}
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
 */
const SectionBody = ({
  className,
  inset = true,
  ...props
}: React.ComponentProps<'div'> & { inset?: boolean }) => (
  <div
    data-slot="section-body"
    className={cn('py-4 first:pt-4 [&:not(:first-child)]:pt-3', inset && 'px-4', className)}
    {...props}
  />
)

const SectionFooter = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="section-footer"
    className={cn(
      'mt-auto flex items-center gap-2 border-t border-(--hd-border) px-4 py-3',
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
}
