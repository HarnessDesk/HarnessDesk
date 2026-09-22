import type * as React from 'react'

import { cn } from '@/lib/utils'

/** The full-height empty state belonging to a conversation pane. */
const ConversationEmptyState = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="conversation-empty-state"
    className={cn(
      'flex size-full flex-col items-center justify-center gap-2.5 p-10 text-center text-(--hd-muted-foreground)',
      className,
    )}
    {...props}
  />
)

export { ConversationEmptyState }
