import type { ReactNode } from 'react'

import { AlertIcon, TrashIcon } from '../../components/Icons'
import { Button } from '../ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { cn } from '../../lib/utils'
import styles from './ConfirmDialog.module.css'

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
 */
export const ConfirmDialog = ({
  title,
  icon,
  confirmLabel,
  cancelLabel = 'Keep',
  tone = 'default',
  busy = false,
  busyLabel,
  pending = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: string
  /** Overrides the tone's glyph when the subject has an icon of its own. */
  icon?: ReactNode
  /** The verb for what happens — "Delete", "Remove worktree". Never "OK". */
  confirmLabel: string
  /** The verb for leaving things alone. Only override with a better verb. */
  cancelLabel?: string
  /**
   * `destructive` — the trash glyph and the red verb — only for a confirm that
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
  onConfirm: () => void
  onCancel: () => void
  /** What is destroyed and where it goes. One or two sentences. */
  children: ReactNode
}) => (
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
      /* The column and its bound are said as utilities too: the primitive's
         own `grid` is a utility, and a module rule can lose to it depending on
         which stylesheet a build happens to load last. `cn` settles it here. */
      className={cn(styles.content, 'flex max-h-(--hd-dialog-max-height) flex-col overflow-hidden')}
      initialFocus={false}
    >
      <AlertDialogHeader
        className={cn(styles.header, 'shrink-0 flex-row items-center')}
        data-tone={tone === 'destructive' ? 'destructive' : undefined}
      >
        <span className={styles.icon}>
          {icon ?? (tone === 'destructive' ? <TrashIcon size={16} /> : <AlertIcon size={16} />)}
        </span>
        <AlertDialogTitle className={styles.title}>{title}</AlertDialogTitle>
      </AlertDialogHeader>
      {/* A `div`, not the primitive's default `p`. Every caller passes block
          content &mdash; `RemoveWorktree` passes a `section` and a `ul` &mdash;
          and a `p` wrapping those is invalid nesting: React warns, and the
          browser closes the paragraph early, which strands the rest of the body
          outside the element `aria-describedby` points at. */}
      {/* The body is the only part that scrolls: a confirm can be asked to
          hold what it confirms — a whole skill, a server's command line — and
          the question and both answers stay on screen however long that is. */}
      <AlertDialogDescription render={<div />} className={cn(styles.body, 'min-h-0 flex-1 overflow-y-auto')} data-slot="confirm-body">
        {children}
      </AlertDialogDescription>
      {/* The proceeding action is written first. The footer is `row-reverse`,
          so first in the markup paints rightmost &mdash; the first rule above.
          The order decides the keyboard too: nothing is focused on open, so
          focus is still on the opener, and Base UI's guard before the popup
          hands the first Tab to the popup's last control, which is Keep. A Tab
          and a Return keep things as they are. Written the other way round,
          every confirm in the app put the verb for leaving things alone where
          the pointer goes to proceed, and a Tab and a Return confirmed. */}
      <AlertDialogFooter className={cn(styles.footer, 'shrink-0')}>
        <Button
          variant={tone === 'destructive' ? 'destructive' : 'default'}
          onClick={onConfirm}
          disabled={busy || pending}
        >
          {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)
