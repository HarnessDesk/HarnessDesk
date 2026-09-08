import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { CrossIcon, FileIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'

/**
 * A file, and what is happening to it.
 *
 * Adopted from shadcn/ui's `attachment`. The version this replaces drew a
 * thumbnail, a name and a size, and stopped — which is fine for a file that is
 * already attached and useless for the only moment that actually needs a
 * component: the seconds between choosing a file and it being there. An
 * attachment is in flight before it is an attachment, and the composer had
 * nowhere to say so.
 *
 * So the state is the point, and it is a real enum rather than a spinner
 * someone remembers to render:
 *
 *   idle        attached, nothing happening
 *   uploading   with a determinate bar, because the size is known
 *   processing  indeterminate — the desk is waiting on something it cannot
 *               measure, and a fake percentage is a lie
 *   error       the reason on the row, not in a toast that has gone by the
 *               time anyone looks
 *   done        says nothing extra. The expected outcome is a whisper.
 *
 * Built to the registry's published anatomy — `Attachment / AttachmentMedia /
 * AttachmentContent / AttachmentTitle / AttachmentDescription /
 * AttachmentActions / AttachmentAction`, plus `AttachmentGroup` — since it is
 * not served as JSON yet. Names match so a later `shadcn add` is a diff.
 */

const attachmentVariants = cva(
  'group/attachment relative flex min-w-0 items-center gap-2 rounded-(--hd-radius-sm) border border-(--hd-border) bg-(--hd-card) text-left',
  {
    variants: {
      size: {
        sm: 'p-1 text-xs',
        default: 'p-1.5 text-sm',
        lg: 'p-2 text-sm',
      },
      orientation: {
        /* `shrink-0` with a floor on the width: the whole point of a group that
           scrolls is that its items keep their size. Without it the flex row
           squeezes every card until four attachments are four ellipses, which
           is worse than one card and an arrow. */
        horizontal: 'w-56 shrink-0 flex-row',
        /* Stacked: the picture is the label, so it goes above and the text
           under it. Only worth it when there is a real thumbnail. */
        vertical: 'w-28 flex-col items-stretch',
      },
    },
    defaultVariants: { size: 'default', orientation: 'horizontal' },
  },
)

export type AttachmentState = 'idle' | 'uploading' | 'processing' | 'error' | 'done'

type AttachmentProps = React.ComponentProps<'div'> &
  VariantProps<typeof attachmentVariants> & {
    state?: AttachmentState
    /** 0&ndash;100, for `uploading` only. Anything else draws no bar. */
    progress?: number
  }

const Attachment = ({
  className,
  size,
  orientation,
  state = 'idle',
  progress,
  children,
  ...props
}: AttachmentProps) => (
  <div
    data-slot="attachment"
    data-state={state}
    className={cn(
      attachmentVariants({ size, orientation }),
      state === 'error' && 'border-(--hd-danger)/50 bg-(--hd-danger-dim)',
      className,
    )}
    {...props}
  >
    {children}
    {(state === 'uploading' || state === 'processing') && (
      <span
        aria-hidden
        className="absolute inset-x-1.5 bottom-1 h-0.5 overflow-hidden rounded-full bg-(--hd-muted)"
      >
        <span
          className={cn(
            'block h-full rounded-full bg-(--hd-primary)',
            /* Determinate where the size is known; a travelling sliver where it
               is not. A bar that pretends to know is worse than one that
               admits it does not. */
            state === 'processing' && 'w-1/3 animate-pulse',
          )}
          style={state === 'uploading' ? { width: `${Math.min(100, Math.max(0, progress ?? 0))}%` } : undefined}
        />
      </span>
    )}
  </div>
)

/** The thumbnail or the file glyph. `image` lets an `<img>` fill it. */
const AttachmentMedia = ({
  className,
  variant = 'icon',
  children,
  ...props
}: React.ComponentProps<'span'> & { variant?: 'icon' | 'image' }) => (
  <span
    data-slot="attachment-media"
    data-variant={variant}
    className={cn(
      'flex shrink-0 items-center justify-center overflow-hidden rounded-(--hd-radius-sm) bg-(--hd-muted) text-(--hd-muted-foreground)',
      variant === 'image'
        ? 'size-9 group-data-[orientation=vertical]/attachment:h-16 group-data-[orientation=vertical]/attachment:w-full [&_img]:size-full [&_img]:object-cover'
        : 'size-8 [&_svg]:size-4',
      className,
    )}
    {...props}
  >
    {children ?? <FileIcon aria-hidden />}
  </span>
)

const AttachmentContent = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="attachment-content"
    className={cn('flex min-w-0 flex-1 flex-col', className)}
    {...props}
  />
)

const AttachmentTitle = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span data-slot="attachment-title" className={cn('truncate', className)} {...props} />
)

/**
 * The second line: the size, the progress, or the reason it failed.
 *
 * Tinted by the attachment's state through the group, so a caller cannot put a
 * failure message in the same grey as a file size.
 */
const AttachmentDescription = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="attachment-description"
    className={cn(
      'truncate text-xs text-(--hd-muted-foreground) tabular-nums',
      'group-data-[state=error]/attachment:text-(--hd-danger-ink)',
      className,
    )}
    {...props}
  />
)

const AttachmentActions = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    data-slot="attachment-actions"
    className={cn('flex shrink-0 items-center gap-0.5', className)}
    {...props}
  />
)

/**
 * A control on the attachment.
 *
 * Independently clickable, which is why the whole card is not a button: remove
 * and open are different acts, and a card that opens when you meant to remove
 * is the reason this is two elements rather than one.
 */
const AttachmentAction = ({
  className,
  children,
  ...props
}: React.ComponentProps<'button'>) => (
  <button
    type="button"
    data-slot="attachment-action"
    className={cn(
      'inline-flex size-5 items-center justify-center rounded-(--hd-radius-sm) text-(--hd-muted-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) [&_svg]:size-3',
      className,
    )}
    {...props}
  >
    {children ?? <CrossIcon aria-hidden />}
  </button>
)

/**
 * Several of them, in a row that scrolls rather than wraps.
 *
 * Wrapping would let four attachments push the composer's text off the screen.
 * Scrolling keeps the composer the size it was.
 */
const AttachmentGroup = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="attachment-group"
    className={cn('flex min-w-0 items-stretch gap-1.5 overflow-x-auto', className)}
    {...props}
  />
)

export {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
  AttachmentGroup,
  attachmentVariants,
}
