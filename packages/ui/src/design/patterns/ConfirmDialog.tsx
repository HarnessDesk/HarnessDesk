import { useEffect, useId, useRef, type ReactNode } from 'react'

import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogClose,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import styles from './ConfirmDialog.module.css'
import { DIALOG_WIDTH, DialogBody, DialogFooter, DialogHead } from './ModalDialog'

/**
 * "Are you sure?" — asked the same way every time.
 *
 * This exists because the app kept answering the same four questions
 * separately, and the answers drifted:
 *
 *   Where do the buttons go?      Bottom right, proceeding action rightmost.
 *   What does cancel say?         The verb for keeping things as they are —
 *                                 "Keep", not "Cancel". A person reading fast
 *                                 sees two verbs and picks; "Cancel" beside
 *                                 "Delete" reads as two ways to stop.
 *   Which one is default?         Neither. Nothing is focused, so Return does
 *                                 not delete anything.
 *   What does the body say?       What is destroyed and where it goes. Not
 *                                 "This cannot be undone" — say what happens,
 *                                 and the reader can tell that themselves.
 *
 * The rule is in one file, so the eleventh confirm cannot get it wrong by
 * copying the tenth.
 * A live update that removes the opener or disables confirmation can request
 * `focusCancel`, moving focus to the keeping verb while the question stays open.
 */
export const ConfirmDialog = ({
  title,
  confirmLabel,
  cancelLabel = 'Keep',
  tone = 'default',
  busy = false,
  busyLabel,
  pending = false,
  focusCancel = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: string
  /** @deprecated Confirm dialogs share one anatomy and do not render leading icons. */
  icon?: ReactNode
  /** The verb for what happens — "Delete", "Remove worktree". Never "OK". */
  confirmLabel: string
  /** The verb for leaving things alone. Only override with a better verb. */
  cancelLabel?: string
  /**
   * `destructive` — the trash glyph and the filled red verb — only for a confirm that
   * really destroys something: delete, remove, discard, forget, sign out. A
   * consent, an approval or a run asks in the ordinary tone, which is why it
   * is the default: the red look is chosen, never inherited.
   */
  tone?: 'destructive' | 'default'
  busy?: boolean
  busyLabel?: string
  /**
   * The dialog is still finding out what confirming would cost — reading the
   * folder, counting the files. The action stays visible and disabled rather
   * than absent, because a button that appears under a pointer already moving
   * towards it gets clicked by accident.
   */
  pending?: boolean
  /** Move focus to the keeping verb when a live update removes the opener or disables confirmation. */
  focusCancel?: boolean
  onConfirm: () => void
  onCancel: () => void
  /** What is destroyed and where it goes. One or two sentences. */
  children: ReactNode
}) => {
  const cancel = useRef<HTMLButtonElement>(null)
  const descriptionId = useId()
  useEffect(() => {
    if (focusCancel && !busy) cancel.current?.focus()
  }, [focusCancel, busy])
  return (
  /*
   * Base UI's alert dialog, wearing the app's dialog classes.
   *
   * The shell used to be the ordinary `Dialog`, which closes when you press
   * the backdrop &mdash; right for a sheet you are reading, wrong for a
   * question you have to answer, and the reason a confirm could be dismissed
   * by a stray click without either verb being chosen. `role="alertdialog"`
   * also tells a screen reader this one is not passive.
   *
   * `initialFocus={false}` keeps the third rule above: nothing is focused, so
   * a held Return does not delete anything. Left to itself, Base UI focuses
   * the popup when a touch opened it and the first control otherwise, and the
   * first control here is the proceeding one &mdash; in a destructive confirm,
   * the one that deletes.
   */
  <AlertDialog open onOpenChange={(next) => { if (!next) onCancel() }}>
    <AlertDialogContent
      /* The box is said once, as utilities: a column, bounded by the window,
         with no padding or gap of its own — header, body and footer pad
         themselves. The primitive's `grid gap-3 p-4` are utilities too, so
         `cn` drops them here. A module rule saying the same would tie with
         them, and which won depended on the order a build loaded the sheets:
         the preview drew every confirm with a second 16px frame. */
      className={cn(DIALOG_WIDTH.sm, 'flex max-h-(--hd-dialog-max-height) flex-col gap-0 overflow-hidden p-0')}
      initialFocus={false}
      aria-describedby={descriptionId}
    >
      <DialogHead
        title={title}
        tone={tone}
        Title={AlertDialogTitle}
        Close={AlertDialogClose}
        closeDisabled={busy}
      />
      {/* The body is the shared padded slot and the alert dialog's description:
          a confirm can hold a whole skill or command while the answers stay fixed. */}
      <DialogBody id={descriptionId} layout="reading" className={styles.confirmationBody}>
        {children}
      </DialogBody>
      {/* The proceeding action is written first. The footer is `row-reverse`,
          so first in the markup paints rightmost &mdash; the first rule above.
          The order decides the keyboard too: nothing is focused on open, so
          focus is still on the opener, and Base UI's guard before the popup
          hands the first Tab to the popup's last control, which is Keep. A Tab
          and a Return keep things as they are. Written the other way round,
          every confirm in the app put the verb for leaving things alone where
          the pointer goes to proceed, and a Tab and a Return confirmed. */}
      <DialogFooter actions={
        <>
          {/* One filled button: the act, red when it destroys. The way to keep
              things as they are is quiet — it is the answer that changes
              nothing, and it should not compete with the one that does. */}
          <Button
            variant={tone === 'destructive' ? 'danger' : 'default'}
            onClick={onConfirm}
            disabled={busy || pending}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </Button>
          <Button ref={cancel} variant="quiet" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
        </>
      } />
    </AlertDialogContent>
  </AlertDialog>
  )
}
