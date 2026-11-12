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
/**
 * Whether each thread follows its end, and the scrollTop it last put itself at. A scroll event arrives with the next
 * frame, which a window in the background can wait a long time for; by then a reply may have grown the thread, so a
 * scroll the thread made itself would read as the reader leaving the end. Only a scroll that is not the one the thread
 * made, and does not reach the end, lets go of it.
 */
const ends = new WeakMap<Element, { readonly atEnd: boolean; readonly written: number | null }>()
/** Moves a thread to its end and keeps it following there, as when the person sends a message. */
export const scrollThreadToEnd = (element: HTMLElement): void => {
  element.scrollTop = element.scrollHeight
  ends.set(element, { atEnd: true, written: element.scrollTop })
}
/** Whether a thread is following its end: true until the reader scrolls away from it. */
export const threadFollowsEnd = (element: HTMLElement): boolean => ends.get(element)?.atEnd ?? true
const readScroll = (element: HTMLElement): void => {
  const last = ends.get(element), top = element.scrollTop
  const own = last?.written !== null && last?.written !== undefined && Math.abs(top - last.written) < 1
  const atEnd = element.scrollHeight - top - element.clientHeight <= END_SLACK || own && last.atEnd
  ends.set(element, { atEnd, written: own ? last.written : null })
}

export const ConversationThread = forwardRef<HTMLDivElement, ComponentProps<'div'> & { readonly keepEnd?: boolean }>(({ className, keepEnd = false, onScroll, ...props }, ref) => {
  const node = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => node.current!, [])
  useLayoutEffect(() => {
    const element = node.current
    if (!keepEnd || !element) return
    const follow = (): void => { if (threadFollowsEnd(element)) scrollThreadToEnd(element) }
    const resize = new ResizeObserver(follow)
    const watch = (): void => { resize.disconnect(); resize.observe(element); for (const child of element.children) resize.observe(child) }
    watch()
    const children = new MutationObserver(() => { watch(); follow() })
    children.observe(element, { childList: true })
    follow()
    return () => { resize.disconnect(); children.disconnect() }
  }, [keepEnd])
  return <PaneColumn inset="reading" clearComposer ref={node} data-slot="conversation-thread" className={`${styles.thread} ${className ?? ''}`}
    onScroll={event => { readScroll(event.currentTarget); onScroll?.(event) }} {...props} />
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
