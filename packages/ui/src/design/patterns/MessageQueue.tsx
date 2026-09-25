import type { ComponentProps, HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

import { SortableList, SortableRow } from '../ui/sortable-list'

/** The messages held between the transcript and the composer. */
export const MessageQueueFrame = ({
  paused = false,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { paused?: boolean }) => (
  <div
    {...props}
    data-slot="message-queue"
    {...(paused ? { 'data-paused': '' } : {})}
    className={cn(
      'group/queue overflow-hidden rounded-(--hd-radius) bg-(--hd-muted)',
      'shadow-[inset_0_0_0_1px_var(--hd-border-strong)]',
      'data-[paused]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--hd-warning)_45%,transparent)]',
      className,
    )}
  />
)

export const MessageQueueHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    {...props}
    data-slot="message-queue-header"
    className={cn(
      'flex items-center gap-2 py-1.5 pr-2 pl-3',
      'group-data-[paused]/queue:bg-[color-mix(in_srgb,var(--hd-warning)_10%,transparent)]',
      className,
    )}
  />
)

/**
 * The queue is a sortable list (`design/ui/sortable-list`): its order, its
 * handle, its drop line, its keys and its announcement are that part's. What
 * is the queue's own is only its row's inset, its hover ground and the look
 * of a message on its way out.
 */
export const MessageQueueList = ({ className, ...props }: ComponentProps<typeof SortableList>) => (
  <SortableList {...props} className={cn('pb-1', className)} />
)

export const MessageQueueRow = ({
  sending = false,
  className,
  ...props
}: ComponentProps<typeof SortableRow> & { sending?: boolean }) => (
  <SortableRow
    {...props}
    {...(sending ? { 'data-sending': '' } : {})}
    className={cn(
      'flex items-center gap-2 py-1 pr-2 pl-1 text-sm leading-(--hd-line-sm)',
      'hover:bg-(--hd-hover) data-[sending]:text-(--hd-muted-foreground)',
      className,
    )}
  />
)

export const MessageQueueActions = ({ className, ...props }: HTMLAttributes<HTMLSpanElement>) => (
  <span
    {...props}
    data-slot="message-queue-actions"
    className={cn(
      'flex shrink-0 items-center gap-px opacity-0 group-hover/sortable-row:opacity-100 focus-within:opacity-100',
      className,
    )}
  />
)

export const MessageQueueTiming = ({
  tone = 'quiet',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: 'quiet' | 'next' }) => (
  <span
    {...props}
    data-slot="message-queue-timing"
    data-tone={tone}
    className={cn(
      'inline-flex h-4.5 shrink-0 items-center whitespace-nowrap rounded-(--hd-radius-md) px-2',
      'text-xs leading-none text-(--hd-muted-foreground) data-[tone=next]:text-(--hd-primary-ink)',
      className,
    )}
  />
)
