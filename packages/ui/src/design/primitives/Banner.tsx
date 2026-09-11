import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

import { AlertIcon, BellOffIcon, CrossIcon, InfoIcon } from '../../components/Icons'
import { ContextMenu, MenuItem, type MenuPoint } from '../../components/Menu'
import { Alert, AlertContent, AlertDescription, AlertTitle } from '../ui/alert'
import styles from './Banner.module.css'

/**
 * A message the app has to make outside the conversation.
 *
 * Everything that interrupts — a toast, a condition that changes what the app
 * can do, a first-run offer — is the same card: an icon that carries the
 * severity, a title that states the fact, a line of detail under it, and the
 * actions on the right, ending in a dismiss. Keeping them one component is
 * what stops the fourth kind of message from inventing a fourth look.
 *
 * The card itself stays neutral in every tone. Colour that floods a banner
 * reads as an emergency whatever it says, and most of these are not.
 *
 * The shell is the shadcn `Alert` (design/ui/alert.tsx) as of the registry
 * adoption pass, which is where the title/description anatomy now comes from.
 * Two things did *not* come with it. Its tinted grounds:
 * `Alert` offers five, this passes `neutral` always, and the icon keeps
 * carrying the severity. And its `role="alert"`, which the registry hard-codes
 * and which would make every persistent banner an assertive live region &mdash;
 * the first-run offer talking over the page it is offering to set up. The role
 * is the caller's here, `undefined` included.
 *
 * Adopting a component is not the same as adopting every opinion in it.
 */

export type BannerTone = 'neutral' | 'info' | 'warning' | 'danger'

const DEFAULT_ICON: Record<BannerTone, ReactNode> = {
  neutral: <InfoIcon size={17} />,
  info: <InfoIcon size={17} />,
  warning: <AlertIcon size={17} />,
  danger: <AlertIcon size={17} />,
}

export const Banner = ({
  tone = 'neutral',
  icon,
  title,
  actions,
  onDismiss,
  onMute,
  compact = false,
  role,
  children,
}: {
  tone?: BannerTone
  /** Overrides the tone's icon, for a message with a subject of its own. */
  icon?: ReactNode
  title?: ReactNode
  actions?: ReactNode
  onDismiss?: () => void
  /**
   * Offered beside the dismiss, for a message the reader has already put away
   * twice. Given, the × opens a two-item menu instead of closing the card:
   * putting this one away, or never being shown its like again.
   */
  onMute?: () => void
  /** The toast form: one line, no title, leaves on its own. */
  compact?: boolean
  role?: 'status' | 'alert'
  /** The detail under the title, or the whole message when there is no title. */
  children?: ReactNode
}) => {
  const [menuAt, setMenuAt] = useState<MenuPoint | null>(null)

  return (
    /* The frame is the card's width, given a name a query can ask: see
       `.frame` in the stylesheet. */
    <div className={styles.frame}>
    <Alert
      tone="neutral"
      className={styles.banner}
      data-tone={tone}
      {...(compact ? { 'data-compact': '' } : {})}
      /* Passed through, `undefined` included: a persistent banner must not be
         an assertive live region. See design/ui/alert.tsx. */
      role={role}
    >
      <span className={styles.icon}>{icon ?? DEFAULT_ICON[tone]}</span>
      <AlertContent className={styles.text}>
        {title !== undefined && <AlertTitle className={styles.title}>{title}</AlertTitle>}
        {children !== undefined && (
          <AlertDescription className={styles.body}>{children}</AlertDescription>
        )}
      </AlertContent>
      {actions && <div className={styles.actions}>{actions}</div>}
      {onDismiss && (
        <button
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
        </button>
      )}
      {onDismiss && onMute && (
        <ContextMenu at={menuAt} label="Message options" onClose={() => setMenuAt(null)}>
          <MenuItem icon={<CrossIcon size={14} />} label="Dismiss" onSelect={onDismiss} />
          <MenuItem
            icon={<BellOffIcon size={14} />}
            label="Stop showing this"
            hint="Turn it back on in Settings › Notifications"
            onSelect={onMute}
          />
        </ContextMenu>
      )}
    </Alert>
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
  <button type="button" className={styles.action} data-variant={variant} {...rest} />
)

export { styles as bannerStyles }
