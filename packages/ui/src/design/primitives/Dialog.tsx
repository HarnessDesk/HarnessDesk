import { useEffect, useRef, type ReactNode } from 'react'

import { CrossIcon } from '../../components/Icons'
import { IconBtn } from './Kit'
import styles from './Dialog.module.css'

/**
 * Every dialog currently open, innermost last.
 *
 * Escape means "close the thing I am looking at", and the thing you are
 * looking at is the last one opened. Without this list, a confirm dialog
 * opened from a settings sheet has no way to know it is not the only one.
 */
const OPEN: object[] = []

/**
 * A surface that takes the window's attention until it is answered.
 *
 * The behaviour is the point, not the box: Escape closes, focus moves into
 * the dialog when it opens and returns where it came from when it leaves, and
 * a click on the ground behind it dismisses. Ten hand-rolled dialogs in this
 * app each decided those separately, and most decided at least one of them by
 * omission.
 *
 * Deliberately unaware of the app: no store, no session, no context. A dialog
 * has to work on the sign-in screen, before there is an app to be aware of.
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
  /** `destructive` marks the title glyph, so consequence reads before prose. */
  tone?: 'default' | 'destructive'
  /**
   * How wide. The four steps are the widths this app already used — 460 for a
   * question, 520 for one that shows you what you are agreeing to, 560 for a
   * list you browse, 620 for one you read. A dialog that wants a fifth width
   * is usually a dialog that wants to be a page.
   */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /**
   * Take a fixed height rather than growing to fit. For a dialog whose body is
   * a list: the surface stops moving as you walk into folders, and the list
   * scrolls inside it instead.
   */
  tall?: boolean
  /**
   * Drop the body's padding, for a body that is a list. A row wants to span
   * the full width so its hover reaches the edges, and inset padding around a
   * scrolling list wastes the height the list came for.
   */
  flush?: boolean
  onClose: () => void
  /**
   * A strip under the header that does not scroll: a breadcrumb, a filter, a
   * tab row. It belongs here rather than at the top of the body because it
   * says where you are, and a reader who has scrolled still needs to know.
   */
  subhead?: ReactNode
  children?: ReactNode
  /** Actions. Write the confirming one first; the footer paints it rightmost. */
  footer?: ReactNode
  footerAside?: ReactNode
}) => {
  const surface = useRef<HTMLDivElement>(null)

  // `onClose` is almost always an inline arrow at the call site, so it has a
  // new identity on every render. Held in a ref, the effect below can run once
  // per open rather than once per render — which matters because its cleanup
  // restores focus: re-running it would pull the caret out of the dialog every
  // time the parent re-rendered, and an `autoFocus` field would never keep it.
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null
    // Focus the surface rather than the first control: landing on a button
    // means a stray Return commits an action nobody read.
    //
    // Unless the body has already claimed focus. A dialog whose job is to take
    // typing marks its field `autoFocus`, and React applies that during the
    // commit — before this effect runs. Focusing the surface here regardless
    // would take the caret straight back out of the field the dialog exists
    // for, and the first thing typed would go nowhere.
    if (!surface.current?.contains(document.activeElement)) surface.current?.focus()

    const token = {}
    OPEN.push(token)
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Only the dialog on top answers. The ones underneath still get the
      // event — they are earlier listeners on the same node — and must let it
      // through, or the top one never sees it.
      if (OPEN[OPEN.length - 1] !== token) return
      // `stopImmediatePropagation`, not `stopPropagation`: the sheet this
      // dialog was opened from listens on `document` too, and stopping
      // propagation does nothing about a listener on the same node. Without
      // this, Escape in a confirm dialog also closes the settings sheet
      // behind it — one key press, two things dismissed.
      event.stopImmediatePropagation()
      event.preventDefault()
      close.current()
    }
    // Window, capture phase: ahead of anything listening on `document`, which
    // is where the rest of the app puts its Escape handlers.
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const at = OPEN.indexOf(token)
      if (at !== -1) OPEN.splice(at, 1)
      returnTo?.focus?.()
    }
    // Deliberately empty: this is "while the dialog is open", not "when the
    // handler changes".
  }, [])

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={surface}
        className={`${styles.dialog} ${styles[size]} ${tall ? styles.tall : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className={styles.header} data-tone={tone === 'destructive' ? 'destructive' : undefined}>
          {icon && <span className={styles.icon}>{icon}</span>}
          <span className={styles.title}>{title}</span>
          <IconBtn className={styles.close} aria-label="Close" onClick={onClose}>
            <CrossIcon size={13} />
          </IconBtn>
        </div>
        {subhead && <div className={styles.subhead}>{subhead}</div>}
        {children && (
          <div className={`${styles.body} ${flush ? styles.flush : ''}`}>{children}</div>
        )}
        {(footer || footerAside) && (
          <div className={styles.footer}>
            {footer}
            {footerAside && <span className={styles.footerAside}>{footerAside}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

/*
 * The dialog's own classes, for the one pattern that needs the look without
 * the shell: `ConfirmDialog` renders through Base UI's alert dialog (no
 * outside-press close, `role="alertdialog"`, its own focus trap) and wears
 * these, so a confirm is pixel-identical to every other dialog and behaves
 * the way a question should. Exported rather than imported across files
 * because `design:audit` counts a screen reaching into another's stylesheet
 * &mdash; the same arrangement `Banner` uses.
 */
export { styles as dialogStyles }
