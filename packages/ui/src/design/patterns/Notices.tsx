import { useState, type ReactNode } from 'react'

import { AlertIcon, ArrowLeftIcon, BellIcon, BellOffIcon, CheckAllIcon, ChevronIcon, CrossIcon, InfoIcon, ShieldAlertIcon, TrashIcon } from '../../components/Icons'
import { ContextMenu, MenuItem, type MenuPoint } from './Menu'
import { Popover } from './Popover'
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
const Lead = ({ message, size = 'md' }: { message: NoticeMessage; size?: 'sm' | 'md' }) => {
  const tone = message.tone ?? 'neutral'
  const Glyph = TONE_ICON[tone]
  return (
    <span className={styles.tile} data-tone={tone} data-size={size} aria-hidden>
      {message.mark ?? <Glyph size={size === 'sm' ? 12 : 14} />}
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
      <div className={styles.cardTitle} data-slot="notice-title">
        {message.title}
      </div>
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
  <div className={styles.composer} data-slot="composer-notice" data-tone={message.tone ?? 'neutral'} role="status">
    <Lead message={message} />
    <span className={styles.line}>
      <span className={styles.lineTitle}>{message.title}</span>
      {message.body ? <span className={styles.lineBody}> {message.body}</span> : null}
    </span>
    {message.action ? <ActionButton action={message.action} variant="outline" /> : null}
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
      <Lead message={message} size="sm" />
      <span className={styles.line}>
        <span className={styles.lineTitle}>{message.title}</span>
        {message.body ? <span className={styles.lineBody}> {message.body}</span> : null}
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

const ago = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

/** A kept message, with who sent it when an Agent did. */
export type InboxMessage = NoticeMessage & {
  /** The sender's name, under the title: an Agent's, or nothing for the desk's own. */
  readonly from?: string
  /** Where the message is about, when it has a place: its conversation. Pressing the row goes there. */
  readonly go?: () => void
}

const DAY = 24 * 3_600_000

/**
 * The inbox: messages kept until they are cleared, newest first, under
 * "Today" and "Earlier". Each is a flat row — the sender's tile, the title
 * with its time at the right, who and why under it, at most one thing to do.
 * The whole row is one press: it marks the message read and, when the
 * message has a place (`go`), goes there. Unread rows carry a dot and the
 * heavier title; "Unread" narrows the list to them. New rows rise in.
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
  const [only, setOnly] = useState<'all' | 'unread'>('all')
  const unread = messages.filter((message) => !message.read).length
  const shown = only === 'unread' ? messages.filter((message) => !message.read) : messages
  const groups = [
    { name: 'Today', items: shown.filter((message) => message.at === undefined || now - message.at < DAY) },
    { name: 'Earlier', items: shown.filter((message) => message.at !== undefined && now - message.at >= DAY) },
  ].filter((group) => group.items.length > 0)
  const row = (message: InboxMessage) => {
    const press = message.go ?? (onOpen && !message.read ? () => onOpen(message.id) : undefined)
    return (
      <li key={message.id} className={cn(styles.inboxItem, revealMotion)} {...(message.read ? {} : { 'data-unread': '' })}>
        <Lead message={message} />
        <div className={styles.inboxText}>
          <span className={styles.inboxTop}>
            {press ? (
              <Button
                variant="link"
                size="inline"
                type="button"
                className={cn(styles.inboxTitle, 'h-auto items-baseline p-0 font-[inherit] leading-[inherit] whitespace-normal')}
                title={message.go ? 'Go to the conversation' : 'Mark read'}
                onClick={() => {
                  if (!message.read) onOpen?.(message.id)
                  message.go?.()
                }}
              >
                {message.title}
              </Button>
            ) : (
              <span className={styles.inboxTitle}>{message.title}</span>
            )}
            {message.at !== undefined ? <time className={styles.inboxTime}>{ago(message.at, now)}</time> : null}
          </span>
          {message.from || message.body ? (
            <span className={styles.inboxBody}>
              {message.from ? <span className={styles.inboxFrom}>{message.from}</span> : null}
              {message.from && message.body ? ' · ' : null}
              {message.body}
            </span>
          ) : null}
          {message.action ? <ActionButton action={message.action} variant="outline" className={styles.inboxAction} /> : null}
        </div>
        {message.read ? null : <span className={styles.unreadDot} aria-label="Unread" />}
      </li>
    )
  }
  return (
    <div className={styles.inbox} data-slot="inbox-list">
      <div className={styles.inboxHead}>
        <span className={styles.inboxHeading}>Inbox</span>
        {messages.length > 0 ? (
          <div className={styles.inboxTabs} role="tablist" aria-label="Show">
            {(['all', 'unread'] as const).map((key) => (
              <Button key={key} variant="ghost" size="xs" type="button" role="tab" aria-selected={only === key} className={styles.inboxTab} onClick={() => setOnly(key)}>
                {key === 'all' ? 'All' : 'Unread'}
                {key === 'unread' && unread > 0 ? <span className={styles.tabCount}>{unread}</span> : null}
              </Button>
            ))}
          </div>
        ) : null}
        <span className={styles.fill} />
        {onMarkAllRead && unread > 0 ? (
          <Button variant="ghost" size="icon-sm" type="button" aria-label="Mark all read" title="Mark all read" onClick={onMarkAllRead}>
            <CheckAllIcon size={14} />
          </Button>
        ) : null}
        {onClear && messages.length > 0 ? (
          <Button variant="ghost" size="icon-sm" type="button" aria-label="Clear the inbox" title="Clear the inbox" onClick={onClear}>
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
  ...list
}: Parameters<typeof InboxList>[0] & { side?: 'top' | 'right' | 'bottom' | 'left' }) => {
  const unread = list.messages.filter((message) => !message.read).length
  return (
    <Popover
      title={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
      side={side}
      sideAlign="end"
      triggerVariant={{ variant: 'ghost', size: 'icon-sm' }}
      label={
        <span className={styles.bell} data-slot="inbox-button" {...(unread > 0 ? { 'data-unread': '' } : {})}>
          <BellIcon size={14} />
          {unread > 0 ? <span className={styles.bellCount}>{unread > 99 ? '99+' : unread}</span> : null}
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
