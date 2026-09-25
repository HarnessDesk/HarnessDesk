import type { ComponentProps, HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

import { Toolbar } from '../ui/section'
import { SortableAnnouncer, SortableRow } from '../ui/sortable-list'

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

/** The queue's head: a toolbar — what is waiting, then what can be done about it. */
export const MessageQueueHeader = ({ className, ...props }: ComponentProps<typeof Toolbar>) => (
  <Toolbar
    {...props}
    data-slot="message-queue-header"
    className={cn(
      'flex-nowrap py-1.5 pr-2 pl-3',
      'group-data-[paused]/queue:bg-[color-mix(in_srgb,var(--hd-warning)_10%,transparent)]',
      className,
    )}
  />
)

/**
 * The queue is a sortable list (`design/ui/sortable-list`): its order, its
 * handle, its drop line, its keys and its announcement are that part's. What
 * is the queue's own is only its rows' inset and hover ground. The sentence a
 * move is announced in sits beside the list, since an `ol` holds only rows.
 */
export const MessageQueueList = ({
  announcement,
  className,
  ...props
}: ComponentProps<'ol'> & { announcement: string }) => (
  <>
    <ol {...props} data-slot="message-queue-list" className={cn('m-0 list-none p-0 pb-1', className)} />
    <SortableAnnouncer message={announcement} />
  </>
)

export const MessageQueueRow = ({
  sending = false,
  className,
  ...props
}: ComponentProps<typeof SortableRow> & { sending?: boolean }) => (
  <SortableRow
    {...props}
    {...(sending ? { 'data-sending': '' } : {})}
    className={cn('flex items-center gap-2 py-1 pr-2 pl-1 hover:bg-(--hd-hover)', className)}
  />
)

/** A row's own actions, drawn while the row is under the pointer or holds the focus. */
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
