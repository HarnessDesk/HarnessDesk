import { useRef, type ReactNode } from 'react'

import { CrossIcon } from '../../components/Icons'
import { cn } from '../../lib/utils'
import { buttonVariants } from '../ui/button'
import {
  Dialog as DialogRoot,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../ui/dialog'
import { dialogStackClass, DialogFormScope } from './DialogForm'
import styles from './ModalDialog.module.css'

const WIDTH = {
  sm: 'w-[min(460px,100%)] max-w-none sm:max-w-none',
  md: 'w-[min(520px,100%)] max-w-none sm:max-w-none',
  lg: 'w-[min(560px,100%)] max-w-none sm:max-w-none',
  xl: 'w-[min(620px,100%)] max-w-none sm:max-w-none',
} as const

/**
 * The first control a person types into: a text field, a text area or a
 * select. A checkbox, a radio or a button is not a field — landing on one
 * would draw its ring on open and invite Space or Return to answer for you.
 */
const FIELD = [
  'input:not([type=hidden],[type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=range],[type=color],[type=file]):not(:disabled,[readonly])',
  'textarea:not(:disabled,[readonly])',
  'select:not(:disabled)',
].join(',')

/**
 * The application dialog pattern: Base UI owns focus, dismissal, stacking,
 * the portal and accessibility; this layer owns HarnessDesk's header, body,
 * footer and measured sizes.
 *
 * The body is a form stack (`DialogForm`) unless it is `flush`: its children
 * are 16px apart, a `SectionHead` in it is a legend on the group it names,
 * and a `Rows` radio group is a compact `ChoiceList`. Nothing in the body
 * needs spacing of its own.
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
        /* The first field when there is one, so a dialog that asks for a
           name is ready for it; otherwise the surface, so Escape reaches it
           and a reader lands inside. The surface wears no ring (the
           primitive's `SURFACE_FOCUS`), whatever opened it. */
        initialFocus={() => surface.current?.querySelector<HTMLElement>(`[data-slot="modal-dialog-body"] :is(${FIELD})`) ?? surface.current}
        showCloseButton={false}
        aria-label={title}
        aria-describedby={undefined}
        className={`${WIDTH[size]} ${tall ? 'h-[min(62vh,560px)] max-h-[min(62vh,560px)]' : ''} flex max-h-[min(72vh,720px)] flex-col gap-0 overflow-hidden rounded-(--hd-surface-radius) bg-(--hd-surface-fill) p-0 text-(--hd-popover-foreground) shadow-(--hd-surface-shadow)`}
      >
        <div className={styles.header} data-tone={tone === 'destructive' ? 'destructive' : undefined}>
          {icon && <span className={styles.icon}>{icon}</span>}
          {/* The subject step, said as utilities so `cn` replaces the
              primitive's `text-base leading-none`: a module rule saying the
              same tied with them, and the preview drew 16px titles. */}
          <DialogTitle className={cn(styles.title, 'text-(length:--hd-text) leading-(--hd-line) font-medium')}>{title}</DialogTitle>
          <DialogClose
            className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
            aria-label="Close"
          >
            <CrossIcon size={13} />
          </DialogClose>
        </div>
        {subhead && <div className={styles.subhead}>{subhead}</div>}
        {children && (
          <div className={`${styles.body} ${flush ? styles.flush : dialogStackClass}`} data-slot="modal-dialog-body">
            <DialogFormScope>{children}</DialogFormScope>
          </div>
        )}
        {(footer || footerAside) && (
          /* `dialog-footer` is what the button reads to draw an ordinary
             action quiet here, so the confirm is the one filled button. */
          <div className={styles.footer} data-slot="dialog-footer">
            {footer}
            {footerAside && <span className={styles.footerAside}>{footerAside}</span>}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  )
}
