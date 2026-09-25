import { useRef, type ComponentProps, type ReactNode } from 'react'

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
 * The head every dialog wears: its mark, its name, and the way out.
 *
 * `Dialog` draws it, and so does a sheet that lays out its own body — the
 * skill sheet — so a dialog's name is one step, one inset and one rule under
 * it whichever of them is open. The name is the subject step (14/21, medium):
 * a dialog names one question or one thing, and a page names a place.
 *
 * `aside` sits on the name's own line (a kind badge); `children` are the lines
 * under it — an identifier, the sentence saying what the thing is — and the
 * head then aligns to its top, so the mark and the way out stay beside the
 * name rather than drifting to the middle of a paragraph.
 */
export const DialogHead = ({
  icon,
  title,
  aside,
  tone = 'default',
  children,
}: {
  icon?: ReactNode
  title: ReactNode
  aside?: ReactNode
  tone?: 'default' | 'destructive'
  children?: ReactNode
}) => {
  /* The subject step, said as utilities so `cn` replaces the primitive's
     `text-base leading-none`: a module rule saying the same tied with them,
     and the preview drew 16px titles. */
  const name = (className: string | undefined) => (
    <DialogTitle className={cn(className, 'text-(length:--hd-text) leading-(--hd-line) font-medium')}>{title}</DialogTitle>
  )
  const lines = children != null || aside != null
  return (
    <div
      className={styles.header}
      data-slot="dialog-head"
      data-tone={tone === 'destructive' ? 'destructive' : undefined}
      {...(children != null ? { 'data-lines': '' } : {})}
    >
      {icon && <span className={styles.icon}>{icon}</span>}
      {lines ? (
        <div className={styles.heading}>
          <div className={styles.titleLine}>
            {name(styles.titleText)}
            {aside}
          </div>
          {children}
        </div>
      ) : (
        name(styles.title)
      )}
      <DialogClose
        className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        aria-label="Close"
      >
        <CrossIcon size={13} />
      </DialogClose>
    </div>
  )
}

/**
 * Under the head, above the body, and outside the scroll: a breadcrumb, or
 * the view switch of a document, still there after the body has scrolled.
 */
export const DialogSubhead = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="dialog-subhead" className={cn(styles.subhead, className)} {...props} />
)

/**
 * A dialog's body, which scrolls and is inset the dialog's step.
 *
 * `form` (what `Dialog` draws unless it is `flush`) is the form stack: its
 * children are 16px apart, a `SectionHead` in it is a legend, and a `Rows`
 * radio group is a compact `ChoiceList`. `flush` is a list whose rows reach
 * the edges. `reading` is inset like a form and is not one — a document, or
 * the facts beside it — so its parts keep their own rhythm.
 */
export const DialogBody = ({
  layout = 'form',
  className,
  children,
  ...props
}: ComponentProps<'div'> & { layout?: 'form' | 'flush' | 'reading' }) => (
  <div
    className={cn(styles.body, layout === 'flush' ? styles.flush : layout === 'form' ? dialogStackClass : undefined, className)}
    data-slot="modal-dialog-body"
    data-layout={layout}
    {...props}
  >
    {/* A flush body is a list, and a reading body a document: only a form
        body is a form. */}
    {layout === 'form' ? <DialogFormScope>{children}</DialogFormScope> : children}
  </div>
)

/**
 * The application dialog pattern: Base UI owns focus, dismissal, stacking,
 * the portal and accessibility; this layer owns HarnessDesk's header, body,
 * footer and measured sizes.
 *
 * The body is a form stack (`DialogForm`) unless it is `flush`: its children
 * are 16px apart, a `SectionHead` in it is a legend on the group it names,
 * and a `Rows` radio group of `RowChoice` rows is a compact `ChoiceList`.
 * Nothing in the body needs spacing of its own. A `flush` body is a list and
 * is not a form, so it keeps the page's parts.
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
        /* The ceiling is 80% of the window up to 720px: a form of a few
           fields and two short choice lists stands whole in a 900px window
           rather than scrolling its last answer out of sight (it was 72%,
           which cut Save as an Agent by 28px). `tall` states its own bound,
           and `cn` lets it replace the ceiling rather than tie with it. */
        className={cn(
          WIDTH[size],
          'flex max-h-[min(80vh,720px)] flex-col gap-0 overflow-hidden rounded-(--hd-surface-radius) bg-(--hd-surface-fill) p-0 text-(--hd-popover-foreground) shadow-(--hd-surface-shadow)',
          tall && 'h-[min(62vh,560px)] max-h-[min(62vh,560px)]',
        )}
      >
        <DialogHead icon={icon} title={title} tone={tone} />
        {subhead && <DialogSubhead>{subhead}</DialogSubhead>}
        {children && <DialogBody layout={flush ? 'flush' : 'form'}>{children}</DialogBody>}
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
