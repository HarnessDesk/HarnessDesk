import { forwardRef, type ComponentProps, type ReactNode } from 'react'
import { PaneColumn } from './PaneColumn'
import { ComposerDock, ComposerShell } from '../ui/composer'
import { Message } from '../ui/message'
import { Bubble } from '../ui/bubble'
import { Text } from './Settings'
import styles from './ConversationShell.module.css'

/** The shared session window frame, independent of its transcript source. */
export const ConversationShell = forwardRef<HTMLDivElement, ComponentProps<'div'>>(({ className, ...props }, ref) => <div ref={ref} data-slot="conversation-shell" className={`${styles.shell} ${className ?? ''}`} {...props} />)
/** A transcript keeps the session's reading gutter and measured dock clearance. */
export const ConversationThread = forwardRef<HTMLDivElement, ComponentProps<'div'>>(({ className, ...props }, ref) => <PaneColumn inset="reading" clearComposer ref={ref} data-slot="conversation-thread" className={`${styles.thread} ${className ?? ''}`} {...props} />)
/** The same floating composer and approval dock in every conversation. */
export const ConversationDock = forwardRef<HTMLDivElement, ComponentProps<'div'>>(({ className, ...props }, ref) => <ComposerDock floating ref={ref} data-slot="conversation-dock" className={`${styles.dock} ${className ?? ''}`} {...props} />)
/** Assistant prose has one rendering frame, shared with Items. */
export const TranscriptAssistantMessage = ({ children, muted = false }: { readonly children: ReactNode; readonly muted?: boolean }) => <Message align="start" rhythm="transcript"><Bubble variant="ghost"><Text as="div" role="prose" {...(muted ? { ink: 'secondary' as const } : {})}>{children}</Text></Bubble></Message>

/** One composer frame; notices and attachments keep their existing DOM positions. */
export const ConversationComposerFrame = ({ children, before, after, form, shell }: {
  readonly children: ReactNode; readonly before?: ReactNode; readonly after?: ReactNode
  readonly form?: ComponentProps<'form'>; readonly shell?: ComponentProps<typeof ComposerShell>
}) => {
  const content = <ComposerShell reading {...shell}>{children}</ComposerShell>
  return <ComposerDock>{before}{form ? <form {...form}>{content}</form> : content}{after}</ComposerDock>
}
