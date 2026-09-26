import * as React from 'react'

import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/*
 * Vendored from shadcn/ui — the surface a chat message part's words stand on,
 * beside `Message`.
 *
 * Two variants have a caller today: `secondary` is the current person's own
 * words, a filled shape sized to its content; `ghost` is everyone else's — an
 * assistant's answer, a room's channel line — unframed and the full width of
 * the row, because rich, rendered prose reads as a document, not a chip. The
 * registry names five more (`default`, `muted`, `tinted`, `outline`,
 * `destructive`); none is drawn here; the audit's own rule is the reason —
 * a variant earns its keep by a screen reaching for it, not by the catalogue
 * being complete in advance.
 */

/* No shared gap: the one bubble with a second child (the user's own —
   `BubbleContent` beside a "Show all" toggle) already spaces that toggle
   itself, in the margin the toggle carried before this part existed. Adding
   a flex `gap` here as well would double it under that one caller. */
const bubbleVariants = cva('flex flex-col', {
  variants: {
    variant: {
      /* The shape sized to its content: a filled plate, up to two thirds of
         the reading column so a one-line reply and a wall of text still both
         read as one bubble rather than a full-width slab. `items-start`
         keeps the plate hugging its own text rather than stretching to the
         cap it may never reach. */
      secondary: 'max-w-[66.6667%] items-start rounded-(--hd-radius-xl) bg-(--hd-muted) px-(--hd-space-4) py-(--hd-space-2-5)',
      /* No frame at all: the full row, for prose that already carries its
         own headings, lists and code fences and would otherwise sit inside a
         second box on top of the ones Markdown already draws. `items-stretch`
         is the one this variant needs and `secondary` does not: an unframed
         child has no width of its own to hug, so without it the row's prose
         reads at its own fit-content width instead of the column's. */
      ghost: 'w-full items-stretch',
    },
  },
  defaultVariants: { variant: 'secondary' },
})

type BubbleProps = React.ComponentProps<'div'> & VariantProps<typeof bubbleVariants>

const Bubble = ({ className, variant, ...props }: BubbleProps) => (
  <div data-slot="bubble" data-variant={variant ?? 'secondary'} className={cn(bubbleVariants({ variant }), className)} {...props} />
)

const bubbleContentVariants = cva('min-w-0', {
  variants: {
    variant: {
      /* Literal text, not Markdown: the sender's own line breaks are the
         only structure it has, so they are kept, and a long unbroken token
         (a path, a URL) wraps rather than pushing the bubble wide. */
      secondary: 'text-base leading-(--hd-line) whitespace-pre-wrap [overflow-wrap:anywhere]',
      ghost: '',
    },
  },
  defaultVariants: { variant: 'secondary' },
})

type BubbleContentProps = React.ComponentProps<'div'> &
  VariantProps<typeof bubbleContentVariants> & {
    /**
     * Fold past this many lines of the reading size, until `expanded` —
     * the user bubble's own clamp. A screen keeps the overflow measurement
     * and the "Show more" toggle itself; this is only the box's own height,
     * so the two callers that clamp (a sent message, a room's own reply)
     * are not left writing the same arbitrary Tailwind value by hand.
     */
    clampLines?: number
    /** Fold at this pixel height instead — the room channel's own clamp, measured off the document's read size rather than a fixed count of lines. */
    clampHeight?: number
    expanded?: boolean
  }

/* Ref-forwarding: the two screens that clamp measure their own overflow
   (`scrollHeight` against the box `ResizeObserver` watches), which needs the
   node itself, not a wrapper's opinion of it. */
const BubbleContent = React.forwardRef<HTMLDivElement, BubbleContentProps>(
  ({ className, variant, clampLines, clampHeight, expanded = false, style, ...props }, ref) => {
    const clamp = !expanded && (clampLines != null || clampHeight != null)
    return (
      <div
        ref={ref}
        data-slot="bubble-content"
        className={cn(bubbleContentVariants({ variant }), clamp && 'overflow-hidden', className)}
        style={
          clamp
            ? { ...style, maxHeight: clampLines != null ? `calc(var(--hd-line) * ${clampLines})` : clampHeight }
            : style
        }
        {...props}
      />
    )
  },
)
BubbleContent.displayName = 'BubbleContent'

export { Bubble, BubbleContent, bubbleVariants, bubbleContentVariants }
export type { BubbleProps, BubbleContentProps }
