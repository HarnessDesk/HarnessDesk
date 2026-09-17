import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { forwardRef, useState } from 'react'
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

const DialogViewport = ({ ...props }: React.ComponentProps<typeof DialogPrimitive.Viewport>) => (
  <DialogPrimitive.Viewport data-slot="dialog-viewport" {...props} />
)

const DialogPopup = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof DialogPrimitive.Popup>
>(({ ...props }, ref) => <DialogPrimitive.Popup ref={ref} data-slot="dialog-popup" {...props} />)
DialogPopup.displayName = 'DialogPopup'

/* Forwards its ref, because the portal it is rendered into hands the child a
   ref through a Slot. Without it every dialog in the app warned on the console
   and the overlay's exit transition had nothing to hold. */
const DialogOverlay = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof DialogPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Backdrop
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      'data-starting-style:animate-in data-starting-style:fade-in-0 data-ending-style:animate-out data-ending-style:fade-out-0 fixed inset-0 z-(--hd-z-dialog) bg-(--hd-scrim)',
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = 'DialogOverlay'

const DialogContent = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof DialogPrimitive.Popup> & {
    showCloseButton?: boolean
    portalled?: boolean
    overlayClassName?: string
  }
>(({ className, children, showCloseButton = true, portalled = true, overlayClassName, ...props }, ref) => {
  const [inlineHost, setInlineHost] = useState<HTMLDivElement | null>(null)
  const content = (
    <>
    <DialogOverlay className={overlayClassName} />
    <DialogPrimitive.Viewport className="fixed inset-0 z-(--hd-z-dialog) grid place-items-center p-4">
      <DialogPrimitive.Popup
        ref={ref}
        data-slot="dialog-content"
        className={cn(
          'bg-popover data-starting-style:animate-in data-starting-style:fade-in-0 data-starting-style:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 relative grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-xl p-5 shadow-(--hd-surface-shadow) duration-200 outline-none sm:max-w-md',
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
      </DialogPrimitive.Popup>
    </DialogPrimitive.Viewport>
    </>
  )
  return portalled ? (
    <DialogPortal>{content}</DialogPortal>
  ) : (
    <div ref={setInlineHost} data-slot="dialog-inline-host">
      {inlineHost ? <DialogPortal container={inlineHost}>{content}</DialogPortal> : null}
    </div>
  )
})
DialogContent.displayName = 'DialogContent'

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
  DialogPopup,
  DialogTitle,
  DialogTrigger,
  DialogViewport,
}
