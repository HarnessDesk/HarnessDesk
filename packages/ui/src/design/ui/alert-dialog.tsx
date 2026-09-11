import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Vendored from shadcn/ui (alert-dialog) &mdash; the **Base UI** build.
 *
 * Adopted because a confirmation is not a dialog with different words in it.
 * The app's `ConfirmDialog` was built on the ordinary dialog, which closes when
 * you press the backdrop or hit Escape &mdash; correct for a sheet you are
 * reading, wrong for a question you have to answer. An alert dialog refuses
 * the press, so a stray click on the ground cannot answer for you. Escape
 * still closes it, and `ConfirmDialog` hears that as its verb for leaving
 * things alone.
 *
 * It does not pick the *safe* action for focus. Left to itself, Base UI
 * focuses the popup when a touch opened it, and otherwise the first control in
 * the DOM &mdash; in a footer written the app's way, the one that proceeds. So
 * `ConfirmDialog` passes `initialFocus={false}`, which moves focus nowhere
 * however it was opened, and a held Return does not delete a worktree.
 */

const AlertDialog = AlertDialogPrimitive.Root
const AlertDialogTrigger = AlertDialogPrimitive.Trigger
const AlertDialogPortal = AlertDialogPrimitive.Portal
const AlertDialogClose = AlertDialogPrimitive.Close

const AlertDialogOverlay = ({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) => (
  <AlertDialogPrimitive.Backdrop
    data-slot="alert-dialog-overlay"
    className={cn('fixed inset-0 z-(--hd-z-dialog) bg-(--hd-scrim)', className)}
    {...props}
  />
)

const AlertDialogContent = ({ className, children, ...props }: AlertDialogPrimitive.Popup.Props) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitive.Popup
      data-slot="alert-dialog-content"
      className={cn(
        'fixed top-1/2 left-1/2 z-(--hd-z-dialog) grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-3',
        'rounded-(--hd-surface-radius) bg-(--hd-surface-fill) p-4 shadow-(--hd-surface-shadow)',
        className,
      )}
      {...props}
    >
      {children}
    </AlertDialogPrimitive.Popup>
  </AlertDialogPortal>
)

const AlertDialogHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="alert-dialog-header"
    className={cn('flex flex-col gap-1', className)}
    {...props}
  />
)

/**
 * The buttons.
 *
 * Right-aligned, with the escape to the left of the act &mdash; the order the
 * platform uses, and the one where the button nearest the pointer's resting
 * place is the one that does something. Write the act first: the row is
 * reversed, as the app's own dialog footer is, so the act paints rightmost.
 * The registry's `justify-end` wanted the escape written first, the opposite
 * of every other footer in the app.
 */
const AlertDialogFooter = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="alert-dialog-footer"
    className={cn('mt-1 flex flex-row-reverse items-center gap-2', className)}
    {...props}
  />
)

const AlertDialogTitle = ({ className, ...props }: AlertDialogPrimitive.Title.Props) => (
  <AlertDialogPrimitive.Title
    data-slot="alert-dialog-title"
    className={cn('text-base font-semibold', className)}
    {...props}
  />
)

const AlertDialogDescription = ({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props) => (
  <AlertDialogPrimitive.Description
    data-slot="alert-dialog-description"
    className={cn('text-base text-(--hd-secondary-foreground)', className)}
    {...props}
  />
)

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogClose,
}
