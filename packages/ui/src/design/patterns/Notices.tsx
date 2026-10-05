import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import { AlertIcon, ArrowLeftIcon, BellIcon, BellOffIcon, ChevronIcon, CrossIcon, InfoIcon, ShieldAlertIcon, TrashIcon } from '../../components/Icons'
import { ContextMenu, MenuItem, type MenuPoint } from './Menu'
import { Popover } from './Popover'
import type { BannerTone } from '../primitives/Banner'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { revealMotion } from '../ui/motion'
import { toast } from '../ui/toast'
import { Chip, Text } from './Settings'
import styles from './Notices.module.css'

const useWrappedText = (ref: React.RefObject<HTMLElement | null>, dependencies: readonly unknown[]) => {
  const [wrapped, setWrapped] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      const tops: number[] = []
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        if (!node.textContent?.trim()) continue
        const range = document.createRange()
        if (typeof range.getClientRects !== 'function') return
        range.selectNodeContents(node)
        tops.push(...[...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.top))
      }
      tops.sort((a, b) => a - b)
      const lines = tops.filter((top, index) => index === 0 || Math.abs(top - tops[index - 1]!) >= 1).length
      setWrapped(lines > 1)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, dependencies)
  return wrapped
}

/**
 * The surfaces a message can be sent to, one component each.
 *
 * A message is the same object wherever it lands — a tone, a title, a line of
 * body, at most one action — and whoever raises it picks where it goes by
 * what it is about, not by what is loudest:
 *
 *   card      the foot of the sidebar: something to do when convenient (an
 *             update to relaunch into, an offer). One at a time, paged.
 *   composer  above the composer of the conversation it blocks: a spent plan,
 *             an agent that is not signed in. Never over any other pane.
 *   strip     one slim line above the pane, one message at a time, paged: for
 *             a desk that would rather keep everything in one place.
 *   inbox     kept: a message worth reading later, behind the bell in the
 *             seat menu, unread until opened.
 *   toast     the result of what was just done. It leaves on its own.
 *
 * A failure of the thing a person just pressed is none of these: it is said
 * in place, beside the control (`ActionError`), in plain words.
 */
export type NoticeSurface = 'card' | 'composer' | 'strip' | 'inbox' | 'toast'

export type NoticeTone = BannerTone

export type NoticeAct = {
  readonly label: string
  readonly onSelect: () => void
  /** A key chord that does the same thing, shown beside the label. */
  readonly shortcut?: string
}

export type NoticeMessage = {
  readonly id: string
  readonly tone?: NoticeTone
  readonly title: ReactNode
  readonly body?: ReactNode
  readonly action?: NoticeAct
  /** When it was raised, for the inbox's time column. */
  readonly at?: number
  /** Only the inbox keeps read state. */
  readonly read?: boolean
  /**
   * Who is speaking, when it is not the desk itself: an Agent's face in place
   * of the tone dot, so a message an Agent sent reads as that Agent's.
   */
  readonly mark?: ReactNode
}

const TONE_ICON: Record<NoticeTone, (props: { size: number }) => ReactNode> = {
  neutral: BellIcon,
  info: InfoIcon,
  warning: AlertIcon,
  danger: ShieldAlertIcon,
}

/**
 * What every surface leads with: a small tile. The tone lives here — a tinted
 * square around its icon — so the ground under the words can stay calm; an
 * Agent's message puts that Agent's face in the tile instead.
 */
const Lead = ({ message, size = 'md', line }: { message: NoticeMessage; size?: 'sm' | 'md'; line?: 'sm' | 'md' }) => {
  const tone = message.tone ?? 'neutral'
  const Glyph = TONE_ICON[tone]
  const lineSize = line ?? size
  return (
    <span data-slot="notice-lead" className={cn('flex shrink-0 items-center overflow-visible', lineSize === 'sm' ? 'h-(--hd-line-sm)' : 'h-(--hd-line)')}>
      <span
        className={styles.tile}
        data-tone={tone}
        data-size={size}
        // An Agent's message leads with that Agent's face, and a face takes the
        // person's chosen shape; a tone's icon stays the tile it was.
        {...(message.mark ? { 'data-shape': 'face' } : {})}
        aria-hidden
      >
        {message.mark ?? <Glyph size={size === 'sm' ? 12 : 14} />}
      </span>
    </span>
  )
}

/**
 * Putting a message away — and, once a kind has been put away twice
 * (`onMute`), the way to stop it for good, the same escalation a banner has:
 * the × opens Dismiss / Stop showing this rather than closing outright.
 */
const Dismiss = ({ onDismiss, onMute }: { onDismiss: () => void; onMute?: (() => void) | undefined }) => {
  const [menuAt, setMenuAt] = useState<MenuPoint | null>(null)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        edge="end"
        edgeGlyph={12}
        type="button"
        className={styles.dismiss}
        aria-label="Dismiss"
        {...(onMute ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': menuAt !== null } : {})}
        onClick={(event) => {
          if (!onMute) {
            onDismiss()
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          setMenuAt({ x: rect.left, y: rect.bottom + 4 })
        }}
      >
        <CrossIcon size={12} />
      </Button>
      {onMute ? (
        <ContextMenu at={menuAt} label="Message options" onClose={() => setMenuAt(null)}>
          <MenuItem icon={<CrossIcon size={14} />} label="Dismiss" onSelect={onDismiss} />
          <MenuItem icon={<BellOffIcon size={14} />} label="Stop showing this" hint="Turn it back on in Settings › Notifications" onSelect={onMute} />
        </ContextMenu>
      ) : null}
    </>
  )
}

/** Which of several messages is showing, kept in range as the list changes. */
const usePager = (count: number) => {
  const [index, setIndex] = useState(0)
  const at = count === 0 ? 0 : Math.min(index, count - 1)
  return {
    at,
    previous: () => setIndex(Math.max(0, at - 1)),
    next: () => setIndex(Math.min(count - 1, at + 1)),
  }
}

const Pager = ({ at, count, onPrevious, onNext }: { at: number; count: number; onPrevious: () => void; onNext: () => void }) => {
  const previousRef = useRef<HTMLButtonElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const [active, setActive] = useState<'previous' | 'next'>(() => (at === 0 ? 'next' : 'previous'))
  if (count <= 1) return null

  const previousDisabled = at === 0
  const nextDisabled = at === count - 1
  const stop = active === 'previous' && !previousDisabled ? 'previous' : active === 'next' && !nextDisabled ? 'next' : previousDisabled ? 'next' : 'previous'
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const enabled = (['previous', 'next'] as const).filter((name) => name === 'previous' ? !previousDisabled : !nextDisabled)
    const current = event.currentTarget === previousRef.current ? 'previous' : 'next'
    const index = Math.max(0, enabled.indexOf(current))
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? enabled.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length
    const target = enabled[nextIndex]!
    setActive(target)
    ;(target === 'previous' ? previousRef : nextRef).current?.focus()
  }

  return (
    <span className={styles.pager} data-slot="notice-pager" role="toolbar" aria-label="Message pages">
      <Button ref={previousRef} variant="ghost" size="icon-xs" type="button" aria-label="Previous message" disabled={previousDisabled} tabIndex={stop === 'previous' ? 0 : -1} onFocus={() => setActive('previous')} onKeyDown={onKeyDown} onClick={onPrevious}>
        <ArrowLeftIcon size={12} />
      </Button>
      <span className={styles.count}>
        {at + 1} of {count}
      </span>
      <Button ref={nextRef} variant="ghost" size="icon-xs" edge="end" edgeGlyph={12} type="button" aria-label="Next message" disabled={nextDisabled} tabIndex={stop === 'next' ? 0 : -1} onFocus={() => setActive('next')} onKeyDown={onKeyDown} onClick={onNext}>
        <ChevronIcon size={12} />
      </Button>
    </span>
  )
}

const ActionButton = ({ action, variant, className }: { action: NoticeAct; variant: 'default' | 'outline'; className?: string }) => (
  <Button size="sm" variant={variant} type="button" className={className} onClick={action.onSelect}>
    {action.label}
    {action.shortcut ? <kbd className={styles.chord}>{action.shortcut}</kbd> : null}
  </Button>
)

/**
 * The card at the foot of the sidebar. It holds every waiting message but
 * shows one, so the column never grows a stack; the pager says how many.
 */
export const NoticeCard = ({
  messages,
  onDismiss,
  onMute,
}: {
  messages: readonly NoticeMessage[]
  onDismiss: (id: string) => void
  /** Offered for a message whose kind has been put away often enough to be silenced. */
  onMute?: (id: string) => (() => void) | undefined
}) => {
  const pager = usePager(messages.length)
  const message = messages[pager.at]
  if (!message) return null
  return (
    <section className={styles.card} data-slot="notice-card" data-tone={message.tone ?? 'neutral'} role="status" aria-label="Messages">
      <div className={styles.cardHead}>
        <Lead message={message} />
        <span className={styles.fill} />
        <Pager at={pager.at} count={messages.length} onPrevious={pager.previous} onNext={pager.next} />
        <Dismiss onDismiss={() => onDismiss(message.id)} onMute={onMute?.(message.id)} />
      </div>
      <Text as="div" role="subject" data-part="notice-title">
        {message.title}
      </Text>
      {message.body ? (
        <p className={styles.cardBody} data-slot="notice-description">
          {message.body}
        </p>
      ) : null}
      {message.action ? <ActionButton action={message.action} variant="default" className={styles.cardAction} /> : null}
    </section>
  )
}

/**
 * A message about the conversation it sits over, fastened to the top of that
 * conversation's composer — the control it is about. A calm bar the
 * composer's own width: the tone is in the tile, the words wrap, and the
 * action sits at the right as a small button.
 */
export const ComposerNotice = ({
  message,
  onDismiss,
  onMute,
}: {
  message: NoticeMessage
  onDismiss?: () => void
  onMute?: (() => void) | undefined
}) => (
  <ComposerNoticeRow message={message} onDismiss={onDismiss} onMute={onMute} />
)

const ComposerNoticeRow = ({ message, onDismiss, onMute }: { message: NoticeMessage; onDismiss?: () => void; onMute?: (() => void) | undefined }) => {
  const lineRef = useRef<HTMLSpanElement>(null)
  const wrapped = useWrappedText(lineRef, [message.title, message.body])
  return (
    <div className={styles.composer} data-slot="composer-notice" data-tone={message.tone ?? 'neutral'} {...(wrapped ? { 'data-wrapped': '' } : {})} role="status">
      <Lead message={message} />
      <span className={styles.line} data-slot="notice-message-line">
        <span ref={lineRef} className={styles.lineText}>
          <span className={styles.lineTitle} data-part="notice-title">{message.title}</span>
          {message.body ? <span className={styles.lineBody} data-part="notice-detail"> {message.body}</span> : null}
        </span>
      </span>
      {message.action ? <ActionButton action={message.action} variant="outline" /> : null}
      {onDismiss ? <Dismiss onDismiss={onDismiss} onMute={onMute} /> : null}
    </div>
  )
}

/** The composer notices, stacked over the composer they are about. */
export const ComposerNoticeStack = ({ children }: { children: ReactNode }) => (
  <div className={styles.composerStack} data-slot="composer-notices">
    {children}
  </div>
)

/**
 * The short status lines over a composer — who is working, what sending does
 * besides send — as one tinted strip rather than loose sentences on the
 * page's own ground. It styles its direct children, so any line can ride in
 * it, and two or more join: no gap, only the outer corners round.
 */
export const ComposerTail = ({ children }: { children: ReactNode }) => (
  <div className={styles.tail} data-slot="composer-tail">
    {children}
  </div>
)

/** One slim line above a pane, one message at a time. */
export const NoticeStrip = ({
  messages,
  onDismiss,
  onMute,
}: {
  messages: readonly NoticeMessage[]
  onDismiss: (id: string) => void
  onMute?: (id: string) => (() => void) | undefined
}) => {
  const pager = usePager(messages.length)
  const message = messages[pager.at]
  if (!message) return null
  return (
    <div className={styles.strip} data-slot="notice-strip" data-tone={message.tone ?? 'neutral'} role="status">
      <Lead message={message} size="sm" />
      <span className={styles.line} data-slot="notice-message-line">
        <span className={styles.lineText}>
          <span className={styles.lineTitle} data-part="notice-title">{message.title}</span>
          {message.body ? <span className={styles.lineBody} data-part="notice-detail"> {message.body}</span> : null}
        </span>
      </span>
      {message.action ? (
        <Button variant="link" size="inline" type="button" className={cn(styles.link, 'h-auto p-0')} onClick={message.action.onSelect}>
          {message.action.label}
        </Button>
      ) : null}
      <span className={styles.fill} />
      <Pager at={pager.at} count={messages.length} onPrevious={pager.previous} onNext={pager.next} />
      <Dismiss onDismiss={() => onDismiss(message.id)} onMute={onMute?.(message.id)} />
    </div>
  )
}

/** A kept message, with who sent it when an Agent did. */
export type InboxMessage = NoticeMessage & {
  /** The sender's name, under the title: an Agent's, or nothing for the desk's own. */
  readonly from?: string
  readonly count?: number
  readonly file?: string
  readonly settings?: readonly string[]
  readonly actions?: readonly NoticeAct[]
  /** Where the message is about, when it has a place: its conversation. Pressing the row goes there. */
  readonly go?: () => void
  readonly goLabel?: string
}

/**
 * The inbox: messages kept until they are cleared, newest first, under
 * day headings. A compact title row expands into details and actions,
 * marking unread content read. Repeated information updates its count and
 * last time; actions name their destination.
 */
export const InboxList = ({
  messages,
  onOpen,
  onMarkAllRead,
  onClear,
  now = Date.now(),
}: {
  messages: readonly InboxMessage[]
  onOpen?: (id: string) => void
  onMarkAllRead?: () => void
  onClear?: () => void
  now?: number
}) => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const unread = messages.filter((message) => !message.read).length
  const shown = messages
  const today = new Date(now).toDateString()
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  const groups: { name: string; items: InboxMessage[] }[] = []
  for (const message of shown) {
    const day = new Date(message.at ?? now)
    const name = day.toDateString() === today ? 'Today' : day.toDateString() === yesterday.toDateString() ? 'Yesterday' : day.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    const group = groups.find(group => group.name === name)
    if (group) group.items.push(message)
    else groups.push({ name, items: [message] })
  }
  const row = (message: InboxMessage) => {
    const open = expanded.has(message.id)
    return (
      <li key={message.id} className={cn(styles.inboxItem, revealMotion)} {...(message.read ? {} : { 'data-unread': '' })}>
        <Lead message={message} size="md" line="sm" />
        <div className={styles.inboxText}>
          <span className={styles.inboxTop}>
              <Button
                variant="ghost"
                size="pattern"
                type="button"
                className={styles.inboxTitle}
                title={!message.read ? 'Mark read' : open ? 'Collapse message' : 'Expand message'}
                aria-expanded={open}
                onClick={() => {
                  if (!message.read) onOpen?.(message.id)
                  setExpanded(current => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next })
                }}
              >
                {message.read ? message.title : <Text role="row">{message.title}</Text>}
              </Button>
            {message.count && message.count > 1 ? <Chip tone="neutral">×{message.count}</Chip> : null}
            {message.at !== undefined ? <time className={styles.inboxTime}>{new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> : null}
          </span>
          {open ? (
            <div className={styles.inboxBody}>
              <div data-part="inbox-full-title">{message.title}</div>
              {message.from ? <span className={styles.inboxFrom}>{message.from}</span> : null}
              {message.from && message.body ? ' · ' : null}
              {message.settings?.length ? <ul className={styles.inboxSettings}>{message.settings.map(setting => <li key={setting}><code>{setting.split('.').map((part, index) => <span key={index}>{index > 0 ? <>.<wbr /></> : null}{part}</span>)}</code></li>)}</ul> : null}
              {message.file ? <p className={styles.inboxDetail}>In <code>{message.file}</code></p> : null}
              {message.body ? <div>{message.body}</div> : null}
            </div>
          ) : null}
          {open ? <div className={styles.inboxActions}>
            {message.go ? <Button variant="outline" size="sm" onClick={message.go}>{message.goLabel ?? 'Open the conversation'}</Button> : null}
            {[...(message.action ? [message.action] : []), ...(message.actions ?? [])].map(action => <ActionButton key={action.label} action={action} variant="outline" />)}
          </div> : null}
        </div>
        {/* `role="img"` because a plain `span` carries no accessible name of
            its own — an `aria-label` on one with no role is dropped by
            assistive tech, which is what silently swallowed this dot. */}
        {message.read ? null : <span className={styles.unreadDot} role="img" aria-label="Unread" />}
      </li>
    )
  }
  return (
    <div className={styles.inbox} data-slot="inbox-list" data-surface>
      <div className={styles.inboxHead}>
        <Text role="subject" data-part="inbox-heading">Inbox</Text>
        {unread > 0 ? <Text role="meta">· {unread} new</Text> : null}
        <span className={styles.fill} />
        {onMarkAllRead && unread > 0 ? (
          <Button variant="link" size="inline" type="button" aria-label="Mark all read" title="Mark all read" onClick={onMarkAllRead}>
            Mark all read
          </Button>
        ) : null}
        {onClear && messages.length > 0 ? (
          <Button variant="ghost" size="icon-sm" edge="end" edgeGlyph={14} type="button" aria-label="Clear the inbox" title="Clear the inbox" onClick={onClear}>
            <TrashIcon size={14} />
          </Button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyTile} aria-hidden>
            <BellIcon size={16} />
          </span>
          <span className={styles.emptyTitle}>{messages.length === 0 ? 'Nothing kept yet' : 'All read'}</span>
          <span className={styles.emptyBody}>Messages an Agent sends you, and anything you move here, wait in this list.</span>
        </div>
      ) : (
        <div className={styles.inboxScroll}>
          {groups.map((group) => (
            <section key={group.name} aria-label={group.name}>
              <h3 className={styles.inboxGroup}>{group.name}</h3>
              <ul className={styles.inboxItems}>{group.items.map(row)}</ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The bell and the inbox behind it. The bell carries the unread count in its
 * own tint; the inbox opens beside it as a panel of its own, wide enough for
 * a card to read in two lines, rather than folding into a menu.
 */
export const InboxPanel = ({
  side = 'right',
  size = 'icon-sm',
  ...list
}: Parameters<typeof InboxList>[0] & { side?: 'top' | 'right' | 'bottom' | 'left'; size?: 'icon-sm' | 'icon-xs' }) => {
  const unread = list.messages.filter((message) => !message.read).length
  return (
    <Popover
      title={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
      side={side}
      sideAlign="end"
      triggerVariant={{ variant: 'ghost', size }}
      label={
        <span className={styles.bell} data-slot="inbox-button" data-size={size} {...(unread > 0 ? { 'data-unread': '' } : {})}>
          <span className="sr-only">{unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}</span><BellIcon size={14} />
          {unread > 0 ? <span className={styles.bellCount} data-slot="inbox-dot" aria-hidden /> : null}
        </span>
      }
    >
      {() => <InboxList {...list} />}
    </Popover>
  )
}

/**
 * A result, said as a toast: the same message shape, through the registry's
 * Sonner so every toast in the app looks the same.
 */
export const showToast = (
  message: Omit<NoticeMessage, 'id'> & { id?: string },
  how: { readonly persist?: boolean } = {},
): void => {
  const options = {
    ...(message.id ? { id: message.id } : {}),
    // A failure stays until it is closed: a toast that left before it was
    // read is a failure nobody saw.
    ...(how.persist ? { duration: Number.POSITIVE_INFINITY, closeButton: true } : {}),
    ...(message.body ? { description: message.body } : {}),
    ...(message.action ? { action: { label: message.action.label, onClick: message.action.onSelect } } : {}),
  }
  if (message.tone === 'danger') toast.error(message.title, options)
  else if (message.tone === 'warning') toast.warning(message.title, options)
  else toast(message.title, options)
}

/**
 * A result that takes a moment: one toast that says it is under way and then
 * turns into how it ended, rather than a spinner somewhere and a second toast
 * later. The promise's own value can name the ending.
 */
export const showProgress = <T,>(
  work: Promise<T>,
  words: { readonly working: string; readonly done: string | ((value: T) => string); readonly failed: string | ((error: unknown) => string) },
): void => {
  toast.promise(work, { loading: words.working, success: words.done, error: words.failed })
}
