import { useRef, type ReactNode } from 'react'

import { CrossIcon } from '../../components/Icons'
import { buttonVariants } from '../ui/button'
import {
  Dialog as DialogRoot,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../ui/dialog'
import styles from './ModalDialog.module.css'

const WIDTH = {
  sm: 'w-[min(460px,100%)] max-w-none sm:max-w-none',
  md: 'w-[min(520px,100%)] max-w-none sm:max-w-none',
  lg: 'w-[min(560px,100%)] max-w-none sm:max-w-none',
  xl: 'w-[min(620px,100%)] max-w-none sm:max-w-none',
} as const

/**
 * The application dialog pattern: Base UI owns focus, dismissal, stacking,
 * the portal and accessibility; this layer owns HarnessDesk's header, body,
 * footer and measured sizes.
 */
export const Dialog = ({
  title,
  icon,
  tone = 'default',
  size = 'sm',
  tall = false,
  flush = false,
  onClose,
  subhead,
  children,
  footer,
  footerAside,
}: {
  title: string
  icon?: ReactNode
  tone?: 'default' | 'destructive'
  size?: keyof typeof WIDTH
  tall?: boolean
  flush?: boolean
  onClose: () => void
  subhead?: ReactNode
  children?: ReactNode
  /** Write the proceeding action first; the footer paints it rightmost. */
  footer?: ReactNode
  footerAside?: ReactNode
}) => {
  const surface = useRef<HTMLDivElement>(null)

  return (
    <DialogRoot open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        ref={surface}
        initialFocus={surface}
        showCloseButton={false}
        aria-label={title}
        aria-describedby={undefined}
        className={`${WIDTH[size]} ${tall ? 'h-[min(62vh,560px)] max-h-[min(62vh,560px)]' : ''} flex max-h-[min(72vh,720px)] flex-col gap-0 overflow-hidden rounded-(--hd-surface-radius) bg-(--hd-surface-fill) p-0 text-(--hd-popover-foreground) shadow-(--hd-surface-shadow)`}
      >
        <div className={styles.header} data-tone={tone === 'destructive' ? 'destructive' : undefined}>
          {icon && <span className={styles.icon}>{icon}</span>}
          <DialogTitle className={styles.title}>{title}</DialogTitle>
          <DialogClose
            className={buttonVariants({ variant: 'ghost', size: 'icon-sm', className: styles.close })}
            aria-label="Close"
          >
            <CrossIcon size={13} />
          </DialogClose>
        </div>
        {subhead && <div className={styles.subhead}>{subhead}</div>}
        {children && <div className={`${styles.body} ${flush ? styles.flush : ''}`}>{children}</div>}
        {(footer || footerAside) && (
          <div className={styles.footer}>
            {footer}
            {footerAside && <span className={styles.footerAside}>{footerAside}</span>}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  )
}
