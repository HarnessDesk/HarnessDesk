import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react'
import { PaneColumn } from './PaneColumn'
import { ComposerDock, ComposerShell } from '../ui/composer'
import { Message } from '../ui/message'
import { Bubble } from '../ui/bubble'
import { Text } from './Settings'
import styles from './ConversationShell.module.css'

/** The shared session window frame, independent of its transcript source. */
export const ConversationShell = forwardRef<HTMLDivElement, ComponentProps<'div'>>(({ className, ...props }, ref) => <div ref={ref} data-slot="conversation-shell" className={`${styles.shell} ${className ?? ''}`} {...props} />)
/** How close to its end a reader still counts as reading the end. */
const END_SLACK = 24

/**
 * A transcript keeps the session's reading gutter and measured dock clearance.
 *
 * The dock floats over the thread, and the thread reserves the dock's measured
 * height as its bottom padding. With `keepEnd` it also follows its end while
 * the reader is there: a notice joining the dock, a late layout or new content
 * moves the end, and without following, the last message is left under the
 * dock. A reader who scrolled up stays where they are. A screen that already
 * follows its own transcript leaves `keepEnd` off.
 */
export const ConversationThread = forwardRef<HTMLDivElement, ComponentProps<'div'> & { readonly keepEnd?: boolean }>(({ className, keepEnd = false, onScroll, ...props }, ref) => {
  const node = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  useImperativeHandle(ref, () => node.current!, [])
  useLayoutEffect(() => {
    const element = node.current
    if (!keepEnd || !element) return
    const follow = (): void => { if (atEnd.current) element.scrollTop = element.scrollHeight }
    const resize = new ResizeObserver(follow)
    const watch = (): void => { resize.disconnect(); resize.observe(element); for (const child of element.children) resize.observe(child) }
    watch()
    const children = new MutationObserver(() => { watch(); follow() })
    children.observe(element, { childList: true })
    follow()
    return () => { resize.disconnect(); children.disconnect() }
  }, [keepEnd])
  return <PaneColumn inset="reading" clearComposer ref={node} data-slot="conversation-thread" className={`${styles.thread} ${className ?? ''}`}
    onScroll={event => { const element = event.currentTarget; atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight <= END_SLACK; onScroll?.(event) }} {...props} />
})
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
