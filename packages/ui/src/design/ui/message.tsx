import type * as React from 'react'

import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/*
 * Vendored from shadcn/ui — a chat message part: the row a person's or an
 * agent's turn stands in, and the two spots every screen that shows one
 * needs around its words — a header naming who spoke, and a footer for the
 * time and its icon-only actions.
 *
 * This file draws the row alone. What the words stand on is `Bubble`, beside
 * it: composition over one more prop, the same split the registry itself
 * draws, and the reason a second screen (the room's own channel line) can
 * take the row without inheriting a shape that was only ever the transcript's.
 *
 * `align` is the one axis: `start` is the far side of the conversation — an
 * assistant, an agent, another sender in a room — `end` is the current
 * person's own words. Both read left to right; only the row's own edge moves.
 */

const messageVariants = cva('flex w-full min-w-0 flex-col gap-(--hd-space-1-5)', {
  variants: {
    align: {
      start: 'items-start',
      end: 'items-end',
    },
  },
  defaultVariants: { align: 'start' },
})

type MessageProps = React.ComponentProps<'div'> & VariantProps<typeof messageVariants>

const Message = ({ className, align, ...props }: MessageProps) => (
  <div
    data-slot="message"
    data-align={align ?? 'start'}
    className={cn(messageVariants({ align }), className)}
    {...props}
  />
)

/** The column beside a message's face — everything but the avatar. */
const MessageContent = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="message-content" className={cn('flex min-w-0 max-w-full flex-col gap-(--hd-space-1)', className)} {...props} />
)

/** The name above a message — who spoke, and who it reached. */
const MessageHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="message-header" className={cn('flex min-w-0 items-baseline gap-1.5', className)} {...props} />
)

/**
 * Under a message: its time, and icon-only actions (copy, retry, a
 * thumbs verdict). One meta line, so the actions and the clock a screen adds
 * to it read the same size and ink whether or not it wraps them in `Text`
 * itself — the room's own aside, and the transcript's bare time span, both
 * lean on that inheritance.
 *
 * `start` spans the message's own row, for a full-width answer whose actions
 * sit apart from its time; `end` sizes to its content, under a bubble that
 * does the same.
 */
const messageFooterVariants = cva(
  'flex items-center gap-(--hd-space-1) text-xs leading-(--hd-line-xs) font-normal text-(--hd-muted-foreground) tabular-nums',
  {
    variants: {
      align: {
        start: 'w-full',
        end: '',
      },
    },
    defaultVariants: { align: 'start' },
  },
)

type MessageFooterProps = React.ComponentProps<'div'> & VariantProps<typeof messageFooterVariants>

const MessageFooter = ({ className, align, ...props }: MessageFooterProps) => (
  <div data-slot="message-footer" className={cn(messageFooterVariants({ align }), className)} {...props} />
)

export { Message, MessageContent, MessageHeader, MessageFooter, messageVariants, messageFooterVariants }
export type { MessageProps, MessageFooterProps }
