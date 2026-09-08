import type * as React from 'react'

import { ChevronIcon, MoreIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'

/**
 * Vendored from shadcn/ui (breadcrumb).
 *
 * Adopted because the app had two hand-rolled crumb rows in the mock pages and
 * none in the product, which is the state just before a third gets written. The
 * registry's version brings the three things a hand-rolled row always skips:
 * `nav[aria-label]` around an `<ol>` so it is announced as a list of one, a
 * current page that is marked rather than merely styled, and an ellipsis for
 * the middle when the path is too long for the bar.
 *
 * Two local departures. The `asChild`/`Slot` prop is dropped — nothing in this
 * app renders a crumb as a router link, and carrying a Radix dependency for an
 * unused escape hatch is the sort of thing the audit counts. And the separator
 * takes the icon facade's chevron rather than importing lucide directly, per
 * the rule every file in this folder follows.
 */

const Breadcrumb = ({ ...props }: React.ComponentProps<'nav'>) => (
  <nav data-slot="breadcrumb" aria-label="Breadcrumb" {...props} />
)

const BreadcrumbList = ({ className, ...props }: React.ComponentProps<'ol'>) => (
  <ol
    data-slot="breadcrumb-list"
    className={cn(
      'flex flex-wrap items-center gap-1.5 text-xs break-words text-(--hd-muted-foreground)',
      className,
    )}
    {...props}
  />
)

const BreadcrumbItem = ({ className, ...props }: React.ComponentProps<'li'>) => (
  <li
    data-slot="breadcrumb-item"
    className={cn('inline-flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0', className)}
    {...props}
  />
)

const BreadcrumbLink = ({ className, ...props }: React.ComponentProps<'a'>) => (
  <a
    data-slot="breadcrumb-link"
    className={cn('transition-colors hover:text-(--hd-foreground)', className)}
    {...props}
  />
)

/**
 * Where you are.
 *
 * `aria-current="page"` and `aria-disabled` rather than a link that goes
 * nowhere: the last crumb is the only one that is not a way out, and a screen
 * reader has to be told which one that is.
 */
const BreadcrumbPage = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="breadcrumb-page"
    role="link"
    aria-disabled="true"
    aria-current="page"
    className={cn('font-medium text-(--hd-foreground)', className)}
    {...props}
  />
)

const BreadcrumbSeparator = ({ children, className, ...props }: React.ComponentProps<'li'>) => (
  <li
    data-slot="breadcrumb-separator"
    role="presentation"
    aria-hidden="true"
    className={cn('[&_svg]:size-3 [&_svg]:text-(--hd-muted-foreground)', className)}
    {...props}
  >
    {children ?? <ChevronIcon />}
  </li>
)

/** The middle of a path too long for the bar. Announced as "More". */
const BreadcrumbEllipsis = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="breadcrumb-ellipsis"
    role="presentation"
    aria-hidden="true"
    className={cn('flex size-4 items-center justify-center [&_svg]:size-3.5', className)}
    {...props}
  >
    <MoreIcon />
    <span className="sr-only">More</span>
  </span>
)

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
}
