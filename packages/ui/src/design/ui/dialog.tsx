import { Dialog as DialogPrimitive } from 'radix-ui'
import { forwardRef } from 'react'
import type * as React from 'react'

import { CrossIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'

/* Vendored from shadcn/ui (dialog). The scrim and z-order are the app's own
 * tokens, and the surface wears the app's floating shadow. Prefer the
 * design system's ConfirmDialog for yes/no questions — it encodes the
 * button rules; this is the general surface. */

const Dialog = ({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) => (
  <DialogPrimitive.Root data-slot="dialog" {...props} />
)

const DialogTrigger = ({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) => (
  <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
)

const DialogPortal = ({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) => (
  <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
)

const DialogClose = ({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) => (
  <DialogPrimitive.Close data-slot="dialog-close" {...props} />
)

/* Forwards its ref, because the portal it is rendered into hands the child a
   ref through a Slot. Without it every dialog in the app warned on the console
   and the overlay's exit transition had nothing to hold. */
const DialogOverlay = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 fixed inset-0 z-(--hd-z-dialog) bg-(--hd-scrim)',
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = 'DialogOverlay'

const DialogContent = ({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      data-slot="dialog-content"
      className={cn(
        'bg-popover data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 fixed top-1/2 left-1/2 z-(--hd-z-dialog) grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl p-5 shadow-(--hd-surface-shadow) duration-200 outline-none sm:max-w-md',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close
          data-slot="dialog-close"
          className="absolute top-3.5 right-3.5 grid size-6 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none"
        >
          <CrossIcon size={13} />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
)

const DialogHeader = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="dialog-header"
    className={cn('flex flex-col gap-1.5 text-left', className)}
    {...props}
  />
)

/* Write the proceeding action first: `row-reverse` paints it rightmost.
 *
 * That is the rule everywhere else in this app — `Dialog.module.css`'s
 * `.footer`, the `footer` prop on `Dialog` ("write the confirming one
 * first"), and `AlertDialogFooter`, aligned in #200 — and the stock shadcn
 * spelling (`flex-row justify-end`) was the one footer still painting in
 * written order. A footer written the app's way would have put the
 * proceeding action on the left.
 *
 * No `justify-end`: a reversed row already packs to the right, and adding it
 * back packs the buttons to the left, which is the trap this spelling is
 * here to close. */
const DialogFooter = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="dialog-footer"
    className={cn('flex flex-row-reverse gap-2', className)}
    {...props}
  />
)

const DialogTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) => (
  <DialogPrimitive.Title
    data-slot="dialog-title"
    className={cn('text-base leading-none font-semibold', className)}
    {...props}
  />
)

const DialogDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) => (
  <DialogPrimitive.Description
    data-slot="dialog-description"
    className={cn('text-muted-foreground text-sm', className)}
    {...props}
  />
)

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
