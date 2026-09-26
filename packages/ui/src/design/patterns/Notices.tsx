import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

import { ArrowLeftIcon, BellIcon, BellOffIcon, ChevronIcon, CrossIcon } from '../../components/Icons'
import { ContextMenu, MenuItem, type MenuPoint } from './Menu'
import type { BannerTone } from '../primitives/Banner'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { revealMotion } from '../ui/motion'
import { toast } from '../ui/toast'
import styles from './Notices.module.css'

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

/** The dot every surface leads with: the message's tone, at a glance. */
const ToneDot = ({ tone = 'neutral' }: { tone?: NoticeTone }) => (
  <span className={styles.dot} data-tone={tone} aria-hidden />
)

/** What a message leads with: its sender's face when it has one, else its tone. */
const Lead = ({ message }: { message: NoticeMessage }) =>
  message.mark ? <span className={styles.mark}>{message.mark}</span> : <ToneDot tone={message.tone} />

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

const Pager = ({ at, count, onPrevious, onNext }: { at: number; count: number; onPrevious: () => void; onNext: () => void }) =>
  count > 1 ? (
    <span className={styles.pager}>
      <Button variant="ghost" size="icon-xs" type="button" aria-label="Previous message" disabled={at === 0} onClick={onPrevious}>
        <ArrowLeftIcon size={12} />
      </Button>
      <span className={styles.count}>
        {at + 1} of {count}
      </span>
      <Button variant="ghost" size="icon-xs" type="button" aria-label="Next message" disabled={at === count - 1} onClick={onNext}>
        <ChevronIcon size={12} />
      </Button>
    </span>
  ) : null

const ActionButton = ({ action, variant }: { action: NoticeAct; variant: 'default' | 'link' }) =>
  variant === 'link' ? (
    <button type="button" className={styles.link} onClick={action.onSelect}>
      {action.label}
    </button>
  ) : (
    <Button size="sm" type="button" onClick={action.onSelect}>
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
        {message.mark ? <span className={styles.mark}>{message.mark}</span> : null}
        <Pager at={pager.at} count={messages.length} onPrevious={pager.previous} onNext={pager.next} />
        <span className={styles.fill} />
        <Dismiss onDismiss={() => onDismiss(message.id)} onMute={onMute?.(message.id)} />
      </div>
      <div className={styles.cardTitle} data-slot="notice-title">
        {message.title}
      </div>
      {message.body ? (
        <p className={styles.cardBody} data-slot="notice-description">
          {message.body}
        </p>
      ) : null}
      {message.action ? (
        <div className={styles.cardAction}>
          <ActionButton action={message.action} variant="default" />
        </div>
      ) : null}
    </section>
  )
}

/**
 * A message about the conversation it sits over, fastened to the top of that
 * conversation's composer — the control it is about. Tinted by tone, one
 * line, one action as a link.
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
  <div className={styles.composer} data-slot="composer-notice" data-tone={message.tone ?? 'neutral'} role="status">
    <Lead message={message} />
    <span className={styles.line}>
      <span className={styles.lineTitle}>{message.title}</span>
      {message.body ? <span className={styles.lineBody}> {message.body}</span> : null}
    </span>
    {message.action ? <ActionButton action={message.action} variant="link" /> : null}
    {onDismiss ? <Dismiss onDismiss={onDismiss} onMute={onMute} /> : null}
  </div>
)

/** The composer notices, stacked over the composer they are about. */
export const ComposerNoticeStack = ({ children }: { children: ReactNode }) => (
  <div className={styles.composerStack} data-slot="composer-notices">
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
      <Lead message={message} />
      <span className={styles.line}>
        <span className={styles.lineTitle}>{message.title}</span>
        {message.body ? <span className={styles.lineBody}> {message.body}</span> : null}
      </span>
      {message.action ? <ActionButton action={message.action} variant="link" /> : null}
      <span className={styles.fill} />
      <Pager at={pager.at} count={messages.length} onPrevious={pager.previous} onNext={pager.next} />
      <Dismiss onDismiss={() => onDismiss(message.id)} onMute={onMute?.(message.id)} />
    </div>
  )
}

/**
 * The inbox's trigger: a bell, and how many are unread. Unread has its own
 * tint (`data-unread`), never the readiness dot's colours — that dot says
 * whether a turn can start, and a message waiting is a different fact.
 */
export const InboxButton = ({
  unread,
  className,
  ...props
}: { unread: number } & ButtonHTMLAttributes<HTMLButtonElement>) => (
  <Button
    variant="ghost"
    size="icon-sm"
    type="button"
    aria-label={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
    className={[styles.inboxButton, className].filter(Boolean).join(' ')}
    data-slot="inbox-button"
    {...(unread > 0 ? { 'data-unread': '' } : {})}
    {...props}
  >
    <BellIcon size={14} />
    {unread > 0 ? <span className={styles.unreadCount}>{unread > 99 ? '99+' : unread}</span> : null}
  </Button>
)

/**
 * How many kept messages are unread, beside whatever opens the inbox — the
 * seat's row, say. Its own tint, never the readiness dot's colours.
 */
export const UnreadMark = ({ count }: { count: number }) =>
  count > 0 ? (
    <span className={styles.unreadMark} data-slot="unread-mark" aria-label={`${count} unread`}>
      {count > 99 ? '99+' : count}
    </span>
  ) : null

const ago = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

/**
 * The inbox itself: messages kept until they are cleared, newest first,
 * unread ones marked. What it is drawn inside — a menu's fold, a popover — is
 * the caller's; this is the list and its two verbs.
 */
export const InboxList = ({
  messages,
  onOpen,
  onMarkAllRead,
  onClear,
  now = Date.now(),
}: {
  messages: readonly NoticeMessage[]
  onOpen?: (id: string) => void
  onMarkAllRead?: () => void
  onClear?: () => void
  now?: number
}) => (
  <div className={styles.inbox} data-slot="inbox-list">
    {messages.length === 0 ? (
      <p className={styles.empty}>Nothing kept.</p>
    ) : (
      <>
        <ul className={styles.inboxItems}>
          {messages.map((message) => (
            <li key={message.id} className={cn(styles.inboxItem, revealMotion)} {...(message.read ? {} : { 'data-unread': '' })}>
              <Lead message={message} />
              <div className={styles.inboxText}>
                <span className={styles.inboxTitle}>{message.title}</span>
                {message.body ? <span className={styles.inboxBody}>{message.body}</span> : null}
                {message.action ? <ActionButton action={message.action} variant="link" /> : null}
              </div>
              {message.at !== undefined ? <time className={styles.when}>{ago(message.at, now)}</time> : null}
              {onOpen && !message.read ? (
                <button type="button" className={styles.markRead} aria-label="Mark read" onClick={() => onOpen(message.id)} />
              ) : null}
            </li>
          ))}
        </ul>
        {onMarkAllRead || onClear ? (
          <div className={styles.inboxFoot}>
            {onMarkAllRead ? (
              <button type="button" className={styles.link} onClick={onMarkAllRead}>
                Mark all read
              </button>
            ) : null}
            {onClear ? (
              <button type="button" className={styles.link} onClick={onClear}>
                Clear
              </button>
            ) : null}
          </div>
        ) : null}
      </>
    )}
  </div>
)

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
