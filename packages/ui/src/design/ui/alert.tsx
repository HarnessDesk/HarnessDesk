import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Vendored from shadcn/ui (alert).
 *
 * The anatomy the app's `Banner` had been drawing by hand: an icon in the
 * gutter, a title, and a description. `Banner` now sits on this and adds the two things the
 * registry has no opinion about &mdash; the app's four tones, and the dismissal
 * policy.
 *
 * The tone set is ours rather than theirs. The registry ships `default` and
 * `destructive`; this app has always had four, because "your workspace is
 * gone" and "an update installed" are not the same news and a single
 * destructive variant makes the second one shout.
 *
 * **The live-region role is opt-in, and that is a deliberate divergence.** The
 * registry hard-codes `role="alert"`, which is right for the thing it is named
 * after and wrong for most of what this app puts in one: a banner that is on
 * screen when a page mounts is not news, and `alert` is an *assertive* region
 * that interrupts whatever a screen reader was saying to announce it. The
 * first-run offer would talk over the page it is offering to set up. So the
 * role is whatever the caller passes, `undefined` included, and `alert` is
 * reserved for a message that arrives while someone is reading.
 */

const alertVariants = cva(
  'relative flex w-full items-start gap-2.5 rounded-(--hd-radius) border px-3 py-2.5 text-base [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-(--hd-border) bg-(--hd-card) [&>svg]:text-(--hd-muted-foreground)',
        info: 'border-(--hd-tint-sky-edge)/40 bg-(--hd-tint-sky-fill) [&>svg]:text-(--hd-tint-sky-ink)',
        success: 'border-(--hd-success)/40 bg-(--hd-success-dim) [&>svg]:text-(--hd-success-ink)',
        warning: 'border-(--hd-warning)/40 bg-(--hd-warning-dim) [&>svg]:text-(--hd-warning-ink)',
        danger: 'border-(--hd-danger)/40 bg-(--hd-danger-dim) [&>svg]:text-(--hd-danger-ink)',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

const Alert = ({
  className,
  tone,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) => (
  /* No default `role`: see above. `props` carries the caller's, or nothing. */
  <div data-slot="alert" className={cn(alertVariants({ tone }), className)} {...props} />
)

const AlertTitle = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="alert-title"
    className={cn('font-medium tracking-tight', className)}
    {...props}
  />
)

const AlertDescription = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="alert-description"
    className={cn('text-xs text-(--hd-secondary-foreground)', className)}
    {...props}
  />
)

/** The title and description together, so the action can sit beside them. */
const AlertContent = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="alert-content"
    className={cn('flex min-w-0 flex-1 flex-col gap-0.5', className)}
    {...props}
  />
)

export { Alert, AlertTitle, AlertDescription, AlertContent, alertVariants }
