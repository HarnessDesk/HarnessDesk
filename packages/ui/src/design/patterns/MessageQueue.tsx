import type { HTMLAttributes, LiHTMLAttributes, OlHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

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

export const MessageQueueList = ({ className, ...props }: OlHTMLAttributes<HTMLOListElement>) => (
  <ol
    {...props}
    data-slot="message-queue-list"
    className={cn('m-0 list-none pt-0 pr-0 pb-1 pl-0', className)}
  />
)

export const MessageQueueRow = ({
  sending = false,
  dragging = false,
  drop = false,
  className,
  ...props
}: LiHTMLAttributes<HTMLLIElement> & {
  sending?: boolean
  dragging?: boolean
  drop?: boolean
}) => (
  <li
    {...props}
    data-slot="message-queue-row"
    {...(sending ? { 'data-sending': '' } : {})}
    {...(dragging ? { 'data-dragging': '' } : {})}
    {...(drop ? { 'data-drop': '' } : {})}
    className={cn(
      'group/queue-row relative flex items-center gap-2 py-1 pr-2 pl-1 text-sm leading-(--hd-line-sm)',
      'hover:bg-(--hd-hover) data-[sending]:text-(--hd-muted-foreground) data-[dragging]:opacity-40',
      "data-[drop]:before:absolute data-[drop]:before:top-[-1px] data-[drop]:before:right-2 data-[drop]:before:left-1 data-[drop]:before:h-0.5 data-[drop]:before:rounded-(--hd-radius-2xs) data-[drop]:before:bg-(--hd-primary) data-[drop]:before:content-['']",
      className,
    )}
  />
)

export const MessageQueueGrip = ({ className, ...props }: HTMLAttributes<HTMLSpanElement>) => (
  <span
    {...props}
    data-slot="message-queue-grip"
    className={cn(
      'inline-grid w-3.5 shrink-0 cursor-grab place-items-center text-(--hd-muted-foreground) opacity-0',
      'group-hover/queue-row:opacity-100 active:cursor-grabbing',
      className,
    )}
  />
)

export const MessageQueueActions = ({ className, ...props }: HTMLAttributes<HTMLSpanElement>) => (
  <span
    {...props}
    data-slot="message-queue-actions"
    className={cn(
      'flex shrink-0 items-center gap-px opacity-0 group-hover/queue-row:opacity-100 focus-within:opacity-100',
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
