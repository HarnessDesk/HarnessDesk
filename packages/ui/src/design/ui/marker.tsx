import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Something that happened *to* the conversation rather than in it.
 *
 * Adopted from shadcn/ui's `marker`, which is a strict superset of the
 * separator this app already had. The registry does not serve it as JSON yet,
 * so this is built to its published anatomy — `Marker / MarkerIcon /
 * MarkerContent`, three variants, a polymorphic root — rather than pasted; the
 * parts and their names match so a later `shadcn add marker` is a diff and not
 * a translation.
 *
 * What the app gains over the version this replaces is the other two variants,
 * and they are genuinely different claims:
 *
 *   default     Inline. A note in the flow of the transcript — "switched to a
 *               new branch", "thinking". It reads as part of the conversation.
 *   separator   A labelled rule across the column. The event is *between*
 *               turns: a compaction, a resume, a change of day. This was the
 *               only shape the app had, and it was being used for inline notes
 *               it did not fit.
 *   border      A bordered row. A boundary that is still a row — a batch of
 *               work that finished, a section of a log.
 *
 * `render` makes the root polymorphic, so a marker can be the link that opens
 * what it is describing. The icon slot is `aria-hidden`: a marker's meaning is
 * in its words, and a screen reader reading out "circle" before them is worse
 * than silence.
 */

const markerVariants = cva(
  'flex items-center gap-1.5 text-xs text-(--hd-muted-foreground) [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'py-1',
        border: 'rounded-(--hd-radius-sm) border border-(--hd-border) px-2 py-1.5',
        separator: 'py-3 before:h-px before:flex-1 before:bg-(--hd-border) after:h-px after:flex-1 after:bg-(--hd-border) gap-2',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

type MarkerProps = React.ComponentProps<'div'> &
  VariantProps<typeof markerVariants> & {
    /** Render as something else — an anchor, a button. */
    render?: React.ReactElement<Record<string, unknown>>
  }

const Marker = ({ className, variant, render, children, ...props }: MarkerProps) => {
  const merged = {
    'data-slot': 'marker',
    'data-variant': variant ?? 'default',
    className: cn(markerVariants({ variant }), className),
    ...props,
  }
  /* The polymorphic root, done the way Base UI does it: the caller hands over
     an element and we merge onto it, rather than a `Slot` wrapper. Keeps this
     file free of a primitive dependency it otherwise would not need. */
  if (render) {
    return (
      <render.type
        {...render.props}
        {...merged}
        className={cn(merged.className, render.props.className as string | undefined)}
      >
        {children}
      </render.type>
    )
  }
  return <div {...merged}>{children}</div>
}

/**
 * The glyph. Decorative by definition — hidden from assistive tech, because the
 * content beside it already says what happened.
 */
const MarkerIcon = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="marker-icon"
    aria-hidden="true"
    className={cn('inline-flex shrink-0 items-center', className)}
    {...props}
  />
)

/** The words. In the separator variant this is what the rules part around. */
const MarkerContent = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="marker-content"
    className={cn('min-w-0 truncate', className)}
    {...props}
  />
)

export { Marker, MarkerIcon, MarkerContent, markerVariants }
