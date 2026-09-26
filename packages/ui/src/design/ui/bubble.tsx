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
 *
 * `variant` is said once, on `Bubble`; `BubbleContent` reads it from context
 * rather than taking its own copy of the same prop. A round asked for this —
 * every caller was writing `<Bubble variant="ghost"><BubbleContent
 * variant="ghost">`, the same word twice for one choice, with nothing
 * stopping the two from disagreeing.
 */

const BubbleVariantContext = React.createContext<'secondary' | 'ghost'>('secondary')

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

/* Ref-forwarding pairs with `BubbleContent` below: a caller measuring the
   content's own overflow may as well be able to reach the frame around it
   the same way, and a part with a sibling that forwards its ref and one that
   does not is the inconsistency a round of review found here. */
const Bubble = React.forwardRef<HTMLDivElement, BubbleProps>(({ className, variant, children, ...props }, ref) => {
  const resolved = variant ?? 'secondary'
  return (
    <BubbleVariantContext.Provider value={resolved}>
      <div ref={ref} data-slot="bubble" data-variant={resolved} className={cn(bubbleVariants({ variant }), className)} {...props}>
        {children}
      </div>
    </BubbleVariantContext.Provider>
  )
})
Bubble.displayName = 'Bubble'

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

type BubbleContentProps = React.ComponentProps<'div'> & {
  /**
   * Fold past this many lines of the reading size, until `expanded` — the
   * clamp both callers use (the user's own message at twelve, the room's
   * channel line at nine). A screen keeps the overflow measurement and the
   * "Show more" toggle itself; this is only the box's own height, in lines
   * rather than an arbitrary Tailwind pixel value written by hand.
   */
  clampLines?: number
  expanded?: boolean
}

const BubbleContent = React.forwardRef<HTMLDivElement, BubbleContentProps>(
  ({ className, clampLines, expanded = false, style, ...props }, ref) => {
    const variant = React.useContext(BubbleVariantContext)
    const clamp = !expanded && clampLines != null
    return (
      <div
        ref={ref}
        data-slot="bubble-content"
        className={cn(bubbleContentVariants({ variant }), clamp && 'overflow-hidden', className)}
        style={clamp ? { ...style, maxHeight: `calc(var(--hd-line) * ${clampLines})` } : style}
        {...props}
      />
    )
  },
)
BubbleContent.displayName = 'BubbleContent'

export { Bubble, BubbleContent, bubbleVariants, bubbleContentVariants }
export type { BubbleProps, BubbleContentProps }
