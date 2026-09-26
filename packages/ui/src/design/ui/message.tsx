import type * as React from 'react'

import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/*
 * Vendored from shadcn/ui — a chat message part: the row a person's or an
 * agent's turn stands in, its content column, and a footer for the time and
 * its icon-only actions.
 *
 * This file draws the row alone. What the words stand on is `Bubble`, beside
 * it: composition over one more prop, the same split the registry itself
 * draws, and the reason a second screen (the room's own channel line) can
 * take the row without inheriting a shape that was only ever the transcript's.
 *
 * `align` is the one axis: `start` is the far side of the conversation — an
 * assistant, an agent, another sender in a room — `end` is the current
 * person's own words. Both read left to right; only the row's own edge moves.
 *
 * `rhythm` is the other: `transcript` gives the row the vertical air the
 * conversation's own transcript reads at — 12px above a sent message and 4px
 * below it, 6px each way for an answer — as an explicit option rather than
 * silently by `align`, because the room's `ChannelMessage` stands on
 * `align="start"` too and must keep its own look. Absent, a row carries none
 * of its own; a caller outside the transcript spaces itself.
 *
 * The registry's `MessageHeader` (a name above the bubble) is not here. Only
 * one screen would ever call it — the transcript has no header, alignment
 * alone says who spoke — and a part with one caller, kept only to round out
 * the set, is the same audit finding a header switched off to dodge would
 * have been. Add it back the day a second screen genuinely needs one.
 */

const messageVariants = cva('flex w-full min-w-0 flex-col gap-(--hd-space-1-5)', {
  variants: {
    align: {
      start: 'items-start',
      end: 'items-end',
    },
    rhythm: {
      transcript: '',
    },
  },
  compoundVariants: [
    { align: 'end', rhythm: 'transcript', class: 'py-(--hd-space-3) pb-(--hd-space-1)' },
    { align: 'start', rhythm: 'transcript', class: 'py-(--hd-space-1-5)' },
  ],
  defaultVariants: { align: 'start' },
})

type MessageProps = React.ComponentProps<'div'> & VariantProps<typeof messageVariants>

const Message = ({ className, align, rhythm, ...props }: MessageProps) => (
  <div
    data-slot="message"
    data-align={align ?? 'start'}
    className={cn(messageVariants({ align, rhythm }), className)}
    {...props}
  />
)

/**
 * The column beside a message's face — everything but the avatar.
 *
 * `w-full` unconditionally, not left to whichever `align-items` its parent
 * `Message` happens to carry: a bubble inside it caps itself with a
 * percentage (`max-w-[66.6667%]`), and a percentage means nothing against a
 * box that is still sizing itself to its own content — a bubble short enough
 * to fit its row on one line wrapped early against that undefined width. A
 * fixed full width gives the percentage the same row every time, whichever
 * way the message aligns.
 */
const MessageContent = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div data-slot="message-content" className={cn('flex w-full min-w-0 max-w-full flex-col gap-(--hd-space-1)', className)} {...props} />
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

export { Message, MessageContent, MessageFooter, messageVariants, messageFooterVariants }
export type { MessageProps, MessageFooterProps }
