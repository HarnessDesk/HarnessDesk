import { Children, Fragment, cloneElement, createContext, isValidElement, useContext, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

import { AlertIcon, BellOffIcon, CheckIcon, CrossIcon, InfoIcon } from '../../components/Icons'
import { ContextMenu, MenuItem, type MenuPoint } from '../patterns/Menu'
import { Button } from '../ui/button'
import { IconTile } from '../ui/icon-tile'
import styles from './Banner.module.css'

/** One notice plate, shared by content-only notices and legacy Banner callers.
 * Size belongs to the host. Success reports a completed requested action;
 * normal conditions remain neutral. Danger adds a bar, never a tinted card.
 */
export type BannerTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const DEFAULT_ICON: Record<BannerTone, ReactNode> = {
  neutral: <InfoIcon size={17} />,
  info: <InfoIcon size={17} />,
  success: <CheckIcon size={14} />,
  warning: <AlertIcon size={17} />,
  danger: <AlertIcon size={17} />,
}

const NoticeContext = createContext({ compact: false, floating: false })

/** Placement owners set the size once for all notices in their slot. */
export const NoticeHost = ({ size = 'standard', floating = false, children }: {
  size?: 'standard' | 'compact'
  floating?: boolean
  children: ReactNode
}) => <NoticeContext.Provider value={{ compact: size === 'compact', floating }}>{children}</NoticeContext.Provider>

// Legacy JSX actions still obey the same count and one-primary policy.
const actionNodes = (actions: ReactNode): ReactNode[] => {
  const nodes: ReactNode[] = []
  Children.forEach(actions, child => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) nodes.push(...actionNodes(child.props.children))
    else if (child !== null && child !== undefined && typeof child !== 'boolean') nodes.push(child)
  })
  return nodes
}

export const Banner = (props: BannerProps) => <NoticeShell {...props} />

export type BannerProps = {
  tone?: BannerTone
  icon?: ReactNode
  mark?: ReactNode
  title?: ReactNode
  actions?: ReactNode
  onDismiss?: () => void
  onMute?: () => void
  /** Ignored compatibility alias: the placement host owns size. */
  compact?: boolean
  measure?: 'column' | 'container'
  role?: 'status' | 'alert'
  children?: ReactNode
}

export const NoticeShell = ({
  tone = 'neutral',
  icon,
  mark,
  kind = 'card',
  title,
  actions,
  onDismiss,
  onMute,
  measure = 'column',
  role,
  children,
}: BannerProps & { kind?: 'card' | 'status' | 'row' }) => {
  const { compact, floating } = useContext(NoticeContext)
  let primary = false
  const buttons = actionNodes(actions).map((node, key) => {
    if (!isValidElement<{ variant?: string }>(node)) return node
    if (node.type !== BannerAction && node.type !== Button) return cloneElement(node, { key })
    const isPrimary = node.type === BannerAction ? node.props.variant !== 'secondary' : !node.props.variant || node.props.variant === 'default'
    const variant = isPrimary && primary ? 'secondary' : node.props.variant
    if (isPrimary) primary = true
    return cloneElement(node, { key, ...(variant ? { variant } : {}) })
  })
  const [menuAt, setMenuAt] = useState<MenuPoint | null>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [wrapped, setWrapped] = useState(false)
  useLayoutEffect(() => {
    const element = textRef.current
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
  }, [title, children])

  const hasContent = (content: ReactNode) => actionNodes(content).some(node => typeof node !== 'string' || node.trim().length > 0)
  if (!hasContent(title) && !hasContent(children)) return null

  return (
    /* Keep the card within its reading column unless its page block owns a wider measure. */
    <div className={styles.frame} data-measure={measure}>
    <div
      data-slot={kind === 'card' ? 'alert' : `notice-${kind}`}
      data-notice-kind={kind}
      className={styles.banner}
      data-tone={tone}
      {...(wrapped ? { 'data-wrapped': '' } : {})}
      {...(compact ? { 'data-compact': '' } : {})}
      {...(floating ? { 'data-floating': '' } : {})}
      {...(buttons.length >= 3 ? { 'data-stack': '' } : {})}
      /* Passed through, `undefined` included: a persistent banner must not be
         an assertive live region. See design/ui/alert.tsx. */
      role={role}
    >
      <IconTile size="sm" shape={mark ? 'face' : 'square'} tone={tone} className={styles.icon} data-part="banner-icon">{mark ?? icon ?? DEFAULT_ICON[tone]}</IconTile>
      <div ref={textRef} className={styles.text} data-slot="alert-content">
        {hasContent(title) && <div className={styles.title} data-slot="alert-title">{title}</div>}
        {hasContent(children) && (
          <div className={styles.body} data-slot="alert-description">{children}</div>
        )}
      </div>
      {buttons.length > 0 && <div className={styles.actions}>{buttons}</div>}
      {onDismiss && (
        <Button
          variant="ghost"
          // The card's own 28px/24px target, exactly: `icon-sm`'s box is
          // `--hd-btn-h-sm` (28px) and `icon-xs`'s is `--hd-icon-target`
          // (24px), so the compact card's smaller dismiss is a size rather
          // than a one-off measurement in `.dismiss`.
          size={compact ? 'icon-xs' : 'icon-sm'}
          edge="end"
          edgeGlyph={compact ? 11 : 13}
          type="button"
          className={styles.dismiss}
          aria-label="Dismiss"
          // "Dismiss, has pop-up menu" is the whole truth about the escalated
          // control: what it is still for, and that there is more behind it.
          {...(onMute ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': menuAt !== null } : {})}
          onClick={(event) => {
            if (!onMute) {
              onDismiss()
              return
            }
            // Dropped from the control rather than from the pointer: this is a
            // menu belonging to a button, and one opened a few pixels away
            // from a 28px target looks detached from it.
            const rect = event.currentTarget.getBoundingClientRect()
            setMenuAt({ x: rect.left, y: rect.bottom + 4 })
          }}
        >
          <CrossIcon size={compact ? 11 : 13} />
        </Button>
      )}
      {onDismiss && onMute && (
        <ContextMenu at={menuAt} label="Message options" onClose={() => setMenuAt(null)} icons="none">
          <MenuItem icon={<CrossIcon size={14} />} label="Dismiss" onSelect={onDismiss} />
          <MenuItem
            icon={<BellOffIcon size={14} />}
            label="Stop showing this"
            hint="Turn it back on in Settings › Notifications"
            onSelect={onMute}
          />
        </ContextMenu>
      )}
    </div>
    </div>
  )
}

/**
 * A button in a banner's action row.
 *
 * One filled button per card. A banner that offers two equal-looking choices
 * makes the user read both before they can ignore it.
 */
export const BannerAction = ({
  variant = 'primary',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) => (
  <Button type="button" variant={variant === 'primary' ? 'default' : 'secondary'} {...rest} />
)

export const BannerStack = ({ children }: { children: ReactNode }) => (
  <NoticeHost size="compact" floating><div className={styles.stack}>{children}</div></NoticeHost>
)

export const NoticeListShell = ({ title, children }: { title?: ReactNode; children?: ReactNode }) => {
  if (!title && !children) return null
  return <NoticeHost size="compact"><section className={styles.list} data-slot="notice-list">
    {title ? <div className={styles.listTitle}>{title}</div> : null}
    {children}
  </section></NoticeHost>
}
