import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The empty state belonging to a conversation pane. It fills the pane by
 * default; `height="content"` keeps a following notice beside its words.
 *
 * `row` is the one other shape this pane needs: a spinner beside its word
 * reads left to right, not stacked, while everything else here — a title
 * over a sentence over a choice — is a column. Same padding either way, so
 * a reader moving between "signed out" and "loading" is in the same box.
 */
const ConversationEmptyState = ({
  className,
  row,
  height = 'pane',
  ...props
}: React.ComponentProps<'div'> & { row?: boolean; height?: 'pane' | 'content' }) => (
  <div
    data-slot="conversation-empty-state"
    data-direction={row ? 'row' : 'column'}
    data-height={height}
    className={cn(
      'flex w-full items-center justify-center p-10 text-center text-(--hd-muted-foreground)',
      height === 'pane' ? 'h-full' : 'h-auto',
      row ? 'flex-row gap-2' : 'flex-col gap-2.5',
      className,
    )}
    {...props}
  />
)

export { ConversationEmptyState }
