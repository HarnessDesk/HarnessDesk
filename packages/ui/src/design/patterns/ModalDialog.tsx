import { useRef, type ComponentProps, type ComponentType, type ReactNode } from 'react'

import { CrossIcon } from '../../components/Icons'
import { cn } from '../../lib/utils'
import { buttonVariants } from '../ui/button'
import {
  Dialog as DialogRoot,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog'
import { dialogStackClass, DialogFormScope } from './DialogForm'
import styles from './ModalDialog.module.css'

export const DIALOG_WIDTH = {
  sm: 'w-[min(460px,100%)] max-w-none sm:max-w-none',
  md: 'w-[min(520px,100%)] max-w-none sm:max-w-none',
  lg: 'w-[min(560px,100%)] max-w-none sm:max-w-none',
  xl: 'w-[min(620px,100%)] max-w-none sm:max-w-none',
  wide: 'w-[min(860px,100%)] max-w-none sm:max-w-none',
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
 * The head every dialog wears: its name, context, short description, and way out.
 *
 * `Dialog` draws it, and so does a sheet that lays out its own body — the
 * MCP detail — so a dialog's name is one step, one inset and one rule under
 * it whichever of them is open. The name is the title step (16/24, semibold).
 *
 * `aside` sits after the name on its line (a context chip); `children` are one
 * under it — an identifier, the sentence saying what the thing is — and the
 * head then aligns to its top, so the title and the way out stay beside the
 * name rather than drifting to the middle of a paragraph.
 */
export const DialogHead = ({
  title,
  aside,
  tone = 'default',
  Title = DialogTitle,
  Close = DialogClose,
  closeDisabled = false,
  children,
}: {
  /** @deprecated Dialog titles share one anatomy and do not render leading icons. */
  icon?: ReactNode
  title: ReactNode
  aside?: ReactNode
  tone?: 'default' | 'destructive'
  /** Alert dialogs supply their matching Base UI primitives; the slot styling stays shared. */
  Title?: ComponentType<ComponentProps<typeof DialogTitle>>
  Close?: ComponentType<ComponentProps<typeof DialogClose>>
  closeDisabled?: boolean
  children?: ReactNode
}) => {
  /* The title step, said as utilities so the preview and app render alike. */
  const name = (className: string | undefined) => (
    // A title is a name: it gives way at its end on one line, and the whole of it is on hover.
    <Title className={cn(className, 'truncate text-(length:--hd-text-lg) leading-(--hd-line-lg) font-semibold')} title={typeof title === 'string' ? title : undefined}>{title}</Title>
  )
  const lines = children != null || aside != null
  return (
    <div
      className={styles.header}
      data-slot="dialog-head"
      data-tone={tone === 'destructive' ? 'destructive' : undefined}
      {...(children != null ? { 'data-lines': '' } : {})}
    >
      {lines ? (
        <div className={styles.heading}>
          <div className={styles.titleLine}>
            {name(styles.titleText)}
            {aside}
          </div>
          {children != null && (
            <DialogDescription
              className={cn(styles.description, 'text-(--hd-secondary-foreground) text-(length:--hd-text-sm) leading-(--hd-line-sm)')}
            >
              {children}
            </DialogDescription>
          )}
        </div>
      ) : (
        name(styles.title)
      )}
      <Close
        className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        aria-label="Close"
        disabled={closeDisabled}
      >
        <CrossIcon size={13} />
      </Close>
    </div>
  )
}

/**
 * A dialog's body, which scrolls and keeps 24px on every side in every layout.
 *
 * Every body keeps the dialog inset on all four sides. `form` (what `Dialog`
 * draws unless it is `flush`) is the form stack: its children are 16px apart,
 * a `SectionHead` in it is a legend, and a `Rows` radio group is a compact
 * `ChoiceList`. `flush` changes the child grammar for a list; it does not
 * remove the body's inset. `reading` is an inset document or facts column.
 */
export const DialogBody = ({
  layout = 'form',
  className,
  children,
  ...props
}: ComponentProps<'div'> & { layout?: 'form' | 'flush' | 'reading' }) => (
  <div
    className={cn(styles.body, layout === 'form' ? dialogStackClass : undefined, className)}
    data-slot="modal-dialog-body"
    data-layout={layout}
    {...props}
  >
    {/* A flush body is a list, and a reading body a document: only a form
        body is a form. */}
    {layout === 'form' ? <DialogFormScope>{children}</DialogFormScope> : children}
  </div>
)

/** One same-height footer band, with an optional quiet link at the left and actions at the right. */
export const DialogFooter = ({
  actions,
  aside,
  navigation,
}: {
  actions?: ReactNode
  aside?: ReactNode
  navigation?: ReactNode
}) => (
  <div className={styles.footer} data-slot="dialog-footer">
    {(navigation || aside) && (
      <div className={styles.footerLeading}>
        {navigation && (
          <nav className={styles.footerNavigation} data-slot="dialog-footer-navigation" aria-label="Start alternatives">
            {navigation}
          </nav>
        )}
        {aside && <span className={styles.footerAside}>{aside}</span>}
      </div>
    )}
    {actions && <div className={styles.footerActions} data-slot="dialog-footer-actions">{actions}</div>}
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
 * The body keeps its 24px inset in every layout. A `flush` body is a list and
 * is not a form, so it keeps the page's parts inside that inset.
 */
export const Dialog = ({
  title,
  titleAside,
  description,
  tone = 'default',
  size = 'sm',
  tall = false,
  flush = false,
  onClose,
  bodyPrelude,
  children,
  footer,
  footerAside,
  footerNavigation,
}: {
  title: string
  /** @deprecated Dialog titles share one anatomy and do not render leading icons. */
  icon?: ReactNode
  titleAside?: ReactNode
  description?: ReactNode
  tone?: 'default' | 'destructive'
  size?: keyof typeof DIALOG_WIDTH
  tall?: boolean
  flush?: boolean
  onClose: () => void
  /** Optional first item inside the padded body, such as a path breadcrumb. */
  bodyPrelude?: ReactNode
  children?: ReactNode
  /** Write the proceeding action first; the footer paints it rightmost. */
  footer?: ReactNode
  footerAside?: ReactNode
  /** Navigation alternatives have no proceeding action; action footers retain their filled act. */
  footerNavigation?: ReactNode
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
        /* The ceiling is 80% of the window up to 720px: a form of a few
           fields and two short choice lists stands whole in a 900px window
           rather than scrolling its last answer out of sight (it was 72%,
           which cut Save as an Agent by 28px). `tall` states its own bound,
           and `cn` lets it replace the ceiling rather than tie with it. */
        className={cn(
          DIALOG_WIDTH[size],
          'flex max-h-[min(80vh,720px)] flex-col gap-0 overflow-hidden rounded-(--hd-surface-radius) bg-(--hd-surface-fill) p-0 text-(--hd-popover-foreground) shadow-(--hd-surface-shadow)',
          tall && 'h-[min(62vh,560px)] max-h-[min(62vh,560px)]',
        )}
      >
        <DialogHead title={title} aside={titleAside} tone={tone}>{description}</DialogHead>
        {(children || bodyPrelude) && (
          <DialogBody layout={flush ? 'flush' : 'form'}>
            {bodyPrelude != null && <div className={styles.bodyPrelude} data-slot="dialog-body-prelude">{bodyPrelude}</div>}
            {children}
          </DialogBody>
        )}
        {(footer || footerAside || footerNavigation) && (
          /* `dialog-footer` is what the button reads to draw a secondary action
             quiet beside the primary, leaving exactly one filled action. */
          <DialogFooter actions={footer} aside={footerAside} navigation={footerNavigation} />
        )}
      </DialogContent>
    </DialogRoot>
  )
}
