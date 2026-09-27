import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The full-height empty state belonging to a conversation pane.
 *
 * `row` is the one other shape this pane needs: a spinner beside its word
 * reads left to right, not stacked, while everything else here — a title
 * over a sentence over a choice — is a column. Same padding either way, so
 * a reader moving between "signed out" and "loading" is in the same box.
 */
const ConversationEmptyState = ({
  className,
  row,
  ...props
}: React.ComponentProps<'div'> & { row?: boolean }) => (
  <div
    data-slot="conversation-empty-state"
    data-direction={row ? 'row' : 'column'}
    className={cn(
      'flex size-full items-center justify-center p-10 text-center text-(--hd-muted-foreground)',
      row ? 'flex-row gap-2' : 'flex-col gap-2.5',
      className,
    )}
    {...props}
  />
)

export { ConversationEmptyState }
